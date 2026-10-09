# Monaco 搜索框（find-widget）机制

> 整理自 find-widget 系列调试记忆（2026-06 ~ 2026-07）。实现位置：`src/renderer/src/components/ReaderMain.vue`、`readerMainMonaco.css`。

## 打开/关闭动画

- 打开从上往下滑入，关闭从上往下滑回
- 动画由 **Monaco 内部 JS 控制**，项目代码无任何 CSS transition/animation
- Monaco 关闭搜索框用 `visibility: hidden` 而非移除 DOM，且 `onDidBeginSearch`/`onDidEndSearch` API 不存在——因此 **MutationObserver 监听不到**，显式调用是最可靠方案

## 动态偏移：setFindWidgetOffset（最终方案）

阅读器 overlay 模式下 find-widget 默认贴容器顶部被顶栏遮挡：

```ts
function setFindWidgetOffset(pixels: number) {
  const widget = editor.value?.getContainerDomNode()?.querySelector('.find-widget');
  if (widget) (widget as HTMLElement).style.top = pixels ? pixels + 'px' : '';
}
```

- 打开时 48px，关闭时清除（恢复原位，保留 Monaco 内部动画）
- **CSS `!important` 方案已废弃**：偏移永久生效、无法区分开/关状态、阻止内部动画、关闭时仍占 48px
- **已知风险**：JS 方案依赖显式调用清零，Monaco 关闭路径多（ESC、点击外部、失焦、找到自动关闭等）无法 100% 覆盖；若出现偏移残留，可回归 CSS 永久偏移（牺牲动画换可靠）

**调用路径（6 处）**：`toggleFindWidget` 开/关分支、`openFindWithSearchStringAsync`（48）、`closeFindWidgetIfReveal` 与 `clear()`（0）、`jumpToNextInlineSearchMatch`（内联搜索打开后关闭搜索框，0）。

## toggleFindWidget 完整逻辑

通过 `e.getContribution("editor.contrib.findController")` 取查找控制器，`getState().isRevealed` 判状态：

- **关闭分支**：`setFindWidgetOffset(0)` → `findCtrl.closeFindWidget()`
- **打开分支**：`inlineSearch.clearInlineSearchDecorations()` → `props.beforeRevealFindWidget?.()` → `e.getAction("actions.find")?.run()` → `setFindWidgetOffset(48)`

对外暴露（defineExpose）：`setInlineSearchStateWithOffset` / `clearInlineSearchStateWithOffset` / `jumpToNextInlineSearchMatch`。

CSS：`.find-widget` 整体及子元素 `user-select: none !important`（输入框恢复 `user-select: text`）。

## tooltip 显示在按钮下方

Monaco 不用原生 `title`，自建 `.monaco-tooltip` 元素 JS 动态定位（默认在按钮上方）：

```css
.monaco-tooltip { margin-top: calc(100% + 8px) !important; }
```

`!important` 覆盖内联样式；全局生效（目前只关心搜索框按钮）。可放 `readerMainMonaco.css` 或组件 `<style>`。

## beforeRevealFindWidget 书钉钩子

搜索框打开前执行的回调，当前实现**自动点亮书钉**（记录滚动位置，搜索后可回跳）：

```
快捷键 Ctrl+F（shortcutRegistry.ts，toggleFind）
  → useAppWindowBindings.ts 窗口快捷键处理
  → App.vue :before-reveal-find-widget="ensurePinBeforeRevealFindWidget"
  → ReaderMain.vue props.beforeRevealFindWidget?.()
  → useAppBookmarkPins.ts ensurePinBeforeRevealFindWidget()
     （pinnedScrollTop 已有值或不可钉则跳过，否则记录 getScrollTop()）
```
