### 核心约定

1. 扩展：无 pending 任务表、不暂存任务结果；任务执行时 WS 断连 → 直接丢，不补发
2. 服务端：
   - 下发 `task`，开启超时计时器（比如 40s，大于页面 30s 加载超时）
   - 超时没收到对应 `task_result` → 视为失败，**服务端重新推送这条任务**
   - 服务端维护 `ws_connId → tabId`；重试时带上上次拿到的 tabId
   - 如果 tab 已经被用户关掉：扩展校验发现 tabId 失效，自动新建、返回新 tabId，服务端更新映射



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

## 服务端侧规则（重点）

1. 每个下发的 `task`，以 `taskId` 作为唯一标识，启动超时（建议 40s）
2. 超时前收到 `task_result`：
   - 正常消费；用里面的 `tabId` 更新当前连接的绑定 tabId
3. 超时没收到回复：
   - 判定本次交付失败；**服务端重新下发同一个 task**（带上当前缓存的 tabId）
4. WS 断开：所有 pending 的任务全部视为待重试；等客户端重连上来后，服务端再推送未完成任务
5. taskId 一定要全局唯一，用来去重、匹配应答