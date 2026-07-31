<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { nextTick, type ComponentPublicInstance } from "vue";
import { getChapterMatchRules, type Chapter } from "./chapter";
import {
  appReplaceRulesChangedEvent,
  type ReplaceRule,
} from "@shared/bookSource/replaceRule";
import { filterEnabledReplaceRules } from "@shared/bookSource/replaceRuleApply";
import { listReplaceRulesLocal } from "./bookSource/replaceRuleLocalStore";
import AppHeader, { type RecentFileItem } from "./components/AppHeader.vue";
import VoiceReadToolbar from "./components/VoiceReadToolbar.vue";
import ReaderChapterNavBar from "./components/ReaderChapterNavBar.vue";
import ReaderSidebar from "./components/ReaderSidebar.vue";
import AppFooter from "./components/AppFooter.vue";
import ReaderMain from "./components/ReaderMain.vue";
import AppDialogHost from "./components/AppDialogHost.vue";
import AppCaptchaHost from "./components/AppCaptchaHost.vue";
import AppToastHost from "./components/AppToastHost.vue";
import AppOverlays from "./components/AppOverlays.vue";
import WebDavSyncPanel from "./components/WebDavSyncPanel.vue";
import FullscreenSystemClock from "./components/FullscreenSystemClock.vue";
import PomodoroBreakOverlay from "./components/PomodoroBreakOverlay.vue";
import type { SettingsApplyPayload } from "./components/SettingsPanel.vue";
import { usePomodoroTimer } from "./composables/usePomodoroTimer";
import {
  mergePomodoroSettings,
  type PomodoroSettings,
} from "./constants/pomodoro";
import type { AiCustomSkill, AiSkillUserOverride } from "@shared/aiSkills";
import type { ColorTxtShowMessageBoxOptions } from "@shared/colorTxtShowMessageBox";
import type {
  CharacterBookStylePersisted,
  CharacterRosterEntry,
} from "@shared/characterTypes";
import {
  characterPortraitBookDirAbs,
  sanitizeBookFolderSegment,
} from "@shared/characterPortraitPaths";
import type { CharacterCardTextureEffectId } from "@shared/characterCardTextureEffects";
import { DEFAULT_CHARACTER_CARD_TEXTURE_EFFECT } from "@shared/characterCardTextureEffects";
import { formatTextEncodingLabel } from "@shared/textEncodingDisplay";
import {
  mergeAiCustomSkills,
  mergeAiSkillOverrides,
  mergeAiSkillsEnabled,
} from "@shared/aiSkills";
import { bookmarkNoteInputRefKey } from "./injectionKeys";
import type { ReaderSidebarTab } from "./constants/readerSidebarTab";
import {
  resolveInitialReaderSidebarTab,
  type InitialWindowLoadIntent,
} from "./reader/initialSidebarTab";
import { pickActiveChapterIdx } from "./reader/chapterIndex";
import {
  WORDCLOUD_DEFAULT_ANGLE_MODE,
  WORDCLOUD_DEFAULT_FONT_FAMILY,
  type WordcloudAngleMode,
} from "./constants/wordcloudUi";
import {
  WORDCLOUD_DEFAULT_PALETTE_ID,
  type WordcloudPaletteId,
} from "./constants/wordcloudPalettes";
import { useAppBookmarkPins } from "./composables/useAppBookmarkPins";
import { useAppChapterListSync } from "./composables/useAppChapterListSync";
import { useAppChapterNavigation } from "./composables/useAppChapterNavigation";
import { useAppFileSession } from "./composables/useAppFileSession";
import { useAppFullscreenReaderLayout } from "./composables/useAppFullscreenReaderLayout";
import { useAppHighlightTerms } from "./composables/useAppHighlightTerms";
import { useAppPersistence } from "./composables/useAppPersistence";
import { useAppReaderAnnotations } from "./composables/useAppReaderAnnotations";
import { useAppReaderChrome } from "./composables/useAppReaderChrome";
import { useAppReadingProgress } from "./composables/useAppReadingProgress";
import { useAppReaderUiPrefs } from "./composables/useAppReaderUiPrefs";
import { useAppShellThemeWatch } from "./composables/useAppShellThemeWatch";
import { useAppSidebarSearch } from "./composables/useAppSidebarSearch";
import { useAppSyncCurrentFileWatch } from "./composables/useAppSyncCurrentFileWatch";
import { useAppWindowBindings } from "./composables/useAppWindowBindings";
import { useAiChapterPlainTextBridge } from "./composables/useAiChapterPlainTextBridge";
import { isEbookFilePath, isMarkdownFilePath, isPlainTextBookPath } from "./ebook/ebookFormat";
import { useAppVoiceRead } from "./composables/useAppVoiceRead";
import { useAppTimedScroll } from "./composables/useAppTimedScroll";
import { useTxtStreamPipeline } from "./composables/useTxtStreamPipeline";
import { fileHistoryKey } from "./stores/recentHistoryStore";
import {
  clampLineationLastColorsToCount,
  DEFAULT_LINEATION_LAST_COLORS,
  type LineationLastColorPrefs,
} from "./constants/annotationColors";
import {
  fileNameKey,
  findFileMetaRecord,
  upsertFileMetaRecord,
  normalizeFileMetaPathKey,
  type FileMetaRecord,
  type HighlightWordsByIndex,
  type ReaderLineationType,
} from "./stores/fileMetaStore";
import {
  applyReaderSurfaceToDocument,
  defaultCompressBlankKeepOneBlank,
  defaultCompressBlankLines,
  defaultChapterMinCharCount,
  defaultFullscreenReaderWidthPercent,
  defaultFullscreenShowSystemTime,
  defaultLeadIndentFullWidth,
  defaultTextConvertDigitMode,
  defaultTextConvertLetterMode,
  defaultTextConvertZhMode,
  defaultMonacoAdvancedWrapping,
  defaultMonacoCustomHighlight,
  defaultMonacoSmoothScrolling,
  defaultMouseWheelScrollSensitivity,
  defaultFastScrollSensitivity,
  clampMouseWheelScrollSensitivity,
  clampFastScrollSensitivity,
  defaultStickyChapterTitleEnabled,
  defaultChapterNavToolbarEnabled,
  defaultReaderEditShowLineNumbers,
  defaultReaderEditMinimap,
  defaultEditAutoRefreshChapterList,
  editAutoRefreshChapterListMaxLines,
  defaultReaderIdleHint,
  defaultReaderOpenHint,
  defaultReaderFontSize,
  defaultReaderLineHeightMultiple,
  defaultReaderPaletteDark,
  defaultReaderPaletteLight,
  defaultReaderTheme,
  defaultRecentFilesHistoryLimit,
  mergeReaderPaletteColorEnabled,
  mergeReaderSurfacePalette,
  overridesFromColorEnabled,
  overridesFromFullPalette,
  resolveEffectiveReaderPalette,
  defaultRestoreSessionOnStartup,
  defaultSyncCurrentFile,
  defaultTxtrDelimitedMatchCrossLine,
  defaultShowChapterCounts,
  defaultChapterCharCountExact,
  defaultShowSidebar,
  emptyFileHintText,
  readerTxtLoadingHintText,
  GITHUB_REPO_URL,
  maxFullscreenReaderWidthPercent,
  clampLineHeightMultipleForFontSize,
  maxFontSize,
  maxChapterMinCharCount,
  maxLineHeightMultipleForFontSize,
  maxRecentFilesHistoryLimit,
  minFullscreenReaderWidthPercent,
  minFontSize,
  minChapterMinCharCount,
  minLineHeightMultiple,
  SIDEBAR_ACTIVITY_BAR_WIDTH,
  type ReaderSurfaceColorEnabled,
  type ReaderSurfacePalette,
} from "./constants/appUi";
import {
  type TextConvertWidthMode,
  type TextConvertZhMode,
} from "@shared/textConvertTypes";
import { mergeVoiceReadSettings, type VoiceReadSettings } from "./constants/voiceRead";
import {
  mergeTimedScrollSettings,
  type TimedScrollSettings,
} from "./constants/timedScroll";
import { migrateVoiceReadFromPersisted, cloneVoiceReadProfiles } from "./services/voiceRead/voiceReadProfileState";
import {
  voiceReadAiSpeakerTokenUsage,
  voiceReadAiSpeakerTokenUsageAvailable,
} from "./services/voiceRead/voiceReadAiSpeakerTokenUsage";
import type { VoiceReadProfile } from "@shared/voiceReadProfiles";
import {
  DEFAULT_HIGHLIGHT_COLORS_DARK,
  DEFAULT_HIGHLIGHT_COLORS_LIGHT,
  MIN_HIGHLIGHT_COLORS,
  mergeHighlightColors,
} from "./constants/highlightColors";
import {
  DEFAULT_LINEATION_COLORS_DARK,
  DEFAULT_LINEATION_COLORS_LIGHT,
  MIN_LINEATION_COLORS,
  mergeLineationColors,
} from "./constants/lineationColors";
import { formatCharCount, formatFileSize } from "./utils/format";
import { resolveDefaultUnpackedBooksDirSync } from "./utils/defaultCacheDirs";
import { joinFs } from "./ebook/pathUtils";
import { buildWebDavAuth } from "./utils/webDavAuth";
import { READER_EDITOR_DEFAULT_FONT_FAMILY } from "./monaco/readerEditorOptions";
import {
  createDefaultShortcutBindings,
  type ShortcutBindingMap,
} from "./services/shortcutRegistry";
import {
  defaultAiSmartFormatSettings,
  aiSmartFormatHasAnyTask,
  type AiSmartFormatSettings,
} from "@shared/aiSmartFormatTypes";
import { useAiSmartFormat } from "./composables/useAiSmartFormat";
import AiSmartFormatProgressModal from "./components/AiSmartFormatProgressModal.vue";
import { appToast } from "./services/appToast";
import { appAlert, appConfirm } from "./services/appDialog";
import { mergeShortcutBindings } from "./services/shortcutUtils";
import {
  syncTxtFilesCategoriesAfterCatalogEdit,
  normalizeTxtFileItem,
  type TxtFileItem,
} from "./services/fileListService";
import {
  cloneDefaultFileCategoryCatalog,
  DEFAULT_FILE_SORT,
  FILE_CATEGORY_FILTER_ALL,
  FILE_CATEGORY_FILTER_UNCATEGORIZED,
  type CategoryEditorRow,
  type FileCategoryDefinition,
  type FileSortMode,
} from "./constants/fileCategories";

const readerRef = ref<InstanceType<typeof ReaderMain> | null>(null);
/** 全屏侧栏文件列表 Teleport 弹层（分类/筛选下拉、右键菜单等） */
const fullscreenFileListPopoversOpen = ref(false);
/** AI 阅读助手：历史/导出/模型菜单等 Teleport；与文件列表合并后交给全屏侧栏收起逻辑 */
const fullscreenAiAssistantPopoversOpen = ref(false);
/** 角色卡：编辑/添加角色抽屉打开 */
const fullscreenCharacterDrawerOpen = ref(false);
const fullscreenCharacterPopoversOpen = ref(false);
const fullscreenSidebarPopoversSuppressCollapse = computed(
  () =>
    fullscreenFileListPopoversOpen.value ||
    fullscreenAiAssistantPopoversOpen.value ||
    fullscreenCharacterDrawerOpen.value ||
    fullscreenCharacterPopoversOpen.value,
);
/** 全屏下打开设置/配色弹框期间，禁用左缘感应自动唤起侧栏 */
const suppressFullscreenSidebarHover = ref(false);
const chrome = useAppReaderChrome({
  readerRef,
  fullscreenSidebarPopoversSuppressCollapse,
  suppressFullscreenSidebarHover,
});
const {
  isFullscreenView,
  showFullscreenTip,
  fullscreenTipFading,
  showFullscreenHeader,
  fullscreenHeaderOverlayRef,
  showFullscreenFooter,
  fullscreenFooterOverlayRef,
  showFullscreenSidebar,
  fullscreenSidebarOverlayRef,
  sidebarWidth,
  fullscreenSidebarWidth,
  sidebarWidthForLayout,
  resizingSidebar,
  enterOrExitFullscreenView,
  getSidebarMaxWidth,
  getSidebarMinWidth,
  clampSidebarWidthToViewport,
  startResizeSidebar,
  updateFullscreenHeaderHover,
  updateFullscreenFooterHover,
  updateFullscreenSidebarHover,
  onFullscreenSidebarMouseLeave,
  onFullscreenHeaderMouseLeave,
  onFullscreenFooterMouseLeave,
  dismissFullscreenPanelsOnLayoutPointerDown,
  endSidebarResize,
  dismissFullscreenChromeForNativeExit,
  fullscreenCursorHidden,
  bumpFullscreenCursorIdle,
  recordFullscreenPointer,
} = chrome;

function setFullscreenHeaderOverlayEl(
  el: Element | ComponentPublicInstance | null,
) {
  if (el == null) {
    fullscreenHeaderOverlayRef.value = null;
    return;
  }
  fullscreenHeaderOverlayRef.value =
    el instanceof HTMLElement
      ? el
      : ((el as ComponentPublicInstance).$el as HTMLElement | null);
}

function setFullscreenFooterOverlayEl(
  el: Element | ComponentPublicInstance | null,
) {
  if (el == null) {
    fullscreenFooterOverlayRef.value = null;
    return;
  }
  fullscreenFooterOverlayRef.value =
    el instanceof HTMLElement
      ? el
      : ((el as ComponentPublicInstance).$el as HTMLElement | null);
}

const showAboutPanel = ref(false);
const showShortcutPanel = ref(false);
const showSettingsPanel = ref(false);
const showColorSchemePanel = ref(false);
const showWebDavPanel = ref(false);
const appOverlaysRef = ref<InstanceType<typeof AppOverlays> | null>(null);
watch(
  () =>
    [
      showSettingsPanel.value,
      showColorSchemePanel.value,
      showWebDavPanel.value,
    ] as const,
  ([settingsOpen, colorOpen, webDavOpen]) => {
    suppressFullscreenSidebarHover.value =
      settingsOpen || colorOpen || webDavOpen;
  },
  { immediate: true },
);
const showChapterRulePanel = ref(false);
const showReplaceRulePanel = ref(false);
const chapterRuleErrorText = ref("");
const chapterRuleState = ref(getChapterMatchRules());
/** 主窗口文本替换规则（localStorage，与找书分键） */
const cachedReplaceRules = ref<ReplaceRule[]>([]);
const textReplaceActive = computed(
  () =>
    filterEnabledReplaceRules(cachedReplaceRules.value, "", "", "content")
      .length > 0 ||
    filterEnabledReplaceRules(cachedReplaceRules.value, "", "", "title")
      .length > 0,
);

function refreshReplaceRulesCache() {
  cachedReplaceRules.value = listReplaceRulesLocal("app");
}

/** 按当前展示设置（替换/转换/压缩空行/缩进等）从物理行重跑管线，并尽量保持视口 */
function reformatReaderDisplayPreservingViewport() {
  if (!currentFile.value || readerEditMode.value || loading.value) return;
  const anchor =
    captureViewportRestoreAnchor() ?? {
      physicalLine: captureViewportAnchorPhysicalLine(),
      wrappedLineIndex: 0,
    };
  void withChapterListScrollSuppressed(async () => {
    const ok = await stream.applyReaderDisplayFromPhysicalLines(anchor);
    if (!ok) return;
    await nextTick();
    readerRef.value?.emitProbeLine?.();
    await syncChaptersAfterViewportSettled();
  });
}

function onReplaceRulesChanged() {
  refreshReplaceRulesCache();
  reformatReaderDisplayPreservingViewport();
}

const currentFile = ref<string | null>(null);
const loading = ref(false);
/** 打开文件时主进程流式读取的字节进度（0–100），无总大小时为 null */
const loadingProgressPercent = ref<number | null>(null);
/** 底栏路径旁：WebDAV 书包上传/同步进度 */
const webDavBookPackProgress = ref<{
  kind: "upload" | "sync";
  percent: number;
} | null>(null);
let webDavBookPackProgressRequestId: string | null = null;
let webDavBookPackProgressUnsub: (() => void) | null = null;

