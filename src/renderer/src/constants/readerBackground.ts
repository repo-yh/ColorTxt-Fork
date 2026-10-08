/**
 * 阅读区背景图：图库状态、叠层解析与 CSS。
 * 内置图目录只从 `readerBuiltins/textures.ts` 引入，本文件不再转导出。
 */
import { READER_BACKGROUND_SUBDIR } from "@shared/readerBackground";
import { joinFs } from "../ebook/pathUtils";
import {
  READER_BACKGROUND_NONE_ID,
  RETIRED_BUILTIN_TEXTURE_IDS,
  getBuiltinReaderTexture,
  isBuiltinReaderTextureId,
  resolveBuiltinReaderTextureUrl,
} from "./readerBuiltins/textures";

export type ReaderBackgroundSize = "auto" | "cover" | "contain";

export const READER_BACKGROUND_BLEND_OPTIONS = [
  { id: "normal", label: "正常" },
  { id: "multiply", label: "正片叠底" },
  { id: "lighten", label: "变亮" },
  { id: "overlay", label: "叠加" },
  { id: "soft-light", label: "柔光" },
  { id: "screen", label: "滤色" },
  { id: "darken", label: "变暗" },
] as const;

export const READER_BACKGROUND_SIZE_OPTIONS = [
  { id: "cover", label: "填满" },
  { id: "contain", label: "包含" },
  { id: "auto", label: "原始" },
] as const;

export type ReaderBackgroundBlend =
  (typeof READER_BACKGROUND_BLEND_OPTIONS)[number]["id"];

export const READER_BACKGROUND_POSITIONS = [
  "left top",
  "center top",
  "right top",
  "left center",
  "center center",
  "right center",
  "left bottom",
  "center bottom",
  "right bottom",
] as const;

export type ReaderBackgroundPosition =
  (typeof READER_BACKGROUND_POSITIONS)[number];

export type ReaderBackgroundThemeSide = "light" | "dark";

export function readerBackgroundThemeSide(
  theme: string,
): ReaderBackgroundThemeSide {
  return theme === "vs-dark" ? "dark" : "light";
}

/** 单张背景图的叠层调节 */
export type ReaderBackgroundLayerSettings = {
  opacity: number;
  size: ReaderBackgroundSize;
  position: ReaderBackgroundPosition;
  repeat: boolean;
  blend: ReaderBackgroundBlend;
};

/** 同一张图亮/暗各一套叠层 */
export type ReaderBackgroundThemeSettings = {
  light: ReaderBackgroundLayerSettings;
  dark: ReaderBackgroundLayerSettings;
};

export type ReaderCustomBackground = {
  id: string;
  name: string;
  fileName: string;
  light: ReaderBackgroundLayerSettings;
  dark: ReaderBackgroundLayerSettings;
};

export type ReaderBackgroundState = {
  /** 是否叠背景图；亮暗共用。关时保留所选图但不显示。 */
  enabled: boolean;
  custom: ReaderCustomBackground[];
};

export const DEFAULT_READER_BACKGROUND_OPACITY = 1;
export const DEFAULT_READER_BACKGROUND_SIZE: ReaderBackgroundSize = "cover";
export const DEFAULT_READER_BACKGROUND_POSITION: ReaderBackgroundPosition =
  "right top";
export const DEFAULT_READER_BACKGROUND_REPEAT = false;
export const DEFAULT_READER_BACKGROUND_BLEND: ReaderBackgroundBlend = "normal";

export const defaultReaderBackgroundLayerSettings: ReaderBackgroundLayerSettings =
  {
    opacity: DEFAULT_READER_BACKGROUND_OPACITY,
    size: DEFAULT_READER_BACKGROUND_SIZE,
    position: DEFAULT_READER_BACKGROUND_POSITION,
    repeat: DEFAULT_READER_BACKGROUND_REPEAT,
    blend: DEFAULT_READER_BACKGROUND_BLEND,
  };

export const defaultReaderBackgroundThemeSettings: ReaderBackgroundThemeSettings =
  {
    light: { ...defaultReaderBackgroundLayerSettings },
    dark: { ...defaultReaderBackgroundLayerSettings },
  };

export const defaultReaderBackgroundState: ReaderBackgroundState = {
  enabled: true,
  custom: [],
};

export function isReaderBackgroundSize(v: unknown): v is ReaderBackgroundSize {
  return v === "auto" || v === "cover" || v === "contain";
}

const POSITION_SET = new Set<string>(READER_BACKGROUND_POSITIONS);

