/**
 * Solara 歌单广场 (Square) —— 宽屏沉浸式全景大厅
 * 支持 QQ 音乐、网易云等平台官方分类歌单浏览与播放，预留酷我/酷狗
 */

import { showNotification } from "./settings.js";
import { getSongKey } from "./playlist.js";

let currentPlatform = "qq";
let currentCategoryId = "3317";
let currentPage = 0;
let playlistAbortController = null;
let activeRequestSeq = 0;
let currentPlaylistDetail = null;

const PLATFORM_NAMES = {
  qq: "QQ音乐",
  netease: "网易云音乐",
  kuwo: "酷我音乐",
  kugou: "酷狗音乐",
  migu: "咪咕音乐",
};

// 格式化播放量数字
function formatPlayCount(num) {
  const n = Number(num) || 0;
  if (n >= 100000000) {
    return (n / 100000000).toFixed(1) + "亿";
  }
  if (n >= 10000) {
    return (n / 10000).toFixed(1) + "万";
  }
  return String(n);
}

/**
 * 切换歌单广场沉浸全景模式
 */
export function toggleSquareMode(enable, state, dom, callbacks = {}) {
  const container = dom?.container || document.getElementById("mainContainer");
  const squareArea = dom?.squareArea || document.getElementById("squareArea");
  if (!container || !squareArea) return;

  state.isSquareMode = Boolean(enable);

  if (enable) {
    // 退出搜索模式并激活广场全景模式
    container.classList.remove("search-mode");
    container.classList.add("square-mode");
    if (document.body) {
      document.body.classList.add("mobile-square-open");
      document.body.classList.remove("mobile-search-open");
    }
    squareArea.removeAttribute("hidden");
    squareArea.setAttribute("aria-hidden", "false");
    squareArea.style.display = "flex";

    // 初次打开若无分类则静默拉取
    const tagListContainer = document.getElementById("squareCategoryTags");
    if (!tagListContainer || tagListContainer.children.length === 0) {
      loadCategories(state, dom, callbacks);
    }
  } else {
    container.classList.remove("square-mode");
    if (document.body) {
      document.body.classList.remove("mobile-square-open");
    }
    squareArea.setAttribute("hidden", "");
    squareArea.setAttribute("aria-hidden", "true");
    squareArea.style.display = "";
  }
}

/**
 * 初始化歌单广场大厅
 */
