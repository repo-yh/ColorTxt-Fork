import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { WebSocketServer, WebSocket } from "ws";
import { getWebDisplayServer } from "./webDisplay";
import type { ExtensionWsDownloadEvent } from "../shared/bookSource/ipc";

const HOST = "127.0.0.1";
/** WS 挂载路径：与 Web 展示服务共用 8888 端口（单端口 HTTP+WS），upgrade 按路径分发 */
const WS_PATH = "/ws";
/**
 * 服务器→脚本协议层心跳间隔：检测半开连接（SW 挂起/被杀时 TCP 无 FIN，
 * 服务器侧 client 引用永远占位，新连接会被误拒）。
 * ping 为 WebSocket 协议层帧，浏览器自动回 pong，脚本代码无需任何配合；
 * 连续两轮无 pong（约 60s）判定死连接并强制断开。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * 单次下发超时（大于脚本侧页面 30s 加载超时）。
 * 超时未收到 task_result → 服务端重新下发同一条 task（带上缓存的 tabId）。
 */
const TASK_TIMEOUT_MS = 40_000;
/** 超时重推上限，超过后向调用方报失败（上限自定，防调用方永久等待） */
const TASK_MAX_RETRIES = 3;

/**
 * pageData 为脚本抓取结果（协议）：title/text/html/href；
 * 服务端对外展开平铺，finalUrl 对应脚本的 location.href（302/跳转后的最终 URL）。
 */
export type OpenAndGetHtmlResult =
  | {
      ok: true;
      title: string;
      text: string;
      html: string;
      finalUrl: string;
    }
  | { ok: false; error: string };

type TaskResolve = (result: OpenAndGetHtmlResult) => void;

type PendingTask = {
  url: string;
  timer: NodeJS.Timeout;
  resolve: TaskResolve;
  /** 上次尝试使用的标签页；重试时带上，脚本校验失效自动新建并回报新 tabId */
  tabId: number | null;
  retries: number;
  /** 表单 POST 任务（kind=form_post）：下发 body 与 referer */
  kind?: "form_post";
  body?: string;
  referer?: string;
  /** 表单 POST 非幂等（重复提交可能重复扣金钱）：超时/断线不重推，直接判失败 */
  noRetry?: boolean;
};

let wss: WebSocketServer | null = null;
/** 当前已连接的脚本（单连接策略：本机单人使用；新连接顶替旧连接） */
let client: WebSocket | null = null;
/** 心跳存活标记：每轮 interval 先查后 ping，收到协议层 pong 置 true */
let clientAlive = true;
let heartbeatTimer: NodeJS.Timeout | null = null;
/** 服务端维护的 connId → tabId 映射（单连接下即 clientTabId；连接断开后保留，重连复用） */
let clientTabId: number | null = null;
const pendingTasks = new Map<string, PendingTask>();
let taskIdSeq = 0;

function resolveTask(taskId: string, result: OpenAndGetHtmlResult): void {
  const task = pendingTasks.get(taskId);
  if (!task) return;
  clearTimeout(task.timer);
  pendingTasks.delete(taskId);
  task.resolve(result);
}