export function isReaderBackgroundPosition(
  v: unknown,
): v is ReaderBackgroundPosition {
  return typeof v === "string" && POSITION_SET.has(v);
}

const BLEND_SET = new Set<string>(
  READER_BACKGROUND_BLEND_OPTIONS.map((o) => o.id),
);

export function isReaderBackgroundBlend(
  v: unknown,
): v is ReaderBackgroundBlend {
  return typeof v === "string" && BLEND_SET.has(v);
}

export function clampReaderBackgroundOpacity(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_READER_BACKGROUND_OPACITY;
  const stepped = Math.round(n / 0.05) * 0.05;
  return Math.min(1, Math.max(0, Number(stepped.toFixed(2))));
}

function parseCustomItem(raw: unknown): ReaderCustomBackground | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.fileName !== "string") return null;
  const id = o.id.trim();
  const fileName = o.fileName.trim();
  if (!id || !fileName) return null;
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  const name =
    typeof o.name === "string" && o.name.trim() ? o.name.trim() : id;
  const { light, dark } = parseReaderBackgroundThemeSettings(
    o,
    defaultReaderBackgroundThemeSettings,
  );
  return { id, name, fileName, light, dark };
}

export function parseReaderCustomBackgrounds(
  raw: unknown,
): ReaderCustomBackground[] {
  if (!Array.isArray(raw)) return [];
  const out: ReaderCustomBackground[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = parseCustomItem(item);
    if (!parsed || seen.has(parsed.id) || isBuiltinReaderTextureId(parsed.id)) {
      continue;
    }
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

export function cloneReaderBackgroundLayerSettings(
  raw: ReaderBackgroundLayerSettings,
): ReaderBackgroundLayerSettings {
  return parseReaderBackgroundLayerSettings(raw);
}

export function cloneReaderBackgroundThemeSettings(
  raw: ReaderBackgroundThemeSettings,
): ReaderBackgroundThemeSettings {
  return {
    light: cloneReaderBackgroundLayerSettings(raw.light),
    dark: cloneReaderBackgroundLayerSettings(raw.dark),
  };
}

export function cloneReaderCustomBackground(
  c: ReaderCustomBackground,
): ReaderCustomBackground {
  return {
    id: c.id,
    name: c.name,
    fileName: c.fileName,
    ...cloneReaderBackgroundThemeSettings(c),
  };
}

export function makeReaderCustomBackground(
  id: string,
  name: string,
  fileName: string,
  pair?: ReaderBackgroundThemeSettings | null,
): ReaderCustomBackground {
  return {
    id,
    name,
    fileName,
    ...parseReaderBackgroundThemeSettings(pair),
  };
}

export function newReaderCustomBackgroundId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseReaderTextureId(raw: unknown): string {
  const id = typeof raw === "string" && raw.trim() ? raw.trim() : "";
  if (!id) return READER_BACKGROUND_NONE_ID;
  if (
    id.length >= 80 ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    RETIRED_BUILTIN_TEXTURE_IDS.has(id)
  ) {
    return READER_BACKGROUND_NONE_ID;
  }
  return id;
}

export function parseTextureIdFromPaletteRaw(raw: unknown): string {
  if (!raw || typeof raw !== "object") return READER_BACKGROUND_NONE_ID;
  return parseReaderTextureId((raw as Record<string, unknown>).textureId);
}

export function resolveReaderTextureIdForTheme(
  theme: string,
  lightTextureId: string | undefined,
  darkTextureId: string | undefined,
): string {
  return parseReaderTextureId(
    theme === "vs-dark" ? darkTextureId : lightTextureId,
  );
}

export function parseReaderBackgroundLayerSettings(
  raw: unknown,
  fallback: ReaderBackgroundLayerSettings = defaultReaderBackgroundLayerSettings,
): ReaderBackgroundLayerSettings {
  if (!raw || typeof raw !== "object") {
    return { ...fallback };
  }
  const o = raw as Record<string, unknown>;
  return {
    opacity: clampReaderBackgroundOpacity(
      typeof o.opacity === "number" ? o.opacity : fallback.opacity,
    ),
    size: isReaderBackgroundSize(o.size) ? o.size : fallback.size,
    position: isReaderBackgroundPosition(o.position)
      ? o.position
      : fallback.position,
    repeat:
      typeof o.repeat === "boolean" ? o.repeat : fallback.repeat,
    blend: isReaderBackgroundBlend(o.blend) ? o.blend : fallback.blend,
  };
}

export function parseReaderBackgroundThemeSettings(
  raw: unknown,
  fallback: ReaderBackgroundThemeSettings = defaultReaderBackgroundThemeSettings,
): ReaderBackgroundThemeSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      light: { ...fallback.light },
      dark: { ...fallback.dark },
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    light: parseReaderBackgroundLayerSettings(o.light, fallback.light),
    dark: parseReaderBackgroundLayerSettings(o.dark, fallback.dark),
  };
}