export async function initSquare(state, dom, callbacks = {}) {
  const squareArea = dom?.squareArea || document.getElementById("squareArea");
  if (!squareArea) return;

  // 1. 顶栏「歌单广场」胶囊入口绑定
  const headerBtn = dom?.headerSquareBtn || document.getElementById("headerSquareBtn");
  if (headerBtn) {
    headerBtn.addEventListener("click", () => {
      toggleSquareMode(!state.isSquareMode, state, dom, callbacks);
    });
  }

  // 1.1 移动端顶栏「歌单广场」按钮绑定
  const mobileBtn = dom?.mobileSquareBtn || document.getElementById("mobileSquareButton");
  if (mobileBtn) {
    mobileBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bridge = window.AuraMobileBridge || window.SolaraMobileBridge;
      if (bridge?.handlers?.closeAllOverlays) {
        bridge.handlers.closeAllOverlays();
      }
      toggleSquareMode(!state.isSquareMode, state, dom, callbacks);
    });
  }

  // 2. 播放列表面板中的「歌单广场 ↗」选项卡联动
  document.querySelectorAll('.playlist-tab[data-target="square"]').forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSquareMode(true, state, dom, callbacks);
    });
  });

  // 3. 广场右上角「返回播放器」按钮
  const closeBtn = dom?.closeSquareBtn || document.getElementById("closeSquareBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      toggleSquareMode(false, state, dom, callbacks);
    });
  }

  // 4. 键盘 Esc 键全局关闭弹窗与广场
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const catModal = document.getElementById("categoryPickerModal");
      if (catModal && catModal.classList.contains("show")) {
        closeCategoryPickerModal();
        return;
      }
      const modal = document.getElementById("playlistDetailModal");
      if (modal && modal.classList.contains("show")) {
        closePlaylistDetailModal();
      } else if (state.isSquareMode) {
        toggleSquareMode(false, state, dom, callbacks);
      }
    }
  });

  // 5. 分类横向导航条左右滚动箭头
  const prevBtn = dom?.squareNavPrev || document.getElementById("squareNavPrev");
  const nextBtn = dom?.squareNavNext || document.getElementById("squareNavNext");
  const tagsBar = document.getElementById("squareCategoryTags");

  if (prevBtn && tagsBar) {
    prevBtn.addEventListener("click", () => {
      tagsBar.scrollBy({ left: -340, behavior: "smooth" });
    });
  }
  if (nextBtn && tagsBar) {
    nextBtn.addEventListener("click", () => {
      tagsBar.scrollBy({ left: 340, behavior: "smooth" });
    });
  }

  // 6. 音乐平台切换下拉框
  const platformSelect = document.getElementById("squarePlatformSelect");
  if (platformSelect) {
    platformSelect.addEventListener("change", (e) => {
      const p = e.target.value;
      const validPlatforms = ["qq", "netease", "kuwo", "kugou", "migu"];
      if (!validPlatforms.includes(p)) {
        showNotification("该平台接口正在接入中，敬请期待", "warning", dom);
        platformSelect.value = currentPlatform;
        return;
      }
      currentPlatform = p;
      currentPage = 0;
      loadCategories(state, dom, callbacks);
    });
  }

  // 7. 移动端/全端分类下拉框绑定 (Native Select)
  const catSelect = dom?.squareCategorySelect || document.getElementById("squareCategorySelect");
  if (catSelect) {
    catSelect.addEventListener("change", (e) => {
      applyCategoryChange(e.target.value, state, dom, callbacks);
    });
  }

  // 8. 全部分类矩阵大厅按钮绑定 (Category Sheet)
  const openCatSheetBtn = dom?.openCategorySheetBtn || document.getElementById("openCategorySheetBtn");
  if (openCatSheetBtn) {
    openCatSheetBtn.addEventListener("click", () => {
      openCategoryPickerModal();
    });
  }

  const closeCatSheetBtn = dom?.closeCategorySheetBtn || document.getElementById("closeCategorySheetBtn");
  if (closeCatSheetBtn) {
    closeCatSheetBtn.addEventListener("click", () => {
      closeCategoryPickerModal();
    });
  }

  const catModal = dom?.categoryPickerModal || document.getElementById("categoryPickerModal");
  if (catModal) {
    catModal.addEventListener("click", (e) => {
      if (e.target === catModal) {
        closeCategoryPickerModal();
      }
    });
  }

  // 9. 歌单广场内置搜索框绑定
  const squareSearchInput = document.getElementById("squareSearchInput");
  const squareSearchBtn = document.getElementById("squareSearchBtn");
  const doSquareSearch = () => {
    const kw = squareSearchInput ? squareSearchInput.value.trim() : "";
    if (!kw) {
      loadPlaylists(state, dom, callbacks);
      return;
    }
    searchSquarePlaylists(kw, state, dom, callbacks);
  };

  if (squareSearchBtn) {
    squareSearchBtn.addEventListener("click", doSquareSearch);
  }
  if (squareSearchInput) {
    squareSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSquareSearch();
      }
    });
  }

  // 10. 歌单分页上一页/下一页绑定
  const pagePrevBtn = document.getElementById("squarePrevPageBtn");
  const pageNextBtn = document.getElementById("squareNextPageBtn");
  if (pagePrevBtn) {
    pagePrevBtn.addEventListener("click", () => {
      if (currentPage > 0) {
        currentPage--;
        loadPlaylists(state, dom, callbacks);
        const scrollEl = document.getElementById("squareContentScroll");
        if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }
  if (pageNextBtn) {
    pageNextBtn.addEventListener("click", () => {
      currentPage++;
      loadPlaylists(state, dom, callbacks);
      const scrollEl = document.getElementById("squareContentScroll");
      if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  // 预热拉取分类列表
  await loadCategories(state, dom, callbacks);
}

/**
 * 切换选中分类并同步全平台 UI
 */
export function applyCategoryChange(categoryId, state, dom, callbacks = {}) {
  currentCategoryId = String(categoryId);
  currentPage = 0;

  // 1. 同步 native select 下拉值
  const catSelect = document.getElementById("squareCategorySelect");
  if (catSelect && catSelect.value !== currentCategoryId) {
    catSelect.value = currentCategoryId;
  }

  // 2. 同步桌面端横滑标签高亮
  const tagListContainer = document.getElementById("squareCategoryTags");
  if (tagListContainer) {
    tagListContainer.querySelectorAll(".square-tag").forEach((b) => {
      b.classList.toggle("active", String(b.dataset.categoryId) === String(currentCategoryId));
    });
  }

  // 3. 同步分类大厅抽屉中的标签高亮
  const sheetList = document.getElementById("categoryPickerSheetList");
  if (sheetList) {
    sheetList.querySelectorAll(".cat-sheet-chip").forEach((b) => {
      b.classList.toggle("active", String(b.dataset.categoryId) === String(currentCategoryId));
    });
  }

  // 4. 加载歌单
  loadPlaylists(state, dom, callbacks);
}

/**
 * 打开分类大厅抽屉
 */
export function openCategoryPickerModal() {
  const modal = document.getElementById("categoryPickerModal");
  if (!modal) return;
  modal.classList.add("show");
  modal.removeAttribute("hidden");
  modal.setAttribute("aria-hidden", "false");
}

/**
 * 关闭分类大厅抽屉
 */
export function closeCategoryPickerModal() {
  const modal = document.getElementById("categoryPickerModal");
  if (!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("hidden", "");
  modal.setAttribute("aria-hidden", "true");
}

/**
 * 加载当前平台的分类标签
 */
export async function loadCategories(state, dom, callbacks = {}) {
  const tagListContainer = document.getElementById("squareCategoryTags");
  const gridContainer = document.getElementById("squarePlaylistGrid");
  const catSelect = document.getElementById("squareCategorySelect");
  const sheetList = document.getElementById("categoryPickerSheetList");
  if (!tagListContainer) return;

  try {
    tagListContainer.innerHTML = `<span class="square-loading-text"><i class="fas fa-spinner fa-spin"></i> 加载分类中...</span>`;
    if (gridContainer) {
      gridContainer.innerHTML = `
        <div class="square-loading-skeleton">
          <i class="fas fa-circle-notch fa-spin"></i>
          <span>正在获取精选歌单...</span>
        </div>
      `;
    }

    const res = await fetch(`/api/playlist/categories?platform=${currentPlatform}`);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) {
      throw new Error(json.error || "获取分类失败");
    }

    const categories = json.data;
    if (categories.length === 0) {
      tagListContainer.innerHTML = `<span class="square-empty-hint">暂无分类</span>`;
      return;
    }

    // 默认选中第一个分类
    currentCategoryId = String(categories[0].id);

    // ─── A. 渲染桌面端横向分类标签 ──────────────────────────────
    tagListContainer.innerHTML = categories.map((cat, idx) => {
      const isActive = idx === 0 ? "active" : "";
      return `
        <button type="button" class="square-tag ${isActive}" data-category-id="${cat.id}">
          ${cat.name}
        </button>
      `;
    }).join("");

    tagListContainer.querySelectorAll(".square-tag").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyCategoryChange(btn.dataset.categoryId, state, dom, callbacks);
      });
    });

    // ─── B. 分组结构划分 (热门/语种/流派/场景/心情) ──────────
    const groupsMap = new Map();
    categories.forEach((cat) => {
      const grp = cat.group || "推荐";
      if (!groupsMap.has(grp)) groupsMap.set(grp, []);
      groupsMap.get(grp).push(cat);
    });

    // ─── C. 填充原生下拉选择框 (Mobile Native Picker with Optgroups) ─
    if (catSelect) {
      let selectHtml = "";
      for (const [grpName, list] of groupsMap.entries()) {
        selectHtml += `<optgroup label="── ${grpName} ──">`;
        list.forEach((c) => {
          const isSel = String(c.id) === String(currentCategoryId) ? "selected" : "";
          selectHtml += `<option value="${c.id}" ${isSel}>${c.name}</option>`;
        });
        selectHtml += `</optgroup>`;
      }
      catSelect.innerHTML = selectHtml;
    }

    // ─── D. 填充分类大厅矩阵抽屉 (Category Matrix Bottom Sheet) ──
    if (sheetList) {
      let sheetHtml = "";
      for (const [grpName, list] of groupsMap.entries()) {
        sheetHtml += `
          <div class="cat-sheet-group">
            <div class="cat-sheet-group-title">
              <span class="cat-group-pill">${grpName}</span>
            </div>
            <div class="cat-sheet-group-grid">
              ${list.map(c => `
                <button type="button" class="cat-sheet-chip ${String(c.id) === String(currentCategoryId) ? 'active' : ''}" data-category-id="${c.id}">
                  ${c.name}
                </button>
              `).join("")}
            </div>
          </div>
        `;
      }
      sheetList.innerHTML = sheetHtml;

      sheetList.querySelectorAll(".cat-sheet-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.categoryId;
          applyCategoryChange(id, state, dom, callbacks);
          closeCategoryPickerModal();
        });
      });
    }

    // 载入歌单
    await loadPlaylists(state, dom, callbacks);
  } catch (err) {
    console.error("[Square] 加载分类失败:", err);
    tagListContainer.innerHTML = `<span class="square-error-hint">分类加载失败，请重试</span>`;
  }
}