/** 文件重名时加时间戳后缀（下载目录内去重，保证每次落盘不覆盖既有文件） */
function uniqueDownloadPath(dir: string, filename: string): string {
  const safe = filename.replace(/[\\/:*?"<>|]/g, "_").trim() || "attachment";
  const full = path.join(dir, safe);
  if (!fs.existsSync(full)) return full;
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 收到脚本主动推送的下载结果后落盘（渲染侧下发的找书下载目录；调试端点未带目录时回退系统下载目录）。 */
async function saveDownloadFile(input: {
  taskId: string;
  url: string;
  postUrl: string;
  filename: string;
  data: Buffer;
  dir?: string;
}): Promise<string> {
  const dir = input.dir?.trim() || app.getPath("downloads");
  const filePath = uniqueDownloadPath(dir, input.filename);
  await fs.promises.writeFile(filePath, input.data);
  console.log(
    `[extensionWs] 下载文件已落盘 taskId=${input.taskId} size=${input.data.length} file=${input.filename} postUrl=${input.postUrl} path=${filePath}`,
  );
  return filePath;
}

/**
 * 下载开始时保存的归属信息：taskId → 文件元数据 + 书籍 name。
 * download_start 到达时写入；download_result 到达时按 taskId 取出，
 * 找到需要替换的书籍（按书名匹配文件列表条目，找书接线用）。
 */
type DownloadStartInfo = {
  taskId: string;
  url: string;
  postUrl: string;
  bookName: string;
  filename: string;
  contentType: string;
  size: number;
};
const downloadStarts = new Map<string, DownloadStartInfo>();

/** 下发时记录的下载目录：taskId → 渲染侧找书设置目录（download_result 落盘用，用后删除） */
const downloadTaskDirs = new Map<string, string>();

/** 主进程 → 应用渲染窗口：脚本 WS 下载落盘完成 / 失败事件（宿主组件按书名替换/导入 + toast） */
function emitDownloadEvent(ev: ExtensionWsDownloadEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const url = win.webContents.getURL();
    if (url.startsWith("data:") || url === "about:blank") continue;
    win.webContents.send("extensionWs:downloadEvent", ev);
  }
}

/** 下发任务并启动本次尝试的 40s 超时计时；超时按服务端规则重推或判失败 */
function dispatchTask(taskId: string): void {
  const task = pendingTasks.get(taskId);
  if (!task) return;
  if (!client || client.readyState !== WebSocket.OPEN) return;

  client.send(
    JSON.stringify({
      type: "task",
      taskId,
      url: task.url,
      tabId: task.tabId,
      ...(task.kind ? { kind: task.kind } : {}),
      ...(task.body !== undefined ? { body: task.body } : {}),
      ...(task.referer ? { referer: task.referer } : {}),
    }),
  );
  console.log(
    `[extensionWs] 任务下发（第 ${task.retries + 1} 次） taskId=${taskId} url=${task.url} tabId=${task.tabId ?? "无"}`,
  );

  clearTimeout(task.timer);
  task.timer = setTimeout(() => {
    if (task.noRetry || task.retries + 1 >= TASK_MAX_RETRIES) {
      pendingTasks.delete(taskId);
      console.warn(
        `[extensionWs] 任务超时（${
          task.noRetry
            ? "表单 POST 非幂等，不重推"
            : `已重推 ${task.retries} 次，放弃`
        }） taskId=${taskId} url=${task.url}`,
      );
      task.resolve({
        ok: false,
        error: task.noRetry
          ? "表单提交超时（结果未知，可能已提交成功，请重新检查购买状态）"
          : `任务超时（${TASK_MAX_RETRIES} 次尝试均未收到结果）`,
      });
      return;
    }
    task.retries += 1;
    console.warn(
      `[extensionWs] 任务超时，重新下发（带缓存 tabId=${task.tabId ?? "无"}） taskId=${taskId}`,
    );
    dispatchTask(taskId);
  }, TASK_TIMEOUT_MS);
}

/** 处理已连接脚本的消息（心跳 pong / 任务结果） */
function handleClientMessage(
  ws: WebSocket,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }

  // 下载开始推送（脚本 fetch 响应头到手、body 拉取前上报，带文件元数据）：
  // 把脚本返回的元数据与书籍 name 对应保存，之后文件推送上来时按 taskId
  // 找到需要替换的书籍；找书接线时这里是 UI 提示「开始下载」的挂点
  if (parsed.type === "download_start") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";
    const url = typeof parsed.url === "string" ? parsed.url : "";
    const postUrl = typeof parsed.postUrl === "string" ? parsed.postUrl : "";
    const bookName =
      typeof parsed.bookName === "string" ? parsed.bookName : "";
    if (typeof parsed.tabId === "number") {
      clientTabId = parsed.tabId;
    }
    const meta = parsed.meta as
      | { filename?: unknown; contentType?: unknown; size?: unknown }
      | undefined;
    const filename =
      typeof meta?.filename === "string" ? meta.filename : "";
    const contentType =
      typeof meta?.contentType === "string" ? meta.contentType : "";
    const size = typeof meta?.size === "number" ? meta.size : 0;
    if (taskId) {
      downloadStarts.set(taskId, {
        taskId,
        url,
        postUrl,
        bookName,
        filename,
        contentType,
        size,
      });
    }
    console.log(
      `[extensionWs] 下载开始 taskId=${taskId} book=${bookName || "(无书名)"} file=${filename || "?"} size=${size} type=${contentType || "?"} postUrl=${postUrl}（归属已保存）`,
    );
    return;
  }

  // 下载结果主动推送（脚本下载完成后上报，非任务应答）：成功解码落盘，失败仅日志
  if (parsed.type === "download_result") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";
    const url = typeof parsed.url === "string" ? parsed.url : "";
    const postUrl = typeof parsed.postUrl === "string" ? parsed.postUrl : "";
    // 顶层 name 由脚本携带（Content-Disposition 解析），服务器保存落盘与
    // 找书接线按书名匹配替换书籍条目都靠它；blob.filename 仅作兼容兜底
    const name =
      typeof parsed.name === "string" && parsed.name ? parsed.name : "";
    const pushedBookName =
      typeof parsed.bookName === "string" ? parsed.bookName : "";
    // 归属优先取下载开始时保存的映射，脚本带回的 bookName 兜底
    const start = taskId ? downloadStarts.get(taskId) : undefined;
    if (start) downloadStarts.delete(taskId);
    const bookName = start?.bookName || pushedBookName;
    // 落盘目录：下发时渲染侧带的找书下载目录（调试端点未带则回退系统下载目录）
    const taskDir = taskId ? (downloadTaskDirs.get(taskId) ?? "") : "";
    if (taskId) downloadTaskDirs.delete(taskId);
    if (typeof parsed.tabId === "number") {
      clientTabId = parsed.tabId;
    }
    const blob = parsed.blob as
      | { data?: unknown; contentType?: unknown; filename?: unknown }
      | undefined;
    if (parsed.ok === true && blob && typeof blob.data === "string") {
      const data = Buffer.from(blob.data, "base64");
      const filename =
        name ||
        (typeof blob.filename === "string" && blob.filename
          ? blob.filename
          : "attachment");
      console.log(
        `[extensionWs] 下载完成待归属 book=${bookName || "(无书名)"} file=${filename} postUrl=${postUrl}（按此查找需要替换的书籍）`,
      );
      saveDownloadFile({ taskId, url, postUrl, filename, data, dir: taskDir })
        .then((filePath) => {
          // 落盘完成广播：宿主组件按 bookName 匹配替换列表条目（替换文件逻辑）或首次导入
          emitDownloadEvent({
            ok: true,
            taskId,
            filePath,
            size: data.length,
            filename,
            bookName,
            postUrl,
          });
        })
        .catch((err: unknown) => {
          console.warn(
            `[extensionWs] 下载文件落盘失败 taskId=${taskId} file=${filename} error=${String(err)}`,
          );
          emitDownloadEvent({
            ok: false,
            taskId,
            bookName,
            postUrl,
            error: `落盘失败：${String(err)}`,
          });
        });
    } else {
      const dlError = String(parsed.error ?? "未知错误");
      console.warn(
        `[extensionWs] 下载失败推送 taskId=${taskId} book=${bookName || "(无书名)"} url=${url} postUrl=${postUrl} name=${name || "(未知)"} error=${dlError}`,
      );
      emitDownloadEvent({
        ok: false,
        taskId,
        bookName,
        postUrl,
        error: dlError,
      });
    }
    return;
  }

  if (parsed.type === "task_result") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";
    // 用脚本回报的 tabId 更新映射（成功/失败都带；tab 失效被新建时为新建后的 tabId）
    if (typeof parsed.tabId === "number") {
      clientTabId = parsed.tabId;
    }

    const task = taskId ? pendingTasks.get(taskId) : undefined;
    if (!task) {
      console.warn(
        `[extensionWs] 收到未知任务结果 taskId=${taskId || "(无)"}`,
      );
      return;
    }

    const pageData = parsed.pageData as
      | { title?: unknown; text?: unknown; html?: unknown; href?: unknown }
      | undefined;
    if (parsed.ok === true && pageData && typeof pageData.html === "string") {
      const finalUrl =
        typeof pageData.href === "string" ? pageData.href : task.url;
      console.log(
        `[extensionWs] 任务完成 taskId=${taskId} html长度=${pageData.html.length} finalUrl=${finalUrl} tabId=${clientTabId}`,
      );
      resolveTask(taskId, {
        ok: true,
        title: typeof pageData.title === "string" ? pageData.title : "",
        text: typeof pageData.text === "string" ? pageData.text : "",
        html: pageData.html,
        finalUrl,
      });
    } else {
      const error = String(parsed.error ?? "未知错误");
      console.warn(
        `[extensionWs] 任务失败 taskId=${taskId} error=${error} tabId=${clientTabId}`,
      );
      resolveTask(taskId, { ok: false, error });
    }
    return;
  }

  console.warn(`[extensionWs] 收到未知消息类型 type=${String(parsed.type)}`);
}

