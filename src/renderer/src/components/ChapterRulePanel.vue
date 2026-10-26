<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  generateChapterRuleId,
  previewChapterExamples,
  type ChapterMatchRule,
} from "../chapter";
import { icons } from "../icons";
import AppModal from "./AppModal.vue";
import IconButton from "./IconButton.vue";
import ChapterRuleEditDialog from "./ChapterRuleEditDialog.vue";
import type { ChapterRuleEditPayload } from "./ChapterRuleEditDialog.vue";
import {
  SORTABLE_ROW_HANDLE_CLASS,
  useSortableReorder,
} from "../composables/useSortableReorder";

const modelValue = defineModel<boolean>({ default: false });

const props = defineProps<{
  rules: ChapterMatchRule[];
  /** 本书专属规则 id 集合（只存 id；内容与顺序全部参照全局规则列表管理） */
  scopedRuleIds?: string[];
  errorText?: string;
}>();

const emit = defineEmits<{
  apply: [
    payload: {
      rules: ChapterMatchRule[];
      scopedRuleIds: string[];
    },
  ];
}>();

/** 开关三态：禁用 / 全局启用 / 仅当前书籍生效 */
type RuleSwitchState = "off" | "on" | "book";

const globalRules = ref<ChapterMatchRule[]>([]);
const scopedIds = ref<string[]>([]);

watch(
  () => [props.rules, props.scopedRuleIds, modelValue.value] as const,
  ([rules, ids, opened]) => {
    if (!opened) return;
    globalRules.value = rules.map((r) => ({
      ...r,
      examples: [...r.examples],
    }));
    scopedIds.value = [...(ids ?? [])];
  },
  { immediate: true, deep: true },
);

// sync：先于主 AppModal 的注销，先关掉子级编辑弹框，保证栈顶先出栈
watch(
  modelValue,
  (open) => {
    if (!open) showEditDialog.value = false;
  },
  { flush: "sync" },
);

const showEditDialog = ref(false);
const editDialogTitle = ref("编辑规则");
const editingRuleId = ref<string | null>(null);
const editBuiltinRuleId = ref<string | null>(null);
const editPatternDraft = ref("");
const editExamplesDraft = ref("");

const scopedIdSet = computed(() => new Set(scopedIds.value));

/**
 * 合并展示：同一条全局规则一行，本书态只是开关状态不同（合并时只切换
 * 开关状态）。顺序唯一来源是全局规则列表——按全局序展示，拖动/编辑都
 * 作用于全局条目。行状态由 rowState 判定（全局启用优先显示「开」）。
 */
const rowsWithPreview = computed(() =>
  globalRules.value.map((rule) => ({
    rule,
    preview: previewChapterExamples(rule.pattern, rule.examples),
  })),
);

const ruleTableBodyRef = ref<HTMLElement | null>(null);
const tableBodyScrollRef = ref<HTMLElement | null>(null);
const headScrollbarPadPx = ref(0);
const ruleCount = computed(() => rowsWithPreview.value.length);
let tableBodyScrollRo: ResizeObserver | null = null;

const ruleTableHeadPadStyle = computed(() =>
  headScrollbarPadPx.value > 0
    ? { paddingRight: `${headScrollbarPadPx.value}px` }
    : undefined,
);

function syncRuleTableHeadScrollbarPad() {
  const el = tableBodyScrollRef.value;
  headScrollbarPadPx.value = el ? el.offsetWidth - el.clientWidth : 0;
}

function teardownRuleTableBodyScrollRo() {
  tableBodyScrollRo?.disconnect();
  tableBodyScrollRo = null;
}

function ensureRuleTableBodyScrollRo() {
  teardownRuleTableBodyScrollRo();
  const el = tableBodyScrollRef.value;
  if (!el) {
    headScrollbarPadPx.value = 0;
    return;
  }
  syncRuleTableHeadScrollbarPad();
  if (typeof ResizeObserver === "undefined") return;
  tableBodyScrollRo = new ResizeObserver(syncRuleTableHeadScrollbarPad);
  tableBodyScrollRo.observe(el);
}

