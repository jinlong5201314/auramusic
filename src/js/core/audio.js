/**
 * Solara 核心音频引擎与播放管线 (HTML5 Audio, 播放模式, 进度/音量同步, 自动切歌)
 */

import { API } from "../constants.js";
import { safeSetLocalStorage, preferHttpsUrl, buildAudioProxyUrl } from "./storage.js";
import { showNotification } from "../features/settings.js";
import { getSongKey } from "../features/playlist.js";
import { ensureFavoriteSongsArray } from "../features/favorites.js";
import { lxPluginEngine } from "./source-plugin.js";

export const playModeTexts = {
    "list": "列表循环",
    "single": "单曲循环",
    "random": "随机播放"
};

// 短期音频地址内存缓存（15分钟 TTL），避免用户在播放列表内切歌反复请求 types=url
const audioUrlMemoryCache = new Map();
const AUDIO_URL_CACHE_TTL = 15 * 60 * 1000;

export const APPLE_SVG_ICONS = {
    play: `<svg class="apple-svg-icon icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.28l10.5-6.5a1.5 1.5 0 0 0 0-2.56L9.3 4.22A1.5 1.5 0 0 0 7 5.5z"/></svg>`,
    pause: `<svg class="apple-svg-icon icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1zm11 0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1z"/></svg>`,
    repeatList: `<svg class="apple-svg-icon icon-repeat-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
    repeatSingle: `<svg class="apple-svg-icon icon-repeat-single" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" font-size="9.5" font-weight="900" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>`,
    shuffle: `<svg class="apple-svg-icon shuffle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.6-8.6c.8-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.4c1.3 0 2.5.6 3.3 1.7l1.8 2.3"/><path d="M14.9 14.7l1.8 2.3c.8 1.1 2 1.7 3.3 1.7H22"/><path d="m18 22 4-4-4-4"/></svg>`
};

export function getActivePlayMode(state) {
    return state.currentList === "favorite" ? state.favoritePlayMode : state.playMode;
}

export function getLastNonRandomMode(state) {
    if (state.currentList === "favorite") {
        return state.favoriteLastNonRandomMode || "list";
    }
    return state.playlistLastNonRandomMode || "list";
}

export function rememberLastNonRandomMode(state) {
    const currentMode = getActivePlayMode(state);
    if (currentMode === "random") {
        return;
    }
    const mode = currentMode || "list";
    if (state.currentList === "favorite") {
        state.favoriteLastNonRandomMode = mode;
    } else {
        state.playlistLastNonRandomMode = mode;
    }
}

export function updateShuffleButtonUI(state, dom) {
    const button = dom.shuffleToggleBtn;
    if (!button) {
        return;
    }
    const mode = getActivePlayMode(state);
    const isRandom = mode === "random";
    button.setAttribute("aria-pressed", isRandom ? "true" : "false");
    button.classList.toggle("active", isRandom);
    button.classList.toggle("is-random", isRandom);
    button.innerHTML = APPLE_SVG_ICONS.shuffle;
    const label = isRandom ? "随机播放：已开启 (点击关闭)" : "随机播放：已关闭 (点击开启)";
    button.title = label;
    button.setAttribute("aria-label", label);
}

export function updatePlayModeUI(state, dom) {
    const mode = getActivePlayMode(state);
    if (dom.playModeBtn) {
        const isSingle = mode === "single";
        const isRandom = mode === "random";
        if (isSingle) {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.repeatSingle;
        } else if (isRandom) {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.shuffle;
        } else {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.repeatList;
        }
        dom.playModeBtn.classList.toggle("is-single", isSingle);
        dom.playModeBtn.classList.toggle("is-random", isRandom);
        dom.playModeBtn.classList.toggle("active", isSingle || isRandom);
        dom.playModeBtn.setAttribute("aria-pressed", (isSingle || isRandom) ? "true" : "false");
        const label = isSingle ? "当前模式：单曲循环" : (isRandom ? "当前模式：随机播放" : "当前模式：列表循环");
        dom.playModeBtn.title = label;
        dom.playModeBtn.setAttribute("aria-label", label);
    }
    updateShuffleButtonUI(state, dom);
}

