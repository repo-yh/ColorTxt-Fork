import type { Ref } from "vue";
import { appAlert, appPrompt } from "../services/appDialog";
import { appLoading } from "../services/appLoading";
import { hashBookBrowser } from "../utils/aiBookHash";

export type UseHighlightAiSearchOptions = {
  sessionFilePath: Ref<string | null | undefined>;
  physicalReaderPath: Ref<string | null | undefined>;
  chapterCount: Ref<number>;
  /** 检索成功后的词语列表（已按出现次数降序） */
  onTerms: (terms: string[]) => void;
};

let nextWordcloudRequestId = 1;

/**
 * 侧栏高亮词「AI 检索」：复用 semantic 词云管线，只要词语列表并打开添加面板。
 * 始终全书检索，不受「防剧透」限制；检索中按 Esc 可中止。
 */
export function useHighlightAiSearch(opts: UseHighlightAiSearchOptions) {
  async function resolveBookHash(): Promise<string | null> {
    const session = opts.sessionFilePath.value?.trim();
    const physical = opts.physicalReaderPath.value?.trim() || session;
    if (!session || !physical) return null;
    try {
      const st = await window.colorTxt.stat(physical);
      if (!st.isFile) return null;
      return hashBookBrowser(session, st.size, st.mtimeMs);
    } catch {
      return null;
    }
  }

  async function runSemanticSearch(semanticQuery: string): Promise<void> {
    const q = semanticQuery.trim();
    if (!q) {
      await appAlert("请输入检索语义。");
      return;
    }
    if (!opts.sessionFilePath.value?.trim()) {
      await appAlert("请先打开一本书。");
      return;
    }
    const chapterCount = opts.chapterCount.value;
    if (!Number.isFinite(chapterCount) || chapterCount <= 0) {
      await appAlert("当前书籍没有可检索的章节。");
      return;
    }

    const bookHash = await resolveBookHash();
    if (!bookHash) {
      await appAlert("无法识别当前书籍，请确认文件已正确打开。");
      return;
    }

    const requestId = nextWordcloudRequestId++;
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      void window.colorTxt.ai.wordcloudAbort(requestId);
    };

    const res = await appLoading.with("AI 检索中", async () => {
      window.addEventListener("keydown", onEsc, true);
      try {
        return await window.colorTxt.ai.wordcloudRun({
          bookHash,
          chapterCount: Math.trunc(chapterCount),
          semanticQuery: q,
          title: `AI 检索：${q}`,
          unlimitedTerms: true,
          requestId,
        });
      } finally {
        window.removeEventListener("keydown", onEsc, true);
      }
    });

    if (!res.ok) {
      if (res.aborted) return;
      await appAlert(res.error || "AI 检索失败。");
      return;
    }

    const terms = res.result.words.map((w) => w.text).filter(Boolean);
    if (terms.length === 0) {
      await appAlert("未检索到相关词语。");
      return;
    }
    opts.onTerms(terms);
  }

  async function searchPreset(label: string): Promise<void> {
    await runSemanticSearch(label);
  }

  async function searchCustomSemantic(): Promise<void> {
    const input = await appPrompt("描述要检索的词语语义", {
      title: "AI 检索：自定义语义",
      placeholder: "例如：武功招式、修行境界、武器装备、官职…",
      defaultValue: "",
    });
    if (input == null) return;
    await runSemanticSearch(input);
  }

  return {
    searchPreset,
    searchCustomSemantic,
    runSemanticSearch,
  };
}
