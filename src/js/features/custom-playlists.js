/**
 * AuraMusic 自定义歌单管理模块 (Custom Playlists)
 * 支持用户创建多个自定义歌单、歌曲一键归档、D1 音频直链持久化与秒播探活
 */

import { getSongKey } from "./playlist.js";
import { showNotification } from "./settings.js";

export function ensureCustomPlaylistsArray(state) {
    if (!Array.isArray(state.customPlaylists)) {
        state.customPlaylists = [];
    }
    return state.customPlaylists;
}

export function getPlaylistById(playlistId, state) {
    const list = ensureCustomPlaylistsArray(state);
    return list.find(p => p.id === playlistId) || null;
}

export function saveCustomPlaylistsState(state, callbacks = {}) {
    ensureCustomPlaylistsArray(state);
    if (typeof callbacks.saveCustomPlaylists === "function") {
        callbacks.saveCustomPlaylists();
    }
}

/**
 * 创建新自定义歌单
 */
export function createCustomPlaylist(name, state, callbacks = {}) {
    const playlists = ensureCustomPlaylistsArray(state);
    const trimmed = (name || "").trim();
    const finalName = trimmed || `我的歌单 ${playlists.length + 1}`;

    const newPlaylist = {
        id: "cpl_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
        name: finalName,
        createdAt: Date.now(),
        songs: []
    };

    playlists.push(newPlaylist);
    saveCustomPlaylistsState(state, callbacks);
    showNotification(`歌单【${finalName}】创建成功`);
    return newPlaylist;
}

/**
 * 删除歌单
 */
export function deleteCustomPlaylist(playlistId, state, dom, callbacks = {}) {
    const playlists = ensureCustomPlaylistsArray(state);
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx < 0) return false;

    const [deleted] = playlists.splice(idx, 1);
    saveCustomPlaylistsState(state, callbacks);

    if (state.activeCustomPlaylistDetailId === playlistId) {
        state.activeCustomPlaylistDetailId = null;
    }

    if (state.currentList === "custom" && state.currentCustomPlaylistId === playlistId) {
        state.currentList = "playlist";
        state.currentCustomPlaylistId = null;
    }

    showNotification(`已删除歌单【${deleted.name}】`);
    renderCustomPlaylists(state, dom, callbacks);
    return true;
}

/**
 * 重命名歌单
 */
export function renameCustomPlaylist(playlistId, newName, state, dom, callbacks = {}) {
    const pl = getPlaylistById(playlistId, state);
    if (!pl) return false;

    const trimmed = (newName || "").trim();
    if (!trimmed) {
        showNotification("歌单名称不能为空");
        return false;
    }

    pl.name = trimmed;
    saveCustomPlaylistsState(state, callbacks);
    showNotification(`歌单已重命名为【${trimmed}】`);
    renderCustomPlaylists(state, dom, callbacks);
    return true;
}

/**
 * 添加歌曲到指定歌单（自动继承与记录音频直链，持久化至 D1）
 */
export function addSongToCustomPlaylist(playlistId, song, state, callbacks = {}) {
    if (!song) return { success: false, reason: "无效歌曲" };
    const pl = getPlaylistById(playlistId, state);
    if (!pl) return { success: false, reason: "歌单不存在" };

    if (!Array.isArray(pl.songs)) pl.songs = [];

    const targetKey = getSongKey(song);
    const exists = pl.songs.some(item => getSongKey(item) === targetKey);
    if (exists) {
        return { success: false, alreadyExists: true, playlistName: pl.name };
    }

    // 继承音频直链：若歌曲带有 audioUrl，或当前正在播放、或收藏夹中已存有该歌曲有效直链，直接写入该歌单并同步 D1
    let candidateAudioUrl = song.audioUrl || "";
    if (!candidateAudioUrl && state.currentSong && getSongKey(state.currentSong) === targetKey) {
        candidateAudioUrl = state.currentAudioUrl || "";
    }
    if (!candidateAudioUrl && Array.isArray(state.favoriteSongs)) {
        const fav = state.favoriteSongs.find(item => getSongKey(item) === targetKey);
        if (fav && fav.audioUrl) candidateAudioUrl = fav.audioUrl;
    }

    const newSongItem = {
        id: song.id,
        name: song.name,
        artist: song.artist,
        album: song.album || "",
        pic_id: song.pic_id || song.id,
        pic: song.pic || "",
        url_id: song.url_id || song.id,
        lyric_id: song.lyric_id || song.id,
        source: song.source || "netease",
        source_name: song.source_name || "",
        duration: song.duration || 0,
        formats: song.formats || ["128k", "320k"],
        audioUrl: candidateAudioUrl
    };

    pl.songs.push(newSongItem);
    saveCustomPlaylistsState(state, callbacks);
    return { success: true, playlistName: pl.name };
}