watch(modelValue, (open) => {
  if (open) void nextTick(ensureRuleTableBodyScrollRo);
  else {
    teardownRuleTableBodyScrollRo();
    headScrollbarPadPx.value = 0;
  }
});

watch(ruleCount, () => {
  void nextTick(syncRuleTableHeadScrollbarPad);
});

onBeforeUnmount(teardownRuleTableBodyScrollRo);

useSortableReorder({
  containerRef: ruleTableBodyRef,
  active: modelValue,
  itemCount: ruleCount,
  enabled: computed(() => rowsWithPreview.value.length > 1),
  onReorder(from, to) {
    moveRule(from, to);
  },
});

/** 编辑框：每行一条示例 */
function examplesToEditText(examples: string[]): string {
  return examples.join("\n");
}

function close() {
  modelValue.value = false;
}

function applyRules() {
  emit("apply", {
    rules: globalRules.value.map((r) => ({
      ...r,
      examples: [...r.examples],
    })),
    scopedRuleIds: [...scopedIds.value],
  });
}

function openEdit(rule: ChapterMatchRule) {
  // 内容与编辑全部参照全局条目管理（本书态只是开关状态不同）
  editingRuleId.value = rule.id;
  editBuiltinRuleId.value = rule.builtIn ? rule.id : null;
  editDialogTitle.value = rule.builtIn ? "编辑内置规则" : "编辑匹配规则";
  editPatternDraft.value = rule.pattern;
  editExamplesDraft.value = examplesToEditText(rule.examples);
  showEditDialog.value = true;
}

function openAdd() {
  editingRuleId.value = null;
  editBuiltinRuleId.value = null;
  editDialogTitle.value = "新增匹配规则";
  editPatternDraft.value = "";
  editExamplesDraft.value = "";
  showEditDialog.value = true;
}

function onEditSave(payload: ChapterRuleEditPayload) {
  if (editingRuleId.value === null) {
    globalRules.value.push({
      id: generateChapterRuleId(),
      pattern: payload.pattern,
      enabled: true,
      examples: payload.examples,
      builtIn: false,
    });
    return;
  }
  const idx = globalRules.value.findIndex((r) => r.id === editingRuleId.value);
  if (idx < 0) return;
  const prev = globalRules.value[idx]!;
  globalRules.value[idx] = {
    ...prev,
    pattern: payload.pattern,
    examples: payload.examples,
  };
}

function removeRule(rule: ChapterMatchRule) {
  if (rowState(rule) === "book") {
    // 本书态删除 = 取消本书专属（规则条目保留，回到全局禁用态显示）
    scopedIds.value = scopedIds.value.filter((id) => id !== rule.id);
    return;
  }
  if (rule.builtIn) return;
  globalRules.value = globalRules.value.filter((r) => r.id !== rule.id);
  scopedIds.value = scopedIds.value.filter((id) => id !== rule.id);
}

function setGlobalEnabled(id: string, enabled: boolean) {
  const idx = globalRules.value.findIndex((r) => r.id === id);
  if (idx < 0) return;
  globalRules.value[idx] = { ...globalRules.value[idx]!, enabled };
}

/**
 * 行状态判定：全局启用优先显示「开」——双真态（全局 enabled=true 且
 * id 在本书集合，由跨书操作产生）也显示「开」且不清 id；其他书籍把
 * 该规则切回关后，本书仍凭残留 id 自动回到「本书」态单独生效。
 */
function rowState(rule: ChapterMatchRule): RuleSwitchState {
  if (rule.enabled) return "on";
  return scopedIdSet.value.has(rule.id) ? "book" : "off";
}

const switchMeta: Record<
  RuleSwitchState,
  { label: string; cls: string; title: string }
> = {
  off: { label: "关", cls: "stateOff", title: "已禁用；点击后仅当前书籍生效" },
  on: { label: "开", cls: "stateOn", title: "全局启用；点击后禁用" },
  book: { label: "本书", cls: "stateBook", title: "仅当前书籍生效；点击后全局启用" },
};

