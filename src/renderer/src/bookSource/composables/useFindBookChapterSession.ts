import {
  computed,
  nextTick,
  ref,
  type ComputedRef,
  type Ref,
} from "vue";
import type ReaderMain from "../../components/ReaderMain.vue";
import type { Book, BookChapter, SearchBookItem } from "@shared/bookSource/types";
import type { ReplaceRule } from "@shared/bookSource/replaceRule";
import {
  applyContentReplaceWithRules,
  applyTitleReplaceWithRules,
  filterEnabledReplaceRules,
} from "@shared/bookSource/replaceRuleApply";
import { listReplaceRulesLocal } from "../replaceRuleLocalStore";
import { formatPhysicalPlainTextForReader } from "../../reader/readerDisplayPipeline";
import { applyTextDisplayConverts } from "../../services/textConvertApply";
import { appConfirm } from "../../services/appDialog";
import { appToast } from "../../services/appToast";
import {
  contentChaptersInReadingOrder,
  displayIndexForReadingOrder,
  readingOrderIndexFromDisplay,
} from "../chapterReadingOrder";
import { useBookSourceChapterContent } from "./useBookSource";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";

export type FindBookChapterSessionDeps = {
  readerRef: Ref<InstanceType<typeof ReaderMain> | null>;
  detail: () => Book;
  item: () => SearchBookItem;
  displayChapters: ComputedRef<BookChapter[]> | Ref<BookChapter[]>;
  contentChapters: ComputedRef<BookChapter[]> | Ref<BookChapter[]>;
  chapterSortDesc: Ref<boolean>;
  currentDisplayIndex: Ref<number>;
  readerBootLoading: ComputedRef<boolean> | Ref<boolean>;
  textConvertZh: Ref<TextConvertZhMode>;
  textConvertLetter: Ref<TextConvertWidthMode>;
  textConvertDigit: Ref<TextConvertWidthMode>;
  compressBlankLines: Ref<boolean>;
  compressBlankKeepOneBlank: Ref<boolean>;
  leadIndentFullWidth: Ref<boolean>;
  chapterMinCharCount: Ref<number>;
  effectiveCacheDir: Ref<string>;
  isChapterCached: (ch: BookChapter) => boolean;
  markChapterCached: (url: string) => void;
  isInBookshelf: (bookUrl: string, origin: string) => boolean;
  updateReadProgress: (
    bookUrl: string,
    origin: string,
    chapterIndex: number,
    chapterTitle?: string,
  ) => void;
  scrollChapterListToCurrent: (options?: {
    force?: boolean;
    smooth?: boolean;
  }) => Promise<void>;
  /** 进入编辑前退出朗读（可晚绑定） */
  exitVoiceRead: () => void;
  /** 进入编辑前停止定时滚动（可晚绑定） */
  stopTimedScroll: () => void;
};

/**
 * 找书阅读器章节会话：加载正文、展示管线渲染、编辑进出/保存。
 * 面板负责编排与侧栏/页脚 UI；本 composable 持有章节内容状态。
 */