/**
 * 从歌单中移除歌曲
 */
export function removeSongFromCustomPlaylist(playlistId, songIndex, state, dom, callbacks = {}) {
    const pl = getPlaylistById(playlistId, state);
    if (!pl || !Array.isArray(pl.songs) || songIndex < 0 || songIndex >= pl.songs.length) return;

    const [removed] = pl.songs.splice(songIndex, 1);
    saveCustomPlaylistsState(state, callbacks);

    if (state.currentList === "custom" && state.currentCustomPlaylistId === playlistId) {
        if (pl.songs.length === 0) {
            state.currentList = "playlist";
            state.currentCustomPlaylistId = null;
        } else if (state.currentCustomSongIndex >= pl.songs.length) {
            state.currentCustomSongIndex = pl.songs.length - 1;
        }
    }

    showNotification(`已从【${pl.name}】移除《${removed.name}》`);
    renderCustomPlaylists(state, dom, callbacks);
}

/**
 * 播放整张自定义歌单或指定单曲
 */
export async function playCustomPlaylist(playlistId, startIndex = 0, state, dom, callbacks = {}) {
    const pl = getPlaylistById(playlistId, state);
    if (!pl || !Array.isArray(pl.songs) || pl.songs.length === 0) {
        showNotification("歌单内暂无歌曲");
        return;
    }

    const safeIndex = Math.max(0, Math.min(startIndex, pl.songs.length - 1));
    state.currentList = "custom";
    state.currentCustomPlaylistId = playlistId;
    state.currentCustomSongIndex = safeIndex;

    const song = pl.songs[safeIndex];
    if (typeof callbacks.playSong === "function") {
        await callbacks.playSong(song, { isCustomPlaylist: true });
    }
    renderCustomPlaylists(state, dom, callbacks);
}

/**
 * 渲染自定义歌单主面板（列表视图或详情视图）
 */
