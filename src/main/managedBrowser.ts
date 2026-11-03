import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import puppeteer, { type Browser } from "puppeteer-core";

/**
 * 受管浏览器通道（CDP connect 版，对标 extensionWs 油猴通道的三个能力）：
 * 1. openAndGetHtmlViaBrowser —— 打开页面抓 {title,text,html,finalUrl}（含 CF/_dsign 壳页等待）
 * 2. formPostViaBrowser        —— 页面上下文 fetch POST（附件购买 attachpay，HTTP 2xx 即成功，非幂等）
 * 3. downloadBookSourceFileViaBrowser —— Browser.setDownloadBehavior 接管附件下载落盘（fire-and-forget + 事件广播）
 *
 * 生命周期（懒启动 + 随 app 销毁）：
 * - 每次调用先探测 CDP 端口，浏览器未运行则自动拉起 Edge（独立 user-data-dir 持久 profile，
 *   登录态/cf_clearance 跨会话保留）；已是带参启动的实例则直接 connect 复用
 * - app will-quit 自动关闭浏览器；也可随时 stopManagedBrowser() 人为提前销毁
 * - 用户手动关掉浏览器窗口 → disconnected → 连接置空，下次调用重新拉起
 */

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9333;
/** 单页加载超时（与油猴通道 30s 对齐） */
const PAGE_LOAD_TIMEOUT_MS = 30_000;
/** CF/_dsign 壳页最多等待轮数与间隔（与油猴通道对齐：最多 3 轮） */
const CF_SHELL_MAX_ROUNDS = 3;
const CF_SHELL_POLL_MS = 2_000;
/** 浏览器进程拉起后等待 CDP 就绪的上限 */
const CDP_READY_TIMEOUT_MS = 15_000;
/** 下载完成超时（大附件 + 慢站） */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 下载后未在预期路径找到文件时的兜底等待 */
const DOWNLOAD_SETTLE_MS = 2_000;

export type ManagedBrowserResult =
  | {
      ok: true;
      title: string;
      text: string;
      html: string;
      finalUrl: string;
    }
  | { ok: false; error: string };

/**
 * 下载事件形状与油猴通道的 ExtensionWsDownloadEvent 一致（渲染层宿主组件按书名
 * 匹配替换/导入的逻辑可直接复用）；channel 名独立为 managedBrowser:downloadEvent。
 */
export type ManagedBrowserDownloadEvent = {
  ok: boolean;
  taskId: string;
  /** ok=true：落盘文件绝对路径 */
  filePath?: string;
  size?: number;
  /** Content-Disposition 解析的文件名（浏览器 downloadWillBegin 给出） */
  filename?: string;
  /** 下发时携带的书架书籍名（落地按书名匹配替换） */
  bookName?: string;
  /** 附件归属的帖子 URL */
  postUrl?: string;
  /** ok=false：失败原因 */
  error?: string;
};

let browser: Browser | null = null;
/** 仅记录由本模块拉起的 Edge 进程；connect 到用户手动启动的实例时为 null（stop 时只断连不杀进程） */
let edgeProc: ChildProcess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findEdgeExe(): string | null {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 探测 CDP 调试端点是否就绪（/json/version 200 即存活） */
function isCdpAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: CDP_HOST, port: CDP_PORT, path: "/json/version", timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/**
 * 探测并确保浏览器可连：CDP 存活直接 connect；未运行则拉起 Edge 等就绪后再 connect。
 * 连接对象缓存在模块级，disconnected（用户手动关窗/进程退出）自动置空，下次调用重新拉起。
 */
async function ensureBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  browser = null;

  if (!(await isCdpAlive())) {
    const exe = findEdgeExe();
    if (!exe) {
      throw new Error("未找到本机 Edge（msedge.exe），无法拉起受管浏览器");
    }
    const userDataDir = path.join(
      app.getPath("userData"),
      "managed-browser-profile",
    );
    console.log(`[managedBrowser] CDP 未运行，拉起 Edge profile=${userDataDir}`);
    const proc = spawn(
      exe,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { stdio: "ignore" },
    );
    edgeProc = proc;
    proc.on("exit", () => {
      if (edgeProc === proc) edgeProc = null;
      // 进程退出时连接随之失效，置空让下次调用重新拉起
      browser = null;
    });

    const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isCdpAlive()) break;
      await sleep(500);
    }
    if (!(await isCdpAlive())) {
      edgeProc = null;
      throw new Error(
        `浏览器启动超时（CDP 端口 ${CDP_PORT} 未就绪，可能被其他程序占用）`,
      );
    }
  }

  const conn = await puppeteer.connect({
    browserURL: `http://${CDP_HOST}:${CDP_PORT}`,
    defaultViewport: null,
  });
  browser = conn;
  conn.on("disconnected", () => {
    if (browser === conn) browser = null;
    console.log("[managedBrowser] 浏览器连接断开（窗口被关/进程退出）");
  });
  console.log("[managedBrowser] 已连接浏览器");
  return conn;
}

