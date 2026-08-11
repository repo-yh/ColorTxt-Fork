/** 选区工具条「查找」应用目标 */
export type SelectionToolbarFindTarget = "findBar" | "sidebarSearch";

/** 选区浮动工具条上可由用户配置的项 */
export type SelectionToolbarButtons = {
  copy: boolean;
  find: boolean;
  askAi: boolean;
  /** 「查找」按钮：打开 Monaco 查找栏，或填入侧栏全文搜索 */
  findTarget: SelectionToolbarFindTarget;
};

export const SELECTION_TOOLBAR_FIND_TARGET_OPTIONS: {
  id: SelectionToolbarFindTarget;
  label: string;
}[] = [
  { id: "findBar", label: "查找栏" },
  { id: "sidebarSearch", label: "全文搜索" },
];

export const defaultSelectionToolbarFindTarget: SelectionToolbarFindTarget =
  "findBar";

export const defaultSelectionToolbarButtons: SelectionToolbarButtons = {
  copy: true,
  find: false,
  askAi: true,
  findTarget: defaultSelectionToolbarFindTarget,
};

export function isSelectionToolbarFindTarget(
  v: unknown,
): v is SelectionToolbarFindTarget {
  return v === "findBar" || v === "sidebarSearch";
}

export function mergeSelectionToolbarButtons(
  partial: Partial<SelectionToolbarButtons> | null | undefined,
): SelectionToolbarButtons {
  return {
    copy:
      typeof partial?.copy === "boolean"
        ? partial.copy
        : defaultSelectionToolbarButtons.copy,
    find:
      typeof partial?.find === "boolean"
        ? partial.find
        : defaultSelectionToolbarButtons.find,
    askAi:
      typeof partial?.askAi === "boolean"
        ? partial.askAi
        : defaultSelectionToolbarButtons.askAi,
    findTarget: isSelectionToolbarFindTarget(partial?.findTarget)
      ? partial.findTarget
      : defaultSelectionToolbarButtons.findTarget,
  };
}
