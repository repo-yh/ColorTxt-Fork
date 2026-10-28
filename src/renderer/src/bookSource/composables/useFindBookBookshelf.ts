import { computed, ref } from "vue";
import type { BookSourceListItem, SearchBookItem } from "@shared/bookSource/types";
import type { CategoryEditorRow } from "../../constants/fileCategories";
import {
  addToFindBookBookshelf,
  addManualToFindBookBookshelf,
  applyBookshelfCategoryCatalogEdit,
  bookshelfBookKey,
  loadFindBookBookshelf,
  removeFromFindBookBookshelf,
  renameFindBookBookshelfBook,
  saveFindBookBookshelf,
  setFindBookBookshelfCanUpdate,
  setFindBookBookshelfCategories,
  setFindBookBookshelfCategory,
  updateFindBookBookshelfReadProgress,
  type BookshelfAddOptions,
  type BookshelfBook,
} from "../findBookBookshelf";

const STORAGE_KEY = "colortxt:findBookBookshelf";

const booksRef = ref<BookshelfBook[]>(loadFindBookBookshelf());

function syncFromStorage() {
  booksRef.value = loadFindBookBookshelf();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_KEY) syncFromStorage();
  });
  // 找书窗启动即自愈清洗（幂等）：剥书架 URL 里过期 _dsign、旧搜索 tocUrl 按书源规则置空
  void healFindBookBookshelfSources();
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 注册域兜底（www.sxsy45.com → sxsy45.com）；仅取末两段，覆盖常规 .com/.net 场景 */
function registrableDomainOf(host: string): string {
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : "";
}

/** 书籍 URL 字段里旧书源 host → 新书源 host（Discuz 换域名：路径/参数不变） */
function replaceUrlHost(
  url: string,
  oldHost: string,
  newHost: string,
  oldDomain: string,
  newDomain: string,
): string {
  if (!url || !oldHost || !newHost) return url;
  if (url.includes(oldHost)) return url.split(oldHost).join(newHost);
  if (!oldDomain || !newDomain || oldDomain === newDomain) return url;
  try {
    const u = new URL(url);
    if (u.hostname === oldDomain || u.hostname.endsWith(`.${oldDomain}`)) {
      return url.split(oldDomain).join(newDomain);
    }
  } catch {
    /* 非 URL（如 manual://）原样返回 */
  }
  return url;
}

/** 剥 URL（含 ,{option} 后缀形态）里写死的 Discuz `_dsign` 挑战参数：该值由服务端每次挑战动态签发，
 *  书架数据里的旧值只会再触发一轮挑战壳页、且跳转后 URL 变化让 HTTP 缓存键漂移；
 *  挑战流程会自动补发新值，写死的旧值无保留价值。
 *  纯字符串剥离：URL 类会把 query 里的 + 当空格重编码，改变请求语义。 */
