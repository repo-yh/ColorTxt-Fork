import { BrowserWindow } from "electron";
import type { BookSourceRecord } from "@shared/bookSource/types";
import {
  headersToLoadUrlExtraHeaders,
  resolveSourceRequestHeaders,
} from "./sourceRequestHeaders";
import { getBookSourceBrowserSession } from "./chromiumNetFetch";
import { getWebViewUserAgent } from "./bookSourceUserAgent";
import {
  cookieHeaderForUrl,
  getCookieStoreDomain,
  getDomainFromUrl,
  setCookieFromResponse,
} from "./cookieManager";
import type { JsExtensionHost } from "./jsExtensions";

export type BackstageWebViewOptions = {
  html?: string | null;
  url?: string | null;
  js?: string | null;
  source?: BookSourceRecord;
  host?: JsExtensionHost;
  headers?: Record<string, string>;
  delayMs?: number;
  timeoutMs?: number;
  injectResult?: unknown;
  overrideUrlRegex?: string | null;
  cacheFirst?: boolean;
  /** 对齐 Electron loadURL：搜索等 POST 表单（如 charset:gbk） */
  method?: string;
  /** POST 原始 body（已按书源 charset 编码） */
  postData?: string | Buffer | Uint8Array | null;
};

const WEBVIEW_CONTEXT = `
var result = typeof window.result !== 'undefined' ? window.result : '';
var src = document.documentElement ? document.documentElement.outerHTML : '';
var baseUrl = location.href;
`;

/**
 * 对齐 Android WebView.evaluateJavascript：默认脚本是「表达式」求值。
 */
function buildWebViewEvalScript(userScript: string): string {
  const trimmed = userScript.trim() || "document.documentElement.outerHTML";
  const looksLikeStatementBlock =
    /\b(var|let|const|function|if|for|while|return|class|switch|try)\b/.test(
      trimmed,
    ) ||
    trimmed.includes(";") ||
    trimmed.includes("\n");
  const body = looksLikeStatementBlock
    ? trimmed
    : `return (${trimmed});`;

  return `
    (async function() {
      ${WEBVIEW_CONTEXT}
      try {
        const __out = await (async function() {
          ${body}
        })();
        if (__out === undefined || __out === null) return "";
        if (typeof __out === "object") return JSON.stringify(__out);
        return String(__out);
      } catch (e) {
        return "";
      }
    })()
  `;
}

/** 标记隐藏后台窗，避免被当成「末窗」挡 quit */
export const BACKSTAGE_WEBVIEW_FLAG = "__colortxtBackstageWebView";

/** 找书设置「WebView 加载延时」全局覆盖（ms）；null = 跟随书源 webViewDelayTime */
let webViewDelayOverrideMs: number | null = null;

export function setWebViewDelayOverrideMs(ms: unknown): void {
  webViewDelayOverrideMs =
    typeof ms === "number" && Number.isFinite(ms) && ms >= 0
      ? Math.floor(ms)
      : null;
}

export function getWebViewDelayOverrideMs(): number | null {
  return webViewDelayOverrideMs;
}

const activeBackstageWindows = new Set<BrowserWindow>();

export function isBackstageWebViewWindow(win: BrowserWindow): boolean {
  return (win as unknown as Record<string, unknown>)[BACKSTAGE_WEBVIEW_FLAG] === true;
}

/** 末个可见窗关闭 / 退出前：强制拆掉后台 WebView，否则 process 不退出 */
export function destroyAllBackstageWebViews(): void {
  for (const win of [...activeBackstageWindows]) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
  activeBackstageWindows.clear();
}

export function stripWebJsRule(rule: string): string {
  return rule.replace(/^@webjs:\s*/i, "").trim();
}

