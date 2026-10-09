/** 详情页付费附件信息（书源 ruleBookInfo @put 写入 Book.variable） */

export interface DetailAttachment {
  /** 购买/下载页链接（相对路径已按书源域名补全） */
  url: string;
  /** 附件文件名 */
  name: string;
  /** 附件描述（大小、下载次数、售价） */
  meta: string;
}

function toAbsoluteUrl(href: string, origin: string): string {
  try {
    return new URL(href, origin || undefined).toString();
  } catch {
    return href;
  }
}

/** variable 的 attachUrl/attachName/attachMeta → 附件列表（无 attachUrl 返回空数组） */
export function parseDetailAttachments(
  variable: Record<string, string> | undefined,
  origin: string,
): DetailAttachment[] {
  const url = variable?.attachUrl?.trim();
  if (!url) return [];
  const name = (variable?.attachName ?? "").trim();
  const meta = (variable?.attachMeta ?? "").trim();
  return [
    {
      url: toAbsoluteUrl(url, origin.trim()),
      name: name || url,
      meta,
    },
  ];
}
