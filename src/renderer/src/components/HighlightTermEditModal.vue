<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { icons } from "../icons";
import { useAnchoredAppShellMenu } from "../composables/useAnchoredAppShellMenu";
import { normalizeHighlightGroup } from "../utils/highlightWords";
import type { HighlightWord } from "../stores/fileMetaStore";
import AppModal from "./AppModal.vue";

const HL_SWATCH_SIZE = 26;
const HL_SWATCH_GAP = 8;
const HL_PICKER_PAD = 10;
const HL_PICKER_COLS = 5;
const HIGHLIGHT_COLOR_PICKER_W =
  HL_PICKER_PAD * 2 +
  HL_PICKER_COLS * HL_SWATCH_SIZE +
  (HL_PICKER_COLS - 1) * HL_SWATCH_GAP;
/** 须高于 AppModal（6000+），与 AppShellMenuTeleport 默认一致 */
const HIGHLIGHT_COLOR_PICKER_Z = 7200;

export type HighlightTermEditCommit = {
  mode: "add" | "edit";
  scope: "global" | "book";
  colorIndex: number;
  terms: HighlightWord[];
  replaceStoredTerms?: string[];
};

const open = defineModel<boolean>("open", { default: false });

const props = withDefaults(
  defineProps<{
    mode: "add" | "edit";
    scope?: "global" | "book";
    initialTerms?: HighlightWord[];
    initialColorIndex?: number;
    highlightColors: readonly string[];
    highlightPreviewBg?: string;
    monacoFontFamily?: string;
  }>(),
  {
    scope: "book",
    initialTerms: () => [],
    initialColorIndex: 0,
    highlightPreviewBg: "var(--reader-bg, var(--bg))",
    monacoFontFamily: "",
  },
);

const emit = defineEmits<{
  commit: [payload: HighlightTermEditCommit];
}>();

const draftTerms = ref<HighlightWord[]>([]);
const draftColorIndex = ref(0);
const draftInput = ref("");
const isRegexMode = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const tagInputRef = ref<HTMLElement | null>(null);
const colorBtnRef = ref<HTMLButtonElement | null>(null);
const dragIndex = ref<number | null>(null);

function onTagDragStart(i: number) {
  dragIndex.value = i;
}
function onTagDragOver(i: number, ev: DragEvent) {
  ev.preventDefault();
}
function onTagDrop(i: number) {
  if (dragIndex.value == null || dragIndex.value === i) return;
  const arr = draftTerms.value.slice();
  const [item] = arr.splice(dragIndex.value, 1);
  arr.splice(i, 0, item!);
  draftTerms.value = arr;
  dragIndex.value = null;
}
function onTagDragEnd() {
  dragIndex.value = null;
}

const title = computed(() =>
  props.mode === "add" ? "添加高亮词" : "编辑高亮词",
);

const draftColor = computed(() => {
  const colors = props.highlightColors;
  const i = draftColorIndex.value;
  if (i >= 0 && i < colors.length) return colors[i]!;
  return "var(--fg)";
});

const canConfirm = computed(() => {
  if (props.mode === "add") {
    return normalizeHighlightGroup(draftTerms.value) != null;
  }
  return true;
});

const colorPicker = useAnchoredAppShellMenu({
  anchor: colorBtnRef,
  placement: "below-center",
  widthPx: HIGHLIGHT_COLOR_PICKER_W,
  gap: 6,
  zIndex: HIGHLIGHT_COLOR_PICKER_Z,
});
const {
  open: colorPickerOpen,
  left: colorPickerLeft,
  top: colorPickerTop,
  panelRef: colorPickerPanelRef,
  closeMenu: closeColorPicker,
  toggleMenu: toggleColorPicker,
} = colorPicker;

function bindColorPickerPanel(el: Element | { $el?: unknown } | null) {
  const node =
    el instanceof HTMLElement
      ? el
      : el &&
          typeof el === "object" &&
          "$el" in el &&
          el.$el instanceof HTMLElement
        ? el.$el
        : null;
  colorPickerPanelRef.value = node;
}

