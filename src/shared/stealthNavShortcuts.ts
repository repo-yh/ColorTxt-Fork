/** 摸鱼翻页/切章全局快捷键（主进程注册用；与渲染设置字段对齐）。 */

export type StealthNavShortcutId =
  | "pagePrev"
  | "pageNext"
  | "chapterPrev"
  | "chapterNext";

export type StealthNavShortcutMap = Record<StealthNavShortcutId, string>;

export const DEFAULT_STEALTH_NAV_SHORTCUTS: StealthNavShortcutMap = {
  pagePrev: "Control+Up",
  pageNext: "Control+Down",
  chapterPrev: "Control+Left",
  chapterNext: "Control+Right",
};

export const STEALTH_NAV_SHORTCUT_IDS: readonly StealthNavShortcutId[] = [
  "pagePrev",
  "pageNext",
  "chapterPrev",
  "chapterNext",
] as const;

export function normalizeStealthNavShortcuts(
  raw: unknown,
): StealthNavShortcutMap {
  const out: StealthNavShortcutMap = { ...DEFAULT_STEALTH_NAV_SHORTCUTS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const id of STEALTH_NAV_SHORTCUT_IDS) {
    const v = o[id];
    if (typeof v === "string" && v.trim()) out[id] = v.trim();
  }
  return out;
}
