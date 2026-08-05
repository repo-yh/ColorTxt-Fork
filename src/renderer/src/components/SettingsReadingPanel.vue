<script setup lang="ts">
import RangeSlider from "./RangeSlider.vue";
import SwitchToggle from "./SwitchToggle.vue";
import NumericInput from "./NumericInput.vue";
import RadioGroup from "./RadioGroup.vue";
import AppCustomSelect, { type CustomSelectItem } from "./AppCustomSelect.vue";
import {
  CHAPTER_TITLE_BLANK_MODE_OPTIONS,
  chapterTitleBlankModeLabel,
  lineHeightMultipleStep,
  lineSpacingPxStep,
  letterSpacingPxStep,
  maxFontSize,
  maxFullscreenReaderWidthPercent,
  maxLineHeightMultipleForFontSize,
  maxLineSpacingPx,
  maxLetterSpacingPx,
  minFontSize,
  minFullscreenReaderWidthPercent,
  minLineHeightMultiple,
  minLineSpacingPx,
  minLetterSpacingPx,
  minMouseWheelScrollSensitivity,
  maxMouseWheelScrollSensitivity,
  minFastScrollSensitivity,
  maxFastScrollSensitivity,
  minReaderHorizontalInsetPx,
  maxReaderHorizontalInsetPx,
  readerHorizontalInsetPxStep,
  type ChapterTitleBlankMode,
} from "../constants/appUi";
import {
  TIMED_SCROLL_RANGE_OPTIONS,
  maxTimedScrollIntervalMs,
  minTimedScrollIntervalMs,
  type TimedScrollRange,
} from "../constants/timedScroll";
import {
  maxPomodoroMinutes,
  minPomodoroMinutes,
  pomodoroLongBreakEvery,
} from "../constants/pomodoro";
import { computed } from "vue";
import { icons } from "../icons.js";

const props = defineProps<{
  draftFontSize: number;
  draftLineHeightMultiple: number;
  draftLineSpacingPx: number;
  draftLetterSpacingPx: number;
  draftReaderHorizontalInsetPx: number;
  draftMonacoSmoothScrolling: boolean;
  draftMonacoCjkWrapOptimize: boolean;
  draftMouseWheelScrollSensitivity: number;
  draftFastScrollSensitivity: number;
  draftStickyChapterTitleEnabled: boolean;
  draftChapterNavToolbarEnabled: boolean;
  draftChapterTitleBlankMode: ChapterTitleBlankMode;
  draftCompressBlankKeepOneBlank: boolean;
  draftTxtrDelimitedMatchCrossLine: boolean;
  draftFullscreenReaderWidthPercent: number;
  draftFullscreenShowSystemTime: boolean;
  draftPomodoroEnabled: boolean;
  draftPomodoroFocusMinutes: number;
  draftPomodoroShortBreakMinutes: number;
  draftPomodoroLongBreakMinutes: number;
  draftTimedScrollRange: TimedScrollRange;
  draftTimedScrollIntervalMs: number;
  monacoCustomHighlight: boolean;
}>();

defineEmits<{
  "update:draftFontSize": [v: number];
  "update:draftLineHeightMultiple": [v: number];
  "update:draftLineSpacingPx": [v: number];
  "update:draftLetterSpacingPx": [v: number];
  "update:draftReaderHorizontalInsetPx": [v: number];
  "update:draftMonacoSmoothScrolling": [v: boolean];
  "update:draftMonacoCjkWrapOptimize": [v: boolean];
  "update:draftMouseWheelScrollSensitivity": [v: number];
  "update:draftFastScrollSensitivity": [v: number];
  "update:draftStickyChapterTitleEnabled": [v: boolean];
  "update:draftChapterNavToolbarEnabled": [v: boolean];
  "update:draftChapterTitleBlankMode": [v: ChapterTitleBlankMode];
  "update:draftCompressBlankKeepOneBlank": [v: boolean];
  "update:draftTxtrDelimitedMatchCrossLine": [v: boolean];
  "update:draftFullscreenReaderWidthPercent": [v: number];
  "update:draftFullscreenShowSystemTime": [v: boolean];
  "update:draftPomodoroEnabled": [v: boolean];
  "update:draftPomodoroFocusMinutes": [v: number];
  "update:draftPomodoroShortBreakMinutes": [v: number];
  "update:draftPomodoroLongBreakMinutes": [v: number];
  "update:draftTimedScrollRange": [v: TimedScrollRange];
  "update:draftTimedScrollIntervalMs": [v: number];
}>();

