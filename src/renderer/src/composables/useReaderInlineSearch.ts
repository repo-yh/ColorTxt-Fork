import type { ShallowRef } from "vue";
import * as monaco from "monaco-editor";
import { ensureSearchAnchorCursorInViewport } from "../reader/ensureSearchAnchorCursorInViewport";

type MatchShape = { lineNumber: number; startColumn: number; endColumn: number };

/** 一键染色分组：每组同色高亮词合并成一个查询，用该组色值给滚动条指示条染色 */
type InlineSearchGroup = { query: string; useRegex: boolean; color: string };

/**
 * 与 Monaco FindModel.MATCHES_LIMIT 对齐。
 * `findMatches` 默认仅 999 条：高亮词组全文匹配常超限，导致后文无装饰、且「下一处」回绕到文首。
 */
const INLINE_SEARCH_MATCHES_LIMIT = 19999;

export function useReaderInlineSearch(deps: {
  editor: ShallowRef<monaco.editor.IStandaloneCodeEditor | null>;
  model: ShallowRef<monaco.editor.ITextModel | null>;
  inlineSearchDecorationsCollection: ShallowRef<monaco.editor.IEditorDecorationsCollection | null>;
  beginProgrammaticScroll: () => void;
  monacoScrollType: (smooth: boolean) => monaco.editor.ScrollType;
  suppressHighlightTipForProgrammaticSelection: () => void;
  /** 清除所有装饰器（包括 Ctrl+F 的） */
  onClearAllDecorations?: () => void;
}) {
  let inlineSearchQuery = "";
  let inlineSearchCaseSensitive = false;
  let inlineSearchWholeWord = false;
  let inlineSearchUseRegex = false;
  let inlineSearchCurrentMatch: MatchShape | null = null;
  /** Ctrl+F 打开时关闭内联搜索装饰器，需要时才恢复 */
  let inlineSearchDecorationsDisabled = false;
  /** 一键染色多组状态；非空时 applyInlineSearchDecorations 走分组染色 */
  let inlineSearchGroups: InlineSearchGroup[] = [];

  function isWordChar(ch: string): boolean {
    return /[0-9A-Za-z_]/.test(ch);
  }

  function isWholeWordRange(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    const leftOk = before === "" || !isWordChar(before);
    const rightOk = after === "" || !isWordChar(after);
    return leftOk && rightOk;
  }

  function matchPassesWholeWord(it: monaco.editor.FindMatch): boolean {
    if (!inlineSearchWholeWord) return true;
    const m = deps.model.value;
    if (!m) return false;
    const lineText = m.getLineContent(it.range.startLineNumber);
    const start = Math.max(0, it.range.startColumn - 1);
    const end = Math.max(start, it.range.endColumn - 1);
    return isWholeWordRange(lineText, start, end);
  }

  function sameInlineSearchMatch(a: MatchShape, b: monaco.Range) {
    return (
      a.lineNumber === b.startLineNumber &&
      a.startColumn === b.startColumn &&
      a.endColumn === b.endColumn
    );
  }

  function findInlineSearchMatches(query: string) {
    const m = deps.model.value;
    if (!m) return [] as monaco.editor.FindMatch[];
    let matches = m.findMatches(
      query,
      false,
      inlineSearchUseRegex,
      inlineSearchCaseSensitive,
      null,
      false,
      INLINE_SEARCH_MATCHES_LIMIT,
    );
    if (inlineSearchWholeWord) {
      matches = matches.filter(matchPassesWholeWord);
    }
    return matches;
  }

  /**
   * 从 searchStart 起逐条找「下一处/上一处」匹配（含起点列）。
   * 用 findNextMatch/findPreviousMatch 逐个查找，突破 findMatches 的 19999 上限，
   * 可跳转到全文任意匹配；guard 上限仅用于防止 wholeWord 过滤陷入死循环。
   */
  function findInlineSearchMatchFrom(
    query: string,
    searchStart: monaco.IPosition,
    direction: "next" | "prev",
  ): monaco.editor.FindMatch | null {
    const m = deps.model.value;
    if (!m) return null;
    let start: monaco.IPosition = {
      lineNumber: searchStart.lineNumber,
      column: searchStart.column,
    };
    for (let guard = 0; guard < INLINE_SEARCH_MATCHES_LIMIT; guard++) {
      const hit =
        direction === "next"
          ? m.findNextMatch(
              query,
              start,
              inlineSearchUseRegex,
              inlineSearchCaseSensitive,
              null,
              false,
            )
          : m.findPreviousMatch(
              query,
              start,
              inlineSearchUseRegex,
              inlineSearchCaseSensitive,
              null,
              false,
            );
      if (!hit) return null;
      if (matchPassesWholeWord(hit)) return hit;
      start =
        direction === "next"
          ? { lineNumber: hit.range.endLineNumber, column: hit.range.endColumn }
          : { lineNumber: hit.range.startLineNumber, column: hit.range.startColumn };
    }
    return null;
  }

  /** 一键染色：循环每个颜色组，用该组色值给滚动条指示条染色 */
  function applyGroupedInlineSearchDecorations() {
    const m = deps.model.value;
    const collection = deps.inlineSearchDecorationsCollection.value;
    if (!m || !collection) return;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const group of inlineSearchGroups) {
      const query = group.query.trim();
      if (!query) continue;
      const matches = m.findMatches(
        query,
        false,
        group.useRegex,
        false,
        null,
        false,
        INLINE_SEARCH_MATCHES_LIMIT,
      );
      for (const it of matches) {
        decorations.push({
          range: it.range,
          options: {
            inlineClassName: "readerInlineSearchMatch",
            overviewRuler: {
              color: group.color,
              position: monaco.editor.OverviewRulerLane.Center,
            },
          },
        });
      }
    }
    collection.set(decorations);
  }

  function applyInlineSearchDecorations() {
    const m = deps.model.value;
    const collection = deps.inlineSearchDecorationsCollection.value;
    if (!m || !collection) return;
    if (inlineSearchDecorationsDisabled) return;
    if (inlineSearchGroups.length > 0) {
      applyGroupedInlineSearchDecorations();
      return;
    }
    const query = inlineSearchQuery.trim();
    if (!query) {
      collection.clear();
      return;
    }
    const matches = findInlineSearchMatches(query);
    if (matches.length === 0) {
      collection.clear();
      return;
    }
    let currentMatchIndex = -1;
    if (inlineSearchCurrentMatch != null) {
      currentMatchIndex = matches.findIndex((it) =>
        sameInlineSearchMatch(inlineSearchCurrentMatch!, it.range),
      );
    }
    if (currentMatchIndex < 0) currentMatchIndex = 0;
    const currentRange = matches[currentMatchIndex]!.range;
    const decorations: monaco.editor.IModelDeltaDecoration[] = matches.map(
      (it, idx) => ({
        range: it.range,
        options: {
          inlineClassName:
            idx === currentMatchIndex
              ? "readerInlineSearchCurrentMatch"
              : "readerInlineSearchMatch",
          /** 在概览尺/滚动条上显示匹配位置指示条，颜色同 Ctrl+F */
          overviewRuler: {
            color: idx === currentMatchIndex ? "#f7dc6f" : "#a8ac94",
            position: monaco.editor.OverviewRulerLane.Center,
          },
        },
      }),
    );
    decorations.push({
      range: new monaco.Range(
        currentRange.startLineNumber,
        1,
        currentRange.startLineNumber,
        m.getLineMaxColumn(currentRange.startLineNumber),
      ),
      options: {
        isWholeLine: true,
        className: "readerInlineSearchCurrentLine",
        linesDecorationsClassName: "readerInlineSearchCurrentLineDecor",
      },
    });
    collection.set(decorations);
  }

  function setInlineSearchState(
    query: string,
    currentMatch?: MatchShape | null,
    options?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
    },
  ) {
    /** 用户主动设置染色状态时恢复内联搜索装饰器 */
    inlineSearchDecorationsDisabled = false;
    inlineSearchGroups = [];
    inlineSearchQuery = query.trim();
    inlineSearchCaseSensitive = options?.caseSensitive === true;
    inlineSearchWholeWord = options?.wholeWord === true;
    inlineSearchUseRegex = options?.useRegex === true;
    if (
      currentMatch &&
      Number.isFinite(currentMatch.lineNumber) &&
      Number.isFinite(currentMatch.startColumn) &&
      Number.isFinite(currentMatch.endColumn)
    ) {
      inlineSearchCurrentMatch = {
        lineNumber: Math.max(1, Math.floor(currentMatch.lineNumber)),
        startColumn: Math.max(1, Math.floor(currentMatch.startColumn)),
        endColumn: Math.max(
          1,
          Math.floor(Math.max(currentMatch.startColumn, currentMatch.endColumn)),
        ),
      };
    } else {
      inlineSearchCurrentMatch = null;
    }
    /** 先清理（含关闭 Ctrl+F）再染色，与点击高亮词一致 */
    deps.inlineSearchDecorationsCollection.value?.clear();
    deps.onClearAllDecorations?.();
    applyInlineSearchDecorations();
  }

  /** 一键染色：按颜色分组染色；循环前先清理旧染色，走同一装饰器集合可被其它动作清除 */
  function setInlineSearchGroups(groups: InlineSearchGroup[]) {
    inlineSearchDecorationsDisabled = false;
    inlineSearchGroups = groups;
    deps.inlineSearchDecorationsCollection.value?.clear();
    deps.onClearAllDecorations?.();
    applyInlineSearchDecorations();
  }

  function clearInlineSearchState() {
    inlineSearchQuery = "";
    inlineSearchCaseSensitive = false;
    inlineSearchWholeWord = false;
    inlineSearchUseRegex = false;
    inlineSearchCurrentMatch = null;
    inlineSearchGroups = [];
    deps.inlineSearchDecorationsCollection.value?.clear();
  }

  /** 仅清除装饰器并禁用（用于 Ctrl+F 打开时避免颜色共存） */
  function clearInlineSearchDecorations() {
    inlineSearchDecorationsDisabled = true;
    deps.inlineSearchDecorationsCollection.value?.clear();
  }

  function jumpToSearchMatchCentered(
    lineNumber: number,
    startColumn: number,
    endColumn: number,
    smooth = true,
  ) {
    const e = deps.editor.value;
    const m = deps.model.value;
    if (!e || !m) return;
    deps.beginProgrammaticScroll();
    const lineCount = m.getLineCount();
    const line = Math.max(
      1,
      Math.min(Math.floor(lineNumber), Math.max(1, lineCount)),
    );
    const maxCol = Math.max(1, m.getLineMaxColumn(line));
    const start = Math.max(1, Math.min(Math.floor(startColumn), maxCol));
    const end = Math.max(start, Math.min(Math.floor(endColumn), maxCol));
    const range = new monaco.Range(line, start, line, end);
    const selection = new monaco.Selection(line, start, line, end);
    const scrollType = deps.monacoScrollType(smooth);
    e.layout();
    deps.suppressHighlightTipForProgrammaticSelection();
    e.setPosition({ lineNumber: line, column: start });
    e.setSelection(selection);
    e.revealRangeInCenter(range, scrollType);
    const editorWithTopForPos = e as monaco.editor.IStandaloneCodeEditor & {
      getTopForPosition?: (lineNumber: number, column?: number) => number;
    };
    if (typeof editorWithTopForPos.getTopForPosition === "function") {
      const posTop = editorWithTopForPos.getTopForPosition(line, start);
      const vh = e.getLayoutInfo().height;
      const lineHeightPx = e.getOption(monaco.editor.EditorOption.lineHeight);
      const targetTop = Math.max(0, posTop - Math.floor(vh / 2) + lineHeightPx / 2);
      e.setScrollTop(targetTop, scrollType);
    }
    e.focus();
  }

  function jumpToNextInlineSearchMatch(
    query: string,
    options?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      useRegex?: boolean;
      smooth?: boolean;
      direction?: "prev" | "next";
    },
  ): boolean {
    const e = deps.editor.value;
    const m = deps.model.value;
    if (!e || !m) return false;
    const q = query.trim();
    if (!q) {
      clearInlineSearchState();
      return false;
    }
    /** 启用内联搜索装饰器（用户主动点击高亮词） */
    inlineSearchDecorationsDisabled = false;
    inlineSearchGroups = [];
    /** 视口外光标先挪到视口首行，便于从当前阅读位置继续查找 */
    ensureSearchAnchorCursorInViewport(e);

    inlineSearchQuery = q;
    inlineSearchCaseSensitive = options?.caseSensitive === true;
    inlineSearchWholeWord = options?.wholeWord === true;
    inlineSearchUseRegex = options?.useRegex === true;

    const prev = options?.direction === "prev";
    const sel = e.getSelection();
    let searchStart: monaco.IPosition;
    if (sel && !sel.isEmpty()) {
      searchStart = prev ? sel.getStartPosition() : sel.getEndPosition();
    } else {
      searchStart = e.getPosition() ?? { lineNumber: 1, column: 1 };
    }

    const hit = findInlineSearchMatchFrom(q, searchStart, prev ? "prev" : "next");
    if (!hit) {
      clearInlineSearchState();
      return false;
    }
    const target = hit.range;
    inlineSearchCurrentMatch = {
      lineNumber: target.startLineNumber,
      startColumn: target.startColumn,
      endColumn: target.endColumn,
    };
    /** 先清除内联搜索装饰器确保干净 */
    deps.inlineSearchDecorationsCollection.value?.clear();
    deps.onClearAllDecorations?.();
    applyInlineSearchDecorations();
    jumpToSearchMatchCentered(
      target.startLineNumber,
      target.startColumn,
      target.endColumn,
      options?.smooth !== false,
    );
    return true;
  }

  function hasInlineSearchQuery(): boolean {
    return inlineSearchQuery.trim().length > 0;
  }

  return {
    applyInlineSearchDecorations,
    setInlineSearchState,
    setInlineSearchGroups,
    clearInlineSearchState,
    clearInlineSearchDecorations,
    jumpToSearchMatchCentered,
    jumpToNextInlineSearchMatch,
    hasInlineSearchQuery,
  };
}
