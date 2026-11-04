import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { WebSocketServer, WebSocket } from "ws";
import { getWebDisplayServer, setWebDisplayDebugHandler } from "./webDisplay";
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
  /** 抓页任务强制越过脚本侧池子缓存（购买附件后重抓等需要新鲜页的场景） */
  skipCache?: boolean;
};

let wss: WebSocketServer | null = null;
/** 当前已连接的脚本（单连接策略：本机单人使用；新连接顶替旧连接） */
let client: WebSocket | null = null;
/** 心跳存活标记：每轮 interval 先查后 ping，收到协议层 pong 置 true */
let clientAlive = true;
/** 最近一次收到当前连接协议层 pong 的时间（连接接受时初始化为当下）：链路新鲜度
 * 判定用——半开连接（对端已死 TCP 无 FIN）readyState 仍 OPEN 但 pong 已停 */
let lastPongAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
/** 服务端维护的 connId → tabId 映射（单连接下即 clientTabId；连接断开后保留，重连复用） */
let clientTabId: number | null = null;
/** 当前 client 连接自报的锁时间（脚本文档内存时间，断线重连不变；null=旧脚本未上报） */
let clientLockAcquiredAt: number | null = null;
/** 已收到 TCP 连接但还没 hello 仲裁的脚本连接（仲裁期间不接管任务、不动现有连接） */
let pendingWs: WebSocket | null = null;
let pendingHelloTimer: NodeJS.Timeout | null = null;
const pendingTasks = new Map<string, PendingTask>();
let taskIdSeq = 0;

// ---- 脚本未连接自动拉起 ----

/** 未连接且无法拉起（服务未启动/拉起等待已超时）时返回给调用方的错误文案 */
const SCRIPT_NOT_CONNECTED_ERROR =
  "脚本未连接（请确认油猴脚本已启用、服务开关已打开）";
/** 自动拉起冷却：一次开页后 60s 内不重复开页（批量任务连环未连接时避免刷屏开 tab） */
const AUTO_OPEN_COOLDOWN_MS = 60_000;
/** 拉起后等待脚本连入时长：浏览器冷启动 + 站点慢页到 document-idle（脚本 @run-at 才连接） */
const AUTO_OPEN_WAIT_MS = 45_000;
let lastAutoOpenAt = 0;
/** 进行中的拉起等待：并发未连接任务共享同一次「开页+等待」，不各自空等满时长 */
let autoOpenWaiter: Promise<string | null> | null = null;

function isScriptConnected(): boolean {
  return client !== null && client.readyState === WebSocket.OPEN;
}

/**
 * 链路新鲜度：连接存在且一个心跳周期（+10s 余量，容忍主进程定时器调度延迟）内
 * 收到过协议层 pong。半开连接 readyState 仍 OPEN 但 pong 已停——仅凭 readyState
 * 判活会把任务推进死连接（实测 40s 超时重推全部空转无结果）
 */
function isClientLinkFresh(): boolean {
  return (
    client !== null &&
    client.readyState === WebSocket.OPEN &&
    Date.now() - lastPongAt <= HEARTBEAT_INTERVAL_MS + 10_000
  );
}

/**
 * 任务下发前的连接保障：脚本未连接时用系统默认浏览器打开「拉起页」（油猴 @match
 * 站点内页面，document-idle 加载完脚本自动连入 WS），等待连入后任务照常下发。
 * 拉起页优先发起页（表单 POST 的 referer / 下载的 postUrl 帖子页），避免默认浏览器
 * 直接 GET 附件/购买页产生副作用；抓页任务即任务 URL 本身（GET 页面无副作用）。
 * 冷却期内不重复开页也不空等，直接判未连接失败（上次拉起已证连接不来）。
 * 返回 null 表示已连接可继续下发；否则返回调用方应上报的错误文案。
 */