watch(open, (v) => {
  if (!v) {
    closeColorPicker();
    return;
  }
  draftTerms.value = props.initialTerms.map((w) => ({ text: w.text, isRegex: w.isRegex ?? false }));
  isRegexMode.value = false;
  const maxIdx = Math.max(0, props.highlightColors.length - 1);
  draftColorIndex.value = Math.min(
    Math.max(0, Math.floor(props.initialColorIndex)),
    maxIdx,
  );
  draftInput.value = "";
  void nextTick(() => inputEl.value?.focus());
});

function tryCommitInput() {
  const t = draftInput.value.trim();
  if (!t) return;
  if (!draftTerms.value.some((d) => d.text === t)) {
    draftTerms.value = [...draftTerms.value, { text: t, isRegex: isRegexMode.value }];
  }
  draftInput.value = "";
}

function removeTag(index: number) {
  draftTerms.value = draftTerms.value.filter((_, i) => i !== index);
}

function onInputKeydown(ev: KeyboardEvent) {
  if (ev.isComposing) return;
  if (ev.key === "Enter" || ev.key === ",") {
    ev.preventDefault();
    tryCommitInput();
    return;
  }
  if (ev.key === "Backspace" && !draftInput.value && draftTerms.value.length) {
    ev.preventDefault();
    draftTerms.value = draftTerms.value.slice(0, -1);
  }
}

function onInputBlur() {
  tryCommitInput();
}

async function onColorBtnClick(ev: MouseEvent) {
  ev.preventDefault();
  ev.stopPropagation();
  await toggleColorPicker();
}

function onPickColor(i: number) {
  if (i < 0 || i >= props.highlightColors.length) return;
  draftColorIndex.value = i;
}

function close() {
  open.value = false;
}

function onConfirm() {
  if (!canConfirm.value) return;
  const terms = normalizeHighlightGroup(draftTerms.value) ?? [];
  if (props.mode === "add" && terms.length === 0) return;
  emit("commit", {
    mode: props.mode,
    scope: props.mode === "add" ? "book" : props.scope,
    colorIndex: draftColorIndex.value,
    terms,
    replaceStoredTerms:
      props.mode === "edit" ? props.initialTerms.map((w) => w.text) : undefined,
  });
  close();
}

function focusInput() {
  inputEl.value?.focus();
}
</script>

<template>
  <AppModal
    v-model="open"
    :title="title"
    max-width="480px"
    :mask-closable="false"
    :body-scroll="false"
  >
    <div class="hlEditRow">
      <div
        ref="tagInputRef"
        class="hlTagInput"
        :style="{ fontFamily: monacoFontFamily || undefined }"
        @click="focusInput"
      >
        <span
          v-for="(term, i) in draftTerms"
          :key="i"
          class="hlTag"
          :style="{
            backgroundColor: highlightPreviewBg,
            color: draftColor,
          }"
          :title="draftTerms.length > 1 ? '拖动调整顺序' : undefined"
          draggable="true"
          @dragstart="onTagDragStart(i)"
          @dragover="onTagDragOver(i, $event)"
          @drop="onTagDrop(i)"
          @dragend="onTagDragEnd"
        >
          <span class="hlTagText">{{ term.text }}</span>
          <button
            type="button"
            class="hlTagRemove"
            :style="{ color: draftColor }"
            title="移除"
            aria-label="移除"
            @click.stop="removeTag(i)"
          >
            <span class="hlTagRemoveIcon" aria-hidden="true" v-html="icons.close" />
          </button>
        </span>
        <input
          ref="inputEl"
          v-model="draftInput"
          class="hlTagField"
          type="text"
          :placeholder="draftTerms.length ? '' : '输入高亮词，回车添加'"
          @keydown="onInputKeydown"
          @blur="onInputBlur"
        />
      </div>
      <button
        type="button"
        class="hlEditRegexBtn"
        :class="{ 'hlEditRegexBtn--active': isRegexMode }"
        :title="isRegexMode ? '正则模式已开启' : '正则模式'"
        :aria-label="isRegexMode ? '关闭正则模式' : '开启正则模式'"
        :aria-pressed="isRegexMode ? 'true' : 'false'"
        @click="isRegexMode = !isRegexMode"
      >
        <span
          class="hlEditRegexIcon"
          aria-hidden="true"
          v-html="isRegexMode ? icons.reFill : icons.re"
        />
      </button>
      <button
        ref="colorBtnRef"
        type="button"
        class="hlEditColorBtn"
        title="高亮色"
        aria-label="高亮色"
        :aria-expanded="colorPickerOpen ? 'true' : 'false'"
        @click="onColorBtnClick"
      >
        <span
          class="hlEditColorIcon"
          aria-hidden="true"
          v-html="icons.palette"
        />
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="colorPickerOpen"
        :ref="bindColorPickerPanel"
        class="hlEditColorPicker"
        data-fullscreen-sidebar-float
        role="dialog"
        aria-label="选择高亮色"
        :style="{
          left: `${colorPickerLeft}px`,
          top: `${colorPickerTop}px`,
          zIndex: HIGHLIGHT_COLOR_PICKER_Z,
          width: `${HIGHLIGHT_COLOR_PICKER_W}px`,
        }"
        @click.stop
      >
        <div class="hlEditSwatchRow">
          <button
            v-for="(c, i) in highlightColors"
            :key="i"
            type="button"
            class="hlEditSwatch"
            :class="{ 'hlEditSwatch--selected': draftColorIndex === i }"
            :style="{ backgroundColor: c }"
            :aria-label="`使用高亮色 ${i + 1}`"
            :title="`高亮色 ${i + 1}`"
            :aria-pressed="draftColorIndex === i ? 'true' : 'false'"
            @click="onPickColor(i)"
          />
        </div>
      </div>
    </Teleport>

    <template #footer>
      <div class="hlEditFooter">
        <button class="btn" type="button" size="large" @click="close">
          取消
        </button>
        <button
          class="btn primary"
          type="button"
          size="large"
          :disabled="!canConfirm"
          @click="onConfirm"
        >
          确定
        </button>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.hlEditRow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
}

