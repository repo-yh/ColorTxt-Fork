# Web 阅读服务（localhost:8888）

> 应用内 HTTP 服务，浏览器展示阅读器正文及完整 Monarch 染色效果。前端 `front/index.html` + `style.css` + `app.js`（2026-10-08 从单文件拆分）。

## 架构

- 服务端：`src/main/webDisplay.ts`，端口 8888；`src/main/index.ts` IPC + 开关；`ipcHandlers.ts` 传三回调；`preload/index.ts` 暴露 API
- 染色始终在 ColorTxt **渲染进程**完成（Monarch tokenizer），浏览器只展示
- `startWebDisplay` 三回调：`getCurrentContent` / `getContentForFile(filePath)` / `getFileList`；非当前文件经 `readWholeTextFile` IPC 读盘后 `monaco.editor.tokenize()` 分词染色

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | front/index.html |
| GET | `/style.css` `/app.js` | 静态资源（显式路由 + `serveFile` 读盘，无通用静态伺服） |
| GET | `/api/content` | 当前阅读文件 `{ file, html, theme }` |
| GET | `/api/content?file=xxx&start=N&end=M` | 指定文件分段染色 HTML |
| GET | `/api/files` | 书架文件列表（含 pathEncoded） |
| GET | `/api/status` | `{ ok, file }`（无打开文件时 `ok:false`） |

- 窗口定位用 `mainWindowFocusState` 精确匹配主窗口（`BrowserWindow.getAllWindows()` 会误选找书窗）
- 打包需 `build.files` 含 `"front/**"`（否则 ASAR 缺 front 目录）
- 主进程 `currentFilePath` 由 App.vue watch `currentFile` 经 `webDisplay:setCurrentFile` IPC 推送

## 编译注意

- `webDisplay.ts` 是 main 进程源码：改后需 `npx electron-vite build`
- `front/*` 运行时直接读盘（`join(app.getAppPath(), "front")`）：改后刷新浏览器即生效，**无需重编译**

## 分段懒加载与跳转（核心性能设计）

- 前端按 `SEGMENT_SIZE = 500` 行分段请求，`textCache`（Map，最多 5 个文件全文）避免重复读盘；全量缓存已删除（2026-03，写盘但不被前端使用）
- **章节跳转卡死修复（2026-10-08）**：原实现从第一章跳最后一章会一次性补齐目标行之前全部未加载内容（可能全本）导致卡死。现改为只加载**目标章节所在段 + 前后各一段**（3×500 行）
  - 中间留下"未加载空洞"，**双向哨兵**：`$sentinel` 向下续载 + `$sentinelTop` 向上续载，单个 IntersectionObserver 按 `target.id` 分发
  - `loadPrevSegment()` 向上加载后按 `scrollHeight` 差值 `scrollBy(0, delta)` 补偿防跳屏
  - 跳转到未加载区域时 `clearContent()` 清空正文行 + 重置 `loadedRanges`，正文常驻约 1500 行不膨胀；侧栏/吸顶标题/哨兵不受影响
  - 相邻章节三段均已加载时零请求直接滚过

## 阅读进度保存/恢复（2026-10-08）

- localStorage `colortxt_web_progress`：JSON map `{ 文件路径: 行号 }`，按文件区分
- 保存：`findTopVisibleLine()` 取视口顶第一个完整可见行（`getBoundingClientRect().top >= 60`），滚动停止 500ms debounce 写入；`beforeunload` 与切换文件兜底
- 恢复：`loadFile()` 读 savedLine > 0 走 `jumpToLine(savedLine, forceRefresh)`（未加载 → `clearContent()` → 只加载目标三段 → 定位）；服务端 `buildColoredHtmlSegment` 对 start/end 做完整 clamp，总行数未知时发超界 end 请求安全
- `jumpToLine` 尾部顺序：先 `scrollToLine` → 再 `updateStickyChapter()` → 最后 `setupSentinel()`（避免顶部哨兵以定位前快照误触发 `loadPrevSegment` 推走视口）