/**
 * 加载分类下的歌单列表 (支持请求取消与竞态覆盖，杜绝卡死)
 */
export async function loadPlaylists(state, dom, callbacks = {}) {
  const gridContainer = document.getElementById("squarePlaylistGrid");
  if (!gridContainer) return;

  // 取消上一次进行中的未完成请求，确保最新操作立刻生效
  if (playlistAbortController) {
    try {
      playlistAbortController.abort();
    } catch (_) {}
  }
  playlistAbortController = new AbortController();
  const currentSeq = ++activeRequestSeq;

  gridContainer.innerHTML = `
    <div class="square-loading-skeleton">
      <i class="fas fa-circle-notch fa-spin"></i>
      <span>正在获取精选歌单...</span>
    </div>
  `;

  try {
    const res = await fetch(`/api/playlist/list?platform=${currentPlatform}&category_id=${encodeURIComponent(currentCategoryId)}&page=${currentPage}&limit=30`, {
      signal: playlistAbortController.signal,
    });
    const json = await res.json();

    // 如果不是当前最新的请求，静默丢弃
    if (currentSeq !== activeRequestSeq) return;

    if (!json.success || !Array.isArray(json.data)) {
      throw new Error(json.error || "获取歌单列表失败");
    }

    const playlists = json.data;
    const paginationEl = document.getElementById("squarePagination");
    const pagePrevBtn = document.getElementById("squarePrevPageBtn");
    const pageNextBtn = document.getElementById("squareNextPageBtn");
    const pageInfoEl = document.getElementById("squarePageInfo");

    if (paginationEl) {
      paginationEl.style.display = "flex";
      if (pagePrevBtn) pagePrevBtn.disabled = (currentPage === 0);
      if (pageNextBtn) pageNextBtn.disabled = (playlists.length < 30);
      if (pageInfoEl) pageInfoEl.textContent = `第 ${currentPage + 1} 页`;
    }

    if (playlists.length === 0) {
      if (currentPage > 0) {
        gridContainer.innerHTML = `<div class=\"square-empty-state\"><i class=\"fas fa-music\"></i><span>没有更多歌单了</span></div>`;
      } else {
        gridContainer.innerHTML = `<div class=\"square-empty-state\"><i class=\"fas fa-music\"></i><span>该分类下暂无歌单</span></div>`;
      }
      if (pageNextBtn) pageNextBtn.disabled = true;
      return;
    }

    gridContainer.innerHTML = playlists.map((item) => {
      const coverUrl = item.cover || "/favicon.png";
      const playCountStr = formatPlayCount(item.playCount);
      return `
        <div class="square-card" data-playlist-id="${item.id}">
          <div class="square-card-cover-wrap">
            <img class="square-card-cover" src="${coverUrl}" alt="${item.title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/favicon.png'" />
            <span class="square-card-badge"><i class="fas fa-play"></i> ${playCountStr}</span>
            <button type="button" class="square-card-play-btn" title="查看歌单详情" aria-label="查看歌单详情">
              <svg class="apple-svg-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.28l10.5-6.5a1.5 1.5 0 0 0 0-2.56L9.3 4.22A1.5 1.5 0 0 0 7 5.5z"/></svg>
            </button>
          </div>
          <div class="square-card-info">
            <h4 class="square-card-title" title="${item.title}">${item.title}</h4>
            <span class="square-card-creator">${item.creator || "官方推荐"}</span>
          </div>
        </div>
      `;
    }).join("");

    // 绑定卡片点击打开详情
    gridContainer.querySelectorAll(".square-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.playlistId;
        const platform = card.dataset.platform || currentPlatform;
        openPlaylistDetailModal(id, state, dom, callbacks, platform);
      });
    });

  } catch (err) {
    if (err.name === "AbortError") return; // 主动取消不报错
    if (currentSeq !== activeRequestSeq) return;
    console.error("[Square] 加载歌单列表失败:", err);
    gridContainer.innerHTML = `<div class="square-error-state"><i class="fas fa-exclamation-triangle"></i><span>歌单加载失败，请重试</span></div>`;
  }
}

