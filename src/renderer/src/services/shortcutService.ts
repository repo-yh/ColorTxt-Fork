export type AppShortcutActions = {
  openSettings: () => void | Promise<void>;
  openColorScheme: () => void | Promise<void>;
  openFindBook: () => void | Promise<void>;
  openBookSource: () => void | Promise<void>;
  toggleFullscreen: () => void | Promise<void>;
  increaseFontSize: () => void | Promise<void>;
  decreaseFontSize: () => void | Promise<void>;
  increaseLineHeight: () => void | Promise<void>;
  decreaseLineHeight: () => void | Promise<void>;
  toggleSidebar: () => void | Promise<void>;
  openNewWindow: () => void | Promise<void>;
  openFile: () => void | Promise<void>;
  pickTxtDirectory: () => void | Promise<void>;
  openChapterRules: () => void | Promise<void>;
  toggleBookmark: () => void | Promise<void>;
  jumpToPrevChapter: () => void | Promise<void>;
  jumpToNextChapter: () => void | Promise<void>;
  toggleFind: () => void | Promise<void>;
  openSidebarSearch: () => void | Promise<void>;
  toggleReaderEdit: () => void | Promise<void>;
  editSelectedText: () => void | Promise<void>;
  scrollDownLine: () => void | Promise<void>;
  scrollUpLine: () => void | Promise<void>;
  scrollPageUp: () => void | Promise<void>;
  scrollPageDown: () => void | Promise<void>;
};

import type { ShortcutBindingMap } from "./shortcutRegistry";
import { keyboardEventToAccelerator, normalizeAccelerator } from "./shortcutUtils";

type ActionKey = keyof AppShortcutActions;

const ACTION_BY_ID: Record<string, ActionKey> = {
  openFile: "openFile",
  pickTxtDirectory: "pickTxtDirectory",
  scrollDownLine: "scrollDownLine",
  scrollUpLine: "scrollUpLine",
  scrollPageUp: "scrollPageUp",
  scrollPageDown: "scrollPageDown",
  jumpPrevChapter: "jumpToPrevChapter",
  jumpNextChapter: "jumpToNextChapter",
  decreaseFontSize: "decreaseFontSize",
  increaseFontSize: "increaseFontSize",
  decreaseLineHeight: "decreaseLineHeight",
  increaseLineHeight: "increaseLineHeight",
  toggleFind: "toggleFind",
  openSidebarSearch: "openSidebarSearch",
  toggleReaderEdit: "toggleReaderEdit",
  editSelectedText: "editSelectedText",
  openChapterRules: "openChapterRules",
  toggleBookmark: "toggleBookmark",
  toggleSidebar: "toggleSidebar",
  toggleFullscreen: "toggleFullscreen",
  openSettings: "openSettings",
  openColorScheme: "openColorScheme",
  openFindBook: "openFindBook",
  openBookSource: "openBookSource",
  openNewWindow: "openNewWindow",
};

/** 编辑模式下焦点在 Monaco 内时，应交给编辑器处理的窗口快捷键（滚屏/查找等） */
export const EDIT_MODE_MONACO_DEFERRED_ACTIONS: ReadonlySet<ActionKey> =
  new Set([
    "scrollDownLine",
    "scrollUpLine",
    "scrollPageUp",
    "scrollPageDown",
    "toggleFind",
  ]);

/** 语音朗读播放中：仍吞掉行滚/页滚/章节跳转/查找；空格与左右由朗读键接管 */
export const VOICE_READ_SCROLL_BLOCKED_ACTIONS: ReadonlySet<ActionKey> =
  new Set([
    "scrollDownLine",
    "scrollUpLine",
    "scrollPageUp",
    "scrollPageDown",
    "jumpToPrevChapter",
    "jumpToNextChapter",
    "toggleFind",
  ]);

export type VoiceReadReaderKeyHandlers = {
  isActive: () => boolean;
  togglePlayPause: () => void;
  playPrevLine: () => void;
  playNextLine: () => void;
};

export type VoiceReadReaderKeyKind = "toggle" | "prev" | "next";

/** 朗读态：空格暂停/播放，左右换行（无修饰键） */
export function voiceReadReaderKeyKind(
  ev: KeyboardEvent,
): VoiceReadReaderKeyKind | null {
  if (ev.isComposing || ev.keyCode === 229) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return null;
  if (ev.key === " " || ev.code === "Space") return "toggle";
  if (ev.key === "ArrowLeft") return "prev";
  if (ev.key === "ArrowRight") return "next";
  return null;
}

/** 查找栏、音量滑块、备注框等：不要抢走空格/方向键 */
function keyboardEventBlocksVoiceReadRemap(ev: KeyboardEvent): boolean {
  const t = ev.target;
  if (!(t instanceof Element)) return false;
  if (t.closest(".find-widget")) return true;
  if (t.closest(".monaco-editor")) return false;
  if (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLButtonElement
  ) {
    return true;
  }
  if (t instanceof HTMLElement && t.isContentEditable) return true;
  const role = t.getAttribute("role");
  return role === "slider" || role === "spinbutton" || role === "textbox";
}

function dispatchVoiceReadReaderKey(
  kind: VoiceReadReaderKeyKind,
  handlers: VoiceReadReaderKeyHandlers,
): void {
  if (kind === "toggle") handlers.togglePlayPause();
  else if (kind === "prev") handlers.playPrevLine();
  else handlers.playNextLine();
}

export function bindAppShortcuts(
  actions: AppShortcutActions,
  getBindings: () => ShortcutBindingMap,
  shouldHandleEvent?: (ev: KeyboardEvent) => boolean,
  shouldDeferAction?: (action: ActionKey, ev: KeyboardEvent) => boolean,
  shouldConsumeAction?: (action: ActionKey, ev: KeyboardEvent) => boolean,
  voiceReadReaderKeys?: VoiceReadReaderKeyHandlers,
): () => void {
  const onShortcutKeyDown = (ev: KeyboardEvent) => {
    if (shouldHandleEvent && !shouldHandleEvent(ev)) return;
    if (voiceReadReaderKeys?.isActive()) {
      const kind = voiceReadReaderKeyKind(ev);
      if (kind && !keyboardEventBlocksVoiceReadRemap(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) dispatchVoiceReadReaderKey(kind, voiceReadReaderKeys);
        return;
      }
    }
    const eventAccel = keyboardEventToAccelerator(ev);
    if (!eventAccel) return;
    const bindings = getBindings();
    let matchedAction: ActionKey | null = null;
    for (const [actionId, binding] of Object.entries(bindings)) {
      const normalized = normalizeAccelerator(binding);
      if (!normalized || normalized !== eventAccel) continue;
      const actionKey = ACTION_BY_ID[actionId];
      if (!actionKey) continue;
      matchedAction = actionKey;
      break;
    }
    if (!matchedAction) return;
    if (shouldConsumeAction?.(matchedAction, ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (shouldDeferAction?.(matchedAction, ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    void actions[matchedAction]();
  };

  window.addEventListener("keydown", onShortcutKeyDown, true);
  return () => window.removeEventListener("keydown", onShortcutKeyDown, true);
}
