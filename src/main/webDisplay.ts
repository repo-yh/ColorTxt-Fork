import { createServer, type Server } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
      theme: string;
      file: string;
      chapters: { title: string; line: number }[];
    };

export type FileListItem = {
  name: string;
  path: string;
  active: boolean;
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

export async function cacheContent(
  filePath: string,
  result: ContentResult,
): Promise<void> {
  const dir = getCacheDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, cacheKey(filePath) + ".json");
  await writeFile(file, JSON.stringify(result), "utf-8");
}

export async function getCachedContent(
  filePath: string,
): Promise<ContentResult | null> {
  const dir = getCacheDir();
  try {
    const file = join(dir, cacheKey(filePath) + ".json");
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as ContentResult;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  cacheDir = null;
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
  getFileList: () => Promise<FileListItem[]>,
): boolean {
  if (server) return true;

  // 确保缓存目录存在
  const dir = getCacheDir();
  mkdir(dir, { recursive: true }).catch(() => {});

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
      try {
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

    if (url.pathname === "/api/status") {
      try {
        const result = await getCurrentContent();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            ok: result.ok,
            file: result.ok ? result.file : undefined,
          }),
        );
      } catch {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false }));
      }
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

export function stopWebDisplay(): void {
  if (!server) return;
  server.close();
  server = null;
  console.log("[webDisplay] Server stopped");
}

export function isWebDisplayRunning(): boolean {
  return server !== null;
}