function beginWebDavBookPackProgress(kind: "upload" | "sync"): string {
  const requestId = `webdav-bp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  webDavBookPackProgressRequestId = requestId;
  webDavBookPackProgress.value = { kind, percent: 0 };
  webDavBookPackProgressUnsub?.();
  webDavBookPackProgressUnsub =
    window.colorTxt?.webdav?.onTransferProgress((p) => {
      if (p.requestId !== webDavBookPackProgressRequestId) return;
      const cur = webDavBookPackProgress.value;
      if (!cur) return;
      webDavBookPackProgress.value = { ...cur, percent: p.percent };
    }) ?? null;
  return requestId;
}

function endWebDavBookPackProgress() {
  webDavBookPackProgressUnsub?.();
  webDavBookPackProgressUnsub = null;
  webDavBookPackProgressRequestId = null;
  webDavBookPackProgress.value = null;
}
/** 递归扫描目录中的 .txt 时：蒙版 + 当前处理的相对路径 */
const dirListScanning = ref(false);
const dirListCurrentName = ref("");
/** 拖入阅读区时显示局部「打开文件」蒙层（由 useAppWindowBindings 驱动） */
const readerDropOverlayVisible = ref(false);
const fileEncoding = ref<string>("-");
const currentFileSize = ref<number | null>(null);
const totalCharCount = ref(0);
const totalLineCount = ref(0);

const chapters = ref<Chapter[]>([]);
const activeChapterIdx = ref<number>(-1);

useAiChapterPlainTextBridge(readerRef, chapters);
const showChapterCounts = ref(defaultShowChapterCounts);
const chapterCharCountExact = ref(defaultChapterCharCountExact);
/** 依赖 exact 开关，变更时更新函数引用以刷新章节列表字数展示（底栏总字数直接读同一开关） */
const formatChapterCharCount = computed(
  () => (n: number) => formatCharCount(n, chapterCharCountExact.value),
);
/** AI 阅读助手工具栏：深度思考 / 防剧透（持久化至 colorTxt.ui.settings） */
const aiAssistantDeepThinking = ref(false);
const aiAssistantSpoilerSafe = ref(false);
const wordcloudFontFamily = ref(WORDCLOUD_DEFAULT_FONT_FAMILY);
const wordcloudAngleMode = ref<WordcloudAngleMode>(WORDCLOUD_DEFAULT_ANGLE_MODE);
const wordcloudPaletteId = ref<WordcloudPaletteId>(WORDCLOUD_DEFAULT_PALETTE_ID);
const voiceReadSettings = ref<VoiceReadSettings>(
  mergeVoiceReadSettings(undefined),
);
const voiceReadProfiles = ref<VoiceReadProfile[]>(
  migrateVoiceReadFromPersisted(undefined).profiles,
);
const activeVoiceReadProfileId = ref(
  migrateVoiceReadFromPersisted(undefined).activeProfileId,
);
const initialWindowLoadIntent: InitialWindowLoadIntent =
  typeof window !== "undefined" && window.colorTxt?.getInitialWindowLoadIntent
    ? window.colorTxt.getInitialWindowLoadIntent()
    : { shouldRestoreSession: false, hasPendingOpenTxt: false };
const sidebarTab = ref<ReaderSidebarTab>(
  resolveInitialReaderSidebarTab(initialWindowLoadIntent),
);
/** 设置 → AI「启用 AI 阅读助手功能」，控制侧栏「AI 阅读助手」 */
const aiFeaturesEnabled = ref(true);
/** AI 开启且文生图开启时显示「角色卡」标签 */
const txt2imgFeatureEnabled = ref(true);
/** 设置「确定」保存后递增，供 AI 阅读助手重新拉取快速提问等配置 */
const aiAssistantConfigSyncNonce = ref(0);

async function refreshAiSidebarFlags() {
  try {
    const c = await window.colorTxt.ai.configGet();
    aiFeaturesEnabled.value = Boolean(c.aiEnabled);
    txt2imgFeatureEnabled.value =
      aiFeaturesEnabled.value && Boolean(c.txt2img?.enabled);
  } catch {
    aiFeaturesEnabled.value = true;
    txt2imgFeatureEnabled.value = true;
  }
}

onMounted(() => {
  /** 旧版侧栏曾含扩展视图 tab（`ext:`）或设置「扩展」占位 id */
  const t = sidebarTab.value as string;
  if (t === "extensions" || t.startsWith("ext:")) {
    sidebarTab.value = "files";
  }
  void refreshAiSidebarFlags();
  refreshReplaceRulesCache();
  window.addEventListener(appReplaceRulesChangedEvent, onReplaceRulesChanged);
});

onBeforeUnmount(() => {
  window.removeEventListener(appReplaceRulesChangedEvent, onReplaceRulesChanged);
  endWebDavBookPackProgress();
});

watch(showSettingsPanel, (open, wasOpen) => {
  if (wasOpen && !open) void refreshAiSidebarFlags();
});

watch(aiFeaturesEnabled, (en) => {
  if (
    !en &&
    (sidebarTab.value === "aiAssistant" || sidebarTab.value === "character")
  ) {
    sidebarTab.value = "files";
  }
});

watch(txt2imgFeatureEnabled, (en) => {
  if (!en && sidebarTab.value === "character") sidebarTab.value = "files";
});
const CHAPTER_REFRESH_DEBOUNCE_MS = 400;
const txtFiles = ref<TxtFileItem[]>([]);
const fileCategory = ref<string>(FILE_CATEGORY_FILTER_ALL);
const fileSort = ref<FileSortMode>(DEFAULT_FILE_SORT);
const fileCategoryCatalog = ref<FileCategoryDefinition[]>(
  cloneDefaultFileCategoryCatalog(),
);
const fileMetaRecords = ref<FileMetaRecord[]>([]);
const showSidebar = ref(defaultShowSidebar);
const readerSidebarRef = ref<InstanceType<typeof ReaderSidebar> | null>(null);
const chapterSync = useAppChapterListSync();
const {
  chapterListScrollSmooth,
  shouldCenterChapterList,
  pulseChapterListCenter,
  shouldCenterFileList,
  suppressFileListCenterAfterLoad,
  shouldCenterBookmarkList,
  pulseBookmarkListCenter,
} = chapterSync;
/** 阅读区无打开文件且未在加载/转换时，居中显示 defaultReaderIdleHint */
const showReaderIdleHint = computed(() => !currentFile.value && !loading.value);
/** 电子书正文流尚未写入行时，复用 `.readerIdleHint` 居中提示 */
/** 流式读盘期间底栏显示字节进度；行/字数在格式化完成后才有 */
const showReaderBusyHint = computed(
  () => loading.value && Boolean(currentFile.value),
);
const readerBusyHintText = computed(() => readerTxtLoadingHintText);
/** 已打开文件且流式加载完成、正文行数与字数均为 0 时居中提示（仅只读；编辑模式不遮挡空白编辑区） */
/** 字数 0 即视为无内容（Monaco 空模型仍可能计 1 行，勿与行数强绑定） */
const showReaderEmptyHint = computed(
  () =>
    Boolean(currentFile.value) &&
    !loading.value &&
    !readerEditMode.value &&
    totalCharCount.value === 0,
);
/** 非全屏：侧栏壳（含活动栏）始终占位；全屏：仅浮动展开时显示整块 */
const sidebarShellVisible = computed(
  () => !isFullscreenView.value || showFullscreenSidebar.value,
);
/** 非全屏且收起面板时仅活动栏宽度；其余与 `sidebarWidthForLayout` 一致 */
const sidebarPaneLayoutWidth = computed(() => {
  if (isFullscreenView.value) return sidebarWidthForLayout.value;
  if (!showSidebar.value) return SIDEBAR_ACTIVITY_BAR_WIDTH;
  return sidebarWidthForLayout.value;
});
const currentTheme = ref(defaultReaderTheme);
/** Monaco txtr.* 语法着色（标点/数字/英文/引号与括号内等） */
const monacoCustomHighlight = ref(defaultMonacoCustomHighlight);
/** 为 true 时在加载文件流中丢弃空行（仅空格/缩进也视为空行） */
const compressBlankLines = ref(defaultCompressBlankLines);
/** 压缩空行时是否在每行正文下方保留一行空行（章节标题行除外） */
const compressBlankKeepOneBlank = ref(defaultCompressBlankKeepOneBlank);
/** 与「内容上色」同时生效：Monarch 成对引号/括号是否跨行 */
const txtrDelimitedMatchCrossLine = ref(defaultTxtrDelimitedMatchCrossLine);
/** 为 true 时正文行统一行首两个全角空格（章节标题行与空行除外） */
const leadIndentFullWidth = ref(defaultLeadIndentFullWidth);
const textConvertZh = ref<TextConvertZhMode>(defaultTextConvertZhMode);
const textConvertLetter = ref<TextConvertWidthMode>(defaultTextConvertLetterMode);
const textConvertDigit = ref<TextConvertWidthMode>(defaultTextConvertDigitMode);
const readerFontSize = ref(defaultReaderFontSize);
const readerLineHeightMultiple = ref(defaultReaderLineHeightMultiple);
const monacoFontFamily = ref(READER_EDITOR_DEFAULT_FONT_FAMILY);
/** 阅读器字体弹框：钉在外层的「其他字体」 */
const pinnedOtherFonts = ref<string[]>([]);
const defaultShortcutBindings = createDefaultShortcutBindings(
  /mac|iphone|ipad|ipod/i.test(navigator.platform || ""),
);
const shortcutBindings = ref<ShortcutBindingMap>({
  ...defaultShortcutBindings,
});

/** 启动时是否恢复上次会话快照（localStorage）；关闭时不写入会话 */
const restoreSessionOnStartup = ref(defaultRestoreSessionOnStartup);
/** 磁盘上当前正文变更后是否自动重新加载（设置项） */
const syncCurrentFile = ref(defaultSyncCurrentFile);
/** 最近打开文件条数上限，0 表示不记录 */
const recentFilesHistoryLimit = ref(defaultRecentFilesHistoryLimit);
/** 小于该字数的章节不纳入章节列表与导航 */
const chapterMinCharCount = ref(defaultChapterMinCharCount);
/** Monaco wrappingStrategy：advanced 换行更优、更重 */
const monacoAdvancedWrapping = ref(defaultMonacoAdvancedWrapping);
/** Monaco 阅读区平滑滚动（设置可关） */
const monacoSmoothScrolling = ref(defaultMonacoSmoothScrolling);
const mouseWheelScrollSensitivity = ref(defaultMouseWheelScrollSensitivity);
const fastScrollSensitivity = ref(defaultFastScrollSensitivity);
/** 阅读区顶部粘性章节标题 */
const stickyChapterTitleEnabled = ref(defaultStickyChapterTitleEnabled);
const chapterNavToolbarEnabled = ref(defaultChapterNavToolbarEnabled);
const readerEditShowLineNumbers = ref(defaultReaderEditShowLineNumbers);
const readerEditMinimap = ref(defaultReaderEditMinimap);
const editAutoRefreshChapterList = ref(defaultEditAutoRefreshChapterList);
const aiSmartFormat = ref<AiSmartFormatSettings>({
  ...defaultAiSmartFormatSettings,
});
const canUseAiSmartFormat = computed(() =>
  aiSmartFormatHasAnyTask(aiSmartFormat.value),
);
/** 全屏时阅读区域宽度（百分比） */
const fullscreenReaderWidthPercent = ref(defaultFullscreenReaderWidthPercent);
/** 全屏时是否在左下角显示系统时间 */
const fullscreenShowSystemTime = ref(defaultFullscreenShowSystemTime);
const timedScrollSettings = ref<TimedScrollSettings>(
  mergeTimedScrollSettings(undefined),
);
const pomodoroSettings = ref<PomodoroSettings>(mergePomodoroSettings(undefined));
const {
  phase: pomodoroPhase,
  displayMode: pomodoroDisplayMode,
  progress: pomodoroProgress,
  countdownText: pomodoroCountdownText,
  pauseResumeLabel: pomodoroPauseResumeLabel,
  paused: pomodoroPaused,
  showBreakOverlay: pomodoroShowBreakOverlay,
  start: startPomodoro,
  toggleDisplayMode: togglePomodoroDisplayMode,
  togglePause: togglePomodoroPause,
  stop: stopPomodoro,
  finishBreakEarly: finishPomodoroBreakEarly,
} = usePomodoroTimer(pomodoroSettings);
/** 电子书转换缓存目录；默认 userData/ConvertedTxt；设置里清空则为与源文件同目录 */
const ebookConvertOutputDir = ref(
  (() => {
    try {
      return window.colorTxt.getDefaultEbookConvertOutputDir();
    } catch {
      return "";
    }
  })(),
);
/** 彩读书包解压目录；默认 userData/UnpackedBooks；空串时运行时仍回退该默认 */
const bookPackUnpackDir = ref(resolveDefaultUnpackedBooksDirSync());
/** 彩读书包默认密码；空串表示导出不加密 */
const bookPackPassword = ref("");
/** 是否启用 WebDAV 同步入口 */
const webDavEnabled = ref(false);
/** WebDAV 服务地址 */
const webDavUrl = ref("");
/** WebDAV 用户名 */
const webDavUsername = ref("");
/** WebDAV 应用根目录名（默认 ColorTxt） */
const webDavRemoteDir = ref("ColorTxt");
/** 角色立绘缓存根目录（绝对路径）；出厂默认 userData/CharacterPortrait */
const characterPortraitCacheDir = ref(
  (() => {
    try {
      return window.colorTxt.getDefaultCharacterPortraitCacheDir();
    } catch {
      return "";
    }
  })(),
);
const characterCardTextureEffect = ref<CharacterCardTextureEffectId>(
  DEFAULT_CHARACTER_CARD_TEXTURE_EFFECT,
);
/** 技能开关（设置 → 技能） */
const aiSkillsEnabled = ref<Record<string, boolean>>(
  mergeAiSkillsEnabled(undefined, []),
);
const aiSkillOverrides = ref<Record<string, AiSkillUserOverride>>({});
const aiCustomSkills = ref<AiCustomSkill[]>([]);
/** 电子书转换阶段（底栏显示「转换中…」） */
const ebookParsing = ref(false);
/** 彩读书包 ZIP 解析 / 解压（全屏「解包中…」蒙层） */
const bookPackUnpacking = ref(false);
/** 转换进行中的电子书原路径（底栏路径；早于 currentFile 更新） */
const ebookConversionSourcePath = ref<string | null>(null);

const readerPaletteOverridesLight = ref<Partial<ReaderSurfacePalette>>({});
const readerPaletteOverridesDark = ref<Partial<ReaderSurfacePalette>>({});
const readerPaletteColorEnabledOverridesLight = ref<
  Partial<ReaderSurfaceColorEnabled>
>({});
const readerPaletteColorEnabledOverridesDark = ref<
  Partial<ReaderSurfaceColorEnabled>
>({});

const readerSurfaceLight = computed(() =>
  mergeReaderSurfacePalette(
    defaultReaderPaletteLight,
    readerPaletteOverridesLight.value,
  ),
);
const readerSurfaceDark = computed(() =>
  mergeReaderSurfacePalette(
    defaultReaderPaletteDark,
    readerPaletteOverridesDark.value,
  ),
);

const readerPaletteColorEnabledLight = computed(() =>
  mergeReaderPaletteColorEnabled(readerPaletteColorEnabledOverridesLight.value),
);
const readerPaletteColorEnabledDark = computed(() =>
  mergeReaderPaletteColorEnabled(readerPaletteColorEnabledOverridesDark.value),
);

const effectiveReaderSurfaceLight = computed(() =>
  resolveEffectiveReaderPalette(
    readerSurfaceLight.value,
    readerPaletteColorEnabledLight.value,
  ),
);
const effectiveReaderSurfaceDark = computed(() =>
  resolveEffectiveReaderPalette(
    readerSurfaceDark.value,
    readerPaletteColorEnabledDark.value,
  ),
);

const highlightColorsLight = ref<string[]>([...DEFAULT_HIGHLIGHT_COLORS_LIGHT]);
const highlightColorsDark = ref<string[]>([...DEFAULT_HIGHLIGHT_COLORS_DARK]);
const lineationColorsLight = ref<string[]>([...DEFAULT_LINEATION_COLORS_LIGHT]);
const lineationColorsDark = ref<string[]>([...DEFAULT_LINEATION_COLORS_DARK]);
/** 已收藏（全书通用）高亮词 */
const highlightWordsByIndexGlobal = ref<HighlightWordsByIndex | undefined>(
  undefined,
);
const lineationLastColors = ref<LineationLastColorPrefs>({
  ...DEFAULT_LINEATION_LAST_COLORS,
});

const highlightColorsForReader = computed(() =>
  currentTheme.value === "vs"
    ? highlightColorsLight.value
    : highlightColorsDark.value,
);

const lineationColorsForReader = computed(() =>
  currentTheme.value === "vs"
    ? lineationColorsLight.value
    : lineationColorsDark.value,
);

const readerPaletteColorEnabledForReader = computed(() =>
  currentTheme.value === "vs"
    ? readerPaletteColorEnabledLight.value
    : readerPaletteColorEnabledDark.value,
);

const currentFileMetaRecord = computed(() => {
  const p = currentFile.value;
  if (!p) return undefined;
  return findFileMetaRecord(fileMetaRecords.value, p);
});

const currentFileCharacterRoster = computed(
  () => currentFileMetaRecord.value?.characterRoster ?? [],
);

const currentFileCharacterBookStyle = computed(
  () => currentFileMetaRecord.value?.characterBookStyle,
);

function onCharacterFileMetaPatch(payload: {
  characterBookStyle?: CharacterBookStylePersisted;
  characterRoster?: CharacterRosterEntry[];
}) {
  const path = currentFile.value;
  if (!path) return;
  fileMetaRecords.value = upsertFileMetaRecord(
    fileMetaRecords.value,
    path,
    () => ({
      ...(payload.characterBookStyle !== undefined
        ? { characterBookStyle: payload.characterBookStyle }
        : {}),
      ...(payload.characterRoster !== undefined
        ? { characterRoster: payload.characterRoster }
        : {}),
    }),
  );
  persistFileMeta();
}

const readerPaneWrapRef = useTemplateRef<HTMLElement>("readerPaneWrapRef");
const {
  fullscreenReaderPaneStyle,
  onLayoutMouseDown: onFullscreenLayoutMouseDown,
  onLayoutWheel,
} = useAppFullscreenReaderLayout({
  isFullscreenView,
  readerRef,
  fullscreenSidebarOverlayRef,
  fullscreenReaderWidthPercent,
  readerPaneWrapRef,
});

function onLayoutMouseDown(ev: MouseEvent) {
  dismissFullscreenPanelsOnLayoutPointerDown(ev);
  onFullscreenLayoutMouseDown(ev);
}

const recentFiles = ref<RecentFileItem[]>([]);

/** 当前阅读位置（与 Monaco 可见区 probe 一致），用于会话恢复 */
const lastProbeLine = ref(1);
/** 视窗可见区首行 / 末行（Monaco 显示行号），用于阅读进度计算 */
const viewportTopLine = ref(1);
const viewportEndLine = ref(1);
/** 阅读区域滚动进度（0-100），按 scrollTop/maxScrollTop 计算 */
const viewportVisualProgressPercent = ref(0);
/** 阅读区域当前是否在底部（滚动意义） */
const viewportAtBottom = ref(false);
/** 流式加载结束后按源文件物理行号（含空行）恢复滚动；滤空时映射为显示行号 */
const pendingRestorePhysicalLine = ref<number | null>(null);
/** 流结束后 Monaco `restoreViewState`；与 pendingRestorePhysicalLine 二选一 */
const pendingRestoreEditorViewState = ref<unknown | null>(null);
/** 与视图状态同时恢复的视口首行物理行号锚点（用于恢复后校验） */
const pendingRestoreViewportTopPhysicalLine = ref<number | null>(null);
/** 只读↔编辑：在切换模式前采集的视口第二行高锚点 */
const pendingReaderEditRestoreAnchor = ref<
  import("./reader/readerViewportAnchor").ReaderViewportRestoreAnchor | null
>(null);
/** 编辑→只读：流式加载结束后按视口锚点恢复（与压缩空行切换一致） */
const pendingRestoreViewportAnchor = ref<
  import("./reader/readerViewportAnchor").ReaderViewportRestoreAnchor | null
>(null);
/** 与主进程 file:stream 的 requestId 对齐；resetSession 时清空，避免重复打开同一文件时旧 chunk 串入 */
const activeStreamRequestId = ref<number | null>(null);
const activeStreamFilePath = ref<string | null>(null);
/** 底栏路径与「在文件夹中显示」：电子书打开时为转换后的 `{原名}.txt` 路径 */
const physicalReaderPath = ref<string | null>(null);
const currentFileIsMarkdown = computed(() => {
  const p = physicalReaderPath.value ?? currentFile.value;
  return p ? isMarkdownFilePath(p) : false;
});
/** 当前文件是否已完成加载与阅读位置同步；无打开文件时为 true，打开/重置会话后为 false，流结束并完成滚动后为 true */
const readingProgressSynced = ref(true);

const readerEditMode = ref(false);
const readerEditorDirty = ref(false);
const editorContentChangeEpoch = ref(0);

const readerSaveEncoding = ref("utf8");

type ReaderEditCursorStatus = {
  line: number;
  column: number;
  selectionLength: number;
};
const readerEditCursorStatus = ref<ReaderEditCursorStatus | null>(null);

const readerEditCursorFooterLabel = computed(() => {
  if (!readerEditMode.value) return "";
  const s = readerEditCursorStatus.value;
  if (!s) return "";
  let text = `行 ${s.line}，列 ${s.column}`;
  if (s.selectionLength > 0) {
    text += ` (已选择 ${s.selectionLength})`;
  }
  return text;
});

function onReaderEditCursorChange(payload: ReaderEditCursorStatus) {
  readerEditCursorStatus.value = payload;
}

const footerEncodingActionsEnabled = computed(
  () =>
    Boolean(
      physicalReaderPath.value &&
        currentFile.value &&
        !loading.value &&
        !ebookParsing.value &&
        typeof window.colorTxt?.writeTextFile === "function",
    ),
);

/** 底栏路径菜单条目可用性（条目仍展示不可用时置灰） */
const footerPathMenuRevealEnabled = computed(
  () =>
    Boolean(
      physicalReaderPath.value ??
        currentFile.value ??
        ebookConversionSourcePath.value,
    ),
);
const footerPathMenuReloadEnabled = computed(
  () =>
    Boolean(currentFile.value && !loading.value && !ebookParsing.value),
);
/** 原始会话路径为电子书（非 txt/md）时展示「重新转换」 */
const footerPathMenuReconvertEnabled = computed(
  () =>
    Boolean(
      currentFile.value &&
        isEbookFilePath(currentFile.value) &&
        !loading.value &&
        !ebookParsing.value,
    ),
);
const footerPathMenuCloseEnabled = computed(() =>
  Boolean(currentFile.value),
);

/** 主进程 `iconv.encode` 使用的编码名 */
function normalizeIpcEncoding(raw: string): string {
  const u = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!u || u === "utf-8" || u === "utf8") return "utf8";
  if (u === "gb2312") return "gb2312";
  return raw.trim() || "utf8";
}

/** 写入磁盘：编辑模式用 Monaco 全文；只读且开压缩空行/行首缩进时用流管道物理行原文 */
function textForReaderDiskSave(): string {
  if (readerEditMode.value) {
    return readerRef.value?.getAllText() ?? "";
  }
  if (compressBlankLines.value || leadIndentFullWidth.value) {
    return stream.getPhysicalFilePlainText();
  }
  return readerRef.value?.getAllText() ?? "";
}

async function saveReaderBufferWithIpcEncoding(
  ipcEncoding: string,
): Promise<boolean> {
  const normalized = normalizeIpcEncoding(ipcEncoding);
  const p = physicalReaderPath.value;
  if (!p || !window.colorTxt?.writeTextFile) return false;
  const text = textForReaderDiskSave();
  const r = await window.colorTxt.writeTextFile(p, text, normalized);
  if (!r.ok) {
    void appAlert(r.message ?? "保存失败");
    return false;
  }
  readerSaveEncoding.value = normalized;
  fileEncoding.value = formatTextEncodingLabel(normalized);
  readerRef.value?.markReaderEditSaved?.();
  readerEditorDirty.value = false;
  return true;
}

/** 切书、关文件、编辑↔只读、关窗、退出应用等场景共用 */
const readerEditDiscardUnsavedMessageBox: ColorTxtShowMessageBoxOptions = {
  type: "warning",
  title: "修改未保存",
  buttons: ["取消", "确定"],
  defaultId: 0,
  cancelId: 0,
  message: "当前文件已修改但尚未保存，确定要放弃这些改动吗？",
  noLink: true,
};

async function confirmReaderEditDiscardUnsaved(): Promise<boolean> {
  if (!window.colorTxt?.showMessageBox) return false;
  const r = await window.colorTxt.showMessageBox(
    readerEditDiscardUnsavedMessageBox,
  );
  return r.response === 1;
}

async function confirmIfReaderEditDiscard(): Promise<boolean> {
  if (!readerEditMode.value || !readerEditorDirty.value) return true;
  return confirmReaderEditDiscardUnsaved();
}

let afterStreamFullTextInstalled: () => void | Promise<void> = async () => {};

const stream = useTxtStreamPipeline({
  readerRef,
  totalCharCount,
  totalLineCount,
  readerEditMode,
  compressBlankLines,
  compressBlankKeepOneBlank,
  leadIndentFullWidth,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  replaceRules: cachedReplaceRules,
  chapterMinCharCount,
  currentFileIsMarkdown,
  afterFullTextInstalled: () => afterStreamFullTextInstalled(),
  onReaderDisplayReady: () => {
    loading.value = false;
    loadingProgressPercent.value = null;
  },
});

/** 程序化刷新章节表期间禁止侧栏 watch 抢跑滚动（会与 centerActiveChapterInList 竞态） */
const suppressChapterListAutoScroll = ref(false);

function captureViewportAnchorPhysicalLine(): number {
  const endLine = Math.max(
    1,
    Math.floor(
      readerRef.value?.getViewportEndLine?.() ?? viewportEndLine.value,
    ),
  );
  return stream.viewportDisplayLineToPhysicalLine(endLine);
}

function captureViewportRestoreAnchor() {
  return readerRef.value?.captureViewportRestoreAnchor?.() ?? null;
}

async function withChapterListScrollSuppressed<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  suppressChapterListAutoScroll.value = true;
  try {
    return await fn();
  } finally {
    suppressChapterListAutoScroll.value = false;
  }
}

/** 侧栏文件列表是否处于编辑模式；编辑中不写文件列表缓存，退出时再落盘 */
const fileListEditing = ref(false);

const persistence = useAppPersistence({
  readerRef,
  stream,
  lastProbeLine,
  viewportEndLine,
  txtFiles,
  currentFile,
  readingProgressSynced,
  sidebarWidth,
  showSidebar,
  currentTheme,
  monacoCustomHighlight,
  compressBlankLines,
  compressBlankKeepOneBlank,
  txtrDelimitedMatchCrossLine,
  leadIndentFullWidth,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  showChapterCounts,
  chapterCharCountExact,
  readerFontSize,
  readerLineHeightMultiple,
  monacoFontFamily,
  pinnedOtherFonts,
  chapterRuleState,
  recentFiles,
  restoreSessionOnStartup,
  recentFilesHistoryLimit,
  chapterMinCharCount,
  monacoAdvancedWrapping,
  monacoSmoothScrolling,
  mouseWheelScrollSensitivity,
  fastScrollSensitivity,
  stickyChapterTitleEnabled,
  chapterNavToolbarEnabled,
  readerEditShowLineNumbers,
  readerEditMinimap,
  editAutoRefreshChapterList,
  aiSmartFormat,
  fullscreenReaderWidthPercent,
  fullscreenShowSystemTime,
  timedScrollSettings,
  pomodoroSettings,
  fileMetaRecords,
  shortcutBindings,
  defaultShortcutBindings,
  readerPaletteOverridesLight,
  readerPaletteOverridesDark,
  readerPaletteColorEnabledOverridesLight,
  readerPaletteColorEnabledOverridesDark,
  highlightColorsLight,
  highlightColorsDark,
  lineationColorsLight,
  lineationColorsDark,
  highlightWordsByIndexGlobal,
  lineationLastColors,
  ebookConvertOutputDir,
  bookPackUnpackDir,
  bookPackPassword,
  webDavEnabled,
  webDavUrl,
  webDavUsername,
  webDavRemoteDir,
  characterPortraitCacheDir,
  characterCardTextureEffect,
  fileCategory,
  fileSort,
  fileCategoryCatalog,
  fileListEditing,
  syncCurrentFile,
  aiSkillsEnabled,
  aiSkillOverrides,
  aiCustomSkills,
  aiAssistantDeepThinking,
  aiAssistantSpoilerSafe,
  wordcloudFontFamily,
  wordcloudAngleMode,
  wordcloudPaletteId,
  voiceReadSettings,
  voiceReadProfiles,
  activeVoiceReadProfileId,
});
const {
  persistSettings,
  persistSidebarWidth,
  persistVoiceReadSecretsToVault,
  clearRecentFiles,
  persistWindowUnloadState,
  persistFileListCache,
  persistFileMeta,
  persistRecentFiles,
  touchRecentFile,
  upsertBookmark,
  removeBookmark,
  clearBookmarks,
  initPersistenceBootstrap,
  applyRecentFilesHistoryLimitFromSettings,
  clearPersistedSession,
  metaProgressByPathKey,
  loadPersistedSettings,
} = persistence;

watch(fileListEditing, (editing, wasEditing) => {
  if (wasEditing === true && editing === false) {
    persistFileListCache();
  }
});

watch(aiAssistantDeepThinking, () => persistSettings());
watch(aiAssistantSpoilerSafe, () => persistSettings());
watch(wordcloudAngleMode, () => persistSettings());
watch(wordcloudPaletteId, () => persistSettings());
watch(wordcloudFontFamily, () => persistSettings());
watch(characterCardTextureEffect, () => persistSettings());
watch(
  voiceReadSettings,
  () => persistSettings(),
  { deep: true },
);
watch(
  timedScrollSettings,
  () => persistSettings(),
  { deep: true },
);
watch(
  voiceReadProfiles,
  () => persistSettings(),
  { deep: true },
);
watch(activeVoiceReadProfileId, () => persistSettings());
watch(
  voiceReadAiSpeakerTokenUsage,
  () => persistSettings(),
  { deep: true },
);
watch(voiceReadAiSpeakerTokenUsageAvailable, () => persistSettings());

/** 加载期底栏/侧栏：当前文件的存档进度仅来自 file.meta */
const archivedProgressForCurrentFile = computed(() => {
  const cur = currentFile.value;
  if (!cur) return undefined;
  const key = fileHistoryKey(cur);
  const fromMap = metaProgressByPathKey.value.get(key);
  if (typeof fromMap === "number" && Number.isFinite(fromMap)) {
    return fromMap;
  }
  return undefined;
});

const { readingProgressParts } = useAppReadingProgress({
  totalLineCount,
  viewportTopLine,
  viewportEndLine,
  viewportVisualProgressPercent,
  currentFile,
  loading,
  readingProgressSynced,
  archivedProgressPercentForCurrentFile: archivedProgressForCurrentFile,
  physicalProgress: stream,
});

/** 与底栏 `readingProgressParts.percentValue` 一致，加载期用存档或 0%，避免当前行不显示 */
const liveReadingProgressForUi = computed<number | undefined>(() => {
  const v = readingProgressParts.value.percentValue;
  return typeof v === "number" ? v : undefined;
});

function onPersistUi() {
  persistSettings();
}

function onSetFilesCategory(paths: string[], category: string) {
  const set = new Set(paths);
  const cat = category.trim() ? category.trim() : undefined;
  const list = txtFiles.value;
  for (let i = 0; i < list.length; i++) {
    const f = list[i]!;
    if (!set.has(f.path)) continue;
    if (cat) {
      if (f.category === cat) continue;
      /** 原地改 `category`，保持对象引用，减少分配且仍能触发深度响应更新 */
      f.category = cat;
    } else {
      if (f.category === undefined) continue;
      delete f.category;
    }
  }
  if (!fileListEditing.value) {
    persistFileListCache();
  }
}

/** 侧栏筛选为具体分类时，新加入列表的文件自动归入该分类 */
function applyCurrentFileCategoryToNewPaths(paths: string[]) {
  const fc = fileCategory.value;
  if (
    fc === FILE_CATEGORY_FILTER_ALL ||
    fc === FILE_CATEGORY_FILTER_UNCATEGORIZED ||
    paths.length === 0
  ) {
    return;
  }
  onSetFilesCategory(paths, fc);
}

function onApplyCategoryCatalog(payload: {
  initial: CategoryEditorRow[];
  draft: CategoryEditorRow[];
  catalog: FileCategoryDefinition[];
}) {
  txtFiles.value = syncTxtFilesCategoriesAfterCatalogEdit(
    txtFiles.value,
    payload.initial,
    payload.draft,
  );
  fileCategoryCatalog.value = payload.catalog.map((c) => ({ ...c }));
  const fc = fileCategory.value;
  if (
    fc !== FILE_CATEGORY_FILTER_ALL &&
    fc !== FILE_CATEGORY_FILTER_UNCATEGORIZED &&
    !payload.catalog.some((c) => c.name === fc)
  ) {
    fileCategory.value = FILE_CATEGORY_FILTER_ALL;
  }
  if (!fileListEditing.value) {
    persistFileListCache();
  }
  persistSettings();
}

function replaceFileBaseName(filePath: string, newBaseName: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (idx < 0) return newBaseName;
  return `${filePath.slice(0, idx + 1)}${newBaseName}`;
}

async function onRenameFilePath(payload: { oldPath: string; newName: string }) {
  const oldPath = payload.oldPath.trim();
  const newName = payload.newName.trim();
  if (!oldPath || !newName) return;
  const targetPath = replaceFileBaseName(oldPath, newName);
  if (fileHistoryKey(targetPath) === fileHistoryKey(oldPath)) return;
  const result = await window.colorTxt.renamePath(oldPath, targetPath);
  if (!result.ok) {
    await appAlert(`重命名失败：${result.message}`);
    return;
  }

  const nextPath = result.path;
  const oldKey = fileHistoryKey(oldPath);
  const nextKey = fileHistoryKey(nextPath);
  txtFiles.value = txtFiles.value.map((f) => {
    if (fileHistoryKey(f.path) !== oldKey) return f;
    return normalizeTxtFileItem({
      ...f,
      path: nextPath,
      size: result.size,
    });
  });

  recentFiles.value = recentFiles.value.map((item) =>
    fileHistoryKey(item.path) === oldKey ? { ...item, path: nextPath } : item,
  );

  // file.meta 迁移：优先按旧路径精确匹配；若不存在再按旧文件名兜底（仅唯一候选时迁移，避免同名串数据）。
  let prevMeta = fileMetaRecords.value.find(
    (m) => fileHistoryKey(m.path) === oldKey,
  );
  if (!prevMeta) {
    const oldNameKey = fileNameKey(oldPath);
    const fallbackCandidates = fileMetaRecords.value.filter(
      (m) => m.fileName === oldNameKey,
    );
    if (fallbackCandidates.length === 1) {
      prevMeta = fallbackCandidates[0];
    }
  }
  if (prevMeta) {
    const prevMetaKey = fileHistoryKey(prevMeta.path);
    const migrated: FileMetaRecord = {
      ...prevMeta,
      path: nextPath,
      fileName: fileNameKey(nextPath),
      updatedAt: Date.now(),
    };
    fileMetaRecords.value = [
      migrated,
      ...fileMetaRecords.value.filter((m) => {
        const k = fileHistoryKey(m.path);
        if (k === prevMetaKey) return false;
        if (k === oldKey) return false;
        if (k === nextKey) return false;
        return true;
      }),
    ];
  }

  // 进度映射 key 基于 path，重命名后需迁移，否则 UI 可能仍引用旧路径进度。
  if (metaProgressByPathKey.value.has(oldKey)) {
    const m = new Map(metaProgressByPathKey.value);
    const v = m.get(oldKey);
    m.delete(oldKey);
    if (typeof v === "number") m.set(nextKey, v);
    metaProgressByPathKey.value = m;
  }

  if (currentFile.value && fileHistoryKey(currentFile.value) === oldKey) {
    currentFile.value = nextPath;
  }
  if (
    physicalReaderPath.value &&
    fileHistoryKey(physicalReaderPath.value) === oldKey
  ) {
    physicalReaderPath.value = nextPath;
  }
  if (
    activeStreamFilePath.value &&
    fileHistoryKey(activeStreamFilePath.value) === oldKey
  ) {
    activeStreamFilePath.value = nextPath;
  }

  persistFileListCache();
  persistRecentFiles();
  // 落盘时机保持原有策略：走现有防抖 + 门控；窗口卸载仍会兜底立即落盘。
  persistFileMeta();
}

async function migratePortraitBookDirIfNeeded(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const oldSeg = sanitizeBookFolderSegment(oldPath);
  const newSeg = sanitizeBookFolderSegment(newPath);
  if (!oldSeg || oldSeg === newSeg) return;
  try {
    const rootRaw = characterPortraitCacheDir.value.trim();
    const root =
      rootRaw ||
      (await window.colorTxt.getDefaultCharacterPortraitCacheDir());
    if (!root?.trim()) return;
    const from = characterPortraitBookDirAbs(root.trim(), oldSeg);
    const to = characterPortraitBookDirAbs(root.trim(), newSeg);
    let st;
    try {
      st = await window.colorTxt.stat(from);
    } catch {
      return;
    }
    if (!st.isDirectory) return;
    const mig = await window.colorTxt.characterPortrait.migrateCacheRoot({
      from,
      to,
    });
    if (!mig.ok) {
      console.warn("migrate portrait book dir failed", mig.error);
    }
  } catch (e) {
    console.warn("migrate portrait book dir failed", e);
  }
}

/**
 * 侧栏「替换文件」：用另一个 txt/md 路径替换列表项，继承原阅读数据（书签/高亮/笔记/角色卡/进度等）。
 */
async function onReplaceFilePath(oldPathRaw: string) {
  const oldPath = oldPathRaw.trim();
  if (!oldPath || !isPlainTextBookPath(oldPath)) return;
  if (!window.colorTxt) {
    await appAlert("preload 未注入：请重启应用（或检查主进程 preload 路径）");
    return;
  }

  const r = await window.colorTxt.showOpenDialog({
    title: "选择替换文件",
    properties: ["openFile"],
    filters: [
      { name: "文本", extensions: ["txt", "md"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (r.canceled || r.filePaths.length === 0) return;
  const newPath = (r.filePaths[0] ?? "").trim();
  if (!newPath) return;
  if (!isPlainTextBookPath(newPath)) {
    await appAlert("请选择 txt 或 md 文件。");
    return;
  }

  const oldKey = fileHistoryKey(oldPath);
  const nextKey = fileHistoryKey(newPath);
  if (oldKey === nextKey) return;

  const newName = fileNameKey(newPath);

  let size = 0;
  try {
    const st = await window.colorTxt.stat(newPath);
    if (!st.isFile) {
      await appAlert("所选路径不是有效文件。");
      return;
    }
    size = typeof st.size === "number" ? st.size : 0;
  } catch {
    await appAlert("无法读取所选文件。");
    return;
  }

  const wasOpen =
    Boolean(currentFile.value) &&
    fileHistoryKey(currentFile.value!) === oldKey;

  txtFiles.value = txtFiles.value
    .filter((f) => {
      const k = fileHistoryKey(f.path);
      // 若新路径已在列表中，去掉旧的那条，避免重复
      if (k === nextKey && k !== oldKey) return false;
      return true;
    })
    .map((f) => {
      if (fileHistoryKey(f.path) !== oldKey) return f;
      return normalizeTxtFileItem({
        ...f,
        path: newPath,
        size,
      });
    });

  recentFiles.value = recentFiles.value.map((item) =>
    fileHistoryKey(item.path) === oldKey ? { ...item, path: newPath } : item,
  );

  let prevMeta = fileMetaRecords.value.find(
    (m) => fileHistoryKey(m.path) === oldKey,
  );
  if (!prevMeta) {
    const fallbackCandidates = fileMetaRecords.value.filter(
      (m) => m.fileName === fileNameKey(oldPath),
    );
    if (fallbackCandidates.length === 1) {
      prevMeta = fallbackCandidates[0];
    }
  }
  if (prevMeta) {
    const prevMetaKey = fileHistoryKey(prevMeta.path);
    const migrated: FileMetaRecord = {
      ...prevMeta,
      path: newPath,
      fileName: fileNameKey(newPath),
      // 纯文本替换不沿用电子书转换缓存路径
      convertedMdPath: undefined,
      sourceMtimeMsAtConvert: undefined,
      updatedAt: Date.now(),
    };
    fileMetaRecords.value = [
      migrated,
      ...fileMetaRecords.value.filter((m) => {
        const k = fileHistoryKey(m.path);
        if (k === prevMetaKey) return false;
        if (k === oldKey) return false;
        if (k === nextKey) return false;
        return true;
      }),
    ];
  } else {
    // 原项无阅读数据：去掉可能挂在旧路径上的空壳，保留新路径已有 meta（若有）
    fileMetaRecords.value = fileMetaRecords.value.filter(
      (m) => fileHistoryKey(m.path) !== oldKey,
    );
  }

  if (metaProgressByPathKey.value.has(oldKey)) {
    const m = new Map(metaProgressByPathKey.value);
    const v = m.get(oldKey);
    m.delete(oldKey);
    m.delete(nextKey);
    if (typeof v === "number") m.set(nextKey, v);
    metaProgressByPathKey.value = m;
  } else if (metaProgressByPathKey.value.has(nextKey) && prevMeta) {
    // 已用旧 meta 覆盖新路径时，清掉仅属于新路径旧进度的映射（进度在 meta 内）
    const m = new Map(metaProgressByPathKey.value);
    if (typeof prevMeta.progress === "number") {
      m.set(nextKey, prevMeta.progress);
    }
    metaProgressByPathKey.value = m;
  }

  await migratePortraitBookDirIfNeeded(oldPath, newPath);

  persistFileListCache();
  persistRecentFiles();
  persistFileMeta();

  if (wasOpen) {
    await openFilePath(newPath, { keepSidebarTab: true });
  } else {
    if (
      physicalReaderPath.value &&
      fileHistoryKey(physicalReaderPath.value) === oldKey
    ) {
      physicalReaderPath.value = newPath;
    }
    if (
      activeStreamFilePath.value &&
      fileHistoryKey(activeStreamFilePath.value) === oldKey
    ) {
      activeStreamFilePath.value = newPath;
    }
  }

  appToast(`已替换为「${newName}」`, { kind: "success" });
}

function onOpenFileInNewWindow(path: string) {
  if (!path.trim()) return;
  window.colorTxt.openFileInNewWindow(path);
}

function onClearFileMeta(path: string) {
  const key = fileHistoryKey(path);
  const next = fileMetaRecords.value.filter(
    (m) => fileHistoryKey(m.path) !== key,
  );
  if (next.length === fileMetaRecords.value.length) return;
  fileMetaRecords.value = next;
  if (metaProgressByPathKey.value.has(key)) {
    const m = new Map(metaProgressByPathKey.value);
    m.delete(key);
    metaProgressByPathKey.value = m;
  }
  persistFileMeta();
}

function metaHasClearableReadingData(rec: FileMetaRecord | undefined): boolean {
  if (!rec) return false;
  if ((rec.bookmarks?.length ?? 0) > 0) return true;
  if (rec.highlightWordsByIndex && Object.keys(rec.highlightWordsByIndex).length)
    return true;
  if ((rec.readerAnnotations?.length ?? 0) > 0) return true;
  if ((rec.characterRoster?.length ?? 0) > 0) return true;
  if (rec.characterBookStyle) return true;
  if (typeof rec.progress === "number") return true;
  if (rec.editorViewState != null) return true;
  if (typeof rec.viewportTopPhysicalLine === "number") return true;
  return false;
}

const showReadingDataPanel = ref(false);

const readingDataItems = computed(() => {
  const live = liveReadingProgressForUi.value;
  const cur = currentFile.value;
  const curKey = cur ? fileHistoryKey(cur) : "";
  const progressMap = metaProgressByPathKey.value;
  const rows = fileMetaRecords.value
    .filter((m) => metaHasClearableReadingData(m))
    .map((m) => {
      const k = fileHistoryKey(m.path);
      let progress: number | undefined;
      if (curKey && k === curKey && typeof live === "number") {
        progress = live;
      } else if (typeof m.progress === "number" && Number.isFinite(m.progress)) {
        progress = m.progress;
      } else {
        progress = progressMap.get(k);
      }
      const normalized = m.path.replace(/\\/g, "/");
      const slash = normalized.lastIndexOf("/");
      const fileName =
        slash >= 0 ? normalized.slice(slash + 1) : normalized || m.path;
      return {
        path: m.path,
        fileName,
        progress,
        lastOpenedAt: m.lastOpenedAt,
      };
    });
  return rows;
});

async function removePortraitCacheForBook(bookPath: string) {
  try {
    const rootRaw = characterPortraitCacheDir.value.trim();
    const root =
      rootRaw ||
      (await window.colorTxt.getDefaultCharacterPortraitCacheDir());
    if (root?.trim()) {
      const bookDir = characterPortraitBookDirAbs(
        root.trim(),
        sanitizeBookFolderSegment(bookPath),
      );
      await window.colorTxt.removePath(bookDir);
    }
  } catch {
    /* 目录不存在或删除失败不阻断清除 meta */
  }
}

/**
 * 清除若干路径的阅读数据（进度/书签/高亮/笔记/角色卡及立绘）。
 * 保留电子书转换路径等空壳 meta；不关闭当前打开的文件。
 */
async function clearReadingDataForPaths(
  paths: string[],
  options?: { toast?: boolean },
): Promise<boolean> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = raw?.trim();
    if (!p) continue;
    const k = normalizeFileMetaPathKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }
  if (unique.length === 0) return false;

  let anyCleared = false;
  let touchedCurrent = false;
  const cur = currentFile.value?.trim() ?? "";
  const curKey = cur ? normalizeFileMetaPathKey(cur) : "";

  for (const path of unique) {
    const key = fileHistoryKey(path);
    const pathKey = normalizeFileMetaPathKey(path);
    const shown = findFileMetaRecord(fileMetaRecords.value, path);
    const hadProgress = metaProgressByPathKey.value.has(key);
    if (!metaHasClearableReadingData(shown) && !hadProgress) continue;

    await removePortraitCacheForBook(path);

    const prevExact =
      fileMetaRecords.value.find(
        (m) => normalizeFileMetaPathKey(m.path) === pathKey,
      ) ?? null;
    const withoutExact = fileMetaRecords.value.filter(
      (m) => normalizeFileMetaPathKey(m.path) !== pathKey,
    );
    const cleared: FileMetaRecord = {
      path: prevExact?.path ?? path,
      fileName: fileNameKey(prevExact?.path ?? path),
      bookmarks: [],
      updatedAt: Date.now(),
    };
    if (prevExact?.convertedMdPath)
      cleared.convertedMdPath = prevExact.convertedMdPath;
    if (prevExact?.sourceMtimeMsAtConvert != null) {
      cleared.sourceMtimeMsAtConvert = prevExact.sourceMtimeMsAtConvert;
    }
    if (prevExact?.lastOpenedAt != null) {
      cleared.lastOpenedAt = prevExact.lastOpenedAt;
    }
    fileMetaRecords.value = [cleared, ...withoutExact];

    if (metaProgressByPathKey.value.has(key)) {
      const m = new Map(metaProgressByPathKey.value);
      m.delete(key);
      metaProgressByPathKey.value = m;
    }
    anyCleared = true;
    if (curKey && pathKey === curKey) touchedCurrent = true;
  }

  if (!anyCleared) {
    if (options?.toast !== false) {
      appToast("没有可清除的阅读数据", { kind: "info" });
    }
    return false;
  }

  persistFileMeta();
  if (touchedCurrent) {
    void refreshReaderHighlightDisplayLayer();
    bumpAnnotationDisplayEpoch();
  }
  if (options?.toast !== false) {
    appToast("已清除阅读数据", { kind: "success" });
  }
  return true;
}

async function clearCurrentFileReadingData() {
  const path = currentFile.value?.trim();
  if (!path) {
    await appAlert("请先打开文件");
    return;
  }
  const ok = await appConfirm(
    "将清除当前文件的阅读进度、书签、高亮词、笔记、角色卡（含立绘）等数据；不会删除文件本身。",
    "清除阅读数据",
  );
  if (!ok) return;
  await clearReadingDataForPaths([path]);
}

async function onClearReadingDataPaths(paths: string[]) {
  await clearReadingDataForPaths(paths);
}

async function onClearAllReadingData() {
  const paths = readingDataItems.value.map((i) => i.path);
  if (paths.length === 0) {
    appToast("没有可清除的阅读数据", { kind: "info" });
    return;
  }
  const ok = await appConfirm(
    "将清除全部文件的阅读进度、书签、高亮词、笔记、角色卡（含立绘）等数据；不会删除文件本身。",
    "清空阅读数据",
  );
  if (!ok) return;
  await clearReadingDataForPaths(paths);
}

async function onRemoveMissingReadingDataFiles() {
  const paths = readingDataItems.value.map((i) => i.path);
  if (paths.length === 0) {
    appToast("没有可清除的阅读数据", { kind: "info" });
    return;
  }
  const missing: string[] = [];
  for (const p of paths) {
    try {
      // file:stat 对 ENOENT 返回 isFile/isDirectory 均为 false，不抛错
      const st = await window.colorTxt.stat(p);
      if (!st.isFile) missing.push(p);
    } catch {
      missing.push(p);
    }
  }
  if (missing.length === 0) {
    appToast("没有失效文件", { kind: "info" });
    return;
  }
  await clearReadingDataForPaths(missing);
}

function openReadingDataPanel() {
  showReadingDataPanel.value = true;
}

/** 顶栏「更多」里最近文件：仅路径来自 recent，进度来自 meta（当前书用 live） */
const recentFilesForMenu = computed<RecentFileItem[]>(() => {
  const map = metaProgressByPathKey.value;
  const live = liveReadingProgressForUi.value;
  const cur = currentFile.value;
  const curKey = cur ? fileHistoryKey(cur) : "";
  return recentFiles.value.map((item) => {
    const k = fileHistoryKey(item.path);
    let progress: number | undefined;
    if (curKey && k === curKey && typeof live === "number") {
      progress = live;
    } else {
      progress = map.get(k);
    }
    return { path: item.path, progress };
  });
});

void initPersistenceBootstrap().catch(() => {
  // 启动引导失败时不阻断应用；目录兜底见 useAppPersistence
});

const {
  pinActive,
  canPin,
  canBookmark,
  addBookmarkOpen,
  removeBookmarkOpen,
  bookmarkNoteInput,
  bookmarkNoteInputRef,
  editingBookmarkLine,
  activeBookmarkInViewport,
  activeBookmarkLine,
  bookmarkActive,
  bookmarkListItems,
  currentFileBookmarks,
  addBookmarkDialogPreview,
  onPinClick,
  ensurePinBeforeRevealFindWidget,
  onGoBackFromPin,
  onBookmarkClick,
  confirmAddBookmark,
  updateEditingBookmarkToCurrentViewportLine,
  confirmRemoveActiveBookmark,
  jumpToBookmark,
  clearCurrentFileBookmarks,
  removeCurrentFileBookmarks,
  onEditBookmark,
  onRemoveBookmark,
} = useAppBookmarkPins({
  readerRef,
  stream,
  readerEditMode,
  currentFile,
  loading,
  totalLineCount,
  fileMetaRecords,
  lastProbeLine,
  viewportEndLine,
  sidebarTab,
  pulseBookmarkListCenter,
  upsertBookmark,
  removeBookmark,
  clearBookmarks,
  chapters,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  compressBlankLines,
  leadIndentFullWidth,
});

provide(bookmarkNoteInputRefKey, bookmarkNoteInputRef);

const fileSession = useAppFileSession({
  readerRef,
  readerSidebarRef,
  stream,
  persistence,
  chapterSync,
  currentFile,
  loading,
  loadingProgressPercent,
  dirListScanning,
  dirListCurrentName,
  fileEncoding,
  currentFileSize,
  totalCharCount,
  totalLineCount,
  chapters,
  activeChapterIdx,
  sidebarTab,
  txtFiles,
  lastProbeLine,
  viewportTopLine,
  viewportEndLine,
  pendingRestorePhysicalLine,
  pendingRestoreEditorViewState,
  pendingRestoreViewportTopPhysicalLine,
  pendingRestoreViewportAnchor,
  recentFiles,
  restoreSessionOnStartup,
  activeStreamRequestId,
  activeStreamFilePath,
  physicalReaderPath,
  readingProgressSynced,
  ebookConvertOutputDir,
  ebookParsing,
  bookPackUnpacking,
  ebookConversionSourcePath,
  fileMetaRecords,
  bookPackUnpackDir,
  bookPackPassword,
  characterPortraitCacheDir,
  applyCurrentFileCategoryIfConcrete: applyCurrentFileCategoryToNewPaths,
  readerEditMode,
  readerEditorDirty,
  confirmIfReaderEditDiscard,
});

const {
  clearFileList,
  clearFileListForCategory,
  removeFileList,
  closeCurrentFile,
  openFileViaDialog,
  openFileFromSidebar,
  pickTxtDirectory,
  pickTxtFilesIntoFileList,
  importPathsIntoFileList,
  openFilePath,
  openRecentFileFromHistory,
} = fileSession;

useAppSyncCurrentFileWatch({
  syncCurrentFile,
  physicalReaderPath,
  currentFile,
  loading,
  readingProgressSynced,
  ebookParsing,
  readerEditMode,
  stream,
  viewportEndLine,
  openFilePath,
});

async function onImportDroppedPathsFromList(paths: string[]) {
  readerDropOverlayVisible.value = false;
  await importPathsIntoFileList(paths);
}

const footerPathCaption = computed(() => {
  if (ebookParsing.value && ebookConversionSourcePath.value) {
    return ebookConversionSourcePath.value;
  }
  return physicalReaderPath.value ?? currentFile.value ?? "";
});

const chapterNav = useAppChapterNavigation({
  readerRef,
  chapters,
  activeChapterIdx,
  lastProbeLine,
  viewportTopLine,
  viewportEndLine,
  currentFile,
  currentFileIsMarkdown,
  readerEditMode,
  readingProgressSynced,
  stream,
  touchRecentFile,
  chapterListScrollSmooth,
  chapterRuleState,
  chapterMinCharCount,
  chapterRuleErrorText,
  showChapterRulePanel,
  sidebarTab,
  persistSettings,
  compressBlankLines,
  leadIndentFullWidth,
  captureViewportRestoreAnchor,
  captureViewportAnchorPhysicalLine,
  withChapterListScrollSuppressed,
  onAfterChapterListRefresh: async () => {
    await nextTick();
    await readerSidebarRef.value?.centerActiveChapterInList?.(false);
  },
});

/** 视口已按物理行恢复且 probe 已更新后：重算章节并居中侧栏（加载结束等） */
async function syncChaptersAfterViewportSettled() {
  try {
    await chapterNav.refreshChapterListFromReaderAsync?.();
    await nextTick();
    await readerSidebarRef.value?.centerActiveChapterInList?.(false);
  } finally {
    // 退出编辑后 openFilePath 会保持 suppress 直至流式加载结束；此处解除以恢复滚动换章居中
    suppressChapterListAutoScroll.value = false;
  }
}

const {
  jumpToChapter,
  jumpToPrevChapter,
  jumpToNextChapter,
  onProbeLineChange,
  applyChapterMatchRules,
} = chapterNav;

const {
  mode: voiceReadMode,
  isSynthesizing: voiceReadSynthesizing,
  synthesizingPhase: voiceReadSynthesizingPhase,
  toolbarRate: voiceReadToolbarRate,
  toolbarVolume: voiceReadToolbarVolume,
  setToolbarVolume: setVoiceReadToolbarVolume,
  canStartVoiceRead: canVoiceRead,
  isVoiceReadActive,
  isVoiceReadScrollLocked,
  isVoiceReadBlocksFind,
  isVoiceReadHeaderLocked,
  isVoiceReadNavigationBlocked,
  toggleVoiceReadToolbar,
  togglePlayPause: voiceReadTogglePlayPause,
  exitVoiceRead,
  playPrevLine: voiceReadPlayPrevLine,
  playNextLine: voiceReadPlayNextLine,
  regenerateCurrentLine: voiceReadRegenerateCurrentLine,
  canPlayPrevLine: voiceReadCanPlayPrevLine,
  canPlayNextLine: voiceReadCanPlayNextLine,
} = useAppVoiceRead({
  readerRef,
  voiceReadSettings,
  voiceReadProfiles,
  activeVoiceReadProfileId,
  currentFile,
  loading,
  readerEditMode,
  monacoSmoothScrolling,
  aiFeaturesEnabled,
  characterRoster: currentFileCharacterRoster,
});

const {
  searchQuery,
  searchResults,
  searchInProgress,
  activeSearchResult,
  hasInlineSearchHighlight,
  searchMatchCase,
  searchWholeWord,
  searchUseRegex,
  scheduleSidebarSearch,
  clearReaderInlineSearchHighlight,
  onJumpToSearchResult,
} = useAppSidebarSearch({
  readerRef,
  stream,
  currentFile,
  loading,
  totalLineCount,
  readerEditMode,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  compressBlankLines,
  leadIndentFullWidth,
  isVoiceReadNavigationBlocked,
  ensurePinBeforeRevealFindWidget,
});

const {
  readerDisplayHighlightWordsByIndex,
  readerDisplayHighlightWordsBookOnly,
  currentFileHighlightTerms,
  refreshReaderHighlightDisplayLayer,
  onAddHighlightTerm,
  onAddHighlightTermFromSidebar,
  onRemoveHighlightTerm,
  onFavoriteHighlightTerm,
  onUnfavoriteHighlightTerm,
  clearCurrentFileHighlightTerms,
  onExportBookHighlightsJson,
  onImportBookHighlightsJson,
  onExportFavoriteHighlightsJson,
  onImportFavoriteHighlightsJson,
  onFindHighlightTermFromSidebar,
} = useAppHighlightTerms({
  readerRef,
  currentFile,
  loading,
  totalLineCount,
  readerEditMode,
  fileMetaRecords,
  highlightWordsByIndexGlobal,
  highlightColorsForReader,
  currentTheme,
  readerSurfaceLight,
  readerSurfaceDark,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  persistFileMeta,
  persistSettings,
  isVoiceReadNavigationBlocked,
  ensurePinBeforeRevealFindWidget,
  hasInlineSearchHighlight,
  editorContentChangeEpoch,
});

const {
  currentFileAnnotations,
  annotationListGroups,
  bumpAnnotationDisplayEpoch,
  revalidateCurrentFileAnnotations,
  refreshCurrentFileAnnotationDisplayTexts,
  onUpsertReaderAnnotation,
  onRemoveReaderAnnotation,
  onClearStaleReaderAnnotations,
  onJumpToReaderAnnotation,
  onClearReaderAnnotationsWithConfirm,
  onExportAnnotationsMd,
  onExportAnnotationsJson,
  onImportAnnotationsJson,
} = useAppReaderAnnotations({
  readerRef,
  stream,
  currentFile,
  readerEditMode,
  fileMetaRecords,
  chapters,
  leadIndentFullWidth,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  compressBlankLines,
  persistFileMeta,
  isVoiceReadNavigationBlocked,
});

afterStreamFullTextInstalled = async () => {
  await new Promise<void>((resolve) => {
    const ric = (
      globalThis as typeof globalThis & {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") {
      ric(() => resolve(), { timeout: 120 });
    } else {
      window.setTimeout(resolve, 16);
    }
  });
  const imgAnchors = await readerRef.value?.applyEmbeddedImageAnchors(
    physicalReaderPath.value,
  );
  // 插图删行会改变 Monaco 行数；须同步 display↔physical 映射（含未压缩空行），否则内链跳转错位。
  if (imgAnchors?.deletedOriginalLineNumbersDesc?.length) {
    stream.removeFilteredDisplayLinesAtOriginalIndices(
      imgAnchors.deletedOriginalLineNumbersDesc,
    );
  }
  if (imgAnchors?.deletedOriginalLineNumbersDesc?.length) {
    readerRef.value?.shiftPendingEbookSidecarForDeletedDisplayLines?.(
      imgAnchors.deletedOriginalLineNumbersDesc,
    );
  }
  stream.resyncFormattedDisplayLinesFromReader?.();
  if (currentFileIsMarkdown.value && !readerEditMode.value) {
    await readerRef.value?.applyMarkdownInternalLinks?.();
  }
  stream.resyncMirrorFromReader();
  revalidateCurrentFileAnnotations();
  refreshCurrentFileAnnotationDisplayTexts();
  bumpAnnotationDisplayEpoch();
  readerRef.value?.refreshReaderAnnotationDecorations?.();
};

const {
  isTimedScrollActive,
  canStartTimedScroll,
  toggleTimedScroll,
} = useAppTimedScroll({
  readerRef,
  timedScrollSettings,
  currentFile,
  loading,
  readerEditMode,
  viewportAtBottom,
  isVoiceReadActive,
});

function onVoiceReadToggle() {
  if (!isVoiceReadActive.value && isTimedScrollActive.value) return;
  toggleVoiceReadToolbar();
}

function guardReaderNavigation(action: () => void): void {
  if (isVoiceReadNavigationBlocked.value) return;
  action();
}

function onJumpToChapterFromSidebar(ch: Chapter) {
  guardReaderNavigation(() => jumpToChapter(ch));
}

function jumpToBookmarkWithVoiceRead(line: number) {
  guardReaderNavigation(() => jumpToBookmark(line));
}

function jumpToPrevChapterWithVoiceRead() {
  guardReaderNavigation(() => jumpToPrevChapter());
}

function jumpToNextChapterWithVoiceRead() {
  guardReaderNavigation(() => jumpToNextChapter());
}

const showReaderChapterNav = computed(
  () =>
    chapterNavToolbarEnabled.value &&
    Boolean(currentFile.value) &&
    chapters.value.length > 1,
);

const readerChapterNavUiVisible = computed(
  () => showReaderChapterNav.value && !isVoiceReadActive.value,
);

const readerChapterNavVisible = computed(
  () =>
    readerChapterNavUiVisible.value &&
    (!isFullscreenView.value || showFullscreenFooter.value),
);

const readerChapterNavBusy = computed(
  () => loading.value || isVoiceReadNavigationBlocked.value,
);

const readerChapterNavActiveIdx = computed(() => {
  if (activeChapterIdx.value >= 0) return activeChapterIdx.value;
  return pickActiveChapterIdx(chapters.value, lastProbeLine.value);
});

const readerChapterNavCanPrev = computed(
  () => showReaderChapterNav.value && readerChapterNavActiveIdx.value > 0,
);

const readerChapterNavCanNext = computed(() => {
  if (!showReaderChapterNav.value) return false;
  const idx = readerChapterNavActiveIdx.value;
  if (idx === -1) return true;
  return idx + 1 < chapters.value.length;
});

const canEnterReaderEditMode = computed(
  () =>
    Boolean(currentFile.value) &&
    !loading.value &&
    readingProgressSynced.value &&
    !ebookParsing.value,
);

/** 编辑态侧栏是否显示「刷新章节」（自动刷新不可用或已关闭时需手动刷新） */
const showEditChapterRefreshButton = computed(
  () =>
    readerEditMode.value &&
    (!editAutoRefreshChapterList.value ||
      totalLineCount.value > editAutoRefreshChapterListMaxLines),
);

function applyChaptersFromReaderPlainText() {
  if (!readerEditMode.value) return;
  chapterNav.refreshChapterListFromReader();
}

async function onToggleReaderEdit() {
  if (readerEditMode.value && aiSmartFormatReviewSession.value) {
    appToast("排版预览进行中，请先点击「应用」或「放弃」。", { kind: "info" });
    return;
  }
  if (readerEditMode.value) {
    if (readerEditorDirty.value) {
      if (!(await confirmReaderEditDiscardUnsaved())) return;
    }
    readerEditorDirty.value = false;
    const path = currentFile.value;
    if (!path) {
      readerEditMode.value = false;
      return;
    }
    const exitAnchor = readerRef.value?.captureViewportRestoreAnchor?.() ?? {
      physicalLine: Math.max(
        1,
        Math.floor(
          readerRef.value?.getViewportEndLine?.() ?? viewportEndLine.value,
        ),
      ),
      wrappedLineIndex: 0,
    };
    suppressChapterListAutoScroll.value = true;
    readerEditMode.value = false;
    const opened = await openFilePath(path, {
      restoreViewportAnchor: exitAnchor,
      skipRememberCurrent: true,
      keepSidebarTab: true,
      skipReaderEditGuard: true,
    });
    if (!opened) {
      suppressChapterListAutoScroll.value = false;
    }
    // 成功时保持 suppress，待流式加载结束 syncChapters 后解除
  } else {
    if (!canEnterReaderEditMode.value) {
      appToast("请等待当前文件加载完成后再进入编辑模式。", { kind: "info" });
      return;
    }
    pendingReaderEditRestoreAnchor.value =
      captureViewportRestoreAnchor() ?? {
        physicalLine: captureViewportAnchorPhysicalLine(),
        wrappedLineIndex: 0,
      };
    suppressChapterListAutoScroll.value = true;
    readerEditMode.value = true;
  }
}

async function onSaveReaderFile() {
  void (await saveReaderBufferWithIpcEncoding(readerSaveEncoding.value));
}

async function runEditFormatWithChapterSync(
  format: () => Promise<boolean | undefined> | boolean | undefined,
) {
  if (!readerEditMode.value) return;
  await withChapterListScrollSuppressed(async () => {
    const changed = await format();
    if (changed) await syncChaptersAfterViewportSettled();
  });
}

function onFormatEditCompressBlankLines() {
  if (aiSmartFormatReviewSession.value) {
    readerRef.value?.applySmartFormatReviewCompressBlankLines?.(
      compressBlankKeepOneBlank.value,
    );
    return;
  }
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatCompressBlankLines?.(
      compressBlankKeepOneBlank.value,
    ),
  );
}

function onFormatEditLeadIndentFullWidth() {
  if (aiSmartFormatReviewSession.value) {
    readerRef.value?.applySmartFormatReviewLeadIndentFullWidth?.();
    return;
  }
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatLeadIndentFullWidth?.(),
  );
}

function onApplyTextConvertZhEdit(mode: Exclude<TextConvertZhMode, "off">) {
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatTextConvertZh?.(mode),
  );
}

function onApplyTextConvertLetterEdit(
  mode: Exclude<TextConvertWidthMode, "off">,
) {
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatTextConvertLetters?.(mode),
  );
}

function onApplyTextConvertDigitEdit(
  mode: Exclude<TextConvertWidthMode, "off">,
) {
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatTextConvertDigits?.(mode),
  );
}

function onApplyReplaceRuleFormat(rules: ReplaceRule[]) {
  void runEditFormatWithChapterSync(() =>
    readerRef.value?.applyEditFormatTextReplace?.(rules),
  );
}

const smartFormatCtl = useAiSmartFormat({
  readerRef,
  chapters,
  aiSmartFormat,
  aiFeaturesEnabled,
  aiSkillOverrides,
  compressBlankKeepOneBlank,
  runEditFormatWithChapterSync,
  onReaderEditDirty: () => {
    onReaderEditContentChange();
  },
  resyncMirrorFromReader: () => stream.resyncMirrorFromReader(),
});
const {
  running: aiSmartFormatRunning,
  progressOpen: aiSmartFormatProgressOpen,
  progressCurrent: aiSmartFormatProgressCurrent,
  progressTotal: aiSmartFormatProgressTotal,
  progressShowTokenUsage: aiSmartFormatProgressShowTokenUsage,
  progressTokenUsage: aiSmartFormatProgressTokenUsage,
  progressTokenUsageAvailable: aiSmartFormatProgressTokenUsageAvailable,
  progressTokenPricePerMillion: aiSmartFormatProgressTokenPricePerMillion,
  reviewSession: aiSmartFormatReviewSession,
  runSmartFormat: runAiSmartFormat,
  stopSmartFormat: stopAiSmartFormat,
  applySmartFormatReview,
  discardSmartFormatReview,
} = smartFormatCtl;

async function confirmAndRunAiSmartFormatFull() {
  const ok = await appConfirm(
    "如果只想对特定选区进行排版，可在编辑器中选中相应文本 → 右键 →「AI 智能排版：选中文本」。",
    "将进行全文智能排版，是否继续？",
  );
  if (!ok) return;
  void runAiSmartFormat("full");
}

function onAiSmartFormatFull() {
  void confirmAndRunAiSmartFormatFull();
}

function onAiSmartFormatSelection() {
  void runAiSmartFormat("selection");
}

async function onFooterSaveFileAsEncoding(codec: "utf8" | "gb2312") {
  void (await saveReaderBufferWithIpcEncoding(codec));
}

function onReaderEditLoaded(payload: { encoding: string }) {
  readerSaveEncoding.value = normalizeIpcEncoding(
    (payload.encoding || "utf8").trim() || "utf8",
  );
  pendingReaderEditRestoreAnchor.value = null;
  stream.resyncMirrorFromReader();
  if (searchQuery.value.trim()) {
    scheduleSidebarSearch();
  }
  try {
    chapterNav.refreshChapterListFromReader();
  } finally {
    suppressChapterListAutoScroll.value = false;
  }
}

let chapterRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function clearChapterRefreshDebounce() {
  if (chapterRefreshDebounceTimer) {
    clearTimeout(chapterRefreshDebounceTimer);
    chapterRefreshDebounceTimer = null;
  }
}

function scheduleChapterListRefreshFromEdit() {
  clearChapterRefreshDebounce();
  if (!readerEditMode.value) return;
  if (!editAutoRefreshChapterList.value) return;
  if (totalLineCount.value > editAutoRefreshChapterListMaxLines) return;

  chapterRefreshDebounceTimer = setTimeout(() => {
    chapterRefreshDebounceTimer = null;
    if (!readerEditMode.value) return;
    if (!editAutoRefreshChapterList.value) return;
    if (totalLineCount.value > editAutoRefreshChapterListMaxLines) return;
    void withChapterListScrollSuppressed(async () => {
      chapterNav.refreshChapterListFromReader();
    });
  }, CHAPTER_REFRESH_DEBOUNCE_MS);
}

function onReaderEditContentChange() {
  stream.resyncMirrorFromReader();
  scheduleChapterListRefreshFromEdit();
  editorContentChangeEpoch.value++;
  if (readerEditMode.value && searchQuery.value.trim()) {
    scheduleSidebarSearch();
  }
}

function onReaderEditLoadFailed() {
  pendingReaderEditRestoreAnchor.value = null;
  suppressChapterListAutoScroll.value = false;
  readerEditMode.value = false;
}

function onReaderEditDirtyChange(dirty: boolean) {
  readerEditorDirty.value = dirty;
}

async function handleWindowCloseRequest() {
  if (readerEditMode.value && readerEditorDirty.value) {
    if (!(await confirmReaderEditDiscardUnsaved())) return;
  }
  window.colorTxt.proceedCloseWindow();
}

/** AI 助手跳转章节：未激活书钉时先记住当前滚动位置（与查找打开前一致），再跳转 */
function jumpToChapterFromAiAssistant(ch: Chapter) {
  guardReaderNavigation(() => {
    ensurePinBeforeRevealFindWidget();
    jumpToChapter(ch);
  });
}

const readerUi = useAppReaderUiPrefs({
  readerRef,
  readerFontSize,
  readerLineHeightMultiple,
  monacoFontFamily,
  pinnedOtherFonts,
  monacoCustomHighlight,
  monacoAdvancedWrapping,
  compressBlankLines,
  leadIndentFullWidth,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  withChapterListScrollSuppressed,
  currentFile,
  stream,
  syncChaptersAfterViewportSettled,
  persistSettings,
  isFullscreenView,
  showFullscreenHeader,
  viewportTopLine,
  viewportEndLine,
  viewportVisualProgressPercent,
  viewportAtBottom,
  isVoiceReadBlocksFind,
});

const {
  onViewportTopLineChange,
  onViewportEndLineChange,
  onViewportVisualProgressChange,
  increaseFontSize,
  decreaseFontSize,
  increaseLineHeight,
  decreaseLineHeight,
  setMonacoFontFamily,
  togglePinnedOtherFont,
  toggleMonacoCustomHighlight,
  toggleMonacoAdvancedWrapping,
  toggleCompressBlankLines,
  toggleLeadIndentFullWidth,
  setTextConvertZhRead,
  setTextConvertLetterRead,
  setTextConvertDigitRead,
  onToggleFind,
} = readerUi;

function openGithubRepo() {
  void window.colorTxt.openExternal(GITHUB_REPO_URL);
}

function requestCheckForUpdates() {
  void appOverlaysRef.value?.checkForUpdates();
}

function openNewWindow() {
  window.colorTxt.openNewWindow();
}

function openFindBookWindow() {
  window.colorTxt.openFindBookWindow();
}

async function applyShortcutBindings(next: ShortcutBindingMap) {
  const merged = mergeShortcutBindings(defaultShortcutBindings, next);
  const globalResult = await window.colorTxt.setGlobalShortcut(
    merged.toggleAllWindowsVisibility,
  );
  if (!globalResult.ok) {
    await appAlert(globalResult.message || "系统级快捷键设置失败");
    return;
  }
  shortcutBindings.value = merged;
  persistSettings();
}

function revealCurrentFileInFolder() {
  const filePath =
    physicalReaderPath.value ??
    currentFile.value ??
    ebookConversionSourcePath.value;
  if (!filePath) return;
  void window.colorTxt.showItemInFolder(filePath).catch(() => {});
}

/** 底栏路径菜单：重新自磁盘载入当前会话文件 */
async function reloadCurrentFileFromDisk() {
  const path = currentFile.value;
  if (!path) return;
  await openFilePath(path, { keepSidebarTab: true });
}

/** 底栏路径菜单：忽略缓存，强制重新转换电子书源文件 */
async function reconvertCurrentEbookFromDisk() {
  const path = currentFile.value;
  if (!path || !isEbookFilePath(path)) return;
  await openFilePath(path, {
    keepSidebarTab: true,
    forceEbookConvert: true,
  });
}

async function exportCurrentReaderBookPack(includeReadingProgress: boolean) {
  const sessionPath = currentFile.value?.trim();
  const physicalPath =
    physicalReaderPath.value?.trim() || sessionPath || "";
  if (!sessionPath || !physicalPath) {
    await appAlert("请先打开文件");
    return;
  }
  const {
    buildReaderBookPackDefaultName,
    buildReaderBookPackZip,
    saveReaderBookPackFile,
  } = await import("./utils/readerBookPack");
  let viewportTopPhysicalLine: number | undefined;
  if (includeReadingProgress) {
    const top = readerRef.value?.getViewportTopLine?.();
    if (typeof top === "number" && Number.isFinite(top)) {
      viewportTopPhysicalLine = readerEditMode.value
        ? Math.max(1, Math.floor(top))
        : stream.viewportDisplayLineToPhysicalLine(top);
    }
  }
  try {
    const zipBuffer = await buildReaderBookPackZip({
      physicalContentPath: physicalPath,
      sessionFilePath: sessionPath,
      meta: findFileMetaRecord(fileMetaRecords.value, sessionPath),
      portraitCacheDir: characterPortraitCacheDir.value,
      includeReadingProgress,
      viewportTopPhysicalLine,
      password: bookPackPassword.value,
    });
    const encrypted = Boolean(bookPackPassword.value.trim());
    const name = buildReaderBookPackDefaultName(
      fileNameKey(sessionPath),
      encrypted,
    );
    const r = await saveReaderBookPackFile(name, zipBuffer, encrypted);
    if (!r.ok) {
      if ("error" in r) await appAlert(r.error);
      return;
    }
    appToast(
      includeReadingProgress ? "已导出书包（含阅读进度）" : "已导出书包",
      { kind: "success" },
    );
  } catch (e) {
    await appAlert(e instanceof Error ? e.message : String(e));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

async function uploadCurrentReaderBookPackToWebDav() {
  if (webDavBookPackProgress.value) return;
  const sessionPath = currentFile.value?.trim();
  const physicalPath =
    physicalReaderPath.value?.trim() || sessionPath || "";
  if (!sessionPath || !physicalPath) {
    await appAlert("请先打开文件");
    return;
  }
  const auth = buildWebDavAuth({
    webDavEnabled: webDavEnabled.value,
    webDavUrl: webDavUrl.value,
    webDavUsername: webDavUsername.value,
    webDavRemoteDir: webDavRemoteDir.value,
  });
  if (!auth || !window.colorTxt?.webdav) {
    appToast("请先在设置中配置 WebDAV", { kind: "warning" });
    return;
  }
  const requestId = beginWebDavBookPackProgress("upload");
  const {
    buildReaderBookPackDefaultName,
    buildReaderBookPackZip,
  } = await import("./utils/readerBookPack");
  let viewportTopPhysicalLine: number | undefined;
  const top = readerRef.value?.getViewportTopLine?.();
  if (typeof top === "number" && Number.isFinite(top)) {
    viewportTopPhysicalLine = readerEditMode.value
      ? Math.max(1, Math.floor(top))
      : stream.viewportDisplayLineToPhysicalLine(top);
  }
  try {
    const zipBuffer = await buildReaderBookPackZip({
      physicalContentPath: physicalPath,
      sessionFilePath: sessionPath,
      meta: findFileMetaRecord(fileMetaRecords.value, sessionPath),
      portraitCacheDir: characterPortraitCacheDir.value,
      includeReadingProgress: true,
      viewportTopPhysicalLine,
      password: bookPackPassword.value,
    });
    const encrypted = Boolean(bookPackPassword.value.trim());
    const name = buildReaderBookPackDefaultName(
      fileNameKey(sessionPath),
      encrypted,
    );
    const tempRoot = await window.colorTxt.getPath("temp");
    if (!tempRoot) {
      await appAlert("无法获取临时目录");
      return;
    }
    const tempDir = joinFs(tempRoot, "colortxt-webdav-upload");
    await window.colorTxt.mkdir(tempDir);
    const tempPath = joinFs(tempDir, name);
    await window.colorTxt.writeBinaryFile(
      tempPath,
      arrayBufferToBase64(zipBuffer),
    );
    const ensure = await window.colorTxt.webdav.ensureLayout(auth);
    if (!ensure.ok) {
      appToast(ensure.error, { kind: "danger" });
      return;
    }
    const put = await window.colorTxt.webdav.putFile(
      auth,
      `Books/${name}`,
      tempPath,
      "application/octet-stream",
      requestId,
    );
    try {
      await window.colorTxt.removePath(tempPath);
    } catch {
      /* ignore */
    }
    if (!put.ok) {
      appToast(put.error, { kind: "danger" });
      return;
    }
    appToast(`已上传书包：${name}`, { kind: "success" });
  } catch (e) {
    await appAlert(e instanceof Error ? e.message : String(e));
  } finally {
    endWebDavBookPackProgress();
  }
}

async function updateCurrentReaderBookPackFromWebDav() {
  if (webDavBookPackProgress.value) return;
  const sessionPath = currentFile.value?.trim();
  if (!sessionPath) {
    await appAlert("请先打开文件");
    return;
  }
  const auth = buildWebDavAuth({
    webDavEnabled: webDavEnabled.value,
    webDavUrl: webDavUrl.value,
    webDavUsername: webDavUsername.value,
    webDavRemoteDir: webDavRemoteDir.value,
  });
  if (!auth || !window.colorTxt?.webdav) {
    appToast("请先在设置中配置 WebDAV", { kind: "warning" });
    return;
  }
  const requestId = beginWebDavBookPackProgress("sync");
  const { buildReaderBookPackDefaultName } = await import(
    "./utils/readerBookPack"
  );
  const encrypted = Boolean(bookPackPassword.value.trim());
  const preferred = buildReaderBookPackDefaultName(
    fileNameKey(sessionPath),
    encrypted,
  );
  const fallback = buildReaderBookPackDefaultName(
    fileNameKey(sessionPath),
    !encrypted,
  );
  const names = preferred === fallback ? [preferred] : [preferred, fallback];
  let downloadedPath: string | null = null;
  let lastError = "";
  try {
    for (const name of names) {
      const r = await window.colorTxt.webdav.getToFile(
        auth,
        `Books/${name}`,
        name,
        requestId,
      );
      if (r.ok) {
        downloadedPath = r.filePath;
        break;
      }
      lastError = r.error;
    }
    if (!downloadedPath) {
      appToast(lastError || "远端未找到对应书包", { kind: "danger" });
      return;
    }
    endWebDavBookPackProgress();
    const opened = await openFilePath(downloadedPath);
    if (opened) {
      appToast("已从 WebDAV 同步书包", { kind: "success" });
    }
  } catch (e) {
    await appAlert(e instanceof Error ? e.message : String(e));
  } finally {
    endWebDavBookPackProgress();
  }
}

async function onWebDavImportPackPaths(
  paths: string[],
  opts?: {
    silent?: boolean;
    passwordBook?: string[];
    skipOnDecryptFail?: boolean;
  },
): Promise<{
  imported: Array<{ packPath: string; openPath: string }>;
  okCount: number;
  skipCount: number;
  failCount: number;
  passwordBook: string[];
  skipOnDecryptFail: boolean;
}> {
  if (!paths.length) {
    return {
      imported: [],
      okCount: 0,
      skipCount: 0,
      failCount: 0,
      passwordBook: opts?.passwordBook ? [...opts.passwordBook] : [],
      skipOnDecryptFail: opts?.skipOnDecryptFail ?? false,
    };
  }
  return await importPathsIntoFileList(paths, opts);
}

function onWebDavConfigDownloaded() {
  loadPersistedSettings();
  refreshReplaceRulesCache();
  // loadPersistedSettings 只写 ref；字号/行高/字体等需推到 Monaco 才生效
  applyReaderAppearanceFromSettings();
  applyRecentFilesHistoryLimitFromSettings();
  // 替换、转换、压缩空行、行首缩进、章节字数等可能已变，按物理行重跑展示
  reformatReaderDisplayPreservingViewport();
}

function quitApp() {
  void (async () => {
    if (readerEditMode.value && readerEditorDirty.value) {
      if (!(await confirmReaderEditDiscardUnsaved())) return;
    }
    window.colorTxt.quitApp();
  })();
}

function applyReaderAppearanceFromSettings() {
  applyReaderSurfaceToDocument(
    currentTheme.value,
    readerSurfaceLight.value,
    readerSurfaceDark.value,
  );
  readerRef.value?.setTheme(currentTheme.value);
  readerRef.value?.setFontSize(readerFontSize.value);
  readerRef.value?.setLineHeightMultiple(readerLineHeightMultiple.value);
  readerRef.value?.setFontFamily(monacoFontFamily.value);
  readerRef.value?.setWrappingStrategyAdvanced(monacoAdvancedWrapping.value);
}

function refreshReaderSurfaceAfterPaletteChange() {
  applyReaderSurfaceToDocument(
    currentTheme.value,
    readerSurfaceLight.value,
    readerSurfaceDark.value,
  );
  readerRef.value?.setTheme(currentTheme.value);
}

function onApplyReaderPalettes(payload: {
  light: ReaderSurfacePalette;
  dark: ReaderSurfacePalette;
  colorEnabledLight: ReaderSurfaceColorEnabled;
  colorEnabledDark: ReaderSurfaceColorEnabled;
}) {
  readerPaletteOverridesLight.value = overridesFromFullPalette(
    payload.light,
    defaultReaderPaletteLight,
  );
  readerPaletteOverridesDark.value = overridesFromFullPalette(
    payload.dark,
    defaultReaderPaletteDark,
  );
  readerPaletteColorEnabledOverridesLight.value = overridesFromColorEnabled(
    payload.colorEnabledLight,
  );
  readerPaletteColorEnabledOverridesDark.value = overridesFromColorEnabled(
    payload.colorEnabledDark,
  );
  persistSettings();
  refreshReaderSurfaceAfterPaletteChange();
}

function onApplyHighlightColors(payload: { light: string[]; dark: string[] }) {
  highlightColorsLight.value = mergeHighlightColors(
    DEFAULT_HIGHLIGHT_COLORS_LIGHT,
    payload.light.length >= MIN_HIGHLIGHT_COLORS ? payload.light : undefined,
  );
  highlightColorsDark.value = mergeHighlightColors(
    DEFAULT_HIGHLIGHT_COLORS_DARK,
    payload.dark.length >= MIN_HIGHLIGHT_COLORS ? payload.dark : undefined,
  );
  persistSettings();
}

function onApplyLineationColors(payload: { light: string[]; dark: string[] }) {
  lineationColorsLight.value = mergeLineationColors(
    DEFAULT_LINEATION_COLORS_LIGHT,
    payload.light.length >= MIN_LINEATION_COLORS ? payload.light : undefined,
  );
  lineationColorsDark.value = mergeLineationColors(
    DEFAULT_LINEATION_COLORS_DARK,
    payload.dark.length >= MIN_LINEATION_COLORS ? payload.dark : undefined,
  );
  lineationLastColors.value = clampLineationLastColorsToCount(
    lineationLastColors.value,
    lineationColorsForReader.value.length,
  );
  persistSettings();
}

function onUpdateLineationLastColor(payload: {
  type: ReaderLineationType;
  colorIndex: number;
}) {
  lineationLastColors.value = clampLineationLastColorsToCount(
    {
      ...lineationLastColors.value,
      [payload.type]: payload.colorIndex,
    },
    lineationColorsForReader.value.length,
  );
  persistSettings();
}

async function onExportBookmarksJson() {
  const path = currentFile.value;
  const list = currentFileBookmarks.value;
  if (!path || list.length === 0) return;
  const {
    buildBookmarkExportDefaultName,
    buildReaderBookmarksExportJson,
    saveBookmarkExportFile,
  } = await import("./utils/readerBookmarkExport");
  const name = buildBookmarkExportDefaultName(fileNameKey(path));
  const data = buildReaderBookmarksExportJson(
    path,
    fileNameKey(path),
    list,
  );
  const r = await saveBookmarkExportFile(name, data);
  if (!r.ok && "error" in r) await appAlert(r.error);
}

async function onImportBookmarksJson() {
  const path = currentFile.value;
  if (!path) return;
  const {
    mergeImportedBookmarks,
    parseReaderBookmarksExportJson,
    pickAndReadBookmarkJsonFile,
  } = await import("./utils/readerBookmarkExport");
  const picked = await pickAndReadBookmarkJsonFile();
  if (!picked.ok) {
    if ("error" in picked) await appAlert(picked.error);
    return;
  }
  const envelope = parseReaderBookmarksExportJson(picked.text);
  if (!envelope) {
    await appAlert("无效的书签 JSON 文件");
    return;
  }
  if (
    envelope.bookPath.replace(/\\/g, "/").toLowerCase() !==
    path.replace(/\\/g, "/").toLowerCase()
  ) {
    const ok = await appConfirm("该文件来自其他书籍，仍导入到当前书？");
    if (!ok) return;
  }
  const merged = mergeImportedBookmarks(
    currentFileBookmarks.value,
    envelope.bookmarks,
  );
  fileMetaRecords.value = upsertFileMetaRecord(
    fileMetaRecords.value,
    path,
    () => ({ bookmarks: merged }),
  );
  persistFileMeta();
  appToast(`已导入 ${envelope.bookmarks.length} 条书签`, { kind: "success" });
}

function onAskAiWithQuote(text: string) {
  sidebarTab.value = "aiAssistant";
  showSidebar.value = true;
  void nextTick(() => {
    readerSidebarRef.value?.prefillAiAssistantQuotedText?.(text);
  });
}

watch(readerEditMode, (edit) => {
  if (!edit) {
    clearChapterRefreshDebounce();
    readerEditCursorStatus.value = null;
  }
});

watch(currentFile, (next, prev) => {
  if (next === prev) return;
  /** 打开文件时从 meta 恢复侧栏标签页 */
  if (next) {
    const meta = findFileMetaRecord(fileMetaRecords.value, next);
    if (meta?.sidebarTab) {
      sidebarTab.value = meta.sidebarTab;
    }
  }
});

/** 侧栏标签页切换时保存到当前文件的 meta */
watch(sidebarTab, () => {
  const path = currentFile.value;
  if (!path) return;
  fileMetaRecords.value = upsertFileMetaRecord(
    fileMetaRecords.value,
    path,
    (record) => ({ ...record, sidebarTab: sidebarTab.value }),
  );
  persistFileMeta();
});

onBeforeUnmount(() => {
  clearChapterRefreshDebounce();
});

async function applySettings(payload: SettingsApplyPayload) {
  const prevCompressBlankKeepOneBlank = compressBlankKeepOneBlank.value;
  const prevChapterMinCharCount = chapterMinCharCount.value;
  monacoSmoothScrolling.value = payload.monacoSmoothScrolling;
  mouseWheelScrollSensitivity.value = clampMouseWheelScrollSensitivity(
    payload.mouseWheelScrollSensitivity,
  );
  fastScrollSensitivity.value = clampFastScrollSensitivity(
    payload.fastScrollSensitivity,
  );
  stickyChapterTitleEnabled.value = payload.stickyChapterTitleEnabled;
  chapterNavToolbarEnabled.value = payload.chapterNavToolbarEnabled;
  chapterCharCountExact.value = payload.chapterCharCountExact;
  timedScrollSettings.value = mergeTimedScrollSettings(payload.timedScroll);
  pomodoroSettings.value = mergePomodoroSettings(payload.pomodoro);
  readerEditShowLineNumbers.value = payload.readerEditShowLineNumbers;
  readerEditMinimap.value = payload.readerEditMinimap;
  editAutoRefreshChapterList.value = payload.editAutoRefreshChapterList;
  aiSmartFormat.value = { ...payload.aiSmartFormat };
  compressBlankKeepOneBlank.value = payload.compressBlankKeepOneBlank;
  txtrDelimitedMatchCrossLine.value = payload.txtrDelimitedMatchCrossLine;
  restoreSessionOnStartup.value = payload.restoreSessionOnStartup;
  syncCurrentFile.value = payload.syncCurrentFile;
  recentFilesHistoryLimit.value = Math.max(
    0,
    Math.min(
      maxRecentFilesHistoryLimit,
      Math.floor(payload.recentFilesHistoryLimit),
    ),
  );
  chapterMinCharCount.value = Math.max(
    minChapterMinCharCount,
    Math.min(maxChapterMinCharCount, Math.floor(payload.chapterMinCharCount)),
  );
  fullscreenReaderWidthPercent.value = Math.max(
    minFullscreenReaderWidthPercent,
    Math.min(
      maxFullscreenReaderWidthPercent,
      Math.floor(payload.fullscreenReaderWidthPercent),
    ),
  );
  fullscreenShowSystemTime.value = payload.fullscreenShowSystemTime;
  ebookConvertOutputDir.value = payload.ebookConvertOutputDir;
  bookPackUnpackDir.value = payload.bookPackUnpackDir.trim();
  bookPackPassword.value = payload.bookPackPassword ?? "";
  webDavEnabled.value = payload.webDavEnabled === true;
  webDavUrl.value = payload.webDavUrl ?? "";
  webDavUsername.value = payload.webDavUsername ?? "";
  webDavRemoteDir.value =
    (payload.webDavRemoteDir ?? "").trim() || "ColorTxt";
  const prevPortraitCache = characterPortraitCacheDir.value.trim();
  const nextPortraitCache = payload.characterPortraitCacheDir.trim();
  if (
    prevPortraitCache &&
    nextPortraitCache &&
    prevPortraitCache !== nextPortraitCache
  ) {
    try {
      const mig = await window.colorTxt.characterPortrait.migrateCacheRoot({
        from: prevPortraitCache,
        to: nextPortraitCache,
      });
      if (!mig.ok) {
        await appAlert(mig.error ?? "迁移角色立绘缓存失败，已保留原目录。");
      } else {
        characterPortraitCacheDir.value = nextPortraitCache;
      }
    } catch (e) {
      await appAlert(e instanceof Error ? e.message : String(e));
    }
  } else {
    characterPortraitCacheDir.value = nextPortraitCache;
  }
  const nextFontSize = Math.max(
    minFontSize,
    Math.min(maxFontSize, Math.round(payload.fontSize)),
  );
  const nextLineHeightMultiple = clampLineHeightMultipleForFontSize(
    nextFontSize,
    payload.lineHeightMultiple,
  );
  readerFontSize.value = nextFontSize;
  readerLineHeightMultiple.value = nextLineHeightMultiple;
  readerRef.value?.setFontSize(nextFontSize);
  readerRef.value?.setLineHeightMultiple(nextLineHeightMultiple);
  aiSkillOverrides.value = mergeAiSkillOverrides(payload.aiSkillOverrides);
  aiCustomSkills.value = mergeAiCustomSkills(payload.aiCustomSkills ?? []);
  aiSkillsEnabled.value = mergeAiSkillsEnabled(
    payload.aiSkillsEnabled,
    aiCustomSkills.value.map((s) => s.id),
  );
  voiceReadSettings.value = mergeVoiceReadSettings(payload.voiceRead);
  voiceReadProfiles.value = cloneVoiceReadProfiles(payload.voiceReadProfiles);
  activeVoiceReadProfileId.value = payload.activeVoiceReadProfileId.trim();
  await persistVoiceReadSecretsToVault();
  aiAssistantConfigSyncNonce.value += 1;
  persistSettings();
  if (!payload.restoreSessionOnStartup) {
    clearPersistedSession();
  }
  applyRecentFilesHistoryLimitFromSettings();
  readerRef.value?.setWrappingStrategyAdvanced(monacoAdvancedWrapping.value);
  showSettingsPanel.value = false;
  if (
    prevChapterMinCharCount !== chapterMinCharCount.value &&
    compressBlankLines.value &&
    currentFile.value &&
    !readerEditMode.value
  ) {
    const anchor =
      captureViewportRestoreAnchor() ?? {
        physicalLine: captureViewportAnchorPhysicalLine(),
        wrappedLineIndex: 0,
      };
    void withChapterListScrollSuppressed(async () => {
      const ok = await stream.applyReaderDisplayFromPhysicalLines(anchor);
      if (!ok) {
        chapterMinCharCount.value = prevChapterMinCharCount;
        persistSettings();
        return;
      }
      await syncChaptersAfterViewportSettled();
    });
  } else if (prevChapterMinCharCount !== chapterMinCharCount.value) {
    chapterNav.refreshChapterListFromReader();
  }

  if (
    prevCompressBlankKeepOneBlank !== compressBlankKeepOneBlank.value &&
    compressBlankLines.value &&
    currentFile.value &&
    !readerEditMode.value
  ) {
    const anchor =
      captureViewportRestoreAnchor() ?? {
        physicalLine: captureViewportAnchorPhysicalLine(),
        wrappedLineIndex: 0,
      };
    void withChapterListScrollSuppressed(async () => {
      const ok = await stream.applyReaderDisplayFromPhysicalLines(anchor);
      if (!ok) {
        compressBlankKeepOneBlank.value = prevCompressBlankKeepOneBlank;
        persistSettings();
        return;
      }
      await syncChaptersAfterViewportSettled();
    });
  }
}

/** 来自主进程的跨窗口主题同步，避免再发 theme:set 造成循环 */
const skipNextThemeNativeIpc = ref(false);

useAppWindowBindings({
  readerRef,
  stream,
  fileSession,
  persistWindowUnloadState,
  persistFileListCache,
  persistSidebarWidth,
  isFullscreenView,
  showSidebar,
  sidebarWidth,
  fullscreenSidebarWidth,
  resizingSidebar,
  getSidebarMaxWidth,
  getSidebarMinWidth,
  clampSidebarWidthToViewport,
  updateFullscreenHeaderHover,
  updateFullscreenFooterHover,
  updateFullscreenSidebarHover,
  endSidebarResize,
  dismissFullscreenChromeForNativeExit,
  bumpFullscreenCursorIdle,
  recordFullscreenPointer,
  enterOrExitFullscreenView,
  pulseChapterListCenter,
  syncChaptersAfterViewportSettled,
  currentTheme,
  readerFontSize,
  readerLineHeightMultiple,
  monacoFontFamily,
  fileEncoding,
  loading,
  loadingProgressPercent,
  pendingRestorePhysicalLine,
  pendingRestoreEditorViewState,
  pendingRestoreViewportTopPhysicalLine,
  pendingRestoreViewportAnchor,
  compressBlankLines,
  suppressFileListCenterAfterLoad,
  suppressChapterListAutoScroll,
  txtFiles,
  sidebarTab,
  currentFile,
  dirListScanning,
  dirListCurrentName,
  chapterRuleErrorText,
  showChapterRulePanel,
  increaseFontSize,
  decreaseFontSize,
  increaseLineHeight,
  decreaseLineHeight,
  openNewWindow,
  openFileViaDialog,
  pickTxtDirectory,
  onBookmarkClick,
  skipNextThemeNativeIpc,
  jumpToPrevChapter: jumpToPrevChapterWithVoiceRead,
  jumpToNextChapter: jumpToNextChapterWithVoiceRead,
  openSettings: () => {
    showSettingsPanel.value = true;
  },
  openColorScheme: () => {
    showColorSchemePanel.value = true;
  },
  openFindBook: openFindBookWindow,
  toggleFind: onToggleFind,
  scrollDownLine: () => readerRef.value?.scrollByLineStep?.(1),
  scrollUpLine: () => readerRef.value?.scrollByLineStep?.(-1),
  scrollPageUp: () => readerRef.value?.scrollByPageStep?.(-1),
  scrollPageDown: () => readerRef.value?.scrollByPageStep?.(1),
  shortcutBindings,
  activeStreamRequestId,
  activeStreamFilePath,
  readingProgressSynced,
  readerDropOverlayVisible,
  handleWindowCloseRequest,
  readerEditMode,
  voiceReadScrollLocked: isVoiceReadScrollLocked,
});

useAppShellThemeWatch({
  currentTheme,
  readerRef,
  readerSurfaceLight,
  readerSurfaceDark,
  skipNextThemeNativeIpc,
  persistSettings,
  showChapterCounts,
  currentFile,
  readerEditMode,
  readerEditorDirty,
  isFullscreenView,
  showFullscreenSidebar,
  pulseChapterListCenter,
});
</script>

<template>
  <div
    ref="appRoot"
    class="app"
    :class="{
      fullscreen: isFullscreenView,
      'fullscreen--cursorHidden': isFullscreenView && fullscreenCursorHidden,
    }"
  >
    <div
      :ref="setFullscreenHeaderOverlayEl"
      class="appHeaderWrap"
      v-show="!isFullscreenView || showFullscreenHeader"
      @mouseleave="onFullscreenHeaderMouseLeave"
    >
      <AppHeader
        :in-fullscreen="isFullscreenView"
        :recent-files="recentFilesForMenu"
        :pin-active="pinActive"
        :can-pin="canPin"
        :bookmark-active="bookmarkActive"
        :can-bookmark="canBookmark"
        :voice-read-active="isVoiceReadActive"
        :can-voice-read="canVoiceRead"
        :timed-scroll-active="isTimedScrollActive"
        :can-timed-scroll="canStartTimedScroll"
        :voice-read-header-locked="isVoiceReadHeaderLocked"
        :current-theme="currentTheme"
        :show-sidebar="showSidebar"
        :can-increase-font="readerFontSize < maxFontSize"
        :can-decrease-font="readerFontSize > minFontSize"
        :can-increase-line-height="
          readerLineHeightMultiple <
          maxLineHeightMultipleForFontSize(readerFontSize) - 1e-6
        "
        :can-decrease-line-height="
          readerLineHeightMultiple > minLineHeightMultiple + 1e-6
        "
        :monaco-font-family="monacoFontFamily"
        :pinned-other-fonts="pinnedOtherFonts"
        :monaco-advanced-wrapping="monacoAdvancedWrapping"
        :monaco-custom-highlight="monacoCustomHighlight"
        :text-replace-active="textReplaceActive"
        :compress-blank-lines="compressBlankLines"
        :lead-indent-full-width="leadIndentFullWidth"
        :text-convert-zh="textConvertZh"
        :text-convert-letter="textConvertLetter"
        :text-convert-digit="textConvertDigit"
        :reader-edit-mode="readerEditMode"
        :can-enter-reader-edit-mode="canEnterReaderEditMode"
        :shortcut-bindings="shortcutBindings"
        @open-file="openFileViaDialog"
        @pin-click="onPinClick"
        @bookmark-click="onBookmarkClick"
        @go-back-from-pin="onGoBackFromPin"
        @change-theme="currentTheme = $event"
        @toggle-sidebar="showSidebar = !showSidebar"
        @toggle-fullscreen="enterOrExitFullscreenView"
        @set-monaco-font="setMonacoFontFamily"
        @toggle-pin-other-font="togglePinnedOtherFont"
        @increase-font-size="increaseFontSize"
        @decrease-font-size="decreaseFontSize"
        @increase-line-height="increaseLineHeight"
        @decrease-line-height="decreaseLineHeight"
        @toggle-monaco-advanced-wrapping="toggleMonacoAdvancedWrapping"
        @toggle-monaco-custom-highlight="toggleMonacoCustomHighlight"
        @toggle-compress-blank-lines="toggleCompressBlankLines"
        @toggle-lead-indent-full-width="toggleLeadIndentFullWidth"
        @format-edit-compress-blank-lines="onFormatEditCompressBlankLines"
        @format-edit-lead-indent-full-width="onFormatEditLeadIndentFullWidth"
        @select-text-convert-zh-read="setTextConvertZhRead"
        @select-text-convert-letter-read="setTextConvertLetterRead"
        @select-text-convert-digit-read="setTextConvertDigitRead"
        @apply-text-convert-zh-edit="onApplyTextConvertZhEdit"
        @apply-text-convert-letter-edit="onApplyTextConvertLetterEdit"
        @apply-text-convert-digit-edit="onApplyTextConvertDigitEdit"
        @toggle-find="onToggleFind"
        :chapter-rules-disabled="currentFileIsMarkdown"
        @open-chapter-rules="
          chapterRuleErrorText = '';
          showChapterRulePanel = true;
        "
        @open-text-replace="showReplaceRulePanel = true"
        @open-github="openGithubRepo"
        @check-for-updates="requestCheckForUpdates"
        @open-shortcuts="showShortcutPanel = true"
        @open-settings="showSettingsPanel = true"
        @open-color-scheme="showColorSchemePanel = true"
        @open-find-book="openFindBookWindow"
        @open-new-window="openNewWindow"
        @open-recent-file="openRecentFileFromHistory"
        @clear-recent-files="clearRecentFiles"
        @open-about="showAboutPanel = true"
        @quit-app="quitApp"
        @toggle-reader-edit="onToggleReaderEdit"
        @save-reader-file="onSaveReaderFile"
        :ai-features-enabled="aiFeaturesEnabled"
        :can-use-ai-smart-format="canUseAiSmartFormat"
        :ai-smart-format-running="aiSmartFormatRunning"
        :smart-format-review-active="aiSmartFormatReviewSession != null"
        @ai-smart-format-full="onAiSmartFormatFull"
        @voice-read-toggle="onVoiceReadToggle"
        @timed-scroll-toggle="toggleTimedScroll"
      />
    </div>

    <div
      class="layout"
      @mousedown="onLayoutMouseDown"
      @wheel.capture="onLayoutWheel"
    >
      <div
        ref="fullscreenSidebarOverlayRef"
        class="sidebarPaneWrap"
        :class="{ 'sidebarPaneWrap--fullscreen': isFullscreenView }"
        v-show="sidebarShellVisible"
        :style="{ width: `${sidebarPaneLayoutWidth}px` }"
        @mouseleave="onFullscreenSidebarMouseLeave"
      >
        <ReaderSidebar
          ref="readerSidebarRef"
          active-scroll-mode="center"
          :panel-expanded="isFullscreenView || showSidebar"
          :activity-icons-on-dark="currentTheme === 'vs-dark'"
          :in-fullscreen="isFullscreenView"
          :show-fullscreen-sidebar="
            isFullscreenView ? showFullscreenSidebar : undefined
          "
          :chapter-list-scroll-smooth="chapterListScrollSmooth"
          :should-center-chapter-list="shouldCenterChapterList"
          :suppress-chapter-list-auto-scroll="suppressChapterListAutoScroll"
          :should-center-file-list="shouldCenterFileList"
          :should-center-bookmark-list="shouldCenterBookmarkList"
          v-model:activeTab="sidebarTab"
          v-model:showChapterCounts="showChapterCounts"
          :files="txtFiles"
          :file-meta-records="fileMetaRecords"
          :file-category="fileCategory"
          :file-sort="fileSort"
          :file-category-catalog="fileCategoryCatalog"
          :meta-progress-by-path-key="metaProgressByPathKey"
          :live-reading-progress-percent="liveReadingProgressForUi"
          :bookmarks="bookmarkListItems"
          :highlight-terms="currentFileHighlightTerms"
          :annotation-groups="annotationListGroups"
          :search-query="searchQuery"
          :search-results="searchResults"
          :search-in-progress="searchInProgress"
          :search-match-case="searchMatchCase"
          :search-whole-word="searchWholeWord"
          :search-use-regex="searchUseRegex"
          :active-search-result="activeSearchResult"
          :has-inline-search-highlight="hasInlineSearchHighlight"
          :highlight-preview-bg="
            currentTheme === 'vs'
              ? readerSurfaceLight.readerBg
              : readerSurfaceDark.readerBg
          "
          :monaco-font-family="monacoFontFamily"
          :lineation-colors="lineationColorsForReader"
          :active-bookmark-line="activeBookmarkLine"
          :current-file-path="currentFile"
          :physical-reader-path="physicalReaderPath"
          :reader-main-ref="readerRef"
          :ai-assistant-tab-visible="aiFeaturesEnabled"
          :character-portrait-tab-visible="txt2imgFeatureEnabled"
          :character-portrait-cache-dir="characterPortraitCacheDir"
          v-model:character-card-texture-effect="characterCardTextureEffect"
          :character-roster="currentFileCharacterRoster"
          :character-book-style="currentFileCharacterBookStyle"
          :voice-read-settings="voiceReadSettings"
          v-model:deep-thinking="aiAssistantDeepThinking"
          v-model:spoiler-safe="aiAssistantSpoilerSafe"
          :ai-skills-enabled="aiSkillsEnabled"
          :ai-skill-overrides="aiSkillOverrides"
          :ai-custom-skills="aiCustomSkills"
          :ai-assistant-config-sync-nonce="aiAssistantConfigSyncNonce"
          :chapters="chapters"
          :active-chapter-idx="activeChapterIdx"
          :chapter-min-char-count="chapterMinCharCount"
          :format-char-count="formatChapterCharCount"
          :show-edit-chapter-refresh-button="showEditChapterRefreshButton"
          @pick-directory="pickTxtDirectory"
          @pick-files="pickTxtFilesIntoFileList"
          @import-dropped-paths="onImportDroppedPathsFromList"
          @open-file="openFileFromSidebar"
          @jump-to-chapter="onJumpToChapterFromSidebar"
          @jump-to-chapter-from-ai="jumpToChapterFromAiAssistant"
          v-model:wordcloud-font-family="wordcloudFontFamily"
          v-model:wordcloud-angle-mode="wordcloudAngleMode"
          v-model:wordcloud-palette-id="wordcloudPaletteId"
          @clear-file-list="clearFileList"
          @clear-file-list-category="clearFileListForCategory"
          @remove-file-list="removeFileList"
          @clear-file-meta="onClearFileMeta"
          @rename-file-path="onRenameFilePath"
          @replace-file-path="onReplaceFilePath"
          @open-file-in-new-window="onOpenFileInNewWindow"
          @close-current-file="closeCurrentFile"
          @refresh-chapters-from-reader="applyChaptersFromReaderPlainText"
          @jump-to-bookmark="jumpToBookmarkWithVoiceRead"
          @clear-bookmarks="clearCurrentFileBookmarks"
          @remove-bookmarks="removeCurrentFileBookmarks"
          @edit-bookmark="onEditBookmark"
          @remove-bookmark="onRemoveBookmark"
          @export-bookmarks-json="onExportBookmarksJson"
          @import-bookmarks-json="onImportBookmarksJson"
          @find-highlight-term="(text, isRegex) => onFindHighlightTermFromSidebar(text, isRegex)"
          @clear-inline-search-highlight="clearReaderInlineSearchHighlight"
          @update:search-query="searchQuery = $event"
          @update:search-match-case="searchMatchCase = $event"
          @update:search-whole-word="searchWholeWord = $event"
          @update:search-use-regex="searchUseRegex = $event"
          @jump-to-search-result="onJumpToSearchResult"
          @remove-highlight-term="onRemoveHighlightTerm"
          @favorite-highlight-term="onFavoriteHighlightTerm"
          @unfavorite-highlight-term="onUnfavoriteHighlightTerm"
          @clear-highlights="clearCurrentFileHighlightTerms"
          @export-book-highlights-json="onExportBookHighlightsJson"
          @import-book-highlights-json="onImportBookHighlightsJson"
          @export-favorite-highlights-json="onExportFavoriteHighlightsJson"
          @import-favorite-highlights-json="onImportFavoriteHighlightsJson"
          @jump-to-annotation="onJumpToReaderAnnotation"
          @remove-annotation="onRemoveReaderAnnotation"
          @clear-annotations="onClearReaderAnnotationsWithConfirm"
          @clear-stale-annotations="onClearStaleReaderAnnotations"
          @export-annotations-md="onExportAnnotationsMd"
          @export-annotations-json="onExportAnnotationsJson"
          @import-annotations-json="onImportAnnotationsJson"
          @character-file-meta-patch="onCharacterFileMetaPatch"
          @persist-ui="onPersistUi"
          @update:file-category="fileCategory = $event"
          @update:file-sort="fileSort = $event"
          @apply-category-catalog="onApplyCategoryCatalog"
          @set-files-category="onSetFilesCategory"
          @update:fullscreen-file-list-popovers-open="
            fullscreenFileListPopoversOpen = $event
          "
          @update:fullscreen-ai-assistant-popovers-open="
            fullscreenAiAssistantPopoversOpen = $event
          "
          @update:fullscreen-character-drawer-open="
            fullscreenCharacterDrawerOpen = $event
          "
          @update:fullscreen-character-popovers-open="
            fullscreenCharacterPopoversOpen = $event
          "
          @update:file-list-editing="fileListEditing = $event"
          @request-expand-panel="showSidebar = true"
          @request-collapse-panel="showSidebar = false"
          @add-highlight-term="(text, isRegex) => onAddHighlightTermFromSidebar(text, isRegex)"
          :web-dav-enabled="webDavEnabled"
          @open-web-dav="showWebDavPanel = true"
          @open-color-scheme="showColorSchemePanel = true"
        @open-find-book="openFindBookWindow"
          @open-settings="showSettingsPanel = true"
        />
        <!-- 放在侧栏容器内，避免移到拖条时触发 @mouseleave 导致全屏侧栏收起 -->
        <div
          v-show="isFullscreenView"
          class="resizer resizer--fullscreenSidebar"
          @mousedown="startResizeSidebar"
        ></div>
      </div>
      <div
        v-show="showSidebar && !isFullscreenView"
        class="resizer"
        :style="{ left: `${sidebarWidthForLayout - 3}px` }"
        @mousedown="startResizeSidebar"
      ></div>
      <div
        ref="readerPaneWrapRef"
        class="readerPaneWrap"
        data-drop-zone="reader"
        :style="fullscreenReaderPaneStyle"
      >
        <Transition name="readerDropOverlay">
          <div
            v-if="readerDropOverlayVisible"
            class="readerDropOverlay"
            aria-hidden="true"
          >
            <p class="readerDropOverlayText">打开文件</p>
          </div>
        </Transition>
        <ReaderMain
          ref="readerRef"
          class="readerPane"
          :voice-read-scroll-locked="isVoiceReadScrollLocked"
          :voice-read-paused="isVoiceReadActive && voiceReadMode === 'paused'"
          :voice-read-blocks-find="isVoiceReadBlocksFind"
          @voice-read-resume="voiceReadTogglePlayPause"
          :monaco-custom-highlight="monacoCustomHighlight"
          :txtr-delimited-match-cross-line="txtrDelimitedMatchCrossLine"
          :compress-blank-lines="compressBlankLines"
          :lead-indent-full-width="leadIndentFullWidth"
          :chapter-min-char-count="chapterMinCharCount"
          :monaco-advanced-wrapping="monacoAdvancedWrapping"
          :monaco-smooth-scrolling="monacoSmoothScrolling"
          :mouse-wheel-scroll-sensitivity="mouseWheelScrollSensitivity"
          :fast-scroll-sensitivity="fastScrollSensitivity"
          :sticky-chapter-title-enabled="stickyChapterTitleEnabled"
          :reader-edit-show-line-numbers="readerEditShowLineNumbers"
          :reader-edit-minimap="readerEditMinimap"
          :stream-loading="loading"
          :reader-surface-light="effectiveReaderSurfaceLight"
          :reader-surface-dark="effectiveReaderSurfaceDark"
          :reader-palette-color-enabled="readerPaletteColorEnabledForReader"
          :highlight-colors="highlightColorsForReader"
          :lineation-colors="lineationColorsForReader"
          :highlight-words-by-index="readerDisplayHighlightWordsByIndex"
          :highlight-words-by-index-book-only="readerDisplayHighlightWordsBookOnly"
          :reader-annotations="currentFileAnnotations"
          :lineation-last-colors="lineationLastColors"
          :reader-file-path="currentFile"
          :ebook-anchor-physical-to-display="
            stream.physicalLineToDisplayForReader
          "
          :ebook-display-line-to-physical="
            stream.viewportDisplayLineToPhysicalLine
          "
          :before-reveal-find-widget="ensurePinBeforeRevealFindWidget"
          :reader-fullscreen="isFullscreenView"
          :reader-edit-mode="readerEditMode"
          :reader-edit-restore-anchor="pendingReaderEditRestoreAnchor"
          :physical-reader-path="physicalReaderPath"
          :file-is-markdown="currentFileIsMarkdown && !readerEditMode"
          :ai-features-enabled="aiFeaturesEnabled"
          :can-use-ai-smart-format="canUseAiSmartFormat"
          :smart-format-review-session="aiSmartFormatReviewSession"
          :monaco-font-family="monacoFontFamily"
          :get-physical-line-content="stream.getPhysicalLineContent"
          :get-display-line-content="stream.getDisplayLineContent"
          @ai-smart-format-full="onAiSmartFormatFull"
          @ai-smart-format-selection="onAiSmartFormatSelection"
          @smart-format-review-apply="applySmartFormatReview()"
          @smart-format-review-discard="discardSmartFormatReview()"
          @probe-line-change="onProbeLineChange"
          @viewport-top-line-change="onViewportTopLineChange"
          @viewport-end-line-change="onViewportEndLineChange"
          @viewport-visual-progress-change="onViewportVisualProgressChange"
          @add-highlight-term="onAddHighlightTerm"
          @remove-highlight-term="onRemoveHighlightTerm"
          @upsert-reader-annotation="onUpsertReaderAnnotation"
          @remove-reader-annotation="onRemoveReaderAnnotation"
          @annotation-quotes-changed="bumpAnnotationDisplayEpoch"
          @update-lineation-last-color="onUpdateLineationLastColor"
          @ask-ai-with-quote="onAskAiWithQuote"
          @reader-edit-dirty-change="onReaderEditDirtyChange"
          @reader-edit-content-change="onReaderEditContentChange"
          @reader-edit-loaded="onReaderEditLoaded"
          @reader-edit-load-failed="onReaderEditLoadFailed"
          @reader-edit-save-request="onSaveReaderFile"
          @reader-edit-cursor-change="onReaderEditCursorChange"
        />
        <VoiceReadToolbar
          :visible="isVoiceReadActive"
          :mode="voiceReadMode"
          :synthesizing="voiceReadSynthesizing"
          :synthesizing-phase="voiceReadSynthesizingPhase"
          :toolbar-rate="voiceReadToolbarRate"
          :toolbar-volume="voiceReadToolbarVolume"
          :engine="voiceReadSettings.engine"
          :can-prev-line="voiceReadCanPlayPrevLine"
          :can-next-line="voiceReadCanPlayNextLine"
          @update:toolbar-rate="voiceReadToolbarRate = $event"
          @update:toolbar-volume="setVoiceReadToolbarVolume($event)"
          @toggle-play-pause="voiceReadTogglePlayPause"
          @prev-line="voiceReadPlayPrevLine"
          @next-line="voiceReadPlayNextLine"
          @regenerate="voiceReadRegenerateCurrentLine"
          @stop="exitVoiceRead"
        />
        <ReaderChapterNavBar
          v-if="readerChapterNavUiVisible && !isFullscreenView"
          :visible="readerChapterNavVisible"
          :can-go-prev="readerChapterNavCanPrev"
          :can-go-next="readerChapterNavCanNext"
          :disabled="readerChapterNavBusy"
          @prev="jumpToPrevChapterWithVoiceRead"
          @next="jumpToNextChapterWithVoiceRead"
        />
        <div
          v-if="showReaderIdleHint"
          class="readerIdleHint"
          aria-hidden="true"
        >
          <div>{{ defaultReaderIdleHint }}</div>
          <p>{{ defaultReaderOpenHint }}</p>
        </div>
        <div
          v-if="showReaderBusyHint"
          class="readerIdleHint"
          aria-live="polite"
        >
          {{ readerBusyHintText }}
        </div>
        <div
          v-if="showReaderEmptyHint"
          class="readerIdleHint"
          aria-hidden="true"
        >
          {{ emptyFileHintText }}
        </div>
      </div>
    </div>
    <div
      v-if="showFullscreenTip"
      class="fullscreenTip"
      :class="{ fading: fullscreenTipFading }"
    >
      按 ESC 退出全屏
    </div>
    <FullscreenSystemClock
      :visible="isFullscreenView && fullscreenShowSystemTime"
      :pomodoro-visible="isFullscreenView && pomodoroPhase !== 'idle'"
      :pomodoro-progress="pomodoroProgress"
      :pomodoro-paused="pomodoroPaused"
    />

    <div
      :ref="setFullscreenFooterOverlayEl"
      class="appFooterWrap"
      v-show="!isFullscreenView || showFullscreenFooter"
      @mouseleave="onFullscreenFooterMouseLeave"
    >
      <ReaderChapterNavBar
        v-if="readerChapterNavUiVisible && isFullscreenView"
        :visible="readerChapterNavVisible"
        :can-go-prev="readerChapterNavCanPrev"
        :can-go-next="readerChapterNavCanNext"
        :disabled="readerChapterNavBusy"
        @prev="jumpToPrevChapterWithVoiceRead"
        @next="jumpToNextChapterWithVoiceRead"
      />
      <AppFooter
        :loading="loading"
        :loading-progress-percent="loadingProgressPercent"
        :ebook-parsing="ebookParsing"
        :current-file="currentFile"
        :path-caption="footerPathCaption"
        :reading-progress-percent-part="readingProgressParts.percentPart"
        :reading-progress-detail-part="readingProgressParts.detailPart"
        :reading-progress-placeholder="readingProgressParts.placeholder"
        :reading-progress-complete="readingProgressParts.complete"
        :total-char-count-text="
          formatCharCount(totalCharCount, chapterCharCountExact)
        "
        :file-size-text="formatFileSize(currentFileSize)"
        :file-encoding="fileEncoding"
        :encoding-actions-enabled="footerEncodingActionsEnabled"
        :path-menu-reveal-enabled="footerPathMenuRevealEnabled"
        :path-menu-reload-enabled="footerPathMenuReloadEnabled"
        :path-menu-reconvert-enabled="footerPathMenuReconvertEnabled"
        :path-menu-close-enabled="footerPathMenuCloseEnabled"
        :web-dav-menu-enabled="webDavEnabled"
        :web-dav-book-pack-progress="webDavBookPackProgress"
        :edit-cursor-label="readerEditCursorFooterLabel"
        :pomodoro-enabled="pomodoroSettings.enabled"
        :pomodoro-phase="pomodoroPhase"
        :pomodoro-display-mode="pomodoroDisplayMode"
        :pomodoro-progress="pomodoroProgress"
        :pomodoro-countdown-text="pomodoroCountdownText"
        :pomodoro-pause-resume-label="pomodoroPauseResumeLabel"
        :pomodoro-paused="pomodoroPaused"
        @path-reveal-in-folder="revealCurrentFileInFolder"
        @path-reload="reloadCurrentFileFromDisk"
        @path-reconvert="reconvertCurrentEbookFromDisk"
        @path-upload-book-pack-web-dav="uploadCurrentReaderBookPackToWebDav"
        @path-update-book-pack-web-dav="updateCurrentReaderBookPackFromWebDav"
        @path-export-book-pack="exportCurrentReaderBookPack(false)"
        @path-export-book-pack-with-progress="exportCurrentReaderBookPack(true)"
        @path-clear-reading-data="clearCurrentFileReadingData"
        @path-close="closeCurrentFile"
        @save-file-as-encoding="onFooterSaveFileAsEncoding"
        @pomodoro-start="startPomodoro"
        @pomodoro-toggle-display-mode="togglePomodoroDisplayMode"
        @pomodoro-toggle-pause="togglePomodoroPause"
        @pomodoro-stop="stopPomodoro"
      />
    </div>
    <PomodoroBreakOverlay
      :visible="pomodoroShowBreakOverlay"
      :countdown-text="pomodoroCountdownText"
      @finish="finishPomodoroBreakEarly"
    />

    <AppDialogHost />
    <AppCaptchaHost />
    <AppToastHost />
    <AiSmartFormatProgressModal
      v-model="aiSmartFormatProgressOpen"
      :current="aiSmartFormatProgressCurrent"
      :total="aiSmartFormatProgressTotal"
      :show-token-usage="aiSmartFormatProgressShowTokenUsage"
      :token-usage="aiSmartFormatProgressTokenUsage"
      :token-usage-available="aiSmartFormatProgressTokenUsageAvailable"
      :token-price-per-million="aiSmartFormatProgressTokenPricePerMillion"
      @stop="stopAiSmartFormat()"
    />

    <WebDavSyncPanel
      v-model="showWebDavPanel"
      :web-dav="{
        webDavEnabled,
        webDavUrl,
        webDavUsername,
        webDavRemoteDir,
      }"
      :import-pack-paths="onWebDavImportPackPaths"
      @open-file="(p) => void openFilePath(p)"
      @config-downloaded="onWebDavConfigDownloaded"
    />

    <AppOverlays
      ref="appOverlaysRef"
      v-model:show-about-panel="showAboutPanel"
      v-model:show-shortcut-panel="showShortcutPanel"
      v-model:show-settings-panel="showSettingsPanel"
      v-model:show-color-scheme-panel="showColorSchemePanel"
      v-model:show-chapter-rule-panel="showChapterRulePanel"
      v-model:show-reading-data-panel="showReadingDataPanel"
      v-model:show-replace-rule-panel="showReplaceRulePanel"
      v-model:add-bookmark-open="addBookmarkOpen"
      v-model:remove-bookmark-open="removeBookmarkOpen"
      v-model:bookmark-note-input="bookmarkNoteInput"
      :restore-session-on-startup="restoreSessionOnStartup"
      :sync-current-file="syncCurrentFile"
      :recent-files-history-limit="recentFilesHistoryLimit"
      :chapter-min-char-count="chapterMinCharCount"
      :fullscreen-reader-width-percent="fullscreenReaderWidthPercent"
      :fullscreen-show-system-time="fullscreenShowSystemTime"
      :reader-font-size="readerFontSize"
      :reader-line-height-multiple="readerLineHeightMultiple"
      :compress-blank-keep-one-blank="compressBlankKeepOneBlank"
      :monaco-smooth-scrolling="monacoSmoothScrolling"
      :mouse-wheel-scroll-sensitivity="mouseWheelScrollSensitivity"
      :fast-scroll-sensitivity="fastScrollSensitivity"
      :sticky-chapter-title-enabled="stickyChapterTitleEnabled"
      :chapter-nav-toolbar-enabled="chapterNavToolbarEnabled"
      :chapter-char-count-exact="chapterCharCountExact"
      :timed-scroll-settings="timedScrollSettings"
      :pomodoro-settings="pomodoroSettings"
      :reader-edit-show-line-numbers="readerEditShowLineNumbers"
      :reader-edit-minimap="readerEditMinimap"
      :edit-auto-refresh-chapter-list="editAutoRefreshChapterList"
      :ai-smart-format="aiSmartFormat"
      :monaco-custom-highlight="monacoCustomHighlight"
      :txtr-delimited-match-cross-line="txtrDelimitedMatchCrossLine"
      :chapter-rules="chapterRuleState.rules"
      :chapter-rule-error-text="chapterRuleErrorText"
      :reader-edit-mode="readerEditMode"
      :editing-bookmark-line="editingBookmarkLine"
      :can-bookmark="canBookmark"
      :add-bookmark-dialog-preview="addBookmarkDialogPreview"
      :active-bookmark-in-viewport="activeBookmarkInViewport"
      :dir-list-scanning="dirListScanning"
      :dir-list-current-name="dirListCurrentName"
      :ebook-parsing="ebookParsing"
      :book-pack-unpacking="bookPackUnpacking"
      :shortcut-bindings="shortcutBindings"
      :default-shortcut-bindings="defaultShortcutBindings"
      :current-theme="currentTheme"
      :reader-surface-light="readerSurfaceLight"
      :reader-surface-dark="readerSurfaceDark"
      :reader-palette-color-enabled-light="readerPaletteColorEnabledLight"
      :reader-palette-color-enabled-dark="readerPaletteColorEnabledDark"
      :monaco-font-family="monacoFontFamily"
      :highlight-colors-light="highlightColorsLight"
      :highlight-colors-dark="highlightColorsDark"
      :lineation-colors-light="lineationColorsLight"
      :lineation-colors-dark="lineationColorsDark"
      :ebook-convert-output-dir="ebookConvertOutputDir"
      :book-pack-unpack-dir="bookPackUnpackDir"
      :book-pack-password="bookPackPassword"
      :web-dav-enabled="webDavEnabled"
      :web-dav-url="webDavUrl"
      :web-dav-username="webDavUsername"
      :web-dav-remote-dir="webDavRemoteDir"
      :character-portrait-cache-dir="characterPortraitCacheDir"
      :voice-read-settings="voiceReadSettings"
      :voice-read-profiles="voiceReadProfiles"
      :active-voice-read-profile-id="activeVoiceReadProfileId"
      :character-roster="currentFileCharacterRoster"
      :ai-skills-enabled="aiSkillsEnabled"
      :ai-skill-overrides="aiSkillOverrides"
      :ai-custom-skills="aiCustomSkills"
      :reading-data-items="readingDataItems"
      @apply-settings="applySettings"
      @apply-shortcut-bindings="applyShortcutBindings"
      @apply-chapter-rules="applyChapterMatchRules"
      @confirm-add-bookmark="confirmAddBookmark"
      @update-bookmark-to-current-viewport-line="
        updateEditingBookmarkToCurrentViewportLine
      "
      @confirm-remove-active-bookmark="confirmRemoveActiveBookmark"
      @apply-reader-palettes="onApplyReaderPalettes"
      @apply-highlight-colors="onApplyHighlightColors"
      @apply-lineation-colors="onApplyLineationColors"
      @open-reading-data="openReadingDataPanel"
      @clear-reading-data-paths="onClearReadingDataPaths"
      @clear-all-reading-data="onClearAllReadingData"
      @remove-missing-reading-data-files="onRemoveMissingReadingDataFiles"
      @apply-replace-rule-format="onApplyReplaceRuleFormat"
    />
  </div>
</template>

<style scoped src="./appShell.css"></style>
