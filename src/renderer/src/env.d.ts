/// <reference types="vite/client" />

import type { ColorTxtApi } from "../../preload";

declare global {
  interface Window {
    colorTxt: ColorTxtApi;
    __COLORTXT_PRELOAD__?: boolean;
    __colorTxtGenerateColoredHtml?: () => Promise<
      | { ok: false; reason: string }
      | { ok: true; html: string; theme: string; file: string }
    >;
  }
}

export {};

