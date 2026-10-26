# head 分支新独立功能 — 重做指导意见

> 目的：记录当前 `main` 分支上 **fork 相对上游的独立功能实现**。下个大版本若与上游合并后功能偏离、需要重做，按对应章节的「数据结构 + 调用链 + 重写要点」恢复即可。
>
> 当前收录：① 高亮词体系（§1–§10）；② 章节屏蔽（§11，2026-10-26 新增）。
>
> 基准 commit：`2be2c2f`（一键染色按颜色分组多色滚动条染色）；§11 基准：实施当日工作区（typecheck 通过）。

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

## 11. 章节屏蔽（右键屏蔽章节目录单个章节）— 2026-10-26 新增

> 动机：章节目录由全局章节正则规则检测，个别书会抓到「不合适的章节」（正文引用的"第X章"、目录页、广告行等）。为某本书单独调全局正则会波及所有书，故做 per-file 的手动屏蔽。语义判断（这行不是章节）机器按格式匹配区分不了，屏蔽是唯一精确手段。

### 11.1 行为

- 侧栏章节列表**右键章节行** → 菜单「屏蔽此章节」→ 从目录/导航隐藏（正文内容与标题样式不动，只动目录导航层）+ toast。
- 恢复：章节列表 footer 上方「**已屏蔽章节（N）**」折叠条，展开后逐条「恢复」（切换文件自动收起）。
- 生效范围（全走过滤后的章节表）：侧栏章节列表、上一章/下一章导航、当前章高亮、粘性章节条锚点（`setChapters`）、语音朗读计章、AI 章节名补全、文件列表「N章」、面板「共 N 章」。
- **统计语义（用户拍板）**：统计数字 = **屏蔽后数量**；被屏蔽章节的 `charCount` **并入上一个保留章节**（误抓行本就是上一章正文的延续，且避免上一章因字数不足被 minCharCount 误滤）。
- Web 展示服务（8888）经**桥接层注入过滤**生效（2026-10-26 修复）：Web 前端章节列表来自 `/api/content` 响应的 `chapters` 字段，由 ReaderMain `buildChapterList` **独立重检测**（不走 `chapters.value`），需 App.vue 桥接按 filePath 查 meta 把 `blockedChapters` 传进 ReaderMain 过滤（见 11.3b）；`/api/chapters`（AI 补全）才直接吃 `chapters.value`。
- 替换文件：`replaceFileInList` 整条 meta 迁移（`{ ...prevMeta, path }`），屏蔽列表自动跟随。

### 11.2 数据结构（`src/renderer/src/stores/fileMetaStore.ts`）

```ts
export type BlockedChapterRecord = {
  title: string;
  lineNumber: number;   // 屏蔽时刻的标题行号（主锚）
  charCount: number;    // 屏蔽时刻的章节字数（行号漂移时的兜底锚）
};
// FileMetaRecord.blockedChapters?: BlockedChapterRecord[]（per-file 持久化）
```

- `normalizeBlockedChapters`：title 非空 + `lineNumber ≥ 1`，按 **`title + lineNumber`** 去重，上限 500，**空数组归一为 undefined（不落盘）**。
- `upsertFileMetaRecord` 保留链含 `blockedChapters: prev?.blockedChapters`（漏了会被任何一次 meta 写入静默清掉）。
- 屏蔽记录在 meta 上 → 替换文件（`replaceFileInList` 的 `{ ...prevMeta, path }` 整记录迁移）自动跟随，无需单独处理。

### 11.3 过滤位置：章节检测「应用层」（`composables/useAppChapterNavigation.ts`）

```
applyChapterListResult(detected)        // 检测产物（全量）先入缓存
  lastDetectedChapters = detected; lastDetectedFilePath = currentFile
  filtered = filterBlockedChapters(detected)
    // 剔除被屏蔽章节；其 charCount 并入 out 中上一个保留章节（首章被屏蔽则字数丢弃）
  chapters.value = filtered             // 单点过滤，下游全部自动生效
  onChaptersApplied(path, filtered.length)   // 文件列表「N章」= 屏蔽后数量
  readerRef.setChapters(filtered)       // 粘性章节条/导航锚点 = 过滤后
  activeChapterIdx = pickActiveChapterIdx(chapters, lastProbeLine)

reapplyChapterBlockFilter()             // 屏蔽/恢复后调用：免重扫，从缓存重过滤
  // 校验 lastDetectedFilePath === currentFile，防切换文件后误用旧书缓存
```

