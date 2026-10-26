// 从 CHANGELOG.md 截取「当前版本 .. 上一个公开版本」之间的所有条目段，写入 release-notes.md
// 用法：node scripts/extract-changelog.mjs <version> [prevVersion]
// - 顶部第一个条目必须就是 <version>，否则报错退出——防止把旧版本说明发进 release
// - 提供 prevVersion 且其条目存在时，截取 [version .. prevVersion) 全部条目（一次 tag 带多个 CHANGELOG 版本发布的场景）
// - 未提供 prevVersion 或找不到其条目时，回退为仅提取 version 单段
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
const prevVersion = process.argv[3] || "";
if (!version) {
  console.error("usage: node scripts/extract-changelog.mjs <version> [prevVersion]");
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

const nextIdx = (() => {
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) return i;
  }
  return lines.length;
})();

let end = nextIdx;
if (prevVersion && prevVersion !== version) {
  const prevHeader = `## ${prevVersion}`;
  const prevIdx = lines.findIndex((l, i) => i > start && l.trim() === prevHeader);
  if (prevIdx > start) {
    end = prevIdx;
  } else {
    console.error(`CHANGELOG.md 未找到 ${prevHeader}，回退为仅提取 ${header} 单段`);
  }
}

const body = lines
  .slice(start, end)
  .join("\n")
  .trim();

writeFileSync("release-notes.md", body + "\n");
console.log(body);