function ensureScriptConnectedBeforeTask(
  url: string,
  preferOpenUrl?: string,
  opts?: { ignoreCooldown?: boolean },
): Promise<string | null> {
  // 半开残留先断开：readyState 仍 OPEN 的死连接会让下方「已连接」判定与拉起等待
  // 循环全部误判（任务照旧推进死连接 / 白等 45s）
  if (client && !isClientLinkFresh()) {
    console.warn(
      "[extensionWs] 连接超过心跳周期无 pong（半开残留），先断开再拉起",
    );
    try {
      client.terminate();
    } catch {
      // onclose 兜底清引用
    }
  }
  if (isScriptConnected()) return Promise.resolve(null);
  if (autoOpenWaiter) return autoOpenWaiter;
  // 冷却检查放在调用时点（拉起进行中的并入方共享同一次开页等待，不走此检查）：
  // 断线恢复路径用 ignoreCooldown 绕过——冷却防的是「从未连上时连环开页刷屏」，
  // 连接被关闭/杀掉后的恢复拉起是唯一自愈路径，被冷却挡住会让批量检查挂死
  if (
    opts?.ignoreCooldown !== true &&
    Date.now() - lastAutoOpenAt <= AUTO_OPEN_COOLDOWN_MS
  ) {
    console.warn("[extensionWs] 脚本未连接（自动拉起冷却期内），任务判失败");
    return Promise.resolve(SCRIPT_NOT_CONNECTED_ERROR);
  }
  autoOpenWaiter = doEnsureScriptConnected(preferOpenUrl?.trim() || url).finally(
    () => {
      autoOpenWaiter = null;
    },
  );
  return autoOpenWaiter;
}

async function doEnsureScriptConnected(
  openUrl: string,
): Promise<string | null> {
  if (!wss) return SCRIPT_NOT_CONNECTED_ERROR;
  lastAutoOpenAt = Date.now();
  console.log(
    `[extensionWs] 脚本未连接，自动打开书源页拉起脚本: ${openUrl}（等待连入 ≤${Math.round(AUTO_OPEN_WAIT_MS / 1000)}s）`,
  );
  try {
    await shell.openExternal(openUrl);
  } catch (err) {
    console.warn(`[extensionWs] 自动打开书源页失败: ${String(err)}`);
  }
  const deadline = Date.now() + AUTO_OPEN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!wss) return SCRIPT_NOT_CONNECTED_ERROR;
    if (isScriptConnected()) {
      console.log("[extensionWs] 脚本已连入（自动拉起成功），继续下发任务");
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn(
    `[extensionWs] 等待脚本连入超时（${Math.round(AUTO_OPEN_WAIT_MS / 1000)}s），任务判失败`,
  );
  return "脚本未连接（已自动打开书源页等待脚本连入，仍超时未连上；请确认油猴脚本已启用、服务开关已打开）";
}

/**
 * 断线后挂起任务恢复：连接断开时 pending 任务保留等「重连后重推」，但重连不会
 * 自己发生——自动拉起只在新建任务时触发，而批量检查更新串行等在本任务回传上
 * 不新建任务，实测会永久挂死（主 tab 被关闭后任务重推进死连接直到放弃，之后
 * 无连接也无拉起，批量卡死不开新 tab）。等 8s 给脚本自愈重连（退避首试 1s，
 * 常见 1-2s 内恢复，刷新/跳转场景不误拉起），仍无连接才自动拉起（绕过冷却）；
 * 拉起失败把挂起任务全部判失败，渲染侧拿到明确错误而非永久等待
 */
const DISCONNECT_RECOVERY_DELAY_MS = 8_000;
let pendingRecoveryTimer: NodeJS.Timeout | null = null;

