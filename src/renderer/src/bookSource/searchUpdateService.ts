import type { BookChapter, BookSourceRecord } from "@shared/bookSource/types";
import { ipcPlain } from "./ipcPlain";
import {
  bookshelfAsBook,
  bookshelfBookKey,
  isManualBookshelfBook,
  loadFindBookBookshelf,
  saveFindBookBookshelf,
  updateFindBookBookshelfBookInfo,
  type BookshelfBook,
  type BookshelfBookInfoPatch,
} from "./findBookBookshelf";

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

/** 取第一个启用「搜索更新」的书源（书架手动添加书籍用） */
export async function findFirstSearchUpdateSource(): Promise<{
  url: string;
  name: string;
} | null> {
  try {
    const list = await window.colorTxt.bookSourceList();
    for (const it of list) {
      if (!it.enabled) continue;
      try {
        const rec = await window.colorTxt.bookSourceGet(it.bookSourceUrl);
        if (sourceHasSearchUpdate(rec)) {
          return { url: it.bookSourceUrl, name: it.bookSourceName };
        }
      } catch {
        /* 单个书源读取失败跳过 */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
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

/** searchUpdate 书源章节（版本帖）用应用内书源浏览器打开；成功后清除书架「有更新」角标 */
export async function openChapterPostInBrowser(
  origin: string | undefined,
  chapterUrl: string | undefined,
  bookUrl: string | undefined,
  bookName?: string,
): Promise<boolean> {
  // 剥 ,{"webView": ...} option，浏览器只要纯帖子 URL
  const url = (chapterUrl ?? "").split(/,\s*\{/)[0]?.trim() ?? "";
  if (!origin?.trim() || !url) return false;
  let opened = false;
  try {
    const res = await window.colorTxt.bookSourceBrowserOpen({
      url,
      bookName: bookName?.trim() || undefined,
    });
    opened = Boolean(res?.ok);
  } catch {
    opened = false;
  }
  if (!opened) return false;
  const key = bookUrl?.trim();
  if (key) setFindBookBookshelfHasUpdate(key, origin.trim(), false);
  return true;
}

function formatSearchUpdateLogHead(book: BookshelfBook): string {
  return `「${book.name}」${book.originName ? ` · ${book.originName}` : ""}`;
}

/** 章节 tag 里的发帖时间（如「2026-9-25 13:33」）→ 时间戳；解析失败返回 0 */
export function parsePostTimeFromTag(tag: string | undefined): number {
  const m = (tag ?? "")
    .trim()
    .match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 书源 searchUrl 模板 → 该书的目录页 URL（{{key}} = 书名 URL 编码） */
export function searchUrlAsTocUrl(
  searchUrl: string,
  bookName: string,
): string {
  return searchUrl
    .trim()
    .replace(/\{\{key\}\}/g, encodeURIComponent(bookName.trim()));
}

/** searchUpdate 书源「阅读」入口：内置浏览器打开该书搜索结果页（章节=单帖无翻章语义，手动看结果） */
export async function openSearchResultInBrowser(
  origin: string | undefined,
  bookName: string,
  bookUrl?: string | undefined,
): Promise<boolean> {
  const sourceUrl = origin?.trim();
  const name = bookName.trim();
  if (!sourceUrl || !name) return false;
  try {
    const source = await window.colorTxt.bookSourceGet(sourceUrl);
    const searchUrl = source?.searchUrl?.trim();
    if (!searchUrl) return false;
    // searchUrl 常为相对路径（如 search.php?...），相对书源/帖子 URL 补全 host
    const raw = searchUrlAsTocUrl(searchUrl, name);
    let full = raw;
    try {
      full = new URL(raw, bookUrl?.trim() || sourceUrl).toString();
    } catch {
      /* base 无效则原样使用 */
    }
    const res = await window.colorTxt.bookSourceBrowserOpen({
      url: full,
      bookName: name,
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/**
 * 拉取书的「版本帖目录」：书源 searchUrl（发布时间倒序 + 板块限定）当 tocUrl，
 * 搜索结果每帖 = 一章，第 1 章 = 最新帖（tag = 发帖时间）。
 */
async function fetchSearchUpdateChapters(
  book: BookshelfBook,
  searchUrl: string,
): Promise<{ chapters: BookChapter[]; message: string }> {
  const res = await window.colorTxt.bookSourceGetChapterList(
    // 书架条目可能来自 Vue 响应式代理，variable 等对象字段需剥成纯对象才能过 IPC 克隆
    ipcPlain({
      bookSourceUrl: book.origin,
      book: {
        ...bookshelfAsBook(book),
        tocUrl: searchUrlAsTocUrl(searchUrl, book.name),
      },
    }),
  );
  return {
    chapters: (res.chapters ?? []).filter((ch) => !ch.isVolume),
    message: res.message?.trim() ?? "",
  };
}

export type SearchUpdateHooks = {
  setUpdating: (key: string, active: boolean) => void;
  appendLog: (entry: string) => void;
  onBooksChanged?: (books: BookshelfBook[]) => void;
};

/**
 * 单书「搜索更新」：搜索结果当目录（发布时间倒序，每帖一章），
 * 第 1 章（最新帖）发帖时间晚于基线 latestPostTime 即有更新；
 * 无基线（首检）只建基线不报更新。
 */
export async function runSearchUpdateForBook(
  book: BookshelfBook,
  hooks: SearchUpdateHooks,
): Promise<boolean> {
  const key = bookshelfBookKey(book.bookUrl, book.origin);
  if (book.canUpdate === false) return false;
  hooks.setUpdating(key, true);
  try {
    const source = await window.colorTxt.bookSourceGet(book.origin);
    const searchUrl = source?.searchUrl?.trim() ?? "";
    if (!searchUrl) {
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n书源未配置 searchUrl，无法检查更新`,
      );
      return false;
    }

    const { chapters, message } = await fetchSearchUpdateChapters(
      book,
      searchUrl,
    );
    if (!chapters.length) {
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n搜索 0 条结果（可能登录态失效，请到书源重新登录）${
          message ? `\n${message}` : ""
        }`,
      );
      return false;
    }

    const latest = chapters[0];
    const latestTime = parsePostTimeFromTag(latest.tag);
    const baseTime = book.latestPostTime ?? 0;
    // 每次都刷新目录缓存；手动添加的书用首条结果回填真实帖子 URL
    const patch: BookshelfBookInfoPatch = {
      chapters,
      ...(isManualBookshelfBook(book) && latest.url?.trim()
        ? { bookUrl: latest.url.trim() }
        : {}),
    };
    const latestDesc = `${latest.title?.trim() || "（无标题）"}（${latest.tag ?? "无时间"}）`;

    if (latestTime <= 0) {
      // 发帖时间解析失败：只刷新目录缓存，不动基线、不报更新
      const next = updateFindBookBookshelfBookInfo(
        book.bookUrl,
        book.origin,
        patch,
      );
      if (next) hooks.onBooksChanged?.(next);
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n无法解析最新帖发帖时间，已刷新目录`,
      );
      return false;
    }

    if (baseTime <= 0) {
      // 首检（含老数据无 latestPostTime）：建立基线，不报更新
      const next = updateFindBookBookshelfBookInfo(book.bookUrl, book.origin, {
        ...patch,
        latestPostTime: latestTime,
      });
      if (next) hooks.onBooksChanged?.(next);
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n已建立基线：${latestDesc}`,
      );
      return true;
    }

    if (latestTime > baseTime) {
      const next = updateFindBookBookshelfBookInfo(book.bookUrl, book.origin, {
        ...patch,
        latestPostTime: latestTime,
        hasUpdate: true,
      });
      if (next) hooks.onBooksChanged?.(next);
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n发现新帖：${latestDesc}`,
      );
      return true;
    }

    // 无更新：基线不动；检查完成无新帖不算失败（避免误报「更新失败」）
    const next = updateFindBookBookshelfBookInfo(
      book.bookUrl,
      book.origin,
      patch,
    );
    if (next) hooks.onBooksChanged?.(next);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    hooks.appendLog(`${formatSearchUpdateLogHead(book)}\n搜索更新异常：${msg}`);
    return false;
  } finally {
    hooks.setUpdating(key, false);
  }
}
