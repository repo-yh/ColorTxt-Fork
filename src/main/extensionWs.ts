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
 * 单次下发超时（大于脚本侧页面 30s 加载超时，脚本存活时 30s 内必有成功/失败回声）。
 * 超时未收到 task_result → 连接必然不可用：半开（readyState OPEN 但 pong 停）或
 * 脚本 tab 被浏览器睡眠冻结（协议层 pong 由浏览器网络层自动应答不经过 renderer，
 * 连接照常「健康」但任务消息无人消费）→ 断开等恢复：close 排断线恢复拉起新 tab，
 * 重连后 acceptConnection 统一重推挂起任务。
 */
const TASK_TIMEOUT_MS = 40_000;
/** 超时重推上限，超过后向调用方报失败（上限自定，防调用方永久等待） */
const TASK_MAX_RETRIES = 3;
/**
 * 链路激活状态（探测状态）机：未激活时任务队列禁止弹出，下发前先发应用层探测
 * （probe），脚本 renderer 消费消息回 probe_ack 才激活——协议层 pong 由浏览器
 * 网络层代答（tab 被睡眠冻结后照回不误），不能作为 renderer 存活凭据；激活不随
 * 收到任何消息自动更新，只有探测通过触发。空闲（队列空一段时间无新任务）自动
 * 回到未激活，下批任务重新探测。
 */
/** 激活态空闲回收：队列为空且无在飞任务起算，到期回到未激活（下次任务先探测） */
const LINK_IDLE_DEACTIVATE_MS = 60_000;
/** 激活后队列弹出节奏：每 1s 弹一个，堆积任务逐个放行避免浏览器瞬时开大量 worker tab */
const QUEUE_POP_INTERVAL_MS = 1_000;
/** 探测应答超时：probe 发出后超时未收 probe_ack → renderer 冻结/死亡 → 断开走恢复 */
const PROBE_TIMEOUT_MS = 5_000;
/** 链路是否已激活（探测通过）；连接断开即作废，重连后重新探测 */
let linkActive = false;
/** 探测等待计时器（probe 发出后超时未 ack 判冻结断开）与当前探测 id（应答匹配） */
let probeTimer: NodeJS.Timeout | null = null;
let currentProbeId: string | null = null;
let probeIdSeq = 0;
/** 探测等待者（下载等非队列任务的下发前等激活）：激活/超时/断线时统一兑现 */
const probeWaiters: Array<(ok: boolean) => void> = [];
/** 队列弹出节拍器（单实例防重入）与激活态空闲倒计时 */
let queuePopTimer: NodeJS.Timeout | null = null;
let idleDeactivateTimer: NodeJS.Timeout | null = null;
/** 已下发未回包的在飞任务计数（并发上限已撤，仅作日志与让位参考） */
let activeTaskCount = 0;

/**
 * pageData 为脚本抓取结果（协议）：title/text/html/href/rateLimited；
 * 服务端对外展开平铺，finalUrl 对应脚本的 location.href（302/跳转后的最终 URL）；
 * rateLimited=脚本检测到站点限流/拒答页的显式标志（1.3.34，文案命中即置位），
 * 引擎限流判定显式优先、URL 形态推断兜底。
 */
