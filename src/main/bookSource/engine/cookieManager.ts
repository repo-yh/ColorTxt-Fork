import { CookieJar } from "tough-cookie";
import { getDomain } from "tldts";
import {
  getBookSource,
  getCookieJar,
  listBookSources,
  saveCookieJar,
  listManualCookieSources,
  saveBookSource,
} from "../store/bookSourceStore";

const jarByDomain = new Map<string, CookieJar>();

/** 手动 Cookie 模式域（书源 cookie 字段非空）：Cookie 以手动输入为唯一权威 */
const manualCookieDomains = new Set<string>();
let manualDomainsLoaded = false;

function ensureManualDomainsLoaded(): void {
  if (manualDomainsLoaded) return;
  manualDomainsLoaded = true;
  try {
    for (const { url } of listManualCookieSources()) {
      manualCookieDomains.add(getCookieStoreDomain(url));
    }
  } catch {
    /* store 不可用时退回自动模式 */
  }
}

/** 手动模式：请求固定使用书源 cookie 字段，Set-Cookie / JS putCookie 不再改动 CookieJar */
export function isManualCookieMode(url: string): boolean {
  ensureManualDomainsLoaded();
  return manualCookieDomains.has(getCookieStoreDomain(url));
}

export function getDomainFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname;
  } catch {
    return url;
  }
}

/**
 * Legado NetworkUtils.getSubDomain：Cookie 按可注册域（eTLD+1）归档，子域共享。
 * 登录常发生在 accounts.example.com，业务请求在 www.example.com——按完整主机名归档会取不到登录态。
 * IP / localhost 等无可注册域时退回主机名。
 */
export function getCookieStoreDomain(url: string): string {
  const host = getDomainFromUrl(url);
  return getDomain(host) ?? host;
}

/** 设为域级 Cookie（Domain=storeDomain），子域名请求也能匹配；非法域名退回 host-only */
function setDomainWideCookie(
  jar: CookieJar,
  storeDomain: string,
  name: string,
  value: string,
): void {
  try {
    jar.setCookieSync(
      `${name}=${value}; Domain=${storeDomain}; Path=/`,
      `https://${storeDomain}/`,
    );
  } catch {
    try {
      jar.setCookieSync(`${name}=${value}`, `https://${storeDomain}/`);
    } catch {
      /* ignore invalid */
    }
  }
}

function loadJar(storeDomain: string): CookieJar {
  let jar = jarByDomain.get(storeDomain);
  if (!jar) {
    jar = new CookieJar();
    const stored = getCookieJar(storeDomain);
    for (const [name, value] of Object.entries(stored)) {
      setDomainWideCookie(jar, storeDomain, name, value);
    }
    jarByDomain.set(storeDomain, jar);
  }
  return jar;
}

/** 枚举 jar 内全部 Cookie（含子域 host-only / HttpOnly），getCookiesSync(裸域) 会漏掉子域 Cookie */
function allJarCookies(jar: CookieJar): { key: string; value: string }[] {
  try {
    const cookies = jar.serializeSync()?.cookies ?? [];
    return cookies
      .filter((c) => typeof c.key === "string" && c.key)
      .map((c) => ({ key: String(c.key), value: String(c.value ?? "") }));
  } catch {
    return [];
  }
}

export function persistJar(
  storeDomain: string,
  opts?: { force?: boolean },
): void {
  // 手动模式域冻结：浏览器/验证窗等会话 Cookie 不落库，手动输入为唯一权威
  if (!opts?.force) {
    ensureManualDomainsLoaded();
    if (manualCookieDomains.has(storeDomain)) return;
  }
  const jar = jarByDomain.get(storeDomain);
  if (!jar) return;
  const map: Record<string, string> = {};
  for (const c of allJarCookies(jar)) {
    map[c.key] = c.value;
  }
  saveCookieJar(storeDomain, map);
}

export function cookieHeaderForUrl(url: string): string {
  const jar = loadJar(getCookieStoreDomain(url));
  try {
    return jar.getCookieStringSync(url) || "";
  } catch {
    return "";
  }
}

export function setCookieFromResponse(url: string, setCookie: string | string[]): void {
  // 手动模式：游客态请求的 Set-Cookie 会把登录 Cookie 冲掉（掉 Cookie 根因），不再回写
  if (isManualCookieMode(url)) return;
  const storeDomain = getCookieStoreDomain(url);
  const jar = loadJar(storeDomain);
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const h of headers) {
    if (!h) continue;
    try {
      jar.setCookieSync(h, url);
    } catch {
      /* ignore */
    }
  }
  persistJar(storeDomain);
}

export function getCookieKey(domain: string, name: string): string | null {
  const jar = loadJar(getCookieStoreDomain(domain));
  const found = allJarCookies(jar).find((c) => c.key === name);
  return found?.value ?? null;
}

function parseCookiePairs(cookie: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookie?.trim()) return map;
  for (const segment of cookie.split(";")) {
    const part = segment.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    if (value || value === "null") map[name] = value;
  }
  return map;
}

