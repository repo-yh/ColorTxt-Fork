import type * as monaco from "monaco-editor";
import type { HighlightWord, HighlightWordsByIndex } from "../stores/fileMetaStore";

export type TxtrMonarchHighlightOptions = {
  enabled: boolean;
  highlightColorsLength: number;
  highlightWordsByIndex: HighlightWordsByIndex | undefined;
};

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightPattern(word: HighlightWord): RegExp {
  if (word.isRegex) {
    try {
      return new RegExp(word.text, "iu");
    } catch {
      return /^$/;
    }
  }
  return new RegExp(escapeRegExpLiteral(word.text), "iu");
}

export function buildTxtrCustomHighlightMonarchRules(
  opts: TxtrMonarchHighlightOptions,
): monaco.languages.IMonarchLanguageRule[] {
  if (!opts.enabled || opts.highlightColorsLength <= 0 || !opts.highlightWordsByIndex) {
    return [];
  }

  type Entry = { phrase: string; pattern: RegExp; colorIndex: number; len: number };
  const entries: Entry[] = [];

  for (const [key, groups] of Object.entries(opts.highlightWordsByIndex)) {
    const idx = Number.parseInt(key, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= opts.highlightColorsLength) continue;
    for (const group of groups) {
      for (const word of group) {
        if (!word.text) continue;
        entries.push({
          phrase: word.text,
          pattern: buildHighlightPattern(word),
          colorIndex: idx,
          len: word.text.length,
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

  return unique.map((e) => [e.pattern, `txtr.customHighlight.${e.colorIndex}`]);
}