/**
 * 歌单广场内置全网/多源歌单搜索
 */
export async function searchSquarePlaylists(keyword, state, dom, callbacks = {}) {
  const gridContainer = document.getElementById("squarePlaylistGrid");
  if (!gridContainer || !keyword.trim()) return;

  if (playlistAbortController) {
    try {
      playlistAbortController.abort();
    } catch (_) {}
  }
  playlistAbortController = new AbortController();
  const currentSeq = ++activeRequestSeq;

  gridContainer.innerHTML = `
    <div class="square-loading-skeleton">
      <i class="fas fa-circle-notch fa-spin"></i>
      <span>正在搜索「${keyword}」相关精选歌单...</span>
    </div>
  `;

  try {
    const res = await fetch(`/api/playlist/search?source=${currentPlatform}&keyword=${encodeURIComponent(keyword)}&page=1&limit=30`, {
      signal: playlistAbortController.signal,
    });
    const json = await res.json();

    if (currentSeq !== activeRequestSeq) return;

    if (!json.success || !Array.isArray(json.data)) {
      throw new Error(json.error || "搜索歌单失败");
    }

    const playlists = json.data;
    const paginationEl = document.getElementById("squarePagination");
    if (paginationEl) {
      paginationEl.style.display = "none"; // 搜索结果隐藏翻页
    }
    if (playlists.length === 0) {
      gridContainer.innerHTML = `<div class="square-empty-state"><i class="fas fa-search"></i><span>未找到「${keyword}」相关的歌单</span></div>`;
      return;
    }

    gridContainer.innerHTML = playlists.map((item) => {
      const coverUrl = item.cover || "/favicon.png";
      const playCountStr = formatPlayCount(item.playCount);
      const tagText = item.platform_name || PLATFORM_NAMES[item.platform] || item.platform || "";
      return `
        <div class="square-card" data-playlist-id="${item.id}" data-platform="${item.platform || currentPlatform}">
          <div class="square-card-cover-wrap">
            <img class="square-card-cover" src="${coverUrl}" alt="${item.title}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/favicon.png'" />
            <span class="square-card-badge"><i class="fas fa-play"></i> ${playCountStr}</span>
            ${tagText ? `<span class="square-card-badge" style="top:8px;bottom:auto;left:8px;background:rgba(0,0,0,0.65);">${tagText}</span>` : ""}
            <button type="button" class="square-card-play-btn" title="查看歌单详情" aria-label="查看歌单详情">
              <svg class="apple-svg-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.28l10.5-6.5a1.5 1.5 0 0 0 0-2.56L9.3 4.22A1.5 1.5 0 0 0 7 5.5z"/></svg>
            </button>
          </div>
          <div class="square-card-info">
            <h4 class="square-card-title" title="${item.title}">${item.title}</h4>
            <span class="square-card-creator">${item.creator || "精选歌单"}</span>
          </div>
        </div>
      `;
    }).join("");

    gridContainer.querySelectorAll(".square-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.playlistId;
        const platform = card.dataset.platform || currentPlatform;
        openPlaylistDetailModal(id, state, dom, callbacks, platform);
      });
    });

  } catch (err) {
    if (err.name === "AbortError") return;
    if (currentSeq !== activeRequestSeq) return;
    console.error("[Square Search] 搜索歌单失败:", err);
    gridContainer.innerHTML = `<div class="square-error-state"><i class="fas fa-exclamation-triangle"></i><span>歌单搜索出错，请重试</span></div>`;
  }
}

