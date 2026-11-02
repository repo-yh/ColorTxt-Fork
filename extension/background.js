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

/**
 * 下载结果主动推送（download_result，非 task_result 应答）：
 * 服务端下发即返回不等待（避免大附件/慢站长时间占用 WS 等待），
 * fetch 成功或失败后扩展均主动推送（带帖子 URL），服务端落盘/记日志保证失败有感知；
 * WS 断连直接丢弃（扩展不暂存），由用户重新触发。
 */
function sendDownloadResult(taskId, tabId, ok, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[SW] WS未连接，丢弃下载结果 taskId=${taskId}`);
    return;
  }
  ws.send(JSON.stringify({
    type: "download_result",
    taskId,
    tabId,
    ok,
    ...extra
  }));
}

/**
 * 下载开始推送（download_start）：fetch 响应头到手、body 拉取前上报，
 * 携带文件元数据（meta.filename/contentType/size）与帖子 URL——服务器立刻
 * 感知哪本书的哪个附件开始下载（大附件下载期间不再是黑盒）；WS 非 OPEN 丢弃。
 */
function sendDownloadStart(taskId, tabId, ok, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[SW] WS未连接，丢弃下载开始推送 taskId=${taskId}`);
    return;
  }
  ws.send(JSON.stringify({
    type: "download_start",
    taskId,
    tabId,
    ok,
    ...extra
  }));
}

// ===== 下载任务(附件 blob 回传)=====

/**
 * 下载第一段：fetch 附件并读响应头（不读 body），Response 存页面全局供第二段取回。
 * 同源 tab 内 fetch 自动携带登录 Cookie / Referer / CF 会话;
 * 登录失效时 Discuz 返回 200+HTML 登录页,必须校验 content-type;
 * 返回文件元数据（filename/contentType/size）供服务器立即感知下载开始。
 * size 取 Content-Length（服务器未声明时为 0，仅提示；实际大小以第二段 body 为准）。
 */
async function fetchAttachmentMeta(url) {
  try {
    const r = await fetch(url, { credentials: "include" });
    window.__ctDlResp = r;
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    if (ct.includes("text/html")) {
      return { ok: false, error: "返回 HTML(登录态可能已失效)" };
    }
    let filename = "";
    const cd = r.headers.get("content-disposition") || "";
    const mStar = cd.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/);
    const mPlain = cd.match(/filename="?([^";]+)"?/);
    if (mStar) {
      try {
        filename = decodeURIComponent(mStar[1]);
      } catch {
        filename = mStar[1];
      }
    } else if (mPlain) {
      try {
        filename = decodeURIComponent(mPlain[1]);
      } catch {
        filename = mPlain[1];
      }
    } else {
      try {
        filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "attachment");
      } catch {
        filename = "attachment";
      }
    }
    return {
      ok: true,
      contentType: ct,
      filename,
      size: Number(r.headers.get("content-length")) || 0
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 下载第二段：取回第一段存的 Response 读 body 转 base64。
 * ArrayBuffer 经 executeScript 返回值序列化会变 {},必须分块转 base64(0x8000/块防 apply 爆栈)。
 */
async function fetchAttachmentBody() {
  const r = window.__ctDlResp;
  if (!r) return { ok: false, error: "下载会话丢失(tab 可能已被关闭或页面已跳转)" };
  try {
    const bytes = new Uint8Array(await r.arrayBuffer());
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { ok: true, data: btoa(binary), size: bytes.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 找一个与目标 URL 同源的 tab 执行 fetch(附件请求的 Cookie/Referer/CF 会话都依赖发起页面) */
async function ensureSameOriginTab(serverTabId, initUrl) {
  let origin = "";
  try {
    origin = new URL(initUrl).origin;
  } catch {
    // 非法 URL 交给下方直接报错
  }
  if (!origin) throw new Error(`非法 URL: ${initUrl}`);

  // 1. 服务端指定的 tab(上次抓页用的帖子页)同源则直接复用,不跳转不打断
  if (serverTabId && (await isTabValid(serverTabId))) {
    try {
      const tab = await chrome.tabs.get(serverTabId);
      if (tab.url && new URL(tab.url).origin === origin) {
        console.log(`[SW] 复用同源tab ${serverTabId} (${tab.url.slice(0, 80)})`);
        return serverTabId;
      }
    } catch {
      // url 取不到等异常,继续找
    }
  }

  // 2. 任意已打开的同源 tab
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id && t.url && new URL(t.url).origin === origin) {
      console.log(`[SW] 使用已打开同源tab ${t.id} (${t.url.slice(0, 80)})`);
      return t.id;
    }
  }

  // 3. 没有同源 tab:新建 tab 打开 initUrl(referer 页)等待加载完成
  console.log(`[SW] 无同源tab,新建tab打开 ${initUrl.slice(0, 80)}`);
  const tabId = await createWorkerTab(initUrl);
  await waitTabComplete(tabId);
  return tabId;
}

async function handleDownloadTask(job) {
  const { url, taskId, tabId: serverTabId, referer, postUrl, bookName } = job;
  let targetTabId = null;
  // meta 响应头到手后记住文件名：body 阶段失败也带 name 推送，服务器有归属感知
  let knownName = "";
  try {
    targetTabId = await ensureSameOriginTab(serverTabId, referer || url);

    // 第一段：fetch + 响应头校验，拿文件元数据
    const startResults = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      args: [url],
      func: fetchAttachmentMeta
    });
    const meta = startResults[0] && startResults[0].result;
    if (!meta || meta.ok !== true) {
      throw new Error((meta && meta.error) || "页面内 fetch 无返回");
    }
    knownName = meta.filename;

    // 下载开始即推元数据（body 拉取前）：带书籍 name 与文件元数据，
    // 服务器立刻感知哪本书的哪个附件开始下载并做归属保存
    console.log(`[SW] 下载开始 ${taskId} file=${meta.filename} size=${meta.size} type=${meta.contentType}`);
    sendDownloadStart(taskId, targetTabId, true, {
      url,
      postUrl: postUrl || "",
      bookName: bookName || "",
      meta: {
        contentType: meta.contentType,
        filename: meta.filename,
        size: meta.size
      }
    });

    // 第二段：读 body 转 base64
    const bodyResults = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: fetchAttachmentBody
    });
    const body = bodyResults[0] && bodyResults[0].result;
    if (!body || body.ok !== true) {
      throw new Error((body && body.error) || "下载 body 读取无返回");
    }
    console.log(`[SW] 下载完成 ${taskId} size=${body.size} file=${meta.filename}`);
    sendDownloadResult(taskId, targetTabId, true, {
      url,
      postUrl: postUrl || "",
      bookName: bookName || "",
      name: meta.filename,
      blob: {
        data: body.data,
        contentType: meta.contentType,
        filename: meta.filename,
        size: body.size
      }
    });
  } catch (err) {
    console.error("[SW] 下载失败", err.message);
    sendDownloadResult(taskId, targetTabId, false, {
      url,
      postUrl: postUrl || "",
      bookName: bookName || "",
      name: knownName,
      error: err.message
    });
  }
}

async function handleTask(job) {
  const { url, taskId, tabId: serverTabId } = job;
  if (job.kind === "download") {
    await handleDownloadTask(job);
    return;
  }
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
      console.log(`[SW] WS关闭，${retryDelay}ms后重试连接`);
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
