import { WebSocketServer, WebSocket } from "ws";

const PORT = 8899;
const HOST = "127.0.0.1";
/**
 * 单次下发超时（readme：比如 40s，大于扩展侧页面 30s 加载超时）。
 * 超时未收到 task_result → 服务端重新下发同一条 task（带上缓存的 tabId）。
 */
const TASK_TIMEOUT_MS = 40_000;
/** 超时重推上限，超过后向调用方报失败（readme 未定上限，防调用方永久等待） */
const TASK_MAX_RETRIES = 3;

/**
 * pageData 为扩展抓取结果（readme 协议）：title/text/html/href；
 * 服务端对外展开平铺，finalUrl 对应扩展的 location.href（302/跳转后的最终 URL）。
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
  /** 上次尝试使用的标签页；重试时带上，扩展校验失效自动新建并回报新 tabId */
  tabId: number | null;
  retries: number;
};

let wss: WebSocketServer | null = null;
/** 当前已连接的插件（单连接策略：本机单人使用） */
let client: WebSocket | null = null;
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

/** 下发任务并启动本次尝试的 40s 超时计时；超时按 readme 服务端规则重推或判失败 */
function dispatchTask(taskId: string): void {
  const task = pendingTasks.get(taskId);
  if (!task) return;
  if (!client || client.readyState !== WebSocket.OPEN) return;

  client.send(
    JSON.stringify({ type: "task", taskId, url: task.url, tabId: task.tabId }),
  );
  console.log(
    `[extensionWs] 任务下发（第 ${task.retries + 1} 次） taskId=${taskId} url=${task.url} tabId=${task.tabId ?? "无"}`,
  );

  clearTimeout(task.timer);
  task.timer = setTimeout(() => {
    if (task.retries + 1 >= TASK_MAX_RETRIES) {
      pendingTasks.delete(taskId);
      console.warn(
        `[extensionWs] 任务超时（已重推 ${task.retries} 次，放弃） taskId=${taskId} url=${task.url}`,
      );
      task.resolve({
        ok: false,
        error: `任务超时（${TASK_MAX_RETRIES} 次尝试均未收到结果）`,
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

/** 处理已连接插件的消息（心跳 pong / 任务结果） */
function handleClientMessage(
  ws: WebSocket,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }

  if (parsed.type === "task_result") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";
    // 用扩展回报的 tabId 更新映射（成功/失败都带；tab 失效被新建时为新建后的 tabId）
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

/** 启动 WS 服务（Promise 化，真实反映端口占用结果，供开关失败回滚） */
export function startExtensionWsServer(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (wss) return Promise.resolve({ ok: true });

  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: HOST, port: PORT });
    let settled = false;

    server.once("listening", () => {
      settled = true;
      wss = server;
      console.log(`[extensionWs] WS 服务已启动: ws://${HOST}:${PORT}`);
      resolve({ ok: true });
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        const reason =
          err.code === "EADDRINUSE"
            ? `端口 ${PORT} 被占用`
            : String(err.message ?? err);
        resolve({ ok: false, reason });
      }
      server.close();
      if (wss === server) wss = null;
    });

    server.on("connection", (ws, req) => {
      console.log(`[extensionWs] 收到连接 ${req.socket.remoteAddress}`);

      if (client && client.readyState === WebSocket.OPEN) {
        console.log("[extensionWs] 已有活跃插件连接，拒绝新连接");
        ws.close(4001, "已有活跃连接");
        return;
      }
      client = ws;
      console.log("[extensionWs] 插件已连接");

      // WS 断开期间的 pending 任务视为待重试，插件重连后重新下发（readme 服务端规则 4）
      if (pendingTasks.size > 0) {
        console.log(
          `[extensionWs] 重连后重推 ${pendingTasks.size} 条未完成任务`,
        );
        for (const taskId of [...pendingTasks.keys()]) {
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
          // 停掉本次尝试的计时器；任务保留在 pendingTasks，插件重连后重推
          for (const task of pendingTasks.values()) {
            clearTimeout(task.timer);
          }
          console.log(
            `[extensionWs] 插件连接断开 code=${code}，pending 任务待重连后重推`,
          );
        }
      });

      ws.on("error", (err) => {
        console.warn(`[extensionWs] 连接错误: ${err.message}`);
      });
    });
  });
}

/** 指挥扩展打开页面并抓取 pageData（v1 引擎接入点雏形；内部 console.log 验证） */
export function openAndGetHtml(url: string): Promise<OpenAndGetHtmlResult> {
  if (!client || client.readyState !== WebSocket.OPEN) {
    return Promise.resolve({
      ok: false,
      error: "插件未连接（请确认浏览器扩展已加载、服务开关已打开）",
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

export function stopExtensionWsServer(): void {
  if (!wss) return;
  const server = wss;
  wss = null;

  for (const task of pendingTasks.values()) {
    clearTimeout(task.timer);
    task.resolve({ ok: false, error: "服务已停止" });
  }
  pendingTasks.clear();

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