export function setPlayMode(mode, state, dom, callbacks = {}, { announce = true } = {}) {
    const validModes = ["list", "single", "random"];
    if (!validModes.includes(mode)) {
        return getActivePlayMode(state);
    }
    const isFavoriteList = state.currentList === "favorite";
    const key = isFavoriteList ? "favoritePlayMode" : "playMode";
    const previousMode = state[key];
    if (previousMode === mode) {
        updatePlayModeUI(state, dom);
        return mode;
    }

    state[key] = mode;
    if (mode !== "random") {
        if (isFavoriteList) {
            state.favoriteLastNonRandomMode = mode;
        } else {
            state.playlistLastNonRandomMode = mode;
        }
    }

    if (isFavoriteList) {
        if (typeof callbacks.saveFavoriteState === "function") callbacks.saveFavoriteState();
    } else {
        if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
    }

    updatePlayModeUI(state, dom);

    const modeText = playModeTexts[mode] || playModeTexts.list;
    window.__solaraDebugLog?.(`[模式切换] 播放模式已切换为: ${modeText}`);

    if (announce) {
        showNotification(`播放模式: ${modeText}`, "info", dom);
    }

    return mode;
}

export function togglePlayMode(state, dom, callbacks = {}, isMobileView = false) {
    const modes = isMobileView ? ["list", "single", "random"] : ["list", "single"];
    const currentMode = getActivePlayMode(state);
    let currentIndex = modes.indexOf(currentMode);
    if (currentIndex === -1) {
        currentIndex = 0;
    }
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    if (nextMode === "random") {
        rememberLastNonRandomMode(state);
    }
    setPlayMode(nextMode, state, dom, callbacks);
}

export function toggleShuffleMode(state, dom, callbacks = {}) {
    const currentMode = getActivePlayMode(state);
    if (currentMode === "random") {
        const fallback = getLastNonRandomMode(state);
        setPlayMode(fallback, state, dom, callbacks);
        return;
    }
    rememberLastNonRandomMode(state);
    setPlayMode("random", state, dom, callbacks);
}

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "00:00";
    }
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function updatePlayPauseButton(dom) {
    if (!dom.playPauseBtn || !dom.audioPlayer) return;
    const isPlaying = !dom.audioPlayer.paused && !dom.audioPlayer.ended;
    dom.playPauseBtn.innerHTML = isPlaying ? APPLE_SVG_ICONS.pause : APPLE_SVG_ICONS.play;
    dom.playPauseBtn.title = isPlaying ? "暂停" : "播放";
    if (typeof document !== "undefined" && document.body) {
        document.body.classList.toggle("is-playing", isPlaying);
    }
    const visualizer = typeof document !== "undefined" ? document.getElementById("audioVisualizer") : null;
    if (visualizer) {
        visualizer.classList.toggle("playing", isPlaying);
    }
}

export function updateProgressBarBackground(dom, value = Number(dom.progressBar?.value), max = Number(dom.progressBar?.max)) {
    if (!dom.progressBar) return;
    const duration = Number.isFinite(max) && max > 0 ? max : 0;
    const progressValue = Number.isFinite(value) ? Math.max(value, 0) : 0;
    const percent = duration > 0 ? Math.min(progressValue / duration, 1) * 100 : 0;
    dom.progressBar.style.setProperty("--progress", `${percent}%`);
}

export function updateVolumeSliderBackground(dom, volume = dom.audioPlayer?.volume) {
    if (!dom.volumeSlider) return;
    const clamped = Math.min(Math.max(Number.isFinite(volume) ? volume : 0, 0), 1);
    dom.volumeSlider.style.setProperty("--volume-progress", `${clamped * 100}%`);
}

export function updateVolumeIcon(dom, volume) {
    if (!dom.volumeIcon) return;
    const clamped = Math.min(Math.max(Number.isFinite(volume) ? volume : 0, 0), 1);
    
    // 如果是 SVG 图标（Apple 矢量图标），动态更新内部矢量路径
    if (dom.volumeIcon.tagName && dom.volumeIcon.tagName.toLowerCase() === "svg") {
        if (clamped === 0) {
            // 静音状态 (扬声器 + 叉号)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>';
        } else if (clamped < 0.4) {
            // 低音量状态 (扬声器 + 单波纹)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
        } else {
            // 高音量状态 (扬声器 + 双波纹)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
        }
        return;
    }

    // 兼容普通 <i> 标签（FontAwesome）
    let icon = "fa-volume-high";
    if (clamped === 0) {
        icon = "fa-volume-xmark";
    } else if (clamped < 0.4) {
        icon = "fa-volume-low";
    }
    dom.volumeIcon.setAttribute("class", `fas ${icon}`);
}

