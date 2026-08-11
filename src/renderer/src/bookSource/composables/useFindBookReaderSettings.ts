import { computed } from "vue";
import {
  defaultChapterMinCharCount,
  defaultReaderPaletteDark,
  defaultReaderPaletteLight,
  maxFontSize,
  maxLineHeightMultipleForFontSize,
  mergeReaderPaletteColorEnabled,
  mergeReaderSurfacePalette,
  minFontSize,
  minLineHeightMultiple,
  persistKey,
  parseReaderPaletteColorEnabledOverrides,
  parseReaderPaletteOverrides,
  resolveEffectiveReaderPalette,
  overridesFromColorEnabled,
  overridesFromFullPalette,
  type ReaderSurfaceColorEnabled,
  type ReaderSurfacePalette,
} from "../../constants/appUi";
import {
  DEFAULT_HIGHLIGHT_COLORS_DARK,
  DEFAULT_HIGHLIGHT_COLORS_LIGHT,
  mergeHighlightColors,
  parseHighlightColorsArray,
} from "../../constants/highlightColors";
import {
  DEFAULT_LINEATION_COLORS_DARK,
  DEFAULT_LINEATION_COLORS_LIGHT,
  mergeLineationColors,
  parseLineationColorsArray,
} from "../../constants/lineationColors";
import {
  mergeVoiceReadSettings,
  type VoiceReadSettings,
} from "../../constants/voiceRead";
import type { VoiceReadProfile } from "@shared/voiceReadProfiles";
import {
  stripVoiceReadProfileApiKeysForDisk,
  stripVoiceReadSettingsApiKeysForDisk,
} from "@shared/voiceReadProfiles";
import type { HighlightWordsByIndex } from "../../stores/fileMetaStore";
import { normalizeHighlightWordsByIndex } from "../../stores/fileMetaStore";
import { loadPersistedSettingsData } from "../../stores/cacheStore";
import { patchPersistedMainSettings } from "../services/findBookSettingsStore";
import {
  cloneVoiceReadProfiles,
  migrateVoiceReadFromPersisted,
  normalizeVoiceReadProfilesForSave,
} from "../../services/voiceRead/voiceReadProfileState";
import { hydrateVoiceReadProfilesWithSecrets } from "../../services/voiceRead/voiceReadSecretsHydration";
import { ref } from "vue";
import { useFindBookSettings } from "./useFindBookSettings";

function loadMainSettingsData() {
  return loadPersistedSettingsData(localStorage, persistKey)?.data ?? {};
}

let store: ReturnType<typeof createFindBookReaderSettingsStore> | null = null;