/** 壳页判定：CF 挑战特征 + 短页内嵌 _ds 混淆（_dsign 挑战壳页 2~4KB） */
function isChallengeShell(html: string): boolean {
  if (!html) return false;
  if (
    html.includes("Just a moment") ||
    html.includes("challenge-platform") ||
    html.includes("_cf_chl_") ||
    html.includes("__jschl")
  ) {
    return true;
  }
  return html.length < 5000 && /['_"]_ds['"]/.test(html);
}

/** 主进程 → 应用渲染窗口广播下载事件（宿主组件按 bookName 替换/导入文件列表条目） */
function emitDownloadEvent(ev: ManagedBrowserDownloadEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const url = win.webContents.getURL();
    if (url.startsWith("data:") || url === "about:blank") continue;
    win.webContents.send("managedBrowser:downloadEvent", ev);
  }
}

/**
 * 打开页面并抓取渲染后内容（对标油猴通道 openAndGetHtml）：
 * goto（domcontentloaded）→ 壳页轮询（CF/_dsign JS 挑战会自动跳转，最多 3 轮）→
 * 抓 title/innerText/outerHTML/finalUrl。用完即关 tab，浏览器窗口保留。
 */
export async function openAndGetHtmlViaBrowser(
  url: string,
): Promise<ManagedBrowserResult> {
  let page = null;
  try {
    const conn = await ensureBrowser();
    page = await conn.newPage();
    await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      })
      .catch((err: Error) => {
        // 下载转导航 / 挑战跳转中断会导致 goto reject，页面仍可能在加载，
        // 交给后面的壳页轮询判定；真失败由抓取阶段兜底
        console.log(
          `[managedBrowser] goto 未正常完成（继续按页面状态判定）: ${err.message.slice(0, 120)}`,
        );
      });

    let html = await page.content().catch(() => "");
    for (let i = 0; i < CF_SHELL_MAX_ROUNDS && isChallengeShell(html); i++) {
      await sleep(CF_SHELL_POLL_MS);
      html = await page.content().catch(() => html);
    }
    if (isChallengeShell(html)) {
      return { ok: false, error: "挑战页未通过（CF/_dsign 壳页，等待超时）" };
    }

    const [title, text, finalUrl] = await Promise.all([
      page.title().catch(() => ""),
      page
        .evaluate(() => (document.body ? document.body.innerText : ""))
        .catch(() => ""),
      Promise.resolve(page.url()),
    ]);
    return { ok: true, title, text, html, finalUrl };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 页面上下文表单 POST（对标油猴通道 form_post，如 Discuz 附件购买 attachpay）：
 * 先开 referer 同源页建立上下文，再页面内 fetch POST（credentials:include 自动带
 * 登录 Cookie/CF 会话），HTTP 2xx 即成功。非幂等（重复提交可能重复扣金钱），
 * 调用方需以重抓帖子验证购买是否真实生效。
 */
