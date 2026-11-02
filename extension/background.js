let ws = null;
let pingTimerId = null;
let pongTimeoutId = null;
let retryDelay = 2000;
let failCount = 0;
const MAX_RETRY_DELAY = 30000;
/** 快速重试次数（间隔均 <30s，靠失败事件续命保 SW 存活）；超过后转 alarm 低频唤醒 */
const FAST_RETRY_COUNT = 4;
const RECONNECT_ALARM = "ws-reconnect";
const PING_INTERVAL = 20000;
const PONG_TIMEOUT = 10000;
const WS_URL = "ws://127.0.0.1:8899";
const PAGE_LOAD_TIMEOUT = 30000;

function clearAllTimers() {
  if (pingTimerId) clearInterval(pingTimerId);
  if (pongTimeoutId) clearTimeout(pongTimeoutId);
  pingTimerId = null;
  pongTimeoutId = null;
}

/**
 * SW 挂起兜底：快速重试期过后不再 setTimeout 空转，SW 挂起省资源，
 * 由 alarm 每 30s 唤醒重试一次——app 启动后最迟 30s 自动连上。
 */
function ensureReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

function clearReconnectAlarm() {
  chrome.alarms.clear(RECONNECT_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  console.log("[SW] alarm 唤醒，尝试重连");
  connect();
});

async function isTabValid(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function createWorkerTab(initUrl) {
  const tab = await chrome.tabs.create({
    url: initUrl,
    active: false
  });
  return tab.id;
}

function waitTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("page load timeout"));
    }, PAGE_LOAD_TIMEOUT);

    function listener(tid, info) {
      if (tid === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isCfShell(html) {
  if (!html) return false;
  return (
    html.includes("Just a moment") ||
    html.includes("challenge-platform") ||
    html.includes("_cf_chl_") ||
    html.includes("__jschl")
  );
}

/** 标准化 URL 比较（浏览器会自动补尾斜杠：https://a.com !== https://a.com/ 会导致复用直达永不命中） */
function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

async function grabPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      text: document.body ? document.body.innerText : "",
      html: document.documentElement.outerHTML,
      href: location.href
    })
  });
  return results[0].result;
}

function sendTaskResult(taskId, tabId, ok, extra) {
  // 扩展不暂存任务结果：WS 断连（非 OPEN）直接丢弃，由服务端超时重试兜底
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[SW] WS未连接，丢弃任务结果 taskId=${taskId}`);
    return;
  }
  ws.send(JSON.stringify({
    type: "task_result",
    taskId,
    tabId,
    ok,
    ...extra
  }));
}

async function handleTask(job) {
  const { url, taskId, tabId: serverTabId } = job;
  let targetTabId = null;

  try {
    let needWait = true;

    if (await isTabValid(serverTabId)) {
      targetTabId = serverTabId;
      const tab = await chrome.tabs.get(serverTabId);
      if (sameUrl(tab.url, url) && tab.status === "complete") {
        // 服务端超时重推同一任务时 tab 已加载同 URL：直接抓，不重新跳转
        console.log(`[SW] 复用已加载tab ${serverTabId}，直接抓取`);
        needWait = false;
      } else {
        console.log(`[SW] 复用tab ${serverTabId}，跳转 ${url}`);
        await chrome.tabs.update(serverTabId, { url });
      }
    } else {
      console.log(`[SW] tabId(${serverTabId ?? "null"})无效，新建worker tab`);
      targetTabId = await createWorkerTab(url);
    }

    if (needWait) await waitTabComplete(targetTabId);

    let pageData = await grabPage(targetTabId);
    for (let i = 0; i < 3 && isCfShell(pageData.html); i++) {
      console.log(`[SW] 检测到CF挑战壳页，等待挑战完成 (${i + 1}/3)`);
      await waitTabComplete(targetTabId);
      pageData = await grabPage(targetTabId);
    }
    if (isCfShell(pageData.html)) {
      throw new Error("CF 挑战未通过（多次检测到挑战壳页）");
    }

    console.log(`[SW] 任务完成 ${taskId} html长度=${pageData.html.length} href=${pageData.href}`);
    sendTaskResult(taskId, targetTabId, true, { pageData });
  } catch (err) {
    console.error("[SW] 任务失败", err.message);
    sendTaskResult(taskId, targetTabId, false, { error: err.message });
  }
}

function connect() {
  // 防重入：SW 被 alarm 唤醒冷启动时顶层会先 connect()，事件分发又调一次
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearAllTimers();
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[SW] WS connected", WS_URL);
    retryDelay = 2000;
    failCount = 0;
    clearReconnectAlarm();
    pingTimerId = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (pongTimeoutId) clearTimeout(pongTimeoutId);
      console.log("[SW] ping");
      ws.send(JSON.stringify({ type: "ping" }));
      pongTimeoutId = setTimeout(() => {
        console.log("[SW] pong超时，主动重连");
        ws.close();
      }, PONG_TIMEOUT);
    }, PING_INTERVAL);
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "pong") {
        if (pongTimeoutId) {
          clearTimeout(pongTimeoutId);
          pongTimeoutId = null;
        }
        return;
      }
      if (msg.type === "task") {
        console.log("[SW] 收到任务", msg);
        await handleTask(msg);
      }
    } catch (e) {
      console.error("[SW] 消息解析异常", e);
    }
  };

  ws.onclose = (evt) => {
    clearAllTimers();
    failCount += 1;
    ensureReconnectAlarm();
    if (failCount <= FAST_RETRY_COUNT) {
      console.log(`[SW] WS关闭，${retryDelay / 1000}ms后重试连接`);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    } else {
      // 快速重试期已过：不再 setTimeout 空转，挂起交给 alarm 每 30s 唤醒
      console.log("[SW] WS关闭，转入低频重连（alarm 每30s唤醒一次）");
    }
  };

  ws.onerror = () => {
    console.error("[SW] WS error");
    ws.close();
  };
}

connect();
