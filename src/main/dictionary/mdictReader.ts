/**
 * MDict (.mdx) via mdict-js. Cache by path; follow @@@LINK= up to 5 hops.
 */
import { createRequire } from "node:module";
import { open as fsOpen } from "node:fs/promises";
import { buildLookupCandidates } from "./lookupCandidates";

const require = createRequire(import.meta.url);

type WordDefinition = { keyText: string; definition: string };
type MdictInstance = {
  lookup(word: string): WordDefinition;
};

type MdictCtor = new (path: string) => MdictInstance;

function loadMdictCtor(): MdictCtor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = require("mdict-js");
  const Ctor = mod?.default ?? mod?.Mdict ?? mod;
  if (typeof Ctor !== "function") {
    throw new Error("mdict-js: Mdict constructor not found");
  }
  return Ctor as MdictCtor;
}

const Mdict = loadMdictCtor();
const cache = new Map<string, MdictInstance>();

function getMdict(mdxPath: string): MdictInstance {
  const key = mdxPath;
  let inst = cache.get(key);
  if (!inst) {
    inst = new Mdict(mdxPath);
    cache.set(key, inst);
  }
  return inst;
}

export function clearMdictCache(mdxPath?: string): void {
  if (mdxPath) cache.delete(mdxPath);
  else cache.clear();
}

/** ?? MDX ? UTF-16LE XML ? Encrypted ???bit0=????? ? unsupported? */
export async function readMdxHeaderEncrypted(mdxPath: string): Promise<{
  title?: string;
  encrypt: number;
}> {
  const fh = await fsOpen(mdxPath, "r");
  try {
    const sizeBuf = Buffer.alloc(4);
    await fh.read(sizeBuf, 0, 4, 0);
    const headerByteSize = sizeBuf.readUInt32BE(0);
    if (headerByteSize === 0 || headerByteSize > 1024 * 1024) {
      throw new Error(`MDX header size out of range: ${headerByteSize}`);
    }
    const xmlBuf = Buffer.alloc(headerByteSize);
    await fh.read(xmlBuf, 0, headerByteSize, 4);
    const xml = xmlBuf.toString("utf16le").replace(/\0+$/g, "");
    const attrs: Record<string, string> = {};
    for (const m of xml.matchAll(/(\w+)="((?:.|\r|\n)*?)"/g)) {
      attrs[m[1]!] = m[2]!;
    }
    let encrypt = 0;
    const encVal = attrs["Encrypted"];
    if (!encVal || encVal === "" || encVal === "No") encrypt = 0;
    else if (encVal === "Yes") encrypt = 1;
    else {
      const n = parseInt(encVal, 10);
      encrypt = Number.isFinite(n) ? n : 0;
    }
    return {
      title: attrs["Title"]?.trim() || undefined,
      encrypt,
    };
  } finally {
    await fh.close();
  }
}

/** ?? script/style??????????? MDX ?? \\0??? */
export function simplifyMdictHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/\r\n?/g, "\n");
  // MDX ???? C ?? NUL ????????? ?
  s = s.replace(/\u0000+/g, "");
  return s.trim();
}

function extractLinkTarget(definition: string): string | null {
  const t = definition.trim();
  if (/^@@@LINK=/i.test(t)) {
    return t.replace(/^@@@LINK=/i, "").trim() || null;
  }
  return null;
}

export type MdictLookupResult = {
  keyText: string;
  definition: string;
};

/**
 * ????? @@@LINK=??? 5 ??????????????
 */
export async function lookupMdict(
  mdxPath: string,
  word: string,
): Promise<MdictLookupResult | null> {
  const mdict = getMdict(mdxPath);
  const candidates = buildLookupCandidates(word);
  for (const cand of candidates) {
    let current = cand;
    for (let hop = 0; hop < 6; hop++) {
      let def: WordDefinition;
      try {
        def = mdict.lookup(current);
      } catch {
        break;
      }
      if (!def?.definition) break;
      const link = extractLinkTarget(def.definition);
      if (link && hop < 5) {
        current = link;
        continue;
      }
      return {
        keyText: def.keyText || current,
        definition: simplifyMdictHtml(def.definition),
      };
    }
  }
  return null;
}