export async function formPostViaBrowser(
  url: string,
  body: string,
  referer?: string,
): Promise<ManagedBrowserResult> {
  let page = null;
  try {
    const conn = await ensureBrowser();
    page = await conn.newPage();
    // 同源上下文：先导航到 referer（发起购买所在的帖子页），失败不阻断（POST 仍带 cookie）
    const contextUrl = referer?.trim() || url;
    await page
      .goto(contextUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      })
      .catch(() => {});

    const res = await page.evaluate(
      async (postUrl, postBody) => {
        try {
          const r = await fetch(postUrl, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: postBody,
          });
          const text = (await r.text()).slice(0, 20000);
          return { ok: r.ok, status: r.status, text, href: location.href };
        } catch (e) {
          return {
            ok: false,
            status: 0,
            text: "",
            href: location.href,
            error: String((e && (e as Error).message) || e),
          };
        }
      },
      url,
      body,
    );

    if (res.ok) {
      return {
        ok: true,
        title: "",
        text: res.text,
        html: res.text,
        finalUrl: res.href,
      };
    }
    return {
      ok: false,
      error:
        "error" in res && res.error
          ? String(res.error)
          : `HTTP ${res.status}（表单提交失败，结果未知，请重新检查购买状态）`,
    };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** 下载任务进行中登记：guid → 预期文件路径（downloadWillBegin 登记，completed 取出） */
type ActiveDownload = {
  taskId: string;
  expectedPath: string;
  filename: string;
  bookName: string;
  postUrl: string;
  timer: NodeJS.Timeout;
};

/**
 * 接管附件下载落盘（对标油猴通道 download 任务，fire-and-forget）：
 * Browser.setDownloadBehavior 把下载重定向到找书下载目录（浏览器不弹保存框），
 * downloadWillBegin 拿 Content-Disposition 解析的文件名，downloadProgress
 * completed 后广播事件（宿主按 bookName 替换/导入）。未购/登录失效时服务端
 * 返回 HTML 不触发下载 → 超时判失败。
 */
