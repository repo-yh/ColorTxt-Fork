import type { HighlightWord, HighlightWordsByIndex } from "../stores/fileMetaStore";

export type HighlightListTerm = {
  terms: string[];
  storedTerms: string[];
  /** 编辑操作用的 HighlightWord[]（含 isRegex） */
  storedWords?: HighlightWord[];
  color: string;
  colorIndex: number;
  scope: "global" | "book";
  isFavorited: boolean;
  matchCount: number;
  termMatchCounts?: number[];
};

const MAX_HIGHLIGHT_TERM_LEN = 100;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildHighlightFindQuery(
  words: readonly HighlightWord[],
): { query: string; useRegex: boolean } {
  const cleaned = words
    .map((w) => ({ text: w.text.trim(), isRegex: w.isRegex ?? false }))
    .filter((w) => w.text);
  if (cleaned.length === 0) return { query: "", useRegex: false };
  if (cleaned.length === 1) {
    const w = cleaned[0]!;
    return { query: w.text, useRegex: w.isRegex };
  }
  return {
    query: cleaned
      .map((w) => (w.isRegex ? w.text : escapeRegExp(w.text)))
      .join("|"),
    useRegex: true,
  };
}

export function highlightGroupsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

function trimTerm(text: string): string {
  let term = text.trim();
  if (!term) return "";
  if (term.length > MAX_HIGHLIGHT_TERM_LEN) term = term.slice(0, MAX_HIGHLIGHT_TERM_LEN);
  return term;
}

export function normalizeHighlightGroup(
  texts: readonly string[] | readonly HighlightWord[],
): HighlightWord[] | null {
  const out: HighlightWord[] = [];
  const seen = new Set<string>();
  for (const item of texts) {
    const w: HighlightWord =
      typeof item === "string" ? { text: item } : item;
    const t = trimTerm(w.text);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ text: t, ...(w.isRegex ? { isRegex: true } as const : {}) });
  }
  return out.length > 0 ? out : null;
}

function groupTexts(g: readonly HighlightWord[]): string[] {
  return g.map((w) => w.text);
}

function removeTermFromMap(map: HighlightWordsByIndex, term: string): boolean {
  let changed = false;
  for (const k of Object.keys(map)) {
    const prevGroups = map[k]!;
    const nextGroups: HighlightWord[][] = [];
    for (const g of prevGroups) {
      if (!g.some((w) => w.text === term)) { nextGroups.push(g); continue; }
      changed = true;
      const next = g.filter((w) => w.text !== term);
      if (next.length > 0) nextGroups.push(next);
    }
    if (nextGroups.length === 0) delete map[k];
    else map[k] = nextGroups;
  }
  return changed;
}

function removeGroupFromMap(
  map: HighlightWordsByIndex,
  storedTerms: readonly string[],
): boolean {
  let changed = false;
  for (const k of Object.keys(map)) {
    const prev = map[k]!;
    const next = prev.filter((g) => !highlightGroupsEqual(groupTexts(g), storedTerms));
    if (next.length !== prev.length) changed = true;
    if (next.length === 0) delete map[k];
    else map[k] = next;
  }
  return changed;
}

export function findGroupLocation(
  map: HighlightWordsByIndex,
  storedTerms: readonly string[],
): { key: string; index: number } | null {
  for (const [k, groups] of Object.entries(map)) {
    const i = groups.findIndex((g) => highlightGroupsEqual(groupTexts(g), storedTerms));
    if (i >= 0) return { key: k, index: i };
  }
  return null;
}

function cloneMap(map: HighlightWordsByIndex | undefined): HighlightWordsByIndex {
  const out: HighlightWordsByIndex = {};
  if (!map) return out;
  for (const [k, groups] of Object.entries(map)) {
    out[k] = groups.map((g) => g.map((w) => ({ ...w })));
  }
  return out;
}

export function assignHighlightTermToColorMap(
  map: HighlightWordsByIndex | undefined,
  colorIndex: number,
  text: string,
): HighlightWordsByIndex | undefined {
  const term = trimTerm(text);
  if (!term || colorIndex < 0 || !Number.isFinite(colorIndex)) return map;
  return upsertHighlightGroupInMap(map, colorIndex, [{ text: term }], { matchSingletonOnly: false });
}

