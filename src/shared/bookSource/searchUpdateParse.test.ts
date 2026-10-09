import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBetterCandidate,
  isNewerThanBaseline,
  parseSearchUpdateTitle,
  titleMatchesBookName,
} from "./searchUpdateParse.ts";

describe("parseSearchUpdateTitle", () => {
  it("parses range and finished mark", () => {
    assert.deepEqual(
      parseSearchUpdateTitle("《官场鬼才之从副镇长到权利巅峰》校对版1-1965完作者：大-帅[已完结]"),
      { chapterNum: 1965, finished: true },
    );
  });

  it("parses [1-1201章][未完结]", () => {
    assert.deepEqual(
      parseSearchUpdateTitle("《官场鬼才之从副镇长到权利巅峰》 作者:大-帅[1-1201章][未完结]"),
      { chapterNum: 1201, finished: false },
    );
  });

  it("unbracketed title with chapter range", () => {
    assert.deepEqual(
      parseSearchUpdateTitle("官场鬼才之从副镇长到权利巅峰 校对版1-1965完"),
      { chapterNum: 1965, finished: true },
    );
  });

  it("keeps max of multiple ranges", () => {
    assert.equal(parseSearchUpdateTitle("1-500完501-1965完").chapterNum, 1965);
  });

  it("date does not inflate chapter count", () => {
    const info = parseSearchUpdateTitle("某某书 2026-8-2 上传");
    assert.equal(info.chapterNum, 8);
    assert.equal(info.finished, false);
  });

  it("no numbers yields zero", () => {
    assert.equal(parseSearchUpdateTitle("《绝世好书》").chapterNum, 0);
  });

  it("连载中 is not finished", () => {
    assert.equal(parseSearchUpdateTitle("某某 1-100章 连载中").finished, false);
  });

  it("完本/全本 count as finished", () => {
    assert.equal(parseSearchUpdateTitle("《书名》完本").finished, true);
    assert.equal(parseSearchUpdateTitle("《书名》全本").finished, true);
  });

  it("empty title yields zero and unfinished", () => {
    assert.deepEqual(parseSearchUpdateTitle(""), { chapterNum: 0, finished: false });
    assert.deepEqual(parseSearchUpdateTitle(undefined), { chapterNum: 0, finished: false });
  });
});

describe("titleMatchesBookName", () => {
  it("matches bracketed title", () => {
    assert.equal(titleMatchesBookName("《官场鬼才》校对版1-1965完", "官场鬼才"), true);
  });

  it("matches unbracketed title", () => {
    assert.equal(titleMatchesBookName("官场鬼才 1-1965完", "官场鬼才"), true);
  });

  it("rejects unrelated title", () => {
    assert.equal(titleMatchesBookName("《别的书》1-100章", "官场鬼才"), false);
  });

  it("empty book name never matches", () => {
    assert.equal(titleMatchesBookName("《某》", "  "), false);
  });
});

describe("isNewerThanBaseline", () => {
  it("no baseline means no update (first run writes baseline)", () => {
    assert.equal(isNewerThanBaseline({ chapterNum: 1965, finished: true }, null), false);
    assert.equal(isNewerThanBaseline({ chapterNum: 1965, finished: true }, { chapterNum: 0 }), false);
  });

  it("finished beats larger unfinished baseline", () => {
    assert.equal(
      isNewerThanBaseline({ chapterNum: 1965, finished: true }, { chapterNum: 2000, finished: false }),
      true,
    );
  });

  it("unfinished candidate loses to finished baseline", () => {
    assert.equal(
      isNewerThanBaseline({ chapterNum: 3000, finished: false }, { chapterNum: 1965, finished: true }),
      false,
    );
  });

  it("same finished flag compares chapterNum", () => {
    assert.equal(
      isNewerThanBaseline({ chapterNum: 2000, finished: true }, { chapterNum: 1965, finished: true }),
      true,
    );
    assert.equal(
      isNewerThanBaseline({ chapterNum: 1965, finished: true }, { chapterNum: 1965, finished: true }),
      false,
    );
  });

  it("zero candidate never wins", () => {
    assert.equal(
      isNewerThanBaseline({ chapterNum: 0, finished: false }, { chapterNum: 100, finished: false }),
      false,
    );
  });
});

describe("isBetterCandidate", () => {
  it("prefers finished regardless of chapterNum", () => {
    assert.equal(isBetterCandidate({ chapterNum: 100, finished: true }, { chapterNum: 5000, finished: false }), true);
    assert.equal(isBetterCandidate({ chapterNum: 100, finished: false }, { chapterNum: 50, finished: true }), false);
  });

  it("same finished compares chapterNum", () => {
    assert.equal(isBetterCandidate({ chapterNum: 300, finished: false }, { chapterNum: 200, finished: false }), true);
    assert.equal(isBetterCandidate({ chapterNum: 100, finished: false }, { chapterNum: 200, finished: false }), false);
  });

  it("zero chapterNum never beats", () => {
    assert.equal(isBetterCandidate({ chapterNum: 0, finished: true }, { chapterNum: 10, finished: false }), false);
  });
});