function createFindBookReaderSettingsStore() {
  const fb = useFindBookSettings();
  const mainData = loadMainSettingsData();

  const currentTheme = ref<"vs" | "vs-dark">(
    mainData.theme === "vs-dark" ? "vs-dark" : "vs",
  );

  const chapterMinCharCount = ref(
    typeof mainData.chapterMinCharCount === "number"
      ? mainData.chapterMinCharCount
      : defaultChapterMinCharCount,
  );
  const aiFeaturesEnabled = ref(false);

  const readerPaletteOverridesLight = ref<Partial<ReaderSurfacePalette>>(
    mainData.readerPaletteOverridesLight ? { ...mainData.readerPaletteOverridesLight } : {},
  );
  const readerPaletteOverridesDark = ref<Partial<ReaderSurfacePalette>>(
    mainData.readerPaletteOverridesDark ? { ...mainData.readerPaletteOverridesDark } : {},
  );
  const readerPaletteColorEnabledOverridesLight = ref(
    mainData.readerPaletteColorEnabledOverridesLight
      ? parseReaderPaletteColorEnabledOverrides(
          mainData.readerPaletteColorEnabledOverridesLight,
        )
      : {},
  );
  const readerPaletteColorEnabledOverridesDark = ref(
    mainData.readerPaletteColorEnabledOverridesDark
      ? parseReaderPaletteColorEnabledOverrides(
          mainData.readerPaletteColorEnabledOverridesDark,
        )
      : {},
  );

  const readerSurfaceLight = computed(() =>
    mergeReaderSurfacePalette(
      defaultReaderPaletteLight,
      parseReaderPaletteOverrides(readerPaletteOverridesLight.value),
    ),
  );
  const readerSurfaceDark = computed(() =>
    mergeReaderSurfacePalette(
      defaultReaderPaletteDark,
      parseReaderPaletteOverrides(readerPaletteOverridesDark.value),
    ),
  );
  const readerPaletteColorEnabledLight = computed(() =>
    mergeReaderPaletteColorEnabled(
      readerPaletteColorEnabledOverridesLight.value,
    ),
  );
  const readerPaletteColorEnabledDark = computed(() =>
    mergeReaderPaletteColorEnabled(
      readerPaletteColorEnabledOverridesDark.value,
    ),
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

  const highlightColorsLight = ref(
    mergeHighlightColors(
      DEFAULT_HIGHLIGHT_COLORS_LIGHT,
      parseHighlightColorsArray(mainData.highlightColorsLight),
    ),
  );
  const highlightColorsDark = ref(
    mergeHighlightColors(
      DEFAULT_HIGHLIGHT_COLORS_DARK,
      parseHighlightColorsArray(mainData.highlightColorsDark),
    ),
  );
  const lineationColorsLight = ref(
    mergeLineationColors(
      DEFAULT_LINEATION_COLORS_LIGHT,
      parseLineationColorsArray(mainData.lineationColorsLight),
    ),
  );
  const lineationColorsDark = ref(
    mergeLineationColors(
      DEFAULT_LINEATION_COLORS_DARK,
      parseLineationColorsArray(mainData.lineationColorsDark),
    ),
  );
  const highlightWordsByIndexGlobal = ref<HighlightWordsByIndex | undefined>(
    normalizeHighlightWordsByIndex(mainData.highlightWordsByIndexGlobal),
  );

  const voiceReadProfiles = ref<VoiceReadProfile[]>([]);
  const activeVoiceReadProfileId = ref("");
  const voiceReadSettings = ref<VoiceReadSettings>(
    mergeVoiceReadSettings(undefined),
  );
  let voiceReadProfileBaselineIds = new Set<string>();
  /** 语音落盘基线：未改则保留磁盘；磁盘合并结果不灌回本窗内存 */
  const voiceReadPersistBaseline: Record<string, unknown> = {};

  function setVoiceReadProfileBaseline(profiles: readonly VoiceReadProfile[]) {
    voiceReadProfileBaselineIds = new Set(
      profiles.map((p) => p.id).filter(Boolean),
    );
  }

  function setVoiceReadPersistBaseline(payload: Record<string, unknown>) {
    Object.keys(voiceReadPersistBaseline).forEach((k) => {
      delete voiceReadPersistBaseline[k];
    });
    Object.assign(
      voiceReadPersistBaseline,
      JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    );
  }

  async function applyVoiceReadFromPersisted(
    raw: Parameters<typeof migrateVoiceReadFromPersisted>[0],
  ) {
    const bundle = migrateVoiceReadFromPersisted(raw);
    voiceReadProfiles.value = cloneVoiceReadProfiles(bundle.profiles);
    activeVoiceReadProfileId.value = bundle.activeProfileId;
    const hydrated = await hydrateVoiceReadProfilesWithSecrets(
      voiceReadProfiles.value,
      activeVoiceReadProfileId.value,
    );
    voiceReadSettings.value = mergeVoiceReadSettings(
      hydrated ?? bundle.activeSettings,
    );
    setVoiceReadProfileBaseline(voiceReadProfiles.value);
    const profilesForDisk = stripVoiceReadProfileApiKeysForDisk(
      normalizeVoiceReadProfilesForSave(voiceReadProfiles.value),
    );
    const voiceReadMerged = stripVoiceReadSettingsApiKeysForDisk(
      mergeVoiceReadSettings(voiceReadSettings.value),
    );
    const rawObj =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    setVoiceReadPersistBaseline({
      activeProfileId: activeVoiceReadProfileId.value,
      profiles: profilesForDisk,
      ...voiceReadMerged,
      aiSpeakerTokenUsage: rawObj.aiSpeakerTokenUsage,
      aiSpeakerTokenUsageAvailable: rawObj.aiSpeakerTokenUsageAvailable,
    });
  }

  void applyVoiceReadFromPersisted(
    mainData.voiceRead as Parameters<typeof migrateVoiceReadFromPersisted>[0],
  );

  const highlightColorsForReader = computed(() =>
    currentTheme.value === "vs"
      ? highlightColorsLight.value
      : highlightColorsDark.value,
  );
  const readerPaletteColorEnabledForReader = computed(() =>
    currentTheme.value === "vs"
      ? readerPaletteColorEnabledLight.value
      : readerPaletteColorEnabledDark.value,
  );

  const canIncreaseFont = computed(() => fb.readerFontSize.value < maxFontSize);
  const canDecreaseFont = computed(() => fb.readerFontSize.value > minFontSize);
  const canIncreaseLineHeight = computed(
    () =>
      fb.readerLineHeightMultiple.value <
      maxLineHeightMultipleForFontSize(fb.readerFontSize.value) - 1e-6,
  );
  const canDecreaseLineHeight = computed(
    () => fb.readerLineHeightMultiple.value > minLineHeightMultiple + 1e-6,
  );

  function syncThemeFromMain() {
    const data = loadMainSettingsData();
    currentTheme.value = data.theme === "vs-dark" ? "vs-dark" : "vs";
  }

  function syncPaletteFromMain() {
    const data = loadMainSettingsData();
    readerPaletteOverridesLight.value = data.readerPaletteOverridesLight
      ? { ...data.readerPaletteOverridesLight }
      : {};
    readerPaletteOverridesDark.value = data.readerPaletteOverridesDark
      ? { ...data.readerPaletteOverridesDark }
      : {};
    readerPaletteColorEnabledOverridesLight.value =
      data.readerPaletteColorEnabledOverridesLight
        ? parseReaderPaletteColorEnabledOverrides(
            data.readerPaletteColorEnabledOverridesLight,
          )
        : {};
    readerPaletteColorEnabledOverridesDark.value =
      data.readerPaletteColorEnabledOverridesDark
        ? parseReaderPaletteColorEnabledOverrides(
            data.readerPaletteColorEnabledOverridesDark,
          )
        : {};
    highlightColorsLight.value = mergeHighlightColors(
      DEFAULT_HIGHLIGHT_COLORS_LIGHT,
      parseHighlightColorsArray(data.highlightColorsLight),
    );
    highlightColorsDark.value = mergeHighlightColors(
      DEFAULT_HIGHLIGHT_COLORS_DARK,
      parseHighlightColorsArray(data.highlightColorsDark),
    );
    lineationColorsLight.value = mergeLineationColors(
      DEFAULT_LINEATION_COLORS_LIGHT,
      parseLineationColorsArray(data.lineationColorsLight),
    );
    lineationColorsDark.value = mergeLineationColors(
      DEFAULT_LINEATION_COLORS_DARK,
      parseLineationColorsArray(data.lineationColorsDark),
    );
    highlightWordsByIndexGlobal.value = normalizeHighlightWordsByIndex(
      data.highlightWordsByIndexGlobal,
    );
    if (
      typeof data.chapterMinCharCount === "number" &&
      Number.isFinite(data.chapterMinCharCount)
    ) {
      chapterMinCharCount.value = data.chapterMinCharCount;
    }
  }

  function syncVoiceReadFromMain() {
    void applyVoiceReadFromPersisted(
      loadMainSettingsData().voiceRead as Parameters<
        typeof migrateVoiceReadFromPersisted
      >[0],
    );
  }

  function syncSharedSettingsFromMain() {
    syncThemeFromMain();
    syncPaletteFromMain();
    // 阅读/编辑/语音与主窗口一样：各窗内存独立，仅启动时从 LS 加载
  }

  function applyReaderPalettes(payload: {
    light: ReaderSurfacePalette;
    dark: ReaderSurfacePalette;
    colorEnabledLight: ReaderSurfaceColorEnabled;
    colorEnabledDark: ReaderSurfaceColorEnabled;
  }) {
    const lightOverrides = overridesFromFullPalette(
      payload.light,
      defaultReaderPaletteLight,
    );
    const darkOverrides = overridesFromFullPalette(
      payload.dark,
      defaultReaderPaletteDark,
    );
    const colorEnabledLightOverrides = overridesFromColorEnabled(
      payload.colorEnabledLight,
    );
    const colorEnabledDarkOverrides = overridesFromColorEnabled(
      payload.colorEnabledDark,
    );
    readerPaletteOverridesLight.value = lightOverrides;
    readerPaletteOverridesDark.value = darkOverrides;
    readerPaletteColorEnabledOverridesLight.value = colorEnabledLightOverrides;
    readerPaletteColorEnabledOverridesDark.value = colorEnabledDarkOverrides;
    patchPersistedMainSettings({
      readerPaletteOverridesLight: lightOverrides,
      readerPaletteOverridesDark: darkOverrides,
      readerPaletteColorEnabledOverridesLight: colorEnabledLightOverrides,
      readerPaletteColorEnabledOverridesDark: colorEnabledDarkOverrides,
    });
  }

  return {
    currentTheme,
    sidebarWidth: fb.sidebarWidth,
    readerFontSize: fb.readerFontSize,
    readerLineHeightMultiple: fb.readerLineHeightMultiple,
    readerLineSpacingPx: fb.readerLineSpacingPx,
    readerLetterSpacingPx: fb.readerLetterSpacingPx,
    readerHorizontalInsetPx: fb.readerHorizontalInsetPx,
    monacoFontFamily: fb.monacoFontFamily,
    pinnedOtherFonts: fb.pinnedOtherFonts,
    monacoCustomHighlight: fb.monacoCustomHighlight,
    txtrDelimitedMatchCrossLine: fb.txtrDelimitedMatchCrossLine,
    compressBlankLines: fb.compressBlankLines,
    compressBlankKeepOneBlank: fb.compressBlankKeepOneBlank,
    chapterTitleBlankMode: fb.chapterTitleBlankMode,
    leadIndentFullWidth: fb.leadIndentFullWidth,
    textConvertZh: fb.textConvertZh,
    textConvertLetter: fb.textConvertLetter,
    textConvertDigit: fb.textConvertDigit,
    monacoAdvancedWrapping: fb.monacoAdvancedWrapping,
    monacoCjkWrapOptimize: fb.monacoCjkWrapOptimize,
    monacoSmoothScrolling: fb.monacoSmoothScrolling,
    mouseWheelScrollSensitivity: fb.mouseWheelScrollSensitivity,
    fastScrollSensitivity: fb.fastScrollSensitivity,
    stickyChapterTitleEnabled: fb.stickyChapterTitleEnabled,
    chapterNavToolbarEnabled: fb.chapterNavToolbarEnabled,
    selectionToolbarButtons: fb.selectionToolbarButtons,
    readerEditShowLineNumbers: fb.readerEditShowLineNumbers,
    readerEditMinimap: fb.readerEditMinimap,
    fullscreenReaderWidthPercent: fb.fullscreenReaderWidthPercent,
    fullscreenShowSystemTime: fb.fullscreenShowSystemTime,
    chapterMinCharCount,
    timedScrollSettings: fb.timedScrollSettings,
    aiFeaturesEnabled,
    readerSurfaceLight,
    readerSurfaceDark,
    readerPaletteColorEnabledLight,
    readerPaletteColorEnabledDark,
    effectiveReaderSurfaceLight,
    effectiveReaderSurfaceDark,
    highlightColorsForReader,
    lineationColorsLight,
    lineationColorsDark,
    readerPaletteColorEnabledForReader,
    highlightWordsByIndexGlobal,
    voiceReadProfiles,
    activeVoiceReadProfileId,
    voiceReadSettings,
    getVoiceReadProfileBaselineIds: () => voiceReadProfileBaselineIds,
    setVoiceReadProfileBaseline,
    voiceReadPersistBaseline,
    setVoiceReadPersistBaseline,
    canIncreaseFont,
    canDecreaseFont,
    canIncreaseLineHeight,
    canDecreaseLineHeight,
    persistReaderUiPrefs: fb.persistReaderUiPrefs,
    applyReaderPalettes,
    syncThemeFromMain,
    syncPaletteFromMain,
    syncVoiceReadFromMain,
    syncSharedSettingsFromMain,
  };
}

export function useFindBookReaderSettings() {
  if (!store) store = createFindBookReaderSettingsStore();
  return store;
}

export function resetFindBookReaderSettingsStoreForTests() {
  store = null;
}
