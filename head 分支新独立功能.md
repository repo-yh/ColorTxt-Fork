# head 分支新独立功能 — 高亮词体系指导意见

> 目的：记录当前 `main` 分支上高亮词功能**相对上游的独立实现**。下个大版本若与上游合并后高亮词功能偏离、需要重做，按本文档的「数据结构 + 调用链 + 重写要点」恢复即可。
>
> 基准 commit：`2be2c2f`（一键染色按颜色分组多色滚动条染色）。

---

## 1. 高亮词数据结构（核心，务必先对齐）

### 1.1 类型定义（`src/renderer/src/stores/fileMetaStore.ts`）

```ts
export type HighlightWord = {
  text: string;
  isRegex?: boolean;   // true=正则匹配，false/undefined=字面量匹配
};

// 键 = 色索引字符串（"0","1",...），值 = 该色下的词组列表（每组 HighlightWord[]）
// 兼容旧 string[] / string[][] 格式
export type HighlightWordsByIndex = Record<string, HighlightWord[][]>;
```

**关键点**：
- 最外层按**色值索引**分组，不是扁平词表。
- 第二层是**词组**（`HighlightWord[][]`）：一个词组 = 一组同义/关联词，作为一个「高亮词条目」管理（可整体染色、合并、拆分）。
- 每个词自带 `isRegex`，**不再用 `regex:` 前缀**（旧格式已迁移）。

### 1.2 存储位置（localStorage）

| 用途 | key | 说明 |
|------|-----|------|
| 本书高亮词 | `colorTxt.file.meta` → `highlightWordsByIndex` | 按文件路径独立 |
| 全局高亮词（收藏） | `colorTxt.ui.settings` → `highlightWordsByIndexGlobal` | 跨文件 |
| 色值 | `colorTxt.ui.settings` → `highlightColorsLight/Dark` | 亮/暗主题 |
| 总开关 | `colorTxt.ui.settings` → `monacoCustomHighlight` | 默认 true |

### 1.3 向后兼容（`normalizeHighlightWordsByIndex` / `normalizeHighlightGroup`）

旧格式 → 新格式的归一化入口，重写时必须保留：
- `string` → `{ text }`
- `string[]` → `HighlightWord[]`
- `string[][]` → `HighlightWord[][]`

任何从 localStorage/导入/导出读回的地方都要先 normalize，否则旧数据会丢 `isRegex` 或崩溃。

### 1.4 侧栏展示类型（`src/renderer/src/utils/highlightWords.ts`）

```ts
export type HighlightListTerm = {
  terms: string[];                    // 展示文本（可能经过简繁转换）
  storedTerms: string[];              // 存储原始文本
  storedWords?: HighlightWord[];      // 编辑操作用（含 isRegex），查询/染色用这个
  color: string;                      // 该组色值（如 "#ff6b6b"）
  colorIndex: number;                 // 色索引
  scope: "global" | "book";           // 收藏词 vs 本书词
  isFavorited: boolean;
  matchCount: number;                 // 匹配数
  termMatchCounts?: number[];         // 词组内每个词的匹配数
};
```

`buildHighlightListTerms(global, book, colors, bodyText, toDisplayText)` 负责把两份 `HighlightWordsByIndex` 合并成侧栏列表。

---

## 2. 组合查询（染色/查找共用的核心）

`buildHighlightFindQuery(words: readonly HighlightWord[]): { query, useRegex }`（`utils/highlightWords.ts`）：

- 单词语：返回 `{ query: 词, useRegex: 词.isRegex }`
- 多词语：正则词用原文、字面量词用 `escapeRegExp` 转义，`|` 连接，返回 `{ query, useRegex: true }`

**规则**：字面量词必须转义正则特殊字符；`isRegex` 只控制「单词语」时是否走正则引擎，多词语恒为 `useRegex: true`。

---

## 3. 正反查找（上一个/下一个）— 均走内联搜索

### 3.1 查找下一个（左键点击单个词/词组）