const draftMaxLineHeightMultiple = computed(() =>
  maxLineHeightMultipleForFontSize(props.draftFontSize),
);

const chapterTitleBlankSelectItems = computed<CustomSelectItem[]>(() =>
  CHAPTER_TITLE_BLANK_MODE_OPTIONS.map((o) => ({
    kind: "item" as const,
    id: o.value,
    label: o.label,
  })),
);
const selectListsEmpty: CustomSelectItem[] = [];
</script>

<template>
  <div class="settingsReadingRoot">
    <div class="settingsBody">
      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short">字号（{{ draftFontSize }} px）</span>
          <RangeSlider
            :model-value="draftFontSize"
            :min="minFontSize"
            :max="maxFontSize"
            :step="1"
            :show-percent="false"
            aria-label="阅读字号"
            @update:model-value="$emit('update:draftFontSize', $event)"
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short"
            >行高（{{ draftLineHeightMultiple.toFixed(1) }}）</span
          >
          <RangeSlider
            :model-value="draftLineHeightMultiple"
            :min="minLineHeightMultiple"
            :max="draftMaxLineHeightMultiple"
            :step="lineHeightMultipleStep"
            :show-percent="false"
            aria-label="行高倍数"
            @update:model-value="$emit('update:draftLineHeightMultiple', $event)"
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short"
            >字间距（{{ draftLetterSpacingPx }} px）</span
          >
          <RangeSlider
            :model-value="draftLetterSpacingPx"
            :min="minLetterSpacingPx"
            :max="maxLetterSpacingPx"
            :step="letterSpacingPxStep"
            :show-percent="false"
            aria-label="字间距"
            @update:model-value="$emit('update:draftLetterSpacingPx', $event)"
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short"
            >行间距（{{ draftLineSpacingPx }} px）</span
          >
          <RangeSlider
            :model-value="draftLineSpacingPx"
            :min="minLineSpacingPx"
            :max="maxLineSpacingPx"
            :step="lineSpacingPxStep"
            :show-percent="false"
            aria-label="行间距"
            @update:model-value="$emit('update:draftLineSpacingPx', $event)"
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short"
            >左右边距（{{ draftReaderHorizontalInsetPx }} px）</span
          >
          <RangeSlider
            :model-value="draftReaderHorizontalInsetPx"
            :min="minReaderHorizontalInsetPx"
            :max="maxReaderHorizontalInsetPx"
            :step="readerHorizontalInsetPxStep"
            :show-percent="false"
            aria-label="阅读区左右边距"
            @update:model-value="
              $emit('update:draftReaderHorizontalInsetPx', $event)
            "
          />
        </div>
      </div>
    </div>

    <div class="settingsBody settingsBody--scroll">
      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">启用中文换行优化</span>
          <SwitchToggle
            :model-value="draftMonacoCjkWrapOptimize"
            aria-label="启用中文换行优化"
            @update:model-value="
              $emit('update:draftMonacoCjkWrapOptimize', $event)
            "
          />
        </div>
        <p class="settingsHint">
          优化「简单换行策略」下的中文换行效果，不作用于「高级换行策略」。建议开启。
        </p>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">引号/括号匹配支持跨行</span>
          <SwitchToggle
            :model-value="draftTxtrDelimitedMatchCrossLine"
            :disabled="!monacoCustomHighlight"
            aria-label="引号/括号匹配支持跨行"
            @update:model-value="
              $emit('update:draftTxtrDelimitedMatchCrossLine', $event)
            "
          />
        </div>
        <p class="settingsHint">
          仅在开启「内容上色」时生效，开启后引号和括号会跨行匹配；<br />如果出现大段非引号/括号内的文本被误上色，是因为原文没有正确关闭引号/括号，可禁用该选项以降低影响范围（通常更建议进入编辑模式手动修正）。
        </p>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">启用粘性章节标题</span>
          <SwitchToggle
            :model-value="draftStickyChapterTitleEnabled"
            aria-label="启用粘性章节标题"
            @update:model-value="
              $emit('update:draftStickyChapterTitleEnabled', $event)
            "
          />
        </div>
        <p class="settingsHint">
          滚动时将章节标题粘在顶部；多层级标题会堆叠。
        </p>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">启用章节导航工具栏</span>
          <SwitchToggle
            :model-value="draftChapterNavToolbarEnabled"
            aria-label="启用章节导航工具栏"
            @update:model-value="
              $emit('update:draftChapterNavToolbarEnabled', $event)
            "
          />
        </div>
        <p class="settingsHint">
          在阅读区底部显示「上一章 / 下一章」快捷跳转；仅一章或无章节时不显示。
        </p>
      </div>
    </div>

    <div class="settingsBody settingsBody--scroll">
      <h3 class="settingsSectionTitle settingsSectionTitle--scroll">滚动</h3>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">平滑滚动</span>
          <SwitchToggle
            :model-value="draftMonacoSmoothScrolling"
            aria-label="阅读区平滑滚动"
            @update:model-value="
              $emit('update:draftMonacoSmoothScrolling', $event)
            "
          />
        </div>
        <p class="settingsHint">关闭后，阅读区滚动不再使用平滑动画。</p>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel">滚动倍率</span>
          <NumericInput
            :model-value="draftMouseWheelScrollSensitivity"
            :min="minMouseWheelScrollSensitivity"
            :max="maxMouseWheelScrollSensitivity"
            aria-label="滚动倍率"
            @update:model-value="
              $emit('update:draftMouseWheelScrollSensitivity', $event)
            "
          />
        </div>
        <p class="settingsHint">滚轮每次滚动的距离倍率（默认 1）。</p>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel">滚动加速倍率</span>
          <NumericInput
            :model-value="draftFastScrollSensitivity"
            :min="minFastScrollSensitivity"
            :max="maxFastScrollSensitivity"
            aria-label="滚动加速倍率"
            @update:model-value="
              $emit('update:draftFastScrollSensitivity', $event)
            "
          />
        </div>
        <p class="settingsHint">按住 <code>Alt</code> 时的加速倍率（默认 5）。</p>
      </div>
    </div>

    <div class="settingsBody settingsBody--timedScroll">
      <h3 class="settingsSectionTitle settingsSectionTitle--timedScroll">
        <span class="settingsIcon" v-html="icons.play" />
        定时滚动
      </h3>

      <div class="settingsRow">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel">范围</span>
          <RadioGroup
            :model-value="draftTimedScrollRange"
            :options="TIMED_SCROLL_RANGE_OPTIONS"
            aria-label="定时滚动范围"
            @update:model-value="
              $emit('update:draftTimedScrollRange', $event as TimedScrollRange)
            "
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel">间隔（毫秒）</span>
          <NumericInput
            :model-value="draftTimedScrollIntervalMs"
            :min="minTimedScrollIntervalMs"
            :max="maxTimedScrollIntervalMs"
            integer
            aria-label="定时滚动间隔毫秒"
            @update:model-value="$emit('update:draftTimedScrollIntervalMs', $event)"
          />
        </div>
      </div>
    </div>

    <div class="settingsBody settingsBody--fullscreen">
      <h3 class="settingsSectionTitle settingsSectionTitle--fullscreen">
        <span class="settingsIcon" v-html="icons.enterFullscreen" />
        全屏阅读
      </h3>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel short"
            >阅读区域宽度（{{ draftFullscreenReaderWidthPercent }}%）</span
          >
          <RangeSlider
            :model-value="draftFullscreenReaderWidthPercent"
            :min="minFullscreenReaderWidthPercent"
            :max="maxFullscreenReaderWidthPercent"
            :step="1"
            :show-percent="false"
            aria-label="全屏阅读区域宽度百分比"
            @update:model-value="
              $emit('update:draftFullscreenReaderWidthPercent', $event)
            "
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">在左下角显示系统时间</span>
          <SwitchToggle
            :model-value="draftFullscreenShowSystemTime"
            aria-label="全屏时在左下角显示系统时间"
            @update:model-value="
              $emit('update:draftFullscreenShowSystemTime', $event)
            "
          />
        </div>
      </div>
    </div>

    <div class="settingsBody settingsBody--pomodoro">
      <h3 class="settingsSectionTitle settingsSectionTitle--pomodoro">
        <span class="settingsIcon" v-html="icons.history" />
        番茄时钟
      </h3>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">启用番茄时钟</span>
          <SwitchToggle
            :model-value="draftPomodoroEnabled"
            aria-label="启用番茄时钟"
            @update:model-value="$emit('update:draftPomodoroEnabled', $event)"
          />
        </div>
        <p class="settingsHint">在底栏左侧显示番茄时钟</p>
      </div>

      <template v-if="draftPomodoroEnabled">
        <div class="settingsRow">
          <div class="settingsRowMain settingsRowMain--baseline">
            <span class="settingsLabel">阅读时长（分钟）</span>
            <NumericInput
              :model-value="draftPomodoroFocusMinutes"
              :min="minPomodoroMinutes"
              :max="maxPomodoroMinutes"
              integer
              aria-label="番茄时钟阅读时长分钟"
              @update:model-value="
                $emit('update:draftPomodoroFocusMinutes', $event)
              "
            />
          </div>
        </div>

        <div class="settingsRow">
          <div class="settingsRowMain settingsRowMain--baseline">
            <span class="settingsLabel">短休息（分钟）</span>
            <NumericInput
              :model-value="draftPomodoroShortBreakMinutes"
              :min="minPomodoroMinutes"
              :max="maxPomodoroMinutes"
              integer
              aria-label="番茄时钟短休息分钟"
              @update:model-value="
                $emit('update:draftPomodoroShortBreakMinutes', $event)
              "
            />
          </div>
        </div>

        <div class="settingsRow">
          <div class="settingsRowMain settingsRowMain--baseline">
            <span class="settingsLabel">长休息（分钟）</span>
            <NumericInput
              :model-value="draftPomodoroLongBreakMinutes"
              :min="minPomodoroMinutes"
              :max="maxPomodoroMinutes"
              integer
              aria-label="番茄时钟长休息分钟"
              @update:model-value="
                $emit('update:draftPomodoroLongBreakMinutes', $event)
              "
            />
          </div>
          <p class="settingsHint">
            每完成 {{ pomodoroLongBreakEvery }} 轮「阅读时长」会进入一次长休息
          </p>
        </div>
      </template>
    </div>

    <div class="settingsBody settingsBody--scroll">
      <h3 class="settingsSectionTitle settingsSectionTitle--scroll">
        <span class="settingsIcon" v-html="icons.compress" />
        压缩空行
      </h3>

      <div class="settingsRow">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel">章节标题前后保留空行</span>
          <AppCustomSelect
            class="settingsSelect settingsSelect--chapterTitleBlank"
            :model-value="draftChapterTitleBlankMode"
            :display-label="chapterTitleBlankModeLabel(draftChapterTitleBlankMode)"
            :fixed-top-items="selectListsEmpty"
            :scroll-items="chapterTitleBlankSelectItems"
            :fixed-bottom-items="selectListsEmpty"
            :scroll-max-height="160"
            ariaLabel="压缩空行时章节标题前后保留空行"
            @update:model-value="
              $emit(
                'update:draftChapterTitleBlankMode',
                $event as ChapterTitleBlankMode,
              )
            "
          />
        </div>
      </div>

      <div class="settingsRow">
        <div class="settingsRowMain">
          <span class="settingsLabel">每行下方保留一个空行</span>
          <SwitchToggle
            :model-value="draftCompressBlankKeepOneBlank"
            aria-label="压缩空行时每行下方保留一个空行"
            @update:model-value="
              $emit('update:draftCompressBlankKeepOneBlank', $event)
            "
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settingsReadingRoot {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settingsBody {
  padding: 8px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px;
  background-color: var(--bg);
  border-radius: 8px;
}

.settingsSectionTitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}

.settingsRow {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settingsRowMain {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.settingsRowMain--baseline {
  align-items: baseline;
}

.settingsSelect {
  flex: 0 1 220px;
  min-width: 160px;
  max-width: 280px;
}

.settingsSelect--chapterTitleBlank {
  flex: 0 1 260px;
  max-width: 300px;
}

.settingsLabel {
  font-size: 14px;
  color: var(--fg);
  flex: 1 1 60%;
  min-width: 60%;
}
.settingsLabel.short {
  flex: 1 1 30%;
  min-width: 30%;
}

.settingsHint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}

.settingsSectionTitle:has(+ .settingsHint) {
  margin-bottom: 0;
}

.settingsIcon {
  display: inline-block;
  width: 16px;
  height: 16px;
  vertical-align: middle;
}
.settingsIcon :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
}
.settingsIcon :deep(svg path) {
  fill: currentColor;
}

.settingsBody--scroll,
.settingsBody--fullscreen,
.settingsBody--pomodoro,
.settingsBody--timedScroll {
  gap: 10px;
}

.settingsSectionTitle--scroll,
.settingsSectionTitle--fullscreen,
.settingsSectionTitle--pomodoro,
.settingsSectionTitle--timedScroll {
  margin-bottom: 10px;
}
</style>
