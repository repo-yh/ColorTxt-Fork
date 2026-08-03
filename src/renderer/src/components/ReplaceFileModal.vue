<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AppModal from "../components/AppModal.vue";
import {
  collectFsPathsFromDataTransfer,
  dataTransferLikelyHasExternalFiles,
} from "../utils/dragDropFsPaths";
import { isPlainTextBookPath } from "../ebook/ebookFormat";
import { icons } from "../icons";

// ── Props & emits ──

const props = defineProps<{
  visible: boolean;
  oldFileName: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  confirm: [newPath: string, newSize: number];
}>();

// ── State ──

const loading = ref(false);
const error = ref("");
const dragOver = ref(false);

// ── Consts ──

const title = computed(() => `替换文件 — ${props.oldFileName}`);

// ── Watch ──

watch(
  () => props.visible,
  (v) => {
    if (v) resetState();
  },
);

// ── Methods ──

function resetState() {
  loading.value = false;
  error.value = "";
  dragOver.value = false;
}

function closeModal() {
  emit("update:visible", false);
}

async function handleFile(path: string) {
  error.value = "";
  if (!isPlainTextBookPath(path)) {
    error.value = "仅支持 .txt / .md 文件";
    return;
  }
  loading.value = true;
  try {
    const st = await window.colorTxt.stat(path);
    if (!st.isFile) {
      error.value = "不是一个文件";
      loading.value = false;
      return;
    }
    loading.value = false;
    emit("confirm", path, st.size);
    closeModal();
  } catch {
    error.value = "无法读取文件信息";
    loading.value = false;
  }
}

// ── Drag & drop ──

function onDragEnter(ev: DragEvent) {
  ev.preventDefault();
  if (dataTransferLikelyHasExternalFiles(ev.dataTransfer)) {
    dragOver.value = true;
  }
}

function onDragLeave(ev: DragEvent) {
  ev.preventDefault();
  dragOver.value = false;
}

function onDragOver(ev: DragEvent) {
  ev.preventDefault();
  if (dataTransferLikelyHasExternalFiles(ev.dataTransfer)) {
    dragOver.value = true;
  }
}

async function onDrop(ev: DragEvent) {
  ev.preventDefault();
  dragOver.value = false;
  const paths = collectFsPathsFromDataTransfer(ev.dataTransfer);
  if (paths.length > 0) {
    await handleFile(paths[0]!);
  }
}

// ── Browse ──

async function onBrowse() {
  const r = await window.colorTxt.showOpenDialog({
    title: "选择替换文件",
    filters: [
      { name: "文本文件", extensions: ["txt", "md"] },
    ],
    properties: ["openFile"],
  });
  if (r.canceled || r.filePaths.length === 0) return;
  await handleFile(r.filePaths[0]!);
}
</script>

<template>
  <AppModal
    :model-value="visible"
    :title="title"
    :max-width="'420px'"
    :mask-closable="true"
    :esc-closable="true"
    :show-close-button="true"
    @update:model-value="closeModal"
  >
    <div class="replace-file-body">
      <div
        class="drop-zone"
        :class="{ 'drop-zone--over': dragOver, 'drop-zone--loading': loading }"
        @dragenter="onDragEnter"
        @dragleave="onDragLeave"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        <span class="drop-zone-icon" v-html="icons.ebook" />
        <p class="drop-zone-text">{{ loading ? "正在读取…" : "拖放文件到此处" }}</p>
        <p v-if="!loading" class="drop-zone-sub">或点击下方按钮</p>
      </div>
      <p v-if="error" class="replace-error">{{ error }}</p>
      <div class="browse-row">
        <button class="btn-browse" :disabled="loading" @click="onBrowse">浏览文件</button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.replace-file-body {
  padding: 4px 0 0;
}

.drop-zone {
  border: 2px dashed var(--border);
  border-radius: 10px;
  padding: 36px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: default;
  transition:
    border-color 0.18s,
    background 0.18s;
}

.drop-zone--over {
  border-color: var(--accent);
  background: var(--hover);
}

.drop-zone--loading {
  opacity: 0.7;
}

.drop-zone-icon {
  color: var(--secondaryText);
  opacity: 0.6;
}

.drop-zone-icon :deep(svg) {
  width: 40px;
  height: 40px;
  display: block;
}

.drop-zone-icon :deep(svg path) {
  fill: currentColor;
}

.drop-zone-text {
  margin: 0;
  font-size: 15px;
  color: var(--text);
}

.drop-zone-sub {
  margin: 0;
  font-size: 13px;
  color: var(--secondaryText);
}

.replace-error {
  margin: 12px 0 0;
  color: var(--danger);
  font-size: 13px;
  text-align: center;
}

.browse-row {
  margin-top: 14px;
  display: flex;
  justify-content: center;
}

.btn-browse {
  padding: 8px 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.btn-browse:hover {
  background: var(--hover);
  border-color: var(--accent);
}

.btn-browse:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
