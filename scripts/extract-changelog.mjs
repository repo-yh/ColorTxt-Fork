// 从 CHANGELOG.md 顶部截取当前版本条目段（第一个 ## 到第二个 ## 前），写入 release-notes.md
// 用法：node scripts/extract-changelog.mjs <version>   例如 3.8.16
// 顶部第一个条目必须就是该版本，否则报错退出——防止把旧版本说明发进 release
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/extract-changelog.mjs <version>");
  process.exit(1);
}

const md = readFileSync("CHANGELOG.md", "utf8");
const lines = md.split(/\r?\n/);
const header = `## ${version}`;

const start = lines.findIndex((l) => /^##\s/.test(l));
if (start < 0) {
  console.error("CHANGELOG.md 中没有任何版本条目");
  process.exit(1);
}
if (lines[start].trim() !== header) {
  console.error(
    `CHANGELOG.md 顶部第一个条目不是 ${header}（实际: ${lines[start].trim()}）——请确认已补当前版本条目且位于顶部`,
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start, end)
  .join("\n")
  .trim();

writeFileSync("release-notes.md", body + "\n");
console.log(body);
