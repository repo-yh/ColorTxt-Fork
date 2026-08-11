import type * as monaco from "monaco-editor";
import type { HighlightWordsByIndex } from "../stores/fileMetaStore";

/** 与装饰方案一致：更长词优先，同长则更小的高亮色索引优先 */
export type TxtrMonarchHighlightOptions = {
  enabled: boolean;
  /** 合法高亮色索引上界（与 `highlightColors.length` 一致） */
  highlightColorsLength: number;
  highlightWordsByIndex: HighlightWordsByIndex | undefined;
};

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// 旧版函数（HighlightWord / isRegex 模型），保留以供参考
// ============================================================
// function buildHighlightPattern(word: HighlightWord): RegExp {
//   if (word.isRegex) {
//     try {
//       return new RegExp(word.text, "iu");
//     } catch {
//       return /^$/;
//     }
//   }
//   return new RegExp(escapeRegExpLiteral(word.text), "iu");
// }

// function highlightPatternLength(word: HighlightWord): number {
//   return word.text.length;
// }

/**
 * 生成自定义高亮词的 Monarch 规则（每条一词一类 token：`txtr.customHighlight.{index}`）。
 * 所有词组内各词均走字面量匹配，大小写不敏感。
 * 与原先 `findMatches` 一致：大小写不敏感。
 */
export function buildTxtrCustomHighlightMonarchRules(
  opts: TxtrMonarchHighlightOptions,
): monaco.languages.IMonarchLanguageRule[] {
  if (
    !opts.enabled ||
    opts.highlightColorsLength <= 0 ||
    !opts.highlightWordsByIndex
  ) {
    return [];
  }

  type Entry = { phrase: string; pattern: RegExp; colorIndex: number; len: number };
  const entries: Entry[] = [];

  for (const [key, groups] of Object.entries(opts.highlightWordsByIndex)) {
    const idx = Number.parseInt(key, 10);
    if (
      !Number.isFinite(idx) ||
      idx < 0 ||
      idx >= opts.highlightColorsLength
    ) {
      continue;
    }
    for (const group of groups) {
      for (const phrase of group) {
        if (!phrase) continue;
        entries.push({
          phrase,
          pattern: new RegExp(escapeRegExpLiteral(phrase), "iu"),
          colorIndex: idx,
          len: phrase.length,
        });
      }
    }
  }

  const seen = new Set<string>();
  const unique: Entry[] = [];
  for (const e of entries) {
    const k = `${e.colorIndex}\0${e.pattern.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }

  unique.sort((a, b) => {
    if (b.len !== a.len) return b.len - a.len;
    return a.colorIndex - b.colorIndex;
  });

  return unique.map((e) => [
    e.pattern,
    `txtr.customHighlight.${e.colorIndex}`,
  ]);
}
