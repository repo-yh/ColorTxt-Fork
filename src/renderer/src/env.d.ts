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
          theme: string;
          file: string;
          chapters: { title: string; line: number }[];
          total: number;
          start: number;
          end: number;
        }
    >;
    __colorTxtGetFileList?: () => Array<{
      name: string;
      path: string;
      active: boolean;
    }>;
  }
}

export {};

