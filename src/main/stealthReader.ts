import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import {
  STEALTH_READER_IPC,
  type StealthBounds,
  type StealthCommand,
  type StealthEnterPayload,
  type StealthPagePayload,
} from "@shared/stealthReaderIpc";
import {
  DEFAULT_STEALTH_NAV_SHORTCUTS,
  normalizeStealthNavShortcuts,
  STEALTH_NAV_SHORTCUT_IDS,
  type StealthNavShortcutMap,
} from "@shared/stealthNavShortcuts";
import {
  closeStealthSettingsWindow,
  openStealthSettingsWindow,
  setStealthOverlayTransparencyRefresher,
  setStealthSettingsOverlayParentResolver,
} from "./stealthSettingsWindow";

const STEALTH_FLAG = "__colortxtStealthReader";

const DEFAULT_EXIT_ACCEL = "F9";

type Session = {
  overlay: BrowserWindow;
  owner: BrowserWindow;
  lastLine: number;
  payload: StealthPagePayload | null;
  /** 热换章待覆盖层拉取；与 boot 用的 payload 分开 */
  pendingPayload: StealthPagePayload | null;
  overlayHiddenByStealthHotkey: boolean;
  onOwnerClosed: () => void;
};

let session: Session | null = null;
let tearingDown = false;
let ipcRegistered = false;
/** 当前摸鱼会话已注册的导航键（可变，设置窗可改）。 */
let navShortcuts: StealthNavShortcutMap = { ...DEFAULT_STEALTH_NAV_SHORTCUTS };
let exitAccelerator = DEFAULT_EXIT_ACCEL;
/** 会话快捷键是否已注册（录制暂停时为 false）。 */
let sessionShortcutsRegistered = false;
/** 渲染进程 updateMinSize 同步过来的字号最小尺寸（setBounds 兜底） */
let overlayMinWidth = 8;
let overlayMinHeight = 8;

export function isStealthReaderWindow(win: BrowserWindow): boolean {
  return (win as unknown as Record<string, unknown>)[STEALTH_FLAG] === true;
}

export function isStealthModeActive(): boolean {
  return session != null && !session.overlay.isDestroyed();
}

/** 当前摸鱼会话的源窗（已 hide，全局显隐热键勿再 show）。 */
export function isStealthSessionOwner(win: BrowserWindow): boolean {
  const s = session;
  return Boolean(s && !s.owner.isDestroyed() && s.owner === win);
}

export function getStealthOverlayWindow(): BrowserWindow | null {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return null;
  return s.overlay;
}

/**
 * 重申透明。`nudge` 时水平微移逼 DWM 重绘（不改宽高）。
 * 悬停仅 setBackgroundColor，避免每次移入都抖一下。
 */
export function refreshStealthOverlayTransparency(opts?: {
  nudge?: boolean;
}): void {
  const win = getStealthOverlayWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.setBackgroundColor("#00000000");
    if (opts?.nudge) {
      const b = win.getBounds();
      if (b.width > 0 && b.height > 0) {
        win.setBounds({ ...b, x: b.x + 1 }, false);
        win.setBounds(b, false);
      }
    }
    win.setAlwaysOnTop(true, "screen-saver");
  } catch {
    /* ignore */
  }
}

function sendCommand(command: StealthCommand, extra?: string): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  s.overlay.webContents.send(STEALTH_READER_IPC.command, command, extra ?? "");
}

function navShortcutEntries(): { accel: string; command: StealthCommand }[] {
  return STEALTH_NAV_SHORTCUT_IDS.map((id) => ({
    accel: navShortcuts[id],
    command: id,
  }));
}

function unregisterPageShortcuts(): void {
  for (const { accel } of navShortcutEntries()) {
    if (!accel) continue;
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* ignore */
    }
  }
  if (exitAccelerator) {
    try {
      globalShortcut.unregister(exitAccelerator);
    } catch {
      /* ignore */
    }
  }
  sessionShortcutsRegistered = false;
}

