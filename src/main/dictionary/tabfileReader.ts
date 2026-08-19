/**
 * Tabfile: single-file tab-separated dictionary (.txt/.tab/.tsv/.dic).
 * Each line is "headword\tdefinition"; lines starting with "##" are metadata.
 */
import { readFile } from "node:fs/promises";

export type TabfileMeta = {
  name?: string;
  description?: string;
};

const cmpAscii = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** 扫描 "##key\tvalue" 元数据行（约定在文件开头，遇到首个非 ## 行即停）。 */
export function parseTabfileMeta(text: string): TabfileMeta {
  const meta: TabfileMeta = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.startsWith("##")) break;
    const tab = raw.indexOf("\t");
    const key = raw.slice(2, tab < 0 ? undefined : tab).trim();
    const value = tab < 0 ? "" : raw.slice(tab + 1);
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
  }
  return meta;
}

export class TabfileReader {
  info: TabfileMeta = {};
  private words: string[] = [];
  private definitions: string[] = [];

  async load(filePath: string): Promise<void> {
    const text = await readFile(filePath, "utf8");
    this.parse(text);
  }

  private parse(text: string): void {
    const words: string[] = [];
    const definitions: string[] = [];
    const meta: TabfileMeta = {};

    let pos = 0;
    while (pos < text.length) {
      let nl = text.indexOf("\n", pos);
      if (nl < 0) nl = text.length;
      const ln =
        text.charCodeAt(nl - 1) === 13
          ? text.slice(pos, nl - 1)
          : text.slice(pos, nl);
      pos = nl + 1;
      if (!ln) continue;

      const tab = ln.indexOf("\t");
      if (tab < 0) continue;
      const head = ln.slice(0, tab);
      const def = ln.slice(tab + 1);

      if (head.startsWith("##")) {
        const key = head.slice(2).trim();
        if (key === "name") meta.name = def;
        else if (key === "description") meta.description = def;
        continue;
      }
      // dictd 风格的 meta 行（00database*）也跳过，不当词条
      if (head.startsWith("00database")) continue;
      words.push(head);
      // 字面 \n 转成换行（dictd 转义约定）
      definitions.push(def.replace(/\\n/g, "\n"));
    }

    // 大小写不敏感排序，供二分查找
    const order = words
      .map((_, i) => i)
      .sort((a, b) => cmpAscii(words[a]!, words[b]!));
    const sortedWords: string[] = new Array(words.length);
    const sortedDefs: string[] = new Array(words.length);
    for (let i = 0; i < order.length; i++) {
      const k = order[i]!;
      sortedWords[i] = words[k]!;
      sortedDefs[i] = definitions[k]!;
    }

    this.words = sortedWords;
    this.definitions = sortedDefs;
    this.info = meta;
  }

  get entryCount(): number {
    return this.words.length;
  }

  /** 大小写不敏感二分查找，命中返回词义。 */
  lookup(word: string): string | undefined {
    let lo = 0;
    let hi = this.words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = cmpAscii(word, this.words[mid]!);
      if (cmp === 0) return this.definitions[mid]!;
      if (cmp > 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }
}

/**
 * 将词义里的 <link rel=stylesheet> 剥掉（相对路径无法解析），
 * 并把配套 .css 文件内容内联成 <style> 注入，对齐 MDict 的处理方式。
 */
export async function resolveTabfileCss(
  html: string,
  cssPaths: string[],
): Promise<string> {
  const chunks: string[] = [];
  for (const p of cssPaths) {
    try {
      const text = await readFile(p, "utf8");
      const t = text.trim();
      if (t) chunks.push(t);
    } catch {
      /* skip missing */
    }
  }

  let s = html.replace(/<link\b[^>]*\bstylesheet\b[^>]*>/gi, "");
  if (chunks.length) {
    s = `<style>${chunks.join("\n")}</style>${s}`;
  }
  return s;
}