function mapToCookieHeader(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function resolveCookieUrl(url: string): string {
  return url.includes("://") ? url : `https://${url}`;
}

/** Legado CookieStore.setCookie：按 url 二级域名保存整段 Cookie（force 跳过手动模式冻结，供 applyManualSourceCookie 写入手动 Cookie） */
export function setCookieForUrl(
  url: string,
  cookie?: string | null,
  opts?: { force?: boolean },
): void {
  const absUrl = resolveCookieUrl(url);
  // 手动模式：书源 JS putCookie 等来源不再改动 CookieJar
  if (!opts?.force && isManualCookieMode(absUrl)) return;
  const storeDomain = getCookieStoreDomain(absUrl);
  if (!cookie?.trim()) {
    removeDomainCookies(storeDomain);
    return;
  }
  const jar = new CookieJar();
  const pairs = parseCookiePairs(cookie);
  if (Object.keys(pairs).length === 0) {
    try {
      jar.setCookieSync(cookie.trim(), absUrl);
    } catch {
      /* ignore invalid Set-Cookie */
    }
  } else {
    for (const [name, value] of Object.entries(pairs)) {
      setDomainWideCookie(jar, storeDomain, name, value);
    }
  }
  jarByDomain.set(storeDomain, jar);
  persistJar(storeDomain, opts);
}

/** Legado CookieStore.replaceCookie：与已有 Cookie 合并后保存 */
export function replaceCookieForUrl(
  url: string,
  cookie: string,
  opts?: { force?: boolean },
): void {
  if (!cookie?.trim()) return;
  const absUrl = resolveCookieUrl(url);
  const merged = {
    ...parseCookiePairs(cookieHeaderForUrl(absUrl)),
    ...parseCookiePairs(cookie),
  };
  setCookieForUrl(absUrl, mapToCookieHeader(merged), opts);
}

export function cookieStringToMap(cookie: string): Record<string, string> {
  return parseCookiePairs(cookie);
}

export function mapToCookieString(
  cookieMap: Record<string, string> | null | undefined,
): string {
  if (!cookieMap || !Object.keys(cookieMap).length) return "";
  return mapToCookieHeader(cookieMap);
}

/**
 * 书源保存/导入时同步手动 Cookie：
 * 非空 → 合并覆盖写入 CookieJar（保留 cf_clearance 等已有项）并进入手动模式；
 * 空 → 清空该域 Cookie 并退出手动模式（回到 Set-Cookie 自动演化）。
 */
export function applyManualSourceCookie(
  sourceUrl: string,
  cookie: string | null | undefined,
): void {
  ensureManualDomainsLoaded();
  const storeDomain = getCookieStoreDomain(sourceUrl);
  const trimmed = cookie?.trim();
  if (!trimmed) {
    manualCookieDomains.delete(storeDomain);
    removeDomainCookies(storeDomain);
    return;
  }
  manualCookieDomains.add(storeDomain);
  // force：绕过手动模式冻结，把手动 Cookie 真正写入 jar 并落库
  replaceCookieForUrl(sourceUrl, trimmed, { force: true });
}

export function removeDomainCookies(domain: string): void {
  const storeDomain = getCookieStoreDomain(domain);
  manualCookieDomains.delete(storeDomain);
  jarByDomain.delete(storeDomain);
  saveCookieJar(storeDomain, {});
  // 兼容旧版本按完整主机名归档的残留行（如 www.<域名>），一并清空
  if (storeDomain !== domain) {
    jarByDomain.delete(domain);
    saveCookieJar(domain, {});
  }
}

/**
 * 浏览器/验证窗关闭时统一固化 Cookie：session 域 Cookie 合并进 CookieJar（force 绕过手动冻结）
 * 并覆盖同域启用书源的 cookie 字段。帖子页服务端生成秒级响应，挑战/登录凭证一旦随关窗丢失，
 * 下次请求就要重走 _dsign 挑战再卡一轮——固化后引擎静态请求与后台 webView 直接带凭证。
 */
export function syncSessionCookieToSource(
  pageUrl: string,
  sessionCookieHeader: string,
): void {
  const header = sessionCookieHeader.trim();
  if (!header) return;
  const mergedHeader = mapToCookieString({
    ...parseCookiePairs(cookieHeaderForUrl(pageUrl)),
    ...parseCookiePairs(header),
  });
  if (!mergedHeader) return;
  const storeDomain = getCookieStoreDomain(pageUrl);
  for (const item of listBookSources()) {
    if (getCookieStoreDomain(item.bookSourceUrl) !== storeDomain) continue;
    const rec = getBookSource(item.bookSourceUrl);
    if (!rec || rec.cookie?.trim() === mergedHeader) continue;
    rec.cookie = mergedHeader;
    saveBookSource(rec);
  }
  applyManualSourceCookie(pageUrl, mergedHeader);
}