export function defaultReaderBackgroundLayerSettingsForId(
  textureId: string,
  side: ReaderBackgroundThemeSide,
): ReaderBackgroundLayerSettings {
  const builtin = getBuiltinReaderTexture(textureId);
  const fromBuiltin = builtin?.[side];
  if (fromBuiltin) {
    return parseReaderBackgroundLayerSettings(fromBuiltin);
  }
  return { ...defaultReaderBackgroundLayerSettings };
}

export function defaultReaderBackgroundThemeSettingsForId(
  textureId: string,
): ReaderBackgroundThemeSettings {
  return {
    light: defaultReaderBackgroundLayerSettingsForId(textureId, "light"),
    dark: defaultReaderBackgroundLayerSettingsForId(textureId, "dark"),
  };
}

export function parseReaderBackgroundState(raw: unknown): ReaderBackgroundState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      enabled: true,
      custom: [],
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled !== false,
    custom: parseReaderCustomBackgrounds(o.custom),
  };
}

export function cloneReaderBackgroundState(
  state: ReaderBackgroundState,
): ReaderBackgroundState {
  return parseReaderBackgroundState(state);
}

export function mergeReaderBackgroundGallery(
  existing: ReaderBackgroundState,
  incoming: {
    custom?: readonly ReaderCustomBackground[];
  },
): ReaderBackgroundState {
  const byId = new Map(
    existing.custom.map((c) => [c.id, cloneReaderCustomBackground(c)]),
  );
  for (const c of incoming.custom ?? []) {
    byId.set(c.id, cloneReaderCustomBackground(c));
  }
  return cloneReaderBackgroundState({
    ...existing,
    custom: [...byId.values()],
  });
}

export function isReaderBackgroundEnabled(
  state: ReaderBackgroundState,
): boolean {
  return state.enabled !== false;
}

export function resolveReaderBackgroundThemeSettings(
  state: ReaderBackgroundState,
  textureId: string,
): ReaderBackgroundThemeSettings {
  const fallback = defaultReaderBackgroundThemeSettingsForId(textureId);
  const custom = state.custom.find((c) => c.id === textureId);
  if (custom) {
    return parseReaderBackgroundThemeSettings(custom, fallback);
  }
  return fallback;
}

export function resolveReaderBackgroundLayerSettings(
  state: ReaderBackgroundState,
  textureId: string,
  side: ReaderBackgroundThemeSide,
): ReaderBackgroundLayerSettings {
  return cloneReaderBackgroundLayerSettings(
    resolveReaderBackgroundThemeSettings(state, textureId)[side],
  );
}

export function patchReaderBackgroundLayerSettings(
  state: ReaderBackgroundState,
  textureId: string,
  side: ReaderBackgroundThemeSide,
  patch: Partial<ReaderBackgroundLayerSettings>,
): ReaderBackgroundState {
  const themes = resolveReaderBackgroundThemeSettings(state, textureId);
  const nextLayer = parseReaderBackgroundLayerSettings({
    ...themes[side],
    ...patch,
  });
  const nextThemes: ReaderBackgroundThemeSettings = {
    ...themes,
    [side]: nextLayer,
  };
  const customIdx = state.custom.findIndex((c) => c.id === textureId);
  if (customIdx < 0) return state;
  const custom = [...state.custom];
  const item = custom[customIdx]!;
  custom[customIdx] = { ...item, ...nextThemes };
  return { ...state, custom };
}

export function copyReaderBackgroundSettingsToId(
  state: ReaderBackgroundState,
  fromId: string,
  toId: string,
): ReaderBackgroundState {
  if (!fromId || !toId || fromId === toId) return state;
  const themes = resolveReaderBackgroundThemeSettings(state, fromId);
  const customIdx = state.custom.findIndex((c) => c.id === toId);
  if (customIdx < 0) return state;
  const custom = [...state.custom];
  const item = custom[customIdx]!;
  custom[customIdx] = {
    ...item,
    ...cloneReaderBackgroundThemeSettings(themes),
  };
  return { ...state, custom };
}

export function serializeReaderBackgroundState(
  state: ReaderBackgroundState,
): ReaderBackgroundState {
  return parseReaderBackgroundState(state);
}

export function readerBackgroundCustomAbs(fileName: string): string {
  const ud = window.colorTxt.getUserDataPath();
  return joinFs(ud, READER_BACKGROUND_SUBDIR, fileName);
}

