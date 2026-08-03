<script setup lang="ts">
import { ref, watch } from "vue";
import AppModal from "./AppModal.vue";

const props = defineProps<{
  visible: boolean;
  detail: string;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  choose: [index: number];
}>();

const open = ref(false);

watch(
  () => props.visible,
  (v) => {
    open.value = v;
    choosing.value = false;
  },
);

const choosing = ref(false);

watch(open, (v) => {
  if (!v && !choosing.value) {
    emit("choose", -1);
    emit("update:visible", false);
  }
});

function onChoose(index: number) {
  choosing.value = true;
  emit("choose", index);
  open.value = false;
  emit("update:visible", false);
}
</script>

<template>
  <AppModal
    v-model="open"
    title="正在阅读书架书籍"
    max-width="400px"
    :mask-closable="true"
    :esc-closable="true"
    :show-close-button="true"
  >
    <div class="appDialogBody">
      <p class="appDialogMsg" style="white-space: pre-line">{{ detail }}</p>
    </div>
    <template #footer>
      <div class="appDialogModalFooter">
        <div class="appDialogModalFooterActions">
          <button type="button" class="btn primary" size="large" style="margin-right: 12px;" @click="onChoose(0)">替换文件</button>
          <button type="button" class="btn primary" size="large" @click="onChoose(1)">打开新文件</button>
        </div>
      </div>
    </template>
  </AppModal>
</template>
