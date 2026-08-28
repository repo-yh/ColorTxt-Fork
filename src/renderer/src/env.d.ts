/// <reference types="vite/client" />

import type { ColorTxtApi } from "../../preload";

declare global {
  interface Window {
    colorTxt: ColorTxtApi;
    __COLORTXT_PRELOAD__?: boolean;
    __colorTxtGenerateColoredHtmlForText?: (
      text: string,
      filePath: string,
    ) => Promise<
      | { ok: false; reason: string }
      | {
          ok: true;
          html: string;
          theme: string;
          file: string;
          chapters: { title: string; line: number }[];
        }
    >;
    __colorTxtGenerateColoredHtmlForSegment?: (
      text: string,
      filePath: string,
      startLine: number,
      endLine: number,
    ) => Promise<
      | { ok: false; reason: string }
      | {
          ok: true;
          html: string;
          /** 该行范围的纯文本块（行以 \n 连接，无任何 HTML 标签） */
          text: string;
          theme: string;
          file: string;
          chapters: { title: string; line: number }[];
          total: number;
          start: number;
          end: number;
        }
    >;
    __colorTxtGenerateHighlightLinesForText?: (
      text: string,
      filePath: string,
    ) => Promise<
      | { ok: false; reason: string }
      | {
          ok: true;
          file: string;
          total: number;
          chapters: Array<{
            title: string;
            /** 章节起始行（0-based，空标题组为 0） */
            line: number;
            lines: Array<{
              /** 行号（0-based，与 content 的 L<行号> 一致） */
              line: number;
              /** 行原文 */
              text: string;
              /** 该行命中的高亮词（正则词为实际匹配片段），去重 */
              words: string[];
            }>;
          }>;
        }
    >;
    __colorTxtGetFileList?: () => Array<{
      name: string;
      path: string;
      pathEncoded?: string;
      active: boolean;
    }>;
    __colorTxtGetFullText?: (opts: {
      chapterIndex?: number;
      start?: number;
      end?: number;
    }) => Promise<
      | { ok: false; reason: string }
      | {
          ok: true;
          body: string;
          start: number;
          end: number;
          total: number;
        }
    >;
    /** 章节列表（当前书）：供内置 AI 补全章节名 */
    __colorTxtGetChapterTitles?: () => Promise<
      | { ok: false; reason: string }
      | {
          ok: true;
          chapters: Array<{
            chapterIndex: number;
            title: string;
            lineNumber: number;
            charCount: number;
          }>;
        }
    >;
    /** 补全章节名（当前书）：保留原标题前缀，批量替换标题行并写回磁盘 */
    __colorTxtApplyChapterTitles?: (payload: {
      items?: Array<{ chapterIndex: number; title: string }>;
    }) => Promise<
      | { ok: false; reason: string; skipped?: Array<{ chapterIndex: number; reason: string }> }
      | {
          ok: true;
          applied: Array<{
            chapterIndex: number;
            oldTitle: string;
            newTitle: string;
          }>;
          skipped: Array<{ chapterIndex: number; reason: string }>;
        }
    >;
  }
}

export {};