export function renderCustomPlaylists(state, dom, callbacks = {}) {
    const container = dom.customPlaylists || document.getElementById("customPlaylists");
    if (!container) return;

    const playlists = ensureCustomPlaylistsArray(state);
    const listEl = dom.customPlaylistsList || container.querySelector("#customPlaylistsList");
    const detailEl = dom.customPlaylistDetail || container.querySelector("#customPlaylistDetail");

    // 1. 如果处于详情视图
    if (state.activeCustomPlaylistDetailId) {
        const activePl = getPlaylistById(state.activeCustomPlaylistDetailId, state);
        if (!activePl) {
            state.activeCustomPlaylistDetailId = null;
            return renderCustomPlaylists(state, dom, callbacks);
        }

        if (listEl) listEl.hidden = true;
        if (detailEl) {
            detailEl.hidden = false;
            renderCustomPlaylistDetail(activePl, state, dom, callbacks);
        }
        container.classList.remove("empty");
        return;
    }

    // 2. 处于歌单列表视图
    if (detailEl) detailEl.hidden = true;
    if (listEl) {
        listEl.hidden = false;
        if (playlists.length === 0) {
            container.classList.add("empty");
            listEl.innerHTML = `
                <div class="custom-playlists-empty-tip">
                    <div class="empty-icon"><i class="fas fa-folder-plus"></i></div>
                    <div class="empty-title">暂无自定义歌单</div>
                    <div class="empty-desc">点击右上角【＋】创建歌单，在任意歌曲上点击【<i class="fas fa-folder-plus"></i>】即可快速归档！</div>
                </div>
            `;
            return;
        }

        container.classList.remove("empty");
        const cardsHtml = playlists.map((pl) => {
            const count = Array.isArray(pl.songs) ? pl.songs.length : 0;
            const firstSong = count > 0 ? pl.songs[0] : null;
            const coverHtml = firstSong && firstSong.pic
                ? `<img src="${firstSong.pic}" class="cpl-card-cover" alt="" loading="lazy" />`
                : `<div class="cpl-card-cover-placeholder"><i class="fas fa-music"></i></div>`;
            const isPlayingThis = state.currentList === "custom" && state.currentCustomPlaylistId === pl.id;

            return `
            <div class="custom-playlist-card${isPlayingThis ? ' is-playing' : ''}" data-id="${pl.id}">
                <div class="cpl-card-media">
                    ${coverHtml}
                    <button class="cpl-card-play-btn" type="button" data-action="play-playlist" data-id="${pl.id}" title="播放整张歌单" aria-label="播放整张歌单">
                        <i class="fas fa-play"></i>
                    </button>
                </div>
                <div class="cpl-card-info" data-action="view-detail" data-id="${pl.id}">
                    <div class="cpl-card-title" title="${pl.name}">${pl.name}</div>
                    <div class="cpl-card-meta">${count} 首歌曲</div>
                </div>
                <div class="cpl-card-actions">
                    <button class="cpl-card-opt-btn" type="button" data-action="rename-playlist" data-id="${pl.id}" title="重命名歌单" aria-label="重命名歌单">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="cpl-card-opt-btn" type="button" data-action="delete-playlist" data-id="${pl.id}" title="删除歌单" aria-label="删除歌单">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            `;
        }).join("");

        listEl.innerHTML = cardsHtml;
    }
}

/**
 * 渲染某个歌单的详情歌曲列表
 */
export function renderCustomPlaylistDetail(playlist, state, dom, callbacks = {}) {
    const container = dom.customPlaylists || document.getElementById("customPlaylists");
    if (!container) return;

    const titleEl = container.querySelector("#customPlaylistDetailTitle");
    const countEl = container.querySelector("#customPlaylistDetailCount");
    const songsContainer = container.querySelector("#customPlaylistSongs");

    if (titleEl) titleEl.textContent = playlist.name;
    const songs = Array.isArray(playlist.songs) ? playlist.songs : [];
    if (countEl) countEl.textContent = `${songs.length} 首歌曲`;

    if (!songsContainer) return;

    if (songs.length === 0) {
        songsContainer.innerHTML = `
            <div class="custom-playlists-empty-tip">
                <div class="empty-icon"><i class="fas fa-music"></i></div>
                <div class="empty-title">歌单内暂无歌曲</div>
                <div class="empty-desc">在任意歌曲右侧点击【<i class="fas fa-folder-plus"></i>】添加到此歌单吧！</div>
            </div>
        `;
        return;
    }

    const songsHtml = songs.map((song, index) => {
        const artistValue = Array.isArray(song.artist) ? song.artist.join(", ") : (song.artist || "未知艺术家");
        const isCurrent = state.currentList === "custom" &&
                          state.currentCustomPlaylistId === playlist.id &&
                          index === state.currentCustomSongIndex;
        const songKey = getSongKey(song) || `cpl-${playlist.id}-${index}`;
        const hasCachedUrl = Boolean(song.audioUrl && song.audioUrl.startsWith("http"));

        return `
        <div class="playlist-item${isCurrent ? ' current' : ''}" data-index="${index}" role="button" tabindex="0" aria-label="播放 ${song.name}" data-favorite-key="${songKey}">
            <div class="playlist-item-info">
                <span class="playlist-item-title">${song.name}</span>
                <span class="playlist-item-artist"> - ${artistValue}</span>
                ${hasCachedUrl ? '<span class="d1-cached-pill" title="已记录高保真直链至 D1 数据库，秒开免解析">D1秒开</span>' : ''}
            </div>
            <div class="playlist-item-actions" role="toolbar" aria-label="歌曲操作">
                <button class="playlist-item-action playlist-item-action--refresh" type="button" data-cpl-action="refresh-song" data-index="${index}" title="清理缓存并重新获取" aria-label="清理缓存并重新获取">
                    <i class="fas fa-arrows-rotate"></i>
                </button>
                <button class="playlist-item-favorite favorite-toggle" type="button" data-cpl-action="toggle-favorite" data-index="${index}" title="收藏" aria-label="收藏">
                    <i class="fa-regular fa-heart"></i>
                </button>
                <button class="playlist-item-action playlist-item-action--add" type="button" data-cpl-action="add-to-queue" data-index="${index}" title="添加到播放列表" aria-label="添加到播放列表">
                    <i class="fas fa-plus"></i>
                </button>
                <button class="playlist-item-remove" type="button" data-cpl-action="remove-song" data-index="${index}" title="从歌单移除" aria-label="从歌单移除">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>
        `;
    }).join("");

    songsContainer.innerHTML = songsHtml;
}

