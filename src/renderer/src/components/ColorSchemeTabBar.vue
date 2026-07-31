<script setup lang="ts">
export type ColorSchemeTabId = "reader" | "highlight" | "lineation";

withDefaults(
  defineProps<{
    activeTab: ColorSchemeTabId;
    visibleTabs?: readonly ColorSchemeTabId[];
  }>(),
  {
    visibleTabs: () => ["reader", "highlight", "lineation"],
  },
);

const emit = defineEmits<{
  "update:activeTab": [value: ColorSchemeTabId];
}>();

const tabLabels: Record<ColorSchemeTabId, string> = {
  reader: "阅读器",
  highlight: "高亮色",
  lineation: "标注色",
};
</script>

<template>
  <div class="colorSchemeTabBar" role="tablist" aria-label="配色分类">
    <div class="tabs">
      <button
        v-for="tab in visibleTabs"
        :key="tab"
        type="button"
        role="tab"
        class="tabBtn"
        :class="{ active: activeTab === tab }"
        :aria-selected="activeTab === tab"
        @click="emit('update:activeTab', tab)"
      >
        {{ tabLabels[tab] }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.colorSchemeTabBar {
  flex-shrink: 0;
  margin-bottom: 0;
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tabBtn {
  box-sizing: border-box;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--tab-fg);
  font-size: 14px;
  padding: 8px 10px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
}

.tabBtn:hover {
  color: var(--tab-fg-hover);
  background: transparent;
}

.tabBtn.active {
  color: var(--tab-fg-active);
  background: transparent;
  border-bottom: 2px solid var(--tab-underline);
  font-weight: 600;
}
</style>