- 上/下章导航、`pickActiveChapterIdx`、`jumpToChapter` 基于 `chapters`（过滤后）**天然跳过被屏蔽章节**，无需单独改导航逻辑。
- 视口落在被屏蔽章节区段内时，`pickActiveChapterIdx` 自动落到前一个保留章节（语义正确：屏蔽区段归属上一章）。
- 编辑模式刷新 / 章节规则变更 / 手动刷新都走同一条 `applyChapterListResult`，屏蔽自动重应用。
- `chapterMinCharCount` 过滤（侧栏层 `chapterMeetsMinCharCount`）与屏蔽过滤是**两层叠加**：先屏蔽（应用层、含字数合并），后 minCharCount（侧栏 `chaptersVisible`）。

### 11.3b Web 展示链路过滤（`components/ReaderMain.vue` buildChapterList，2026-10-26 补）

Web 前端（`front/app.js`）的章节列表**不是**来自 `/api/chapters`，而是 `/api/content` 响应里的 `chapters` 字段（`renderChapters(data.chapters)`）；该字段由 ReaderMain 的 `buildChapterList(fullText, filePath, lines)` 从原始全文**独立重检测**（txt 走 `buildChaptersFromPlainText`，md 走 ATX 标题），与主程序 `chapters.value` 是两条链路。屏蔽对 Web 生效的做法：

```
App.vue 四个桥接（已各自查 meta 合并高亮词，复用同一次查询）
  __colorTxtGenerateColoredHtmlForText / ForSegment / HighlightLinesForText / GetFullText
  → 把 meta?.blockedChapters 作为新参数传给 ReaderMain expose
  → buildColoredHtml / buildColoredHtmlSegment / buildHighlightLines / getFullText
  → buildChapterList(..., blockedChapters)
      缓存 chaptersCache 存「文本指纹 → 全量 Chapter[]」（过滤在输出时做，缓存与屏蔽无关）
      kept = filterChaptersByBlockedRecords(chapters, blockedChapters)   // 共享纯函数
      chapterList（目录输出）与 chapterLineSet（正文标题行样式）都用 kept：
      被屏蔽章节标题行按普通正文渲染、不加 chapter-title 类（2026-10-26 用户拍板；
      与主程序「标题样式不动，只动目录导航层」语义不同，重写时勿混同）
  → getFullText 按 chapterIndex 切章用过滤后列表（被屏蔽区段并入上一章，
    与 /api/chapters 的过滤后索引天然对齐）
```

- 共享过滤纯函数在 `reader/chapterBlock.ts`：`isChapterBlockedByRecords`（title + lineNumber || charCount 匹配）、`filterChaptersByPredicate`（剔除 + charCount 并入上一章）、`filterChaptersByBlockedRecords`。主程序链路（`useAppChapterNavigation.filterBlockedChapters`）、App.vue `isCurrentChapterBlocked`、Web 链路三处共用，杜绝逻辑漂移。
- 主进程（`webDisplay.ts` / `ipcHandlers.ts`）**零改动**：屏蔽注入完全发生在渲染进程桥接内部，主进程不感知 meta。

### 11.4 事件调用链

```
屏蔽：章节行 @contextmenu.prevent.stop（ChapterListPanel）
  → AppContextMenu「屏蔽此章节」（icons.close，point 定位）
  → emit("blockChapter", chapter) → ReaderSidebar 转发 → App.vue onBlockChapter
  → upsertFileMetaRecord（blockedChapters 追加，title+lineNumber 去重）
  → persistFileMeta() → chapterNav.reapplyChapterBlockFilter() → toast

恢复：「已屏蔽章节（N）」折叠条「恢复」按钮（ChapterListPanel）
  → emit("unblockChapter", record) → App.vue onUnblockChapter
  → 按 title + lineNumber 删除 → persistFileMeta → reapply → toast
```

