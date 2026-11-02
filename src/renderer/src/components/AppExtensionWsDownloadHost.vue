<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { appToast } from "../services/appToast";
import { useFindBookSettings } from "../bookSource/composables/useFindBookSettings";

const emit = defineEmits<{
  (
    e: "downloadImported",
    payload: {
      filePath: string;
      size?: number;
      bookName?: string;
      defaultCategory?: string;
    },
  ): void;
}>();

const findBookSettings = useFindBookSettings();

let offDownload: (() => void) | null = null;

onMounted(() => {
  offDownload = window.colorTxt.extensionWs.onDownloadEvent((ev) => {
    void handleWsDownload(ev);
  });
});

onUnmounted(() => {
  offDownload?.();
  offDownload = null;
});

/** 扩展 WS 下载落盘事件（主进程已按找书下载设置目录落盘）→ 按书名替换/导入 + toast + 下载后动作 */
async function handleWsDownload(ev: {
  ok: boolean;
  taskId: string;
  filePath?: string;
  size?: number;
  filename?: string;
  bookName?: string;
  postUrl?: string;
  error?: string;
}) {
  const bookName = ev.bookName?.trim() || undefined;
  if (!ev.ok) {
    appToast(
      `扩展下载失败${bookName ? `（${bookName}）` : ""}：${ev.error ?? "未知错误"}`,
      { kind: "warning" },
    );
    return;
  }
  const filePath = ev.filePath?.trim();
  if (!filePath) return;
  appToast(
    `下载完成${bookName ? `：${bookName}` : ""}`,
    { kind: "success" },
  );
  // 加入主界面运行时文件列表（父组件 importPathsIntoFileList：内存+持久化+切侧栏）
  if (findBookSettings.downloadAddToMainFileList.value) {
    emit("downloadImported", {
      filePath,
      size: ev.size,
      bookName,
      defaultCategory: findBookSettings.downloadDefaultCategory.value,
    });
  }
  switch (findBookSettings.downloadAfterAction.value) {
    case "openMain":
      await window.colorTxt.openFileInMainWindow(filePath);
      return;
    case "openNewWindow":
      window.colorTxt.openFileInNewWindow(filePath);
      return;
  }
}
</script>

<template>
  <span hidden aria-hidden="true"></span>
</template>
