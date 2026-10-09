/** sxsy45 帖式书源「搜索更新」的标题解析：章节数 + 完结标记。
 * 规则见 .qwen/specs/2026-10-09-sxsy45-search-update-design.md 2.2 节：完结是最大的。 */

export interface SearchUpdateTitleInfo {
  /** 标题解析出的最大章节数；无数字为 0 */
  chapterNum: number;
  /** 是否完结版（优先级高于章节数） */
  finished: boolean;
}

/** 「A-B」「A~B」「A到B」取后者（如 1-1965 → 1965） */
const CH_RANGE_PATTERN = /(\d+)\s*[-—~至到]\s*(\d+)/g;
/** 「N章」取前者（如 1201章 → 1201） */
const CH_SINGLE_PATTERN = /(\d+)\s*章/g;
const FINISH_EXCLUDE_PATTERN = /未完结|未完|连载中/;
const FINISH_MARK_PATTERN = /已?完结|完本|全本|\d\s*完/;

export function parseSearchUpdateTitle(
  title: string | undefined | null,
): SearchUpdateTitleInfo {
  const raw = (title ?? "").trim();
  // 《》内书名先剥掉，防书名内数字/「完」字干扰
  const rest = raw.replace(/《[^》]*》/g, " ");
  let chapterNum = 0;
  for (const m of rest.matchAll(CH_RANGE_PATTERN)) {
    const v = Number(m[2]);
    if (Number.isFinite(v) && v > chapterNum) chapterNum = v;
  }
  for (const m of rest.matchAll(CH_SINGLE_PATTERN)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > chapterNum) chapterNum = v;
  }
  const finished = !FINISH_EXCLUDE_PATTERN.test(rest) && FINISH_MARK_PATTERN.test(rest);
  return { chapterNum, finished };
}

/** 标题包含书名即匹配（部分帖子标题没有《》包裹；方向保守：宁漏勿误） */
export function titleMatchesBookName(
  title: string | undefined | null,
  bookName: string | undefined | null,
): boolean {
  const t = (title ?? "").trim();
  const n = (bookName ?? "").trim();
  if (!t || !n) return false;
  return t.includes(n);
}

/** 候选帖是否优于书架基线（有更新）。无基线（首检）返回 false——只写基线不报更新。 */
export function isNewerThanBaseline(
  cand: SearchUpdateTitleInfo,
  base?: { chapterNum?: number; finished?: boolean } | null,
): boolean {
  if (!base || !base.chapterNum || base.chapterNum <= 0) return false;
  if (cand.chapterNum <= 0) return false;
  if (cand.finished !== base.finished) return cand.finished;
  return cand.chapterNum > base.chapterNum;
}

/** 搜索结果间选优：完结优先、章节数次之；chapterNum 为 0 不参与 */
export function isBetterCandidate(
  a: SearchUpdateTitleInfo,
  b: SearchUpdateTitleInfo,
): boolean {
  if (a.chapterNum <= 0) return false;
  if (b.chapterNum <= 0) return true;
  if (a.finished !== b.finished) return a.finished;
  return a.chapterNum > b.chapterNum;
}