```
HighlightListPanel 点击词/整组
  → emit("findHighlightTerm", { query, useRegex, color: item.color })
  → ReaderSidebar 透传 → App.vue → useAppHighlightTerms.onFindHighlightTermFromSidebar
  → readerRef.jumpToNextInlineSearchMatch(q, { useRegex, color })
  → useReaderInlineSearch：findNextMatch 逐条查找（突破 19999 上限）+ 颜色组循环染色（用词色）+ 跳转居中
```

要点：
- 走**内联搜索**（不打开 Monaco 查找框）。
- `jumpToNextInlineSearchMatch` 内部用 `findNextMatch`（无 `limitResultCount` 参数）逐条找，**不受 `findMatches` 的 999/19999 上限**影响，能跳转到全文任意匹配。
- 染色前先 `clear + onClearAllDecorations`（关闭 Ctrl+F）再重新染色。

### 3.2 查找上一个（右键单个词/词组）

```
HighlightListPanel 右键
  → emit("findHighlightTermPrev", { query, useRegex, color: item.color })
  → ReaderSidebar 透传 → App.vue → useAppHighlightTerms.onFindHighlightTermPrevFromSidebar
  → readerRef.jumpToNextInlineSearchMatch(q, { useRegex, color, direction: "prev" })
  → useReaderInlineSearch：findPreviousMatch 逐条查找 + 颜色组循环染色（用词色）+ 跳转居中
```

要点：
- 「上一个」也走**内联搜索**（`direction: "prev"`），用 `findPreviousMatch`（无 `limitResultCount` 参数）逐条往前找，自带回绕到文末。
- 与「下一个」对称，统一走颜色组循环染色，用词色。
- 历史：曾因内联 prev 方向不稳定而改用 Monaco 原生查找框（`openFindWithSearchString(..., "prev")`），统一化重构后 prev 逻辑完善，已改回内联。

---

## 4. 匹配数显示

- 侧栏每个 `HighlightListTerm.matchCount` / `termMatchCounts` 由 `useAppHighlightTerms` 写入。
- 统计用 `model.findMatches(词, false, false, false, null, false)`（字面量，不区分大小写）。
- **必须依赖 `loading` 状态**：文件是流式加载，model 在流结束后才有内容，`loading` 变 false 后要重新触发统计，否则匹配数恒为 0。
- 编辑模式下内容变化通过计数器（`editorContentChangeEpoch`）触发重算。

---

## 5. 新增 / 修改高亮词的 isRegex 传递

### 5.1 侧栏快捷添加（`ReaderSidebar` → `HighlightListPanel`）

- 输入框旁 `.*` 按钮切换 `isRegexMode`。
- 提交 `emit("addHighlightTerm", text, isRegexMode)`，`(text: string, isRegex: boolean)`。
- 颜色随机选：`Math.floor(Math.random() * colors.length)`。

### 5.2 编辑弹窗（`HighlightTermEditModal.vue`）

- `draftTerms: HighlightWord[]`，每项 `{ text, isRegex }`。
- 正则词在 tag 上显示 `.*` 小徽章（`hlTagRegexBadge`，右下角角标）。
- 提交走 `commitHighlightGroup`，**整个词组（含每个词的 isRegex）一起提交**，不要丢单个词的 isRegex。

### 5.3 收藏 / 取消收藏

- `onFavoriteHighlightTerm` / `onUnfavoriteHighlightTerm` 必须从「全局词」和「本书词」**两个作用域**查找源词保留 `isRegex`。
- 取消收藏必须先查到源词 `isRegex`，**再**删除，否则删完找不到。

---

## 6. 组合 / 拆分高亮词（`utils/highlightWords.ts`）

| 函数 | 作用 |
|------|------|
| `mergeHighlightGroupsInMap` | 合并两个词组（拖放合并） |
| `splitTermFromHighlightGroupInMap` | 从词组拆分出单个词 |
| `upsertHighlightGroupInMap` | 新增/更新词组 |
| `removeHighlightGroupFromMap` | 删除整组 |
| `removeHighlightTermFromMap` | 删除单个词 |
| `assignHighlightTermToColorMap` | 给词组分配色索引 |
| `setHighlightGroupColorInMap` | 改变词组色值 |
| `findGroupLocation` | 定位词组（key + index） |
| `termExistsInHighlightMap` / `groupExistsInHighlightMap` | 查重 |
| `highlightGroupListKeyBase` | 词组列表 key（`storedTerms.join("\0")`） |

