import { computed, ref, watch, type Ref } from "vue";
import type ReaderMain from "../components/ReaderMain.vue";
import { APP_DISPLAY_NAME } from "../constants/appUi";
import { appAlert } from "../services/appDialog";
import { appToast } from "../services/appToast";
import { applyTextDisplayConverts } from "../services/textConvertApply";
import {
  assignHighlightTermToColorForFile,
  fileNameKey,
  findFileMetaRecord,
  removeHighlightTermFromFile,
  upsertFileMetaRecord,
  type FileMetaRecord,
  type HighlightWord,
  type HighlightWordsByIndex,
} from "../stores/fileMetaStore";
import {
  assignHighlightTermToColorMap,
  buildHighlightListTerms,
  findHighlightWordWithDefault,
  mergeHighlightWordsByIndex,
  removeHighlightTermFromMap,
  termExistsInHighlightMap,
  type HighlightListTerm,
} from "../utils/highlightWords";
import {
  isTextConvertDisplayActive,
  type TextConvertWidthMode,
  type TextConvertZhMode,
} from "@shared/textConvertTypes";

type ReaderRef = Ref<InstanceType<typeof ReaderMain> | null>;

/**
 * 高亮词：展示层刷新、侧栏列表、CRUD / 导入导出。
 */
export function useAppHighlightTerms(deps: {
  readerRef: ReaderRef;
  currentFile: Ref<string | null>;
  loading: Ref<boolean>;
  totalLineCount: Ref<number>;
  readerEditMode: Ref<boolean>;
  fileMetaRecords: Ref<FileMetaRecord[]>;
  highlightWordsByIndexGlobal: Ref<HighlightWordsByIndex | undefined>;
  highlightColorsForReader: Ref<readonly string[]>;
  currentTheme: Ref<string>;
  readerSurfaceLight: Ref<{ bodyText: string }>;
  readerSurfaceDark: Ref<{ bodyText: string }>;
  textConvertZh: Ref<TextConvertZhMode>;
  textConvertLetter: Ref<TextConvertWidthMode>;
  textConvertDigit: Ref<TextConvertWidthMode>;
  persistFileMeta: () => void;
  persistSettings: () => void;
  isVoiceReadNavigationBlocked: Ref<boolean>;
  ensurePinBeforeRevealFindWidget: () => void;
  hasInlineSearchHighlight: Ref<boolean>;
  editorContentChangeEpoch: Ref<number>;
}) {
  const currentFileHighlightWords = computed(
    () => {
      const path = deps.currentFile.value;
      if (!path) return undefined;
      return findFileMetaRecord(deps.fileMetaRecords.value, path)
        ?.highlightWordsByIndex;
    },
  );

  const mergedHighlightWordsForReader = computed(() =>
    mergeHighlightWordsByIndex(
      deps.highlightWordsByIndexGlobal.value,
      currentFileHighlightWords.value,
    ),
  );

  /** 只读展示层转换后的高亮词（Monaco 上色 / 侧栏列表 / 查找） */
  const readerDisplayHighlightWordsByIndex = ref<
    HighlightWordsByIndex | undefined
  >(undefined);
  const readerDisplayHighlightWordsBookOnly = ref<
    HighlightWordsByIndex | undefined
  >(undefined);
  const currentFileHighlightTerms = ref<HighlightListTerm[]>([]);

  let refreshHighlightDisplayGen = 0;

  function highlightListBodyTextColor(): string {
    return deps.currentTheme.value === "vs"
      ? deps.readerSurfaceLight.value.bodyText
      : deps.readerSurfaceDark.value.bodyText;
  }

  async function refreshReaderHighlightDisplayLayer() {
    const gen = ++refreshHighlightDisplayGen;
    const global = deps.highlightWordsByIndexGlobal.value;
    const book = currentFileHighlightWords.value;
    const colors = deps.highlightColorsForReader.value;
    const bodyText = highlightListBodyTextColor();
    const convertOpts = {
      zh: deps.textConvertZh.value,
      letter: deps.textConvertLetter.value,
      digit: deps.textConvertDigit.value,
    };
    const applyConvert =
      !deps.readerEditMode.value &&
      isTextConvertDisplayActive(
        convertOpts.zh,
        convertOpts.letter,
        convertOpts.digit,
      );

    if (!applyConvert) {
      if (gen !== refreshHighlightDisplayGen) return;
      readerDisplayHighlightWordsByIndex.value =
        mergedHighlightWordsForReader.value;
      readerDisplayHighlightWordsBookOnly.value = book;
      const raw = buildHighlightListTerms(
        global,
        book,
        colors,
        bodyText,
      );
      currentFileHighlightTerms.value =
        deps.readerRef.value?.countHighlightTermMatches(raw) ?? raw;
      return;
    }

    const displayByStored = new Map<string, string>();

    async function convertMapWithLookup(
      map: HighlightWordsByIndex | undefined,
    ): Promise<HighlightWordsByIndex | undefined> {
      if (!map) return undefined;
      const out: HighlightWordsByIndex = {};
      for (const [key, words] of Object.entries(map)) {
        const converted: HighlightWord[] = [];
        for (const stored of words) {
          if (!stored) continue;
          let display = displayByStored.get(stored.text);
          if (display == null) {
            display = await applyTextDisplayConverts(stored.text, convertOpts);
            displayByStored.set(stored.text, display);
          }
          converted.push({ text: display, isRegex: stored.isRegex });
        }
        if (converted.length > 0) out[key] = converted;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    const [globalDisplay, bookDisplay] = await Promise.all([
      convertMapWithLookup(global),
      convertMapWithLookup(book),
    ]);
    if (gen !== refreshHighlightDisplayGen) return;

    readerDisplayHighlightWordsByIndex.value = mergeHighlightWordsByIndex(
      globalDisplay,
      bookDisplay,
    );
    readerDisplayHighlightWordsBookOnly.value = bookDisplay;
    const raw = buildHighlightListTerms(
      global,
      book,
      colors,
      bodyText,
      (stored) => displayByStored.get(stored.text) ?? stored.text,
    );
    currentFileHighlightTerms.value =
      deps.readerRef.value?.countHighlightTermMatches(raw) ?? raw;
  }

  watch(
    [
      mergedHighlightWordsForReader,
      () => deps.textConvertZh.value,
      () => deps.textConvertLetter.value,
      () => deps.textConvertDigit.value,
      deps.readerEditMode,
      deps.highlightColorsForReader,
      deps.currentTheme,
      deps.editorContentChangeEpoch,
      deps.loading,
    ],
    () => {
      void refreshReaderHighlightDisplayLayer();
    },
    { deep: true, immediate: true },
  );

  function onAddHighlightTerm(payload: { text: string; colorIndex: number }) {
    const path = deps.currentFile.value;
    if (!path) return;
    deps.fileMetaRecords.value = assignHighlightTermToColorForFile(
      deps.fileMetaRecords.value,
      path,
      payload.colorIndex,
      { text: payload.text },
    );
    deps.persistFileMeta();
  }

  function onRemoveHighlightTerm(payload: {
    text: string;
    scope?: "global" | "book";
  }) {
    const term = { text: payload.text.trim() };
    if (payload.scope === "global") {
      deps.highlightWordsByIndexGlobal.value = removeHighlightTermFromMap(
        deps.highlightWordsByIndexGlobal.value,
        term,
      );
      deps.persistSettings();
      return;
    }
    const path = deps.currentFile.value;
    if (!path) return;
    deps.fileMetaRecords.value = removeHighlightTermFromFile(
      deps.fileMetaRecords.value,
      path,
      term,
    );
    deps.persistFileMeta();
  }

  function onFavoriteHighlightTerm(payload: {
    text: string;
    colorIndex: number;
  }) {
    const path = deps.currentFile.value;
    if (!path) return;
    const term = { text: payload.text.trim() };
    // 从全局词或本书词中查找 isRegex 属性，保留正则标记
    const sourceWord = findHighlightWordWithDefault(
      deps.highlightWordsByIndexGlobal.value,
      currentFileHighlightWords.value,
      term.text,
      term,
    );
    deps.fileMetaRecords.value = removeHighlightTermFromFile(
      deps.fileMetaRecords.value,
      path,
      term,
    );
    deps.highlightWordsByIndexGlobal.value = assignHighlightTermToColorMap(
      deps.highlightWordsByIndexGlobal.value,
      payload.colorIndex,
      sourceWord,
    );
    deps.persistFileMeta();
    deps.persistSettings();
  }

  function onUnfavoriteHighlightTerm(payload: {
    text: string;
    colorIndex: number;
  }) {
    const term = { text: payload.text.trim() };
    // 取消收藏前从全局词或本书词中查找 isRegex 属性（此时全局词中还有该词）
    const sourceWord = findHighlightWordWithDefault(
      deps.highlightWordsByIndexGlobal.value,
      currentFileHighlightWords.value,
      term.text,
      term,
    );
    // 现在再删除全局词
    deps.highlightWordsByIndexGlobal.value = removeHighlightTermFromMap(
      deps.highlightWordsByIndexGlobal.value,
      term,
    );
    const path = deps.currentFile.value;
    const bookHas = termExistsInHighlightMap(
      currentFileHighlightWords.value,
      term,
    );
    if (!bookHas && path) {
      deps.fileMetaRecords.value = assignHighlightTermToColorForFile(
        deps.fileMetaRecords.value,
        path,
        payload.colorIndex,
        sourceWord,
      );
      deps.persistFileMeta();
    }
    deps.persistSettings();
  }

  async function clearCurrentFileHighlightTerms() {
    const path = deps.currentFile.value;
    if (!path) return;
    const r = await window.colorTxt.showMessageBox({
      type: "warning",
      title: APP_DISPLAY_NAME,
      buttons: ["取消", "清空"],
      defaultId: 1,
      cancelId: 0,
      message: "是否要清空当前文件的所有本书高亮词？",
      detail: "此操作不可逆！",
      noLink: true,
    });
    if (r.response !== 1) return;
    deps.fileMetaRecords.value = upsertFileMetaRecord(
      deps.fileMetaRecords.value,
      path,
      () => ({ highlightWordsByIndex: undefined }),
    );
    deps.persistFileMeta();
  }

  async function onExportBookHighlightsJson() {
    const path = deps.currentFile.value;
    const map = currentFileHighlightWords.value;
    if (!path || !map) return;
    const {
      buildHighlightExportDefaultName,
      buildReaderHighlightsExportJson,
      countHighlightWordsInMap,
      saveHighlightExportFile,
    } = await import("../utils/readerHighlightExport");
    if (countHighlightWordsInMap(map) <= 0) return;
    const name = buildHighlightExportDefaultName(fileNameKey(path));
    const data = buildReaderHighlightsExportJson(map);
    const r = await saveHighlightExportFile(name, data);
    if (!r.ok && "error" in r) await appAlert(r.error);
  }

  async function onImportBookHighlightsJson() {
    const path = deps.currentFile.value;
    if (!path) return;
    const {
      countHighlightWordsInMap,
      mergeImportedHighlightWords,
      parseReaderHighlightsExportJson,
      pickAndReadHighlightJsonFile,
    } = await import("../utils/readerHighlightExport");
    const picked = await pickAndReadHighlightJsonFile("导入本书高亮词（JSON）");
    if (!picked.ok) {
      if ("error" in picked) await appAlert(picked.error);
      return;
    }
    const envelope = parseReaderHighlightsExportJson(picked.text);
    if (!envelope) {
      await appAlert("无效的高亮词 JSON 文件");
      return;
    }
    const imported = envelope.highlightWordsByIndex;
    const merged = mergeImportedHighlightWords(
      currentFileHighlightWords.value,
      imported,
    );
    deps.fileMetaRecords.value = upsertFileMetaRecord(
      deps.fileMetaRecords.value,
      path,
      () => ({ highlightWordsByIndex: merged }),
    );
    deps.persistFileMeta();
    appToast(`已导入 ${countHighlightWordsInMap(imported)} 个高亮词到本书`, {
      kind: "success",
    });
  }

  async function onExportFavoriteHighlightsJson() {
    const map = deps.highlightWordsByIndexGlobal.value;
    if (!map) return;
    const {
      buildHighlightExportDefaultName,
      buildReaderHighlightsExportJson,
      countHighlightWordsInMap,
      saveHighlightExportFile,
    } = await import("../utils/readerHighlightExport");
    if (countHighlightWordsInMap(map) <= 0) return;
    const path = deps.currentFile.value;
    const name = buildHighlightExportDefaultName(
      path ? fileNameKey(path) : "高亮词",
    );
    const data = buildReaderHighlightsExportJson(map);
    const r = await saveHighlightExportFile(name, data);
    if (!r.ok && "error" in r) await appAlert(r.error);
  }

  async function onImportFavoriteHighlightsJson() {
    const {
      countHighlightWordsInMap,
      mergeImportedHighlightWords,
      parseReaderHighlightsExportJson,
      pickAndReadHighlightJsonFile,
    } = await import("../utils/readerHighlightExport");
    const picked = await pickAndReadHighlightJsonFile("导入收藏高亮词（JSON）");
    if (!picked.ok) {
      if ("error" in picked) await appAlert(picked.error);
      return;
    }
    const envelope = parseReaderHighlightsExportJson(picked.text);
    if (!envelope) {
      await appAlert("无效的高亮词 JSON 文件");
      return;
    }
    const imported = envelope.highlightWordsByIndex;
    deps.highlightWordsByIndexGlobal.value = mergeImportedHighlightWords(
      deps.highlightWordsByIndexGlobal.value,
      imported,
    );
    deps.persistSettings();
    appToast(`已导入 ${countHighlightWordsInMap(imported)} 个收藏高亮词`, {
      kind: "success",
    });
  }

  function onFindHighlightTermFromSidebar(text: string, isRegex?: boolean) {
    if (
      !deps.currentFile.value ||
      deps.loading.value ||
      deps.totalLineCount.value <= 0
    )
      return;
    if (deps.isVoiceReadNavigationBlocked.value) return;
    deps.ensurePinBeforeRevealFindWidget();
    const useRegex = isRegex === true;
    const found = deps.readerRef.value?.jumpToNextInlineSearchMatch?.(text, {
      caseSensitive: false,
      wholeWord: false,
      useRegex,
      smooth: true,
    });
    deps.hasInlineSearchHighlight.value = found === true;
  }

  /** 从侧栏手动录入添加高亮词（随机颜色） */
  function onAddHighlightTermFromSidebar(text: string, isRegex?: boolean) {
    const path = deps.currentFile.value;
    if (!path) return;
    const colors = deps.highlightColorsForReader.value;
    const colorIndex = Math.floor(Math.random() * colors.length);
    deps.fileMetaRecords.value = assignHighlightTermToColorForFile(
      deps.fileMetaRecords.value,
      path,
      colorIndex,
      { text, isRegex: isRegex === true },
    );
    deps.persistFileMeta();
  }

  return {
    currentFileHighlightWords,
    mergedHighlightWordsForReader,
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
  };
}
