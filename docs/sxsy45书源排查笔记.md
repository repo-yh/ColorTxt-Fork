# sxsy45（尚香书苑）书源排查笔记

> sxsy45.com 是 Discuz 论坛书源：每本书 = 一个帖子，正文是付费 txt 附件（1 金钱/本），用户自己到网页下载。书源范围只做**搜索 + 详情展示**，不做正文下载；书源定位是「发现更新的工具」（用户明确：不要求详情页，只要有搜索就行）。书源 JSON 与临时文件见 `.qwen/tmp/sxsy45_booksource.json`（可重建）；设计文档 `.qwen/specs/2026-10-09-sxsy45-search-update-design.md`。

## 引擎登录态机制（通用）

- ColorTxt 书源系统是 **legado 兼容实现**；登录态不存 token，而是**完整 Cookie 持久化到 CookieJar**（SQLite `book_source_cookies` 表，domain → JSON 键值对，按 eTLD+1 归档，重启不丢）
- 书源开 `enabledCookieJar` 后每次请求自动附加 Cookie 头；账号密码存 `getLoginInfo/setLoginInfo`，JS 用 `source.getLoginInfoMap()` 取
- 网站若走 `Authorization: Bearer` 头，CookieJar 管不到——需写死进书源 `header` 或用 `@put:/get:` 变量传递
- WebView 登录 Cookie 由 `sourceVerification.ts` 的 `persistSessionCookies` 在 `did-navigate` 时写进 jar；登录成功页若 JS 延迟跳转、关窗太早则 Cookie 没同步

## 搜索必须登录 + 登录墙启发式不识别 Discuz

- 游客访问搜索接口被 302 到 `member.php?mod=logging&action=login`，引擎把登录页 HTML 当结果解析 → bookList 空（表现为「0 条 / 是否未登录」）
- 引擎 `loginCheck.ts` 的 `isLikelyLoginPage` 强特征词（账号登录/人机验证等）与 Discuz 表述（用户名/密码/找回密码）不匹配——**引擎不会自动识别 Discuz 登录墙**，需登录 + CookieJar，或书源加 `loginCheckJs` 主动检测
- 诊断 302：auth 有效 → 302 到 searchid 结果页（200 含 `threadlist`）；游客/失效 → 302 到登录页（含 `loginform_`）。Set-Cookie 只刷 sid 等，从不覆盖 auth
- sxsy45 搜索**无频率限制**（连续多次同关键词均成功，searchid 相同是 Discuz 搜索缓存）

## 验证码登录流程（Discuz）

1. GET 登录页 → 提取 `formhash`、`loginhash`
2. 下载验证码图 `misc.php?mod=seccode&update=<随机>&idhash=cS`（**必须带 Referer** 指向登录页，否则非图片）
3. POST `member.php?mod=logging&action=login&loginsubmit=yes&loginhash=<hash>`（formhash、loginfield=username、username、password、seccodehash=cS、seccodeverify、cookietime）

**两个关键坑**：
- 验证码存**独立 cookie `u52q_2132_seccodecS`**（非 session，只在下载图时下发）——下载图 `-c` 存 jar、POST 用 `-b` 同一 jar，否则「验证码填写错误」；服务器从不下发 `sid`
- 任何 seccode 中间请求（`action=update` 等）都会**作废当前验证码**——严格按「登录页 → 验证码图 → 立即 POST」顺序

## WebView「已登录」指示不可靠

验证/登录窗口用 `defaultSession`（无独立 partition），WebView 显示「已登录」来自其自身 session 残留，**不代表 CookieJar 已有 auth**（搜索走的是 CookieJar，两套独立存储）。

- **别点「重新登录」按钮**：`persistSessionCookies` 会把 WebView 残留 Cookie 转存进 jar，转存的 auth 若已过期会**覆盖 jar 里原本有效的好 auth**——这是间歇性「时好时坏」的头号嫌疑
- 验证 CookieJar：临时日志打印 `cookieHeaderForUrl` 结果，看是否含 auth

## 网络通道：必须走 10808 代理

**sxsy45 直连被 GFW/CF 边缘间歇 RST**（`ERR_CONNECTION_REFUSED` -102，curl HTTP 000）——这才是「搜索 0 条 / 登录窗空白」的真正根因（UA 不一致假设已被推翻：删书源 UA 后登录窗立即连接失败，直连时好时坏只是赶上通道短暂可用）。