- ReaderSidebar 用 `findFileMetaRecord(props.fileMetaRecords, currentFilePath)` 取 `blockedChapters` 传给 ChapterListPanel（props `blockedChapters`），不新增跨层状态。
- 屏蔽判断 `isChapterBlocked(ch)`（App.vue `isCurrentChapterBlocked`）：`b.title === ch.title && (b.lineNumber === ch.lineNumber || b.charCount === ch.charCount)`——**在检测全量章节上判定**（filterBlockedChapters 的输入），不在过滤后列表上。

### 11.5 陷阱（重写时必须保留）

1. **锚定匹配有降级**：主锚 `title+lineNumber`；文件重编辑后行号漂移时 `charCount` 兜底；都匹配不上则不再隐藏（无害，重新屏蔽即可）。不要改成只按 title——同名标题（正文误抓 + 真章节同名）会误伤真章节。
2. **`reapplyChapterBlockFilter` 必须校验 `lastDetectedFilePath === currentFile`**：切文件后章节表未重建时防误用上一本的缓存。
3. **屏蔽/恢复走重过滤而非重新检测**：大书（5 万行+走 heavy 分块路径）重检测会卡，缓存全量后重过滤瞬时生效。
4. **`blockedChapters` 空数组要归一为 undefined**，否则空数组随每条 meta 落盘。
5. **`chapters` 全链路共享（但仅限应用层链路）**：语音朗读（`useAppVoiceRead({ chapters })`）、AI 章节名补全（`__colorTxtGetChapterTitles`）吃 `chapters.value`，屏蔽后自动一致——不要给它们单独回退到全量。**Web `/api/content` 链路例外**：它由 ReaderMain `buildChapterList` 独立检测，必须经桥接注入 `blockedChapters`（见 11.3b），不会自动生效。
6. 右键菜单在章节行上要 `.stop`，否则冒泡到全屏布局的 `@contextmenu`（App.vue `onLayoutContextMenu`）重复弹菜单。
7. **Web 链路的屏蔽过滤必须在输出时做、缓存存全量**：`chaptersCache` 键只有 filePath+文本指纹，若把过滤后列表存进缓存，屏蔽/恢复后（文本未变）会命中旧缓存永不刷新；`chapterList` 与 `chapterLineSet` 都从过滤后的 `kept` 构造——被屏蔽章节标题行不加 `chapter-title` 类（2026-10-26 用户拍板，Web 端与主程序「标题样式不动」语义不同）。

### 11.6 涉及文件清单（§11）

| 文件 | 职责 |
|------|------|
| `src/renderer/src/stores/fileMetaStore.ts` | `BlockedChapterRecord` + `blockedChapters` 字段 normalize/去重/上限 + upsert 保留链 |
| `src/renderer/src/reader/chapterBlock.ts` | 共享屏蔽过滤纯函数（记录匹配 / 剔除+字数并入），主程序与 Web 链路共用 |
| `src/renderer/src/composables/useAppChapterNavigation.ts` | `isChapterBlocked` 依赖、应用层过滤（复用 chapterBlock 纯函数）、`reapplyChapterBlockFilter` |
| `src/renderer/src/components/ChapterListPanel.vue` | 章节行右键菜单 + 已屏蔽折叠区 + block/unblock 事件与样式 |
| `src/renderer/src/components/ReaderSidebar.vue` | 从 meta 解析当前文件屏蔽列表透传 + 事件转发 |
| `src/renderer/src/App.vue` | `isCurrentChapterBlocked` / `onBlockChapter` / `onUnblockChapter` + chapterNav 依赖 + 事件挂载 + Web 桥接注入 blockedChapters |
| `src/renderer/src/components/ReaderMain.vue` | Web 内容链路 `buildChapterList` 屏蔽过滤（缓存存全量、输出时过滤）+ 4 个 expose 透传 |

## 12. 章节正则规则三态开关（禁用 / 全局开启 / 仅当前书籍）— 2026-10-26 新增

### 12.1 行为