export function useFindBookChapterSession(deps: FindBookChapterSessionDeps) {
  const readerContentKey = ref<string | null>(null);
  const lastChapterTitle = ref("");
  const lastChapterBody = ref("");
  const totalLineCount = ref(0);
  const readerEditMode = ref(false);
  const readerEditorDirty = ref(false);
  /** 切章过程（含列表滚动等待）；与 IPC chapterLoading 合并为 chapterContentBusy */
  const loading = ref(false);
  /** 仅切到未缓存章节时为 true，控制侧栏 loading 图标与「加载中」提示 */
  const showChapterLoadingUi = ref(false);

  const {
    loading: chapterLoading,
    error: chapterError,
    logs,
    load: loadChapterContent,
    cancel: cancelChapterLoad,
  } = useBookSourceChapterContent();

  /** 展示管线用规则缓存（原文在 lastChapter*；规则变更时刷新） */
  const cachedReplaceRules = ref<ReplaceRule[]>([]);
  const replaceRulesLoaded = ref(false);

  async function refreshReplaceRulesCache() {
    try {
      cachedReplaceRules.value = listReplaceRulesLocal("findBook");
    } catch {
      cachedReplaceRules.value = [];
    } finally {
      replaceRulesLoaded.value = true;
    }
  }

  async function ensureReplaceRulesCache() {
    if (!replaceRulesLoaded.value) await refreshReplaceRulesCache();
  }

  function applyDisplayReplaceTitle(title: string): string {
    if (!title) return title;
    const d = deps.detail();
    const it = deps.item();
    const rules = filterEnabledReplaceRules(
      cachedReplaceRules.value,
      d.name || "",
      it.origin || "",
      "title",
    );
    return applyTitleReplaceWithRules(title, rules);
  }

  function applyDisplayReplaceBody(body: string): string {
    const d = deps.detail();
    const it = deps.item();
    const rules = filterEnabledReplaceRules(
      cachedReplaceRules.value,
      d.name || "",
      it.origin || "",
      "content",
    );
    return applyContentReplaceWithRules(body, rules);
  }

  /** 有已启用的规则 → 工具栏按钮激活（无总开关） */
  const textReplaceActive = computed(() => {
    const d = deps.detail();
    const it = deps.item();
    const name = d.name || "";
    const origin = it.origin || "";
    const rules = cachedReplaceRules.value;
    return (
      filterEnabledReplaceRules(rules, name, origin, "content").length > 0 ||
      filterEnabledReplaceRules(rules, name, origin, "title").length > 0
    );
  });

  function textConvertOptions() {
    return {
      zh: deps.textConvertZh.value,
      letter: deps.textConvertLetter.value,
      digit: deps.textConvertDigit.value,
    };
  }

  function contentIndexFor(ch: BookChapter): number {
    return deps.contentChapters.value.findIndex((c) => c.url === ch.url);
  }

  async function ensureChapterScrollAtTop() {
    for (let i = 0; i < 30 && !deps.readerRef.value; i++) {
      await nextTick();
    }
    const reader = deps.readerRef.value;
    if (!reader) return;
    reader.scrollToDocumentStart(false);
    await nextTick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          reader.scrollToDocumentStart(false);
          reader.refreshChapterStickyScroll?.();
          resolve();
        });
      });
    });
  }

  function stripLeadingChapterTitleFromBody(body: string, title: string): string {
    const rawTitle = title.trim();
    if (!rawTitle) return body;
    try {
      const titlePat = rawTitle
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s*");
      return body.replace(
        new RegExp(`^(?:\\s|\\p{P})*${titlePat}\\s*`, "u"),
        "",
      );
    } catch {
      return body;
    }
  }

  async function renderChapterText(
    heading: string,
    body: string,
    opts?: { resetScroll?: boolean },
  ) {
    await ensureReplaceRulesCache();
    const convertOpts = textConvertOptions();
    const rawTitle = heading.trim();
    // 正文若已带章节名（旧缓存 / ##{{title}} 未生效），先剥离再拼回一行，
    // 避免「橙色章节装饰行 + 正文里又一行黑字标题」
    let bodyText = stripLeadingChapterTitleFromBody(body, rawTitle);
    // 文本替换与「转换」同属展示管线：先替换，再简繁/全半角
    const titleText = applyDisplayReplaceTitle(rawTitle);
    bodyText = applyDisplayReplaceBody(bodyText);
    let text = titleText ? `${titleText}\n${bodyText}` : bodyText;
    text = await applyTextDisplayConverts(text, convertOpts);
    const formatted = formatPhysicalPlainTextForReader(text, {
      compressBlankLines: deps.compressBlankLines.value,
      compressBlankKeepOneBlank: deps.compressBlankKeepOneBlank.value,
      leadIndentFullWidth: deps.leadIndentFullWidth.value,
      minCharCount: deps.chapterMinCharCount.value,
      skipBlanksBeforeFirstChapterTitle: true,
    });
    for (let i = 0; i < 30 && !deps.readerRef.value; i++) {
      await nextTick();
    }
    const reader = deps.readerRef.value;
    if (!reader) return;
    await reader.setFullText(formatted.text, {
      heavy: false,
      resetScroll: opts?.resetScroll ?? true,
    });
    totalLineCount.value = reader.getModelLineCount?.() ?? formatted.lineCount;
    if (rawTitle) {
      const lineNumber =
        formatted.chapterTitleDisplayLineByPhysical.get(1) ?? 1;
      reader.setChapters([
        {
          title: rawTitle,
          lineNumber,
          headingLevel: 1,
        },
      ]);
    } else {
      reader.setChapters([]);
    }
  }

  /** 编辑态展示：缓存原文（章节名 + 正文），不经压缩空行等阅读管线 */
  function buildEditSourceText(): string {
    const rawTitle = lastChapterTitle.value.trim();
    const body = lastChapterBody.value;
    return rawTitle ? `${rawTitle}\n${body}` : body;
  }

  const chapterContentBusy = computed(
    () => loading.value || chapterLoading.value,
  );

  const canEnterReaderEditMode = computed(
    () =>
      Boolean(readerContentKey.value) &&
      !chapterContentBusy.value &&
      !deps.readerBootLoading.value,
  );

  async function confirmIfReaderEditDiscard(): Promise<boolean> {
    if (!readerEditMode.value || !readerEditorDirty.value) return true;
    return appConfirm(
      "当前章节已修改但尚未保存，确定要放弃这些改动吗？",
      "修改未保存",
    );
  }

  function onReaderEditDirtyChange(dirty: boolean) {
    readerEditorDirty.value = dirty;
  }

  async function onToggleReaderEdit() {
    if (readerEditMode.value) {
      if (!(await confirmIfReaderEditDiscard())) return;
      readerEditorDirty.value = false;
      readerEditMode.value = false;
      // 退出编辑：lastChapter* 仍为原文，重跑展示管线（文本替换 → 转换 → …）
      if (lastChapterBody.value || lastChapterTitle.value) {
        await renderChapterText(lastChapterTitle.value, lastChapterBody.value, {
          resetScroll: false,
        });
      }
      return;
    }
    if (!canEnterReaderEditMode.value) {
      appToast("请等待当前章节加载完成后再进入编辑模式。", { kind: "info" });
      return;
    }
    deps.exitVoiceRead();
    deps.stopTimedScroll();
    // 先进入编辑态再 setChapters，避免阅读态标题装饰残留（与主界面一致：编辑不渲标题样式）
    readerEditMode.value = true;
    await nextTick();
    // 进入编辑：直接编辑原文（文本替换只在阅读展示管线，不改 lastChapter*）
    const editText = buildEditSourceText();
    const reader = deps.readerRef.value;
    if (reader) {
      await reader.setFullText(editText, { heavy: false, resetScroll: false });
      totalLineCount.value = reader.getModelLineCount?.() ?? 0;
      if (lastChapterTitle.value.trim()) {
        reader.setChapters([
          {
            title: lastChapterTitle.value.trim(),
            lineNumber: 1,
            headingLevel: 1,
          },
        ]);
      } else {
        reader.setChapters([]);
      }
    }
    deps.readerRef.value?.markReaderEditSaved?.();
    readerEditorDirty.value = false;
  }

  async function onSaveReaderChapter() {
    if (!readerEditMode.value) return;
    const ch = deps.displayChapters.value[deps.currentDisplayIndex.value];
    const d = deps.detail();
    const it = deps.item();
    const bookUrl = d.bookUrl?.trim() || it.bookUrl?.trim();
    if (!ch?.url?.trim() || !bookUrl) {
      appToast("无法保存：缺少章节信息", { kind: "warning" });
      return;
    }
    const text = deps.readerRef.value?.getAllText() ?? "";
    const body = stripLeadingChapterTitleFromBody(text, lastChapterTitle.value);
    const r = await window.colorTxt.bookSourceSaveChapterCache({
      name: d.name || "",
      bookUrl,
      chapterUrl: ch.url,
      content: body,
      cacheDir: deps.effectiveCacheDir.value.trim() || undefined,
    });
    if (!r.ok) {
      appToast(r.message || "保存到缓存失败", { kind: "warning" });
      return;
    }
    lastChapterBody.value = body;
    deps.markChapterCached(ch.url);
    deps.readerRef.value?.markReaderEditSaved?.();
    readerEditorDirty.value = false;
    appToast("已保存到缓存", { kind: "success", duration: 1200 });
  }

  async function loadChapterAtDisplayIndex(
    index: number,
    options?: { smoothScroll?: boolean; preferCache?: boolean },
  ) {
    const ch = deps.displayChapters.value[index];
    if (!ch) return;
    if (!(await confirmIfReaderEditDiscard())) return;
    if (readerEditMode.value) {
      readerEditMode.value = false;
      readerEditorDirty.value = false;
    }
    const contentIndex = contentIndexFor(ch);
    if (contentIndex < 0) {
      // 分卷标题：不拉正文规则（对齐 Legado），仅展示卷名
      if (ch.isVolume) {
        if (!(await confirmIfReaderEditDiscard())) return;
        if (readerEditMode.value) {
          readerEditMode.value = false;
          readerEditorDirty.value = false;
        }
        deps.currentDisplayIndex.value = index;
        cancelChapterLoad();
        readerContentKey.value = `findbook://volume#${encodeURIComponent(ch.url)}`;
        lastChapterTitle.value = ch.title;
        lastChapterBody.value = "";
        totalLineCount.value = 0;
        await renderChapterText(ch.title, "");
        void deps.scrollChapterListToCurrent({
          smooth: options?.smoothScroll ?? true,
        });
      }
      return;
    }
    const preferCache = options?.preferCache !== false;
    const fromCache = preferCache && deps.isChapterCached(ch);
    const wantSmooth = options?.smoothScroll ?? true;
    deps.currentDisplayIndex.value = index;
    loading.value = true;
    showChapterLoadingUi.value = !fromCache;
    cancelChapterLoad();
    // 先启动侧栏居中动画，避免与 Monaco 正文写入抢主线程导致卡顿
    const scrollDone = deps.scrollChapterListToCurrent({ smooth: wantSmooth });
    if (!fromCache) {
      // 未缓存 / 强制刷新：遮罩盖住旧正文，切章期间不做 Monaco 清空（避免卡列表动画）
      readerContentKey.value = null;
      lastChapterTitle.value = "";
      lastChapterBody.value = "";
      totalLineCount.value = 0;
    }
    const listLen = deps.displayChapters.value.length;
    const readingIdx = readingOrderIndexFromDisplay(
      index,
      listLen,
      deps.chapterSortDesc.value,
    );
    const nextDisplayIdx = displayIndexForReadingOrder(
      readingIdx + 1,
      listLen,
      deps.chapterSortDesc.value,
    );
    const nextInReadingOrder =
      readingIdx + 1 < listLen
        ? deps.displayChapters.value[nextDisplayIdx]
        : undefined;
    const chapterUrlsInReadingOrder = contentChaptersInReadingOrder(
      deps.contentChapters.value,
    ).map((c) => c.url);
    const d = deps.detail();
    const it = deps.item();
    try {
      const loaded = await loadChapterContent({
        bookSourceUrl: it.origin,
        book: {
          ...d,
          kind: d.kind || it.kind || "",
          origin: it.origin,
          originName: it.originName,
        },
        chapterUrl: ch.url,
        chapterTitle: ch.title,
        chapterIndex: contentIndex,
        isVolume: ch.isVolume,
        nextChapterUrl: nextInReadingOrder?.url,
        chapterUrls: chapterUrlsInReadingOrder,
        cacheDir: deps.effectiveCacheDir.value.trim() || undefined,
        preferCache,
      });
      if (loaded == null) {
        readerContentKey.value = null;
        lastChapterTitle.value = ch.title;
        lastChapterBody.value = "";
        return;
      }
      const { content: body, displayTitle } = loaded;
      // 缓存命中往往立刻返回：等列表动画结束再写正文，避免与 rAF 平滑滚动抢帧
      if (wantSmooth) await scrollDone;
      deps.markChapterCached(ch.url);
      readerContentKey.value = `findbook://${d.bookUrl}#${ch.url}`;
      // IPC 返回缓存/联网原文；文本替换在 renderChapterText 中与「转换」一并套用
      lastChapterTitle.value = displayTitle || ch.title;
      lastChapterBody.value = body;
      await renderChapterText(lastChapterTitle.value, body);
      if (deps.isInBookshelf(d.bookUrl, it.origin)) {
        deps.updateReadProgress(d.bookUrl, it.origin, contentIndex, ch.title);
      }
    } finally {
      loading.value = false;
      showChapterLoadingUi.value = false;
      await ensureChapterScrollAtTop();
    }
  }

  function isChapterLoading(index: number): boolean {
    return showChapterLoadingUi.value && index === deps.currentDisplayIndex.value;
  }

  async function refreshCurrentChapterDisplay() {
    if (readerEditMode.value) return;
    if (!lastChapterBody.value) return;
    await renderChapterText(lastChapterTitle.value, lastChapterBody.value, {
      resetScroll: false,
    });
  }

  /** 关闭阅读器时清会话态（不取消 IPC：由调用方 cancelChapterLoad） */
  function resetChapterSessionUi() {
    loading.value = false;
    showChapterLoadingUi.value = false;
    readerEditMode.value = false;
    readerEditorDirty.value = false;
    readerContentKey.value = null;
    lastChapterBody.value = "";
    lastChapterTitle.value = "";
    totalLineCount.value = 0;
  }

  function clearReaderEditFlags() {
    readerEditMode.value = false;
    readerEditorDirty.value = false;
  }

  return {
    readerContentKey,
    lastChapterTitle,
    lastChapterBody,
    totalLineCount,
    readerEditMode,
    readerEditorDirty,
    loading,
    showChapterLoadingUi,
    chapterLoading,
    chapterError,
    logs,
    cancelChapterLoad,
    chapterContentBusy,
    cachedReplaceRules,
    textReplaceActive,
    refreshReplaceRulesCache,
    ensureReplaceRulesCache,
    applyDisplayReplaceTitle,
    applyDisplayReplaceBody,
    contentIndexFor,
    renderChapterText,
    canEnterReaderEditMode,
    confirmIfReaderEditDiscard,
    onReaderEditDirtyChange,
    onToggleReaderEdit,
    onSaveReaderChapter,
    loadChapterAtDisplayIndex,
    isChapterLoading,
    refreshCurrentChapterDisplay,
    resetChapterSessionUi,
    clearReaderEditFlags,
  };
}
