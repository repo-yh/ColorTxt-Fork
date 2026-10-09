import { BrowserWindow, Notification } from "electron";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  BOOK_SOURCE_IPC,
  type BookSourceBrowserDownloadEvent,
} from "@shared/bookSource/ipc";
import type { SessionEntry } from "./chromiumNetFetch";
import { getBookSourceNetSession } from "./chromiumNetFetch";
import { cookieHeaderForUrl } from "./cookieManager";
import { getWebViewUserAgent } from "./bookSourceUserAgent";
import { getBookSourceDispatcher } from "./httpProxy";
import {
  clearSessionDomainCookies,
  persistWebViewCookies,
  seedSessionCookies,
} from "./backstageWebView";

let browserWin: BrowserWindow | null = null;
let downloadHooked = false;
/** 最近一次 will-download 拦截时间：导航被转下载导致的 loadURL 失败不报「打开失败」 */
let lastDownloadInterceptAt = 0;
/** 当前浏览会话的书架书籍名（打开浏览器时传入；下载事件随行，落地按书名匹配替换列表条目） */
let currentBookName = "";

/**
 * 书源浏览器窗口（应用内）：
 * - 挂书源网络分区 session（走找书代理，防直连 RST；HTTP 磁盘缓存已关闭）
 * - 打开/导航前种入 CookieJar 登录态（与引擎搜索同源 Cookie），导航/关窗时回写 CookieJar
 * - session 级 will-download 拦截附件下载（取消浏览器下载，URL 转交找书下载模块）
 * 单例窗口；再次打开时同窗口导航到新 URL。
 */
export function openBookSourceBrowserWindow(
  pageUrl: string,
  title?: string,
  bookName?: string,
): { ok: boolean; message?: string } {
  const target = pageUrl.trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, message: "仅支持 http(s) 链接" };
  }
  currentBookName = bookName?.trim() ?? "";
  const sesEntry = getBookSourceNetSession();
  hookDownload(sesEntry);

  const existing = browserWin && !browserWin.isDestroyed() ? browserWin : null;
  if (existing) {
    existing.show();
    existing.focus();
    void navigate(existing, sesEntry, target, title || currentBookName);
    return { ok: true };
  }
  createWindow(sesEntry, target, title || currentBookName);
  return { ok: true };
}

function createWindow(
  sesEntry: SessionEntry,
  pageUrl: string,
  title?: string,
): void {
  const win = new BrowserWindow({
    title: title || "书源浏览",
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: sesEntry.partition,
    },
  });
  browserWin = win;
  win.removeMenu();
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(getWebViewUserAgent());

  win.once("ready-to-show", () => win.show());

  // 关窗/导航时把 session Cookie 回写 CookieJar（窗口内登录对引擎静态请求同样生效）
  win.on("close", () => {
    const url = win.webContents.getURL();
    if (/^https?:\/\//i.test(url)) {
      void persistWebViewCookies(win.webContents, url).catch(() => {});
    }
  });
  win.on("closed", () => {
    if (browserWin === win) browserWin = null;
  });

  // 站点证书 SAN 不一致仍放行（对齐 sourceVerification/backstageWebView）
  win.webContents.on("certificate-error", (event, _u, _e, _c, cb) => {
    event.preventDefault();
    cb(true);
  });

  // 站内新开链接在当前窗口导航，不弹新 Electron 窗口（下载走 will-download 不受影响）
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void navigate(win, sesEntry, target, undefined, { silent: true });
    return { action: "deny" };
  });

  win.webContents.on("did-navigate", (_e, url) => {
    if (/^https?:\/\//i.test(url)) {
      void persistWebViewCookies(win.webContents, url).catch(() => {});
    }
  });

  void navigate(win, sesEntry, pageUrl, title);
}

async function navigate(
  win: BrowserWindow,
  sesEntry: SessionEntry,
  pageUrl: string,
  title?: string,
  options?: { silent?: boolean },
): Promise<void> {
  if (title && !win.isDestroyed()) win.setTitle(title);
  try {
    await sesEntry.proxyReady;
  } catch {
    /* 代理就绪失败也尝试加载 */
  }
  if (win.isDestroyed()) return;
  // CookieJar → session：先清该域残留再种入（对齐 backstageWebView，保证登录态确定性）
  try {
    await clearSessionDomainCookies(win.webContents, pageUrl);
    const cookieHeader = cookieHeaderForUrl(pageUrl);
    if (cookieHeader) {
      await seedSessionCookies(win.webContents, pageUrl, cookieHeader);
    }
  } catch {
    /* 种入失败不阻断打开 */
  }
  if (win.isDestroyed()) return;
  try {
    await win.loadURL(pageUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 站内新窗口链接（target=_blank）/附件下载：失败静默（转下载必然 reject；且 reject 可能先于 will-download，时间戳兜不住）
    if (options?.silent) return;
    // 对齐 backstageWebView：-3 ABORTED / -7 TIMED_OUT 为软失败（偶发仍会随后 did-finish-load）
    if (/ERR_ABORTED|ERR_TIMED_OUT/i.test(msg)) return;
    // 导航被「转下载」中止（target=_blank 附件链接 → windowOpen → navigate → will-download）：
    // 下载已正常接管，不算打开失败
    if (Date.now() - lastDownloadInterceptAt < 3000) return;
    new Notification({
      title: "书源浏览打开失败",
      body: `${pageUrl}（${msg}）`,
    }).show();
  }
}

/** 书源分区 session 的下载接管：拦截下载 URL，取消浏览器下载，转交找书下载模块 */
function hookDownload(sesEntry: SessionEntry): void {
  if (downloadHooked) return;
  downloadHooked = true;
  sesEntry.ses.on("will-download", (event, item, webContents) => {
    lastDownloadInterceptAt = Date.now();
    // 取消浏览器自身下载：URL 交给找书下载模块（登录 Cookie/代理/加入主界面文件列表）
    event.preventDefault();
    let referer = "";
    try {
      referer = webContents?.getURL?.() ?? "";
    } catch {
      /* ignore */
    }
    showBrowserWindowToast(
      `开始下载：${item.getFilename() || "附件"}`,
      3000,
      referer,
    );
    emitBrowserDownloadEvent({
      url: item.getURL(),
      filename: item.getFilename(),
      referer: /^https?:\/\//i.test(referer) ? referer : undefined,
      bookName: currentBookName || undefined,
    });
  });
}

function isAppRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const url = win.webContents.getURL();
  return !url.startsWith("data:") && url !== "about:blank";
}