要点：这些函数全部操作 `HighlightWordsByIndex`（`HighlightWord[][]`），**保留 isRegex**。拖放合并/拆分时不要用 `string[][]`，否则 isRegex 丢失。

### 6.1 单词移动（从多词组拖出单词到另一组）

- 拖多词组中的**单个词**放到另一组时，不整组合并，只移动该词，源组保留其余词。
- 事件链路：`HighlightListPanel.onItemDrop` 判断 `payload.kind === "term"` → `source.storedTerms` 传**完整源组**（仅用于 `findGroupLocation` 定位），被移动的词走新增的 `source.moveTerm` → `ReaderSidebar` 透传 → `App.vue` → `useAppHighlightTerms.onMergeHighlightGroups`。
- `onMergeHighlightGroups` 有 `moveTerm` 时走单词移动分支：`removeHighlightTermFromMap` 从源组移除该词 + `upsertHighlightGroupInMap` 把词合入目标组。同 scope 一次落盘；跨 scope（全局↔本书）源/目标各落盘一次。目标组已存在同名词则忽略，词的 `isRegex` 保留。
- 无 `moveTerm` 时保持原整组合并行为不变。

---

## 7. 一键染色（按颜色分组多色滚动条）— 本次新增

### 行为
- 入口：高亮词 header「一键染色」按钮（`icons.palette` 多色图标）。
- 按高亮词**已有色值**（`colorIndex`）分组，每组合并去重词后 `buildHighlightFindQuery`。
- 每组用该色值给滚动条 `overviewRuler.color` 染色，实现多色指示条。

### 调用链

```
header「一键染色」按钮（ReaderSidebar）
  → highlightPanelRef.colorAllHighlights()   // HighlightListPanel defineExpose
  → onColorAllHighlights：按 colorIndex 分组 → emit("colorAllHighlights", { groups })
  → ReaderSidebar 透传 → App.vue → useAppHighlightTerms.onColorAllHighlights
  → readerRef.setInlineSearchGroups(groups)
  → useReaderInlineSearch：循环前 clear + 关闭 Ctrl+F → 分组染色
```

### 关键实现（`useReaderInlineSearch.ts`）

- `InlineSearchGroup = { query, useRegex, color }`；`inlineSearchGroups: InlineSearchGroup[]`。
- `setInlineSearchGroups(groups)`：`disabled=false` → 存 groups → `clear + onClearAllDecorations` → `applyInlineSearchDecorations`。
- **染色统一为颜色组循环**：`applyInlineSearchDecorations` 只做一个 `for` 循环遍历 `inlineSearchGroups`（单组=循环一次，多组=循环多次，不区分组数），每组 findMatches 后 `overviewRuler.color` 用组色。
- **单组查询也塞进 groups**：`setInlineSearchState`（搜索）设 `inlineSearchGroups = [单元素]`；`jumpToNextInlineSearchMatch`（点击单个词）设 `inlineSearchGroups = [{ query, useRegex, color }]`，color 由 `onFindHighlightTermFromSidebar` 从 `item.color` 传入。
- **当前匹配高亮只看 `inlineSearchCurrentMatch != null`**，与组数无关；无 currentMatch 时所有匹配普通色（不再 fallback 第一个为当前）。

### 清除机制（保证可被其它动作清除）

- 染色走**同一套 decorations collection**，设置前先清旧染色。
- Ctrl+F 打开 → `clearInlineSearchDecorations`（disabled + clear）清除。
- 搜索清空 → `clearInlineSearchState` 清除（`inlineSearchGroups = []`）。
- 点击单个词/搜索 → 覆盖 `inlineSearchGroups` 为新单组（替换旧染色）。

---

## 8. 落盘 localStorage（持久化）机制

### 8.1 两条落盘路径

