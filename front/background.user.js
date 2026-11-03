// ==UserScript==
// @name         ColorTxt 找书通道（油猴版 WS 客户端）
// @namespace    colortxt-find-book
// @version      1.3.5
// @description  连接 ColorTxt 桌面端 WS 服务（ws://127.0.0.1:8888/ws，与 Web 展示服务共用 8888 端口）：主 tab 持锁收任务，抓页任务开后台 tab 真实加载（导航执行 _dsign 挑战 JS 过墙）经 worker 池取页；表单 POST（附件购买）/ 附件下载同源 fetch。单连接锁 + 心跳 + 断线指数退避，行为清单见脚本内注释
// @updateURL    http://127.0.0.1:8888/background.user.js
// @downloadURL  http://127.0.0.1:8888/background.user.js
// @match        https://sxsy33.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_getTab
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
    'use strict';

    // ColorTxt 主进程 WS 服务（extensionWs.ts）：与 Web 展示服务共用 8888 端口（/ws 路径）；
    // 绑 127.0.0.1，不用 localhost（可能解析到 ::1 连不上）
    const WS_SERVER = "ws://127.0.0.1:8888/ws";
    // 按书源站点修改 @match；抓取任务 URL 必与页面同源（服务端只对 enabledWebSocket 书源走本通道）
    const LOCK_KEY = "ws_single_conn_lock";
    const LOCK_TTL = 12000;
    const RENEW_INTERVAL = LOCK_TTL / 2;
    // worker 池：拿不到 WS 锁的 tab 转为 worker，把 {url, body} 登记在此（同 URL 去重保最新），
    // 主 tab 收到抓页任务后开后台 tab 真实加载，监听本键按 URL 取内容回传
    const POOL_KEY = "ws_worker_pool";
    // 池子上限：GM 存储是永久的（浏览器重启都在），无上限会一直膨胀占磁盘——
    // 只留最近 20 条，满后新登记挤掉最旧一条（队列尾=最新）
    const POOL_MAX = 20;
    // worker tab 自关凭证 + 任务关联键：主 tab GM_openInTab 时在 URL hash 带一次性
    // token（_colortxt_spawn=<随机>）；壳页/CF 页阶段脚本把 token 搬进 sessionStorage
    // （挑战跳转与 HTTP 302 都会丢 hash，sessionStorage 同 tab 全程保留）——真页登记
    // 池子时带 token，主 tab 按 token 匹配任务，URL 匹配仅作无 token 记录（手动 tab）
    // 的兜底——解决 Discuz 搜索 302 到 searchid 后 location.href 与任务 URL 不一致
    // 导致匹配失败超时的问题；token 在手也是脚本 tab 的自关凭证
    const SPAWN_HASH_MARK = "_colortxt_spawn=";
    const SPAWN_TOKEN_KEY = "ws_spawn_token";

    // 自更新：脚本下发与检查更新的统一来源（Web 展示服务 /background.user.js 端点）。
    // 主 tab 每次加载比对远程 @version，有新版当前 tab 跳该链接触发 Tampermonkey 安装页
    const UPDATE_SCRIPT_URL = "http://127.0.0.1:8888/background.user.js";

    // 退避配置
    const BASE_DELAY = 1000;
    const MAX_DELAY = 16000;   // 最长退避 16s
    const BACKOFF_RATE = 1.6;

    // 心跳配置（应用层：脚本发 ping，服务端回 pong）。
    // 放宽原因：主 tab 长期后台运行时 Chrome 节流后台 tab 定时器（1s 粒度；后台超 5 分钟
    // 对齐到 1 分钟），旧 3s ping/8s 超时会被节流穿透导致误判断连重连。loopback 本地
    // 连接无需激进半开检测：服务端进程退出 OS 立即发 FIN 触发 onclose 走重连。
    const HEARTBEAT_INTERVAL = 30000;   // 每30s发心跳包
    const HEARTBEAT_TIMEOUT = 120000;   // 120s没收到心跳应答 → 判定心跳失败，主动断开

    // 任务超时（对齐油猴通道：页面 30s；下载总 120s）
    const PAGE_TIMEOUT_MS = 30000;
    const DOWNLOAD_TIMEOUT_MS = 120000;

    let ws = null;
    let renewTimer = null;
    let retryTimer = null;
    let heartbeatSendTimer = null;
    let heartbeatTimeoutTimer = null;
    let holdLock = false;
    let backoffDelay = BASE_DELAY;
    // Tampermonkey 本 tab 标识（GM_getTab 异步到手；回报统一带上供服务端维护映射）
    let myTabId = null;

    const now = Date.now();
    // 锁归属标识：sessionStorage 同 tab 刷新（含后台回收重载）后保留、跨 tab 隔离。
    // 锁里记录持有者标识，主 tab 刷新后新文档凭它认领自己的旧锁直接重连——卸载阶段的
    // GM 写删除经实测不可靠（beforeunload/pagehide/unload 全挂载仍失败，锁残留导致
    // 新文档误判 worker 且自关主 tab），故释放不能依赖卸载钩子，锁认领才是权威路径
    let holderId = sessionStorage.getItem("ws_lock_holder");
    if (!holderId) {
        holderId = Math.random().toString(36).slice(2);
        sessionStorage.setItem("ws_lock_holder", holderId);
    }
    const lock = GM_getValue(LOCK_KEY, null);
    const lockIsMine = !!(lock && lock.holderId === holderId);
    if (lock && lock.active && !lockIsMine && (now - lock.ts < LOCK_TTL)) {
        // 已有其他 tab 持锁：本 tab 转为 worker，把页面内容登记进池子供主 tab 匹配取用
        workerRegister();
        return;
    }

    console.log("[Tab] 锁空闲/过期/归属本tab，尝试WS初始连接（仅启动时一次）");
    // 拿 Tampermonkey 本 tab 标识（数字，同一 tab 刷新前后稳定）：回报消息统一带
    // tabId，服务端按 typeof number 更新 connId→tabId 映射——新连接顶替旧连接策略下，
    // tab 刷新重连后服务端重推任务仍对得上本 tab（防止刷新重连后任务丢失）
    GM_getTab((tabData) => {
        myTabId = tabData.tabId;
    });
    // 先占锁再连接：握手窗口内其他新 Tab 见锁直接终止，避免无谓竞争；
    // 初始连接失败由 onerror(!holdLock) 释放锁，Tab 刷新后脚本重新执行再试
    GM_setValue(LOCK_KEY, { active: true, ts: Date.now(), holderId });
    // 主 tab 浏览的页面同样登记进池子当缓存：用户点链接跳转重当主后，当前页面（帖子
    // 详情等）供应用之后的任务命中（token 为空永不自关，纯缓存语义）
    registerPageToPool();
    // 主 tab 唯一的池子监听器：worker 登记 → 按 token/url 匹配任务表 → 按 taskId 回传
    watchPool();
    tryConnect();
    checkSelfUpdate();

    // BFCache 恢复（自更新跳 TM 安装页后用户后退返回等场景）：页面冻结期间浏览器
    // 关闭了 WS、断开了 GM 值监听 port（watchPool 的值变更监听随之失效），而脚本顶层
    // 不会因 bfcache 恢复重新执行——必须在 pageshow(persisted) 手动重建连接与监听。
    // tryConnect 防重入，与解冻后迟到的 onclose 重连兜底不冲突；锁凭 holderId 认领，
    // 定时器（续约/心跳）解冻后自然恢复。仅主 tab 注册（worker 页面无监听可重建）
    window.addEventListener("pageshow", (ev) => {
        if (!ev.persisted) return;
        console.log("[Tab] 页面从BFCache恢复，重建 WS 连接与池子监听");
        watchPool();
        tryConnect();
    });

    /** 自更新检查：GM_xmlhttpRequest（油猴特权请求，不受 https 页面访问 loopback
     * http 的混合内容/PNA 限制）拉下发脚本比对 @version，发现新版本当前 tab 打开
     * .user.js 链接触发 Tampermonkey 安装页（更新后回论坛页脚本重载自动重当主）。
     * 仅主 tab 路径执行——worker/手动 tab 跳转会打断任务；抓页任务进行中推迟 10s
     * 重试，空闲才跳。Web 服务未开/请求失败静默忽略，不影响找书主链路 */
    function checkSelfUpdate() {
        GM_xmlhttpRequest({
            method: "GET",
            url: UPDATE_SCRIPT_URL,
            timeout: 5000,
            onload: (resp) => {
                const m = String(resp.responseText || "").match(/\/\/\s*@version\s+(\S+)/);
                const remote = m && m[1];
                if (!remote || remote === GM_info.script.version) return;
                if (pendingFetchTasks.size > 0) {
                    setTimeout(checkSelfUpdate, 10000);
                    return;
                }
                console.log(`[Update] 发现新版本 ${GM_info.script.version} → ${remote}，关闭 WS 后打开更新链接`);
                // 跳转前主动关 WS：服务端立即感知断开（不等心跳超时判死）；100ms 延迟
                // 给 close 帧留出网络 flush 时间。pagehide 释放锁链路照常生效
                try { if (ws) ws.close(1000, "self update"); } catch (e) { /* 已关则忽略 */ }
                setTimeout(() => { location.href = UPDATE_SCRIPT_URL; }, 100);
            },
            onerror: () => {},
            ontimeout: () => {},
        });
    }

    function resetHeartbeatTimer() {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = setTimeout(() => {
            console.log("[Tab] ❌ 心跳超时，主动关闭连接，进入重试");
            if (ws) ws.close(4000, "heartbeat timeout");
        }, HEARTBEAT_TIMEOUT);
    }

    function stopAllHeartbeat() {
        clearInterval(heartbeatSendTimer);
        clearTimeout(heartbeatTimeoutTimer);
    }

    /** 发送 JSON（无任务表不暂存：断线/未连接直接丢弃，服务端超时重推兜底） */
    function sendJson(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn(`[Tab] WS未连接，丢弃${obj.type || "消息"} taskId=${obj.taskId || ""}`);
            return;
        }
        try {
            // 回报统一带本 tab 标识（tabId 未到手时省略，服务端 typeof number 校验兼容缺失）
            if (obj.tabId === undefined && myTabId !== null) {
                obj.tabId = myTabId;
            }
            ws.send(JSON.stringify(obj));
        } catch (e) { /* 忽略发送失败 */ }
    }

    function tryConnect() {
        // 防重入：连接中/已连接不重复建连（对齐油猴通道 connect）
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
        stopAllHeartbeat();
        ws = new WebSocket(WS_SERVER);

        ws.onopen = () => {
            holdLock = true;
            backoffDelay = BASE_DELAY; // 连上成功，重置退避
            GM_setValue(LOCK_KEY, { active: true, ts: Date.now(), holderId });
            console.log("[Tab] ✅ WS已连接，启动续约+心跳");

            if (renewTimer) clearInterval(renewTimer);
            // 持锁后续约无条件执行（不依赖 ws 状态）：断线退避重试期间也持续续约，
            // 保证别的 Tab 不会在重试期间抢进来（续约行为清单第 4/5 条）。
            // 续约必须带 holderId：锁认领（本 tab 刷新/跳转后 lockIsMine 判定）依赖
            // 该字段，漏写会把字段抹掉导致跳转后新文档永远认领失败变 worker
            renewTimer = setInterval(() => {
                GM_setValue(LOCK_KEY, { active: true, ts: Date.now(), holderId });
            }, RENEW_INTERVAL);

            // 心跳发送定时器
            heartbeatSendTimer = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                    resetHeartbeatTimer();
                }
            }, HEARTBEAT_INTERVAL);
        };

        ws.onmessage = async (evt) => {
            let payload;
            try {
                payload = JSON.parse(evt.data);
            } catch (e) {
                console.error("[Tab] 消息解析失败", evt.data);
                return;
            }

            // 服务端返回pong，重置心跳超时计时器
            if (payload.type === "pong") {
                resetHeartbeatTimer();
                return;
            }

            // 业务任务（服务端协议：kind 缺省=抓页 / form_post=表单POST / download=附件下载）
            if (payload.type === "task") {
                void handleTask(payload);
            }
        };

        ws.onclose = () => {
            console.log(`[Tab] WS断开，准备退避重试，下次延迟：${backoffDelay}ms`);
            stopAllHeartbeat();
            // 续约定时器不清：重试期间依然持有锁、持续续约（断线重试规则），
            // 仅 beforeunload 主动释放时才清
            ws = null;

            // 曾经成功建立连接，持有锁：执行退避重试
            if (holdLock) {
                retryTimer = setTimeout(() => {
                    tryConnect();
                }, backoffDelay);
                backoffDelay = Math.min(backoffDelay * BACKOFF_RATE, MAX_DELAY);
            }
        };

        ws.onerror = () => {
            console.error("[Tab] WS连接错误");
            stopAllHeartbeat();
            // renewTimer 不清：重试期间依然持有锁、持续续约（断线重试规则）；
            // 初始失败场景 renewTimer 尚未启动，onopen 时会先清旧再建新
            if (ws) ws.close();
            ws = null;
            // 启动初次连接失败，不重试、释放锁；只有onopen成功过才重试
            if (!holdLock) {
                GM_deleteValue(LOCK_KEY);
            }
        };
    }

    // ---------- worker 池 ----------

    function getPool() {
        try {
            return JSON.parse(GM_getValue(POOL_KEY, "[]"));
        } catch (e) {
            return [];
        }
    }

    function savePool(list) {
        GM_setValue(POOL_KEY, JSON.stringify(list));
    }

    /** 匹配口径：剥 _dsign 签名参数与 hash——挑战壳页 JS 跳转后的真页 URL 带 _dsign，需与任务裸 URL 对齐 */
    function normalizeTaskUrl(u) {
        try {
            const url = new URL(u);
            url.searchParams.delete("_dsign");
            url.hash = "";
            return url.href;
        } catch (e) {
            return u;
        }
    }

    /** 帖子页（viewthread）存储裁剪：只保留标题 h1.ts + 楼主层（#postlist 首个
     * div#post_N，内含 table#pid_N 楼层本体）——应用需要的正文/attachpay 购买
     * 表单/已购直链都在首楼，回复楼层是灌水无需缓存（实测整页 ~98KB → 楼主层
     * ~11KB，省约 90%）。非帖子页或结构不认识（模板变化）时回退整页，登记永不失败 */
    function pickStorableBody() {
        const full = document.body.innerHTML;
        if (!/mod=viewthread/i.test(location.href)) return full;
        const postlist = document.querySelector("#postlist");
        if (!postlist) return full;
        // :scope > 限定直接子元素——回复框容器 postlistreply 里的 post_reply 等
        // 同前缀 id 不误匹配；#postlist 下首个 div#post_N 即楼主层（文档序）
        const floor = postlist.querySelector(":scope > div[id^='post_']");
        if (!floor) return full;
        // 标题 h1.ts 在 #postlist 之外，书源解析书名/快照显示需要，一并保留
        const h1 = document.querySelector("h1.ts");
        return (h1 ? h1.outerHTML : "") + floor.outerHTML;
    }

    /** 页面登记进池子当缓存（帖子详情内容不变，应用之后打开同帖直接命中秒回）。
     * 无 <title> 的页面是挑战壳页/中间跳转页，CF 拦截页（title=Just a moment）是
     * 挑战中——都跳过不登记，等跳到真页后由新文档重新执行脚本登记（否则主 tab 会
     * 把中间页当结果取走）。返回本页 token（无则空串） */
    function registerPageToPool() {
        // token 搬运放最前：挑战壳页（无 title）与 CF 页也要搬——hash 随挑战跳转/
        // HTTP 302 丢失，sessionStorage 同 tab 客户端与服务器跳转全程保留，真页凭它认领任务
        const m = location.hash.match(/_colortxt_spawn=([a-z0-9]+)/i);
        if (m) sessionStorage.setItem(SPAWN_TOKEN_KEY, m[1]);
        if (!document.title) return "";
        if (document.title.includes("Just a moment")) return "";
        const token = (m && m[1]) || sessionStorage.getItem(SPAWN_TOKEN_KEY) || "";
        const item = { url: location.href, body: pickStorableBody(), token };
        // 去重：同一个url只保留最新一条（新快照自动替换旧缓存）
        const filtered = getPool().filter(
            (x) => normalizeTaskUrl(x.url) !== normalizeTaskUrl(item.url),
        );
        filtered.push(item);
        // 永久存储防膨胀：只留最近 POOL_MAX 条，满后从队头挤掉最旧一条
        while (filtered.length > POOL_MAX) filtered.shift();
        savePool(filtered);
        return token;
    }

    /** worker tab：登记页面后，仅脚本开出的 tab（token 在手）自关；用户手动打开的
     * 页面无 token 永不误杀。挑战壳页跳转会丢 hash 但 sessionStorage 已接力 */
    function workerRegister() {
        const token = registerPageToPool();
        if (!token) {
            console.log("[Worker] 已登记页面进池子（非脚本tab，不自关）", location.href);
            return;
        }
        console.log("[Worker] 已登记页面进池子，即将自关", location.href);
        // 延迟自关：给 GM 值变更广播留传播时间（确保主 tab 先收到登记）
        setTimeout(() => window.close(), 500);
    }

    /** 主 tab 抓页任务表：taskId → {url, token, resolve, timer}——记住任务 id 与下发
     * 打开 url 及其 spawn token 的关系，worker 登记池子后按 token 匹配取回结果 */
    const pendingFetchTasks = new Map();

    /** 主 tab 唯一的池子监听器：池子变化时遍历任务表匹配，命中即按 taskId 取回结果。
     * 匹配口径：记录带 token（脚本 tab）时按 token 精确匹配（任务 URL 与 worker 最终
     * URL 可能因搜索 302 searchid/挑战跳转不一致）；记录无 token（手动 tab）时退回
     * normalize URL 匹配兜底 */
    function watchPool() {
        GM_addValueChangeListener(POOL_KEY, (k, oldV, raw, remote) => {
            if (!remote) return;
            let arr;
            try {
                arr = JSON.parse(raw);
            } catch (e) {
                return;
            }
            for (const [taskId, task] of [...pendingFetchTasks]) {
                const want = normalizeTaskUrl(task.url);
                const found = arr.find(
                    (x) =>
                        (x.token && x.token === task.token) ||
                        (!x.token && normalizeTaskUrl(x.url) === want),
                );
                if (found) {
                    pendingFetchTasks.delete(taskId);
                    clearTimeout(task.timer);
                    task.resolve(found.body);
                }
            }
        });
    }

    // ---------- 任务分发 ----------

    async function handleTask(payload) {
        const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
        if (!taskId) return;
        console.log("[Tab] 收到任务", payload);
        try {
            if (payload.kind === "download") {
                await runDownloadTask(payload, taskId);
            } else if (payload.kind === "form_post") {
                await runFormPostTask(payload, taskId);
            } else {
                await runFetchPageTask(payload, taskId);
            }
        } catch (err) {
            console.error("[Tab] 任务失败", String((err && err.message) || err));
            sendJson({
                type: "task_result",
                taskId,
                ok: false,
                error: String((err && err.message) || err),
            });
        }
    }

    /**
     * 抓页任务（openAndGetHtml）：开后台 tab 真实加载目标页——导航会执行站点的
     * _dsign 挑战 JS 自动过墙（fetch 不执行 JS 拿不到真页）。任务表 pendingFetchTasks
     * 记住 taskId 与下发打开 url 的关系，worker tab 加载后登记池子，watchPool 按
     * url 匹配取回 body，再按 taskId 回传服务器。
     */
    async function runFetchPageTask(payload, taskId) {
        const url = new URL(payload.url, location.origin).href;
        const want = normalizeTaskUrl(url);
        // 缓存命中直接回传（不开 worker tab，重复打开帖子秒回，省挑战 13~66s）。
        // 帖子详情内容不变，无限缓存；search.php 排除是防御——搜索 302 searchid 后
        // 池子里存的是 searchid URL，任务的 srchtxt URL 本就永不命中缓存，但万一某
        // 次搜索未 302 直出，同书检查更新的固定搜索 URL 会命中旧快照致更新检测失效
        if (!/\/search\.php\?/i.test(url)) {
            const cached = getPool().find(
                (x) => x.body && normalizeTaskUrl(x.url) === want,
            );
            if (cached) {
                console.log(`[Tab] 缓存命中 ${taskId} html长度=${cached.body.length} url=${url}`);
                sendJson({
                    type: "task_result",
                    taskId,
                    ok: true,
                    pageData: {
                        title: extractTitle(cached.body),
                        text: extractText(cached.body),
                        html: cached.body,
                        href: url,
                    },
                });
                return;
            }
        }
        // 主 tab 持 GM_openInTab 句柄，任务终态（成功/超时/异常）finally 统一主动关
        // worker tab——开 tab 的人负责关 tab，用户手动打开的页面永不触碰；worker 侧
        // hash 自关仅作 close() 不可用（TM 版本差异）时的兜底
        let workerTab = null;
        let html;
        try {
            html = await new Promise((resolve, reject) => {
                // 一次性 spawn token：任务关联键（搜索 302 searchid 后 URL 不匹配，靠
                // token 精确认领）+ worker 自关凭证；hash 随挑战跳转/302 丢失时由
                // workerRegister 搬进 sessionStorage 接力
                const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
                const timer = setTimeout(() => {
                    pendingFetchTasks.delete(taskId);
                    reject(new Error("后台页未登记内容（worker 加载超时或被重定向）"));
                }, PAGE_TIMEOUT_MS);
                // 登记任务表（taskId ↔ 下发打开 url + token），worker 登记后由 watchPool
                // 匹配取回；服务端超时重推同 taskId 时先清旧 timer，防旧计时器到点误删新记录
                const prev = pendingFetchTasks.get(taskId);
                if (prev) clearTimeout(prev.timer);
                pendingFetchTasks.set(taskId, { url, token, resolve, timer });
                // 后台打开不抢焦点（active+loadInBackground 双保险，防 TM 版本差异）；
                // setParent 让 worker 关闭后焦点回落本 tab。hash 带一次性 token：
                // 不进服务器请求，用户手动开的同 URL 页面无 token 永不误杀
                const spawnUrl = new URL(url);
                spawnUrl.hash = "";
                spawnUrl.hash = SPAWN_HASH_MARK + token;
                workerTab = GM_openInTab(spawnUrl.href, {
                    active: false,
                    loadInBackground: true,
                    setParent: true,
                });
            });
        } finally {
            if (workerTab && typeof workerTab.close === "function") {
                try {
                    workerTab.close();
                } catch (e) { /* 关闭失败交给 worker hash 自关兜底 */ }
            }
        }
        console.log(`[Tab] 任务完成 ${taskId} html长度=${html.length} href=${url}`);
        sendJson({
            type: "task_result",
            taskId,
            ok: true,
            pageData: {
                title: extractTitle(html),
                text: extractText(html),
                html,
                href: url,
            },
        });
    }

    /**
     * 表单 POST 任务（如 Discuz 附件购买 attachpay）：同源 fetch POST 自动带登录 Cookie/CF 会话，
     * HTTP 2xx 即成功（pageData.html 为响应文本）。非幂等（重复提交可能重复扣金钱）：
     * 服务端对该类任务超时/断线不重推，本脚本也无需去重。
     */
    async function runFormPostTask(payload, taskId) {
        const url = new URL(payload.url, location.origin).href;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
        let resp;
        let text;
        try {
            resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: typeof payload.body === "string" ? payload.body : "",
                credentials: "same-origin",
                redirect: "follow",
                signal: ctrl.signal,
            });
            text = (await resp.text()).slice(0, 20000);
        } finally {
            clearTimeout(timer);
        }
        if (!resp.ok) {
            sendJson({
                type: "task_result",
                taskId,
                ok: false,
                error: `HTTP ${resp.status}（表单提交失败，结果未知，请重新检查购买状态）`,
            });
            return;
        }
        console.log(`[Tab] form_post 完成 ${taskId} status=${resp.status} 长度=${text.length}`);
        sendJson({
            type: "task_result",
            taskId,
            ok: true,
            pageData: {
                title: "",
                text,
                html: text,
                href: url,
            },
        });
    }

    /**
     * 下载任务（fire-and-forget）：fetch 附件 → 响应头到手先推 download_start（文件元数据，
     * 服务端按 taskId 保存归属），body 拉完转 base64 推 download_result，服务端落盘。
     * 未购/登录失效时服务端返回 HTML 提示页而非附件 → 不推 start，直接报失败（对齐油猴通道）。
     */
    async function runDownloadTask(payload, taskId) {
        const url = new URL(payload.url, location.origin).href;
        const postUrl = typeof payload.postUrl === "string" ? payload.postUrl : "";
        const bookName = typeof payload.bookName === "string" ? payload.bookName : "";
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
        // meta 响应头到手后记住文件名：body 阶段失败也带 name 推送，服务端有归属感知（对齐油猴通道）
        let knownName = "";
        try {
            const resp = await fetch(url, {
                credentials: "same-origin",
                redirect: "follow",
                signal: ctrl.signal,
            });
            const contentType = resp.headers.get("content-type") || "";
            if (!resp.ok || /text\/html/i.test(contentType)) {
                const pageTitle = extractTitle(await resp.text().catch(() => ""));
                sendJson({
                    type: "download_result",
                    taskId,
                    url,
                    postUrl,
                    bookName,
                    name: knownName,
                    ok: false,
                    error: resp.ok
                        ? `未触发下载（服务端返回普通页面「${pageTitle.slice(0, 40)}」，附件未购或登录态可能已失效）`
                        : `HTTP ${resp.status}`,
                });
                return;
            }
            const fallbackName = (() => {
                try {
                    return decodeURIComponent(
                        new URL(url).pathname.split("/").pop() || "attachment",
                    );
                } catch (e) {
                    return "attachment";
                }
            })();
            const filename = parseContentDisposition(
                resp.headers.get("content-disposition"),
                fallbackName,
            );
            knownName = filename;
            const size = Number(resp.headers.get("content-length")) || 0;
            console.log(`[Tab] 下载开始 ${taskId} file=${filename} size=${size} type=${contentType}`);
            sendJson({
                type: "download_start",
                taskId,
                url,
                postUrl,
                bookName,
                meta: { filename, contentType, size },
            });
            const buf = await resp.arrayBuffer();
            console.log(`[Tab] 下载完成 ${taskId} size=${buf.byteLength} file=${filename}`);
            sendJson({
                type: "download_result",
                taskId,
                url,
                postUrl,
                bookName,
                name: filename,
                ok: true,
                blob: {
                    data: arrayBufferToBase64(buf),
                    contentType,
                    filename,
                    size: buf.byteLength,
                },
            });
        } catch (err) {
            console.error("[Tab] 下载失败", String((err && err.message) || err));
            sendJson({
                type: "download_result",
                taskId,
                url,
                postUrl,
                bookName,
                name: knownName,
                ok: false,
                error: String((err && err.message) || err),
            });
        } finally {
            clearTimeout(timer);
        }
    }

    // ---------- 工具 ----------

    /** 从 HTML 提取 <title>（含实体解码；静态 HTML 无法取 document.title） */
    function extractTitle(html) {
        const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (!m) return "";
        const el = document.createElement("textarea");
        el.innerHTML = m[1].trim();
        return el.value;
    }

    /** 从静态 HTML 粗提正文文本（块级标签补换行近似 innerText；仅作展示/检测用，解析走 html） */
    function extractText(html) {
        try {
            const doc = new DOMParser().parseFromString(html, "text/html");
            doc.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
            doc.querySelectorAll("p,div,br,li,tr,h1,h2,h3,h4,h5,h6,section,article").forEach((n) => {
                n.insertAdjacentText("afterend", "\n");
            });
            return (doc.body ? doc.body.textContent : "").replace(/[ \t]+/g, " ").trim();
        } catch (e) {
            return "";
        }
    }

    /** Content-Disposition 文件名解析（RFC 5987 filename* 优先，回退 filename，再回退 URL 末段；解码失败回退原串，对齐油猴通道） */
    function parseContentDisposition(header, fallbackName) {
        if (header) {
            const utf8 = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
            if (utf8) {
                const raw = utf8[1].replace(/["']/g, "").trim();
                try {
                    return decodeURIComponent(raw) || fallbackName;
                } catch (e) {
                    return raw || fallbackName;
                }
            }
            const plain = header.match(/filename\s*=\s*"?([^";]+)"?/);
            if (plain) {
                try {
                    return decodeURIComponent(plain[1].trim()) || plain[1].trim();
                } catch (e) {
                    return plain[1].trim();
                }
            }
        }
        return fallbackName;
    }

    /** ArrayBuffer → base64（分块转换防 call 栈溢出；附件 txt 级大小足够） */
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    // 卸载清理只挂 pagehide（官方推荐的 unload/beforeunload 替代事件）：刷新/关闭/
    // 站内导航都会触发；unload 被 Chrome Permissions Policy 默认禁止（报 violation
    // 且不执行），beforeunload 属废弃趋势不挂。e.persisted=true → 页面进 bfcache
    // 只是休眠未注销，跳过清理（退回时继续工作）；只有真销毁才清理。GM 写在卸载
    // 阶段可能静默失败，锁释放权威路径 = sessionStorage 锁认领 + LOCK_TTL 过期
    window.addEventListener("pagehide", (e) => {
        if (e.persisted) return;
        clearInterval(renewTimer);
        clearTimeout(retryTimer);
        stopAllHeartbeat();
        if (holdLock) {
            GM_deleteValue(LOCK_KEY);
        }
        if (ws) {
            ws.close(1000, "tab unload");
        }
    });

    // 同源链接点击即释放锁：click 在导航前触发（页面活跃，GM 写可靠），比 pagehide
    // 的卸载阶段 GM 写（实测静默失败）可靠得多——tab 即将跳走，提前放锁让新文档立即
    // 抢占。排除：target=_blank（新 tab 开，本 tab 仍是主）、外链（新页面不跑脚本，
    // 靠 pagehide 兜底）、纯锚点（不导航）、javascript: 伪链接。若点击被脚本拦截未
    // 导航，锁被误删也自愈（本 tab 续约 6s 内写回 + sessionStorage 认领兜底）
    document.addEventListener(
        "click",
        (e) => {
            const t = e.target;
            const a = t && t.closest ? t.closest("a[href]") : null;
            if (!a || a.target === "_blank") return;
            let href;
            try {
                href = new URL(a.href, location.href);
            } catch (err) {
                return;
            }
            if (href.origin !== location.origin || href.protocol === "javascript:") return;
            const cur = new URL(location.href);
            cur.hash = "";
            href.hash = "";
            if (href.href === cur.href) return;
            if (holdLock) {
                GM_deleteValue(LOCK_KEY);
            }
        },
        true,
    );
})();