/**
 * 打开歌单详情弹窗
 */
export async function openPlaylistDetailModal(playlistId, state, dom, callbacks = {}, targetPlatform = null) {
  const modal = document.getElementById("playlistDetailModal");
  if (!modal) return;

  const header = document.getElementById("modalPlaylistHeader");
  const songList = document.getElementById("modalPlaylistSongs");
  const playAllBtn = document.getElementById("modalPlayAllBtn");
  const appendAllBtn = document.getElementById("modalAppendAllBtn");

  modal.classList.add("show");
  modal.removeAttribute("hidden");
  modal.setAttribute("aria-hidden", "false");

  if (header) {
    header.innerHTML = `
      <div class="modal-pl-loading">
        <i class="fas fa-spinner fa-spin"></i>
        <span>正在加载歌单内容...</span>
      </div>
    `;
  }
  if (songList) songList.innerHTML = "";
  if (playAllBtn) playAllBtn.disabled = true;
  if (appendAllBtn) appendAllBtn.disabled = true;

  try {
    const pl = targetPlatform || currentPlatform;
    const res = await fetch(`/api/playlist/detail?platform=${pl}&id=${encodeURIComponent(playlistId)}`);
    const json = await res.json();
    if (!json.success || !json.data) {
      throw new Error(json.error || "获取歌单内容失败");
    }

    currentPlaylistDetail = json.data;
    const { title, cover, creator, desc, songs } = currentPlaylistDetail;

    if (header) {
      header.innerHTML = `
        <div class="modal-pl-meta">
          <img class="modal-pl-cover" src="${cover || '/favicon.png'}" alt="${title}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/favicon.png'" />
          <div class="modal-pl-details">
            <span class="modal-pl-platform-badge">${PLATFORM_NAMES[currentPlatform] || currentPlatform}</span>
            <h3 class="modal-pl-title">${title}</h3>
            <p class="modal-pl-creator"><i class="fas fa-user-circle"></i> ${creator || '未知创作者'} · 共 ${songs.length} 首歌</p>
            ${desc ? `<p class="modal-pl-desc" title="${desc}">${desc}</p>` : ''}
          </div>
        </div>
      `;
    }

    if (songList) {
      if (songs.length === 0) {
        songList.innerHTML = `<div class="modal-pl-empty">暂无曲目信息</div>`;
      } else {
        songList.innerHTML = songs.map((s, idx) => {
          return `
            <div class="modal-pl-song-row" data-song-index="${idx}">
              <span class="modal-pl-song-idx">${idx + 1}</span>
              <div class="modal-pl-song-main">
                <span class="modal-pl-song-name">${s.name}</span>
                <span class="modal-pl-song-artist">${s.artist} ${s.album ? `— 《${s.album}》` : ''}</span>
              </div>
              <button type="button" class="modal-pl-cpl-btn" data-square-action="add-to-cpl" data-song-index="${idx}" title="添加到我的歌单">
                <i class="fas fa-folder-plus"></i>
              </button>
              <button type="button" class="modal-pl-single-play" title="播放此歌曲">
                <svg class="apple-svg-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.28l10.5-6.5a1.5 1.5 0 0 0 0-2.56L9.3 4.22A1.5 1.5 0 0 0 7 5.5z"/></svg>
              </button>
            </div>
          `;
        }).join("");

        // 绑定单曲点播与添加到自定义歌单
        songList.querySelectorAll(".modal-pl-song-row").forEach((row) => {
          row.addEventListener("click", (e) => {
            const cplBtn = e.target.closest("[data-square-action='add-to-cpl']");
            const idx = parseInt(row.dataset.songIndex, 10);
            if (cplBtn) {
              e.stopPropagation();
              const targetSong = songs[idx];
              if (targetSong && typeof callbacks.addToPlaylist === "function") {
                callbacks.addToPlaylist(targetSong);
              }
              return;
            }
            playSingleFromModal(idx, state, dom, callbacks);
          });
        });
      }
    }

    if (playAllBtn) {
      playAllBtn.disabled = false;
      playAllBtn.onclick = () => playAllFromModal(state, dom, callbacks, true);
    }
    if (appendAllBtn) {
      appendAllBtn.disabled = false;
      appendAllBtn.onclick = () => playAllFromModal(state, dom, callbacks, false);
    }

  } catch (err) {
    console.error("[Square Detail] 加载失败:", err);
    if (header) {
      header.innerHTML = `<div class="modal-pl-error">歌单详情加载失败：${err.message}</div>`;
    }
  }
}

