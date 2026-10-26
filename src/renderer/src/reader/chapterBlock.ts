import type { Chapter } from "../chapter";
import type { BlockedChapterRecord } from "../stores/fileMetaStore";

/**
 * 单章是否命中屏蔽记录：title 必须相等，行号或字数任一相等即命中
 *（主锚 title+lineNumber；文件重编辑行号漂移时按字数兜底）。
 */
export function isChapterBlockedByRecords(
  ch: Chapter,
  blocked: readonly BlockedChapterRecord[],
): boolean {
  return blocked.some(
    (b) =>
      b.title === ch.title &&
      (b.lineNumber === ch.lineNumber || b.charCount === ch.charCount),
  );
}

/**
 * 按判断函数剔除被屏蔽章节；被屏蔽章节的 charCount 并入上一个保留章节
 *（误抓行本就是上一章正文的延续），首章被屏蔽则字数丢弃。
 */
export function filterChaptersByPredicate(
  detected: Chapter[],
  isBlocked: (ch: Chapter) => boolean,
): Chapter[] {
  const out: Chapter[] = [];
  for (const ch of detected) {
    if (isBlocked(ch)) {
      if (out.length > 0) {
        const prev = out[out.length - 1]!;
        out[out.length - 1] = {
          ...prev,
          charCount: prev.charCount + ch.charCount,
        };
      }
      continue;
    }
    out.push(ch);
  }
  return out;
}

/** 按屏蔽记录过滤章节；blocked 为空时原样返回 */
export function filterChaptersByBlockedRecords(
  detected: Chapter[],
  blocked: readonly BlockedChapterRecord[] | undefined,
): Chapter[] {
  if (!blocked || blocked.length === 0) return detected;
  return filterChaptersByPredicate(detected, (ch) =>
    isChapterBlockedByRecords(ch, blocked),
  );
}
