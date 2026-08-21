import { createServer, type Server } from "node:http";
import { readFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { createHash } from "node:crypto";

const PORT = 8888;

let server: Server | null = null;
let currentFilePath: string | null = null;

export function setCurrentFilePath(path: string): void {
  currentFilePath = path;
}

export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

export type ContentResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      html: string;
      /** 分段请求返回：该行范围的纯文本块（行以 \n 连接，无 HTML 标签）；全文请求为 undefined */
      text?: string;
      theme: string;
      file: string;
      chapters: { title: string; line: number }[];
      total?: number;
      start?: number;
      end?: number;
    };

export type FileListItem = {
  name: string;
  path: string;
  active: boolean;
};

export type HighlightLineItem = {
  /** 行号（0-based，与 content 的 L<行号> 一致） */
  line: number;
  /** 行原文 */
  text: string;
  /** 该行命中的高亮词（正则词为实际匹配片段），去重 */
  words: string[];
};

export type HighlightChapterGroup = {
  /** 章节标题；空标题 = 第一章之前（或全书无章节）的正文 */
  title: string;
  /** 章节起始行（0-based，空标题组为 0） */
  line: number;
  /** 该章节内含高亮词的行（行号 + 原文 + 命中词列表） */
  lines: HighlightLineItem[];
};

export type HighlightsResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      file: string;
      total: number;
      chapters: HighlightChapterGroup[];
    };

// ---- Cache ----

let cacheDir: string | null = null;

function getCacheDir(): string {
  if (!cacheDir) {
    cacheDir = join(app.getPath("temp"), "colortxt-webdisplay");
  }
  return cacheDir;
}

function cacheKey(filePath: string): string {
  return createHash("md5").update(filePath).digest("hex");
}

export function clearCache(): void {
  cacheDir = null;
}

/**
 * 清理 tmp 目录下的失效缓存：删除不在文件列表中的文件对应的缓存
 */
export async function cleanStaleCache(validFilePaths: string[]): Promise<void> {
  const dir = getCacheDir();
  const validHashes = new Set(validFilePaths.map((fp) => cacheKey(fp)));

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".json")) continue;
    const hash = name.slice(0, -5);
    if (!validHashes.has(hash)) {
      await unlink(join(dir, name)).catch(() => {});
    }
  }
}

// ---- Server ----

function serveFile(
  res: import("node:http").ServerResponse,
  filePath: string,
  contentType: string,
): void {
  readFile(filePath, "utf-8")
    .then((body) => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(body);
    })
    .catch(() => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    });
}

export function startWebDisplay(
  getCurrentContent: () => Promise<ContentResult>,
  getContentForFile: (filePath: string, refresh?: boolean) => Promise<ContentResult>,
  getContentForSegment: (filePath: string, start: number, end: number, refresh?: boolean) => Promise<ContentResult>,
  getFileList: () => Promise<FileListItem[]>,
  getHighlightsForFile: (filePath: string) => Promise<HighlightsResult>,
): boolean {
  if (server) return true;

  // 确保缓存目录存在
  const dir = getCacheDir();
  mkdir(dir, { recursive: true }).catch(() => {});

  // 清理失效缓存（不在文件列表中的文件对应的缓存）
  getFileList()
    .then((files) => cleanStaleCache(files.map((f) => f.path)))
    .catch(() => {});

  const frontDir = join(app.getAppPath(), "front");

  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveFile(res, join(frontDir, "index.html"), "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/files") {
      try {
        const files = await getFileList();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: true, files }));
      } catch {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: true, files: [] }));
      }
      return;
    }

    if (url.pathname === "/api/content") {
      const fileParam = url.searchParams.get("file");
      const refresh = url.searchParams.has("refresh");
      const startStr = url.searchParams.get("start");
      const endStr = url.searchParams.get("end");
      const wantSegment = startStr != null && endStr != null && fileParam != null;

      try {
        // 分段请求：由上层提供分段专用处理器（全文分词，只生成片段 HTML）
        if (wantSegment) {
          const segStart = parseInt(startStr!, 10);
          const segEnd = parseInt(endStr!, 10);
          const result = await getContentForSegment(fileParam!, segStart, segEnd, refresh);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify(result));
          return;
        }

        let result: ContentResult;
        if (fileParam) {
          result = await getContentForFile(fileParam, refresh);
        } else {
          result = await getCurrentContent();
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, reason: "服务内部错误" }));
      }
      return;
    }

    if (url.pathname === "/api/highlights") {
      const fileParam = url.searchParams.get("file");

      try {
        let result: HighlightsResult;
        if (fileParam) {
          result = await getHighlightsForFile(fileParam);
        } else {
          const fp = getCurrentFilePath();
          if (!fp) {
            result = { ok: false, reason: "未打开文件" };
          } else {
            result = await getHighlightsForFile(fp);
          }
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, reason: "服务内部错误" }));
      }
      return;
    }

    if (url.pathname === "/api/status") {
      const fp = getCurrentFilePath();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: fp != null, file: fp ?? undefined }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[webDisplay] Port ${PORT} already in use`);
    }
    server = null;
  });

  server.listen(PORT, () => {
    console.log(`[webDisplay] Server started on http://localhost:${PORT}`);
  });

  return true;
}

export function stopWebDisplay(getFileList?: () => Promise<FileListItem[]>): void {
  if (!server) return;
  server.close();
  server = null;

  // 关闭时清理失效缓存
  if (getFileList) {
    getFileList()
      .then((files) => cleanStaleCache(files.map((f) => f.path)))
      .catch(() => {});
  }

  console.log("[webDisplay] Server stopped");
}

export function isWebDisplayRunning(): boolean {
  return server !== null;
}