function registerPageShortcuts(): void {
  if (!session || session.overlay.isDestroyed()) return;
  unregisterPageShortcuts();
  const seen = new Set<string>();
  for (const { accel, command } of navShortcutEntries()) {
    if (!accel || seen.has(accel)) continue;
    seen.add(accel);
    const ok = globalShortcut.register(accel, () => {
      sendCommand(command);
    });
    if (!ok) {
      console.warn(`[stealthReader] 无法注册全局快捷键 ${accel}`);
    }
  }
  if (exitAccelerator && !seen.has(exitAccelerator)) {
    const exitOk = globalShortcut.register(exitAccelerator, () => {
      sendCommand("exit");
    });
    if (!exitOk) {
      console.warn(`[stealthReader] 无法注册全局快捷键 ${exitAccelerator}`);
    }
  }
  sessionShortcutsRegistered = true;
}

/** 录制快捷键时暂停摸鱼全局键，避免无法录入。 */
export function suspendStealthSessionShortcuts(): void {
  if (!sessionShortcutsRegistered) return;
  unregisterPageShortcuts();
}

/** 录制结束后若仍在摸鱼模式则恢复。 */
export function resumeStealthSessionShortcuts(): void {
  if (!isStealthModeActive()) return;
  registerPageShortcuts();
}

export function applyStealthNavShortcuts(raw: unknown): void {
  navShortcuts = normalizeStealthNavShortcuts(raw);
  if (isStealthModeActive()) {
    registerPageShortcuts();
  }
}

/** 取色前让摸鱼覆盖层退至取色层之下（保持可见，便于对着正文取样）。 */
export function prepareStealthForEyedropper(): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  s.overlay.setAlwaysOnTop(false);
}

export function restoreStealthAfterEyedropper(): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  if (s.overlayHiddenByStealthHotkey) return;
  s.overlay.setFocusable(false);
  s.overlay.showInactive();
  s.overlay.setAlwaysOnTop(true, "screen-saver");
}

function clampBoundsToDisplay(bounds: StealthBounds): StealthBounds {
  const { x, y, width, height } = bounds;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
  // 用整屏 bounds（含任务栏区域），摸鱼窗可拖到任务栏上；z-order 用 screen-saver。
  const area = display.bounds;
  const minW = Math.max(8, overlayMinWidth);
  const minH = Math.max(8, overlayMinHeight);
  const w = Math.max(minW, Math.round(width));
  const h = Math.max(minH, Math.round(height));
  const maxX = area.x + Math.max(0, area.width - w);
  const maxY = area.y + Math.max(0, area.height - h);
  return {
    x: Math.min(maxX, Math.max(area.x, Math.round(x))),
    y: Math.min(maxY, Math.max(area.y, Math.round(y))),
    width: Math.min(w, area.width),
    height: Math.min(h, area.height),
  };
}

function defaultBounds(): StealthBounds {
  const area = screen.getPrimaryDisplay().bounds;
  const width = Math.min(320, area.width);
  const height = Math.min(180, area.height);
  return {
    x: area.x + Math.max(0, area.width - width - 24),
    y: area.y + 24,
    width,
    height,
  };
}

function loadStealthHtml(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    void win.loadURL(`${base}/stealth-reader.html`);
    return;
  }
  void win.loadFile(
    path.join(__dirname, "../renderer/stealth-reader.html"),
  );
}

/** 空标题，避免偶发系统 chrome 露出应用名。 */
function lockEmptyWindowTitle(win: BrowserWindow): void {
  win.setTitle("");
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!win.isDestroyed()) win.setTitle("");
  });
}

