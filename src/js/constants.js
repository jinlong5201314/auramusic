/**
 * Solara 全局常量与配置
 */

export const DEFAULT_RADAR_GENRES = [
    "热歌榜",
    "新歌榜",
    "飙升榜",
];

export const EXPLORE_RADAR_GENRES = [
    "热歌榜",
    "新歌榜",
    "飙升榜",
    "潮流风向榜",
    "原创榜",
    "网易云全球说唱榜",
    "美国Billboard榜",
];

export const SOURCE_OPTIONS = [
    { value: "all", label: "聚合大会" },
    { value: "tx", label: "小秋音乐" },
    { value: "wy", label: "小芸音乐" },
    { value: "kw", label: "小蜗音乐" },
    { value: "kg", label: "小枸音乐" },
    { value: "mg", label: "小蜜音乐" }
];

export const RADAR_PLAYLISTS = [
    { id: "3778678", name: "热歌榜", description: "网易云音乐官方热歌榜" },
    { id: "19723756", name: "飙升榜", description: "网易云音乐官方飙升榜" },
    { id: "3779629", name: "新歌榜", description: "网易云音乐官方新歌榜" },
    { id: "13372522766", name: "潮流风向榜", description: "网易云音乐官方潮流风向榜" },
    { id: "2884035", name: "原创榜", description: "网易云音乐官方原创榜" },
    { id: "14028249541", name: "网易云全球说唱榜", description: "网易云音乐全球说唱榜" },
    { id: "60198", name: "美国Billboard榜", description: "网易云音乐美国Billboard榜" }
];

export function normalizeSource(value) {
    const allowed = SOURCE_OPTIONS.map(option => option.value);
    return allowed.includes(value) ? value : SOURCE_OPTIONS[0].value;
}

export const QUALITY_OPTIONS = [
    { value: "128", label: "标准音质", description: "128 kbps" },
    { value: "192", label: "高品音质", description: "192 kbps" },
    { value: "320", label: "极高音质", description: "320 kbps" },
    { value: "999", label: "无损音质", description: "FLAC" }
];

export function normalizeQuality(value) {
    const match = QUALITY_OPTIONS.find(option => option.value === value);
    return match ? match.value : "320";
}

export const REMOTE_STORAGE_ENDPOINT = "/api/storage";

export const STORAGE_KEYS_TO_SYNC = new Set([
    "playlistSongs",
    "currentTrackIndex",
    "playMode",
    "playbackQuality",
    "playerVolume",
    "currentPlaylist",
    "currentList",
    "currentSong",
    "currentPlaybackTime",
    "favoriteSongs",
    "currentFavoriteIndex",
    "favoritePlayMode",
    "favoritePlaybackTime",
    "customPlaylists",
    "currentCustomPlaylistId",
    "currentCustomSongIndex",
    "searchSource",
    "lastSearchState.v1",
    "radarSettings",
    "lxMusicSourcesList",
    "lxMusicActiveSourceId",
    "lxMusicSourceEnabled",
]);

export const PALETTE_STORAGE_KEY = "paletteCache.v3";
export const LAST_SEARCH_STATE_STORAGE_KEY = "lastSearchState.v1";
export const PLAYLIST_EXPORT_VERSION = 1;
export const FAVORITE_EXPORT_VERSION = 1;
export const APP_VERSION = "v4.3.0";

export const BACKGROUND_TRANSITION_DURATION = 850;
export const PALETTE_APPLY_DELAY = 140;
export const PALETTE_MAX_DIMENSION = 96;
export const PALETTE_TARGET_SAMPLE_COUNT = 2400;

export const PLACEHOLDER_HTML = `<div class="placeholder"><i class="fas fa-music"></i></div>`;

export const themeDefaults = {
    light: {
        gradient: "",
        primaryColor: "",
        primaryColorDark: "",
    },
    dark: {
        gradient: "",
        primaryColor: "",
        primaryColorDark: "",
    }
};