/**
 * 「原始」=`background-size: auto` 时 1 图像素 = 1 CSS 像素。
 * 系统 DPI / 窗口缩放下 CSS 像素大于屏幕像素，图会被放大。
 * 用 image-set 把当前 `devicePixelRatio` 标成图的密度，使 1 图像素 = 1 屏幕像素。
 */
export function readerBackgroundImageCssForSize(
  imageCss: string,
  size: ReaderBackgroundSize,
): string {
  if (!imageCss || imageCss === "none" || size !== "auto") return imageCss;
  const raw = window.devicePixelRatio;
  const dpr = Number.isFinite(raw) && raw > 0 ? raw : 1;
  if (Math.abs(dpr - 1) < 0.02) return imageCss;
  return `image-set(${imageCss} ${dpr}x)`;
}

let lastReaderBackgroundApply: {
  theme: string;
  state: ReaderBackgroundState;
  textureId: string;
} | null = null;
let readerBackgroundDprMql: MediaQueryList | null = null;

function onReaderBackgroundDprChange() {
  subscribeReaderBackgroundDprWatch();
  const last = lastReaderBackgroundApply;
  if (!last) return;
  void applyReaderBackgroundToDocument(last.theme, last.state, last.textureId);
}

function subscribeReaderBackgroundDprWatch() {
  readerBackgroundDprMql?.removeEventListener(
    "change",
    onReaderBackgroundDprChange,
  );
  readerBackgroundDprMql = window.matchMedia(
    `(resolution: ${window.devicePixelRatio || 1}dppx)`,
  );
  readerBackgroundDprMql.addEventListener("change", onReaderBackgroundDprChange);
}

/** 预览区 / 方案卡片叠层内联样式（与阅读器 CSS 变量语义一致） */
export function readerBackgroundOverlayStyle(
  url: string,
  layer: ReaderBackgroundLayerSettings,
  options?: { originalAsContain?: boolean },
): Record<string, string> {
  const size =
    options?.originalAsContain && layer.size === "auto"
      ? "contain"
      : layer.size;
  const imageCss = `url("${url}")`;
  return {
    backgroundImage: readerBackgroundImageCssForSize(imageCss, size),
    backgroundSize: size,
    backgroundPosition: layer.position,
    backgroundRepeat: layer.repeat ? "repeat" : "no-repeat",
    opacity: String(layer.opacity),
    mixBlendMode: layer.blend,
  };
}

export function readerBackgroundPreviewUrl(
  textureId: string,
  customUrlById: Record<string, string>,
): string {
  if (!textureId || textureId === READER_BACKGROUND_NONE_ID) return "";
  const builtin = getBuiltinReaderTexture(textureId);
  if (builtin) return resolveBuiltinReaderTextureUrl(builtin.url);
  return customUrlById[textureId] ?? "";
}

export async function resolveReaderBackgroundImageCss(
  state: ReaderBackgroundState,
  textureId: string,
): Promise<string> {
  const id = parseReaderTextureId(textureId);
  if (!id || id === READER_BACKGROUND_NONE_ID) return "none";
  const builtin = getBuiltinReaderTexture(id);
  if (builtin) {
    const href = resolveBuiltinReaderTextureUrl(builtin.url);
    return href ? `url("${href}")` : "none";
  }
  const custom = state.custom.find((c) => c.id === id);
  if (!custom) return "none";
  try {
    const abs = readerBackgroundCustomAbs(custom.fileName);
    const url = await colortxtLocalUrlWithSize(abs);
    if (!url) return "none";
    return `url("${url}")`;
  } catch {
    return "none";
  }
}