export function setAudioCurrentTime(time, state, dom) {
    if (!Number.isFinite(time) || !dom.audioPlayer) return;
    const duration = dom.audioPlayer.duration || Number(dom.progressBar?.max) || 0;
    const clamped = duration > 0 ? Math.min(Math.max(time, 0), duration) : Math.max(time, 0);
    try {
        dom.audioPlayer.currentTime = clamped;
    } catch (error) {
        console.warn("设置播放进度失败", error);
    }
    if (dom.progressBar) dom.progressBar.value = clamped;
    if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(clamped);
    updateProgressBarBackground(dom, clamped, duration);
    if (state.currentList === "favorite") {
        state.favoritePlaybackTime = clamped;
    } else {
        state.currentPlaybackTime = clamped;
    }
}

export function waitForAudioReady(player) {
    if (!player) return Promise.resolve();
    if (player.readyState >= 1) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            player.removeEventListener('loadedmetadata', onLoaded);
            player.removeEventListener('error', onError);
        };
        const onLoaded = () => {
            cleanup();
            if (player.duration > 0 && player.duration < 15 && (player.src.includes('kuwo') || player.src.includes('kw-') || player.src.includes('sycdn'))) {
                console.warn('[Audio Guard] 检测到音频时长极短 (' + player.duration + 's)，判定为版权声明语音，拒绝播放！');
                reject(new Error('检测到该音源为官方版权声明语音，已自动拦截'));
                return;
            }
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error('音频加载失败'));
        };
        player.addEventListener('loadedmetadata', onLoaded, { once: true });
        player.addEventListener('error', onError, { once: true });
    });
}

let currentPlaybackToken = 0;

export function cancelPendingPlayback() {
    currentPlaybackToken++;
}

export function setResolveStatus(dom, status, text) {
    if (!dom || !dom.resolveStatusPill) return;
    dom.resolveStatusPill.style.display = "inline-flex";
    dom.resolveStatusPill.className = `resolve-status-pill status-${status}`;
    if (dom.resolveText) {
        dom.resolveText.textContent = text;
    }
}

