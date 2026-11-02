import * as cheerio from "cheerio";

/**
 * 版本帖（Discuz 帖子页）付费附件解析：扩展 WS 通道抓回的 HTML 直接按页面结构
 * 解析（不走书源规则），为「点章节下载 / 提示需购买」两态编排提供数据。
 * 解析器逻辑与 .qwen/tmp/test_attach_code_filter.mjs 蓝图一致（已实测两种形态互不误匹配）。
 */

export type ChapterAttachment = {
  /** 绝对 URL（相对路径已按 finalUrl 补全，可直接下发扩展下载） */
  url: string;
  /** 附件文件名 */
  name: string;
};

export type ChapterAttachments = {
  /** 已购附件：p.attnm 内 mod=attachment 签名链接（可直接下载） */
  purchased: ChapterAttachment[];
  /** 未购附件：action=attachpay 购买链接（提示购买用） */
  unpaid: ChapterAttachment[];
};

function toAbsoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl || undefined).toString();
  } catch {
    return href;
  }
}

/** 解析帖子页 HTML 中的已购 / 未购附件（aid 各自去重） */
export function parseChapterAttachments(
  html: string,
  baseUrl: string,
): ChapterAttachments {
  const $ = cheerio.load(html);
  const purchased: ChapterAttachment[] = [];
  const unpaid: ChapterAttachment[] = [];

  // 已购附件：p.attnm 内 href 含 mod=attachment 的签名链接（按 aid 去重）
  const seenPurchased = new Set<string>();
  $("p.attnm")
    .find("a[href*='mod=attachment']")
    .each((_, a) => {
      const href = $(a).attr("href") || "";
      const name = $(a).text().trim();
      const aid = (href.match(/aid=([A-Za-z0-9%+/=]+)/) || [])[1] || "";
      if (href && name && !seenPurchased.has(aid)) {
        seenPurchased.add(aid);
        purchased.push({ url: toAbsoluteUrl(href, baseUrl), name });
      }
    });

  // 未购附件：href 含 action=attachpay&aid=<数字>&tid=<数字>
  // （记录链接是 action=viewattachpayments&…，不含 "action=attachpay&"，天然不误匹配）；
  // 同一附件卡里附件名链接与「购买」按钮同 aid，去重后保留首个（附件名文本）
  const seenUnpaid = new Set<string>();
  $("a[href*='action=attachpay&aid=']").each((_, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(/action=attachpay&aid=(\d+)&tid=(\d+)/);
    const text = $(a).text().trim();
    if (m && !seenUnpaid.has(m[1])) {
      seenUnpaid.add(m[1]);
      unpaid.push({ url: toAbsoluteUrl(href, baseUrl), name: text });
    }
  });

  return { purchased, unpaid };
}