export async function persistWebViewCookies(
  webContents: Electron.WebContents,
  pageUrl: string,
): Promise<void> {
  const cookies = await webContents.session.cookies.get({});
  for (const c of cookies) {
    const domain = c.domain?.replace(/^\./, "") ?? getDomainFromUrl(pageUrl);
    setCookieFromResponse(
      `https://${domain}/`,
      `${c.name}=${c.value}; Domain=${c.domain ?? domain}; Path=${c.path ?? "/"}`,
    );
  }
  // Chromium Cookie 异步落盘（~30s 周期）；dev 重启/崩溃会丢刚写入的登录 Cookie
  await webContents.session.cookies.flushStore().catch(() => {});
}

/** 读 session 里该可注册域的全部 Cookie 拼成 k=v; k=v 头（含 HttpOnly；session 对象独立于窗口，窗口销毁后仍可读） */
export async function getSessionCookieHeader(
  ses: Electron.Session,
  pageUrl: string,
): Promise<string> {
  const storeDomain = getCookieStoreDomain(pageUrl);
  const cookies = await ses.cookies.get({});
  const pairs: string[] = [];
  for (const c of cookies) {
    const d = (c.domain ?? "").replace(/^\./, "");
    if (d !== storeDomain && !d.endsWith(`.${storeDomain}`)) continue;
    pairs.push(`${c.name}=${c.value}`);
  }
  return pairs.join("; ");
}

/** 清掉 session 里该可注册域的全部 Cookie（种入 jar 前保证状态确定） */
export async function clearSessionDomainCookies(
  webContents: Electron.WebContents,
  pageUrl: string,
): Promise<void> {
  const storeDomain = getCookieStoreDomain(pageUrl);
  const cookies = await webContents.session.cookies.get({});
  for (const c of cookies) {
    const d = (c.domain ?? "").replace(/^\./, "");
    if (d !== storeDomain && !d.endsWith(`.${storeDomain}`)) continue;
    const url = `http${c.secure ? "s" : ""}://${d}${c.path ?? "/"}`;
    await webContents.session.cookies.remove(url, c.name).catch(() => {});
  }
}

/** 将 Cookie 头写入 Electron session，供页面脚本/AJAX 使用。
 *  覆盖式写入——仅限 ensureDomainSessionInit 的进程级首次初始化调用；
 *  日常链路对共享分区零写入（jar 快照可能旧于分区活会话，覆盖会把已登录
 *  会话打回游客态，loginCheckJs 即误弹登录窗）。 */
export async function seedSessionCookies(
  webContents: Electron.WebContents,
  pageUrl: string,
  header: string,
): Promise<void> {
  if (!header.trim()) return;
  const storeDomain = getCookieStoreDomain(pageUrl);
  const cookieUrl = `https://${getDomainFromUrl(pageUrl)}/`;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      // 域级 Cookie：登录态多存于 .domain 级 Cookie，host-only 注入会被同名域 Cookie 遮蔽/漏发
      await webContents.session.cookies.set({
        url: cookieUrl,
        name,
        value,
        domain: storeDomain,
        path: "/",
      });
    } catch {
      try {
        await webContents.session.cookies.set({
          url: cookieUrl,
          name,
          value,
          path: "/",
        });
      } catch {
        /* ignore invalid cookie */
      }
    }
  }
}

/**
 * 「分区为唯一权威」的进程级 Cookie 初始化：每（分区, 可注册域）仅首次执行——
 * 清域 + 覆盖种入 CookieJar 终态快照；此后分区自由演进（浏览器/验证窗/后台
 * WebView 谁登录谁生效），引擎日常链路对分区零写入。jar 快照可能旧于分区活
 * 会话，任何后续覆盖都会把已登录会话打回游客态（误弹登录窗 / 静态 0 条）。
 */
const initedSessionDomains = new Map<string, Promise<void>>();

