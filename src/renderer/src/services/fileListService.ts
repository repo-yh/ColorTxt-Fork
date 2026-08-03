import type { CategoryEditorRow } from "../constants/fileCategories";
import type {
  ColorTxtOpenDialogOptions,
  ColorTxtOpenDialogResult,
} from "@shared/colorTxtOpenSaveDialog";

export type TxtFileItem = {
  name: string;
  path: string;
  size: number;
  /** 首次加入侧栏列表的时间（ms）；旧数据由迁移逻辑回填 */
  addedAt?: number;
  /** 侧栏分类名；仅存于文件列表缓存，与 file.meta 无关 */
  category?: string;
};

type ColorTxtShellApi = {
  showOpenDialog?: (
    o: ColorTxtOpenDialogOptions,
  ) => Promise<ColorTxtOpenDialogResult>;
  listTxtFilesInDirectory?: (dirPath: string) => Promise<{
    dirPath: string;
    files: TxtFileItem[];
  }>;
};

export function basenameFromPath(filePath: string) {
  const p = filePath.replace(/\\/g, "/");
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function normalizeTxtFileItem(item: TxtFileItem): TxtFileItem {
  const name = basenameFromPath(item.path);
  const catRaw = typeof item.category === "string" ? item.category.trim() : "";
  const base: TxtFileItem = { ...item, name };
  if (catRaw) base.category = catRaw;
  else delete base.category;
  return base;
}

/** 侧栏文件列表：按路径去重、统一显示名、按文件名排序（与是否「合并旧列表」无关） */
export function prepareTxtFileList(items: TxtFileItem[]): TxtFileItem[] {
  const byPath = new Map<string, TxtFileItem>();
  for (const item of items) {
    byPath.set(item.path, normalizeTxtFileItem(item));
  }
  return Array.from(byPath.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}

const ADDED_AT_MIGRATION_BASE = 1_700_000_000_000;

/** 为缺少 `addedAt` 的项按当前数组顺序赋单调时间戳，便于「添加时间」排序稳定 */
export function migrateTxtFileListAddedAt(items: TxtFileItem[]): TxtFileItem[] {
  let i = 0;
  return items.map((item) => {
    if (typeof item.addedAt === "number" && Number.isFinite(item.addedAt)) {
      return item;
    }
    const addedAt = ADDED_AT_MIGRATION_BASE + i;
    i += 1;
    return { ...item, addedAt };
  });
}

/** 侧栏文件列表：合并后按路径去重；新路径写入 `addedAt`，已有路径保留原 `addedAt`；最后按文件名排序 */
export function mergeTxtFileLists(
  existing: TxtFileItem[],
  incoming: TxtFileItem[],
): TxtFileItem[] {
  const now = Date.now();
  const byPath = new Map<string, TxtFileItem>();
  for (const item of existing) {
    const n = normalizeTxtFileItem(item);
    byPath.set(n.path, {
      ...n,
      addedAt:
        typeof item.addedAt === "number" && Number.isFinite(item.addedAt)
          ? item.addedAt
          : n.addedAt,
    });
  }
  for (const item of incoming) {
    const n = normalizeTxtFileItem(item);
    const prev = byPath.get(n.path);
    if (prev) {
      const incomingCat =
        typeof n.category === "string" && n.category.trim()
          ? n.category.trim()
          : undefined;
      byPath.set(n.path, {
        ...n,
        name: prev.name,
        addedAt: prev.addedAt,
        category: incomingCat ?? prev.category,
      });
    } else {
      byPath.set(n.path, {
        ...n,
        addedAt: now,
      });
    }
  }
  return Array.from(byPath.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}

/**
 * 「分类管理」保存后：按行 key 对侧栏文件列表上的分类名改名 / 删除已移除分类。
 */
export function syncTxtFilesCategoriesAfterCatalogEdit(
  files: TxtFileItem[],
  initial: CategoryEditorRow[],
  draft: CategoryEditorRow[],
): TxtFileItem[] {
  let next = files.map((f) => ({ ...f }));
  const im = new Map(initial.map((r) => [r.key, r]));
  const dm = new Map(draft.map((r) => [r.key, r]));
  for (const [k, d] of dm) {
    const prevRow = im.get(k);
    if (prevRow && prevRow.name.trim() !== d.name.trim()) {
      const from = prevRow.name.trim();
      const to = d.name.trim();
      next = next.map((f) => {
        const c = (f.category ?? "").trim();
        return c === from ? { ...f, category: to } : f;
      });
    }
  }
  for (const [k, p] of im) {
    if (!dm.has(k)) {
      const name = p.name.trim();
      next = next.map((f) => {
        const c = (f.category ?? "").trim();
        return c === name ? { ...f, category: undefined } : f;
      });
    }
  }
  return next;
}

export async function readTxtDirectoryFromDialog(
  colorTxt: ColorTxtShellApi | undefined,
): Promise<
  | { ok: true; dirPaths: string[]; files: TxtFileItem[] }
  | { ok: false; reason: "missingApi" | "cancelled" }
> {
  if (
    !colorTxt ||
    typeof colorTxt.showOpenDialog !== "function" ||
    typeof colorTxt.listTxtFilesInDirectory !== "function"
  ) {
    return { ok: false, reason: "missingApi" };
  }

  const r = await colorTxt.showOpenDialog({
    properties: ["openDirectory", "multiSelections"],
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { ok: false, reason: "cancelled" };
  }

  const dirPaths = r.filePaths;
  const byPath = new Map<string, TxtFileItem>();
  for (const dirPath of dirPaths) {
    const batch = await colorTxt.listTxtFilesInDirectory(dirPath);
    for (const f of batch.files) {
      byPath.set(f.path, f);
    }
  }
  const files = Array.from(byPath.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hans-CN"),
  );

  return {
    ok: true,
    dirPaths,
    files: files.map(normalizeTxtFileItem),
  };
}
