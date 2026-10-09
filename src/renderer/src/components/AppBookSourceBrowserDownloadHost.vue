<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useFindBookSettings } from "../bookSource/composables/useFindBookSettings";

const emit = defineEmits<{
  (
    e: "downloadImported",
    payload: { filePath: string; size?: number; bookName?: string },
  ): void;
}>();

const findBookSettings = useFindBookSettings();

let offDownload: (() => void) | null = null;

onMounted(() => {
  offDownload = window.colorTxt.onBookSourceBrowserDownloadEvent((ev) => {
    void handleBrowserDownload(ev);
  });
});

onUnmounted(() => {
  offDownload?.();
  offDownload = null;
});

/** 书源浏览器附件下载拦截 → 按找书下载设置下载并加入主界面文件列表（提醒注入浏览器窗口，由主进程处理） */
async function handleBrowserDownload(ev: {
  url: string;
  filename?: string;
  referer?: string;
}) {
  const url = ev.url?.trim();
  if (!url) return;
  try {
    const r = await window.colorTxt.bookSourceBrowserDownload({
      url,
      filename: ev.filename,
      referer: ev.referer,
      outputDir: findBookSettings.effectiveDownloadDir.value,
    });
    if (!r.ok || !r.filePath) return;
    // 加入主界面运行时文件列表（父组件 importPathsIntoFileList：内存+持久化+切侧栏）
    if (findBookSettings.downloadAddToMainFileList.value) {
      emit("downloadImported", {
        filePath: r.filePath,
        size: r.size,
        bookName: ev.bookName?.trim() || undefined,
      });
    }
    switch (findBookSettings.downloadAfterAction.value) {
      case "openMain":
        await window.colorTxt.openFileInMainWindow(r.filePath);
        return;
      case "openNewWindow":
        window.colorTxt.openFileInNewWindow(r.filePath);
        return;
    }
  } catch {
    /* 失败提醒已由主进程注入浏览器窗口 */
  }
}
</script>

<template>
  <span hidden aria-hidden="true"></span>
</template>