/**
 * 核心后端 API 代理接口
 */
export const API = {
    baseUrl: "/proxy",

    generateSignature: () => {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    },

    fetchJson: async (url, debugLogger = null) => {
        try {
            const response = await fetch(url, {
                headers: {
                    "Accept": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            const cacheStatus = response.headers.get("X-Cache-Status");
            if (cacheStatus && typeof debugLogger === "function") {
                const urlObj = new URL(url, window.location.origin);
                const type = urlObj.searchParams.get("types") || "未知接口";
                if (cacheStatus === "HIT") {
                    debugLogger(`[边缘缓存] 命中接口数据: ${type}`);
                } else if (cacheStatus === "MISS") {
                    debugLogger(`[穿透回源] 拉取接口数据: ${type}`);
                }
            }

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (parseError) {
                console.warn("JSON parse failed, returning raw text", parseError);
                return text;
            }
        } catch (error) {
            console.error("API request error:", error);
            throw error;
        }
    },

    search: async (keyword, source = "all", count = 20, page = 1, debugLogger = null) => {
        // 1. 优先调用内建 5 大平台同构搜索引擎（聚合大会 / 小秋 / 小芸 / 小蜗 / 小枸 / 小蜜）
        try {
            const searchApiUrl = `/api/search?keyword=${encodeURIComponent(keyword)}&source=${source}&count=${count}&page=${page}`;
            if (typeof debugLogger === "function") debugLogger(`[内建搜索] 发起请求: ${searchApiUrl}`);
            const resp = await fetch(searchApiUrl);
            if (resp.ok) {
                const data = await resp.json();
                if (Array.isArray(data)) {
                    if (typeof debugLogger === "function") debugLogger(`[内建搜索] 成功命中 ${data.length} 首曲目`);
                    return data.map(song => ({
                        id: song.id,
                        name: song.name,
                        artist: song.artist,
                        album: song.album,
                        pic_id: song.pic_id || song.id,
                        pic: song.pic || "",
                        url_id: song.url_id || song.id,
                        lyric_id: song.lyric_id || song.id,
                        source: song.source,
                        source_name: song.source_name || "",
                        duration: song.duration,
                        formats: song.formats
                    }));
                }
            }
        } catch (err) {
            if (typeof debugLogger === "function") debugLogger(`[内建搜索] 异常，尝试回退旧源: ${err.message}`);
        }

        // 2. 外部 GD 音乐台兜底（仅在特定旧源或异常时触发）
        const fallbackSource = source === "wy" ? "netease" : (source === "kw" ? "kuwo" : "netease");
        const signature = API.generateSignature();
        const url = `${API.baseUrl}?types=search&source=${fallbackSource}&name=${encodeURIComponent(keyword)}&count=${count}&pages=${page}&s=${signature}`;

        try {
            if (typeof debugLogger === "function") debugLogger(`API请求: ${url}`);
            const data = await API.fetchJson(url, debugLogger);
            if (typeof debugLogger === "function") debugLogger(`API响应: ${JSON.stringify(data).substring(0, 200)}...`);

            if (!Array.isArray(data)) throw new Error("搜索结果格式错误");

            return data.map(song => ({
                id: song.id,
                name: song.name,
                artist: song.artist,
                album: song.album,
                pic_id: song.pic_id,
                url_id: song.url_id,
                lyric_id: song.lyric_id,
                source: song.source,
            }));
        } catch (error) {
            if (typeof debugLogger === "function") debugLogger(`API错误: ${error.message}`);
            throw error;
        }
    },

    getRadarPlaylist: async (playlistId = "3778678", options = {}) => {
        const signature = API.generateSignature();

        let limit = 20;
        let offset = 0;

        if (typeof options === "number") {
            limit = options;
        } else if (options && typeof options === "object") {
            if (Number.isFinite(options.limit)) {
                limit = options.limit;
            } else if (Number.isFinite(options.count)) {
                limit = options.count;
            }
            if (Number.isFinite(options.offset)) {
                offset = options.offset;
            }
        }

        limit = Math.max(1, Math.min(200, Math.trunc(limit)) || 20);
        offset = Math.max(0, Math.trunc(offset) || 0);

        const params = new URLSearchParams({
            types: "playlist",
            id: playlistId,
            limit: String(limit),
            offset: String(offset),
            s: signature,
        });
        const url = `${API.baseUrl}?${params.toString()}`;

        try {
            const data = await API.fetchJson(url);
            const tracks = data && data.playlist && Array.isArray(data.playlist.tracks)
                ? data.playlist.tracks.slice(0, limit)
                : [];

            if (tracks.length === 0) throw new Error("No tracks found");

            return tracks.map(track => {
                const directPicUrl = track.al?.picUrl || (typeof track.al?.pic === "string" && track.al.pic.startsWith("http") ? track.al.pic : "");
                return {
                    id: track.id,
                    name: track.name,
                    artist: Array.isArray(track.ar) ? track.ar.map(artist => artist.name).join(" / ") : (track.ar?.name || "未知艺术家"),
                    album: track.al?.name || "",
                    source: "netease",
                    lyric_id: track.id,
                    pic: directPicUrl,
                    pic_id: track.al?.pic_str || track.al?.pic || "",
                    url_id: track.id,
                };
            });
        } catch (error) {
            console.error("API request failed:", error);
            throw error;
        }
    },

    getSongUrl: (song, quality = "320") => {
        const signature = API.generateSignature();
        const sourceMap = { wy: "netease", tx: "tencent", kw: "kuwo", kg: "kugou", mg: "migu" };
        const rawSource = song.source || "netease";
        const normSource = sourceMap[rawSource] || rawSource;
        const songName = encodeURIComponent(song.name || "");
        const artistName = encodeURIComponent(Array.isArray(song.artist) ? song.artist.join(" ") : (song.artist || ""));
        const durationParam = song.duration ? `&duration=${encodeURIComponent(song.duration)}` : "";
        return `${API.baseUrl}?types=url&id=${song.url_id || song.id}&source=${normSource}&name=${songName}&artist=${artistName}&br=${quality}${durationParam}&s=${signature}`;
    },

    getLyric: (song) => {
        const signature = API.generateSignature();
        const sourceMap = { wy: "netease", tx: "tencent", kw: "kuwo", kg: "kugou", mg: "migu" };
        const rawSource = song.source || "netease";
        const normSource = sourceMap[rawSource] || rawSource;
        const songName = encodeURIComponent(song.name || "");
        const artistName = encodeURIComponent(Array.isArray(song.artist) ? song.artist.join(" ") : (song.artist || ""));
        // 关键防御：对于小秋音乐(tx)，如果 lyric_id 被历史脏数据污染成了网易云数字 ID，强制纠正回 song.id (如 000hh1Mg2uZKBd)
        let lyricId = song.lyric_id || song.id;
        if ((normSource === "tencent" || normSource === "tx") && typeof lyricId === "string" && /^\d+$/.test(lyricId) && typeof song.id === "string" && song.id.startsWith("00")) {
            lyricId = song.id;
        }
        return `${API.baseUrl}?types=lyric&id=${lyricId}&source=${normSource}&name=${songName}&artist=${artistName}&_v=v3.2.5&s=${signature}`;
    },

    getPicUrl: (song) => {
        if (song.pic && typeof song.pic === "string" && song.pic.startsWith("http")) return song.pic;
        const signature = API.generateSignature();
        const sourceMap = { wy: "netease", tx: "tencent", kw: "kuwo", kg: "kugou", mg: "migu" };
        const rawSource = song.source || "netease";
        const normSource = sourceMap[rawSource] || rawSource;
        return `${API.baseUrl}?types=pic&id=${song.pic_id || song.id}&source=${normSource}&size=300&s=${signature}`;
    }
};

Object.freeze(API);