export function upsertHighlightGroupInMap(
  map: HighlightWordsByIndex | undefined,
  colorIndex: number,
  terms: readonly HighlightWord[],
  opts?: {
    replaceStoredTerms?: readonly string[];
    matchSingletonOnly?: boolean;
  },
): HighlightWordsByIndex | undefined {
  if (!terms.length || colorIndex < 0 || !Number.isFinite(colorIndex)) return map;
  const targetKey = String(Math.floor(colorIndex));
  const base = cloneMap(map);

  if (opts?.replaceStoredTerms) {
    removeGroupFromMap(base, opts.replaceStoredTerms);
  }

  for (const w of terms) {
    removeTermFromMap(base, w.text);
  }

  const list = [...(base[targetKey] ?? [])];
  list.push([...terms]);
  base[targetKey] = list;
  return base;
}

export function setHighlightGroupColorInMap(
  map: HighlightWordsByIndex | undefined,
  storedTerms: readonly string[],
  colorIndex: number,
): HighlightWordsByIndex | undefined {
  const group = normalizeHighlightGroup(storedTerms);
  if (!group || !map || colorIndex < 0 || !Number.isFinite(colorIndex)) return map;
  const targetKey = String(Math.floor(colorIndex));
  const loc = findGroupLocation(map, storedTerms);
  if (!loc) return map;
  if (loc.key === targetKey) return map;

  const base = cloneMap(map);
  const fromList = [...base[loc.key]!];
  const [moved] = fromList.splice(loc.index, 1);
  if (!moved) return map;
  if (fromList.length === 0) delete base[loc.key];
  else base[loc.key] = fromList;

  const toList = [...(base[targetKey] ?? [])];
  toList.push(moved);
  base[targetKey] = toList;
  return base;
}

export function removeHighlightGroupFromMap(
  map: HighlightWordsByIndex | undefined,
  storedTerms: readonly string[],
): HighlightWordsByIndex | undefined {
  const group = normalizeHighlightGroup(storedTerms);
  if (!group || !map) return map;
  const base = cloneMap(map);
  if (!removeGroupFromMap(base, storedTerms)) return map;
  return Object.keys(base).length > 0 ? base : undefined;
}

export function mergeHighlightGroupsInMap(
  map: HighlightWordsByIndex | undefined,
  sourceStoredTerms: readonly HighlightWord[],
  targetStoredTerms: readonly HighlightWord[],
  targetColorIndex: number,
): HighlightWordsByIndex | undefined {
  if (!sourceStoredTerms.length || !targetStoredTerms.length) return map;
  const merged = normalizeHighlightGroup([...targetStoredTerms, ...sourceStoredTerms]);
  if (!merged) return map;
  if (targetColorIndex < 0 || !Number.isFinite(targetColorIndex)) return map;
  return upsertHighlightGroupInMap(map, targetColorIndex, merged, {
    replaceStoredTerms: targetStoredTerms.map((w) => w.text),
  });
}

export function splitTermFromHighlightGroupInMap(
  map: HighlightWordsByIndex | undefined,
  storedTerms: readonly string[],
  termToSplit: string,
  colorIndex: number,
): HighlightWordsByIndex | undefined {
  if (!map || colorIndex < 0 || !Number.isFinite(colorIndex)) return map;
  const loc = findGroupLocation(map, storedTerms);
  if (!loc) return map;
  const originalGroup = map[loc.key]![loc.index]!;
  if (originalGroup.length < 2) return map;
  const term = trimTerm(termToSplit);
  if (!term) return map;
  const splitWord = originalGroup.find((w) => w.text === term);
  if (!splitWord) return map;
  const remaining = originalGroup.filter((w) => w.text !== term);
  let next = removeHighlightGroupFromMap(map, storedTerms);
  next = upsertHighlightGroupInMap(next, colorIndex, remaining);
  next = upsertHighlightGroupInMap(next, colorIndex, [{ text: term, ...(splitWord.isRegex ? { isRegex: true } as const : {}) }]);
  return next;
}

