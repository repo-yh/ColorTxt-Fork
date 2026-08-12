import { computed, ref } from "vue";
import {
  createInitialFindBookSettingsState,
  loadFindBookProxySettings,
  loadMainSettingsData,
  patchPersistedMainSettings,
  persistFindBookSettings,
  sharedReaderSettingsFromMainData,
  snapshotFindBookOnlySettingsFromStore,
  snapshotSharedReaderSettingsForMain,
  syncPersistedFindBookProxyToMain,
} from "../services/findBookSettingsStore";
import {
  findBookProxyChangedEvent,
  findBookSettingsKey,
  type FindBookProxySettings,
} from "../constants/findBookSettings";
import {
  resolveDefaultBookSourceChapterCacheDirSync,
  resolveDefaultBookSourceDownloadDirSync,
} from "../../utils/defaultCacheDirs";
import {
  clonePersistBaselineValue,
  WINDOW_LOCAL_MAIN_SETTING_KEYS,
} from "../../services/settingsPersistMerge";

let store: ReturnType<typeof createFindBookSettingsStore> | null = null;

function createFindBookSettingsStore() {
  const initial = createInitialFindBookSettingsState();

  const cacheDir = ref(initial.cacheDir);
  const downloadDir = ref(initial.downloadDir);
  const downloadAfterAction = ref(initial.downloadAfterAction);
  const downloadAddToMainFileList = ref(initial.downloadAddToMainFileList);
  const downloadDefaultCategory = ref(initial.downloadDefaultCategory);
  const proxy = ref<FindBookProxySettings>({ ...initial.proxy });
  const readerFontSize = ref(initial.readerFontSize);
  const readerLineHeightMultiple = ref(initial.readerLineHeightMultiple);
  const readerLineSpacingPx = ref(initial.readerLineSpacingPx);
  const readerLetterSpacingPx = ref(initial.readerLetterSpacingPx);
  const readerHorizontalInsetPx = ref(initial.readerHorizontalInsetPx);
  const monacoFontFamily = ref(initial.monacoFontFamily);
  const pinnedOtherFonts = ref(initial.pinnedOtherFonts);
  const monacoCustomHighlight = ref(initial.monacoCustomHighlight);
  const txtrDelimitedMatchCrossLine = ref(initial.txtrDelimitedMatchCrossLine);
  const compressBlankLines = ref(initial.compressBlankLines);
  const compressBlankKeepOneBlank = ref(initial.compressBlankKeepOneBlank);
  const chapterTitleBlankMode = ref(initial.chapterTitleBlankMode);
  const leadIndentFullWidth = ref(initial.leadIndentFullWidth);
  const textConvertZh = ref(initial.textConvertZh);
  const textConvertLetter = ref(initial.textConvertLetter);
  const textConvertDigit = ref(initial.textConvertDigit);
  const monacoAdvancedWrapping = ref(initial.monacoAdvancedWrapping);
  const monacoCjkWrapOptimize = ref(initial.monacoCjkWrapOptimize);
  const monacoSmoothScrolling = ref(initial.monacoSmoothScrolling);
  const mouseWheelScrollSensitivity = ref(initial.mouseWheelScrollSensitivity);
  const fastScrollSensitivity = ref(initial.fastScrollSensitivity);
  const stickyChapterTitleEnabled = ref(initial.stickyChapterTitleEnabled);
  const chapterNavToolbarEnabled = ref(initial.chapterNavToolbarEnabled);
  const readerEditShowLineNumbers = ref(initial.readerEditShowLineNumbers);
  const readerEditMinimap = ref(initial.readerEditMinimap);
  const fullscreenReaderWidthPercent = ref(initial.fullscreenReaderWidthPercent);
  const fullscreenShowSystemTime = ref(initial.fullscreenShowSystemTime);
  const showSidebar = ref(initial.showSidebar);
  const sidebarWidth = ref(initial.sidebarWidth);
  const showChapterTag = ref(initial.showChapterTag);
  const timedScrollSettings = ref(initial.timedScrollSettings);
  const pomodoroSettings = ref(initial.pomodoroSettings);
  const selectionToolbarButtons = ref(initial.selectionToolbarButtons);
  const dictionarySettings = ref(initial.dictionarySettings);

  /** 阅读/编辑共用字段落盘基线（不把磁盘合并进本窗内存） */
  const readerUiPersistBaseline: Record<string, unknown> = {};

  const effectiveCacheDir = computed(() => {
    const configured = cacheDir.value.trim();
    return configured || resolveDefaultBookSourceChapterCacheDirSync();
  });

  const effectiveDownloadDir = computed(() => {
    const configured = downloadDir.value.trim();
    return configured || resolveDefaultBookSourceDownloadDirSync();
  });

  function applyProxyFromDisk() {
    proxy.value = loadFindBookProxySettings();
  }

  function syncHttpProxyToMain() {
    syncPersistedFindBookProxyToMain();
  }

  function sharedReaderSnapshot() {
    return {
      readerFontSize: readerFontSize.value,
      readerLineHeightMultiple: readerLineHeightMultiple.value,
      readerLineSpacingPx: readerLineSpacingPx.value,
      readerLetterSpacingPx: readerLetterSpacingPx.value,
      readerHorizontalInsetPx: readerHorizontalInsetPx.value,
      monacoFontFamily: monacoFontFamily.value,
      pinnedOtherFonts: pinnedOtherFonts.value,
      monacoCustomHighlight: monacoCustomHighlight.value,
      txtrDelimitedMatchCrossLine: txtrDelimitedMatchCrossLine.value,
      compressBlankLines: compressBlankLines.value,
      compressBlankKeepOneBlank: compressBlankKeepOneBlank.value,
      chapterTitleBlankMode: chapterTitleBlankMode.value,
      leadIndentFullWidth: leadIndentFullWidth.value,
      textConvertZh: textConvertZh.value,
      textConvertLetter: textConvertLetter.value,
      textConvertDigit: textConvertDigit.value,
      monacoAdvancedWrapping: monacoAdvancedWrapping.value,
      monacoCjkWrapOptimize: monacoCjkWrapOptimize.value,
      monacoSmoothScrolling: monacoSmoothScrolling.value,
      mouseWheelScrollSensitivity: mouseWheelScrollSensitivity.value,
      fastScrollSensitivity: fastScrollSensitivity.value,
      stickyChapterTitleEnabled: stickyChapterTitleEnabled.value,
      chapterNavToolbarEnabled: chapterNavToolbarEnabled.value,
      readerEditShowLineNumbers: readerEditShowLineNumbers.value,
      readerEditMinimap: readerEditMinimap.value,
      fullscreenReaderWidthPercent: fullscreenReaderWidthPercent.value,
      fullscreenShowSystemTime: fullscreenShowSystemTime.value,
      timedScrollSettings: timedScrollSettings.value,
      pomodoroSettings: pomodoroSettings.value,
      selectionToolbarButtons: selectionToolbarButtons.value,
      dictionarySettings: dictionarySettings.value,
    };
  }

  function captureReaderUiPersistBaseline() {
    const patch = snapshotSharedReaderSettingsForMain(sharedReaderSnapshot());
    for (const [key, value] of Object.entries(patch)) {
      if (!WINDOW_LOCAL_MAIN_SETTING_KEYS.has(key)) continue;
      if (value === undefined) continue;
      readerUiPersistBaseline[key] = clonePersistBaselineValue(value);
    }
  }

  /** 仅找书专属（下载/代理/侧栏等） */
  function persistAll() {
    persistFindBookSettings(
      snapshotFindBookOnlySettingsFromStore({
        cacheDir: cacheDir.value,
        downloadDir: downloadDir.value,
        downloadAfterAction: downloadAfterAction.value,
        downloadAddToMainFileList: downloadAddToMainFileList.value,
        downloadDefaultCategory: downloadDefaultCategory.value,
        proxy: proxy.value,
        showSidebar: showSidebar.value,
        sidebarWidth: sidebarWidth.value,
        showChapterTag: showChapterTag.value,
      }),
    );
    syncHttpProxyToMain();
    try {
      window.dispatchEvent(new CustomEvent(findBookProxyChangedEvent));
    } catch {
      // ignore
    }
  }

  /** 阅读/编辑相关写入主界面 `colorTxt.ui.settings`（未改字段保留磁盘） */
  function persistReaderUiPrefs() {
    patchPersistedMainSettings(
      snapshotSharedReaderSettingsForMain(sharedReaderSnapshot()),
      { baseline: readerUiPersistBaseline },
    );
  }

  function hydrateSharedReaderFromMain() {
    const shared = sharedReaderSettingsFromMainData(loadMainSettingsData());
    readerFontSize.value = shared.readerFontSize;
    readerLineHeightMultiple.value = shared.readerLineHeightMultiple;
    readerLineSpacingPx.value = shared.readerLineSpacingPx;
    readerLetterSpacingPx.value = shared.readerLetterSpacingPx;
    readerHorizontalInsetPx.value = shared.readerHorizontalInsetPx;
    monacoFontFamily.value = shared.monacoFontFamily;
    pinnedOtherFonts.value = shared.pinnedOtherFonts;
    monacoCustomHighlight.value = shared.monacoCustomHighlight;
    txtrDelimitedMatchCrossLine.value = shared.txtrDelimitedMatchCrossLine;
    compressBlankLines.value = shared.compressBlankLines;
    compressBlankKeepOneBlank.value = shared.compressBlankKeepOneBlank;
    chapterTitleBlankMode.value = shared.chapterTitleBlankMode;
    leadIndentFullWidth.value = shared.leadIndentFullWidth;
    textConvertZh.value = shared.textConvertZh;
    textConvertLetter.value = shared.textConvertLetter;
    textConvertDigit.value = shared.textConvertDigit;
    monacoAdvancedWrapping.value = shared.monacoAdvancedWrapping;
    monacoCjkWrapOptimize.value = shared.monacoCjkWrapOptimize;
    monacoSmoothScrolling.value = shared.monacoSmoothScrolling;
    mouseWheelScrollSensitivity.value = shared.mouseWheelScrollSensitivity;
    fastScrollSensitivity.value = shared.fastScrollSensitivity;
    stickyChapterTitleEnabled.value = shared.stickyChapterTitleEnabled;
    chapterNavToolbarEnabled.value = shared.chapterNavToolbarEnabled;
    readerEditShowLineNumbers.value = shared.readerEditShowLineNumbers;
    readerEditMinimap.value = shared.readerEditMinimap;
    fullscreenReaderWidthPercent.value = shared.fullscreenReaderWidthPercent;
    fullscreenShowSystemTime.value = shared.fullscreenShowSystemTime;
    timedScrollSettings.value = shared.timedScrollSettings;
    pomodoroSettings.value = shared.pomodoroSettings;
    selectionToolbarButtons.value = shared.selectionToolbarButtons;
    dictionarySettings.value = shared.dictionarySettings;
    captureReaderUiPersistBaseline();
  }

  function onProxyExternalChange() {
    applyProxyFromDisk();
    syncHttpProxyToMain();
  }

  function onStorageSync(ev: StorageEvent) {
    if (ev.storageArea !== window.localStorage) return;
    if (ev.key !== null && ev.key !== findBookSettingsKey) return;
    onProxyExternalChange();
  }

  captureReaderUiPersistBaseline();

  // 窗口启动时把已持久化的代理同步到主进程
  syncHttpProxyToMain();

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorageSync);
    window.addEventListener(findBookProxyChangedEvent, onProxyExternalChange);
  }

  return {
    cacheDir,
    downloadDir,
    downloadAfterAction,
    downloadAddToMainFileList,
    downloadDefaultCategory,
    proxy,
    effectiveCacheDir,
    effectiveDownloadDir,
    syncHttpProxyToMain,
    applyProxyFromDisk,
    readerFontSize,
    readerLineHeightMultiple,
    readerLineSpacingPx,
    readerLetterSpacingPx,
    readerHorizontalInsetPx,
    monacoFontFamily,
    pinnedOtherFonts,
    monacoCustomHighlight,
    txtrDelimitedMatchCrossLine,
    compressBlankLines,
    compressBlankKeepOneBlank,
    chapterTitleBlankMode,
    leadIndentFullWidth,
    textConvertZh,
    textConvertLetter,
    textConvertDigit,
    monacoAdvancedWrapping,
    monacoCjkWrapOptimize,
    monacoSmoothScrolling,
    mouseWheelScrollSensitivity,
    fastScrollSensitivity,
    stickyChapterTitleEnabled,
    chapterNavToolbarEnabled,
    readerEditShowLineNumbers,
    readerEditMinimap,
    fullscreenReaderWidthPercent,
    fullscreenShowSystemTime,
    showSidebar,
    sidebarWidth,
    showChapterTag,
    timedScrollSettings,
    pomodoroSettings,
    selectionToolbarButtons,
    dictionarySettings,
    persistAll,
    persistReaderUiPrefs,
    hydrateSharedReaderFromMain,
    readerUiPersistBaseline,
  };
}

export function useFindBookSettings() {
  if (!store) store = createFindBookSettingsStore();
  return store;
}

export function resetFindBookSettingsStoreForTests() {
  store = null;
}