export async function playSong(song, options = {}, state, dom, callbacks = {}, debugLogger = null) {
    const myToken = ++currentPlaybackToken;
    const { autoplay = true, startTime = 0, preserveProgress = false, isRetry = false } = options;

    state.audioReadyForPalette = false;

    const log = (msg) => {
        if (typeof debugLogger === "function") debugLogger(msg);
        else if (typeof window !== "undefined" && typeof window.__solaraDebugLog === "function") window.__solaraDebugLog(msg);
    };

    try {
        if (typeof callbacks.updateCurrentSongInfo === "function") {
            callbacks.updateCurrentSongInfo(song, { loadArtwork: false });
        }

        const quality = state.playbackQuality || '320';
        log(`[音频播放] 准备加载: ${song.name || "未知歌曲"} (音质: ${quality}k, 来源: ${song.source || 'netease'})`);

        const cacheKey = `${song.source || 'netease'}_${song.id}_${quality}`;
        let originalAudioUrl = null;
        let resolvedSourceChannel = null;

        setResolveStatus(dom, "resolving", "正在解析音频流...");

        // 1. 优先命中前端内存短期直链缓存（0 网络请求）
        if (!isRetry && audioUrlMemoryCache.has(cacheKey)) {
            const cachedItem = audioUrlMemoryCache.get(cacheKey);
            if (Date.now() - cachedItem.timestamp < AUDIO_URL_CACHE_TTL && cachedItem.url) {
                originalAudioUrl = cachedItem.url;
                resolvedSourceChannel = cachedItem.sourceChannel || "本地极速缓存";
                log(`[音频缓存] 命中内存直链: ${song.name} (${quality}k)，省去 1 次网络请求`);
            } else {
                audioUrlMemoryCache.delete(cacheKey);
            }
        }

        // 2. 未命中或重试时，发起实际网络请求
        if (!originalAudioUrl) {
            // 2.0 优先尝试激活的洛雪自定义音源订阅（若已配置且开启）
            if (lxPluginEngine && lxPluginEngine.isEnabled) {
                const activeSrc = lxPluginEngine.getActiveSource();
                const srcName = activeSrc?.name || "自定义音源";
                try {
                    setResolveStatus(dom, "resolving", `音源【${srcName}】解析中...`);
                    log(`[自定义音源] 正在尝试通过订阅插件解析: 《${song.name}》...`);
                    const customUrl = await lxPluginEngine.resolveAudioUrl(song, quality);
                    if (customUrl) {
                        originalAudioUrl = customUrl;
                        resolvedSourceChannel = `洛雪源: ${lxPluginEngine.lastResolvedSourceName || srcName}`;
                        log(`[自定义音源] 解析成功，优先使用插件音轨 (${resolvedSourceChannel})`);
                    }
                } catch (lxErr) {
                    console.warn('[自定义音源] 插件调度异常:', lxErr);
                }
            }

            // 2.1 若自定义音源未开启或解析未命中，进入 Solara 原生多源直连与全网兜底
            if (!originalAudioUrl) {
                setResolveStatus(dom, "resolving", "原生直连与全网调度中...");
                const nonNeteaseSources = ['qq', 'kuwo', 'kugou', 'tx', 'kw', 'kg', 'mg'];
                const needsCrossMatch = nonNeteaseSources.includes(song.source) || nonNeteaseSources.includes(song.platform);
                // 彻底杜绝盲目覆盖 lyric_id：QQ/酷狗/酷我本身有原生精确歌词（如 tx 的 songmid），绝不能盲目把 lyric_id 篡改为网易云搜出来的无关/翻唱歌曲 ID！
                // 仅当曲目本身完全没有 lyric_id / id 时，才作为最后的辅助候选，且必须严格校验歌手匹配
                if (needsCrossMatch && !song._matchedNetease && !song.lyric_id) {
                    try {
                        log(`[音源增强] 正在为【${song.source_name || song.platform || song.source}】曲目《${song.name}》预检索最佳音频流...`);
                        const queryText = `${song.name} ${song.artist}`.trim();
                        const matched = await API.search(queryText, 'wy', 3);
                        if (Array.isArray(matched) && matched.length > 0) {
                            const rawTargetArtist = String(song.artist || "").toLowerCase();
                            // 严格比对歌手名，杜绝“全网找歌君”等无关翻唱
                            const best = matched.find(item => {
                                const candArtist = String(item.artist || "").toLowerCase();
                                return rawTargetArtist && (candArtist.includes(rawTargetArtist) || rawTargetArtist.includes(candArtist));
                            }) || null;
                            if (best) {
                                song.lyric_id = best.lyric_id || best.id;
                                if (!song.pic && best.pic) song.pic = best.pic;
                                song.pic_id = best.pic_id || best.id;
                            }
                            song._matchedNetease = true;
                        }
                    } catch (matchErr) {
                        console.warn('[音源增强] 跨源检索异常:', matchErr);
                    }
                }

                let audioUrl = API.getSongUrl(song, quality);
                if (isRetry) {
                    audioUrl += '&nocache=true';
                    log(`[音频重试] 正在通过非缓存链路重试请求...`);
                }
                log(`[音频解析] 请求接口: ${audioUrl}`);

                const audioData = await API.fetchJson(audioUrl);
                if (myToken !== currentPlaybackToken) {
                    return;
                }

                if (!audioData || !audioData.url) {
                    const errMsg = audioData?.message || '该曲目受版权限制或暂无可用完整音轨';
                    throw new Error(errMsg);
                }

                originalAudioUrl = audioData.url;
                const sourceMap = { netease: "网易云", qq: "QQ音乐", tx: "QQ音乐", kuwo: "酷我", kw: "酷我", kugou: "酷狗", kg: "酷狗", migu: "咪咕", mg: "咪咕" };
                const channelName = sourceMap[song.source] || song.source_name || "官方通道";
                resolvedSourceChannel = `原生: ${channelName}`;
            }

            // 存入短期缓存（15分钟有效）
            audioUrlMemoryCache.set(cacheKey, {
                url: originalAudioUrl,
                sourceChannel: resolvedSourceChannel,
                timestamp: Date.now()
            });
        }

        setResolveStatus(dom, "resolving", `缓冲中 (${resolvedSourceChannel || "音频通道"})...`);

        log(`[音频地址] 解析就绪: ${originalAudioUrl.slice(0, 50)}...`);
        const proxiedAudioUrl = buildAudioProxyUrl(originalAudioUrl);
        const preferredAudioUrl = preferHttpsUrl(originalAudioUrl);
        const candidateAudioUrls = Array.from(
            new Set([proxiedAudioUrl, preferredAudioUrl, originalAudioUrl].filter(Boolean))
        );

        state.currentSong = song;
        state.currentAudioUrl = null;
        dom.audioPlayer.pause();

        if (state.currentList === "favorite") {
            if (!preserveProgress) {
                state.favoritePlaybackTime = 0;
                state.favoriteLastSavedPlaybackTime = 0;
                safeSetLocalStorage('favoritePlaybackTime', '0');
            } else if (startTime > 0) {
                state.favoritePlaybackTime = startTime;
                state.favoriteLastSavedPlaybackTime = startTime;
            }
        } else {
            if (!preserveProgress) {
                state.currentPlaybackTime = 0;
                state.lastSavedPlaybackTime = 0;
                safeSetLocalStorage('currentPlaybackTime', '0');
            } else if (startTime > 0) {
                state.currentPlaybackTime = startTime;
                state.lastSavedPlaybackTime = startTime;
            }
        }

        state.pendingSeekTime = startTime > 0 ? startTime : null;

        let selectedAudioUrl = null;
        let lastAudioError = null;

        for (const candidateUrl of candidateAudioUrls) {
            dom.audioPlayer.src = candidateUrl;
            dom.audioPlayer.load();

            try {
                await waitForAudioReady(dom.audioPlayer);
                // 严格拦截：识别并过滤 20~45 秒的 VIP 试听音频切片（如网易云/腾讯 27s 试听音频）
                const dur = dom.audioPlayer.duration;
                if (dur > 0 && dur < 45) {
                    log(`[试听拦截] 检测到音频时长仅有 ${Math.round(dur)} 秒（平台 VIP 试听切片），拒绝播放残缺音频！`);
                    throw new Error(`检测到该音频为平台试听片段 (${Math.round(dur)}s)，已自动放弃并调度完整源`);
                }
                selectedAudioUrl = candidateUrl;
                break;
            } catch (error) {
                lastAudioError = error;
            }
        }

        if (myToken !== currentPlaybackToken) {
            return;
        }

        if (!selectedAudioUrl) {
            throw lastAudioError || new Error('音频加载失败');
        }

        if (myToken !== currentPlaybackToken) {
            return;
        }

        state.currentAudioUrl = selectedAudioUrl;

        if (state.pendingSeekTime != null) {
            setAudioCurrentTime(state.pendingSeekTime, state, dom);
            state.pendingSeekTime = null;
        } else {
            setAudioCurrentTime(dom.audioPlayer.currentTime || 0, state, dom);
        }

        state.lastSavedPlaybackTime = state.currentPlaybackTime;

        let playPromise = null;
        log(`[音频解码] 缓冲就绪 (${autoplay ? '开始自动播放' : '静音待播'})`);
        setResolveStatus(dom, "success", `${resolvedSourceChannel || "音频已就绪"}`);

        if (autoplay) {
            playPromise = dom.audioPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(async error => {
                    console.error('播放失败:', error);
                    log(`[音频异常] 播放失败: ${error?.message || error}`);
                    if (!isRetry) {
                        try {
                            await playSong(song, { ...options, isRetry: true }, state, dom, callbacks, debugLogger);
                        } catch (retryError) {
                            showNotification('播放失败，请检查网络连接', 'error', dom);
                        }
                    } else {
                        showNotification('播放失败，请检查网络连接', 'error', dom);
                    }
                });
            }
        } else {
            dom.audioPlayer.pause();
            updatePlayPauseButton(dom);
        }

        // 异步延迟调度封面、歌词与极光色彩应用
        if (typeof callbacks.scheduleDeferredSongAssets === "function") {
            callbacks.scheduleDeferredSongAssets(song, playPromise);
        }

        if (typeof window.__SOLARA_UPDATE_MEDIA_METADATA === 'function') {
            window.__SOLARA_UPDATE_MEDIA_METADATA();
        }
    } catch (error) {
        console.error('播放歌曲失败:', error);
        setResolveStatus(dom, "error", `加载失败: ${error?.message || "网络异常/版权受限"}`);
        // 清除当前歌曲在内存中的直链缓存，杜绝命中坏链
        const badCacheKey = `${song.source || 'netease'}_${song.id}_${state.playbackQuality || '320'}`;
        audioUrlMemoryCache.delete(badCacheKey);
        if (!isRetry) {
            setResolveStatus(dom, "resolving", "正在尝试备用链路重试...");
            return playSong(song, { ...options, isRetry: true }, state, dom, callbacks, debugLogger);
        }
        throw error;
    } finally {
        if (typeof callbacks.savePlayerState === "function") {
            callbacks.savePlayerState();
        }
    }
}