| 数据 | 内存来源 | 落盘函数 | localStorage key |
|------|---------|---------|-----------------|
| 本书高亮词 | `fileMetaRecords`（`FileMetaRecord[]`） | `persistFileMeta` / `persistFileMetaImmediate` → `persistFileMetaRecords` | `colorTxt.file.meta` |
| 全局高亮词（收藏） | `highlightWordsByIndexGlobal`（ref） | `persistSettings` → `flushPersistSettings` → `persistSettingsData` | `colorTxt.ui.settings` |

### 8.2 本书高亮词落盘链路

```
upsertFileMetaRecord(records, path, patch)   // 更新内存 fileMetaRecords
  → persistFileMeta() → scheduleFileMetaDiskWrite("gated")   // 防抖 + 门控
  → 最终 persistFileMetaRecords(storage, key, items)          // setItem JSON
  → 磁盘结构：{ items: FileMetaRecord[] }，每条 record.highlightWordsByIndex
```

- `persistFileMetaImmediate()`：取消防抖，立即写（关窗等场景，进度/书签/高亮词/视图状态要落盘）。
- 写盘前 `mergeFileMetaWithDiskAndPersist`：多窗口共用 localStorage 时按路径、`updatedAt` 决胜合并。

### 8.3 全局高亮词落盘链路

```
highlightWordsByIndexGlobal.value = ...
  → persistSettings() → persistSettingsQueued（nextTick 合并）
  → flushPersistSettings() → persistSettingsData(localStorage, persistKey, next)
```

### 8.4 关键陷阱（重写时必须保留）

1. **persistSettings 互斥锁**：`persistingSettings` + `persistSettingsPending`。互斥时不能直接 `return` 丢弃，否则「取消收藏」等多步操作的最后一次写入会丢（重启后词恢复）。必须排队（`persistSettingsPending` + finally 里 `nextTick` 复查）。
2. **persistSettingsQueued**：`nextTick` 合并，配色「应用」会连调多次，避免旧数据中途落盘。
3. **normalize 边界转换**：写盘/读回都要 `normalizeHighlightWordsByIndex` / `normalizeHighlightGroup`，否则旧 string/string[][] 数据丢 `isRegex` 或崩溃。

## 9. 重写指导意见（未来版本对齐）

若下个版本与上游合并导致高亮词功能偏离，重做时按顺序恢复：

1. **先对齐数据结构**：确认 `HighlightWord = {text, isRegex}` 与 `HighlightWordsByIndex = Record<string, HighlightWord[][]>` 是否还在；若上游改回 `string[]`/`string[][]` 或 `regex:` 前缀，先补 normalize 兼容层。
2. **再对齐查询**：`buildHighlightFindQuery` 的字面量转义 + isRegex 语义（单词 isRegex、多词恒正则）。
3. **正反查找**：next/prev 都走 `jumpToNextInlineSearchMatch`（`findNextMatch`/`findPreviousMatch` 突破上限，`direction` 区分），统一颜色组循环染色用词色。
4. **匹配数**：依赖 `loading` 状态重新统计，编辑模式用 epoch 计数器触发。
5. **isRegex 传递**：新增/编辑/收藏/取消收藏全链路保留 `isRegex`，收藏取消收藏要跨 global/book 两作用域查找。
6. **组合/拆分**：全部走 `HighlightWord[][]`，拖放合并/拆分不丢 isRegex。
7. **一键染色**：header 直出按钮 → 按 colorIndex 分组 → `setInlineSearchGroups` 多组染色；染色统一为颜色组循环（单组=一组元素），点击单个词用词色 `color` 染色。

---

## 10. 涉及文件清单