- 规则面板（ChapterRulePanel）每行最前面的开关由滑动开关改为**三色循环按钮**，循环顺序：`关`（灰，禁用）→ `本书`（橙 #d97706，仅当前书籍生效）→ `开`（accent 色，全局启用）→ `关`。三个转换的动作语义（2026-10-26 拍板）：**切到「关」清两个状态**（全局 enabled=false + 清本书 id）；**切到「开」**设置全局启用（enabled=true）+ 清理本书单独开状态（清 id）；**切到「本书」**清理全局启用（enabled=false）+ 设置本书 id。
- 「本书」态 = 全局列表该规则保持 `enabled=false`（其他书籍读到时即禁用态）+ 该规则 id 写入本书 meta 的专属集合。
- **合并展示时只切换开关状态**：面板里同一条全局规则只显示一行；行状态判定**全局启用优先**——`enabled=true` 一律显示「开」（含跨书产生的双真态：全局开 + 本书 id 残留），`enabled=false` 且 id 在本书专属集合显示「本书」（橙色 badge），否则「关」。规则**内容与顺序全部参照全局列表管理**（meta 不保存内容、不保存顺序）。
- 面板**合并展示顺序** = 全局规则列表顺序（本书规则在全局什么位置就在什么位置）；拖拽改全局列表顺序，本书规则跟随移动（拖拽有效果）。
- 其他书籍：读不到本书 meta 的 id 集合，该规则显示/生效均为禁用态；打开该书面板时全局列表的 disabled 条目恢复显示。
- 本书行/全局行的**编辑都直接改全局条目**（内容单源，改动对所有书可见）；「移除本书专属」（本书行删除按钮，含内置规则）= 只从 id 集合删除（规则条目保留，回到全局禁用态显示）；全局自定义行删除 = 从全局列表移除 + id 集合清理。
- 本书行的编辑/开关操作照常可用；拖拽手柄仅在非「本书」态行显示（本书态行位置 = 全局列表位置，不独立存在）。

### 12.2 数据结构

- **meta 只存 id**：`FileMetaRecord.scopedChapterRuleIds?: string[]` + `normalizeScopedChapterRuleIds`（字符串、trim 非空、去重、上限 50、空→undefined）+ upsert 保留链 + `setFileScopedChapterRuleIds` helper。`ChapterMatchRule` 类型不变，无新规则类型。
- `chapter.ts` 模块级上下文：`activeScopedRuleIds: Set<string>` + `setActiveScopedChapterRuleIds(ids?)`（重编译）。
- `rebuildEnabledRegexes(rules, scopedIds)`：按全局列表顺序遍历，**规则生效 = `enabled` 为真或 id 在本书专属集合中**（内容仍取全局条目），编译失败 throw（内容来自全局列表、面板编辑有即时校验）；**空列表允许**（去掉原「至少需要启用一条非空的匹配规则」throw——用户可把所有规则都设为仅本书）。`setChapterMatchRules` 仍保留「列表非空 + id 唯一」校验。

### 12.3 生效链路（零侵入设计）

- `detectChapterTitle` 及全部下游（`readerDisplayPipeline` 章节检测/缩进豁免、标注豁免、`useAppChapterNavigation` 三分支、ReaderMain `buildChapterList`）**零改动**——只读模块级 `enabledRegexList`，scoped 合并已在 rebuild 时完成。
- markdown 链路（`detectMarkdownHeading` ATX）与正则规则无关，不受影响。
- App.vue `watch(currentBookScopedChapterRuleIds)` → `setActiveScopedChapterRuleIds`（切书/meta 更新自动切换）。
- 规则保存：`@apply-chapter-rules` → App.vue 包装函数 `applyChapterMatchRules({ rules, scopedRuleIds })` → `setFileScopedChapterRuleIds` 写当前书 meta + `persistFileMeta()` + `setActiveScopedChapterRuleIds` → nav 原 `applyChapterMatchRulesFromNav({ rules })`（全局列表保存 + 章节表重建）。
- **Web 展示链路**：App.vue 4 个桥接（`__colorTxtGenerateColoredHtmlForText/ForSegment/HighlightLinesForText/GetFullText`）经 `withWebBridgeScopedRules(filePath, fn)` 临时切换到目标书 scoped → try/finally 恢复当前书（实时读 currentFile meta）。

### 12.4 陷阱（重写时必须保留）

