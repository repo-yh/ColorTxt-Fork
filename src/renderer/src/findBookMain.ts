import "monaco-editor/esm/nls.messages.zh-cn.js";
import { createApp } from "vue";
import FindBookWindow from "./FindBookWindow.vue";
import "./style.css";
import "./styles/settingsPanel.css";
import { installEscapeBlurTextFieldListener } from "./utils/escapeBlurTextField";

installEscapeBlurTextFieldListener();
createApp(FindBookWindow).mount("#app");