| 文件 | 职责 |
|------|------|
| `src/renderer/src/stores/fileMetaStore.ts` | `HighlightWord` / `HighlightWordsByIndex` 类型 + normalize |
| `src/renderer/src/utils/highlightWords.ts` | 查询/组合/拆分/合并/去重 + `HighlightListTerm` + `buildHighlightListTerms` |
| `src/renderer/src/composables/useAppHighlightTerms.ts` | 高亮词 CRUD、匹配数、正反查找、一键染色入口 |
| `src/renderer/src/composables/useReaderInlineSearch.ts` | 内联搜索染色（单组 + 分组）、跳转（findNextMatch） |
| `src/renderer/src/components/HighlightListPanel.vue` | 侧栏高亮词列表 UI + 分组染色（onColorAllHighlights）+ 更多菜单 |
| `src/renderer/src/components/HighlightTermEditModal.vue` | 新增/编辑弹窗（isRegex 徽章、词组编辑） |
| `src/renderer/src/components/ReaderSidebar.vue` | header 按钮（一键染色/添加/更多）+ 事件透传 |
| `src/renderer/src/components/ReaderMain.vue` | Monaco 编辑器 + defineExpose（setInlineSearchGroups 等） |
| `src/renderer/src/App.vue` | 事件绑定 + 全局词状态 + onFavorite/onUnfavorite |
| `src/renderer/src/monaco/txtrHighlightMonarch.ts` | Monarch 前景色染色（高亮词实时着色） |

---

## 11. AI 技能（内置 AI 工具）

> 目的：记录 `main` 分支上**内置 AI 对话助手**新增的工具与技能，供未来版本合并偏离后按文档恢复。
> 两个技能：**高亮词情景分析**（`highlightDistribution` / `highlightBody`）与 **章节名补全**（`getChapterTitles` / `applyChapterTitles`）。
> 详细计划见 `.qwen/specs/ai-highlight-context-tool.md` 与 `.qwen/specs/ai-chapter-title-completion.md`。

### 11.1 高亮词情景分析（highlightDistribution / highlightBody）

**用途**：AI 根据高亮词分布获取正文/章节全文，分析高亮词涉及的情景（谁和谁干了什么）。**不走向量库、不压缩、不截断**——直接读渲染进程当前书上下文（`currentFile` + Monaco model 全文），与 Web `/api/highlights` 同源。

**两个工具 schema**（`src/shared/aiTypes.ts` `AI_AGENT_TOOLS`）：

| 工具 | 作用 | 参数 |
|------|------|------|
| `highlightDistribution` | 当前书高亮词分布（按章节分组，含命中行号与命中词） | `reasoning` |
| `highlightBody` | 当前书指定范围纯文本正文（不压缩不截断） | `reasoning` + 二选一：`chapterIndex`（整章）或 `start`/`end`（行范围，0-based，end 含） |

**调用链**：

```
用户问「高亮词涉及的情景 / 谁和谁干了什么」
  → 模型调用 highlightDistribution 获取全书高亮词分布（不关心当前阅读章节）
  → 对集中点（约 20 行内 ≥5 次命中）用 highlightBody 按 start/end 或 chapterIndex 拉纯文本正文
  → 主进程 agentChat.ts dispatchTool → runHighlightDistribution / runHighlightBody
  → webContents.executeJavaScript 调渲染进程桥接 __colorTxtGetHighlightDistribution / __colorTxtGetHighlightBody
  → App.vue 桥接用 currentFile + getAllText() 取全文 + 合并全局/文件级高亮词
  → ReaderMain.vue getHighlightDistribution（复用 buildHighlightLines）/ getHighlightBody（纯文本切片）
```

**关键点**：
- **不依赖向量索引**：正文过长时用多次 `start`/`end` 分段获取，勿一次拉取整本；**不要截断**正文。
- **禁止用 ragSearch / ragContext 代替**：它们会向量分块或压缩，导致高亮词命中位置与正文细节不准确。
- **敏感内容照常分析不拒答**：涉及人物时明确告诉用户男女主在干什么（含亲密/隐私/敏感情节）。
- 系统提示新增「高亮词情景分析」小节引导模型（`agentChat.ts` `buildAgentSystemPrompt`）。

**涉及文件**：`aiTypes.ts`（schema）、`agentChat.ts`（run 函数 + dispatchTool + 系统提示）、`App.vue`（桥接）、`ReaderMain.vue`（getHighlightDistribution / getHighlightBody）、`env.d.ts`（桥接类型）。

### 11.2 章节名补全（getChapterTitles / applyChapterTitles + 章节名补全技能）

**用途**：AI 逐章读取章节内容，总结章节名，只编辑标题行，仅补全缺失名（只有章节号没有名字的标题），保留原标题前缀，直接写回磁盘。

