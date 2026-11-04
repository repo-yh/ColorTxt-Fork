import { computed, ref } from "vue";
import type { BookChapter } from "@shared/bookSource/types";
import { LOGIN_EXPIRED_LOG_MARK } from "@shared/bookSource/ipc";
import {
  bookshelfBookKey,
  updateFindBookBookshelfBookInfo,
  type BookshelfBook,
  type BookshelfBookInfoPatch,
} from "../findBookBookshelf";
import { resolveLatestChapterTitleFromToc } from "../findBookshelfDisplay";
import { isSearchUpdateSource, runSearchUpdateForBook } from "../searchUpdateService";
import { ipcPlain } from "../ipcPlain";

const updatingKeys = ref(new Set<string>());

/** 更新目录错误日志（批量/单项共用，打开「日志」面板查看） */
const bookshelfUpdateLogEntries = ref<string[]>([]);

/** 批量更新中发现登录失效的书源（WS 源命中后终止该源剩余书的检查更新） */
const loginExpiredOrigins = new Set<string>();

/** 检查更新中被搜索限流（WS 源搜索被重定向回搜索首页）的书源集合——
 *  引擎 SEARCH_RATE_LIMITED_LOG_MARK 标记经 onRateLimited 回调写入，
 *  串行组检查完一本后读取并清除，据此挂起 concurrentRate 时长 */
const searchRateLimitedOrigins = new Set<string>();

/** 单本限流重试上限：挂起后重试连续超过此数仍被限流则放弃本书（防死循环） */
const SEARCH_RATE_LIMIT_MAX_RETRIES = 3;

/** 引擎 logs 是否含「响应 URL 命中书源登录页」标记（fetchWithLoginCheck 统一 push） */
function hasLoginExpiredLog(logs?: string[] | null): boolean {
  return (logs ?? []).some((l) => l.includes(LOGIN_EXPIRED_LOG_MARK));
}

/** 对齐 Legado AppConfig.threadCount 默认 16；书架更新略保守 */
const BOOKSHELF_UPDATE_CONCURRENCY = 8;

/** 同一书源同时只更新一本书（Legado sourceSemaphores Semaphore(1)） */
const sourceUpdateTail = new Map<string, Promise<void>>();

export const bookshelfUpdateBusy = computed(() => updatingKeys.value.size > 0);

export const bookshelfUpdateHasLog = computed(
  () => bookshelfUpdateLogEntries.value.length > 0,
);

export function getBookshelfUpdateLogText(): string {
  return bookshelfUpdateLogEntries.value.length
    ? bookshelfUpdateLogEntries.value.join("\n\n")
    : "（暂无日志）";
}

export function clearBookshelfUpdateLogs(): void {
  bookshelfUpdateLogEntries.value = [];
}

function appendBookshelfUpdateLog(entry: string) {
  const text = entry.trim();
  if (!text) return;
  bookshelfUpdateLogEntries.value = [...bookshelfUpdateLogEntries.value, text];
}

function formatUpdateErrorEntry(
  book: BookshelfBook,
  headline: string,
  logs?: string[] | null,
): string {
  const header = `「${book.name}」${book.originName ? ` · ${book.originName}` : ""}\n${book.origin}`;
  const parts = [header, headline.trim()].filter(Boolean);
  const extra = (logs ?? []).map((l) => l.trim()).filter(Boolean);
  if (extra.length) parts.push(extra.join("\n"));
  return parts.join("\n");
}

async function withSourceUpdateLock<T>(
  origin: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sourceUpdateTail.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = prev.then(() => gate);
  sourceUpdateTail.set(origin, current);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sourceUpdateTail.get(origin) === current) {
      sourceUpdateTail.delete(origin);
    }
  }
}