function createOverlayWindow(bounds: StealthBounds): BrowserWindow {
  const b = clampBoundsToDisplay(bounds);
  const opts: Electron.BrowserWindowConstructorOptions = {
    show: false,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 8,
    minHeight: 8,
    title: "",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    thickFrame: false,
    // Electron 文档：透明窗设 resizable:true 在部分平台会异常；缩放走 setBounds。
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    // 失焦时避免 DWM 给透明区填实心底（部分 Win11 + Electron）
    backgroundMaterial: "none",
    // 点击不激活；翻页键走全局快捷键。
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (process.platform === "win32") {
    opts.type = "toolbar";
  }
  const win = new BrowserWindow(opts);
  (win as unknown as Record<string, unknown>)[STEALTH_FLAG] = true;
  win.setAlwaysOnTop(true, "screen-saver");
  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.setBackgroundColor("#00000000");
  win.setFocusable(false);
  win.setResizable(false);
  lockEmptyWindowTitle(win);

  win.webContents.on("before-input-event", (event, input) => {
    const isToggleDevToolsKey =
      input.type === "keyDown" &&
      (input.key === "F12" ||
        ((input.control || input.meta) &&
          input.shift &&
          input.key.toLowerCase() === "i"));
    if (!isToggleDevToolsKey) return;
    event.preventDefault();
    if (!app.isPackaged) {
      win.webContents.toggleDevTools();
    }
  });

  loadStealthHtml(win);
  return win;
}

function restoreOwner(owner: BrowserWindow, line: number): void {
  if (owner.isDestroyed()) return;
  owner.setSkipTaskbar(false);
  owner.show();
  owner.focus();
  if (!owner.webContents.isDestroyed()) {
    owner.webContents.send(STEALTH_READER_IPC.ownerProgress, {
      line,
      focus: true,
    });
  }
}

function teardown(restore: boolean): void {
  if (tearingDown) return;
  tearingDown = true;
  const s = session;
  session = null;
  unregisterPageShortcuts();
  closeStealthSettingsWindow();
  const line = s?.lastLine ?? 1;
  if (s && !s.owner.isDestroyed()) {
    s.owner.removeListener("closed", s.onOwnerClosed);
  }
  const overlay = s?.overlay;
  if (overlay && !overlay.isDestroyed()) {
    overlay.destroy();
  }
  if (restore && s && !s.owner.isDestroyed()) {
    restoreOwner(s.owner, line);
  }
  tearingDown = false;
}

export function destroyStealthReaderWindow(): void {
  teardown(false);
}

/** Ctrl+`：显隐覆盖层；不把源窗口 show 回来。 */
export function toggleStealthOverlayVisibility(): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  setStealthOverlayHiddenByHotkey(!s.overlayHiddenByStealthHotkey && s.overlay.isVisible());
}

/** 与全局「显示/隐藏阅读器」同向：hidden=true 藏覆盖层。 */
export function setStealthOverlayHiddenByHotkey(hidden: boolean): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  if (hidden) {
    s.overlay.hide();
    s.overlayHiddenByStealthHotkey = true;
    return;
  }
  s.overlayHiddenByStealthHotkey = false;
  s.overlay.setFocusable(false);
  s.overlay.showInactive();
  s.overlay.setAlwaysOnTop(true, "screen-saver");
}

function enterFromOwner(
  owner: BrowserWindow,
  payload: StealthEnterPayload,
): { ok: boolean; message?: string } {
  if (session && !session.overlay.isDestroyed()) {
    if (session.owner === owner) {
      if (session.overlayHiddenByStealthHotkey) {
        toggleStealthOverlayVisibility();
      }
      return { ok: false, message: "已在摸鱼模式中" };
    }
    // 单例：其它窗口抢占时先退出并恢复当前源窗
    teardown(true);
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!text) {
    return { ok: false, message: "没有可阅读的正文" };
  }
  const startLine = Math.max(1, Math.floor(Number(payload.startLine) || 1));
  const chapters = Array.isArray(payload.chapters) ? payload.chapters : [];
  const bounds =
    payload.bounds &&
    Number.isFinite(payload.bounds.width) &&
    Number.isFinite(payload.bounds.height)
      ? clampBoundsToDisplay(payload.bounds)
      : defaultBounds();

  const overlay = createOverlayWindow(bounds);
  const onOwnerClosed = () => {
    if (session?.owner === owner) teardown(false);
  };
  const exitRaw =
    typeof payload.exitAccelerator === "string"
      ? payload.exitAccelerator.trim()
      : "";
  exitAccelerator = exitRaw || DEFAULT_EXIT_ACCEL;
  navShortcuts = normalizeStealthNavShortcuts(payload.navShortcuts);
  const pagePayload: StealthPagePayload = {
    text,
    startLine,
    chapters,
  };
  if (typeof payload.hasPrevChapter === "boolean") {
    pagePayload.hasPrevChapter = payload.hasPrevChapter;
  }
  if (typeof payload.hasNextChapter === "boolean") {
    pagePayload.hasNextChapter = payload.hasNextChapter;
  }
  session = {
    overlay,
    owner,
    lastLine: startLine,
    payload: pagePayload,
    pendingPayload: null,
    overlayHiddenByStealthHotkey: false,
    onOwnerClosed,
  };

  overlay.on("closed", () => {
    if (session?.overlay === overlay) {
      teardown(true);
    }
  });
  owner.on("closed", onOwnerClosed);

  overlay.once("ready-to-show", () => {
    if (overlay.isDestroyed() || !session) return;
    if (!owner.isDestroyed()) {
      owner.setSkipTaskbar(true);
      owner.hide();
    }
    overlay.setFocusable(false);
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, "screen-saver");
    registerPageShortcuts();
  });

  return { ok: true };
}