export function closePlaylistDetailModal() {
  const modal = document.getElementById("playlistDetailModal");
  if (!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("hidden", "");
  modal.setAttribute("aria-hidden", "true");
  currentPlaylistDetail = null;
}

/**
 * 将歌单内的歌曲载入到当前播放列表并播放
 * @param {boolean} replaceAll 是否替换全部现有队列
 */
function playAllFromModal(state, dom, callbacks = {}, replaceAll = true) {
  if (!currentPlaylistDetail || !Array.isArray(currentPlaylistDetail.songs) || currentPlaylistDetail.songs.length === 0) {
    return;
  }

  const songs = currentPlaylistDetail.songs.map((s) => ({
    id: s.id,
    name: s.name,
    artist: s.artist,
    album: s.album,
    source: s.platform || currentPlatform || "qq",
    platform: s.platform || currentPlatform || "qq",
    pic: s.cover || "",
    pic_id: s.songMid || s.id,
    url_id: s.songId || s.id,
    lyric_id: s.id,
  }));

  if (!Array.isArray(state.playlistSongs)) {
    state.playlistSongs = [];
  }

  if (replaceAll) {
    state.playlistSongs = [...songs];
    state.currentTrackIndex = 0;
    state.currentPlaylist = "playlist";
    state.currentList = "playlist";

    if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
    if (typeof callbacks.renderPlaylist === "function") callbacks.renderPlaylist();

    closePlaylistDetailModal();
    showNotification(`已载入《${currentPlaylistDetail.title}》共 ${songs.length} 首歌`, "success", dom);

    if (typeof callbacks.playTrackByIndex === "function") {
      callbacks.playTrackByIndex(0);
    }
  } else {
    const existingKeys = new Set(
      state.playlistSongs.map(getSongKey).filter((k) => typeof k === "string" && k !== "")
    );
    let added = 0;
    songs.forEach((s) => {
      const k = getSongKey(s);
      if (!k || !existingKeys.has(k)) {
        state.playlistSongs.push(s);
        if (k) existingKeys.add(k);
        added++;
      }
    });

    if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
    if (typeof callbacks.renderPlaylist === "function") callbacks.renderPlaylist();

    closePlaylistDetailModal();
    showNotification(`已将 ${added} 首歌曲追加到播放列表`, "success", dom);
  }
}

/**
 * 从弹窗点播单曲
 */
function playSingleFromModal(songIndex, state, dom, callbacks = {}) {
  if (!currentPlaylistDetail || !currentPlaylistDetail.songs || !currentPlaylistDetail.songs[songIndex]) {
    return;
  }
  const s = currentPlaylistDetail.songs[songIndex];
  const songObj = {
    id: s.id,
    name: s.name,
    artist: s.artist,
    album: s.album,
    source: s.platform || currentPlatform || "qq",
    platform: s.platform || currentPlatform || "qq",
    pic: s.cover || "",
    pic_id: s.songMid || s.id,
    url_id: s.songId || s.id,
    lyric_id: s.id,
  };

  if (!Array.isArray(state.playlistSongs)) {
    state.playlistSongs = [];
  }

  // 插入或找到该歌曲位置
  let targetIndex = state.playlistSongs.findIndex((item) => String(item.id) === String(songObj.id) && item.name === songObj.name);
  if (targetIndex === -1) {
    state.playlistSongs.splice(state.currentTrackIndex + 1, 0, songObj);
    targetIndex = state.currentTrackIndex + 1;
  }

  state.currentTrackIndex = targetIndex;
  state.currentPlaylist = "playlist";
  state.currentList = "playlist";

  if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
  if (typeof callbacks.renderPlaylist === "function") callbacks.renderPlaylist();

  closePlaylistDetailModal();
  showNotification(`开始播放: ${songObj.name}`, "success", dom);

  if (typeof callbacks.playTrackByIndex === "function") {
    callbacks.playTrackByIndex(targetIndex);
  }
}
