import {
  clampLineHeightMultipleForFontSize,
  defaultCompressBlankKeepOneBlank,
  defaultCompressBlankLines,
  defaultChapterNavToolbarEnabled,
  defaultFullscreenReaderWidthPercent,
  defaultFullscreenShowSystemTime,
  defaultShowSidebar,
  defaultLeadIndentFullWidth,
  defaultMonacoAdvancedWrapping,
  defaultMonacoCustomHighlight,
  defaultMonacoSmoothScrolling,
  defaultMouseWheelScrollSensitivity,
  defaultFastScrollSensitivity,
  clampMouseWheelScrollSensitivity,
  clampFastScrollSensitivity,
  defaultReaderEditMinimap,
  defaultReaderEditShowLineNumbers,
  defaultReaderFontSize,
  defaultReaderLineHeightMultiple,
  defaultStickyChapterTitleEnabled,
  defaultTxtrDelimitedMatchCrossLine,
  FIND_BOOK_SIDEBAR_MIN_WIDTH,
  normalizeLineHeightMultiple,
  persistKey,
  SIDEBAR_ACTIVITY_BAR_WIDTH,
} from "../../constants/appUi";
import {
  defaultTimedScrollIntervalMs,
  defaultTimedScrollRange,
  mergeTimedScrollSettings,
  type TimedScrollSettings,
} from "../../constants/timedScroll";
import {
  mergePomodoroSettings,
  type PomodoroSettings,
} from "../../constants/pomodoro";
import { READER_EDITOR_DEFAULT_FONT_FAMILY } from "../../monaco/readerEditorOptions";
import {
  resolveDefaultBookSourceDownloadDirSync,
  resolveDefaultBookSourceChapterCacheDirSync,
} from "../../utils/defaultCacheDirs";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";
import {
  DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
  DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY,
  DEFAULT_FIND_BOOK_PROXY_SETTINGS,
  defaultFindBookShowChapterTag,
  findBookSettingsKey,
  isFindBookDownloadAfterAction,
  normalizeFindBookProxySettings,
  type FindBookDownloadAfterAction,
  type FindBookProxySettings,
  type PersistedFindBookSettings,
} from "../constants/findBookSettings";
import {
  loadPersistedSettingsData,
  type PersistedSettingsData,
} from "../../stores/cacheStore";

export { patchPersistedMainSettings } from "../../stores/cacheStore";

function safeParseFindBookSettings(raw: string | null): PersistedFindBookSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PersistedFindBookSettings;
  } catch {
    return {};
  }
}

function loadRawFindBookSettings(): PersistedFindBookSettings {
  try {
    return safeParseFindBookSettings(localStorage.getItem(findBookSettingsKey));
  } catch {
    return {};
  }
}

export function loadPersistedFindBookSettings(): PersistedFindBookSettings {
  return loadRawFindBookSettings();
}