function setMenuOpen(open: boolean): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;
  s.overlay.webContents.send(STEALTH_READER_IPC.menuOpen, open);
}

function popupContextMenu(timedScrollActive: boolean): void {
  const s = session;
  if (!s || s.overlay.isDestroyed()) return;

  const template: MenuItemConstructorOptions[] = [
    {
      label: "定时滚动",
      type: "checkbox",
      checked: timedScrollActive,
      click: () => sendCommand("toggleTimedScroll"),
    },
    { type: "separator" },
    {
      label: "设置",
      click: () => {
        setMenuOpen(false);
        openStealthSettingsWindow();
      },
    },
    { type: "separator" },
    {
      label: "退出摸鱼模式",
      // 仅展示；实际退出已由 globalShortcut 注册，避免菜单再抢一次
      ...(exitAccelerator
        ? { accelerator: exitAccelerator, registerAccelerator: false }
        : {}),
      click: () => sendCommand("exit"),
    },
  ];

  setMenuOpen(true);
  const menu = Menu.buildFromTemplate(template);
  menu.popup({
    window: s.overlay,
    callback: () => setMenuOpen(false),
  });
}

export function registerStealthReaderIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  setStealthSettingsOverlayParentResolver(() => getStealthOverlayWindow());
  setStealthOverlayTransparencyRefresher(() =>
    refreshStealthOverlayTransparency({ nudge: true }),
  );

  ipcMain.handle(STEALTH_READER_IPC.enter, (evt, raw: unknown) => {
    const owner = BrowserWindow.fromWebContents(evt.sender);
    if (!owner || owner.isDestroyed()) {
      return { ok: false, message: "窗口已关闭" };
    }
    const payload = (raw ?? {}) as StealthEnterPayload;
    return enterFromOwner(owner, payload);
  });

  ipcMain.handle(STEALTH_READER_IPC.getPayload, (evt) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return null;
    const payload = s.payload;
    s.payload = null;
    return payload;
  });

  ipcMain.on(STEALTH_READER_IPC.ownerChapterNav, (evt, raw: unknown) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return;
    let direction: "prev" | "next" | null = null;
    let anchor: "start" | "end" = "start";
    if (raw === "prev" || raw === "next") {
      direction = raw;
    } else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const d = o.direction;
      if (d === "prev" || d === "next") direction = d;
      if (o.anchor === "end") anchor = "end";
    }
    if (!direction) return;
    if (s.owner.isDestroyed() || s.owner.webContents.isDestroyed()) return;
    s.owner.webContents.send(STEALTH_READER_IPC.ownerChapterNav, {
      direction,
      anchor,
    });
  });

  ipcMain.handle(STEALTH_READER_IPC.updatePayload, (evt, raw: unknown) => {
    const s = session;
    const senderWin = BrowserWindow.fromWebContents(evt.sender);
    if (!s || !senderWin || senderWin !== s.owner) {
      return { ok: false, message: "不在摸鱼模式或非源窗" };
    }
    if (s.overlay.isDestroyed()) {
      return { ok: false, message: "摸鱼窗已关闭" };
    }
    const o = (raw ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) {
      return { ok: false, message: "没有可阅读的正文" };
    }
    const startLine = Math.max(1, Math.floor(Number(o.startLine) || 1));
    const chapters = Array.isArray(o.chapters) ? o.chapters : [];
    const anchor = o.anchor === "end" ? "end" : "start";
    const page: StealthPagePayload = {
      text,
      startLine,
      chapters: chapters as StealthPagePayload["chapters"],
      anchor,
    };
    if (typeof o.hasPrevChapter === "boolean") {
      page.hasPrevChapter = o.hasPrevChapter;
    }
    if (typeof o.hasNextChapter === "boolean") {
      page.hasNextChapter = o.hasNextChapter;
    }
    s.lastLine = startLine;
    s.pendingPayload = page;
    // 只走 pending + command，避免大正文双通道 IPC
    s.overlay.webContents.send(
      STEALTH_READER_IPC.command,
      "reloadPayload" satisfies StealthCommand,
      "",
    );
    return { ok: true };
  });

  ipcMain.handle(STEALTH_READER_IPC.getPendingPayload, (evt) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return null;
    const payload = s.pendingPayload;
    s.pendingPayload = null;
    return payload;
  });

  ipcMain.on(STEALTH_READER_IPC.chapterNavSettled, (evt) => {
    const s = session;
    if (!s || s.owner.webContents !== evt.sender) return;
    // 成功热换会先写入 pending；有 pending 时由 reloadPayload 收尾
    if (s.pendingPayload) return;
    if (s.overlay.isDestroyed()) return;
    s.overlay.webContents.send(
      STEALTH_READER_IPC.command,
      "chapterNavSettled" satisfies StealthCommand,
      "",
    );
  });

  ipcMain.on(STEALTH_READER_IPC.exit, (evt, line: unknown) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return;
    const n = Math.max(1, Math.floor(Number(line) || s.lastLine));
    s.lastLine = n;
    teardown(true);
  });

  ipcMain.on(STEALTH_READER_IPC.popupMenu, (evt, raw: unknown) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return;
    const timedScrollActive =
      raw != null &&
      typeof raw === "object" &&
      (raw as { timedScrollActive?: unknown }).timedScrollActive === true;
    popupContextMenu(timedScrollActive);
  });

  ipcMain.on(STEALTH_READER_IPC.setNavShortcuts, (_evt, raw: unknown) => {
    applyStealthNavShortcuts(raw);
  });

  ipcMain.handle(STEALTH_READER_IPC.getBounds, (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return null;
    return win.getBounds();
  });

  ipcMain.on(STEALTH_READER_IPC.getCursorScreenPoint, (evt) => {
    const p = screen.getCursorScreenPoint();
    evt.returnValue = { x: p.x, y: p.y };
  });

  ipcMain.on(STEALTH_READER_IPC.setBounds, (evt, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed() || !raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const bounds = clampBoundsToDisplay({
      x: Number(o.x),
      y: Number(o.y),
      width: Number(o.width),
      height: Number(o.height),
    });
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height)
    ) {
      return;
    }
    win.setMinimumSize(overlayMinWidth, overlayMinHeight);
    win.setBounds(bounds);
    // 部分 Windows/DPI 下 setBounds 会悄悄小于 min，读回再钉死
    const after = win.getBounds();
    if (
      after.width < overlayMinWidth ||
      after.height < overlayMinHeight
    ) {
      win.setBounds({
        x: after.x,
        y: after.y,
        width: Math.max(after.width, overlayMinWidth),
        height: Math.max(after.height, overlayMinHeight),
      });
    }
  });

  ipcMain.on(STEALTH_READER_IPC.setPosition, (evt, x: unknown, y: unknown) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return;
    const nx = Math.round(Number(x));
    const ny = Math.round(Number(y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    win.setPosition(nx, ny);
  });

  ipcMain.on(STEALTH_READER_IPC.setMinSize, (evt, w: unknown, h: unknown) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return;
    const width = Math.max(1, Math.round(Number(w) || 1));
    const height = Math.max(1, Math.round(Number(h) || 1));
    overlayMinWidth = width;
    overlayMinHeight = height;
    win.setMinimumSize(width, height);
    // 仅 setMinimumSize 不会抬高已偏小的窗；字号变大时要把当前高度/宽度撑到能显示一行
    const b = win.getBounds();
    if (b.width >= width && b.height >= height) return;
    const next = clampBoundsToDisplay({
      x: b.x,
      y: b.y,
      width: Math.max(b.width, width),
      height: Math.max(b.height, height),
    });
    win.setBounds(next);
  });

  ipcMain.on(STEALTH_READER_IPC.blur, (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false);
    win.blur();
  });

  ipcMain.on(STEALTH_READER_IPC.refreshTransparency, (evt, nudge: unknown) => {
    const s = session;
    if (!s || s.overlay.webContents !== evt.sender) return;
    refreshStealthOverlayTransparency({ nudge: nudge === true });
  });

  ipcMain.handle(STEALTH_READER_IPC.prepareEyedropper, () => {
    prepareStealthForEyedropper();
  });

  ipcMain.handle(STEALTH_READER_IPC.restoreEyedropper, () => {
    restoreStealthAfterEyedropper();
  });
}