/** 启动服务器→脚本心跳（协议层 ping，浏览器自动回 pong；连续两轮无响应判定死连接） */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    if (!clientAlive) {
      console.warn(
        `[extensionWs] 心跳超时（连续两轮无 pong），判定死连接强制断开`,
      );
      try {
        client.terminate();
      } catch {
        // onclose 兜底清引用
      }
      return;
    }
    clientAlive = false;
    try {
      client.ping();
    } catch {
      // 发送失败下轮处理
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 启动 WS 服务（挂 Web 展示服务宿主共用 8888 端口，仅接受 /ws 路径，随其开关联动） */
export function startExtensionWsServer(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (wss) return Promise.resolve({ ok: true });

  const host = getWebDisplayServer();
  if (!host) {
    return Promise.resolve({
      ok: false,
      reason: "Web 展示服务未启动（WS 与其共用端口 8888）",
    });
  }

  return new Promise((resolve) => {
    // server+path 模式：ws 自行挂宿主 upgrade 监听并按路径过滤（非 /ws 的 upgrade 直接拒绝）
    const server = new WebSocketServer({ server: host, path: WS_PATH });

    wss = server;
    console.log(
      `[extensionWs] WS 服务已启动: ws://${HOST}:8888${WS_PATH}（随 Web 展示服务）`,
    );
    startHeartbeat();
    startExtensionWsDebugServer();
    resolve({ ok: true });

    server.on("connection", (ws, req) => {
      console.log(`[extensionWs] 收到连接 ${req.socket.remoteAddress}`);

      // 顶替策略：旧连接多半是 SW 挂起后的半开残留（TCP 无 FIN，服务器侧
      // readyState 仍显示 OPEN），直接断开让新连接接管——脚本重载/SW 唤醒后立即可用
      if (client) {
        console.log("[extensionWs] 已有旧脚本连接，新连接顶替（旧连接视为挂起残留）");
        try {
          client.terminate();
        } catch {
          // 忽略旧连接断开失败
        }
        client = null;
      }
      client = ws;
      clientAlive = true;
      console.log("[extensionWs] 脚本已连接");
      ws.on("pong", () => {
        clientAlive = true;
      });

      // WS 断开期间的 pending 任务视为待重试，脚本重连后重新下发（服务端断线重试规则）；
      // 表单 POST（非幂等）例外：断线不重推直接判失败，防止重复扣金钱
      if (pendingTasks.size > 0) {
        for (const taskId of [...pendingTasks.keys()]) {
          const task = pendingTasks.get(taskId);
          if (task?.noRetry) {
            pendingTasks.delete(taskId);
            console.warn(
              `[extensionWs] 断线期间表单 POST 任务不重推，判失败 taskId=${taskId} url=${task.url}`,
            );
            task.resolve({
              ok: false,
              error:
                "脚本连接断开，表单提交结果未知（可能已提交成功，请重新检查购买状态）",
            });
            continue;
          }
          dispatchTask(taskId);
        }
      }

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          console.warn("[extensionWs] 收到非法 JSON，忽略");
          return;
        }
        handleClientMessage(ws, parsed);
      });

      ws.on("close", (code) => {
        if (client === ws) {
          client = null;
          // 停掉本次尝试的计时器；任务保留在 pendingTasks，脚本重连后重推
          for (const task of pendingTasks.values()) {
            clearTimeout(task.timer);
          }
          // 下载为主动推送模式：断线期间脚本的 download_result 直接丢弃（脚本不暂存），
          // 服务器无 pending 可清；用户重新触发下载即可
          console.log(
            `[extensionWs] 脚本连接断开 code=${code}，pending 任务待重连后重推`,
          );
        }
      });

      ws.on("error", (err) => {
        console.warn(`[extensionWs] 连接错误: ${err.message}`);
      });
    });
  });
}