export function ensureDomainSessionInit(
  partition: string,
  webContents: Electron.WebContents,
  pageUrl: string,
  cookieHeader: string,
): Promise<void> {
  const key = `${partition}|${getCookieStoreDomain(pageUrl)}`;
  const existing = initedSessionDomains.get(key);
  if (existing) return existing;
  const p = (async () => {
    await clearSessionDomainCookies(webContents, pageUrl);
    if (cookieHeader.trim()) {
      await seedSessionCookies(webContents, pageUrl, cookieHeader);
    }
  })();
  initedSessionDomains.set(key, p);
  p.catch(() => {
    // 初始化失败允许下次重试
    if (initedSessionDomains.get(key) === p) initedSessionDomains.delete(key);
  });
  return p;
}

function isEmptyEvalResult(text: string): boolean {
  return !text || text === "null" || text === "undefined";
}

/**
 * CDN/站点 JS 挑战页（如 `var buid = "fffffffffffffffffff"` + probe.js）。
 * 此时 outerHTML 非空但尚无正文；应对齐「空结果」继续等待。
 * 取 `document.cookie` 时不把挑战页当未就绪（cookie 字符串本身就可能很短）。
 *
 * 另识别 Discuz `_dsign` 型挑战壳页（如 sxsy 系）：服务器先回 2~5KB 混淆 JS
 * （拼接 `'_ds'`/`'assign'`/`'href'` 等字面量 + location 跳转），脚本执行后才进真页面。
 * 该壳页无 title/body 结构、远小于正常帖子页，据此区分避免误伤正常短页面。
 */