- 通道差异：登录验证窗走 **Chromium 网络栈（defaultSession，只跟系统代理）**；引擎搜索走 **undici（找书设置的全局代理，失败回退 bs-net session）**
- **零代码配置法**：① v2rayN 开系统代理（登录窗跟系统代理）；② ColorTxt 找书设置 → 代理填 `socks5://127.0.0.1:10808`（不通换 `http://127.0.0.1:10809`）→ 重新登录一次（cf_clearance 以 10808 出口重签进 CookieJar）
- 书源 header **不写死 User-Agent**，只留 Referer（引擎自动用 `getWebViewUserAgent()` 与登录窗一致）

**后台 WebView 代理（2026-10-09 已修）**：`backstageWebView.ts` 原用 defaultSession 只跟系统代理，`{"webView":true}` URL option 加载 sxsy45 直连被 RST。已改为复用 `chromiumNetFetch.ts` 的 `getBookSourceNetSession()`（按找书代理分区独立 session + `setProxy` + 忽略坏证书），`webPreferences.partition` 指向分区 session、加载前 `await proxyReady`；CookieJar 注入/回写用 `wc.session` 自动跟随。**代理优先级**：找书设置配了 → 走找书代理；没配 → `setProxy({mode:"direct"})` 强制直连（连系统代理也不跟，与引擎 undici 对齐）；登录窗不受影响仍跟系统代理。改 `src/main` 需重新编译。

## _dsign 反爬：webView URL option 解法

- 帖子页（`forum.php?mod=viewthread&tid=xxx`）被 Discuz 防爬插件拦截；`_dsign` 是**会话级时效签名会过期**（曾误判为固定常量）。签名失效时所有帖子页形态返回 **200 + JS 混淆挑战页（6.4KB）**，挑战页 JS 拼新 `_dsign` 做 `location.assign` 跳转
- 书源 `bookUrl` 写死过期 `_dsign` → 引擎 fetch 不执行 JS → `td.t_f`/`thread_subject` 全部 0 命中（附件不显示、无章节）。搜索接口无此防爬
- **正确解法（纯书源配置）**：`bookUrl` 产出 URL 尾部拼 `,{"webView": true, "webViewDelayTime": 4000}`——引擎走隐藏 WebView（CookieJar 注入登录 cookie、UA 与登录窗一致、执行挑战 JS、跟随二次导航、4 秒余量后取回真页面）。**不要**重新解码混淆 JS 换新常量（同样会过期）
- 副作用：书架 bookUrl 带 `,{...}` 后缀，仅影响「复制 URL」观感（key 一致性不受影响）

## curl 验证死路

**curl 无法验证 sxsy45 帖子/搜索接口**：游客、带 CookieJar cookie（含 auth）、换各种 UA 全被 302 登录墙；CF 的 cf_clearance 绑定 UA/出口。需要真实 HTML 时**别用 curl 反复试**，让用户浏览器 F12 Console 抓：

```js
copy([...document.querySelectorAll("a")].filter(a=>a.href.includes("attach")).map(a=>a.outerHTML).join("\n\n"))
```

已确认真实附件 href 含 `attachpay`（`forum.php?mod=misc&action=attachpay&aid=...`，不是 `mod=attachment`），cheerio 选择器 `td.t_f:eq(0) a[href*=attachpay]:eq(0)@href` 可命中。

## loginCheckJs 写法陷阱

引擎把 `result`（StrResponse）包装成**方法接口对象**（`body`/`url`/`code` 都是方法不是属性）：

```js
// ❌ String(result) 恒为 "[object Object]"，永不命中
// ✅ 正确写法
if (String(result.body()).includes('loginform_')) {
  java.startBrowserAwait('https://sxsy45.com/member.php?mod=logging&action=login', '登录 · 尚香书苑');
  result = java.getStrResponse();
}
result;
```

引擎 `webBook.ts` 的 `fetchWithLoginCheck` 在搜索/发现/详情/目录/正文所有路径都会跑 `loginCheckJs`；`fromLegadoCheckResult` 对返回包装对象完全兼容。

## curl cookie jar 陷阱

- `#HttpOnly_` 开头的行**是真 cookie 不是注释**（登录态恰恰是 HttpOnly）——特判 `startsWith("#") && !startsWith("#HttpOnly_")` 才跳过
- Windows 下每行尾带 `\r`，拼 Cookie 头会报 `invalid header value`——切分前 `line.replace(/\r$/, "")`

## 书源问题排查原则

书源问题**优先用纯书源配置解决**（`loginCheckJs`、`loginUrl`、CookieJar 用法），不轻易改引擎代码；临时诊断日志问题解决后回滚。sxsy45 所用机制全部是引擎原生支持（`{{key}}` Mustache、cheerio `:eq()`、`##正则##$1` 替换、`<js>` 尾部规则、`baseUrl` 变量、`loginUrl` WebView 登录窗）。
