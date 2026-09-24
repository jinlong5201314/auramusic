/**
 * Solara 设置面板、探索雷达偏好与大留白小播放器/全景双模态切换
 */

import { EXPLORE_RADAR_GENRES, DEFAULT_RADAR_GENRES } from "../constants.js";
import { safeGetLocalStorage, safeSetLocalStorage, persistStorageItems } from "../core/storage.js";
import { toggleDebugMode } from "../visual/spotlight.js";
import { updateAllTabsIndicators } from "./playlist.js";
import { lxPluginEngine } from "../core/source-plugin.js";

const NOTIFICATION_ICONS = {
    success: `<svg class="notification-svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>`,
    error: `<svg class="notification-svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/></svg>`,
    warning: `<svg class="notification-svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>`,
    info: `<svg class="notification-svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd"/></svg>`
};

let notificationHideTimer = null;
let notificationListenersBound = false;

export function showNotification(message, type = "success", dom = null) {
    if (typeof document === "undefined") return;
    const notification = (dom && dom.notification) || document.getElementById("notification");
    if (!notification) return;

    if (notificationHideTimer) {
        clearTimeout(notificationHideTimer);
        notificationHideTimer = null;
    }

    const iconHtml = NOTIFICATION_ICONS[type] || NOTIFICATION_ICONS.info;
    notification.innerHTML = `
        <span class="notification-icon notification-icon--${type}" aria-hidden="true">${iconHtml}</span>
        <span class="notification-message">${message}</span>
    `;
    notification.className = `notification notification--${type} ${type}`;

    // 绑定交互：鼠标悬停暂停自动收回，移开恢复，点击直接收回
    if (!notificationListenersBound) {
        notificationListenersBound = true;
        notification.addEventListener("mouseenter", () => {
            if (notificationHideTimer) {
                clearTimeout(notificationHideTimer);
                notificationHideTimer = null;
            }
        });
        notification.addEventListener("mouseleave", () => {
            if (notification.classList.contains("show")) {
                notificationHideTimer = setTimeout(() => {
                    notification.classList.remove("show");
                    notificationHideTimer = null;
                }, 1800);
            }
        });
        notification.addEventListener("click", () => {
            if (notificationHideTimer) {
                clearTimeout(notificationHideTimer);
                notificationHideTimer = null;
            }
            notification.classList.remove("show");
        });
    }

    // 强制重绘让连续触发也有微弹性动效
    notification.classList.remove("show");
    void notification.offsetWidth;
    notification.classList.add("show");

    const displayDuration = Math.max(2800, Math.min(5500, String(message).length * 130));
    notificationHideTimer = setTimeout(() => {
        notification.classList.remove("show");
        notificationHideTimer = null;
    }, displayDuration);
}

export function openSettingsModal(dom, state = null) {
    if (dom && dom.settingsModal) {
        // 同步调试模式按钮外观
        if (state) {
            const toggleDebugBtn = document.getElementById("toggleDebugBtn");
            const toggleDebugText = document.getElementById("toggleDebugText");
            if (toggleDebugBtn) {
                toggleDebugBtn.classList.toggle("is-active", Boolean(state.debugMode));
            }
            if (toggleDebugText) {
                toggleDebugText.textContent = state.debugMode ? "关闭调试模式" : "开启调试模式";
            }
        }

        // 同步音源订阅信息
        if (dom.lxSourceUrlInput) {
            dom.lxSourceUrlInput.value = "";
        }
        renderLxSourceList(dom);

        dom.settingsModal.classList.add("show");
        dom.settingsModal.setAttribute("aria-hidden", "false");
    }
}