/** 指挥脚本打开页面并抓取 pageData（v1 引擎接入点雏形；内部 console.log 验证） */
export function openAndGetHtml(url: string): Promise<OpenAndGetHtmlResult> {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return Promise.resolve({
      ok: false,
      error: "脚本未连接（请确认油猴脚本已启用、服务开关已打开）",
    });
  }

  taskIdSeq += 1;
  const taskId = `task-${Date.now()}-${taskIdSeq}`;

  return new Promise((resolve) => {
    pendingTasks.set(taskId, {
      url,
      timer: setTimeout(() => {}, 0),
      resolve,
      tabId: clientTabId,
      retries: 0,
    });
    dispatchTask(taskId);
  });
}

/**
 * 指挥脚本在页面上下文 fetch 附件（fire-and-forget）。
 * 下发即返回，不 pending 等待回传（大附件/慢站会长时间占用等待）；
 * 脚本 fetch 响应头到手先推 download_start（带 bookName + 文件元数据，服务器归属保存），
 * 下载完成或失败后推 download_result（带 bookName + name + 帖子 URL），
 * 服务端按 taskId 归属映射找到需要替换的书籍，落盘/记日志保证失败也有感知。
 */
export function downloadBookSourceFileViaExtension(
  url: string,
  referer?: string,
  postUrl?: string,
  bookName?: string,
  downloadDir?: string,
): { ok: boolean; error?: string } {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return {
      ok: false,
      error: "脚本未连接（请确认油猴脚本已启用、服务开关已打开）",
    };
  }

  taskIdSeq += 1;
  const taskId = `dl-${Date.now()}-${taskIdSeq}`;

  if (taskId) downloadTaskDirs.set(taskId, downloadDir?.trim() ?? "");

  client.send(
    JSON.stringify({
      type: "task",
      taskId,
      url,
      tabId: clientTabId,
      kind: "download",
      referer,
      postUrl,
      bookName,
    }),
  );
  console.log(
    `[extensionWs] 下载任务下发 taskId=${taskId} book=${bookName || "(无书名)"} url=${url} tabId=${clientTabId ?? "无"}`,
  );
  return { ok: true };
}

