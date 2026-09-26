/**
 * Solara Mobile UI - 顶部工具栏交互控制
 */

import { $, triggerLightHaptic } from "./core.js";

export function bindMobileToolbar() {
    // 1. 移动端深浅色模式切换绑定
    const mobileThemeToggle = $("mobileThemeToggle");
    if (mobileThemeToggle) {
        mobileThemeToggle.addEventListener("click", () => {
            triggerLightHaptic();
            const desktopThemeBtn = $("themeToggleButton");
            if (desktopThemeBtn) {
                desktopThemeBtn.click();
            } else if (document.body) {
                document.body.classList.toggle("dark-mode");
            }
        });
    }

    // 2. 移动端探索雷达按钮绑定
    const mobileExploreBtn = $("mobileExploreButton");
    if (mobileExploreBtn) {
        mobileExploreBtn.addEventListener("click", () => {
            triggerLightHaptic();
            const desktopRadar = $("loadOnlineBtn");
            if (desktopRadar) {
                desktopRadar.click();
            }
        });
    }

    // 3. 移动端设置按钮绑定 (顶栏与抽屉面板双重呼应)
    const mobileSettingsBtn = $("mobileSettingsBtn");
    if (mobileSettingsBtn) {
        mobileSettingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            triggerLightHaptic();
            const desktopSettings = $("headerSettingsBtn");
            if (desktopSettings) {
                desktopSettings.click();
            } else if (window.__solaraOpenSettings) {
                window.__solaraOpenSettings();
            }
        });
    }

    const mobilePanelSettings = $("mobilePanelSettings");
    if (mobilePanelSettings) {
        mobilePanelSettings.addEventListener("click", (e) => {
            e.stopPropagation();
            triggerLightHaptic();
            const desktopSettings = $("headerSettingsBtn");
            if (desktopSettings) {
                desktopSettings.click();
            } else if (window.__solaraOpenSettings) {
                window.__solaraOpenSettings();
            }
        });
    }
}