function schedulePendingTaskRecovery(): void {
  if (pendingTasks.size === 0) return;
  if (pendingRecoveryTimer) return;
  pendingRecoveryTimer = setTimeout(() => {
    pendingRecoveryTimer = null;
    if (pendingTasks.size === 0 || isScriptConnected()) return;
    const first = [...pendingTasks.values()][0]!;
    console.warn(
      `[extensionWs] 连接断开 ${Math.round(DISCONNECT_RECOVERY_DELAY_MS / 1000)}s 仍无脚本连入，自动拉起恢复挂起任务（${pendingTasks.size} 条）`,
    );
    // 拉起页用任务发起页 referer（抓页/表单 POST 的 referer 都是帖子页，GET 无副作用）；
    // 下载走 download_start 推送模型不在 pendingTasks，无需考虑
    const preferOpenUrl = first.referer;
    ensureScriptConnectedBeforeTask(first.url, preferOpenUrl, {
      ignoreCooldown: true,
    }).then((error) => {
      // 拉起成功：acceptConnection 已按 pending 重推，无需动作
      if (!error) return;
      for (const [taskId, task] of [...pendingTasks]) {
        pendingTasks.delete(taskId);
        clearTimeout(task.timer);
        console.warn(
          `[extensionWs] 拉起未恢复连接，挂起任务判失败 taskId=${taskId} url=${task.url}`,
        );
        task.resolve({ ok: false, error });
      }
    });
  }, DISCONNECT_RECOVERY_DELAY_MS);
}

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
  if (!client || client.readyState !== WebSocket.OPEN) {
    console.warn(
      `[extensionWs] 任务下发时无可用连接，挂起等待重连/拉起恢复 taskId=${taskId}`,
    );
    return;
  }

  client.send(
    JSON.stringify({
      type: "task",
      taskId,
      url: task.url,
      tabId: task.tabId,
      ...(task.kind ? { kind: task.kind } : {}),
      ...(task.body !== undefined ? { body: task.body } : {}),
      ...(task.referer ? { referer: task.referer } : {}),
      ...(task.skipCache ? { skipCache: true } : {}),
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
    // 重推前先验链路新鲜度：半开连接 readyState 仍 OPEN 但 pong 已停，盲推会把
    // 本轮尝试又推进死连接。不新鲜（或已无连接）→ 断开等恢复：close 排断线恢复
    // 拉起新 tab，重连后 acceptConnection 统一重推挂起任务
    if (!isClientLinkFresh()) {
      task.retries += 1;
      console.warn(
        `[extensionWs] 任务超时且链路不新鲜（超一个心跳周期无 pong），断开等重连恢复 taskId=${taskId}`,
      );
      try {
        client?.terminate();
      } catch {
        // onclose 兜底清引用
      }
      return;
    }
    task.retries += 1;
    console.warn(
      `[extensionWs] 任务超时，重新下发（带缓存 tabId=${task.tabId ?? "无"}） taskId=${taskId}`,
    );
    dispatchTask(taskId);
  }, TASK_TIMEOUT_MS);
}

/** hello 仲裁后的接受/顶替/拒绝（lockAcquiredAt=null 表示旧脚本未上报，按原行为接受）。
 * 拒绝路径只回消息并立即断开本连接，现有 client 不动；接受/顶替路径接管任务下发 */
function acceptConnection(
  ws: WebSocket,
  lockAcquiredAt: number | null,
): void {
  if (pendingWs === ws) {
    clearPendingHello();
    pendingWs = null;
  }
  if (client) {
    if (
      lockAcquiredAt !== null &&
      clientLockAcquiredAt !== null &&
      lockAcquiredAt < clientLockAcquiredAt
    ) {
      console.log(
        `[extensionWs] 新连接锁时间过旧（${lockAcquiredAt} < ${clientLockAcquiredAt}），拒绝（现有连接保持）`,
      );
      try {
        ws.send(
          JSON.stringify({ type: "connect_rejected", reason: "lock_time_stale" }),
        );
      } catch {
        // 忽略发送失败
      }
      try {
        ws.close(4000, "lock time stale");
      } catch {
        // 忽略关闭失败
      }
      return;
    }
    // 顶替：旧连接多半是 SW 挂起后的半开残留（TCP 无 FIN，服务器侧 readyState
    // 仍显示 OPEN）——时间相等=同文档断线重连自己的残留；更大=新文档接管；
    // 任一方未上报时间（旧脚本）=原顶替行为
    console.log("[extensionWs] 已有旧脚本连接，新连接顶替（旧连接视为挂起残留）");
    try {
      client.terminate();
    } catch {
      // 忽略旧连接断开失败
    }
    client = null;
    clientLockAcquiredAt = null;
  }
  client = ws;
  clientLockAcquiredAt = lockAcquiredAt;
  clientAlive = true;
  // 新连接视为新鲜链路（首个心跳 ping 在 ≤30s 内核实）
  lastPongAt = Date.now();
  // 连接已恢复，取消挂起的断线恢复拉起（挂起任务在下方按 pending 重推）
  if (pendingRecoveryTimer) {
    clearTimeout(pendingRecoveryTimer);
    pendingRecoveryTimer = null;
  }
  console.log(
    `[extensionWs] 脚本已连接${
      lockAcquiredAt !== null ? `（锁时间 ${lockAcquiredAt}）` : ""
    }`,
  );

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
}

function clearPendingHello(): void {
  if (pendingHelloTimer) {
    clearTimeout(pendingHelloTimer);
    pendingHelloTimer = null;
  }
}