.hlTagInput {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 36px;
  max-height: min(52vh, 420px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: text;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
}

.hlTagInput:focus-within {
  border-color: var(--accent, var(--primary));
}

.hlTag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 2px 4px 2px 8px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1.3;
  box-sizing: border-box;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.hlTag:active {
  cursor: grabbing;
}

.hlTag.sortableRowGhost {
  opacity: 0.35;
  outline: 1px dashed var(--accent, var(--primary));
  outline-offset: 1px;
}

.hlTag.sortableRowChosen {
  opacity: 0.92;
}

.hlTag.sortableRowDrag {
  opacity: 0.88;
  box-shadow: 0 4px 12px color-mix(in srgb, #000 18%, transparent);
  cursor: grabbing;
}

.hlTagText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hlTagRemove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.7;
}

.hlTagRemove:hover {
  opacity: 1;
}

.hlTagRemoveIcon {
  display: inline-flex;
  width: 10px;
  height: 10px;
}

.hlTagRemoveIcon :deep(svg) {
  width: 10px;
  height: 10px;
  display: block;
}

.hlTagRemoveIcon :deep(svg path) {
  fill: currentColor;
}

.hlTagField {
  flex: 1 1 80px;
  min-width: 80px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.4;
  padding: 2px 0;
  font-family: inherit;
}

.hlTagField::placeholder {
  font-family: var(--font-family) !important;
}

.hlEditColorBtn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
}

.hlEditColorBtn:hover,
.hlEditColorBtn[aria-expanded="true"] {
  opacity: 1;
}

.hlEditColorIcon {
  display: inline-flex;
  width: 18px;
  height: 18px;
}

.hlEditColorIcon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}

.hlEditRegexBtn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.65;
  transition: opacity 0.15s, border-color 0.15s;
}

.hlEditRegexBtn:hover,
.hlEditRegexBtn--active {
  opacity: 1;
}

.hlEditRegexBtn--active {
  border-color: var(--accent, var(--primary));
  background: color-mix(in srgb, var(--accent, var(--primary)) 10%, var(--bg));
}

.hlEditRegexIcon {
  display: inline-flex;
  width: 18px;
  height: 18px;
}

.hlEditRegexIcon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}

.hlEditFooter {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  width: 100%;
}

.hlEditColorPicker {
  position: fixed;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 18%, transparent);
  box-sizing: border-box;
}

.hlEditSwatchRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: calc(5 * 26px + 4 * 8px);
}

.hlEditSwatch {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 2px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 50%;
  cursor: pointer;
  flex-shrink: 0;
}

.hlEditSwatch:hover {
  transform: scale(1.08);
}

.hlEditSwatch--selected {
  border-color: var(--bg);
  box-shadow: 0 0 0 2px var(--accent);
}
</style>