/**
 * 指挥脚本在页面上下文发起表单 POST（如 Discuz 附件购买 attachpay）。
 * 同源 tab 内 fetch POST（credentials:include 自动带登录 Cookie/CF 会话），
 * pending 等 task_result（HTTP 2xx 即成功，pageData.html 为响应文本）。
 * 表单 POST 非幂等（重复提交可能重复扣金钱）：超时/断线不重推直接判失败，
 * 结果是否真实生效由调用方重抓帖子验证（可能实际已购买成功）。
 */
export function formPostViaExtension(
  url: string,
  body: string,
  referer?: string,
): Promise<OpenAndGetHtmlResult> {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return Promise.resolve({
      ok: false,
      error: "脚本未连接（请确认油猴脚本已启用、服务开关已打开）",
    });
  }

  taskIdSeq += 1;
  const taskId = `fp-${Date.now()}-${taskIdSeq}`;

  return new Promise((resolve) => {
    pendingTasks.set(taskId, {
      url,
      timer: setTimeout(() => {}, 0),
      resolve,
      tabId: clientTabId,
      retries: 0,
      kind: "form_post",
      body,
      referer,
      noRetry: true,
    });
    dispatchTask(taskId);
  });
}

/** 本机调试端点端口（仅 loopback），随 WS 服务同启停；8901 被系统服务占用，避开 */
const DEBUG_PORT = 8911;
let debugServer: http.Server | null = null;

