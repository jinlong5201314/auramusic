/**
 * Solara Mobile UI - iOS 原生可拖拽 Bottom Sheet 抽屉控制器
 */

import { $, triggerLightHaptic, updateMobileOverlayScrim } from "./core.js";
import { closeMobileSearch } from "./search.js";

export function normalizePanelView(view) {
    return view === "lyrics" ? "playlist" : (view || "playlist");
}

export function switchMobilePanelTab(targetTab) {
    const validTabs = ["playlist", "favorites", "customPlaylists", "square"];
    const currentTab = validTabs.includes(targetTab) ? targetTab : "playlist";

    const plTab = $("mobilePlaylistTab");
    const favTab = $("mobileFavoritesTab");
    const cplTab = $("mobileCustomPlaylistsTab");
    const sqTab = $("mobileSquareTab");
    const plActions = $("mobilePlaylistActions");
    const favActions = $("mobileFavoritesActions");
    const cplActions = $("mobileCustomPlaylistsActions");
    const playlist = $("playlist");
    const favorites = $("favorites");
    const customPlaylists = $("customPlaylists");
    const square = $("square");

    if (plTab) {
        plTab.classList.toggle("active", currentTab === "playlist");
        plTab.setAttribute("aria-selected", currentTab === "playlist" ? "true" : "false");
    }
    if (favTab) {
        favTab.classList.toggle("active", currentTab === "favorites");
        favTab.setAttribute("aria-selected", currentTab === "favorites" ? "true" : "false");
    }
    if (cplTab) {
        cplTab.classList.toggle("active", currentTab === "customPlaylists");
        cplTab.setAttribute("aria-selected", currentTab === "customPlaylists" ? "true" : "false");
    }
    if (sqTab) {
        sqTab.classList.toggle("active", currentTab === "square");
        sqTab.setAttribute("aria-selected", currentTab === "square" ? "true" : "false");
    }

    if (plActions) {
        plActions.hidden = currentTab !== "playlist";
        plActions.setAttribute("aria-hidden", currentTab !== "playlist" ? "true" : "false");
    }
    if (favActions) {
        favActions.hidden = currentTab !== "favorites";
        favActions.setAttribute("aria-hidden", currentTab !== "favorites" ? "true" : "false");
    }
    if (cplActions) {
        cplActions.hidden = currentTab !== "customPlaylists";
        cplActions.setAttribute("aria-hidden", currentTab !== "customPlaylists" ? "true" : "false");
    }

    const panels = [
        { name: "playlist", el: playlist },
        { name: "favorites", el: favorites },
        { name: "customPlaylists", el: customPlaylists },
        { name: "square", el: square }
    ];

    panels.forEach(({ name, el }) => {
        if (!el) return;
        const isActive = name === currentTab;
        el.classList.toggle("active", isActive);
        el.hidden = !isActive;
        if (!isActive) {
            el.setAttribute("hidden", "");
        } else {
            el.removeAttribute("hidden");
        }
    });

    if (document.body) {
        document.body.setAttribute("data-mobile-panel-view", currentTab);
    }

    // 移动端分段控制器物理滑动胶囊
    const tabsContainer = $("mobilePanelHeader")?.querySelector(".playlist-tabs");
    if (tabsContainer) {
        requestAnimationFrame(() => {
            let indicator = tabsContainer.querySelector(".playlist-tabs-indicator");
            if (!indicator) {
                indicator = document.createElement("div");
                indicator.className = "playlist-tabs-indicator";
                indicator.setAttribute("aria-hidden", "true");
                tabsContainer.prepend(indicator);
            }
            let activeTab = plTab;
            if (currentTab === "favorites") activeTab = favTab;
            else if (currentTab === "customPlaylists") activeTab = cplTab;
            else if (currentTab === "square") activeTab = sqTab;

            if (activeTab && activeTab.offsetWidth > 0) {
                indicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
                indicator.style.width = `${activeTab.offsetWidth}px`;
                indicator.style.opacity = "1";
            }
        });
    }

    try {
        window.dispatchEvent(new CustomEvent("aura:mobile-tab-changed", { detail: { tab: targetTab } }));
        window.dispatchEvent(new CustomEvent("solara:mobile-tab-changed", { detail: { tab: targetTab } }));
    } catch (e) {}
}

export function openMobilePanel(view = "playlist") {
    if (!document.body) return;
    triggerLightHaptic();
    const targetView = normalizePanelView(view);
    switchMobilePanelTab(targetView);
    closeMobileSearch();
    document.body.classList.add("mobile-panel-open");
    updateMobileOverlayScrim();

    const panel = $("mobilePanel");
    if (panel) {
        requestAnimationFrame(() => {
            const tabsContainer = $("mobilePanelHeader")?.querySelector(".playlist-tabs");
            let activeTab = $("mobilePlaylistTab");
            if (targetView === "favorites") activeTab = $("mobileFavoritesTab");
            else if (targetView === "customPlaylists") activeTab = $("mobileCustomPlaylistsTab");
            else if (targetView === "square") activeTab = $("mobileSquareTab");

            const indicator = tabsContainer?.querySelector(".playlist-tabs-indicator");
            if (indicator && activeTab && activeTab.offsetWidth > 0) {
                indicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
                indicator.style.width = `${activeTab.offsetWidth}px`;
                indicator.style.opacity = "1";
            }
        });
    }
    if (panel) {
        panel.style.transform = "";
        panel.style.transition = "";
    }
}

export function closeMobilePanel() {
    if (!document.body) return;
    document.body.classList.remove("mobile-panel-open");
    updateMobileOverlayScrim();

    const panel = $("mobilePanel");
    if (panel) {
        panel.style.transform = "";
        panel.style.transition = "";
    }
}

export function toggleMobilePanel(view = "playlist") {
    if (!document.body) return;
    const isOpen = document.body.classList.contains("mobile-panel-open");
    const currentView = document.body.getAttribute("data-mobile-panel-view") || "playlist";
    const targetView = normalizePanelView(view);
    if (isOpen && (!targetView || currentView === targetView)) {
        closeMobilePanel();
    } else {
        openMobilePanel(targetView || currentView || "playlist");
    }
}

export function closeAllMobileOverlays() {
    closeMobileSearch();
    closeMobilePanel();
}