/**
 * 打开“添加到歌单”轻量弹窗
 */
export function openAddToPlaylistModal(song, state, dom, callbacks = {}) {
    if (!song) return;
    const modal = dom.addToPlaylistModal || document.getElementById("addToPlaylistModal");
    if (!modal) return;

    const previewEl = modal.querySelector("#addToPlaylistSongPreview");
    if (previewEl) {
        const artistText = Array.isArray(song.artist) ? song.artist.join(", ") : (song.artist || "未知艺术家");
        previewEl.innerHTML = `
            <span class="preview-song-name">${song.name || '未知歌曲'}</span>
            <span class="preview-song-artist"> - ${artistText}</span>
        `;
    }

    const input = modal.querySelector("#quickPlaylistNameInput");
    if (input) input.value = "";

    const itemsContainer = modal.querySelector("#addToPlaylistItems");
    const playlists = ensureCustomPlaylistsArray(state);
    const targetKey = getSongKey(song);

    if (itemsContainer) {
        if (playlists.length === 0) {
            itemsContainer.innerHTML = `
                <div class="cpl-modal-empty-tip">暂无歌单，可在上方直接输入名称快速创建！</div>
            `;
        } else {
            itemsContainer.innerHTML = playlists.map(pl => {
                const count = Array.isArray(pl.songs) ? pl.songs.length : 0;
                const alreadyIn = Array.isArray(pl.songs) && pl.songs.some(item => getSongKey(item) === targetKey);
                return `
                <div class="cpl-select-item${alreadyIn ? ' already-added' : ''}" data-id="${pl.id}" role="button" tabindex="0">
                    <div class="cpl-select-item-icon">
                        <i class="fas fa-folder"></i>
                    </div>
                    <div class="cpl-select-item-info">
                        <div class="cpl-select-item-name">${pl.name}</div>
                        <div class="cpl-select-item-count">${count} 首歌曲</div>
                    </div>
                    <div class="cpl-select-item-status">
                        ${alreadyIn ? '<span class="status-added"><i class="fas fa-check"></i> 已在歌单</span>' : '<button type="button" class="status-add-btn">添加</button>'}
                    </div>
                </div>
                `;
            }).join("");
        }
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    modal.__targetSong = song;
}

/**
 * 关闭“添加到歌单”轻量弹窗
 */
export function closeAddToPlaylistModal(dom) {
    const modal = dom?.addToPlaylistModal || document.getElementById("addToPlaylistModal");
    if (modal) {
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
        modal.__targetSong = null;
    }
}

/**
 * 初始化自定义歌单事件监听
 */
export function initCustomPlaylistsUI(state, dom, callbacks = {}) {
    const container = dom.customPlaylists || document.getElementById("customPlaylists");
    if (!container) return;

    // 1. 歌单列表点击事件（播放全部、进入详情、重命名、删除）
    container.addEventListener("click", (e) => {
        const actionBtn = e.target.closest("button[data-action]");
        const detailInfo = e.target.closest("[data-action='view-detail']");
        const cplActionBtn = e.target.closest("button[data-cpl-action]");

        // 详情页歌曲条目操作
        if (cplActionBtn) {
            e.stopPropagation();
            const action = cplActionBtn.dataset.cplAction;
            const index = Number(cplActionBtn.dataset.index);
            const activePl = getPlaylistById(state.activeCustomPlaylistDetailId, state);
            if (!activePl || !activePl.songs[index]) return;
            const targetSong = activePl.songs[index];

            if (action === "refresh-song") {
                if (typeof callbacks.refreshSongCache === "function") {
                    callbacks.refreshSongCache(targetSong);
                }
                return;
            }

            if (action === "toggle-favorite") {
                if (typeof callbacks.toggleFavorite === "function") {
                    callbacks.toggleFavorite(targetSong);
                }
                return;
            }
            if (action === "add-to-queue") {
                if (!Array.isArray(state.playlistSongs)) state.playlistSongs = [];
                const key = getSongKey(targetSong);
                const exists = state.playlistSongs.some(s => getSongKey(s) === key);
                if (!exists) {
                    state.playlistSongs.push({ ...targetSong });
                    if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
                    showNotification(`已添加《${targetSong.name}》到播放列表`);
                } else {
                    showNotification(`《${targetSong.name}》已在播放列表中`);
                }
                return;
            }
            if (action === "remove-song") {
                removeSongFromCustomPlaylist(activePl.id, index, state, dom, callbacks);
                return;
            }
        }

        // 详情页点击歌曲行播放
        const songItem = e.target.closest("#customPlaylistSongs .playlist-item");
        if (songItem && !e.target.closest(".playlist-item-actions")) {
            e.stopPropagation();
            const index = Number(songItem.dataset.index);
            if (state.activeCustomPlaylistDetailId && !Number.isNaN(index)) {
                playCustomPlaylist(state.activeCustomPlaylistDetailId, index, state, dom, callbacks);
            }
            return;
        }

        // 列表页卡片操作
        if (actionBtn) {
            e.stopPropagation();
            const action = actionBtn.dataset.action;
            const id = actionBtn.dataset.id;
            if (action === "play-playlist") {
                playCustomPlaylist(id, 0, state, dom, callbacks);
                return;
            }
            if (action === "rename-playlist") {
                const pl = getPlaylistById(id, state);
                if (pl) {
                    const newName = window.prompt("请输入新的歌单名称：", pl.name);
                    if (newName !== null) {
                        renameCustomPlaylist(id, newName, state, dom, callbacks);
                    }
                }
                return;
            }
            if (action === "delete-playlist") {
                const pl = getPlaylistById(id, state);
                if (pl && window.confirm(`确定要删除歌单【${pl.name}】吗？`)) {
                    deleteCustomPlaylist(id, state, dom, callbacks);
                }
                return;
            }
        }

        // 点击卡片进入详情
        if (detailInfo) {
            e.stopPropagation();
            const id = detailInfo.dataset.id;
            state.activeCustomPlaylistDetailId = id;
            renderCustomPlaylists(state, dom, callbacks);
            return;
        }

        // 详情页头部操作
        const backBtn = e.target.closest("#backToPlaylistsBtn");
        if (backBtn) {
            e.stopPropagation();
            state.activeCustomPlaylistDetailId = null;
            renderCustomPlaylists(state, dom, callbacks);
            return;
        }

        const playAllBtn = e.target.closest("#customPlaylistPlayAllBtn");
        if (playAllBtn && state.activeCustomPlaylistDetailId) {
            e.stopPropagation();
            playCustomPlaylist(state.activeCustomPlaylistDetailId, 0, state, dom, callbacks);
            return;
        }

        const delDetailBtn = e.target.closest("#customPlaylistDeleteBtn");
        if (delDetailBtn && state.activeCustomPlaylistDetailId) {
            e.stopPropagation();
            const pl = getPlaylistById(state.activeCustomPlaylistDetailId, state);
            if (pl && window.confirm(`确定要删除歌单【${pl.name}】吗？`)) {
                deleteCustomPlaylist(state.activeCustomPlaylistDetailId, state, dom, callbacks);
            }
            return;
        }
    });

    // 2. 顶栏【新建歌单】按钮绑定
    const createBtn = document.getElementById("createPlaylistBtn");
    const mobileCreateBtn = document.getElementById("mobileCreatePlaylistBtn");
    const handleCreate = () => {
        const name = window.prompt("请输入新建歌单名称：", `我的歌单 ${(state.customPlaylists || []).length + 1}`);
        if (name !== null) {
            createCustomPlaylist(name, state, callbacks);
            renderCustomPlaylists(state, dom, callbacks);
        }
    };
    if (createBtn) createBtn.addEventListener("click", handleCreate);
    if (mobileCreateBtn) mobileCreateBtn.addEventListener("click", handleCreate);

    // 3. 初始化添加到歌单弹窗事件
    initAddToPlaylistModalEvents(state, dom, callbacks);
}

/**
 * 绑定“添加到歌单”轻量弹窗内部交互
 */
function initAddToPlaylistModalEvents(state, dom, callbacks = {}) {
    const modal = document.getElementById("addToPlaylistModal");
    if (!modal) return;

    const closeBtn = document.getElementById("closeAddToPlaylistBtn");
    if (closeBtn) {
        closeBtn.addEventListener("click", () => closeAddToPlaylistModal(dom));
    }

    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            closeAddToPlaylistModal(dom);
            return;
        }

        // 点击选择某个已有歌单
        const selectItem = e.target.closest(".cpl-select-item");
        if (selectItem && modal.__targetSong) {
            const playlistId = selectItem.dataset.id;
            const res = addSongToCustomPlaylist(playlistId, modal.__targetSong, state, callbacks);
            if (res.success) {
                showNotification(`已添加《${modal.__targetSong.name}》到【${res.playlistName}】`);
                closeAddToPlaylistModal(dom);
                renderCustomPlaylists(state, dom, callbacks);
            } else if (res.alreadyExists) {
                showNotification(`《${modal.__targetSong.name}》已在【${res.playlistName}】中`);
            }
            return;
        }
    });

    // 快速新建并添加
    const quickCreateBtn = document.getElementById("quickCreatePlaylistBtn");
    const quickInput = document.getElementById("quickPlaylistNameInput");
    if (quickCreateBtn && quickInput) {
        const handleQuickCreateAndAdd = () => {
            const val = quickInput.value.trim();
            if (!val) {
                showNotification("请输入歌单名称");
                quickInput.focus();
                return;
            }
            const newPl = createCustomPlaylist(val, state, callbacks);
            if (modal.__targetSong) {
                addSongToCustomPlaylist(newPl.id, modal.__targetSong, state, callbacks);
                showNotification(`已创建【${newPl.name}】并添加歌曲`);
            }
            closeAddToPlaylistModal(dom);
            renderCustomPlaylists(state, dom, callbacks);
        };

        quickCreateBtn.addEventListener("click", handleQuickCreateAndAdd);
        quickInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleQuickCreateAndAdd();
            }
        });
    }
}