export function isJsChallengeHtml(text: string): boolean {
  const head = text.slice(0, 8000);
  if (head.includes("fffffffffffffffffff")) return true;
  if (/probe\.js/i.test(head) && text.length < 4096) return true;
  if (
    text.length < 8192 &&
    !/<title[\s>]|<body[\s>]|<div[\s>]|<form[\s>]/i.test(text)
  ) {
    if (/['"]_ds['"]/.test(text)) return true;
    if (/['"]assign['"]/.test(head) && /location|['"]href['"]/i.test(head)) {
      return true;
    }
  }
  return false;
}

function shouldRetryWebViewResult(text: string, userScript: string): boolean {
  if (isEmptyEvalResult(text)) return true;
  if (/^\s*document\.cookie\s*$/i.test(userScript.trim())) return false;
  // 仅当脚本意在取页面 HTML 时，挑战页视为未就绪
  if (
    !userScript.trim() ||
    /outerHTML|innerHTML|documentElement|document\.body/i.test(userScript)
  ) {
    return isJsChallengeHtml(text);
  }
  return false;
}

function attachTrustAnyCertificate(wc: Electron.WebContents): void {
  // 对齐 Legado BackstageWebView.onReceivedSslError → proceed()
  wc.on("certificate-error", (event, _url, _error, _cert, callback) => {
    event.preventDefault();
    callback(true);
  });
}

function registerBackstageWindow(win: BrowserWindow): void {
  (win as unknown as Record<string, unknown>)[BACKSTAGE_WEBVIEW_FLAG] = true;
  activeBackstageWindows.add(win);
  win.on("closed", () => {
    activeBackstageWindows.delete(win);
  });
}

/**
 * 常驻隐藏 tab 宿主：引擎 webView 请求（搜索/更新/发现）不再每次新建隐藏窗+销毁，
 * 而是加载到这个常驻 tab——它与内置浏览器共享 persist 分区（登录态/挑战凭证/磁盘
 * 缓存全程热），页面 JS 自己完成 _dsign 等挑战，加载完截获 outerHTML/webJs 结果
 * 交回引擎解析、UI 渲染。串行队列复用同一 webContents（sxsy 系搜索本就限并发）。
 */
let engineTabHost: BrowserWindow | null = null;

function getEngineTabHost(partition: string): BrowserWindow {
  if (engineTabHost && !engineTabHost.isDestroyed()) return engineTabHost;
  const win = new BrowserWindow({
    // 调试期：tab 先显示出来供 F12 观察挑战/响应；验证完改回 show: false
    show: true,
    title: "引擎Tab（调试）",
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 对齐 Legado blockNetworkImage：挡图片，减轻多余 HTTPS 握手失败噪音
      javascript: true,
      images: false,
      partition,
    },
  });
  // F12 / Ctrl+Shift+I 切换 DevTools（调试期观察网络请求/Cookie）
  win.webContents.on("before-input-event", (event, input) => {
    const isToggleDevToolsKey =
      input.type === "keyDown" &&
      (input.key === "F12" ||
        ((input.control || input.meta) &&
          input.shift &&
          input.key.toLowerCase() === "i"));
    if (!isToggleDevToolsKey) return;
    event.preventDefault();
    win.webContents.toggleDevTools();
  });
  // 挂 BACKSTAGE_WEBVIEW_FLAG：退出清理（destroyAllBackstageWebViews）统一销毁
  registerBackstageWindow(win);
  win.on("closed", () => {
    if (engineTabHost === win) engineTabHost = null;
  });
  // 渲染进程崩溃：销毁重建，防止宿主坏死后所有请求持续失败
  win.webContents.on("render-process-gone", () => {
    if (engineTabHost === win && !win.isDestroyed()) win.destroy();
  });
  attachTrustAnyCertificate(win.webContents);
  engineTabHost = win;
  return win;
}

/** 常驻宿主只有一个 webContents：请求串行排队（前一个彻底结束后下一个才加载） */
let engineTabChain: Promise<unknown> = Promise.resolve();

function enqueueEngineTab<T>(task: () => Promise<T>): Promise<T> {
  const p = engineTabChain.then(task, task);
  engineTabChain = p.catch(() => {});
  return p;
}

export async function runBackstageWebView(
  opts: BackstageWebViewOptions,
): Promise<string> {
  // 对齐 Legado BackstageWebView.getStrResponse：withTimeout(60000)
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pageUrl = (opts.url?.trim() || "about:blank").split(",")[0]!.trim();
  const html = opts.html?.trim() ?? "";
  const userScript = opts.js?.trim() || "document.documentElement.outerHTML";
  // 对齐 Legado BackstageWebView：onPageFinished 后 `1000 + webViewDelayTime` 再执行 JS
  const delayMs = 1000 + Math.max(0, opts.delayMs ?? 0);

  let headers = { ...(opts.headers ?? {}) };
  if (opts.source) {
    headers = {
      ...(await resolveSourceRequestHeaders(opts.source, {
        baseUrl: pageUrl.startsWith("http") ? pageUrl : opts.source.bookSourceUrl,
        host: opts.host,
        logs: opts.host?.logs,
      })),
      ...headers,
    };
  }
  // 对齐 Legado CookieManager：WebView 以 CookieJar 为准（部分书源 AJAX 正文依赖登录态）。
  // Cookie 走 session 注入而非请求头：extraHeaders 只作用于首个请求，且会与 session Cookie 重复
  const cookieHeader =
    headers.Cookie?.trim() ||
    headers.cookie?.trim() ||
    (pageUrl.startsWith("http") ? cookieHeaderForUrl(pageUrl) : "");
  delete headers.Cookie;
  delete headers.cookie;
  const userAgent =
    headers["User-Agent"] ??
    headers["user-agent"] ??
    getWebViewUserAgent();

  // 后台 WebView 与内置浏览器共享 persist 分区：挑战凭证/磁盘缓存互通，
  // 浏览器里过完验证引擎请求直接免挑战（走找书设置的全局代理）
  const sesEntry = getBookSourceBrowserSession();

  return enqueueEngineTab(async () => {
    // 常驻隐藏 tab 复用（不新建不销毁；调试期窗口显示，验证完改回隐藏）
    const win = getEngineTabHost(sesEntry.partition);
    const wc = win.webContents;
    // 外层总超时置位后内部循环尽快退出；宿主常驻，超时只 stop 复位不销毁
    let aborted = false;

    // 调试 tab 被手动关闭：立即中止本次等待并让出串行队列（否则当前 task 要等满
    // 总超时才结束，期间搜索/更新/发现的后续请求全部排队无法新建宿主）
    let rejectHostClosed!: (err: Error) => void;
    const onHostClosed = () => rejectHostClosed(new Error("引擎 tab 已被关闭"));
    const hostClosed = new Promise<never>((_, reject) => {
      rejectHostClosed = reject;
      if (win.isDestroyed()) {
        reject(new Error("引擎 tab 已被关闭"));
        return;
      }
      win.once("closed", onHostClosed);
    });

    const work = (async (): Promise<string> => {
      await sesEntry.proxyReady;
      wc.setUserAgent(userAgent);
      if (pageUrl.startsWith("http")) {
        // 进程级首次：清域+种 jar 终态快照；此后分区为唯一权威、零 seed——
        // 覆盖会冲掉浏览器/验证窗登录的活会话，把该次请求打回游客态
        await ensureDomainSessionInit(
          sesEntry.partition,
          wc,
          pageUrl,
          cookieHeader,
        ).catch(() => {});
      }

      if (opts.overrideUrlRegex) {
        const re = new RegExp(opts.overrideUrlRegex);
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("webView 跳转匹配超时")),
            timeoutMs,
          );
          const onNav = (_event: Electron.Event, url: string) => {
            if (!re.test(url)) return;
            clearTimeout(timer);
            cleanup();
            resolve(url);
          };
          const cleanup = () => {
            wc.removeListener("will-navigate", onNav);
            wc.removeListener("did-navigate", onNav);
          };
          wc.on("will-navigate", onNav);
          wc.on("did-navigate", onNav);
          void loadWebViewContent(wc, pageUrl, html, headers, timeoutMs, {
            method: opts.method,
            postData: opts.postData,
          }).catch((err) => {
            clearTimeout(timer);
            cleanup();
            reject(err);
          });
        });
      }

      await loadWebViewContent(wc, pageUrl, html, headers, timeoutMs, {
        method: opts.method,
        postData: opts.postData,
      });

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      if (opts.injectResult != null) {
        const json = JSON.stringify(opts.injectResult);
        await wc.executeJavaScript(`window.result = ${json};`);
      }

      const wrappedScript = buildWebViewEvalScript(userScript);

      // 对齐 Legado EvalJsRunnable：非空且非 "null" 即返回；否则最多再试 30 次（间隔 1s）。
      // 额外：JS 挑战页（fffffffffffffffffff / 短 probe.js / Discuz _dsign 壳页）对 HTML 类脚本也继续等。
      let last = "";
      for (let retry = 0; ; retry++) {
        if (aborted || wc.isDestroyed()) throw new Error("webView 已超时中止");
        try {
          const raw = await wc.executeJavaScript(wrappedScript, true);
          last = typeof raw === "string" ? raw : String(raw ?? "");
        } catch {
          // 壳页 JS 跳转（location.assign）瞬间执行会抛导航异常：视为未就绪继续等待
          last = "";
        }
        if (!shouldRetryWebViewResult(last, userScript)) break;
        if (retry >= 30) {
          // 先回写 session Cookie，再决定是否超时失败
          if (pageUrl.startsWith("http")) {
            await persistWebViewCookies(wc, pageUrl);
          }
          // loginCheckJs 常用 `document.cookie`：值可为空（仅 HttpOnly），不能当 JS 超时
          if (/^\s*document\.cookie\s*$/i.test(userScript)) {
            return last;
          }
          if (isEmptyEvalResult(last)) {
            throw new Error("webView js 执行超时（空结果）");
          }
          // 挑战页等满仍返回最后一次 HTML，由上层决定是否可用
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (pageUrl.startsWith("http")) {
        await persistWebViewCookies(wc, pageUrl);
      }
      return last;
    })();

    // 超时后 stop 复位 tab（常驻宿主不销毁）；吞掉后到的拒绝，避免 unhandledRejection
    void work.catch(() => {});
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<string>((_, reject) => {
          overallTimer = setTimeout(() => {
            aborted = true;
            reject(new Error("webView 总体超时"));
          }, timeoutMs);
        }),
        hostClosed,
      ]);
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      try {
        win.removeListener("closed", onHostClosed);
      } catch {
        /* ignore */
      }
      try {
        if (!wc.isDestroyed()) wc.stop();
      } catch {
        /* ignore */
      }
    }
  });
}