export function autoPlayNext(state, dom, callbacks = {}) {
    if (dom.audioPlayer && dom.audioPlayer.__solaraMediaSessionHandledEnded === 'skip') {
        dom.audioPlayer.__solaraMediaSessionHandledEnded = false;
        return;
    }
    const mode = getActivePlayMode(state);
    if (mode === "single") {
        dom.audioPlayer.currentTime = 0;
        dom.audioPlayer.play();
        return;
    }

    playNext(state, dom, callbacks);
    updatePlayPauseButton(dom);
}

export function playNext(state, dom, callbacks = {}) {
    if (state.currentList === "favorite") {
        const favorites = ensureFavoriteSongsArray(state);
        if (favorites.length === 0) {
            if (typeof callbacks.clearLyricsIfLibraryEmpty === "function") callbacks.clearLyricsIfLibraryEmpty();
            return;
        }
        const mode = state.favoritePlayMode || "list";
        let nextIndex = state.currentFavoriteIndex;
        if (mode === "random") {
            nextIndex = Math.floor(Math.random() * favorites.length);
        } else if (mode === "list") {
            nextIndex = (state.currentFavoriteIndex + 1) % favorites.length;
        }
        if (mode !== "single") {
            state.currentFavoriteIndex = nextIndex;
        }
        if (typeof callbacks.playFavoriteSong === "function") {
            callbacks.playFavoriteSong(state.currentFavoriteIndex);
        }
        return;
    }

    let nextIndex = -1;
    let playlist = [];

    if (state.currentPlaylist === "playlist") {
        playlist = state.playlistSongs;
    } else if (state.currentPlaylist === "online") {
        playlist = state.onlineSongs;
    } else if (state.currentPlaylist === "search") {
        playlist = state.searchResults;
    }

    if (playlist.length === 0) {
        if (typeof callbacks.clearLyricsIfLibraryEmpty === "function") callbacks.clearLyricsIfLibraryEmpty();
        return;
    }

    const mode = state.playMode || "list";
    if (mode === "random") {
        nextIndex = Math.floor(Math.random() * playlist.length);
    } else if (mode === "list") {
        nextIndex = (state.currentTrackIndex + 1) % playlist.length;
    } else if (mode === "single") {
        nextIndex = state.currentTrackIndex >= 0 ? state.currentTrackIndex : 0;
    }

    if (mode !== "single") {
        state.currentTrackIndex = nextIndex;
    }

    const targetIndex = mode === "single" ? state.currentTrackIndex : nextIndex;

    if (state.currentPlaylist === "playlist" && typeof callbacks.playPlaylistSong === "function") {
        callbacks.playPlaylistSong(targetIndex);
    } else if (state.currentPlaylist === "online" && typeof callbacks.playOnlineSong === "function") {
        callbacks.playOnlineSong(targetIndex);
    } else if (state.currentPlaylist === "search" && typeof callbacks.playSearchResult === "function") {
        callbacks.playSearchResult(targetIndex);
    }
}