export function removeHighlightTermFromMap(
  map: HighlightWordsByIndex | undefined,
  text: string,
): HighlightWordsByIndex | undefined {
  const term = trimTerm(text);
  if (!term || !map) return map;
  const base = cloneMap(map);
  if (!removeTermFromMap(base, term)) return map;
  return Object.keys(base).length > 0 ? base : undefined;
}

export function termExistsInHighlightMap(
  map: HighlightWordsByIndex | undefined,
  text: string,
): boolean {
  const term = trimTerm(text);
  if (!term || !map) return false;
  return Object.values(map).some((groups) =>
    groups.some((g) => g.some((w) => w.text === term)),
  );
}

export function groupExistsInHighlightMap(
  map: HighlightWordsByIndex | undefined,
  storedTerms: readonly string[],
): boolean {
  const group = normalizeHighlightGroup(storedTerms);
  if (!group || !map) return false;
  return findGroupLocation(map, storedTerms) != null;
}

export function findHighlightColorIndexInMap(
  map: HighlightWordsByIndex | undefined,
  text: string,
): number | null {
  const term = trimTerm(text);
  if (!term || !map) return null;
  for (const [k, groups] of Object.entries(map)) {
    if (!groups.some((g) => g.some((w) => w.text === term))) continue;
    const idx = Number.parseInt(k, 10);
    if (Number.isFinite(idx) && idx >= 0) return idx;
  }
  return null;
}

export function mergeHighlightWordsByIndex(
  global: HighlightWordsByIndex | undefined,
  book: HighlightWordsByIndex | undefined,
): HighlightWordsByIndex | undefined {
  if (!global && !book) return undefined;
  const out = cloneMap(global);
  if (!book) return Object.keys(out).length > 0 ? out : undefined;
  for (const [k, groups] of Object.entries(book)) {
    const idx = Number.parseInt(k, 10);
    if (!Number.isFinite(idx) || idx < 0) continue;
    for (const g of groups) {
      if (!g.length) continue;
      for (const w of g) {
        if (w.text) removeTermFromMap(out, w.text);
      }
      const key = String(idx);
      const list = [...(out[key] ?? [])];
      list.push(g.map((w) => ({ ...w })));
      out[key] = list;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function expandHighlightMapToListTerms(
  map: HighlightWordsByIndex | undefined,
  scope: "global" | "book",
  colors: readonly string[],
  bodyText: string,
  toDisplayText?: (stored: string) => string,
): HighlightListTerm[] {
  if (!map) return [];
  const isFavorited = scope === "global";
  const out: HighlightListTerm[] = [];
  for (const [idxKey, groups] of Object.entries(map)) {
    const idx = Number.parseInt(idxKey, 10);
    if (!Number.isFinite(idx) || idx < 0) continue;
    const color = idx < colors.length ? colors[idx]! : bodyText;
    for (const group of groups) {
      if (!group.length) continue;
      const storedTerms = group.map((w) => w.text);
      const terms = storedTerms.map((s) => toDisplayText?.(s) ?? s);
      out.push({
        terms,
        storedTerms: [...storedTerms],
        storedWords: group.map((w) => ({ ...w })),
        color,
        colorIndex: idx,
        scope,
        isFavorited,
        matchCount: 0,
      });
    }
  }
  return out;
}

export function buildHighlightListTerms(
  global: HighlightWordsByIndex | undefined,
  book: HighlightWordsByIndex | undefined,
  colors: readonly string[],
  bodyText: string,
  toDisplayText?: (stored: string) => string,
): HighlightListTerm[] {
  return [
    ...expandHighlightMapToListTerms(global, "global", colors, bodyText, toDisplayText),
    ...expandHighlightMapToListTerms(book, "book", colors, bodyText, toDisplayText),
  ];
}

export function highlightGroupListKeyBase(storedTerms: readonly string[]): string {
  return [...storedTerms]
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .join("\0");
}