/** Chromium net errors：-3 ABORTED；-7 TIMED_OUT 上偶发仍会随后 did-finish-load */
function isSoftWebViewLoadError(code: number, err?: unknown): boolean {
  if (code === -3 || code === -7) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ERR_TIMED_OUT|ERR_ABORTED/i.test(msg);
}

async function loadWebViewContent(
  wc: Electron.WebContents,
  pageUrl: string,
  html: string,
  headers: Record<string, string>,
  timeoutMs = 60_000,
  loadOpts?: {
    method?: string;
    postData?: string | Buffer | Uint8Array | null;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("webView 页面加载超时")),
      timeoutMs,
    );
    let settled = false;
    const cleanup = () => {
      wc.removeListener("did-finish-load", done);
      wc.removeListener("did-fail-load", fail);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const failHard = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    };
    const fail = (
      _: unknown,
      code: number,
      desc: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // 子框架（广告/统计 iframe）失败不影响主文档；
      // 误当整页失败会让 getCsrfToken 类 webView 调用永远拿不到正文
      if (isMainFrame === false) return;
      // 软失败：等 did-finish-load 或总超时（部分站 TIMED_OUT 后仍出正文）
      if (isSoftWebViewLoadError(code)) return;
      failHard(new Error(`webView 加载失败: ${desc || code}`));
    };
    const onLoadUrlCatch = (err: unknown) => {
      if (isSoftWebViewLoadError(0, err)) return;
      failHard(err instanceof Error ? err : new Error(String(err)));
    };
    wc.once("did-finish-load", done);
    // 勿用 once：子框架失败会消费掉监听器，漏掉之后真正的主框架失败
    wc.on("did-fail-load", fail);

    if (html) {
      void wc
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
          baseURLForDataURL: pageUrl.startsWith("http") ? pageUrl : undefined,
        })
        .catch(onLoadUrlCatch);
      return;
    }
    if (pageUrl.startsWith("http")) {
      const method = (loadOpts?.method ?? "GET").toUpperCase();
      const postRaw = loadOpts?.postData;
      const headerMap = Object.fromEntries(
        Object.entries(headers).filter(([k]) => !/^user-agent$/i.test(k)),
      );
      if (
        method === "POST" &&
        postRaw != null &&
        !(typeof postRaw === "string" && !postRaw) &&
        !headerMap["Content-Type"] &&
        !headerMap["content-type"]
      ) {
        headerMap["Content-Type"] = "application/x-www-form-urlencoded";
      }
      const extraHeaders = headersToLoadUrlExtraHeaders(headerMap);
      const loadOptions: Electron.LoadURLOptions = {};
      if (extraHeaders) loadOptions.extraHeaders = extraHeaders;
      if (method === "POST" && postRaw != null) {
        const bytes = Buffer.isBuffer(postRaw)
          ? postRaw
          : typeof postRaw === "string"
            ? Buffer.from(postRaw)
            : Buffer.from(postRaw);
        loadOptions.postData = [{ type: "rawData", bytes }];
      }
      void wc
        .loadURL(
          pageUrl,
          Object.keys(loadOptions).length > 0 ? loadOptions : undefined,
        )
        .catch(onLoadUrlCatch);
      return;
    }
    void wc.loadURL("about:blank").catch(onLoadUrlCatch);
  });
}