function stripStaleDsignParam(raw: string | undefined): string | undefined {
  if (!raw || !raw.includes("_dsign=")) return raw;
  const commaIdx = raw.indexOf(",{");
  const urlPart = commaIdx >= 0 ? raw.slice(0, commaIdx) : raw;
  const suffix = commaIdx >= 0 ? raw.slice(commaIdx) : "";
  let out = urlPart.replace(/[?&]_dsign=[^&#]*/g, "");
  out = out.replace(/\?&/, "?").replace(/([?&])&+/g, "$1");
  if (/[?&]$/.test(out)) out = out.slice(0, -1);
  return out + suffix;
}

/**
 * 书架按书源名自愈：书源换域名/换源后（bookSourceUrl 变化），书架条目 origin 查不到书源；
 * 按 originName 匹配现存书源（导入同名替换后唯一），改写 origin 并把条目里
 * 所有旧域名 URL（bookUrl/tocUrl/封面/章节缓存/最后阅读）迁移到新书源域名。
 * 同时对所有书做 URL 清洗：剥过期 _dsign；书源 ruleBookInfo.tocUrl 已置空
 * （目录=当前帖子页）的书，把书架存量书名搜索 tocUrl 清空回落 bookUrl。
 */
export async function healFindBookBookshelfSources(): Promise<boolean> {
  const items = loadFindBookBookshelf();
  if (!items.length) return false;
  let sources: BookSourceListItem[] = [];
  try {
    sources = await window.colorTxt.bookSourceList();
  } catch {
    return false;
  }
  if (!sources.length) return false;
  const urlSet = new Set(sources.map((s) => s.bookSourceUrl.trim()));
  const byName = new Map<string, BookSourceListItem[]>();
  for (const s of sources) {
    const name = s.bookSourceName.trim();
    if (!name) continue;
    const arr = byName.get(name);
    if (arr) arr.push(s);
    else byName.set(name, [s]);
  }
  // 书架里 tocUrl 仍是旧书名搜索 URL 的书：查其书源 ruleBookInfo.tocUrl 是否已置空
  const emptyTocRuleOrigins = new Set<string>();
  const pendingRuleCheckOrigins = new Set<string>();
  for (const b of items) {
    const toc = (b.tocUrl ?? "").trim();
    if (toc.includes("/search.php?") && b.origin.trim()) {
      pendingRuleCheckOrigins.add(b.origin.trim());
    }
  }
  for (const origin of pendingRuleCheckOrigins) {
    try {
      const rec = await window.colorTxt.bookSourceGet(origin);
      if (rec && !String(rec.ruleBookInfo?.tocUrl ?? "").trim()) {
        emptyTocRuleOrigins.add(origin);
      }
    } catch {
      /* 单源查询失败忽略：下次自愈再试 */
    }
  }
  let changed = false;
  const next = items.map((book) => {
    const origin = book.origin.trim();
    const needsOriginHeal = Boolean(origin) && !urlSet.has(origin);
    let target: BookSourceListItem | undefined;
    let oldHost = "";
    let newHost = "";
    let oldDomain = "";
    let newDomain = "";
    if (needsOriginHeal) {
      const candidates = byName.get(book.originName.trim());
      if (candidates?.length) {
        // 消歧兜底：启用优先，再取最新导入（lastUpdateTime 大者），保证确定性
        const sorted = [...candidates].sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            (b.lastUpdateTime ?? 0) - (a.lastUpdateTime ?? 0),
        );
        target = sorted[0]!;
        newHost = hostOfUrl(target.bookSourceUrl);
        oldHost = hostOfUrl(origin);
        oldDomain = registrableDomainOf(oldHost);
        newDomain = registrableDomainOf(newHost);
      }
    }
    const fixUrl = (u: string | undefined): string | undefined => {
      if (!u) return u;
      let fixed = u;
      if (target) {
        fixed = replaceUrlHost(fixed, oldHost, newHost, oldDomain, newDomain);
      }
      fixed = stripStaleDsignParam(fixed) ?? fixed;
      return fixed === u ? u : fixed;
    };
    const chapters = book.chapters?.map((ch) => {
      const fixed = fixUrl(ch.url);
      if (fixed === ch.url) return ch;
      return { ...ch, url: fixed ?? ch.url };
    });
    let variable = book.variable;
    if (variable) {
      let variableChanged = false;
      const nextVariable: Record<string, string> = {};
      for (const [k, v] of Object.entries(variable)) {
        const fixed = fixUrl(v);
        if (fixed !== v) variableChanged = true;
        nextVariable[k] = fixed ?? v;
      }
      variable = variableChanged ? nextVariable : variable;
    }
    const healed: BookshelfBook = {
      ...book,
      origin: target ? target.bookSourceUrl.trim() : book.origin,
      originName: target ? target.bookSourceName : book.originName,
      chapters,
      variable,
    };
    const bookUrl = fixUrl(healed.bookUrl);
    if (bookUrl !== undefined) healed.bookUrl = bookUrl;
    const tocUrl = fixUrl(healed.tocUrl);
    if (tocUrl !== undefined) healed.tocUrl = tocUrl;
    // 目录=当前帖子页的书源（ruleBookInfo.tocUrl 空）：旧搜索 tocUrl 置空回落 bookUrl
    if (emptyTocRuleOrigins.has(healed.origin.trim()) && (healed.tocUrl ?? "").trim()) {
      healed.tocUrl = "";
    }
    if (healed.coverUrl !== undefined) {
      const coverUrl = fixUrl(healed.coverUrl);
      if (coverUrl !== undefined) healed.coverUrl = coverUrl;
    }
    if (healed.coverSourceUrl !== undefined) {
      const coverSourceUrl = fixUrl(healed.coverSourceUrl);
      if (coverSourceUrl !== undefined) healed.coverSourceUrl = coverSourceUrl;
    }
    if (healed.lastReadChapterUrl !== undefined) {
      const lastReadChapterUrl = fixUrl(healed.lastReadChapterUrl);
      if (lastReadChapterUrl !== undefined) {
        healed.lastReadChapterUrl = lastReadChapterUrl;
      }
    }
    if (
      healed.origin === book.origin &&
      healed.originName === book.originName &&
      healed.chapters === book.chapters &&
      healed.variable === book.variable &&
      healed.bookUrl === book.bookUrl &&
      healed.tocUrl === book.tocUrl &&
      healed.coverUrl === book.coverUrl &&
      healed.coverSourceUrl === book.coverSourceUrl &&
      healed.lastReadChapterUrl === book.lastReadChapterUrl
    ) {
      return book;
    }
    changed = true;
    return healed;
  });
  if (changed) {
    saveFindBookBookshelf(next);
    booksRef.value = next;
  }
  return changed;
}

export function useFindBookBookshelf() {
  const books = computed(() => booksRef.value);

  function refresh() {
    syncFromStorage();
  }

  function findBookshelfBook(
    bookUrl: string,
    origin: string,
  ): BookshelfBook | undefined {
    const key = bookshelfBookKey(bookUrl, origin);
    return booksRef.value.find(
      (b) => bookshelfBookKey(b.bookUrl, b.origin) === key,
    );
  }

  function isInBookshelf(bookUrl: string, origin: string): boolean {
    return Boolean(findBookshelfBook(bookUrl, origin));
  }

  function add(item: SearchBookItem, options?: BookshelfAddOptions) {
    booksRef.value = addToFindBookBookshelf(item, options);
  }

  /** 手动添加书籍（仅书名 + 书源）；返回 null 表示同书源同名已存在 */
  function addManual(
    name: string,
    origin: string,
    originName: string,
  ): BookshelfBook | null {
    const result = addManualToFindBookBookshelf(name, origin, originName);
    booksRef.value = result.books;
    return result.added ? result.book : null;
  }

  /** 书架改名：只改 name，不动 lastChapter / 章节基线 */
  function rename(bookUrl: string, origin: string, name: string): boolean {
    const next = renameFindBookBookshelfBook(bookUrl, origin, name);
    if (!next) return false;
    booksRef.value = next;
    return true;
  }

  function remove(bookUrl: string, origin: string) {
    booksRef.value = removeFromFindBookBookshelf(bookUrl, origin);
  }

  function toggle(item: SearchBookItem, options?: BookshelfAddOptions): boolean {
    if (isInBookshelf(item.bookUrl, item.origin)) {
      remove(item.bookUrl, item.origin);
      return false;
    }
    add(item, options);
    return true;
  }

  function updateReadProgress(
    bookUrl: string,
    origin: string,
    chapterIndex: number,
    chapterTitle?: string,
    chapterUrl?: string,
  ): boolean {
    const next = updateFindBookBookshelfReadProgress(
      bookUrl,
      origin,
      chapterIndex,
      chapterTitle,
      chapterUrl,
    );
    if (!next) return false;
    booksRef.value = next;
    return true;
  }

  function setOrder(items: BookshelfBook[]) {
    saveFindBookBookshelf(items);
    booksRef.value = items;
  }

  function setCanUpdate(bookUrl: string, origin: string, canUpdate: boolean) {
    const next = setFindBookBookshelfCanUpdate(bookUrl, origin, canUpdate);
    if (!next) return false;
    booksRef.value = next;
    return true;
  }

  function setCategory(bookUrl: string, origin: string, category: string) {
    const next = setFindBookBookshelfCategory(bookUrl, origin, category);
    if (!next) return false;
    booksRef.value = next;
    return true;
  }

  function setCategories(
    keys: readonly { bookUrl: string; origin: string }[],
    category: string,
  ) {
    const next = setFindBookBookshelfCategories(keys, category);
    if (!next) return false;
    booksRef.value = next;
    return true;
  }

  function applyCategoryCatalogEdit(
    initial: CategoryEditorRow[],
    draft: CategoryEditorRow[],
  ) {
    booksRef.value = applyBookshelfCategoryCatalogEdit(initial, draft);
  }

  function applyBooks(next: BookshelfBook[]) {
    booksRef.value = next;
  }

  return {
    books,
    refresh,
    healSources: healFindBookBookshelfSources,
    findBookshelfBook,
    isInBookshelf,
    add,
    addManual,
    rename,
    remove,
    toggle,
    updateReadProgress,
    setOrder,
    setCanUpdate,
    setCategory,
    setCategories,
    applyCategoryCatalogEdit,
    applyBooks,
  };
}