/**
 * 调试用：把油猴通道暴露为本机 HTTP 接口，供 curl 手动验证与采集解析样本。
 * GET /openAndGetHtml?url=<encodeURIComponent 后的目标 URL>[&raw=1]
 *   raw=1 且抓取成功时直接返回 HTML 文本，否则返回 OpenAndGetHtmlResult JSON。
 * GET /download?url=<附件 URL>&referer=<发起页 URL>&postUrl=<帖子 URL>
 *   fire-and-forget：下发即返回；脚本 fetch 完成后主动推送 download_result，
 *   服务端落盘到系统下载目录（成功/失败都推送，失败记日志）。
 */
function startExtensionWsDebugServer(): void {
  if (debugServer) return;
  // 调试脚手架仅开发版提供，打包发布版不开此端口
  if (app.isPackaged) return;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${DEBUG_PORT}`);
    const target = u.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error:
            "用法: /openAndGetHtml?url=<encodeURIComponent 后的目标 URL>&raw=1 或 /download?url=<附件 URL>&referer=<发起页 URL>",
        }),
      );
      return;
    }
    if (u.pathname === "/openAndGetHtml") {
      console.log(`[extensionWs] 调试端点请求 ${target}`);
      openAndGetHtml(target)
        .then((r) => {
          if (u.searchParams.get("raw") === "1" && r.ok) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(r.html);
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(r));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        });
      return;
    }
    if (u.pathname === "/download") {
      const referer = u.searchParams.get("referer") ?? undefined;
      const postUrl = u.searchParams.get("postUrl") ?? undefined;
      const bookName = u.searchParams.get("bookName") ?? undefined;
      console.log(`[extensionWs] 调试端点下载下发 ${target}`);
      const r = downloadBookSourceFileViaExtension(
        target,
        referer,
        postUrl,
        bookName,
      );
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          r.ok
            ? {
                ok: true,
                message:
                  "下载任务已下发（fire-and-forget）；脚本 fetch 完成后主动推送 download_result，服务端落盘到系统下载目录（失败也推送并记日志）",
              }
            : r,
        ),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "未知端点" }));
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.warn(`[extensionWs] 调试端点启动失败: ${err.message}`);
  });
  server.listen(DEBUG_PORT, HOST);
  debugServer = server;
  console.log(`[extensionWs] 调试端点已启动: http://${HOST}:${DEBUG_PORT}`);
}

function stopExtensionWsDebugServer(): void {
  if (!debugServer) return;
  const server = debugServer;
  debugServer = null;
  server.close(() => {});
}

export function stopExtensionWsServer(): void {
  stopExtensionWsDebugServer();
  stopHeartbeat();
  clientAlive = true;
  if (!wss) return;
  const server = wss;
  wss = null;

  for (const task of pendingTasks.values()) {
    clearTimeout(task.timer);
    task.resolve({ ok: false, error: "服务已停止" });
  }
  pendingTasks.clear();
  downloadStarts.clear();
  downloadTaskDirs.clear();

  if (client) {
    try {
      client.close();
    } catch {
      // 忽略关闭失败
    }
    client = null;
  }
  clientTabId = null;

  server.close(() => {
    console.log("[extensionWs] WS 服务已停止");
  });
}

export function isExtensionWsRunning(): boolean {
  return wss !== null;
}