async function colortxtLocalUrlWithSize(abs: string): Promise<string | null> {
  const url = await window.colorTxt.pathToReadableLocalUrl(abs);
  if (!url) return null;
  const st = await window.colorTxt.stat(abs);
  if (!st.isFile) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}s=${st.size}`;
}

export async function resolveCustomBackgroundPreviewUrl(
  fileName: string,
): Promise<string | null> {
  try {
    const abs = readerBackgroundCustomAbs(fileName);
    return await colortxtLocalUrlWithSize(abs);
  } catch {
    return null;
  }
}

/**
 * 将阅读区背景图变量写入 `document.documentElement`。
 * 仅阅读区容器使用 `.readerSurfaceBg::before` 消费这些变量。
 */
export async function applyReaderBackgroundForPalettes(
  theme: string,
  state: ReaderBackgroundState,
  light: { textureId?: string },
  dark: { textureId?: string },
): Promise<void> {
  return applyReaderBackgroundToDocument(
    theme,
    state,
    resolveReaderTextureIdForTheme(theme, light.textureId, dark.textureId),
  );
}

export async function applyReaderBackgroundToDocument(
  theme: string,
  state: ReaderBackgroundState = defaultReaderBackgroundState,
  textureId: string = READER_BACKGROUND_NONE_ID,
): Promise<void> {
  lastReaderBackgroundApply = { theme, state, textureId };
  subscribeReaderBackgroundDprWatch();
  const root = document.documentElement;
  const overlayOff = !isReaderBackgroundEnabled(state);
  const image = overlayOff
    ? "none"
    : await resolveReaderBackgroundImageCss(state, textureId);
  const isNone = image === "none";
  const layer = resolveReaderBackgroundLayerSettings(
    state,
    textureId,
    readerBackgroundThemeSide(theme),
  );
  const imageCss = isNone
    ? "none"
    : readerBackgroundImageCssForSize(image, layer.size);
  root.style.setProperty("--reader-bg-image", imageCss);
  root.style.setProperty(
    "--reader-bg-image-opacity",
    isNone ? "0" : String(layer.opacity),
  );
  root.style.setProperty("--reader-bg-image-size", layer.size);
  root.style.setProperty("--reader-bg-image-position", layer.position);
  root.style.setProperty(
    "--reader-bg-image-repeat",
    layer.repeat ? "repeat" : "no-repeat",
  );
  root.style.setProperty("--reader-bg-image-blend", layer.blend);
  scheduleReaderBackgroundStickyAlign();
}

/** 实际绘制纹理的最外层 `.readerSurfaceBg`（全屏/极简时内层不再叠图）。 */
export function outermostReaderSurfaceEl(
  from: Element | null,
): HTMLElement | null {
  let found: HTMLElement | null = null;
  let n: HTMLElement | null =
    from instanceof HTMLElement ? from : from?.parentElement ?? null;
  while (n) {
    if (n.classList.contains("readerSurfaceBg")) found = n;
    n = n.parentElement;
  }
  return found;
}

/** 粘性条 `::before` 对齐阅读表面，使纹理与正文区同一张图。 */
export function syncReaderBackgroundStickyAlign(sticky: HTMLElement): void {
  const surface = outermostReaderSurfaceEl(sticky);
  if (!surface) return;
  const sr = surface.getBoundingClientRect();
  const wr = sticky.getBoundingClientRect();
  if (wr.width < 1 || wr.height < 1 || sr.width < 1 || sr.height < 1) return;
  sticky.style.setProperty(
    "--reader-bg-align-x",
    `${Math.round(sr.left - wr.left)}px`,
  );
  sticky.style.setProperty(
    "--reader-bg-align-y",
    `${Math.round(sr.top - wr.top)}px`,
  );
  sticky.style.setProperty(
    "--reader-bg-align-w",
    `${Math.round(sr.width)}px`,
  );
  sticky.style.setProperty(
    "--reader-bg-align-h",
    `${Math.round(sr.height)}px`,
  );
}

export function syncAllReaderBackgroundStickyAlign(): boolean {
  const widgets = document.querySelectorAll<HTMLElement>(
    ".readerPane .monaco-editor .sticky-widget",
  );
  let aligned = false;
  widgets.forEach((el) => {
    const wr = el.getBoundingClientRect();
    if (wr.width < 1 || wr.height < 1) return;
    syncReaderBackgroundStickyAlign(el);
    aligned = true;
  });
  return aligned;
}

let stickyAlignRaf = 0;
let stickyAlignAttempts = 0;
/** Monaco 粘性条常在大纲/布局之后才进 DOM，刷新后需多等几帧 */
const STICKY_ALIGN_RETRY_MAX = 32;

export function scheduleReaderBackgroundStickyAlign(): void {
  stickyAlignAttempts = 0;
  if (stickyAlignRaf) return;
  queueReaderBackgroundStickyAlign();
}

function queueReaderBackgroundStickyAlign(): void {
  const tick = () => {
    stickyAlignRaf = 0;
    if (syncAllReaderBackgroundStickyAlign()) {
      stickyAlignAttempts = 0;
      return;
    }
    stickyAlignAttempts += 1;
    if (stickyAlignAttempts > STICKY_ALIGN_RETRY_MAX) {
      stickyAlignAttempts = 0;
      return;
    }
    queueReaderBackgroundStickyAlign();
  };
  if (typeof requestAnimationFrame !== "function") {
    tick();
    return;
  }
  stickyAlignRaf = requestAnimationFrame(tick);
}
