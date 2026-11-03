import * as cheerio from "cheerio";

/**
 * 版本帖（Discuz 帖子页）付费附件解析：WS 油猴通道抓回的 HTML 直接按页面结构
 * 解析（不走书源规则），为「点章节下载 / 提示需购买」两态编排提供数据。
 * 解析器逻辑与 .qwen/tmp/test_attach_code_filter.mjs 蓝图一致（已实测两种形态互不误匹配）。
 */

export type ChapterAttachment = {
  /** 绝对 URL（相对路径已按 finalUrl 补全，可直接下发脚本下载） */
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

  // 已购附件：href 含 mod=attachment&aid=<base64签名> 的直链（按 aid 去重）。
  // 两种页面形态都命中：①p.attnm 容器内直链；②span#attach_N（showMenu 悬浮菜单）
  // 内直链——购买后部分帖子不再渲染 p.attnm 结构（实测 tid=426950 attnm=0）；
  // viewattachpayments 记录链接是 mod=misc&action=viewattachpayments，不会误命中
  const seenPurchased = new Set<string>();
  $("a[href*='mod=attachment&aid=']").each((_, a) => {
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

/** attachpay 购买页解析结果（form#attachpayform 的提交参数与计费信息） */
export type AttachpayForm = {
  /** 表单 action（相对路径已按 baseUrl 补全为绝对 URL，POST 直接用它） */
  action: string;
  formhash: string;
  aid: string;
  /** 帖子 tid（从 action 查询串解析；表单 hidden 不带 tid） */
  tid: string;
  /** 表单 hidden referer（Discuz 填站点根路径，POST body 原样带回） */
  referer: string;
  /** 本附件售价（金钱） */
  price: number;
  /** 表单展示的「购买后余额」（金钱；站点已算好的扣款后余额） */
  balanceAfter: number;
};

/**
 * 解析 attachpay 购买页：提取 form#attachpayform 的 action 与 hidden 字段，
 * 以及「售价 / 购买后余额」表格行。解析失败（页面结构不符）返回 null。
 */
export function parseAttachpayPage(
  html: string,
  baseUrl: string,
): AttachpayForm | null {
  const $ = cheerio.load(html);
  const form = $("form#attachpayform");
  if (!form.length) return null;
  const action = toAbsoluteUrl(form.attr("action") || "", baseUrl);
  if (!action) return null;
  const formhash =
    form.find("input[name='formhash']").attr("value")?.trim() ?? "";
  const aid = form.find("input[name='aid']").attr("value")?.trim() ?? "";
  const referer =
    form.find("input[name='referer']").attr("value")?.trim() ?? "";

  // 计费行：td 首列文本含「售价」/「购买后余额」，末列为金额（可能带单位文字）
  let price = 0;
  let balanceAfter = 0;
  form.find("tr").each((_, tr) => {
    const label = $(tr).find("td").first().text().trim();
    const isPrice = label.includes("售价");
    const isBalance = label.includes("购买后余额");
    if (!isPrice && !isBalance) return;
    const raw = $(tr).find("td").last().text().replace(/[^\d-]/g, "");
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return;
    if (isPrice) price = value;
    else balanceAfter = value;
  });

  const tid = (action.match(/tid=(\d+)/) || [])[1] ?? "";
  return { action, formhash, aid, tid, referer, price, balanceAfter };
}
