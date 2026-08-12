<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch } from "vue";
import { icons } from "../icons";
import { dictionaryDisplayName } from "../constants/dictionarySettings";
import LoadingDotsBounce from "./LoadingDotsBounce.vue";
import { registerModal } from "../utils/modalStack";
import type { DictionarySettings } from "@shared/dictionaryTypes";
import type { DictionaryLookupResultItem } from "@shared/dictionaryTypes";

/** IPC 只能传可结构化克隆的纯对象；Vue reactive Proxy 会触发 An object could not be cloned */
function plainSettingsForIpc(settings: DictionarySettings): DictionarySettings {
  return JSON.parse(JSON.stringify(toRaw(settings))) as DictionarySettings;
}

type DictSlot = {
  providerId: string;
  title: string;
  status: "pending" | "ready";
  result?: DictionaryLookupResultItem;
  collapsed: boolean;
};

const props = defineProps<{
  open: boolean;
  word: string;
  settings: DictionarySettings;
  floatCenterX: number;
  floatRootTop: number;
  openDownward: boolean;
  maxHeight: number;
}>();

const emit = defineEmits<{
  close: [];
  openDictionaryManage: [];
}>();

const panelZIndex = ref(6000);
const popupPanelRef = ref<HTMLElement | null>(null);
const popupBodyRef = ref<HTMLElement | null>(null);
const queryInputRef = ref<HTMLInputElement | null>(null);
let modalUnregister: (() => void) | null = null;
let removeOutsideListener: (() => void) | null = null;

const queryWord = ref("");
const slots = ref<DictSlot[]>([]);
const errorMessage = ref("");
const lookupDone = ref(false);
let lookupSeq = 0;

const hasVisibleSlots = computed(() => slots.value.length > 0);

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

function splitProviderIds(settings: DictionarySettings): {
  localIds: string[];
  networkIds: string[];
  order: string[];
} {
  const order = (settings.providerOrder ?? []).filter(
    (id) => settings.providerEnabled?.[id] !== false,
  );
  const localSet = new Set(
    (settings.importedDictionaries ?? []).map((d) => d.id),
  );
  const localIds = order.filter((id) => localSet.has(id));
  const networkIds = order.filter((id) => !localSet.has(id));
  return { localIds, networkIds, order };
}

function settleProvider(
  seq: number,
  providerId: string,
  item: DictionaryLookupResultItem | null,
) {
  if (seq !== lookupSeq) return;
  const valid = !!(item && item.content?.trim());
  if (!valid) {
    slots.value = slots.value.filter((s) => s.providerId !== providerId);
    return;
  }
  slots.value = slots.value.map((s) =>
    s.providerId === providerId
      ? {
          ...s,
          title: item!.title || s.title,
          status: "ready" as const,
          result: item!,
        }
      : s,
  );
}

async function lookupOne(
  word: string,
  plain: DictionarySettings,
  providerId: string,
): Promise<DictionaryLookupResultItem | null> {
  const res = await window.colorTxt.dictionaryLookup({
    word,
    settings: { ...plain, providerOrder: [providerId] },
  });
  if (!res.ok) return null;
  return res.results[0] ?? null;
}

