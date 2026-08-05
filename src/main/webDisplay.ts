import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

const PORT = 8888;

let server: Server | null = null;

export type ContentResult =
  | { ok: false; reason: string }
  | { ok: true; html: string; theme: string; file: string };

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
  getColoredHtml: () => Promise<ContentResult>,
): boolean {
  if (server) return true;

  const frontDir = join(app.getAppPath(), "front");

  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      serveFile(res, join(frontDir, "index.html"), "text/html; charset=utf-8");
      return;
    }

    if (url === "/api/content") {
      try {
        const result = await getColoredHtml();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({ ok: false, reason: "服务内部错误" }),
        );
      }
      return;
    }

    if (url === "/api/status") {
      try {
        const result = await getColoredHtml();
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