export function playPrevious(state, dom, callbacks = {}) {
    if (state.currentList === "favorite") {
        const favorites = ensureFavoriteSongsArray(state);
        if (favorites.length === 0) {
            return;
        }
        const mode = state.favoritePlayMode || "list";
        let prevIndex = state.currentFavoriteIndex;
        if (mode === "random") {
            prevIndex = Math.floor(Math.random() * favorites.length);
        } else if (mode === "list") {
            prevIndex = state.currentFavoriteIndex - 1;
            if (prevIndex < 0) {
                prevIndex = favorites.length - 1;
            }
        }
        if (mode !== "single") {
            state.currentFavoriteIndex = prevIndex;
        }
        if (typeof callbacks.playFavoriteSong === "function") {
            callbacks.playFavoriteSong(state.currentFavoriteIndex);
        }
        return;
    }

    let prevIndex = -1;
    let playlist = [];

    if (state.currentPlaylist === "playlist") {
        playlist = state.playlistSongs;
    } else if (state.currentPlaylist === "online") {
        playlist = state.onlineSongs;
    } else if (state.currentPlaylist === "search") {
        playlist = state.searchResults;
    }

    if (playlist.length === 0) return;

    const mode = state.playMode || "list";
    if (mode === "random") {
        prevIndex = Math.floor(Math.random() * playlist.length);
    } else if (mode === "list") {
        prevIndex = state.currentTrackIndex - 1;
        if (prevIndex < 0) prevIndex = playlist.length - 1;
    } else if (mode === "single") {
        prevIndex = state.currentTrackIndex >= 0 ? state.currentTrackIndex : 0;
    }

    if (mode !== "single") {
        state.currentTrackIndex = prevIndex;
    }

    const targetIndex = mode === "single" ? state.currentTrackIndex : prevIndex;

    if (state.currentPlaylist === "playlist" && typeof callbacks.playPlaylistSong === "function") {
        callbacks.playPlaylistSong(targetIndex);
    } else if (state.currentPlaylist === "online" && typeof callbacks.playOnlineSong === "function") {
        callbacks.playOnlineSong(targetIndex);
    } else if (state.currentPlaylist === "search" && typeof callbacks.playSearchResult === "function") {
        callbacks.playSearchResult(targetIndex);
    }
}

