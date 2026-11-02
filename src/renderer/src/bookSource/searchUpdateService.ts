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
import { stripChapterUrlOption } from "./findBookshelfDisplay";

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

/**
 * searchUpdate 书源章节（版本帖）：WS 扩展通道抓正文（外部浏览器登录态），
 * 书源浏览器窗口快照渲染离线 body（禁导航纯单页，不实时回源）；成功后清除
 * 书架「有更新」角标。书架条目单击（最后阅读）、阅读器/详情目录章节点击共用。
 */
export async function openChapterPostInBrowser(
  origin: string | undefined,
  chapterUrl: string | undefined,
  bookUrl: string | undefined,
  bookName?: string,
): Promise<{ ok: boolean; message?: string }> {
  // 剥 ,{"webView": ...} option，WS 抓页只要纯帖子 URL
  const url = stripChapterUrlOption(chapterUrl);
  if (!origin?.trim() || !url) return { ok: false, message: "章节 URL 无效" };
  try {
    const res = await window.colorTxt.bookSourceWsSnapshotOpen({
      url,
      bookName: bookName?.trim() || undefined,
    });
    if (!res?.ok) return { ok: false, message: res?.message || "快照打开失败" };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const key = bookUrl?.trim();
  if (key) setFindBookBookshelfHasUpdate(key, origin.trim(), false);
  return { ok: true };
}

function formatSearchUpdateLogHead(book: BookshelfBook): string {
  return `「${book.name}」${book.originName ? ` · ${book.originName}` : ""}`;
}

/** 章节 tag 里的发帖时间（如「2026-9-25 13:33」「10-11 20:15」）→ 时间戳；解析失败返回 0 */
export function parsePostTimeFromTag(tag: string | undefined): number {
  const raw = (tag ?? "").trim();
  const m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    const t = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
    ).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  // 无年份（Discuz 当年帖显示「10-11 20:15」）：补当前年份；补出未来超 1 天按跨年老帖年份减 1
  const m2 = raw.match(/(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m2) return 0;
  const now = new Date();
  const build = (year: number) =>
    new Date(
      year,
      Number(m2[1]) - 1,
      Number(m2[2]),
      Number(m2[3]),
      Number(m2[4]),
    ).getTime();
  let t = build(now.getFullYear());
  if (t - now.getTime() > 86400000) t = build(now.getFullYear() - 1);
  return Number.isFinite(t) ? t : 0;
}

/** 帖子标题型书名（如「[更新]《现代都市异闻录》1-368」）→ 裸书名；Discuz 搜索对
 *  整串带 []《》 的标题匹配不出结果（实测空结果页），需提取《》内书名再搜。
 *  手动编辑的无《》书名原样使用。 */
export function cleanBookNameForSearch(name: string): string {
  const raw = name.trim();
  const m = raw.match(/《([^《》]+)》/);
  return m ? m[1]! : raw;
}

/** 书源 searchUrl 模板 → 该书的目录页 URL（{{key}} = 清洗后书名 URL 编码） */
export function searchUrlAsTocUrl(
  searchUrl: string,
  bookName: string,
): string {
  return searchUrl
    .trim()
    .replace(
      /\{\{key\}\}/g,
      encodeURIComponent(cleanBookNameForSearch(bookName)),
    );
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
    // searchUrl 现带 ,{"webView":...} option（引擎目录/检查更新要过 _dsign 挑战）；
    // 浏览器直开必须剥掉，否则 Discuz 判「非法字符」拒绝请求
    const raw = searchUrlAsTocUrl(stripChapterUrlOption(searchUrl), name);
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
): Promise<{ chapters: BookChapter[]; message: string; logs: string[] }> {
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
    logs: res.logs ?? [],
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

    const { chapters, message, logs } = await fetchSearchUpdateChapters(
      book,
      searchUrl,
    );
    for (const line of logs) hooks.appendLog(line);
    if (!chapters.length) {
      hooks.appendLog(
        `${formatSearchUpdateLogHead(book)}\n搜索 0 条结果（可能登录态失效，请到书源重新登录）${
          message ? `\n${message}` : ""
        }`,
      );
      return false;
    }

    // 最新帖 = 全部章节中发帖时间最大的一章（免疫搜索排序变化；不再假设第 1 条是最新帖）
    let latest = chapters[0];
    let latestTime = parsePostTimeFromTag(latest.tag);
    for (const ch of chapters) {
      const t = parsePostTimeFromTag(ch.tag);
      if (t > latestTime) {
        latestTime = t;
        latest = ch;
      }
    }
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

/** 点章节走扩展 WS 通道下载附件的编排结果 */
export type ChapterDownloadViaExtensionResult =
  | { status: "downloaded"; count: number }
  | { status: "needBuy"; names: string[] }
  | { status: "noAttachment" }
  | { status: "failed"; error: string };

/**
 * 已购附件逐个下发扩展下载（fire-and-forget，落盘目录用找书设置），成功后清书架
 * 「有更新」角标。章节下载与主下载按钮购买后重取直链共用此同一下发路径。
 */
async function downloadPurchasedAttachments(
  attachments: { url: string; name: string }[],
  refererUrl: string,
  bookName: string,
  bookUrl: string | undefined,
  sourceUrl: string,
  downloadDir: string,
): Promise<ChapterDownloadViaExtensionResult> {
  const dir = downloadDir.trim();
  let sent = 0;
  for (const a of attachments) {
    try {
      const res = await window.colorTxt.extensionWs.download({
        url: a.url,
        referer: refererUrl,
        postUrl: refererUrl,
        bookName,
        downloadDir: dir,
      });
      if (res?.ok) sent += 1;
    } catch {
      /* 单个下发失败继续其余附件 */
    }
  }
  if (sent > 0) {
    const key = bookUrl?.trim();
    if (key) setFindBookBookshelfHasUpdate(key, sourceUrl, false);
    return { status: "downloaded", count: sent };
  }
  return {
    status: "failed",
    error: "插件未连接（请确认浏览器扩展已加载、服务开关已打开）",
  };
}

/**
 * searchUpdate 书源点章节：扩展 WS 通道抓帖子页解析附件两态——
 * 已购附件逐个下发扩展下载（fire-and-forget，落盘目录用找书设置），成功后清「有更新」角标；
 * 未购附件返回需购买名单；无附件/失败交调用方兜底（如回退内置浏览器打开）。
 */
export async function downloadChapterViaExtension(
  chapterUrl: string | undefined,
  bookName: string,
  bookUrl: string | undefined,
  origin: string | undefined,
  downloadDir: string,
): Promise<ChapterDownloadViaExtensionResult> {
  // 剥 ,{"webView": ...} option（同浏览器打开路径），扩展抓取只要纯帖子 URL
  const url = stripChapterUrlOption(chapterUrl).trim();
  const name = bookName.trim();
  const sourceUrl = origin?.trim();
  if (!url || !sourceUrl) {
    return { status: "failed", error: "章节 URL 无效" };
  }
  try {
    const parsed = await window.colorTxt.extensionWs.parseChapterAttachments(
      url,
    );
    if (!parsed.ok) {
      return { status: "failed", error: parsed.error };
    }
    if (parsed.purchased.length > 0) {
      return await downloadPurchasedAttachments(
        parsed.purchased,
        url,
        name,
        bookUrl,
        sourceUrl,
        downloadDir,
      );
    }
    if (parsed.unpaid.length > 0) {
      return {
        status: "needBuy",
        names: parsed.unpaid.map((a) => a.name).filter(Boolean),
      };
    }
    return { status: "noAttachment" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", error: msg };
  }
}

/** 附件购买确认计划（主下载按钮：未购附件弹窗展示用） */
export type AttachmentPurchasePlan = {
  /** 待购买附件（名称 + 售价） */
  attachments: { name: string; price: number }[];
  /** 表单展示的「购买后余额」（金钱；首个购买页原值，与表单一致） */
  balanceAfter: number;
  /** 本次购买合计需要（金钱） */
  totalCost: number;
  /** 余额不足预判（仅供弹窗标红提示，确认购买仍照常提交） */
  balanceShort: boolean;
};

/**
 * searchUpdate 书源主下载按钮：始终用最新章节帖（调用方传 contentChapterList[0]），
 * 扩展 WS 通道抓帖解析附件两态——已购逐个下发扩展下载；
 * 未购逐个 GET attachpay 购买页组计划 → hooks.confirmPurchase 弹窗确认 →
 * 逐个 form_post 提交购买（HTTP 200 即成功，不解析响应内容）→
 * 重新发起抓帖请求过滤附件下载链接（购买已生效，不做额外等待）→ 触发下载。
 * 章节链路 downloadChapterViaExtension 不走此流程（章节入口无购买编排）。
 */
export async function downloadLatestPostViaExtension(
  chapterUrl: string | undefined,
  bookName: string,
  bookUrl: string | undefined,
  origin: string | undefined,
  downloadDir: string,
  hooks: {
    confirmPurchase: (plan: AttachmentPurchasePlan) => Promise<boolean>;
  },
): Promise<ChapterDownloadViaExtensionResult> {
  // 剥 ,{"webView": ...} option（同浏览器打开路径），扩展抓取只要纯帖子 URL
  const url = stripChapterUrlOption(chapterUrl).trim();
  const name = bookName.trim();
  const sourceUrl = origin?.trim();
  if (!url || !sourceUrl) {
    return { status: "failed", error: "章节 URL 无效" };
  }

  try {
    const parsed = await window.colorTxt.extensionWs.parseChapterAttachments(
      url,
    );
    if (!parsed.ok) {
      return { status: "failed", error: parsed.error };
    }
    // 已购附件直接下载（不涉及购买流程），与章节下载同一路径
    if (parsed.purchased.length > 0) {
      return await downloadPurchasedAttachments(
        parsed.purchased,
        url,
        name,
        bookUrl,
        sourceUrl,
        downloadDir,
      );
    }
    if (parsed.unpaid.length === 0) {
      return { status: "noAttachment" };
    }

    // 逐个 GET attachpay 购买页：取表单提交参数与计费信息
    const forms: {
      name: string;
      action: string;
      formhash: string;
      aid: string;
      referer: string;
      price: number;
      balanceAfter: number;
    }[] = [];
    for (const a of parsed.unpaid) {
      const f = await window.colorTxt.extensionWs.parseAttachpay(a.url);
      if (!f.ok) return { status: "failed", error: f.error };
      forms.push({
        name: a.name,
        action: f.action,
        formhash: f.formhash,
        aid: f.aid,
        referer: f.referer,
        price: f.price,
        balanceAfter: f.balanceAfter,
      });
    }
    const totalCost = forms.reduce((s, f) => s + f.price, 0);
    // 余额不足预判：发起前本金 = 首个表单的购买后余额 + 该附件售价
    const first = forms[0]!;
    const balanceShort = first.balanceAfter + first.price < totalCost;
    const confirmed = await hooks.confirmPurchase({
      attachments: forms.map((f) => ({ name: f.name, price: f.price })),
      balanceAfter: first.balanceAfter,
      totalCost,
      balanceShort,
    });
    if (!confirmed) {
      return {
        status: "needBuy",
        names: parsed.unpaid.map((a) => a.name).filter(Boolean),
      };
    }

    // 逐个提交购买（form_post）：HTTP 200 即成功，不解析响应内容
    for (const f of forms) {
      const body = new URLSearchParams({
        formhash: f.formhash,
        aid: f.aid,
        ...(f.referer ? { referer: f.referer } : {}),
        paysubmit: "true",
      }).toString();
      const r = await window.colorTxt.extensionWs.formPost({
        url: f.action,
        body,
        referer: url,
      });
      if (!r.ok) {
        return { status: "failed", error: `购买请求失败：${r.error}` };
      }
    }

    // 重新发起获取帖子的请求过滤附件下载链接（购买已生效，不做额外等待）
    const reparsed = await window.colorTxt.extensionWs.parseChapterAttachments(
      url,
    );
    if (!reparsed.ok) {
      return {
        status: "failed",
        error: `购买后重新获取帖子失败：${reparsed.error}`,
      };
    }
    if (reparsed.purchased.length === 0) {
      return {
        status: "failed",
        error: "购买未生效（余额不足或站点拒绝），附件仍为未购状态",
      };
    }
    // 拿到直链后与章节下载同一路径触发下发
    return await downloadPurchasedAttachments(
      reparsed.purchased,
      url,
      name,
      bookUrl,
      sourceUrl,
      downloadDir,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", error: msg };
  }
}