**两个工具 schema**（`src/shared/aiTypes.ts` `AI_AGENT_TOOLS`）：

| 工具 | 作用 | 参数 |
|------|------|------|
| `getChapterTitles` | 当前书章节列表（含 chapterIndex、title、lineNumber、字数 charCount） | `reasoning` |
| `applyChapterTitles` | 为指定章节替换标题行（写回磁盘） | `reasoning` + `items: [{chapterIndex, title}]`，title 为**完整新标题**（含章节号前缀） |

**技能**：`BUILTIN_AI_SKILLS` 新增「章节名补全」（`CHAPTER_TITLE_COMPLETION_SKILL_ID = "chapter-title-completion"`，`src/shared/aiSkills.ts`），默认启用。引导文案在技能 `prompt` 中（**不硬编码在系统提示**），用户启用该技能时 AI 通过 `skill_chapter-title-completion` 工具获得。

**调用链**：

```
用户输入「给所有章节补全章节名」
  → 模型调用 getChapterTitles 获取章节列表（含 charCount）并判断哪些缺名
  → 对缺名章用 highlightBody(chapterIndex) 读原文（不截断）→ 总结章节名（保留前缀拼完整新标题）
  → 调用 applyChapterTitles([{chapterIndex, title}...]) 写回
  → 主进程 agentChat.ts dispatchTool → runGetChapterTitles / runApplyChapterTitles
  → webContents.executeJavaScript 调渲染进程桥接 __colorTxtGetChapterTitles / __colorTxtApplyChapterTitles
  → App.vue 桥接：getChapterTitles 读内存 chapters；applyChapterTitles 定位物理行替换整行 → 写盘刷新
```

**写回实现（App.vue `__colorTxtApplyChapterTitles`）**：
1. 用内存 `chapters[chapterIndex].lineNumber`（展示行号）→ `stream.getDisplayLineToPhysicalLine()` 映射物理行（map 为空时物理行 = 展示行号）。
2. **直接替换整行**：`lines[physicalLine - 1] = title`（AI 传的完整新标题，含前缀）。
3. 批量替换后一次性重建全文，复用 `onApplyPartialPhysicalEdit` 链路：`writeTextFile` → `commitPhysicalLinesFromPlainText` → `applyReaderDisplayFromPhysicalLines` → `syncChaptersAfterViewportSettled`。
4. **不使用正则**：章节识别、缺名判断、前缀保留全由 AI 基于 `getChapterTitles` 返回的内存 `chapters` 数据完成；渲染进程只定位物理行并直接替换。

**关键点**：
- **正文获取只用 highlightBody**：不压缩不截断，支持 chapterIndex 整章；**禁止使用 ragContext**（会截断/压缩正文）。
- **分批处理避免大上下文**：缺名章中 `charCount > 10000` 的超长章节**每章单独一批**（一章读完、写回，再处理下一章），不与其他章合批；其余普通章**每 5 章一批**循环，避免一次拉取超大正文导致上下文过大。
- **章节引用标记**：`highlightBody` / `getChapterTitles` 描述与技能 prompt 均补充 `（ch=N）` 章节跳转标记引导（N = chapterIndex，从 0 起），使 AI 回答中可点击跳转正文对应章节。
- **向量检索关闭时工具仍开放**：`buildAgentToolsWithSkills` 只排除 RAG 依赖工具（`ragSearch` / `ragContext` / `extractCharacterAppearance`），`highlightBody` / `getChapterTitles` / `applyChapterTitles` 等非 RAG 工具始终开放。
- **runSkillInvokeTool 特殊指令**：`agentTools.ts` 为章节名补全技能加特殊指令（用 highlightBody、禁止 ragSearch/ragContext、分批处理）。

**涉及文件**：`aiTypes.ts`（schema + 描述）、`aiAgentSkillToolNames.ts`（技能 ID）、`aiSkills.ts`（技能定义）、`agentChat.ts`（run 函数 + dispatchTool）、`agentTools.ts`（buildAgentToolsWithSkills + runSkillInvokeTool）、`App.vue`（桥接 + 写回）、`env.d.ts`（桥接类型）。



