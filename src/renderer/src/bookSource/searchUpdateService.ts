import type { BookSourceRecord, SearchBookItem } from "@shared/bookSource/types";
import {
  isBetterCandidate,
  isNewerThanBaseline,
  parseSearchUpdateTitle,
  titleMatchesBookName,
  type SearchUpdateTitleInfo,
} from "@shared/bookSource/searchUpdateParse";
import {
  bookshelfBookKey,
  loadFindBookBookshelf,
  saveFindBookBookshelf,
  updateFindBookBookshelfBookInfo,
  type BookshelfBook,
} from "./findBookBookshelf";

/** 单源搜索收集超时兜底（正常单源搜索数秒内完成） */
const SEARCH_ONCE_TIMEOUT_MS = 60_000;

function sourceHasSearchUpdate(source: BookSourceRecord | null): boolean {
  return Boolean(source && (source as { searchUpdate?: unknown }).searchUpdate);
}

/** 书源是否启用「搜索更新」检测（书源 JSON 自定义字段 searchUpdate） */
export async function isSearchUpdateSource(
  origin: string | undefined,
): Promise<boolean> {
  const url = origin?.trim();
  if (!url) return false;
  try {
    return sourceHasSearchUpdate(await window.colorTxt.bookSourceGet(url));
  } catch {
    return false;
  }
}

/**
 * 单源搜索一次并收集全部结果。
 * 走书源 searchUrl 规则（用户可自定义，如附加板块参数），key 替换 {{key}}。
 * result 事件 items 为全量快照，done 时 resolve；超时兜底防悬挂。
 */
export async function searchOnceForUpdate(
  key: string,
  origin: string,
): Promise<SearchBookItem[]> {
  const k = key.trim();
  if (!k) return [];
  const res = await window.colorTxt.bookSourceSearch(k, {
    sourceUrls: [origin.trim()],
  });
  const searchId = res.searchId;
  if (!searchId) return [];
  return await new Promise((resolve) => {
    let items: SearchBookItem[] = [];
    let settled = false;
    const finish = (v: SearchBookItem[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(v);
    };
    const unsub = window.colorTxt.onBookSourceSearchEvent((ev) => {
      if (ev.searchId !== searchId) return;
      if (ev.type === "result") items = ev.items;
      else if (ev.type === "done") finish(items);
    });
    const timer = setTimeout(() => finish(items), SEARCH_ONCE_TIMEOUT_MS);
  });
}

/** 设置书架项「有更新」标记（无变化返回 null；返回最新书架数组供 applyBooks） */
export function setFindBookBookshelfHasUpdate(
  bookUrl: string,
  origin: string,
  hasUpdate: boolean,
): BookshelfBook[] | null {
  const key = bookshelfBookKey(bookUrl, origin);
  let changed = false;
  const next = loadFindBookBookshelf().map((b) => {
    if (bookshelfBookKey(b.bookUrl, b.origin) !== key) return b;
    const prev = b.hasUpdate === true;
    if (prev === hasUpdate) return b;
    changed = true;
    if (hasUpdate) return { ...b, hasUpdate: true };
    const { hasUpdate: _drop, ...rest } = b;
    return rest;
  });
  if (!changed) return null;
  saveFindBookBookshelf(next);
  return next;
}

function formatSearchUpdateLogHead(book: BookshelfBook): string {
  return `「${book.name}」${book.originName ? ` · ${book.originName}` : ""}`;
}

/** 结果里选出最优帖：标题须包含书名；完结优先、章节数次之 */
function pickBestResult(
  items: readonly SearchBookItem[],
  bookName: string,
): { info: SearchUpdateTitleInfo; bookUrl: string; title: string } | null {
  let best: { info: SearchUpdateTitleInfo; bookUrl: string; title: string } | null =
    null;
  for (const it of items) {
    // lastChapter = 帖子完整标题（书源 ruleSearch.lastChapter 传出）；缺省时用 name 兜底
    const fullTitle = (it.lastChapter ?? "").trim();
    const candidateTitle = fullTitle || (it.name ?? "").trim();
    if (!candidateTitle) continue;
    if (
      !titleMatchesBookName(candidateTitle, bookName) &&
      !titleMatchesBookName(fullTitle, bookName)
    ) {
      continue;
    }
    const info = parseSearchUpdateTitle(candidateTitle);
    if (info.chapterNum <= 0) continue;
    if (!best || isBetterCandidate(info, best.info)) {
      best = { info, bookUrl: it.bookUrl, title: candidateTitle };
    }
  }
  return best;
}

export type SearchUpdateHooks = {
  setUpdating: (key: string, active: boolean) => void;
  appendLog: (entry: string) => void;
  onBooksChanged?: (books: BookshelfBook[]) => void;
};

/** 单书「搜索更新」：搜书名 → 标题解析（完结优先/章节数）→ 与基线比较 → 写回 */
export async function runSearchUpdateForBook(
  book: BookshelfBook,
  hooks: SearchUpdateHooks,
): Promise<boolean> {
  const key = bookshelfBookKey(book.bookUrl, book.origin);
  if (book.canUpdate === false) return false;
  hooks.setUpdating(key, true);
  try {
    const items = await searchOnceForUpdate(book.name, book.origin);
    if (!items.length) {
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n搜索 0 条结果（可能登录态失效，请到书源重新登录）`,
      );
      return false;
    }

    const best = pickBestResult(items, book.name.trim());
    if (!best) {
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n搜索 ${items.length} 条结果，但无标题包含「${book.name}」的帖子`,
      );
      return false;
    }

    // 基线：优先已存 chapterNum；老数据从当前帖标题（lastChapter）解析
    let base: SearchUpdateTitleInfo | null = null;
    if (book.chapterNum && book.chapterNum > 0) {
      base = { chapterNum: book.chapterNum, finished: book.finished === true };
    } else {
      const baseTitle = (book.lastChapter ?? "").trim();
      if (baseTitle) {
        const info = parseSearchUpdateTitle(baseTitle);
        if (info.chapterNum > 0) base = info;
      }
    }

    if (!base || isNewerThanBaseline(best.info, base)) {
      // 首检（无基线）只写基线不报更新；有基线且候选更优则报更新
      const next = updateFindBookBookshelfBookInfo(book.bookUrl, book.origin, {
        lastChapter: best.title,
        bookUrl: best.bookUrl,
        chapterNum: best.info.chapterNum,
        finished: best.info.finished,
        ...(base ? { hasUpdate: true } : {}),
      });
      if (next) hooks.onBooksChanged?.(next);
      return true;
    }

    // 无更新：基线字段缺失时补写（hasUpdate 不动）
    if (!book.chapterNum) {
      const next = updateFindBookBookshelfBookInfo(book.bookUrl, book.origin, {
        chapterNum: best.info.chapterNum,
        finished: best.info.finished,
      });
      if (next) hooks.onBooksChanged?.(next);
    }
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    hooks.appendLog(`${formatSearchUpdateLogHead(book)}\n搜索更新异常：${msg}`);
    return false;
  } finally {
    hooks.setUpdating(key, false);
  }
}