/**
 * 三态循环：关 → 本书（仅当前书籍） → 全局开 → 关。
 * 切到「关」清两个状态（全局启用 + 本书 id）；切到「开」设置全局启用
 * 并清理本书 id；切到「本书」清理全局启用并设置本书 id。
 */
function cycleRuleState(rule: ChapterMatchRule) {
  const state = rowState(rule);
  if (state === "off") {
    setGlobalEnabled(rule.id, false);
    scopedIds.value = [...scopedIds.value, rule.id];
    return;
  }
  if (state === "book") {
    setGlobalEnabled(rule.id, true);
    scopedIds.value = scopedIds.value.filter((id) => id !== rule.id);
    return;
  }
  setGlobalEnabled(rule.id, false);
  scopedIds.value = scopedIds.value.filter((id) => id !== rule.id);
}

function moveRule(fromRow: number, toRow: number) {
  if (fromRow === toRow) return;
  // 拖拽改的是全局列表顺序（唯一顺序来源），本书专属行原位显示、跟随移动
  const rowsArr = rowsWithPreview.value;
  if (fromRow < 0 || fromRow >= rowsArr.length) return;
  const to = Math.max(0, Math.min(toRow, rowsArr.length - 1));
  const fromId = rowsArr[fromRow]?.rule.id;
  const toId = rowsArr[to]?.rule.id;
  if (!fromId || !toId) return;
  const all = globalRules.value;
  const fromAll = all.findIndex((r) => r.id === fromId);
  if (fromAll < 0) return;
  const next = [...all];
  const [item] = next.splice(fromAll, 1);
  if (!item) return;
  const insertAt = next.findIndex((r) => r.id === toId);
  next.splice(insertAt < 0 ? next.length : insertAt, 0, item);
  globalRules.value = next;
}
</script>

<template>
  <AppModal
    v-model="modelValue"
    title="章节匹配规则"
    max-width="850px"
    :mask-closable="false"
    :esc-closable="true"
  >
    <p class="desc">
      可启用多条规则，按顺序依次匹配；任一条匹配成功即视为章节标题。拖动操作列的「移动」图标调整优先级。开关三态：关（禁用）→ 本书（仅当前书籍生效，其他书籍中该规则保持禁用）→ 开（所有书籍生效）→ 关。
    </p>

    <div class="tableWrap">
      <div class="ruleTableHeadWrap" :style="ruleTableHeadPadStyle">
        <table class="ruleTable ruleTable--head">
        <colgroup>
          <col class="colCheck" />
          <col class="colRule" />
          <col class="colActions" />
        </colgroup>
        <thead>
          <tr>
            <th class="colCheck" scope="col" aria-label="启用"></th>
            <th class="colRule" scope="col">规则与示例</th>
            <th class="colActions" scope="col">操作</th>
          </tr>
        </thead>
        </table>
      </div>
      <div ref="tableBodyScrollRef" class="tableBodyScroll">
        <table class="ruleTable ruleTable--body">
          <colgroup>
            <col class="colCheck" />
            <col class="colRule" />
            <col class="colActions" />
          </colgroup>
          <tbody ref="ruleTableBodyRef">
            <tr v-for="item in rowsWithPreview" :key="item.rule.id">
              <td class="cellCheck">
                <button
                  class="triStateBtn"
                  :class="switchMeta[rowState(item.rule)].cls"
                  type="button"
                  :aria-label="`规则状态 ${item.rule.id}`"
                  :title="switchMeta[rowState(item.rule)].title"
                  @click="cycleRuleState(item.rule)"
                >
                  {{ switchMeta[rowState(item.rule)].label }}
                </button>
              </td>
              <td class="cellRule">
                <div class="rulePattern">
                  <span
                    v-if="rowState(item.rule) === 'book'"
                    class="scopedBadge"
                    >本书</span
                  >{{ item.rule.pattern }}
                </div>
                <div class="ruleExamples">
                  <template v-if="item.preview.kind === 'empty'"
                    >（无示例）</template
                  >
                  <span
                    v-else-if="item.preview.kind === 'error'"
                    class="ruleExamplesError"
                    >{{ item.preview.message }}</span
                  >
                  <div v-else class="ruleExamplesPreviewBody">
                    <span
                      v-for="(ex, i) in item.preview.items"
                      :key="i"
                      class="tag"
                      :class="{ success: ex.hit }"
                    >
                      {{ ex.text }}
                    </span>
                  </div>
                </div>
              </td>
              <td class="cellActions">
                <div class="cellActionsInner">
                  <IconButton
                    v-if="rowState(item.rule) !== 'book'"
                    :class="SORTABLE_ROW_HANDLE_CLASS"
                    :icon-html="icons.move"
                    aria-label="拖动排序"
                    title="拖动排序"
                    :disabled="rowsWithPreview.length <= 1"
                  />
                  <IconButton
                    :icon-html="icons.edit"
                    aria-label="编辑"
                    title="编辑"
                    @click="openEdit(item.rule)"
                  />
                  <IconButton
                    v-if="!item.rule.builtIn || rowState(item.rule) === 'book'"
                    danger
                    :icon-html="icons.remove"
                    :aria-label="
                      rowState(item.rule) === 'book' ? '移除本书专属' : '移除'
                    "
                    :title="
                      rowState(item.rule) === 'book' ? '移除本书专属' : '移除'
                    "
                    @click="removeRule(item.rule)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="errorText" class="errorText">{{ errorText }}</p>

    <template #footer>
      <div class="chapterRuleFooter">
        <button class="btn" type="button" size="large" @click="openAdd">
          添加匹配规则
        </button>
        <div class="chapterRuleFooterEnd">
          <button class="btn" type="button" size="large" @click="close">
            关闭
          </button>
          <button
            class="btn primary"
            type="button"
            size="large"
            @click="applyRules"
          >
            保存
          </button>
        </div>
      </div>
    </template>
  </AppModal>

  <ChapterRuleEditDialog
    v-model="showEditDialog"
    :title="editDialogTitle"
    :pattern="editPatternDraft"
    :examples-text="editExamplesDraft"
    :builtin-rule-id="editBuiltinRuleId"
    @save="onEditSave"
  />