async function runLookup(wordOverride?: string) {
  const word = (wordOverride ?? queryWord.value).trim();
  queryWord.value = word;
  if (popupBodyRef.value) popupBodyRef.value.scrollTop = 0;
  if (!word) {
    slots.value = [];
    errorMessage.value = "请输入要查询的词";
    lookupDone.value = true;
    return;
  }

  const seq = ++lookupSeq;
  errorMessage.value = "";
  lookupDone.value = false;

  const plain = plainSettingsForIpc(props.settings);
  const { localIds, networkIds, order } = splitProviderIds(plain);

  if (!order.length) {
    slots.value = [];
    errorMessage.value = "没有启用的词典";
    lookupDone.value = true;
    return;
  }

  // 一开始就列出所有启用词典，均为「查询中」
  slots.value = order.map((id) => ({
    providerId: id,
    title: dictionaryDisplayName(plain, id),
    status: "pending" as const,
    collapsed: false,
  }));

  try {
    const networkJobs = networkIds.map(async (id) => {
      try {
        const item = await lookupOne(word, plain, id);
        settleProvider(seq, id, item);
      } catch {
        settleProvider(seq, id, null);
      }
    });

    for (const id of localIds) {
      if (seq !== lookupSeq) return;
      try {
        const item = await lookupOne(word, plain, id);
        settleProvider(seq, id, item);
      } catch {
        settleProvider(seq, id, null);
      }
    }

    await Promise.all(networkJobs);
    if (seq !== lookupSeq) return;

    if (!slots.value.length) {
      errorMessage.value = "未找到释义";
    }
  } catch (e) {
    if (seq !== lookupSeq) return;
    if (!slots.value.some((s) => s.status === "ready")) {
      slots.value = [];
      errorMessage.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (seq === lookupSeq) lookupDone.value = true;
  }
}

function onQueryClick() {
  void runLookup();
}

function onQueryKeydown(ev: KeyboardEvent) {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  void runLookup();
}

function toggleCard(providerId: string) {
  slots.value = slots.value.map((s) =>
    s.providerId === providerId ? { ...s, collapsed: !s.collapsed } : s,
  );
}

function onOpenManage() {
  emit("openDictionaryManage");
}

function onDocPointerDown(ev: PointerEvent) {
  if (!props.open) return;
  const t = ev.target;
  if (!(t instanceof Node)) return;
  if (popupPanelRef.value?.contains(t)) return;
  // 词典管理等 AppModal 在浮层之上，点它们不关查词面板
  if (
    t instanceof Element &&
    t.closest(".appModalBackdrop, .appModalPanel")
  ) {
    return;
  }
  emit("close");
}

function bindOutsideClose() {
  removeOutsideListener?.();
  document.addEventListener("pointerdown", onDocPointerDown, true);
  removeOutsideListener = () =>
    document.removeEventListener("pointerdown", onDocPointerDown, true);
}

function unbindOutsideClose() {
  removeOutsideListener?.();
  removeOutsideListener = null;
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      queryWord.value = props.word.trim();
      const reg = registerModal({
        close: () => emit("close"),
        getEscClosable: () => true,
        setZIndex: (z) => {
          panelZIndex.value = z;
        },
      });
      panelZIndex.value = reg.zIndex;
      modalUnregister = reg.unregister;
      bindOutsideClose();
      await nextTick();
      queryInputRef.value?.focus();
      queryInputRef.value?.select();
      void runLookup(queryWord.value);
    } else {
      modalUnregister?.();
      modalUnregister = null;
      unbindOutsideClose();
      lookupSeq += 1;
      lookupDone.value = true;
    }
  },
);

watch(
  () => [props.open, props.word] as const,
  ([open, word], prev) => {
    if (!open) return;
    if (!prev || prev[0] !== true) return;
    if (prev[1] === word) return;
    queryWord.value = word.trim();
    void runLookup(queryWord.value);
  },
);

onBeforeUnmount(() => {
  modalUnregister?.();
  unbindOutsideClose();
});
</script>

<template>
  <div
    v-show="open"
    class="dictPopupRoot"
    :class="{ dictPopupRootDown: openDownward }"
    :style="{
      top: `${floatRootTop}px`,
      left: `${floatCenterX}px`,
      zIndex: panelZIndex,
    }"
  >
    <div
      ref="popupPanelRef"
      class="dictPopup"
      role="dialog"
      aria-label="词典查词"
      :style="{ maxHeight: `${maxHeight}px` }"
    >
      <div class="dictPopupHeader">
        <div class="dictPopupQueryRow">
          <div class="dictPopupQueryField">
            <input
              ref="queryInputRef"
              v-model="queryWord"
              class="dictPopupQueryInput"
              type="search"
              aria-label="查询关键词"
              placeholder="输入词语"
              @keydown="onQueryKeydown"
            />
          </div>
          <button
            type="button"
            class="btn primary dictPopupQueryBtn"
            @click="onQueryClick"
          >
            查询
          </button>
        </div>
        <button
          type="button"
          class="dictPopupIconBtn"
          aria-label="词典管理"
          title="词典管理"
          @click="onOpenManage"
        >
          <span aria-hidden="true" v-html="icons.setting"></span>
        </button>
      </div>
      <div ref="popupBodyRef" class="dictPopupBody">
        <div
          v-if="!hasVisibleSlots && lookupDone"
          class="dictPopupStatus dictPopupStatus--muted"
        >
          {{ errorMessage || "未找到释义" }}
        </div>
        <section
          v-for="slot in slots"
          :key="slot.providerId"
          class="dictCard"
        >
          <button
            type="button"
            class="dictCardToggle"
            :aria-expanded="!slot.collapsed"
            @click="toggleCard(slot.providerId)"
          >
            <span class="dictCardTitle">{{ slot.title }}</span>
            <span
              class="dictCardChevron"
              :class="{ dictCardChevronCollapsed: slot.collapsed }"
              aria-hidden="true"
              v-html="icons.foldChevron"
            ></span>
          </button>
          <div v-show="!slot.collapsed" class="dictCardBody">
            <div
              v-if="slot.status === 'pending'"
              class="dictCardPending"
            >
              查询中<LoadingDotsBounce />
            </div>
            <template v-else-if="slot.result">
              <div
                v-if="slot.result.contentFormat === 'html'"
                class="dictCardContent dictCardContent--html"
                v-html="sanitizeHtml(slot.result.content)"
              ></div>
              <pre
                v-else
                class="dictCardContent dictCardContent--text"
              >{{ slot.result.content }}</pre>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dictPopupRoot {
  position: fixed;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  transform: translate(-50%, -100%);
  max-width: min(400px, calc(100vw - 24px));
}

