/**
 * 简单换行（wrappingStrategy: simple）下的中文换行优化：
 * - 将 General Punctuation 等网文常用标点按全角列宽估算（包装 `isFullWidthCharacter` /
 *   `computeCharWidth`；`、。「」` 等本就在 CJK/全角区，无需补）
 * - 全角样字改为「汉」（见 electron.vite Monaco transform）
 * 不改 canBreak（曾用 break-all 会导致 ，。？ 等出现在行首）。
 * 高级换行开启时由 ReaderMain 关闭此开关。
 */

let cjkWrapOptimizeEnabled = true;

export function setCjkWrapOptimizeEnabled(on: boolean): void {
  cjkWrapOptimizeEnabled = on;
}

export function isCjkWrapOptimizeEnabled(): boolean {
  return cjkWrapOptimizeEnabled;
}

/**
 * Monaco 默认 `isFullWidthCharacter` 不含 General Punctuation（U+2000–206F），
 * 弯引号/破折号/省略号等会被当成半角，比例中文字体下易行尾溢出。
 */
export function isCjkWrapOptimizeFullWidthCodePoint(charCode: number): boolean {
  // ‐-‒–—―
  if (charCode >= 0x2010 && charCode <= 0x2015) return true;
  // ‘’‚‛“”„‟
  if (charCode >= 0x2018 && charCode <= 0x201f) return true;
  // • ‥ … ⋯
  if (
    charCode === 0x2022 ||
    charCode === 0x2025 ||
    charCode === 0x2026 ||
    charCode === 0x22ef
  ) {
    return true;
  }
  // ‹›
  if (charCode === 0x2039 || charCode === 0x203a) return true;
  return false;
}
