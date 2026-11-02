### 核心约定

1. 扩展：无 pending 任务表、不暂存任务结果；任务执行时 WS 断连 → 直接丢，不补发
2. 服务端：
   - 下发 `task`，开启超时计时器（比如 40s，大于页面 30s 加载超时）
   - 超时没收到对应 `task_result` → 视为失败，**服务端重新推送这条任务**
   - 服务端维护 `ws_connId → tabId`；重试时带上上次拿到的 tabId
   - 如果 tab 已经被用户关掉：扩展校验发现 tabId 失效，自动新建、返回新 tabId，服务端更新映射
3. 下载任务（kind=download）例外——fire-and-forget：
   - 服务端下发即返回，**不 pending 等待回传**（大附件/慢站会长时间占用 WS 等待），不做超时重推
   - 扩展 fetch 响应头到手后**先主动推送 `download_start`**（带 bookName + 文件元数据 meta.filename/contentType/size 与帖子 URL）——服务端把「文件元数据 ↔ 书籍 name」对应保存，立刻感知哪本书开始下载
   - 下载**完成或失败后推送 `download_result`**（成功带附件内容与 name，失败带 error，均带 bookName + 帖子 URL），服务端按 taskId 归属映射找到需要替换的书籍，落盘/记日志，保证失败也有感知
   - 下载非幂等（重推会重复请求附件、重复扣金钱），失败由用户重新触发



## 整协议清单

### 1. 心跳

扩展 → 服务：

```
{"type":"ping"}
```

服务 → 扩展：

```
{"type":"pong"}
```

### 2. 服务下发任务（第一次 tabId=null）

```
{
  "type":"task",
  "url":"https://www.baidu.com",
  "taskId":"t001",
  "tabId":null
}
```

### 3. 扩展返回结果（成功 / 失败都带 tabId）

成功：

```
{
  "type":"task_result",
  "taskId":"t001",
  "tabId":1234,
  "ok":true,
  "pageData":{
    "title":"百度一下，你就知道",
    "text":"...",
    "html":"...",
    "href":"https://www.baidu.com/"
  }
}
```

失败：

```
{
  "type":"task_result",
  "taskId":"t001",
  "tabId":1234,
  "ok":false,
  "error":"page load timeout"
}
```

### 4. 服务下发下载任务（kind=download）

```
{
  "type":"task",
  "taskId":"dl-1699-1",
  "url":"https://sxsy33.com/forum.php?mod=attachment&aid=<base64签名>",
  "tabId":1234,
  "kind":"download",
  "referer":"https://sxsy33.com/forum.php?mod=viewthread&tid=433664&…",
  "postUrl":"https://sxsy33.com/forum.php?mod=viewthread&tid=433664&…",
  "bookName":"现代都市异闻录"
}
```

- `tabId`：服务端缓存的上次抓页 tab（通常是帖子页），扩展优先复用同源页执行 fetch
- `referer`：发起页 URL（tab 全失效时扩展新建 tab 打开它）；不带时用 url 本身
- `postUrl`：附件归属的帖子 URL，扩展推送时原样带回（找书接线用于归属书）
- `bookName`：触发下载的书架书籍名，扩展在 download_start / download_result 推送时原样带回（服务端按此找到需要替换的书籍）

### 5. 扩展主动推送下载开始（fetch 响应头到手、body 拉取前）

```
{
  "type":"download_start",
  "taskId":"dl-1699-1",
  "tabId":1234,
  "url":"https://sxsy33.com/forum.php?mod=attachment&aid=<base64签名>",
  "postUrl":"https://sxsy33.com/forum.php?mod=viewthread&tid=433664&…",
  "bookName":"现代都市异闻录",
  "ok":true,
  "meta":{
    "contentType":"application/octet-stream",
    "filename":"[sxsy.org]现代都市异闻录1-19作者：赵高.txt",
    "size":443270
  }
}
```