.dictPopupRootDown {
  transform: translate(-50%, 0);
}

.dictPopup {
  pointer-events: auto;
  width: 360px;
  max-width: min(400px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  box-shadow: 0 8px 28px color-mix(in srgb, #000 22%, transparent);
  overflow: hidden;
}

.dictPopupHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.dictPopupQueryRow {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
}

.dictPopupQueryField {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
  border-right: none;
  border-radius: 999px 0 0 999px;
  background: var(--input-bg);
  padding: 6px 10px;
  transition: border-color 0.12s ease;
}

.dictPopupQueryField:focus-within {
  border-color: var(--accent);
}

.dictPopupQueryInput {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  width: 0;
  height: auto;
  border: none;
  border-radius: 0;
  outline: none;
  background: transparent;
  padding: 2px 0;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  line-height: inherit;
}

.dictPopupQueryBtn {
  flex-shrink: 0;
  border-radius: 0 999px 999px 0;
  padding: 7px 16px;
  white-space: nowrap;
  font-size: 14px;
  border: none;
}

.dictPopupIconBtn {
  flex-shrink: 0;
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.dictPopupIconBtn:hover {
  background: var(--icon-btn-bg-hover);
}

.dictPopupIconBtn :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}

.dictPopupIconBtn :deep(svg path) {
  fill: currentColor;
}

.dictPopupBody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dictPopupStatus {
  margin: 8px 0;
  font-size: 13px;
  color: var(--fg);
}

.dictPopupStatus--muted {
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 62%, transparent));
}

.dictCard {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}

.dictCard:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.dictCardToggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 4px 6px;
  box-sizing: border-box;
  border: none;
  border-radius: 6px;
  background: var(--icon-btn-bg-hover);
  cursor: pointer;
  text-align: left;
  color: inherit;
  transition: background 0.12s ease;
  user-select: none;
}

.dictCardToggle:hover .dictCardTitle,
.dictCardToggle:hover .dictCardChevron {
  color: var(--fg);
}

.dictCardTitle {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 70%, transparent));
  transition: color 0.12s ease;
}

.dictCardChevron {
  flex-shrink: 0;
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 62%, transparent));
  transform: rotate(180deg);
  transition: transform 0.15s ease, color 0.12s ease;
}

.dictCardChevronCollapsed {
  transform: rotate(0deg);
}

.dictCardChevron :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.dictCardChevron :deep(svg path) {
  fill: currentColor;
}

.dictCardBody {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dictCardPending {
  display: inline-flex;
  align-items: center;
  gap: 0.15em;
  font-size: 13px;
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 62%, transparent));
}

.dictCardContent {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
}

.dictCardContent--html {
  white-space: normal;
}

.dictCardContent--html :deep(a) {
  color: var(--accent, #3b82f6);
}

.dictCardContent--html :deep(img) {
  max-width: 100%;
  height: auto;
}

.dictCardContent--html :deep(.dictZhWord) {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}

.dictCardContent--html :deep(.dictZhPinyin) {
  margin: 2px 0 0;
  font-size: 13px;
  font-style: italic;
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 70%, transparent));
}

.dictCardContent--html :deep(.dictZhLang) {
  margin: 2px 0 8px;
  font-size: 12px;
  font-style: italic;
  color: var(--muted-fg, color-mix(in srgb, var(--fg) 62%, transparent));
}

.dictCardContent--html :deep(.dictWtPos) {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}

.dictCardContent--html :deep(.dictZhDefs) {
  margin: 0 0 10px;
  padding-left: 1.25em;
}

.dictCardContent--html :deep(.dictZhDefs:last-child) {
  margin-bottom: 0;
}

.dictCardContent--html :deep(.dictZhDefs li) {
  margin: 0.2em 0;
}

.dictCardContent--html :deep(.dictWikiTitle) {
  margin: 0 0 10px;
  padding: 10px 12px;
  border-radius: 6px;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  background: color-mix(in srgb, #000 45%, var(--fg) 12%);
  min-height: 48px;
}

.dictCardContent--html :deep(.dictWikiDesc) {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.9;
}

.dictCardContent--html :deep(.dictWikiExtract) {
  font-size: 13px;
  line-height: 1.45;
}

.dictCardContent--html :deep(.dictWikiExtract p) {
  margin: 0;
}

.dictCardContent--html :deep(.dictWikiExtract b),
.dictCardContent--html :deep(.dictWikiExtract strong) {
  font-weight: 700;
}

.dictCardContent--text {
  font-family: inherit;
}
</style>