/** 整份替换找书专属设置（去掉旧版阅读/编辑孤儿键） */
export function persistFindBookSettings(data: PersistedFindBookSettings) {
  try {
    localStorage.setItem(findBookSettingsKey, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function loadMainSettingsData(): PersistedSettingsData {
  return loadPersistedSettingsData(localStorage, persistKey)?.data ?? {};
}

export function snapshotFindBookOnlySettingsFromStore(state: {
  cacheDir: string;
  downloadDir: string;
  downloadAfterAction: FindBookDownloadAfterAction;
  downloadAddToMainFileList: boolean;
  downloadDefaultCategory: string;
  proxy: FindBookProxySettings;
  showSidebar: boolean;
  sidebarWidth: number;
  showChapterTag: boolean;
}): PersistedFindBookSettings {
  return {
    cacheDir: state.cacheDir.trim(),
    downloadDir: state.downloadDir.trim(),
    downloadAfterAction: state.downloadAfterAction,
    downloadAddToMainFileList: state.downloadAddToMainFileList,
    downloadDefaultCategory: state.downloadDefaultCategory.trim(),
    proxy: normalizeFindBookProxySettings(state.proxy),
    showSidebar: state.showSidebar,
    sidebarWidth: state.sidebarWidth,
    showChapterTag: state.showChapterTag,
  };
}

export type SharedReaderSettingsSnapshot = {
  readerFontSize: number;
  readerLineHeightMultiple: number;
  monacoFontFamily: string;
  pinnedOtherFonts: string[];
  monacoCustomHighlight: boolean;
  txtrDelimitedMatchCrossLine: boolean;
  compressBlankLines: boolean;
  compressBlankKeepOneBlank: boolean;
  leadIndentFullWidth: boolean;
  textConvertZh: TextConvertZhMode;
  textConvertLetter: TextConvertWidthMode;
  textConvertDigit: TextConvertWidthMode;
  monacoAdvancedWrapping: boolean;
  monacoSmoothScrolling: boolean;
  mouseWheelScrollSensitivity: number;
  fastScrollSensitivity: number;
  stickyChapterTitleEnabled: boolean;
  chapterNavToolbarEnabled: boolean;
  readerEditShowLineNumbers: boolean;
  readerEditMinimap: boolean;
  fullscreenReaderWidthPercent: number;
  fullscreenShowSystemTime: boolean;
  timedScrollSettings: TimedScrollSettings;
  pomodoroSettings: PomodoroSettings;
};

export function sharedReaderSettingsFromMainData(
  data: PersistedSettingsData,
): SharedReaderSettingsSnapshot {
  return {
    readerFontSize:
      typeof data.fontSize === "number" && Number.isFinite(data.fontSize)
        ? data.fontSize
        : defaultReaderFontSize,
    readerLineHeightMultiple:
      typeof data.lineHeightMultiple === "number"
        ? normalizeLineHeightMultiple(data.lineHeightMultiple)
        : normalizeLineHeightMultiple(defaultReaderLineHeightMultiple),
    monacoFontFamily:
      typeof data.fontFamily === "string" && data.fontFamily.trim()
        ? data.fontFamily.trim()
        : READER_EDITOR_DEFAULT_FONT_FAMILY,
    pinnedOtherFonts: Array.isArray(data.pinnedOtherFonts)
      ? data.pinnedOtherFonts.filter((f) => typeof f === "string" && f.trim())
      : [],
    monacoCustomHighlight:
      typeof data.monacoCustomHighlight === "boolean"
        ? data.monacoCustomHighlight
        : defaultMonacoCustomHighlight,
    txtrDelimitedMatchCrossLine:
      typeof data.txtrDelimitedMatchCrossLine === "boolean"
        ? data.txtrDelimitedMatchCrossLine
        : defaultTxtrDelimitedMatchCrossLine,
    compressBlankLines:
      typeof data.compressBlankLines === "boolean"
        ? data.compressBlankLines
        : defaultCompressBlankLines,
    compressBlankKeepOneBlank:
      typeof data.compressBlankKeepOneBlank === "boolean"
        ? data.compressBlankKeepOneBlank
        : defaultCompressBlankKeepOneBlank,
    leadIndentFullWidth:
      typeof data.leadIndentFullWidth === "boolean"
        ? data.leadIndentFullWidth
        : defaultLeadIndentFullWidth,
    textConvertZh: (data.textConvertZh as TextConvertZhMode | undefined) ?? "off",
    textConvertLetter:
      (data.textConvertLetter as TextConvertWidthMode | undefined) ?? "off",
    textConvertDigit:
      (data.textConvertDigit as TextConvertWidthMode | undefined) ?? "off",
    monacoAdvancedWrapping:
      typeof data.monacoAdvancedWrapping === "boolean"
        ? data.monacoAdvancedWrapping
        : defaultMonacoAdvancedWrapping,
    monacoSmoothScrolling:
      typeof data.monacoSmoothScrolling === "boolean"
        ? data.monacoSmoothScrolling
        : defaultMonacoSmoothScrolling,
    mouseWheelScrollSensitivity: clampMouseWheelScrollSensitivity(
      typeof data.mouseWheelScrollSensitivity === "number"
        ? data.mouseWheelScrollSensitivity
        : defaultMouseWheelScrollSensitivity,
    ),
    fastScrollSensitivity: clampFastScrollSensitivity(
      typeof data.fastScrollSensitivity === "number"
        ? data.fastScrollSensitivity
        : defaultFastScrollSensitivity,
    ),
    stickyChapterTitleEnabled:
      typeof data.stickyChapterTitleEnabled === "boolean"
        ? data.stickyChapterTitleEnabled
        : defaultStickyChapterTitleEnabled,
    chapterNavToolbarEnabled:
      typeof data.chapterNavToolbarEnabled === "boolean"
        ? data.chapterNavToolbarEnabled
        : defaultChapterNavToolbarEnabled,
    readerEditShowLineNumbers:
      typeof data.readerEditShowLineNumbers === "boolean"
        ? data.readerEditShowLineNumbers
        : defaultReaderEditShowLineNumbers,
    readerEditMinimap:
      typeof data.readerEditMinimap === "boolean"
        ? data.readerEditMinimap
        : defaultReaderEditMinimap,
    fullscreenReaderWidthPercent:
      typeof data.fullscreenReaderWidthPercent === "number"
        ? data.fullscreenReaderWidthPercent
        : defaultFullscreenReaderWidthPercent,
    fullscreenShowSystemTime:
      typeof data.fullscreenShowSystemTime === "boolean"
        ? data.fullscreenShowSystemTime
        : defaultFullscreenShowSystemTime,
    timedScrollSettings: mergeTimedScrollSettings(data.timedScroll),
    pomodoroSettings: mergePomodoroSettings(data.pomodoro),
  };
}

export function snapshotSharedReaderSettingsForMain(
  state: SharedReaderSettingsSnapshot,
): Record<string, unknown> {
  return {
    fontSize: state.readerFontSize,
    lineHeightMultiple: state.readerLineHeightMultiple,
    fontFamily: state.monacoFontFamily,
    pinnedOtherFonts: [...state.pinnedOtherFonts],
    monacoCustomHighlight: state.monacoCustomHighlight,
    txtrDelimitedMatchCrossLine: state.txtrDelimitedMatchCrossLine,
    compressBlankLines: state.compressBlankLines,
    compressBlankKeepOneBlank: state.compressBlankKeepOneBlank,
    leadIndentFullWidth: state.leadIndentFullWidth,
    textConvertZh: state.textConvertZh,
    textConvertLetter: state.textConvertLetter,
    textConvertDigit: state.textConvertDigit,
    monacoAdvancedWrapping: state.monacoAdvancedWrapping,
    monacoSmoothScrolling: state.monacoSmoothScrolling,
    mouseWheelScrollSensitivity: state.mouseWheelScrollSensitivity,
    fastScrollSensitivity: state.fastScrollSensitivity,
    stickyChapterTitleEnabled: state.stickyChapterTitleEnabled,
    chapterNavToolbarEnabled: state.chapterNavToolbarEnabled,
    readerEditShowLineNumbers: state.readerEditShowLineNumbers,
    readerEditMinimap: state.readerEditMinimap,
    fullscreenReaderWidthPercent: state.fullscreenReaderWidthPercent,
    fullscreenShowSystemTime: state.fullscreenShowSystemTime,
    timedScroll: state.timedScrollSettings,
    pomodoro: state.pomodoroSettings,
  };
}

export function createInitialFindBookSettingsState() {
  const data = loadPersistedFindBookSettings();
  const shared = sharedReaderSettingsFromMainData(loadMainSettingsData());
  return {
    cacheDir:
      typeof data.cacheDir === "string" && data.cacheDir.trim()
        ? data.cacheDir.trim()
        : resolveDefaultBookSourceChapterCacheDirSync(),
    downloadDir:
      typeof data.downloadDir === "string" && data.downloadDir.trim()
        ? data.downloadDir.trim()
        : resolveDefaultBookSourceDownloadDirSync(),
    downloadAfterAction: isFindBookDownloadAfterAction(data.downloadAfterAction)
      ? data.downloadAfterAction
      : DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
    downloadAddToMainFileList: data.downloadAddToMainFileList !== false,
    downloadDefaultCategory:
      data.downloadDefaultCategory === undefined
        ? DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY
        : typeof data.downloadDefaultCategory === "string"
          ? data.downloadDefaultCategory.trim()
          : "",
    proxy: normalizeFindBookProxySettings(
      data.proxy ?? DEFAULT_FIND_BOOK_PROXY_SETTINGS,
    ),
    showSidebar:
      typeof data.showSidebar === "boolean"
        ? data.showSidebar
        : defaultShowSidebar,
    sidebarWidth:
      typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth)
        ? Math.max(
            FIND_BOOK_SIDEBAR_MIN_WIDTH,
            Math.floor(data.sidebarWidth),
          )
        : 270 - SIDEBAR_ACTIVITY_BAR_WIDTH,
    showChapterTag:
      typeof data.showChapterTag === "boolean"
        ? data.showChapterTag
        : defaultFindBookShowChapterTag,
    ...shared,
  };
}

export function clampFindBookReaderLineHeight(
  fontSize: number,
  lineHeight: number,
): number {
  return clampLineHeightMultipleForFontSize(fontSize, lineHeight);
}

export {
  defaultTimedScrollIntervalMs,
  defaultTimedScrollRange,
};