/** 书源 concurrentRate → 检查更新本间间隔 ms（纯数字=毫秒；"n/毫秒" 取毫秒段；无配置 0） */
async function sourceUpdateIntervalMs(origin: string): Promise<number> {
  try {
    const rec = await window.colorTxt.bookSourceGet(origin);
    const rate = rec?.concurrentRate?.trim();
    if (!rate || rate === "0") return 0;
    const idx = rate.indexOf("/");
    const ms = Number.parseInt(idx > 0 ? rate.slice(idx + 1) : rate, 10);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}

function formatLastChapter(raw: string | undefined): string {
  const s = raw?.trim() ?? "";
  if (!s) return "";
  return s
    .replace(/[·•][^\n]*$/, "")
    .replace(
      /\s+(?:\d+\s*(?:分钟|小时|天|周|个月|月|年)前|刚刚|\d{4}[./-]\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*$/u,
      "",
    )
    .trim();
}

function buildInfoPatch(
  book: BookshelfBook,
  detail: NonNullable<
    Awaited<ReturnType<typeof window.colorTxt.bookSourceGetBookInfo>>["detail"]
  >,
  chapters: BookChapter[],
): BookshelfBookInfoPatch {
  // 对齐 Legado：有目录时以最新章节标题为准（写入 chapters 时还会再覆盖一次）
  const tocTitle = resolveLatestChapterTitleFromToc(chapters);
  const lastChapter =
    tocTitle || formatLastChapter(detail.lastChapter) || book.lastChapter;
  const patch: BookshelfBookInfoPatch = {
    name: detail.name?.trim() || book.name,
    author: detail.author?.trim() || book.author,
    intro: detail.intro ?? book.intro,
    kind: detail.kind ?? book.kind,
    wordCount: detail.wordCount ?? book.wordCount,
    updateTime: detail.updateTime?.trim() || undefined,
    lastChapter: lastChapter || book.lastChapter,
  };
  if (detail.coverUrl?.trim()) patch.coverUrl = detail.coverUrl.trim();
  if (detail.coverSourceUrl?.trim()) {
    patch.coverSourceUrl = detail.coverSourceUrl.trim();
  }
  const nextBookUrl = detail.bookUrl?.trim();
  if (nextBookUrl && nextBookUrl !== book.bookUrl) {
    patch.bookUrl = nextBookUrl;
  }
  if (detail.variable && Object.keys(detail.variable).length) {
    patch.variable = detail.variable;
  }
  return patch;
}

export function useBookshelfUpdate(onBooksChanged?: (books: BookshelfBook[]) => void) {
  const isAnyUpdating = bookshelfUpdateBusy;

  function isUpdating(book: BookshelfBook): boolean {
    return updatingKeys.value.has(bookshelfBookKey(book.bookUrl, book.origin));
  }

  function setUpdating(key: string, active: boolean) {
    const next = new Set(updatingKeys.value);
    if (active) next.add(key);
    else next.delete(key);
    updatingKeys.value = next;
  }

  async function updateBook(book: BookshelfBook): Promise<boolean> {
    if (book.canUpdate === false) return false;
    const key = bookshelfBookKey(book.bookUrl, book.origin);
    if (updatingKeys.value.has(key)) return false;
    setUpdating(key, true);
    try {
      return await withSourceUpdateLock(
        book.origin,
        () => updateBookOnce(book),
      );
    } finally {
      setUpdating(key, false);
    }
  }

  /** 批量更新专用入口：该源已检测到登录失效（仅 WS 源，见 loginExpiredOrigins）直接跳过 */
  async function updateBookBatch(book: BookshelfBook): Promise<boolean> {
    if (loginExpiredOrigins.has(book.origin)) return false;
    const key = bookshelfBookKey(book.bookUrl, book.origin);
    if (updatingKeys.value.has(key)) return false;
    setUpdating(key, true);
    try {
      return await withSourceUpdateLock(book.origin, async () => {
        // 锁内二次检测：排队等锁期间同源其他书可能已检出登录失效
        if (loginExpiredOrigins.has(book.origin)) return false;
        return updateBookOnce(book);
      });
    } finally {
      setUpdating(key, false);
    }
  }

  async function updateBookOnce(book: BookshelfBook): Promise<boolean> {
    const key = bookshelfBookKey(book.bookUrl, book.origin);

    // searchUpdate 书源：检查更新走「书名模糊搜索 + 标题完结/章节数比对」（假目录站检测不到更新）
    if (await isSearchUpdateSource(book.origin)) {
      return runSearchUpdateForBook(book, {
        setUpdating,
        appendLog: appendBookshelfUpdateLog,
        onBooksChanged,
        // 引擎 logs 命中登录失效标记 → 记入失效集合（批量时同源剩余书提前跳过）
        onLoginExpired: () => loginExpiredOrigins.add(book.origin),
        // 引擎 logs 命中搜索限流标记（搜索被重定向回搜索首页）→ 记入限流集合
        // （批量 WS 源串行组据此挂起 concurrentRate 时长后重试本书）
        onRateLimited: () => searchRateLimitedOrigins.add(book.origin),
      });
    }

    setUpdating(key, true);
    try {
      const infoRes = await window.colorTxt.bookSourceGetBookInfo(
        ipcPlain({
          bookSourceUrl: book.origin,
          bookUrl: book.bookUrl,
          name: book.name,
          author: book.author,
          kind: book.kind,
          wordCount: book.wordCount,
          intro: book.intro,
          lastChapter: book.lastChapter,
          coverUrl: book.coverUrl,
          variable: book.variable,
        }),
      );
      if (!infoRes.detail) {
        // 引擎 logs 命中登录页标记 → 记入失效集合（批量时同源剩余书提前跳过）
        if (hasLoginExpiredLog(infoRes.logs)) loginExpiredOrigins.add(book.origin);
        appendBookshelfUpdateLog(
          formatUpdateErrorEntry(
            book,
            infoRes.message?.trim() || "获取书籍详情失败",
            infoRes.logs,
          ),
        );
        return false;
      }

      const detail = ipcPlain(infoRes.detail);
      const tocRes = await window.colorTxt.bookSourceGetChapterList({
        bookSourceUrl: book.origin,
        book: detail,
      });
      if (tocRes.message?.trim() && !(tocRes.chapters?.length)) {
        if (hasLoginExpiredLog(tocRes.logs)) loginExpiredOrigins.add(book.origin);
        appendBookshelfUpdateLog(
          formatUpdateErrorEntry(
            book,
            tocRes.message.trim() || "获取目录失败",
            tocRes.logs,
          ),
        );
        return false;
      }
      if (tocRes.message?.trim() && tocRes.chapters?.length) {
        // 有目录但仍有告警：记入日志，继续写入
        if (hasLoginExpiredLog(tocRes.logs)) loginExpiredOrigins.add(book.origin);
        appendBookshelfUpdateLog(
          formatUpdateErrorEntry(book, tocRes.message.trim(), tocRes.logs),
        );
      }

      const chapters = tocRes.chapters ?? [];
      const patch = buildInfoPatch(book, detail, chapters);
      const next = updateFindBookBookshelfBookInfo(book.bookUrl, book.origin, {
        ...patch,
        tocUrl: detail.tocUrl,
        chapters,
      });
      if (next) onBooksChanged?.(next);
      return Boolean(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendBookshelfUpdateLog(
        formatUpdateErrorEntry(book, msg || "更新目录异常"),
      );
      return false;
    } finally {
      setUpdating(key, false);
    }
  }

  async function updateBooks(books: readonly BookshelfBook[]): Promise<void> {
    const queue = books.filter((book) => book.canUpdate !== false);
    if (!queue.length) return;

    clearBookshelfUpdateLogs();
    loginExpiredOrigins.clear();
    searchRateLimitedOrigins.clear();

    // searchUpdate 书源（如 sxsy45）站点搜索限流是漏桶算法（非固定间隔）：
    // WS 源启用自适应——限流未发生时一本接一本直查；某本搜索被限流（响应被
    // 重定向回搜索首页，引擎 SEARCH_RATE_LIMITED_LOG_MARK 标记）时挂起
    // concurrentRate 时长后重试本书，且此后剩余书按 concurrentRate 固定本间
    // 间隔走（漏桶已空，等不了恢复全部，只能按间隔请求剩下的）；非 WS 源
    // 维持原固定本间间隔。限流只做在检查更新代码里，请求层——查看帖子/WS
    // 脚本交互——不限流。其余书源保持多 worker 并发池。分组判定每源只查一次书源库。
    const searchUpdateOrigins = new Set<string>();
    // WS 油猴通道书源：登录态在外部浏览器（脚本会话），本地无 Cookie 可自愈——
    // 批量更新中检测到登录失效即提前终止该源剩余书的检查；非 WS 源保持弹窗自愈不终止
    const wsOrigins = new Set<string>();
    for (const book of queue) {
      const origin = book.origin?.trim();
      if (!origin || searchUpdateOrigins.has(origin)) continue;
      if (await isSearchUpdateSource(origin)) searchUpdateOrigins.add(origin);
      try {
        const rec = await window.colorTxt.bookSourceGet(origin);
        if (rec?.enabledWebSocket) wsOrigins.add(origin);
      } catch {
        /* 书源读取失败按非 WS 处理 */
      }
    }
    const serialGroups = new Map<string, BookshelfBook[]>();
    const parallelQueue: BookshelfBook[] = [];
    for (const book of queue) {
      const origin = book.origin?.trim() ?? "";
      if (searchUpdateOrigins.has(origin)) {
        const group = serialGroups.get(origin);
        if (group) group.push(book);
        else serialGroups.set(origin, [book]);
      } else {
        parallelQueue.push(book);
      }
    }

    let parallelCursor = 0;
    const parallelWorkers = Array.from(
      { length: Math.min(BOOKSHELF_UPDATE_CONCURRENCY, parallelQueue.length) },
      async () => {
        while (parallelCursor < parallelQueue.length) {
          const book = parallelQueue[parallelCursor++];
          // 该源已检出登录失效（仅 WS 源）：跳过同源剩余书
          const origin = book.origin?.trim() ?? "";
          if (wsOrigins.has(origin) && loginExpiredOrigins.has(origin)) {
            continue;
          }
          await updateBookBatch(book);
        }
      },
    );
    const serialWorkers = [...serialGroups.entries()].map(
      async ([origin, group]) => {
        const intervalMs = await sourceUpdateIntervalMs(origin);
        const adaptive = wsOrigins.has(origin);
        // 组级限流状态：一旦本组出现限流，剩余书固定间隔走（不等漏桶恢复全部）
        let rateLimitedMode = false;
        for (let i = 0; i < group.length; i++) {
          // 该源已检出登录失效（仅 WS 源）：终止剩余书（本间挂起也一并跳过）
          if (wsOrigins.has(origin) && loginExpiredOrigins.has(origin)) {
            appendBookshelfUpdateLog(
              `书源「${group[0]?.originName || origin}」登录已失效，已终止该源剩余 ${group.length - i} 本的检查更新`,
            );
            break;
          }
          const book = group[i];
          const key = bookshelfBookKey(book.bookUrl, book.origin);
          if (updatingKeys.value.has(key)) continue;
          // 转圈覆盖「挂起 + 检查 + 限流重试」全程：被限流时该行持续转圈可见
          // （未限流时无挂起，转圈只覆盖检查瞬间，秒进秒出）
          setUpdating(key, true);
          try {
            if (adaptive) {
              let waitBeforeRetry = false;
              let retries = 0;
              while (true) {
                // 挂起：限流重试前（waitBeforeRetry）或限流后剩余书每本前
                if ((waitBeforeRetry || rateLimitedMode) && intervalMs > 0) {
                  await new Promise((r) => setTimeout(r, intervalMs));
                }
                waitBeforeRetry = false;
                await withSourceUpdateLock(origin, () => updateBookOnce(book));
                if (!searchRateLimitedOrigins.delete(origin)) break;
                // 本次搜索被限流：挂起 intervalMs 后重试本书（超上限放弃）
                rateLimitedMode = true;
                retries += 1;
                if (retries > SEARCH_RATE_LIMIT_MAX_RETRIES) {
                  appendBookshelfUpdateLog(
                    `「${book.name}」重试 ${SEARCH_RATE_LIMIT_MAX_RETRIES} 次仍被搜索限流，跳过本书`,
                  );
                  break;
                }
                waitBeforeRetry = true;
              }
            } else {
              // 非 WS searchUpdate 源：固定本间间隔（限流检测依赖 WS 通道 finalUrl）
              if (i > 0 && intervalMs > 0) {
                await new Promise((r) => setTimeout(r, intervalMs));
              }
              await withSourceUpdateLock(origin, () => updateBookOnce(book));
            }
          } finally {
            setUpdating(key, false);
          }
        }
      },
    );
    await Promise.all([...parallelWorkers, ...serialWorkers]);
  }

  return {
    isAnyUpdating,
    isUpdating,
    updateBook,
    updateBooks,
  };
}