/** 处理已连接脚本的消息（hello 仲裁 / 心跳 pong / 任务结果） */
function handleClientMessage(
  ws: WebSocket,
  parsed: Record<string, unknown>,
): void {
  // 连接仲裁 hello（脚本 onopen 后第一条，tabId 由 sendJson 统一注入）：带锁时间
  // 触发挂起连接的接受/顶替/拒绝；已仲裁连接重复发的 hello 忽略
  if (parsed.type === "hello") {
    if (typeof parsed.tabId === "number") {
      clientTabId = parsed.tabId;
    }
    const time =
      typeof parsed.lockAcquiredAt === "number" ? parsed.lockAcquiredAt : null;
    if (ws === pendingWs) {
      acceptConnection(ws, time);
    }
    return;
  }

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

      // 顶替仲裁延后到 hello：脚本连接后第一条消息自报 lockAcquiredAt（文档内存
      // 时间，断线重连不变），服务端据此仲裁——服务器无现存连接时不看时间直接
      // 接受（网络闪断主 tab 重连不能被旧时间挡住）；有现存连接时只有时间不小于
      // 现存连接的才顶替（相等=同文档重连半开残留，更小=旧文档来抢，回
      // connect_rejected 后立即断开本连接、现有连接不动，脚本收到后转 worker 不
      // 再重试）。仲裁前连接挂起：不接管任务下发；上个 pending 未走完又来新连接
      // （异常）时旧的视为僵死直接关
      if (pendingWs) {
        console.log("[extensionWs] 上一个连接未完成hello仲裁，视为僵死关闭");
        clearPendingHello();
        try {
          pendingWs.terminate();
        } catch {
          // 忽略
        }
        pendingWs = null;
      }
      pendingWs = ws;
      pendingHelloTimer = setTimeout(() => {
        pendingHelloTimer = null;
        // 超时未收到 hello（旧版本脚本不发）：按原「新连接顶替」行为接受，保证
        // 升级过渡期可用
        console.log("[extensionWs] 未收到 hello（旧脚本？），按原顶替策略接受");
        acceptConnection(ws, null);
      }, 5000);
      ws.on("pong", () => {
        clientAlive = true;
        lastPongAt = Date.now();
      });

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
        if (pendingWs === ws) {
          clearPendingHello();
          pendingWs = null;
          console.log(`[extensionWs] 连接在hello仲裁前断开 code=${code}`);
          return;
        }
        if (client === ws) {
          client = null;
          clientLockAcquiredAt = null;
          // 停掉本次尝试的计时器；任务保留在 pendingTasks，脚本重连后重推
          for (const task of pendingTasks.values()) {
            clearTimeout(task.timer);
          }
          // 下载为主动推送模式：断线期间脚本的 download_result 直接丢弃（脚本不暂存），
          // 服务器无 pending 可清；用户重新触发下载即可
          console.log(
            `[extensionWs] 脚本连接断开 code=${code}，pending 任务待重连后重推`,
          );
          // 排断线恢复：8s 后仍无脚本连入则自动拉起（重连不会自己发生，见函数注释）
          schedulePendingTaskRecovery();
        }
      });

      ws.on("error", (err) => {
        console.warn(`[extensionWs] 连接错误: ${err.message}`);
      });
    });
  });
}

/** 指挥脚本打开页面并抓取 pageData（v1 引擎接入点雏形；内部 console.log 验证） */
export function openAndGetHtml(
  url: string,
  opts?: { skipCache?: boolean },
): Promise<OpenAndGetHtmlResult> {
  // 未连接自动拉起：打开任务页等脚本连入后照常下发（详见 ensureScriptConnectedBeforeTask）
  return ensureScriptConnectedBeforeTask(url).then((error) => {
    if (error) return { ok: false as const, error };

    taskIdSeq += 1;
    const taskId = `task-${Date.now()}-${taskIdSeq}`;

    return new Promise<OpenAndGetHtmlResult>((resolve) => {
      pendingTasks.set(taskId, {
        url,
        timer: setTimeout(() => {}, 0),
        resolve,
        tabId: clientTabId,
        retries: 0,
        skipCache: opts?.skipCache === true,
      });
      dispatchTask(taskId);
    });
  });
}

/**
 * 指挥脚本在页面上下文 fetch 附件（fire-and-forget）。
 * 下发即返回，不 pending 等待回传（大附件/慢站会长时间占用等待）；
 * 脚本 fetch 响应头到手先推 download_start（带 bookName + 文件元数据，服务器归属保存），
 * 下载完成或失败后推 download_result（带 bookName + name + 帖子 URL），
 * 服务端按 taskId 归属映射找到需要替换的书籍，落盘/记日志保证失败也有感知。
 */
