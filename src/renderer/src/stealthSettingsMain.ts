import { createApp } from "vue";
import StealthSettingsApp from "./StealthSettingsApp.vue";
import "./style.css";
import "./styles/settingsPanel.css";
import { installEscapeBlurTextFieldListener } from "./utils/escapeBlurTextField";

installEscapeBlurTextFieldListener();
createApp(StealthSettingsApp).mount("#app");