## 吸顶章节标题：JS 浮层（非 CSS sticky）

CSS sticky 在滚动时"跟随→吸回"产生视觉跳动，改用独立浮层：

- `#stickyChapter` 是 `<body>` **直属子元素**（`position: fixed`，`z-index: 11` > 工具栏 10，不透明背景）
- `alignStickyChapter()`：每次 scroll/resize 读工具栏 `getBoundingClientRect()`，动态设置 top/left/right（工具栏是 sticky，rect 随滚动变化，必须每帧重读）
- `updateStickyChapter()`：找 `offsetTop <= scrollTop + 64` 的最后一个章节更新文字
- **恢复进度吸顶不显示的修复（2026-10-08）**：原判定依赖章节元素在 DOM（恢复进度只加载 3 段，章节间隔超 1500 行时上方章节元素不存在 → 判定失败）。已改为**行号判定**：`findTopVisibleLine()` 取视口顶行，找 `chapters[i].line <= topLine` 的最后一个章节，不依赖 DOM

## 侧栏展开不重排正文（2026-10-08）

- 正文固定宽度 `#main { width: calc(100% - 260px) }`，展开/收起用 `transform: translateX(240px)` 整体平移（不再用 `margin-left` 挤压导致重排/丢滚动位置）
- `toggleSidebar()` 删除了滚动位置补偿逻辑（高度不变天然保持），改为 250ms 后 `alignStickyChapter()`
- 移动端媒体查询重置：`#main { flex: 1; width: auto }` + `shifted { transform: none }`（侧栏是覆盖层）
- 已知代价：收起侧栏时正文右侧留 240px 空白

## 字体大小调节（2026-10-08）

`#content` 用 `font-size: var(--content-size, 16px)`，A−/A+ 步进 1px（12–40px，到边界禁用），localStorage `colortxt_web_font_size` 持久化；移动端同一变量（默认 15px 起）+ 紧凑按钮样式。

## 章节行号偏移补偿

章节检测引擎对多行标题（如"第一章\n练气"）返回的 `lineNumber` 常落在**第二行**（正则实际匹配行）。构建 `chapterLineSet`/`chapterList` 时检查 `lines[c.lineNumber]` 是否含标题文字，不含则回退 `lineNumber - 1`。

## sticky 相关陷阱

- **Chrome sticky + scrollIntoView 失效**：目标元素已吸附时，Chrome 认为"已在视口内"拒绝滚动。跳转前临时 `el.style.position = 'static'` → `scrollIntoView` → `requestAnimationFrame` 恢复；配合 `scroll-margin-top: 60px`
- **CSS sticky 包含块**：需要隔离 sticky 边界时用 `transform: translateZ(0)` 或 `overflow` 创建包含块，**`contain: layout style` 不创建** sticky 包含块

## 已知问题与优化方向

- 浏览器卡顿根因是全链路同步阻塞：IPC 读盘 → 全文分词 → 巨大 HTML 字符串 → 序列化 → innerHTML 数万节点。优化方向：只传 token 位置数据，前端 CSS class 按需渲染
- 纯文本词典/正文若配 css，注入 `<style>` 后可能被 `looksLikeHtml` 误判为 html

## 踩坑记录

| 问题 | 原因 | 修复 |
|------|------|------|
| `getLineTokens is not a function` | Monaco 0.55 内部 API 未暴露 | 改公共 API `monaco.editor.tokenize()` |
| 染色不生效 | tokenize 返回的 token type 带 `.txtr-text` 后缀 | 去后缀再查色值映射 |
| 拿到找书窗内容 | 全窗口搜索误选找书窗 | `mainWindowFocusState` 精确定位 |
| 打包后 front 404 | `build.files` 未含 `front/**` | package.json 补白名单 |
| `/api/status` 恒 ok:false | 渲染进程从不 setCurrentFile | App.vue watch 推送 + 启动时推一次 |