</template>

<style scoped>
.desc {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}

.tableWrap {
  display: flex;
  flex-direction: column;
  max-height: min(50vh, 420px);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.ruleTableHeadWrap {
  flex-shrink: 0;
}

.tableBodyScroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.ruleTable {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}

.ruleTable col.colCheck {
  width: 44px;
}

.ruleTable col.colActions {
  width: 118px;
}

.ruleTable th,
.ruleTable td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.ruleTable--head th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 92%, var(--border));
}

.ruleTable--body tbody tr:last-child td {
  border-bottom: none;
}

.cellCheck {
  text-align: center;
}

.triStateBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  border: 1px solid var(--border);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  background: transparent;
  transition:
    background-color 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.triStateBtn.stateOff {
  color: var(--muted);
}

.triStateBtn.stateOn {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

.triStateBtn.stateBook {
  color: #fff;
  background: #d97706;
  border-color: #d97706;
}

.scopedBadge {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
  background: #d97706;
  vertical-align: 1px;
}

.rulePattern {
  font-size: 12px;
  line-height: 1.45;
  font-family: Consolas, "Courier New", monospace;
  color: var(--fg);
  word-break: break-all;
  white-space: pre-wrap;
}

.ruleExamples {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.45;
}

.ruleExamplesPreviewBody {
  min-width: 0;
  word-break: break-all;
  color: var(--info);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ruleExamplesError {
  color: var(--danger, #f56c6c);
}

.cellRule {
  min-width: 0;
}

.cellActions {
  vertical-align: middle;
  text-align: left;
}

.cellActionsInner {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
}

.errorText {
  margin: 10px 0 0;
  color: #e85d75;
  font-size: 12px;
}

.chapterRuleFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
}

.chapterRuleFooterEnd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

:deep(tr.sortableRowGhost) {
  opacity: 0.45;
}

:deep(tr.sortableRowChosen) {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

:deep(.sortableRowHandle) {
  cursor: grab;
}

:deep(.sortableRowHandle:active) {
  cursor: grabbing;
}
</style>