export function downloadBookSourceFileViaBrowser(
  url: string,
  opts: {
    referer?: string;
    postUrl?: string;
    bookName?: string;
    downloadDir?: string;
  } = {},
): { ok: boolean; error?: string } {
  const taskId = `mb-dl-${Date.now()}`;
  void (async () => {
    let page = null;
    let session = null;
    try {
      const conn = await ensureBrowser();
      const dir = opts.downloadDir?.trim() || app.getPath("downloads");
      await fs.promises.mkdir(dir, { recursive: true });

      // browser 级 CDP session：下载行为设置与事件监听都在这一条 session 上
      session = await conn.target().createCDPSession();
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      });

      const active = new Map<string, ActiveDownload>();
      let sawDownload = false;
      const settle = async (ev: ManagedBrowserDownloadEvent): Promise<void> => {
        // 等浏览器把 .crdownload 改名落定后再广播
        await sleep(DOWNLOAD_SETTLE_MS);
        emitDownloadEvent(ev);
      };

      session.on("Browser.downloadWillBegin", (e) => {
        sawDownload = true;
        const filename = e.suggestedFilename || "attachment";
        const expectedPath = path.join(dir, filename);
        active.set(e.guid, {
          taskId,
          expectedPath,
          filename,
          bookName: opts.bookName ?? "",
          postUrl: opts.postUrl ?? "",
          timer: setTimeout(() => {
            active.delete(e.guid);
            void settle({
              ok: false,
              taskId,
              bookName: opts.bookName ?? "",
              postUrl: opts.postUrl ?? "",
              error: `下载超时（${DOWNLOAD_TIMEOUT_MS / 1000}s 未完成，未购或登录态失效时服务端返回 HTML 不触发下载）`,
            });
          }, DOWNLOAD_TIMEOUT_MS),
        });
        console.log(
          `[managedBrowser] 下载开始 taskId=${taskId} book=${opts.bookName || "(无书名)"} file=${filename}`,
        );
      });

      session.on("Browser.downloadProgress", (e) => {
        const entry = active.get(e.guid);
        if (!entry) return;
        if (e.state === "completed") {
          clearTimeout(entry.timer);
          active.delete(e.guid);
          void (async () => {
            // allow 模式下重名文件会被追加 " (1)" 后缀，优先取预期路径，兜底扫同名 stem 最新文件
            let filePath = entry.expectedPath;
            if (!fs.existsSync(filePath)) {
              const ext = path.extname(entry.filename);
              const stem = path.basename(entry.filename, ext);
              const candidates = (await fs.promises.readdir(dir))
                .filter((n) => n.startsWith(stem) && n.endsWith(ext))
                .map((n) => path.join(dir, n))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
              filePath = candidates[0] ?? entry.expectedPath;
            }
            const size = fs.existsSync(filePath)
              ? fs.statSync(filePath).size
              : 0;
            console.log(
              `[managedBrowser] 下载完成 taskId=${taskId} file=${path.basename(filePath)} size=${size}`,
            );
            await settle({
              ok: true,
              taskId,
              filePath,
              size,
              filename: path.basename(filePath),
              bookName: entry.bookName,
              postUrl: entry.postUrl,
            });
          })();
        } else if (e.state === "canceled") {
          clearTimeout(entry.timer);
          active.delete(e.guid);
          void settle({
            ok: false,
            taskId,
            bookName: entry.bookName,
            postUrl: entry.postUrl,
            error: "下载被取消（浏览器/用户中断）",
          });
        }
      });

      // 触发下载：导航到附件直链，attachment 响应被浏览器转成下载（goto 会以
      // ERR_ABORTED 结束，属预期）；goto 正常 resolve = 服务端返回了普通页面
      // （未购/登录失效的 HTML 提示页），不触发下载，直接广播失败
      page = await conn.newPage();
      let downloadTriggered = false;
      const gotoErr = await page
        .goto(url, { timeout: PAGE_LOAD_TIMEOUT_MS })
        .then(() => null, (err: Error) => err);
      if (!gotoErr) {
        const pageTitle = await page.title().catch(() => "");
        emitDownloadEvent({
          ok: false,
          taskId,
          bookName: opts.bookName ?? "",
          postUrl: opts.postUrl ?? "",
          error: `未触发下载（服务端返回普通页面「${pageTitle.slice(0, 40)}」，附件未购或登录态可能已失效）`,
        });
      } else {
        downloadTriggered = true;
        console.log(
          `[managedBrowser] 下载导航结束（下载转导航属预期）: ${gotoErr.message.slice(0, 90)}`,
        );
      }

      // session 生命周期必须覆盖整个下载过程：active 非空时立即 detach 会让
      // downloadProgress 事件丢失（文件实际落盘却误报超时），故等全部下载终态后再清理；
      // 导航虽 abort 但始终没有任何下载事件时（网络失败等），等待窗口后兜底广播失败
      if (downloadTriggered) {
        const sawAnyDownload = () => active.size > 0 || sawDownload;
        const failDeadline = Date.now() + 10_000;
        while (!sawAnyDownload() && Date.now() < failDeadline) {
          await sleep(500);
        }
        if (!sawAnyDownload()) {
          emitDownloadEvent({
            ok: false,
            taskId,
            bookName: opts.bookName ?? "",
            postUrl: opts.postUrl ?? "",
            error: `未触发下载（导航异常：${gotoErr?.message.slice(0, 80) ?? "未知"}）`,
          });
        } else {
          const allDoneDeadline = Date.now() + DOWNLOAD_TIMEOUT_MS + 15_000;
          while (active.size > 0 && Date.now() < allDoneDeadline) {
            await sleep(500);
          }
        }
      }
    } catch (err) {
      emitDownloadEvent({
        ok: false,
        taskId,
        bookName: opts.bookName ?? "",
        postUrl: opts.postUrl ?? "",
        error: String(err instanceof Error ? err.message : err),
      });
    } finally {
      if (page) await page.close().catch(() => {});
      if (session) await session.detach().catch(() => {});
    }
  })();
  return { ok: true };
}

/**
 * 人为提前销毁：断开连接并关闭浏览器（close 走 CDP 优雅退出；
 * 本模块拉起的进程若 3s 未退出则 taskkill 树杀兜底）。
 * 连接到的是用户手动启动的实例时，同样会被关闭——销毁语义即「关闭浏览器」。
 */
export async function stopManagedBrowser(): Promise<void> {
  const conn = browser;
  browser = null;
  const proc = edgeProc;
  edgeProc = null;
  if (conn) {
    await conn.close().catch(() => {});
  }
  if (proc && proc.pid && !proc.killed) {
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        proc.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      }),
    ]);
    if (!exited) {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    }
  }
  console.log("[managedBrowser] 浏览器已销毁");
}

// app 退出时自动销毁浏览器（主入口 import 本模块即生效；无常驻副作用，浏览器懒启动）
void app.on("will-quit", () => {
  void stopManagedBrowser();
});

export function isManagedBrowserRunning(): boolean {
  return browser !== null && browser.connected;
}