1. **meta 只存 id，内容/顺序单源全局列表（用户拍板：不要保存具体内容与顺序，合并时只切换开关状态）**：本书态 = 全局条目 enabled=false + meta 记 id；面板同一条规则只显示一行。不要加回整条副本——副本会让编辑/拖拽双源漂移、拖拽失去对本书规则的效果。
2. **规则编译失败仍 throw（无静默跳过）**：规则内容全部来自全局列表（面板编辑有即时校验），meta 只存 id 不会产生无效规则；全局列表中出现无效正则时保存/切书即报错（模块初始化 try/catch 回退默认规则仍保留）。
3. **「至少启用一条」校验已放宽**：rebuild 允许空列表（全局全禁 + 本书无专属 = 无章节，合法形态）；但 `setChapterMatchRules` 仍拒绝空规则列表（面板无法保存 0 条规则）。
4. **合并展示顺序 = 全局列表顺序**（本书规则在全局什么位置就在什么位置，不固定尾部）：拖拽 moveRule 按 rows 索引→id→globalDraft 索引移动，本书规则跟随；本书态行无拖拽手柄（位置=全局同 id 条目位置，不独立存在）。
5. **规则被全局删除时 id 集合残留无害**：rebuild 只遍历全局列表，残留 id 匹配不到任何规则即自然失效；全局自定义行删除时同步清理 id 集合（面板内）。
6. **跨书双真态是有意特性（id 残留接力，2026-10-26 拍板）**：书 A「本书」态的规则被其他书切到「全局开」时**不清理书 A 的 id**（其他书操作只碰自己的 meta 集合）——书 A 显示「开」（全局启用优先）；将来任何书把该规则切回「关」（enabled=false）后，书 A 凭残留 id 自动回到「本书」态单独生效。只有本书自己的「切到关/切到开」动作才清理本书 id，且**清 id 范围永远限于当前书**：草稿只持当前书集合，保存经 `setFileScopedChapterRuleIds` → `upsertFileMetaRecord` 仅替换当前书 path 的记录（其他书记录原样保留）；行删除按钮按显示态分流（本书态=「移除本书专属」只清 id，关/开态=「移除」删全局条目+清 id）。
7. **Web 桥接 try/finally 恢复用「进入时捕获的 currentFile meta」**：桥接执行期间用户切书的竞态窗口极小且章节表瞬时偏差可自愈，不做加锁。
8. **「保存」按钮是唯一生效点**：三态切换按钮/编辑/拖拽均只改面板内草稿（globalRules/scopedIds）——循环中的清理动作（切到关清两状态、切到开清本书 id、切到本书清全局启用）同样只作用于草稿，点击切换全程不写 meta、不触发重检测、不持久化；点底部「保存」按钮才 emit → 写本书 meta + persist + 全局列表保存 + 章节表重建（生效点唯一）。关闭/esc/遮罩直接丢弃草稿。`props.scopedRuleIds` 变化（含打开面板时）经 `watch(..., deep)` 重置双源草稿，编辑中改动不回写 props。

### 12.5 涉及文件清单（§12）

| 文件 | 职责 |
|------|------|
| `src/renderer/src/chapter.ts` | `activeScopedRuleIds` 模块级 id 上下文（set/get）+ `rebuildEnabledRegexes` 合并生效（enabled 或 id 在集合，按全局序编译、空列表允许） |
| `src/renderer/src/stores/fileMetaStore.ts` | `scopedChapterRuleIds: string[]` 字段 + normalize/去重/上限 + upsert 保留链 + `setFileScopedChapterRuleIds` |
| `src/renderer/src/components/ChapterRulePanel.vue` | 三色循环按钮（关→本书→全局开循环；切关双清/切开清 id/切本书清全局+置 id；行状态全局启用优先显示）+ globalRules/scopedIds 双源草稿 + 合并展示（同一条规则一行只切开关状态、顺序=全局列表）+ apply emit `{ rules, scopedRuleIds }` |
| `src/renderer/src/components/AppOverlays.vue` | `scopedChapterRuleIds` prop 透传 + apply payload 类型扩展 |
| `src/renderer/src/App.vue` | `currentBookScopedChapterRuleIds` computed + watch setActive + apply 包装（写 meta + persist）+ `withWebBridgeScopedRules` 4 桥接切换/恢复 |