/** 主进程 → 应用渲染窗口：浏览器附件下载拦截事件（跳过书源浏览器窗口自己） */
function emitBrowserDownloadEvent(ev: BookSourceBrowserDownloadEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === browserWin) continue;
    if (!isAppRendererWindow(win)) continue;
    win.webContents.send(BOOK_SOURCE_IPC.browserDownloadEvent, ev);
  }
}

/** 书源浏览器窗口右下角临时提醒（页面无 appToast 设施，注入浮层；窗口已关则静默）。
 * expectedUrl = 下载发起页 URL：窗口已导航离开（如换了书）则不注入，避免旧书提醒弹到新书页面 */
function showBrowserWindowToast(
  message: string,
  ms = 3000,
  expectedUrl?: string,
): void {
  const win = browserWin && !browserWin.isDestroyed() ? browserWin : null;
  if (!win) return;
  const expect = expectedUrl?.trim();
  const guard = expect
    ? `if (location.href !== ${JSON.stringify(expect)}) return;`
    : "";
  const js = `
    (function() {
      ${guard}
      var d = document.createElement('div');
      d.textContent = ${JSON.stringify(message)};
      d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:70vw;' +
        'padding:8px 14px;border-radius:6px;background:rgba(20,20,20,0.85);color:#fff;' +
        'font-size:13px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,0.35);' +
        'pointer-events:none;transition:opacity .3s;';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function() { d.style.opacity = '0'; }, ${ms});
      setTimeout(function() { d.remove(); }, ${ms + 400});
    })();
  `;
  void win.webContents.executeJavaScript(js).catch(() => {});
}

/**
 * 引擎网络栈下载浏览器拦截的附件 URL：
 * 登录 Cookie（CookieJar）+ 发起页 Referer（防盗链）+ 浏览器同款 UA + 找书代理，
 * 原始字节写盘（编码探测交给阅读器打开时处理）。
 */
export async function downloadBookSourceBrowserFile(opts: {
  url: string;
  filename?: string;
  referer?: string;
  outputDir: string;
}): Promise<{ ok: boolean; filePath?: string; size?: number; message?: string }> {
  const url = opts.url.trim();
  const dir = opts.outputDir.trim();
  if (!/^https?:\/\//i.test(url)) {
    showBrowserWindowToast("下载失败：无效下载链接", 3000, opts.referer);
    return { ok: false, message: "无效下载链接" };
  }
  if (!dir) {
    showBrowserWindowToast("下载失败：下载目录未配置", 3000, opts.referer);
    return { ok: false, message: "下载目录未配置" };
  }
  try {
    await mkdir(dir, { recursive: true });
    const headers: Record<string, string> = {};
    const cookie = cookieHeaderForUrl(url);
    if (cookie) headers.Cookie = cookie;
    if (opts.referer?.trim()) headers.Referer = opts.referer.trim();
    const ua = getWebViewUserAgent();
    if (ua) headers["User-Agent"] = ua;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
      dispatcher: getBookSourceDispatcher(),
    } as RequestInit);
    if (!res.ok) {
      showBrowserWindowToast(
        `下载失败：HTTP ${res.status}`,
        3000,
        opts.referer,
      );
      return { ok: false, message: `下载失败：HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      showBrowserWindowToast("下载失败：下载内容为空", 3000, opts.referer);
      return { ok: false, message: "下载内容为空" };
    }
    const filePath = uniqueDownloadPath(dir, opts.filename?.trim() || "attachment.txt");
    await writeFile(filePath, buf);
    showBrowserWindowToast(`下载完成：${basename(filePath)}`, 3000, opts.referer);
    return { ok: true, filePath, size: buf.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showBrowserWindowToast(`下载失败：${msg}`, 3000, opts.referer);
    return { ok: false, message: msg };
  }
}

/** 重名自动加时间戳后缀，避免覆盖已下载文件 */
function uniqueDownloadPath(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  const path = join(dir, filename);
  if (!existsSync(path)) return path;
  return join(dir, `${stem}-${Date.now()}${ext}`);
}