- `meta.filename`：Content-Disposition 优先，无则 URL pathname 解码兜底
- `meta.size`：Content-Length，服务器未声明时为 0（仅提示；实际大小以 download_result 的 blob.size 为准）
- fetch 失败（HTTP 错误/返回 HTML）不推 start，直接推 download_result(ok=false)

### 6. 扩展主动推送下载结果（成功 / 失败都推）

成功：

```
{
  "type":"download_result",
  "taskId":"dl-1699-1",
  "tabId":1234,
  "url":"https://sxsy33.com/forum.php?mod=attachment&aid=<base64签名>",
  "postUrl":"https://sxsy33.com/forum.php?mod=viewthread&tid=433664&…",
  "bookName":"现代都市异闻录",
  "ok":true,
  "name":"[sxsy.org]现代都市异闻录1-19作者：赵高.txt",
  "blob":{
    "data":"<base64 文件内容>",
    "contentType":"application/octet-stream",
    "filename":"[sxsy.org]现代都市异闻录1-19作者：赵高.txt",
    "size":443270
  }
}
```

- `name`（顶层）：文件名，服务端保存落盘、按书名匹配替换书籍条目都靠它
- `bookName`：下发时带的书籍名原样带回（服务端归属映射的兜底）

失败：

```
{
  "type":"download_result",
  "taskId":"dl-1699-1",
  "tabId":1234,
  "url":"…",
  "postUrl":"…",
  "bookName":"现代都市异闻录",
  "name":"[sxsy.org]…（响应头已拿到时带，未拿到为空串）",
  "ok":false,
  "error":"返回 HTML(登录态可能已失效)"
}
```

下载实现要点：扩展在**同源 tab**（serverTabId 优先，其次任意同源 tab，最后新建 tab 打开 referer）内
`executeScript` 执行 `fetch(url, {credentials:"include"})`——自动携带登录 Cookie / Referer / CF 会话；
校验 `r.ok` 且 content-type 非 `text/html`（登录失效时 Discuz 返回 200+HTML 登录页）；
文件名优先 Content-Disposition；ArrayBuffer 经消息序列化会丢失，分块（0x8000/块）转 base64。

## 服务端侧规则（重点）

1. 每个下发的 `task`，以 `taskId` 作为唯一标识，启动超时（建议 40s）
2. 连接管理（本机单人，单连接策略）：
   - **新连接顶替旧连接**：扩展重载 / SW 挂起唤醒后的新连接直接接管，旧连接视为半开残留强制断开（旧 SW 已死时 TCP 无 FIN，服务器侧收不到断开事件）
   - **服务器心跳释放**：服务器每 30s 发协议层 ping（浏览器自动回 pong，扩展无需处理），连续两轮无 pong（约 60s）判定死连接强制断开释放
3. 超时前收到 `task_result`：
   - 正常消费；用里面的 `tabId` 更新当前连接的绑定 tabId
4. 超时没收到回复：
   - 判定本次交付失败；**服务端重新下发同一个 task**（带上当前缓存的 tabId）
5. WS 断开：所有 pending 的任务全部视为待重试；等客户端重连上来后，服务端再推送未完成任务
   （下载任务例外：主动推送模式，断线期间扩展的 download_result 直接丢弃，服务端无 pending）
6. taskId 一定要全局唯一，用来去重、匹配应答
7. 下载任务（kind=download）：下发即完成，无超时计时；收到推送后
   - `download_start`：把扩展返回的文件元数据（meta.filename/contentType/size）与 bookName 对应保存（taskId → 归属映射），日志记「下载开始」
   - `download_result` ok=true：按 taskId 查归属映射拿到 bookName（扩展带回的 bookName 兜底），base64 解码落盘（重名加时间戳后缀），按书籍名找到需要替换的书籍（找书接线用）；`postUrl` 供归属书
   - `download_result` ok=false：记日志（失败有感知，由用户重新触发）