export async function downloadSong(song, quality = "320", dom = null) {
    try {
        showNotification("正在准备下载...", "info", dom);

        const audioUrl = API.getSongUrl(song, quality);
        const audioData = await API.fetchJson(audioUrl);

        if (audioData && audioData.url) {
            const proxiedAudioUrl = buildAudioProxyUrl(audioData.url);
            const preferredAudioUrl = preferHttpsUrl(audioData.url);
            const downloadUrl = proxiedAudioUrl || preferredAudioUrl || audioData.url;

            const link = document.createElement("a");
            link.href = downloadUrl;
            const preferredExtension = quality === "999" ? "flac" : quality === "740" ? "ape" : "mp3";
            const fileExtension = (() => {
                try {
                    const url = new URL(audioData.url);
                    const pathname = url.pathname || "";
                    const match = pathname.match(/\.([a-z0-9]+)$/i);
                    if (match) return match[1];
                } catch (error) {
                    console.warn("无法从下载链接中解析扩展名:", error);
                }
                return preferredExtension;
            })();
            link.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(", ") : song.artist}.${fileExtension}`;
            link.target = "_blank";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            showNotification("下载已开始", "success", dom);
        } else {
            throw new Error("无法获取下载地址");
        }
    } catch (error) {
        console.error("下载失败:", error);
        showNotification("下载失败，请稍后重试", "error", dom);
    }
}

/**
 * 彻底重置播放器为空闲/空态（停止播放、释放音频缓冲、重置界面与系统状态）
 */
export function resetPlayerToIdle(state, dom, callbacks = {}) {
    cancelPendingPlayback();

    if (dom.audioPlayer) {
        try {
            dom.audioPlayer.pause();
            dom.audioPlayer.removeAttribute("src");
            dom.audioPlayer.src = "";
            dom.audioPlayer.load();
        } catch (e) {
            console.warn("停止音频播放异常:", e);
        }
    }

    state.isPlaying = false;
    state.currentTrackIndex = -1;
    state.currentSong = null;
    state.currentAudioUrl = null;
    state.currentArtworkUrl = null;
    state.currentPlaybackTime = 0;
    state.lastSavedPlaybackTime = 0;
    if (state.currentList === "favorite") {
        state.currentFavoriteIndex = -1;
        state.favoritePlaybackTime = 0;
        state.favoriteLastSavedPlaybackTime = 0;
    }

    // 重置进度条
    if (dom.progressBar) {
        dom.progressBar.value = 0;
        dom.progressBar.max = 0;
        updateProgressBarBackground(dom, 0, 1);
    }
    if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = "00:00";
    if (dom.durationDisplay) dom.durationDisplay.textContent = "00:00";

    // 重置播放/暂停按钮
    updatePlayPauseButton(dom);

    // 重置歌曲信息与封面
    if (dom.currentSongTitle) dom.currentSongTitle.textContent = "选择一首歌曲开始播放";
    if (dom.currentSongArtist) dom.currentSongArtist.textContent = "未知艺术家";
    if (typeof callbacks.showAlbumCoverPlaceholder === "function") {
        callbacks.showAlbumCoverPlaceholder();
    }
    if (typeof callbacks.clearLyricsContent === "function") {
        callbacks.clearLyricsContent();
    }

    // 重置系统媒体会话
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
        } catch (_) {}
    }

    // 更新收藏状态图标
    if (typeof callbacks.updateFavoriteIcons === "function") {
        callbacks.updateFavoriteIcons();
    }

    // 保存状态
    if (typeof callbacks.savePlayerState === "function") {
        callbacks.savePlayerState();
    }
}

/**
 * 智能预判并获取下一首曲目对象
 */
export function getNextSong(state) {
    if (!state) return null;
    if (state.currentList === "favorite") {
        const favorites = ensureFavoriteSongsArray(state);
        if (favorites.length === 0) return null;
        const mode = state.favoritePlayMode || "list";
        let nextIndex = state.currentFavoriteIndex;
        if (mode === "random") {
            nextIndex = Math.floor(Math.random() * favorites.length);
        } else if (mode === "list") {
            nextIndex = (state.currentFavoriteIndex + 1) % favorites.length;
        }
        return favorites[nextIndex] || null;
    }

    let playlist = [];
    if (state.currentPlaylist === "playlist") playlist = state.playlistSongs;
    else if (state.currentPlaylist === "online") playlist = state.onlineSongs;
    else if (state.currentPlaylist === "search") playlist = state.searchResults;

    if (!Array.isArray(playlist) || playlist.length === 0) return null;
    const mode = getActivePlayMode(state);
    let nextIndex = state.currentIndex;
    if (mode === "random") {
        nextIndex = Math.floor(Math.random() * playlist.length);
    } else if (mode === "list") {
        nextIndex = (state.currentIndex + 1) % playlist.length;
    }
    return playlist[nextIndex] || null;
}

let isPreloadingNext = false;
let lastPreloadedSongId = null;

/**
 * 智能下一首曲目后台静默预载（Zero-Gap 毫秒级秒开切歌）
 */
export async function preloadNextSong(state, debugLogger = null) {
    if (isPreloadingNext) return;
    const nextSong = getNextSong(state);
    if (!nextSong || !nextSong.id) return;
    if (lastPreloadedSongId === String(nextSong.id)) return;

    const quality = state.playbackQuality || '320';
    const cacheKey = `${nextSong.source || 'netease'}_${nextSong.id}_${quality}`;
    if (audioUrlMemoryCache.has(cacheKey)) return;

    isPreloadingNext = true;
    lastPreloadedSongId = String(nextSong.id);

    try {
        const log = (msg) => {
            if (typeof debugLogger === "function") debugLogger(msg);
            else if (typeof window !== "undefined" && typeof window.__solaraDebugLog === "function") window.__solaraDebugLog(msg);
        };
        log(`[无缝预载] 正在后台静默预解析下一首曲目: 《${nextSong.name}》...`);

        let preloadUrl = null;
        let preloadChannel = null;

        // 1. 优先尝试自定义音源
        if (lxPluginEngine && lxPluginEngine.isEnabled) {
            try {
                const customUrl = await lxPluginEngine.resolveAudioUrl(nextSong, quality);
                if (customUrl) {
                    preloadUrl = customUrl;
                    preloadChannel = `洛雪源: ${lxPluginEngine.lastResolvedSourceName || "自定义音源"}`;
                }
            } catch {}
        }

        // 2. 备用尝试原生直连
        if (!preloadUrl) {
            const reqUrl = API.getSongUrl(nextSong, quality);
            const res = await API.fetchJson(reqUrl);
            if (res && res.url) {
                preloadUrl = res.url;
                preloadChannel = "原生直连";
            }
        }

        if (preloadUrl) {
            audioUrlMemoryCache.set(cacheKey, {
                url: preloadUrl,
                sourceChannel: preloadChannel,
                timestamp: Date.now()
            });
            log(`[无缝预载] 下一首《${nextSong.name}》已就绪，切歌实现 0 延迟秒播！`);

            // 预请求音频头 128KB 放入浏览器缓存
            if (typeof document !== "undefined") {
                const preloader = new Audio();
                preloader.preload = "auto";
                preloader.src = preloadUrl;
                preloader.volume = 0;
            }
        }
    } catch (e) {
        console.warn("[无缝预载] 后台静默预加载未完成 (不影响正常切歌):", e.message);
    } finally {
        isPreloadingNext = false;
    }
}