export async function downloadBookSourceFileViaExtension(
  url: string,
  referer?: string,
  postUrl?: string,
  bookName?: string,
  downloadDir?: string,
): Promise<{ ok: boolean; error?: string }> {
  // 未连接自动拉起：优先开发起页 postUrl（默认浏览器直接 GET 附件 URL 会把附件
  // 下载进浏览器下载目录），无发起页才用任务 URL 兜底
  const error = await ensureScriptConnectedBeforeTask(url, postUrl || referer);
  if (error) return { ok: false, error };
  // await 之后 client 收窄失效：send 前再判一次（断开则不创建任务直接失败）
  if (!client || client.readyState !== WebSocket.OPEN) {
    return { ok: false, error: SCRIPT_NOT_CONNECTED_ERROR };
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
  // 未连接自动拉起：优先开 referer 帖子页（默认浏览器直接 GET attachpay 页会展示
  // 购买确认页，有误导性），无 referer 才用任务 URL 兜底
  return ensureScriptConnectedBeforeTask(url, referer).then((error) => {
    if (error) return { ok: false as const, error };

    taskIdSeq += 1;
    const taskId = `fp-${Date.now()}-${taskIdSeq}`;

    return new Promise<OpenAndGetHtmlResult>((resolve) => {
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
  });
}

/**
 * 调试用：把油猴通道暴露为 HTTP 接口——并入 Web 展示服务 8888 单端口
 * （/api/debug/*，宿主按前缀转交），供 curl 手动验证与采集解析样本。
 * 仅开发版注册（打包发布版无此路由，/api/debug/* 走宿主 404）。
 * GET /api/debug/openAndGetHtml?url=<encodeURIComponent 后的目标 URL>[&raw=1]
 *   raw=1 且抓取成功时直接返回 HTML 文本，否则返回 OpenAndGetHtmlResult JSON。
 * GET /api/debug/download?url=<附件 URL>&referer=<发起页 URL>&postUrl=<帖子 URL>
 *   fire-and-forget：下发即返回；脚本 fetch 完成后主动推送 download_result，
 *   服务端落盘到系统下载目录（成功/失败都推送，失败记日志）。
 */
function startExtensionWsDebugServer(): void {
  if (app.isPackaged) return;
  setWebDisplayDebugHandler(handleDebugRequest);
  console.log(
    "[extensionWs] 调试端点已并入 Web 展示服务单端口: http://127.0.0.1:8888/api/debug/*（仅开发版）",
  );
}

function stopExtensionWsDebugServer(): void {
  setWebDisplayDebugHandler(null);
}

/** 调试请求处理（webDisplay 宿主按 /api/debug/ 前缀转交，url 已解析） */
async function handleDebugRequest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const target = url.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: false,
        error:
          "用法: /api/debug/openAndGetHtml?url=<encodeURIComponent 后的目标 URL>&raw=1 或 /api/debug/download?url=<附件 URL>&referer=<发起页 URL>",
      }),
    );
    return;
  }
  if (url.pathname === "/api/debug/openAndGetHtml") {
    console.log(`[extensionWs] 调试端点请求 ${target}`);
    openAndGetHtml(target)
      .then((r) => {
        if (url.searchParams.get("raw") === "1" && r.ok) {
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
  if (url.pathname === "/api/debug/download") {
    const referer = url.searchParams.get("referer") ?? undefined;
    const postUrl = url.searchParams.get("postUrl") ?? undefined;
    const bookName = url.searchParams.get("bookName") ?? undefined;
    console.log(`[extensionWs] 调试端点下载下发 ${target}`);
    try {
      const r = await downloadBookSourceFileViaExtension(
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
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "未知端点" }));
}

export function stopExtensionWsServer(): void {
  stopExtensionWsDebugServer();
  stopHeartbeat();
  clientAlive = true;
  if (pendingRecoveryTimer) {
    clearTimeout(pendingRecoveryTimer);
    pendingRecoveryTimer = null;
  }
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

  if (pendingWs) {
    clearPendingHello();
    try {
      pendingWs.close();
    } catch {
      // 忽略关闭失败
    }
    pendingWs = null;
  }
  if (client) {
    try {
      client.close();
    } catch {
      // 忽略关闭失败
    }
    client = null;
  }
  clientTabId = null;
  clientLockAcquiredAt = null;

  server.close(() => {
    console.log("[extensionWs] WS 服务已停止");
  });
}

export function isExtensionWsRunning(): boolean {
  return wss !== null;
}