export function renderLxSourceList(dom) {
    if (!dom || !dom.lxSourceList) return;

    const sources = lxPluginEngine.sources || [];
    if (sources.length === 0) {
        dom.lxSourceList.innerHTML = `<div class="lx-source-empty">暂无导入的自定义音源脚本，请在上方输入链接添加</div>`;
        return;
    }

    dom.lxSourceList.innerHTML = sources.map((src) => {
        const isActive = src.id === lxPluginEngine.activeSourceId;
        const activeClass = isActive ? "is-active" : "";
        const checkedAttr = isActive ? "checked" : "";
        return `
            <div class="lx-source-item ${activeClass}" data-id="${src.id}">
                <div class="lx-source-main" data-id="${src.id}">
                    <input type="radio" name="lxActiveSourceRadio" class="lx-source-radio" value="${src.id}" ${checkedAttr} />
                    <div class="lx-source-meta">
                        <div class="lx-source-title-row">
                            <span class="lx-source-title">${src.name || "自定义音源"}</span>
                            <span class="lx-source-ver-tag">v${src.version || "1.0.0"}</span>
                        </div>
                        <span class="lx-source-url-text" title="${src.url}">${src.url}</span>
                    </div>
                </div>
                <div class="lx-source-actions">
                    <button type="button" class="lx-source-del-btn" data-id="${src.id}" title="删除此音源">
                        <svg class="apple-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join("");

    // 绑定单选切换事件
    dom.lxSourceList.querySelectorAll(".lx-source-main").forEach(item => {
        item.addEventListener("click", async () => {
            const id = item.getAttribute("data-id");
            if (id && id !== lxPluginEngine.activeSourceId) {
                showNotification("正在切换音源...", "info", dom);
                const ok = await lxPluginEngine.activateSource(id);
                renderLxSourceList(dom);
            // 立即向云端 D1 增量同步音源列表与状态
            if (typeof persistStorageItems === "function") {
                persistStorageItems({
                    lxMusicSourcesList: JSON.stringify(lxPluginEngine.sources),
                    lxMusicActiveSourceId: lxPluginEngine.activeSourceId,
                    lxMusicSourceEnabled: String(lxPluginEngine.isEnabled)
                });
            }
            showNotification(ok ? `已切换生效音源: 【${lxPluginEngine.scriptInfo?.name || "自定义音源"}】` : `音源加载异常: ${lxPluginEngine.lastError}`, ok ? "success" : "error", dom);
            }
        });
    });

    // 绑定删除按钮事件
    dom.lxSourceList.querySelectorAll(".lx-source-del-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = btn.getAttribute("data-id");
            if (id) {
                lxPluginEngine.removeSource(id);
                renderLxSourceList(dom);
                if (typeof persistStorageItems === "function") {
                    persistStorageItems({
                        lxMusicSourcesList: JSON.stringify(lxPluginEngine.sources),
                        lxMusicActiveSourceId: lxPluginEngine.activeSourceId,
                        lxMusicSourceEnabled: String(lxPluginEngine.isEnabled)
                    });
                }
                showNotification("已移除该音源", "info", dom);
            }
        });
    });
}

export function closeSettingsModal(dom) {
    if (dom && dom.settingsModal) {
        dom.settingsModal.classList.remove("show");
        dom.settingsModal.setAttribute("aria-hidden", "true");
    }
}

export function renderGenreList(dom, state = null) {
    if (!dom || !dom.radarGenreList) return;
    
    const selectedGenres = Array.isArray(state?.radarSettings?.genres) && state.radarSettings.genres.length > 0
        ? state.radarSettings.genres
        : DEFAULT_RADAR_GENRES;

    dom.radarGenreList.innerHTML = EXPLORE_RADAR_GENRES.map(genre => {
        const isChecked = selectedGenres.includes(genre) ? "checked" : "";
        const label = (typeof window !== "undefined" && typeof window.t === "function") ? window.t(genre) : genre;
        return `
        <div class="genre-item">
            <input type="checkbox" id="genre-${genre}" value="${genre}" ${isChecked}>
            <label for="genre-${genre}" class="genre-label">${label}</label>
        </div>
        `;
    }).join("");
}

export function applySettingsToUI(dom, state) {
    if (!dom || !dom.radarGenreList) return;
    
    const selectedGenres = Array.isArray(state?.radarSettings?.genres) && state.radarSettings.genres.length > 0
        ? state.radarSettings.genres
        : DEFAULT_RADAR_GENRES;

    const checkboxes = dom.radarGenreList.querySelectorAll("input[type='checkbox']");
    checkboxes.forEach(cb => {
        cb.checked = selectedGenres.includes(cb.value);
    });
}

export async function loadSettings(dom, state) {
    let localSettings = safeGetLocalStorage("radarSettings");
    if (localSettings) {
        try {
            state.radarSettings = JSON.parse(localSettings);
            // 兼容迁移：若包含旧曲风（如“流行”、“摇滚”等），过滤只保留有效榜单；若全无效则回退至默认三大官方榜单
            if (Array.isArray(state.radarSettings?.genres)) {
                const validGenres = state.radarSettings.genres.filter(g => EXPLORE_RADAR_GENRES.includes(g));
                state.radarSettings.genres = validGenres.length > 0 ? validGenres : [...DEFAULT_RADAR_GENRES];
            } else {
                state.radarSettings = { genres: [...DEFAULT_RADAR_GENRES] };
            }
            applySettingsToUI(dom, state);
        } catch (e) {
            console.error("解析本地设置失败:", e);
            state.radarSettings = { genres: [...DEFAULT_RADAR_GENRES] };
            applySettingsToUI(dom, state);
        }
    } else {
        state.radarSettings = { genres: [...DEFAULT_RADAR_GENRES] };
        applySettingsToUI(dom, state);
    }
}

export async function saveSettings(dom, state) {
    if (!dom.radarGenreList) return;
    const selectedGenres = Array.from(dom.radarGenreList.querySelectorAll("input:checked")).map(cb => cb.value);
    
    if (selectedGenres.length === 0) {
        const tip = (typeof window !== "undefined" && typeof window.t === "function") 
            ? window.t("请至少选择一个榜单") 
            : "请至少选择一个榜单";
        showNotification(tip, "warning", dom);
        return;
    }

    state.radarSettings = {
        genres: selectedGenres
    };

    safeSetLocalStorage("radarSettings", JSON.stringify(state.radarSettings));

    if (typeof persistStorageItems === "function") {
        persistStorageItems({
            radarSettings: JSON.stringify(state.radarSettings)
        });
    }

    const successTip = (typeof window !== "undefined" && typeof window.t === "function") 
        ? window.t("设置已保存") 
        : "设置已保存";
    showNotification(successTip, "success", dom);
    closeSettingsModal(dom);
}

export function initLayoutMode(dom) {
    const STORAGE_KEY = "auramusic_layout_mode";
    const toggleBtn = dom?.layoutToggleBtn || document.getElementById("layoutToggleBtn");
    
    let currentMode = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("solara_layout_mode");
    if (!currentMode) {
        currentMode = "compact";
    }

    const applyLayoutMode = (mode) => {
        const isCompact = mode === "compact";
        document.body.classList.toggle("layout-compact", isCompact);
        
        if (toggleBtn) {
            toggleBtn.setAttribute("aria-label", isCompact ? "展开为全景沉浸模式" : "收拢为大留白小播放器");
            toggleBtn.setAttribute("title", isCompact ? "展开为全景沉浸模式" : "收拢为大留白小播放器");
        }
        localStorage.setItem(STORAGE_KEY, mode);

        // 布局模式切换时立即与分段重新测量指示器，并在过渡动画（100ms, 300ms, 650ms）结束阶段重新校准
        if (typeof updateAllTabsIndicators === "function") {
            updateAllTabsIndicators();
            setTimeout(updateAllTabsIndicators, 100);
            setTimeout(updateAllTabsIndicators, 300);
            setTimeout(updateAllTabsIndicators, 650);
        }
    };

    applyLayoutMode(currentMode);

    // 监听舞台主容器尺寸过渡结束事件，确保在长缓动完成瞬间 100% 精确对齐
    const stageContainer = document.querySelector(".container");
    if (stageContainer && !stageContainer.__tabsTransitionBound) {
        stageContainer.__tabsTransitionBound = true;
        stageContainer.addEventListener("transitionend", (e) => {
            if (e.target === stageContainer && (e.propertyName === "width" || e.propertyName === "height" || e.propertyName === "grid-template-columns")) {
                if (typeof updateAllTabsIndicators === "function") {
                    updateAllTabsIndicators();
                }
            }
        });
    }

    if (toggleBtn && !toggleBtn.__layoutBound) {
        toggleBtn.__layoutBound = true;
        toggleBtn.addEventListener("click", () => {
            const isCurrentlyCompact = document.body.classList.contains("layout-compact");
            const newMode = isCurrentlyCompact ? "expanded" : "compact";
            applyLayoutMode(newMode);
        });
    }

    const headerSettingsBtn = dom?.headerSettingsBtn || document.getElementById("headerSettingsBtn");
    if (headerSettingsBtn && !headerSettingsBtn.__clickBound) {
        headerSettingsBtn.__clickBound = true;
        headerSettingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openSettingsModal(dom);
        });
    }

    if (!window.__settingsKeyBound) {
        window.__settingsKeyBound = true;
        window.addEventListener("keydown", (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === ",") {
                e.preventDefault();
                openSettingsModal(dom);
            }
        });
    }
}

export function initSettings(dom, state, callbacks = {}) {
    renderGenreList(dom, state);

    const headerSettingsBtn = dom?.headerSettingsBtn || document.getElementById("headerSettingsBtn");
    if (headerSettingsBtn && !headerSettingsBtn.__clickBound) {
        headerSettingsBtn.__clickBound = true;
        headerSettingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openSettingsModal(dom, state);
        });
    }
    
    let lastToolbarClick = 0;
    const handleDoubleTap = (e) => {
        const now = Date.now();
        if (now - lastToolbarClick < 300) {
            e.preventDefault();
            openSettingsModal(dom, state);
        }
        lastToolbarClick = now;
    };

    if (dom.mobileToolbarTitle) {
        dom.mobileToolbarTitle.addEventListener("click", handleDoubleTap);
    }

    if (dom.closeSettingsBtn) {
        dom.closeSettingsBtn.addEventListener("click", () => closeSettingsModal(dom));
    }
    if (dom.saveSettingsBtn) {
        dom.saveSettingsBtn.addEventListener("click", () => saveSettings(dom, state));
    }
    const openBtn = dom.openSettingsBtn || document.getElementById("openSettingsBtn");
    if (openBtn) {
        openBtn.addEventListener("click", () => openSettingsModal(dom, state));
    }
    if (dom.settingsModal) {
        dom.settingsModal.addEventListener("click", (e) => {
            if (e.target === dom.settingsModal) closeSettingsModal(dom);
        });
    }

    // 绑定开启/关闭调试模式按钮
    const toggleDebugBtn = document.getElementById("toggleDebugBtn");
    if (toggleDebugBtn) {
        toggleDebugBtn.addEventListener("click", () => {
            const isEnabled = toggleDebugMode(state, dom, callbacks.debugLog);
            showNotification(isEnabled ? "已开启调试控制台" : "已关闭调试控制台", isEnabled ? "success" : "info", dom);
        });
    }

    // 绑定手动云端同步按钮
    const manualSyncBtn = document.getElementById("manualSyncBtn");
    if (manualSyncBtn) {
        manualSyncBtn.addEventListener("click", async () => {
            if (typeof callbacks.manualSync === "function") {
                manualSyncBtn.disabled = true;
                const origHtml = manualSyncBtn.innerHTML;
                manualSyncBtn.innerHTML = '<span class="loader" style="width:14px;height:14px;border-width:2px;"></span><span>正在同步中...</span>';
                try {
                    await callbacks.manualSync();
                    showNotification("云端数据漫游同步成功", "success", dom);
                } catch (e) {
                    console.error("手动同步失败:", e);
                    showNotification(e.message ? `同步失败: ${e.message}` : "云端同步失败，请检查网络或服务端", "error", dom);
                } finally {
                    manualSyncBtn.disabled = false;
                    manualSyncBtn.innerHTML = origHtml;
                }
            } else {
                console.warn("未提供 manualSync 回调函数");
            }
        });
    }

    // 绑定洛雪自定义多音源添加按钮
    if (dom.loadLxSourceBtn && dom.lxSourceUrlInput) {
        dom.loadLxSourceBtn.addEventListener("click", async () => {
            const url = dom.lxSourceUrlInput.value.trim();
            if (!url) {
                showNotification("请输入有效的音源脚本 URL", "warning", dom);
                return;
            }

            dom.loadLxSourceBtn.disabled = true;
            const origHtml = dom.loadLxSourceBtn.innerHTML;
            dom.loadLxSourceBtn.innerHTML = '<span class="loader" style="width:14px;height:14px;border-width:2px;"></span><span>添加解析中...</span>';

            try {
                const added = await lxPluginEngine.addSource(url);
                dom.lxSourceUrlInput.value = "";
                renderLxSourceList(dom);
                showNotification(`成功添加音源【${added.name || "自定义音源"}】并设为默认`, "success", dom);
            } catch (err) {
                showNotification(`音源添加失败: ${err.message}`, "error", dom);
            } finally {
                dom.loadLxSourceBtn.disabled = false;
                dom.loadLxSourceBtn.innerHTML = origHtml;
            }
        });
    }

    loadSettings(dom, state);
    initLayoutMode(dom);
}