export type OpenAndGetHtmlResult =
  | {
      ok: true;
      title: string;
      text: string;
      html: string;
      finalUrl: string;
      rateLimited?: boolean;
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
  /** 已下发未终态（在飞计数依据）：排队中 false，下发置 true；断线挂起等
   * 重推时由 acceptConnection 重置为 false 重新入队 */
  sent: boolean;
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

function getSafeExternalHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function doEnsureScriptConnected(
  openUrl: string,
): Promise<string | null> {
  if (!wss) return SCRIPT_NOT_CONNECTED_ERROR;
  lastAutoOpenAt = Date.now();
  console.log(
    `[extensionWs] 脚本未连接，自动打开书源页拉起脚本: ${openUrl}（等待连入 ≤${Math.round(AUTO_OPEN_WAIT_MS / 1000)}s）`,
  );
  const safeOpenUrl = getSafeExternalHttpUrl(openUrl);
  if (!safeOpenUrl) {
    console.warn(`[extensionWs] 拒绝打开不安全 URL: ${openUrl}`);
    return "脚本未连接（自动拉起被拒绝：URL 非法或协议不受支持）";
  }
  try {
    // 拉起 URL hash 带一次性接管令牌（与 worker spawn token 同机制）：脚本解析到
    // 即无条件抢占锁当主，绕开旧 tab 锁 TTL 竞争（冻结 tab 不续约、锁 12s 内不过
    // 期，等锁会连环开 tab）。令牌仅客户端消费，服务端不校验——连接仲裁由现有
    // lockAcquiredAt 逻辑天然覆盖（新 tab 文档最新，时间必然更大）
    const spawnToken =
      Date.now().toString(36) + Math.random().toString(36).slice(2);
    await shell.openExternal(`${safeOpenUrl}#ctws_spawn=${spawnToken}`);
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
  // 活跃任务终态让位：在飞计数减一，排队任务继续按节拍弹出；队列弹尽转入空闲倒计时
  if (task.sent && activeTaskCount > 0) activeTaskCount -= 1;
  task.resolve(result);
  scheduleQueuePop();
  refreshIdleTimer();
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

/**
 * 队列弹出放行入口（三个调用时机：任务创建入队、活跃任务终态让位、连接接受挂起
 * 任务重推）：激活 → 排弹出节拍；未激活 → 触发探测（通过后自动开始弹出）。
 * 任务堆积 + WS 不可用（断连/tab 睡眠冻结）期间任务全部滞留队列，探测通过后按
 * 节奏逐个放行，避免连接恢复瞬间全量下发让脚本同时开大量 worker tab
 */
function enqueueOrProbe(): void {
  // 新任务到达，取消空闲倒计时（链路即将干活，不回收激活态）
  if (idleDeactivateTimer) {
    clearTimeout(idleDeactivateTimer);
    idleDeactivateTimer = null;
  }
  if (linkActive) {
    scheduleQueuePop();
    return;
  }
  startProbe();
}

/**
 * 下发应用层探测：脚本 renderer 必须消费 WS 消息并回 probe_ack 才算通过——协议层
 * pong 由浏览器网络层代答（tab 被睡眠冻结后照回），无法证明脚本上下文存活。
 * 超时未应答 = tab 可能已失效 → 主动断开走恢复链路（close 排 8s 拉起新 tab），
 * 新 tab 连入后重新探测，通过才放行队列
 */
function startProbe(): void {
  if (linkActive || probeTimer) return;
  if (!isScriptConnected()) return;
  // 无排队任务也无等待者时不空探（连接刚接受无任务、探测已通过后的入队等）
  const hasQueued = [...pendingTasks.values()].some((t) => !t.sent);
  if (!hasQueued && probeWaiters.length === 0) return;
  const probeId = `probe-${Date.now()}-${++probeIdSeq}`;
  currentProbeId = probeId;
  try {
    client!.send(JSON.stringify({ type: "probe", probeId }));
  } catch {
    currentProbeId = null;
    return;
  }
  console.log(`[extensionWs] 链路未激活，下发探测 ${probeId}（等待 renderer 应答）`);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    currentProbeId = null;
    // 断线/已激活场景等待者已在别处兑现，这里只处理「连接在但脚本无应答」
    resetProbeState(false);
    if (linkActive || !isScriptConnected()) return;
    console.warn(
      "[extensionWs] 探测超时无应答（renderer 冻结/失效，协议层 pong 不可信），断开等恢复拉起新 tab",
    );
    try {
      client?.terminate();
    } catch {
      // onclose 兜底清引用
    }
  }, PROBE_TIMEOUT_MS);
}

/** 重置探测状态：清计时器与探测 id，统一兑现等待者（ok=探测是否通过） */
function resetProbeState(ok: boolean): void {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  currentProbeId = null;
  const waiters = probeWaiters.splice(0);
  for (const w of waiters) w(ok);
}

/**
 * 队列弹出节拍：激活态每 1s 弹一个未下发任务（Map FIFO），堆积任务逐个放行——
 * 浏览器逐个开 worker tab 有喘息，防瞬时全量下发开一片；节拍器单实例防重入，
 * 队列弹尽后转入空闲倒计时
 */
function scheduleQueuePop(): void {
  if (!linkActive) return;
  if (queuePopTimer) return;
  queuePopTimer = setTimeout(() => {
    queuePopTimer = null;
    if (!linkActive || !isScriptConnected()) return;
    for (const [taskId, task] of pendingTasks) {
      if (task.sent) continue;
      task.sent = true;
      activeTaskCount += 1;
      sendTaskToClient(taskId, task);
      break;
    }
    if ([...pendingTasks.values()].some((t) => !t.sent)) {
      scheduleQueuePop();
    } else {
      refreshIdleTimer();
    }
  }, QUEUE_POP_INTERVAL_MS);
}

/**
 * 激活态空闲回收：队列为空且无在飞任务起倒计时，到期回到未激活——激活只代表
 * 「探测那一刻 renderer 活着」，空闲越久 tab 被睡眠的可能性越大，下次新任务必须
 * 重新探测（不因收到任何消息自动续期，协议层 pong 不可信）
 */
function refreshIdleTimer(): void {
  if (idleDeactivateTimer) {
    clearTimeout(idleDeactivateTimer);
    idleDeactivateTimer = null;
  }
  if (!linkActive) return;
  if (pendingTasks.size > 0) return;
  idleDeactivateTimer = setTimeout(() => {
    idleDeactivateTimer = null;
    if (!linkActive || pendingTasks.size > 0) return;
    linkActive = false;
    console.log(
      `[extensionWs] 队列空闲超 ${Math.round(LINK_IDLE_DEACTIVATE_MS / 1000)}s，链路回到未激活（下次任务先探测）`,
    );
  }, LINK_IDLE_DEACTIVATE_MS);
}

/**
 * 下载等非队列任务的下发前置：未激活时先探测并等待结果（激活/超时/断线兑现）。
 * 探测失败已断开走恢复链路，调用方应放弃本次下发让用户重试
 */
function ensureLinkActive(): Promise<boolean> {
  if (linkActive) return Promise.resolve(true);
  if (!isScriptConnected()) return Promise.resolve(false);
  const waiter = new Promise<boolean>((resolve) => {
    probeWaiters.push(resolve);
  });
  startProbe();
  return waiter;
}

/** 发送任务消息并启动本次尝试的 40s 超时计时（仅 scheduleQueuePop 弹出节拍内调用） */
function sendTaskToClient(taskId: string, task: PendingTask): void {
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
      ...(task.skipCache ? { skipCache: true } : {}),
    }),
  );
  console.log(
    `[extensionWs] 任务下发（第 ${task.retries + 1} 次） taskId=${taskId} url=${task.url} tabId=${task.tabId ?? "无"}（在飞 ${activeTaskCount}）`,
  );

  clearTimeout(task.timer);
  task.timer = setTimeout(() => {
    // 连接处理先行：任务超时 = 本次尝试失败，连接必然不可用——半开（pong 停）或
    // 脚本 renderer 被浏览器睡眠冻结（协议层 pong 由浏览器网络层自动应答，连接
    // 照常「健康」但脚本侧页面任务 30s 内必有回声，40s 超时即消息无人消费）。
    // 统一断开走恢复链路：close 排 8s 断线恢复拉起新 tab，重连后 acceptConnection
    // 统一重推挂起任务（重新探测激活后按节拍弹出）；链路新鲜时盲重推只会在冻结 tab 上空转重推，
    // 直到用户手动点击 tab 触发恢复
    console.warn(
      `[extensionWs] 任务超时，链路${
        isClientLinkFresh()
          ? "新鲜但脚本无回声（疑似 tab 被睡眠冻结）"
          : "不新鲜（超一个心跳周期无 pong，半开）"
      }，断开等重连恢复 taskId=${taskId} url=${task.url}`,
    );
    try {
      client?.terminate();
    } catch {
      // onclose 兜底清引用
    }
    if (task.noRetry || task.retries + 1 >= TASK_MAX_RETRIES) {
      console.warn(
        `[extensionWs] 任务超时（${
          task.noRetry
            ? "表单 POST 非幂等，不重推"
            : `已重推 ${task.retries} 次，放弃`
        }） taskId=${taskId} url=${task.url}`,
      );
      // 走 resolveTask 统一终态出口：在飞计数让位 + 队列空后转空闲倒计时
      // （直接 delete+resolve 会漏这两步，链路激活态滞留、在飞计数失真）
      resolveTask(taskId, {
        ok: false,
        error: task.noRetry
          ? "表单提交超时（结果未知，可能已提交成功，请重新检查购买状态）"
          : `任务超时（${TASK_MAX_RETRIES} 次尝试均未收到结果）`,
      });
      return;
    }
    task.retries += 1;
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
  // 表单 POST（非幂等）例外：断线不重推直接判失败，防止重复扣金钱。
  // 重推不直接 send：挂起任务重置为未下发，链路按「新连接未激活」处理——先探测
  // （renderer 消费消息回 ack 才算活），通过后按节奏逐个弹出，防止恢复瞬间全量
  // 下发开大量 worker tab
  if (pendingTasks.size > 0) {
    for (const [taskId, task] of [...pendingTasks]) {
      if (task.noRetry) {
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
      task.sent = false;
    }
    activeTaskCount = 0;
    // 探测状态不随连接自动激活（协议层 pong 不可信）：重连/新 tab 连入后重新探测
    linkActive = false;
    resetProbeState(false);
    if (queuePopTimer) {
      clearTimeout(queuePopTimer);
      queuePopTimer = null;
    }
    if (idleDeactivateTimer) {
      clearTimeout(idleDeactivateTimer);
      idleDeactivateTimer = null;
    }
    enqueueOrProbe();
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

  // 探测应答（脚本 renderer 消费消息后回——协议层 pong 由浏览器网络层代答不可信，
  // 应用层 ack 才能证明脚本上下文存活）：激活链路，队列开始按节奏弹出。
  // probeId 不匹配的迟到应答（超时已判死）忽略
  if (parsed.type === "probe_ack") {
    if (linkActive) return;
    if (
      typeof parsed.probeId !== "string" ||
      parsed.probeId !== currentProbeId
    ) {
      console.warn(
        `[extensionWs] 收到不匹配的探测应答 probeId=${String(parsed.probeId)}（当前 ${currentProbeId ?? "无"}），忽略`,
      );
      return;
    }
    linkActive = true;
    resetProbeState(true);
    console.log("[extensionWs] 探测通过，链路激活，队列开始按节奏弹出");
    scheduleQueuePop();
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
      | {
          title?: unknown;
          text?: unknown;
          html?: unknown;
          href?: unknown;
          rateLimited?: unknown;
        }
      | undefined;
    if (parsed.ok === true && pageData && typeof pageData.html === "string") {
      const finalUrl =
        typeof pageData.href === "string" ? pageData.href : task.url;
      console.log(
        `[extensionWs] 任务完成 taskId=${taskId} html长度=${pageData.html.length} finalUrl=${finalUrl} rateLimited=${pageData.rateLimited === true} tabId=${clientTabId}`,
      );
      resolveTask(taskId, {
        ok: true,
        title: typeof pageData.title === "string" ? pageData.title : "",
        text: typeof pageData.text === "string" ? pageData.text : "",
        html: pageData.html,
        finalUrl,
        rateLimited: pageData.rateLimited === true,
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
          // 在飞计数随连接作废：挂起任务重连后由 acceptConnection 重置 sent
          // 重新入队补发
          activeTaskCount = 0;
          // 链路随连接作废：探测态/节拍/空闲倒计时一并复位，重连后重新探测
          linkActive = false;
          resetProbeState(false);
          if (queuePopTimer) {
            clearTimeout(queuePopTimer);
            queuePopTimer = null;
          }
          if (idleDeactivateTimer) {
            clearTimeout(idleDeactivateTimer);
            idleDeactivateTimer = null;
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
        sent: false,
        skipCache: opts?.skipCache === true,
      });
      // 入队即走放行入口：激活直接排节拍弹出，未激活先探测（排队中不计时，
      // 下发才启动 40s 超时）
      enqueueOrProbe();
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
  // 下载虽不入队，下发前同样要过链路探测：未激活先探测一波，通过才放行
  // （防 tab 冻结后协议层 pong 被代答、下载静默黑洞）
  if (!(await ensureLinkActive())) {
    return {
      ok: false,
      error: "脚本无响应（疑似标签页被浏览器睡眠），已断开等待恢复，请重试",
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
        sent: false,
        kind: "form_post",
        body,
        referer,
        noRetry: true,
      });
      // 入队即走放行入口（表单 POST 同样先探测/排节拍；排队中不计时，下发才
      // 启动 40s 超时）
      enqueueOrProbe();
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
  activeTaskCount = 0;
  // 探测状态机一并复位：清探测/节拍/空闲倒计时，激活态归零
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  if (queuePopTimer) {
    clearTimeout(queuePopTimer);
    queuePopTimer = null;
  }
  if (idleDeactivateTimer) {
    clearTimeout(idleDeactivateTimer);
    idleDeactivateTimer = null;
  }
  linkActive = false;
  resetProbeState(false);

  server.close(() => {
    console.log("[extensionWs] WS 服务已停止");
  });
}

export function isExtensionWsRunning(): boolean {
  return wss !== null;
}
