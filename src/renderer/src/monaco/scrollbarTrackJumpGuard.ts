import type { editor } from "monaco-editor";

/**
 * 拦截 Monaco 滚动条轨道点击跳转，保留滑块拖动。
 *
 * Monaco 在 `.scrollbar` 节点上监听 bubble 阶段 `pointerdown`；
 * 仅当 `target ===` 轨道节点时才跳转（滑块有独立监听）。
 * 须在更外层捕获并用 `stopImmediatePropagation`，否则事件仍会到达轨道节点。
 */
export function bindMonacoScrollbarTrackJumpGuard(
  ed: editor.ICodeEditor,
  isEnabled: () => boolean,
  /** 建议用 `editorHost`：比 `getDomNode()` 更外，且与其它阅读器捕获一致 */
  listenRoot?: HTMLElement | null,
): () => void {
  const root = listenRoot ?? ed.getDomNode();
  if (!root) return () => {};

  const onPointerDownCapture = (e: PointerEvent) => {
    if (!isEnabled()) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // 轨道：`.scrollbar`；滑块：`.slider`（可在轨道内）
    const track = t.closest(".monaco-scrollable-element > .scrollbar");
    if (!track || !root.contains(track)) return;
    if (t.closest(".slider")) return;

    const scrollTop = ed.getScrollTop();
    const scrollLeft = ed.getScrollLeft();
    e.preventDefault();
    e.stopImmediatePropagation();

    // 兜底：若仍有路径改了滚动位置，下一帧拉回
    requestAnimationFrame(() => {
      if (!isEnabled()) return;
      if (ed.getScrollTop() !== scrollTop || ed.getScrollLeft() !== scrollLeft) {
        ed.setScrollTop(scrollTop);
        ed.setScrollLeft(scrollLeft);
      }
    });
  };

  root.addEventListener("pointerdown", onPointerDownCapture, true);
  return () => {
    root.removeEventListener("pointerdown", onPointerDownCapture, true);
  };
}
