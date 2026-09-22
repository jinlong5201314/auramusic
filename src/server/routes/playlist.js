/**
 * 多平台分类歌单路由 —— 支持 QQ音乐、网易云、酷我、酷狗音乐
 *
 * 路由：
 *   GET /api/playlist/platforms
 *   GET /api/playlist/categories?platform=qq|netease|kuwo|kugou
 *   GET /api/playlist/list?platform=...&category_id=...&page=0&limit=30
 *   GET /api/playlist/detail?platform=...&id=...
 */

'use strict';

const { Router } = require('express');

// 内存缓存
const memoryCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCache(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttlMs = CACHE_TTL_MS) {
  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

// ────────────────────────────────────────────────────────────────
// 1. QQ 音乐适配器
// ────────────────────────────────────────────────────────────────
const QQ_CATEGORIES = [
  { id: 3317, name: "官方歌单", group: "热门" },
  { id: 9527, name: "AI歌单", group: "热门" },
  { id: 3417, name: "私藏", group: "热门" },
  { id: 1069, name: "音乐人在听", group: "主题" },
  { id: 64, name: "KTV金曲", group: "主题" },
  { id: 3902, name: "Chill Vibes", group: "主题" },
  { id: 3056, name: "网络歌曲", group: "主题" },
  { id: 95, name: "现场音乐", group: "主题" },
  { id: 107, name: "背景音乐", group: "主题" },
  { id: 59, name: "经典老歌", group: "主题" },
  { id: 71, name: "情歌", group: "主题" },
  { id: 3202, name: "ACG", group: "主题" },
  { id: 3201, name: "影视", group: "主题" },
  { id: 73, name: "游戏", group: "主题" },
  { id: 3357, name: "DJ神曲", group: "主题" },
  { id: 32, name: "夜店", group: "场景" },
  { id: 3248, name: "学习工作", group: "场景" },
  { id: 3215, name: "咖啡馆", group: "场景" },
  { id: 132, name: "运动", group: "场景" },
  { id: 27, name: "睡前", group: "场景" },
  { id: 36, name: "旅行", group: "场景" },
  { id: 3901, name: "驾驶", group: "场景" },
  { id: 74, name: "伤感", group: "心情" },
  { id: 3142, name: "快乐", group: "心情" },
  { id: 13, name: "安静", group: "心情" },
  { id: 16, name: "励志", group: "心情" },
  { id: 7, name: "治愈", group: "心情" },
  { id: 3152, name: "流行", group: "流派" },
  { id: 45, name: "电子", group: "流派" },
  { id: 49, name: "轻音乐", group: "流派" },
  { id: 48, name: "民谣", group: "流派" },
  { id: 42, name: "说唱", group: "流派" },
  { id: 41, name: "摇滚", group: "流派" },
  { id: 46, name: "爵士", group: "流派" },
  { id: 47, name: "古典", group: "流派" },
  { id: 61, name: "古风", group: "流派" },
  { id: 1, name: "国语", group: "语种" },
  { id: 146, name: "粤语", group: "语种" },
  { id: 3, name: "英语", group: "语种" },
  { id: 4, name: "韩语", group: "语种" },
  { id: 5, name: "日语", group: "语种" },
];

const qqAdapter = {
  name: "qq",
  label: "QQ音乐",
  async getCategories() {
    return QQ_CATEGORIES;
  },
  async getPlaylists(categoryId = 3317, page = 0, limit = 30) {
    const postData = {
      comm: { cv: 4747474, ct: 24, format: "json", inCharset: "utf-8", outCharset: "utf-8", notice: 0, platform: "yqq.json", needNewCode: 1 },
      playlist: {
        method: "get_category_content",
        module: "playlist.PlayListCategoryServer",
        param: {
          titleid: Number(categoryId),
          caller: "0",
          category_id: Number(categoryId),
          size: Number(limit),
          page: Number(page),
          use_page: 1,
        },
      },
    };

    const res = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: {
        "Referer": "https://y.qq.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(postData),
    });

    if (!res.ok) throw new Error(`QQ Music API error: ${res.status}`);
    const json = await res.json();
    const rawItems = json?.playlist?.data?.content?.v_item || json?.playlist?.data?.content?.ef_playlist || json?.playlist?.data?.content?.list || [];
    
    return rawItems.map((item) => {
      const basic = item.basic || item;
      return {
        id: String(basic.tid || basic.dissid),
        title: basic.title || basic.dissname,
        cover: basic.cover?.medium_url || basic.cover?.default_url || basic.imgurl || "",
        playCount: basic.play_cnt || basic.listennum || 0,
        songCount: basic.song_cnt || 0,
        creator: basic.creator?.nick || basic.creatorname || "",
        desc: basic.desc || "",
        platform: "qq",
      };
    });
  },
  async getPlaylistDetail(id) {
    const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(id)}&format=json`;
    const res = await fetch(url, {
      headers: {
        "Referer": "https://y.qq.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) throw new Error(`QQ Music detail error: ${res.status}`);
    const json = await res.json();
    const cd = json?.cdlist?.[0];
    if (!cd) throw new Error("QQ 歌单未找到或内容为空");

    const songs = (cd.songlist || []).map((s) => {
      const artist = Array.isArray(s.singer) ? s.singer.map((a) => a.name).join(" / ") : (s.singer?.name || "");
      const cover = s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : "";
      return {
        id: String(s.songmid || s.songid),
        songId: s.songid,
        songMid: s.songmid,
        name: s.songname,
        artist,
        album: s.albumname || "",
        cover,
        interval: s.interval,
        platform: "qq",
        source: "qq",
      };
    });

    return {
      id: String(cd.disstid),
      title: cd.dissname,
      cover: cd.logo,
      creator: cd.nickname,
      desc: cd.desc || "",
      songCount: songs.length,
      platform: "qq",
      songs,
    };
  },
};

// ────────────────────────────────────────────────────────────────
// 2. 网易云音乐适配器
// ────────────────────────────────────────────────────────────────
const NETEASE_CATEGORIES = [
  { id: "全部", name: "全部", group: "热门" },
  { id: "华语", name: "华语", group: "语种" },
  { id: "欧美", name: "欧美", group: "语种" },
  { id: "日语", name: "日语", group: "语种" },
  { id: "韩语", name: "韩语", group: "语种" },
  { id: "粤语", name: "粤语", group: "语种" },
  { id: "流行", name: "流行", group: "风格" },
  { id: "摇滚", name: "摇滚", group: "风格" },
  { id: "民谣", name: "民谣", group: "风格" },
  { id: "电子", name: "电子", group: "风格" },
  { id: "说唱", name: "说唱", group: "风格" },
  { id: "轻音乐", name: "轻音乐", group: "风格" },
  { id: "古风", name: "古风", group: "风格" },
  { id: "清晨", name: "清晨", group: "场景" },
  { id: "夜晚", name: "夜晚", group: "场景" },
  { id: "学习", name: "学习", group: "场景" },
  { id: "工作", name: "工作", group: "场景" },
  { id: "午休", name: "午休", group: "场景" },
  { id: "怀旧", name: "怀旧", group: "情感" },
  { id: "伤感", name: "伤感", group: "情感" },
  { id: "治愈", name: "治愈", group: "情感" },
];

const neteaseAdapter = {
  name: "netease",
  label: "网易云音乐",
  async getCategories() {
    return NETEASE_CATEGORIES;
  },
  async getPlaylists(categoryId = "全部", page = 0, limit = 30) {
    const offset = page * limit;
    const cat = categoryId || "全部";
    const url = `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(cat)}&order=hot&offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        "Referer": "https://music.163.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`Netease API error: ${res.status}`);
    const json = await res.json();
    return (json.playlists || []).map((p) => ({
      id: String(p.id),
      title: p.name,
      cover: p.coverImgUrl,
      playCount: p.playCount,
      songCount: p.trackCount,
      creator: p.creator?.nickname || "",
      desc: p.description || "",
      platform: "netease",
    }));
  },
  async getPlaylistDetail(id) {
    const url = `https://music.163.com/api/v3/playlist/detail?id=${encodeURIComponent(id)}&n=1000`;
    const res = await fetch(url, {
      headers: {
        "Referer": "https://music.163.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) throw new Error(`Netease detail error: ${res.status}`);
    const json = await res.json();
    const pl = json.playlist;
    if (!pl) throw new Error("网易云歌单未找到");
    const songs = (pl.tracks || []).map((t) => ({
      id: String(t.id),
      name: t.name,
      artist: Array.isArray(t.ar) ? t.ar.map((a) => a.name).join(" / ") : "",
      album: t.al?.name || "",
      cover: t.al?.picUrl || "",
      platform: "netease",
      source: "netease",
    }));
    return {
      id: String(pl.id),
      title: pl.name,
      cover: pl.coverImgUrl,
      creator: pl.creator?.nickname || "",
      desc: pl.description || "",
      songCount: songs.length,
      platform: "netease",
      songs,
    };
  },
};

// ────────────────────────────────────────────────────────────────
// 3. 酷我音乐适配器 (kuwo.cn)
// ────────────────────────────────────────────────────────────────
const KUWO_CATEGORIES = [
  { id: "146", name: "精选情歌", group: "热门" },
  { id: "211", name: "经典老歌", group: "专区" },
  { id: "87", name: "网红专区", group: "专区" },
  { id: "187", name: "DJ专区", group: "专区" },
  { id: "210", name: "轻音乐专区", group: "专区" },
  { id: "212", name: "国风专区", group: "专区" },
  { id: "2189", name: "短视频", group: "主题" },
  { id: "1265", name: "经典", group: "主题" },
  { id: "2267", name: "BGM", group: "主题" },
  { id: "62", name: "解压", group: "心情" },
  { id: "61", name: "开心", group: "心情" },
  { id: "64", name: "甜蜜", group: "心情" },
  { id: "181", name: "开车", group: "场景" },
  { id: "139", name: "运动", group: "场景" },
  { id: "66", name: "睡眠", group: "场景" },
  { id: "67", name: "学习", group: "场景" },
  { id: "37", name: "华语", group: "语种" },
  { id: "38", name: "欧美", group: "语种" },
  { id: "39", name: "粤语", group: "语种" },
];

const kuwoAdapter = {
  name: "kuwo",
  label: "酷我音乐",
  async getCategories() {
    return KUWO_CATEGORIES;
  },
  async getPlaylists(categoryId = "146", page = 0, limit = 30) {
    const pn = page + 1;
    const catId = categoryId || "146";
    const url = `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?pn=${pn}&rn=${limit}&order=hot&id=${encodeURIComponent(catId)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://kuwo.cn/playlists",
      },
    });
    if (!res.ok) throw new Error(`Kuwo API error: ${res.status}`);
    const json = await res.json();
    const rawList = json?.data?.data || [];
    return rawList.map((p) => ({
      id: String(p.id),
      title: p.name || p.title,
      cover: p.img || "",
      playCount: p.listencnt || 0,
      songCount: p.total || 0,
      creator: p.uname || "酷我音乐",
      desc: p.info || p.desc || "",
      platform: "kuwo",
    }));
  },
  async getPlaylistDetail(id) {
    const url = `https://m.kuwo.cn/newh5app/wapi/api/www/playlist/playListInfo?pid=${encodeURIComponent(id)}&pn=1&rn=100`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
        "Referer": "https://kuwo.cn/",
      },
    });
    if (!res.ok) throw new Error(`Kuwo detail error: ${res.status}`);
    const json = await res.json();
    const data = json.data;
    if (!data) throw new Error("酷我歌单未找到或解析失败");

    const songs = (data.musicList || []).map((t) => ({
      id: String(t.rid || t.id),
      songId: t.rid || t.id,
      name: t.name,
      artist: t.artist,
      album: t.album || "",
      cover: t.pic || "",
      platform: "kuwo",
      source: "kuwo",
    }));

    return {
      id: String(data.id || id),
      title: data.name || data.title,
      cover: data.img || data.pic || "",
      creator: data.uname || "酷我音乐",
      desc: data.info || data.desc || "",
      songCount: songs.length,
      platform: "kuwo",
      songs,
    };
  },
};

// ────────────────────────────────────────────────────────────────
// 4. 酷狗音乐适配器 (kugou.com)
// ────────────────────────────────────────────────────────────────
const KUGOU_CATEGORIES = [
  { id: "recommend", name: "精选推荐", group: "精选" },
  { id: "hot", name: "最热歌单", group: "精选" },
  { id: "new", name: "最新发布", group: "精选" },
  { id: "collect", name: "热门收藏", group: "精选" },
  { id: "surge", name: "飙升榜单", group: "精选" },
  { id: "classic", name: "经典怀旧", group: "主题" },
  { id: "pop", name: "流行网络", group: "主题" },
  { id: "sad", name: "伤感催泪", group: "心情" },
  { id: "heal", name: "治愈放松", group: "心情" },
  { id: "car", name: "车载公路", group: "场景" },
  { id: "study", name: "学习专注", group: "场景" },
  { id: "cantonese", name: "粤语金曲", group: "语种" },
  { id: "pure", name: "纯音乐", group: "流派" },
];

const kugouAdapter = {
  name: "kugou",
  label: "酷狗音乐",
  async getCategories() {
    return KUGOU_CATEGORIES;
  },
  async getPlaylists(categoryId = "recommend", page = 0, limit = 30) {
    const pn = page + 1;
    const url = `https://m.kugou.com/plist/index&json=true&page=${pn}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
        "Referer": "https://www.kugou.com/yy/html/special.html",
        "X-Forwarded-For": "116.23.12.34",
        "X-Real-IP": "116.23.12.34",
      },
    });
    if (!res.ok) throw new Error(`Kugou API error: ${res.status}`);
    const json = await res.json();
    const items = json?.plist?.list?.info || [];
    return items.map((item) => {
      const cover = (item.imgurl || "").replace("{size}", "400");
      return {
        id: String(item.specialid),
        title: item.specialname,
        cover,
        playCount: item.playcount || 0,
        songCount: item.songcount || 0,
        creator: item.nickname || item.username || "酷狗音乐",
        desc: item.intro || "",
        platform: "kugou",
      };
    });
  },
  async getPlaylistDetail(id) {
    const songsUrl = `http://mobilecdnbj.kugou.com/api/v5/special/song?specialid=${encodeURIComponent(id)}&page=1&pagesize=100`;
    const metaUrl = `http://m.kugou.com/plist/list/${encodeURIComponent(id)}?json=true`;

    const [songsRes, metaRes] = await Promise.all([
      fetch(songsUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "X-Forwarded-For": "116.23.12.34",
          "X-Real-IP": "116.23.12.34",
        },
      }),
      fetch(metaUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)",
          "X-Forwarded-For": "116.23.12.34",
          "X-Real-IP": "116.23.12.34",
        },
      }).catch(() => null),
    ]);

    if (!songsRes.ok) throw new Error(`Kugou detail error: ${songsRes.status}`);
    const songsJson = await songsRes.json();
    const rawSongs = songsJson?.data?.info || [];

    let metaTitle = "";
    let metaCover = "";
    let metaCreator = "酷狗音乐";
    let metaDesc = "";

    if (metaRes && metaRes.ok) {
      try {
        const metaJson = await metaRes.json();
        const info = metaJson?.info?.list || {};
        metaTitle = info.specialname || "";
        metaCover = (info.imgurl || "").replace("{size}", "400");
        metaCreator = info.nickname || "酷狗音乐";
        metaDesc = info.intro || "";
      } catch (_) {}
    }

    const songs = rawSongs.map((s) => {
      let name = s.songname || s.filename || "";
      let artist = s.singername || "";
      if (!artist && name.includes(" - ")) {
        const parts = name.split(" - ");
        artist = parts[0].trim();
        name = parts.slice(1).join(" - ").trim();
      }
      return {
        id: String(s.audio_id || s.hash || s.id),
        songId: s.audio_id || s.hash,
        hash: s.hash,
        name,
        artist,
        album: s.album_name || "",
        cover: metaCover,
        platform: "kugou",
        source: "kugou",
      };
    });

    return {
      id: String(id),
      title: metaTitle || `酷狗精选歌单 (${id})`,
      cover: metaCover,
      creator: metaCreator,
      desc: metaDesc,
      songCount: songs.length,
      platform: "kugou",
      songs,
    };
  },
};

// ────────────────────────────────────────────────────────────────
// 5. 咪咕音乐适配器（小蜜音乐）
// ────────────────────────────────────────────────────────────────
const miguAdapter = {
  name: "migu",
  async getCategories() {
    return [
      { id: "10000000", name: "推荐歌单", group: "精选" },
      { id: "1001", name: "华语流行", group: "语种" },
      { id: "1002", name: "欧美潮流", group: "语种" },
      { id: "1003", name: "粤语经典", group: "语种" },
      { id: "2001", name: "摇滚先锋", group: "风格" },
      { id: "2002", name: "民谣时光", group: "风格" },
      { id: "2003", name: "电音派对", group: "风格" },
      { id: "3001", name: "驾车公路", group: "场景" },
      { id: "3002", name: "轻眠入梦", group: "场景" },
      { id: "3003", name: "运动节奏", group: "场景" },
    ];
  },
  async getPlaylists(categoryId = "10000000", page = 0, limit = 30) {
    const pageNo = page + 1;
    const timestamp = String(Date.now());
    const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
    const signature_md5 = "6cdc72a439cef99a3418d2a78aa28c73";
    const sign_raw = `每日推荐${signature_md5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`;
    const sign = crypto.createHash('md5').update(sign_raw).digest('hex');

    const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=%E7%83%AD%E9%97%A8&pageNo=${pageNo}&sort=0&sid=USS`;
    const res = await axios.get(url, {
      headers: {
        uiVersion: "A_music_3.6.1",
        deviceId,
        timestamp,
        sign,
        channel: "0146921",
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; MI 11)",
        "X-Forwarded-For": "116.23.12.34",
        "X-Real-IP": "116.23.12.34",
      },
    });
    const list = res.data?.songListResultData?.result || [];
    return list.map((item) => ({
      id: String(item.id),
      title: item.name,
      cover: item.musicListPicUrl || "",
      playCount: formatPlayCount(item.playNum),
      songCount: parseInt(item.musicNum) || 0,
      creator: item.userName || "咪咕音乐",
      desc: item.intro || "",
      platform: "migu",
    }));
  },
  async getPlaylistDetail(id) {
    const url = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?needSimple=01&resourceType=2021&resourceId=${encodeURIComponent(id)}`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "okhttp/3.10.0",
        "X-Forwarded-For": "116.23.12.34",
        "X-Real-IP": "116.23.12.34",
      },
    });
    const resource = res.data?.resource?.[0] || {};
    const songItems = resource.songItems || [];
    const songs = songItems.map((s) => ({
      id: String(s.songId || s.copyrightId || s.id),
      songId: s.songId || s.copyrightId,
      name: s.songName || s.name,
      artist: s.singer || "",
      album: s.album || "",
      cover: s.albumImgs?.[0]?.img || resource.imgItem?.img || "",
      platform: "migu",
      source: "migu",
    }));

    return {
      id: String(id),
      title: resource.title || "咪咕精选歌单",
      cover: resource.imgItem?.img || "",
      creator: resource.ownerName || "咪咕音乐",
      desc: resource.summary || "",
      songCount: songs.length,
      platform: "migu",
      songs,
    };
  },
};

// ────────────────────────────────────────────────────────────────
// 6. 洛雪音乐歌单搜索算法与聚合引擎 (Node Express)
// ────────────────────────────────────────────────────────────────
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  if (s1 === s2) return 100;
  if (s2.includes(s1) || s1.includes(s2)) return 75;
  let matches = 0;
  for (const char of s1) {
    if (s2.includes(char)) matches++;
  }
  return (matches / Math.max(s1.length, s2.length)) * 50;
}

async function searchQQSongLists(keyword, page = 1, limit = 20) {
  try {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page - 1}&num_per_page=${limit}&format=json&query=${encodeURIComponent(keyword)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`;
    const resp = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://y.qq.com/" } });
    return (resp.data?.data?.list || []).map((item) => ({
      id: String(item.dissid),
      title: item.dissname,
      cover: item.imgurl,
      playCount: formatPlayCount(item.listennum),
      rawPlayCount: item.listennum || 0,
      songCount: item.song_count || 0,
      creator: item.creator?.name || "",
      desc: item.introduction || "",
      platform: "tx",
      platform_name: "小秋音乐",
    }));
  } catch (err) {
    return [];
  }
}

async function searchNeteaseSongLists(keyword, page = 1, limit = 20) {
  try {
    const offset = (page - 1) * limit;
    const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1000&offset=${offset}&limit=${limit}&total=true`;
    const resp = await axios.get(url, { headers: { Referer: "https://music.163.com", "User-Agent": "Mozilla/5.0" } });
    return (resp.data?.result?.playlists || []).map((item) => ({
      id: String(item.id),
      title: item.name,
      cover: item.coverImgUrl,
      playCount: formatPlayCount(item.playCount),
      rawPlayCount: item.playCount || 0,
      songCount: item.trackCount || 0,
      creator: item.creator?.nickname || "",
      desc: item.description || "",
      platform: "wy",
      platform_name: "小芸音乐",
    }));
  } catch (err) {
    return [];
  }
}

async function searchKuwoSongLists(keyword, page = 1, limit = 20) {
  try {
    const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0`;
    const resp = await axios.get(url, { headers: { "User-Agent": "okhttp/3.10.0" } });
    const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const data = JSON.parse(raw.replace(/'/g, '"'));
    return (data?.abslist || []).map((item) => ({
      id: String(item.playlistid),
      title: item.name,
      cover: item.pic,
      playCount: formatPlayCount(item.playcnt),
      rawPlayCount: parseInt(item.playcnt, 10) || 0,
      songCount: parseInt(item.songnum, 10) || 0,
      creator: item.nickname || "",
      desc: item.intro || "",
      platform: "kw",
      platform_name: "小蜗音乐",
    }));
  } catch (err) {
    return [];
  }
}

async function searchKugouSongLists(keyword, page = 1, limit = 20) {
  try {
    const url = `http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=10&filter=0&version=7910&sver=2`;
    const resp = await axios.get(url, { headers: { "User-Agent": "okhttp/3.10.0" } });
    return (resp.data?.data?.info || []).map((item) => ({
      id: String(item.specialid),
      title: item.specialname,
      cover: (item.imgurl || "").replace("{size}", "400"),
      playCount: formatPlayCount(item.playcount),
      rawPlayCount: item.playcount || 0,
      songCount: item.songcount || 0,
      creator: item.nickname || "",
      desc: item.intro || "",
      platform: "kg",
      platform_name: "小枸音乐",
    }));
  } catch (err) {
    return [];
  }
}

async function searchMiguSongLists(keyword, page = 1, limit = 20) {
  try {
    const timestamp = String(Date.now());
    const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
    const signature_md5 = "6cdc72a439cef99a3418d2a78aa28c73";
    const sign_raw = `${keyword}${signature_md5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`;
    const sign = crypto.createHash('md5').update(sign_raw).digest('hex');

    const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;
    const headers = {
      uiVersion: "A_music_3.6.1",
      deviceId,
      timestamp,
      sign,
      channel: "0146921",
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; MI 11)",
      "X-Forwarded-For": "116.23.12.34",
      "X-Real-IP": "116.23.12.34",
    };
    const resp = await axios.get(url, { headers });
    return (resp.data?.songListResultData?.result || []).map((item) => ({
      id: String(item.id),
      title: item.name,
      cover: item.musicListPicUrl || "",
      playCount: formatPlayCount(item.playNum),
      rawPlayCount: parseInt(item.playNum, 10) || 0,
      songCount: parseInt(item.musicNum, 10) || 0,
      creator: item.userName || "",
      desc: item.intro || "",
      platform: "mg",
      platform_name: "小蜜音乐",
    }));
  } catch (err) {
    return [];
  }
}

async function searchAllSongLists(keyword, page = 1, limit = 20) {
  const perLimit = Math.max(5, Math.ceil(limit / 3));
  const results = await Promise.allSettled([
    searchQQSongLists(keyword, page, perLimit),
    searchNeteaseSongLists(keyword, page, perLimit),
    searchKuwoSongLists(keyword, page, perLimit),
    searchKugouSongLists(keyword, page, perLimit),
    searchMiguSongLists(keyword, page, perLimit),
  ]);

  const merged = [];
  results.forEach((res) => {
    if (res.status === "fulfilled" && Array.isArray(res.value)) {
      merged.push(...res.value);
    }
  });

  merged.sort((a, b) => {
    const simA = calculateSimilarity(keyword, a.title);
    const simB = calculateSimilarity(keyword, b.title);
    if (Math.abs(simA - simB) > 15) {
      return simB - simA;
    }
    return (b.rawPlayCount || 0) - (a.rawPlayCount || 0);
  });

  return merged.slice(0, limit);
}

const ADAPTERS = {
  qq: qqAdapter,
  tx: qqAdapter,
  netease: neteaseAdapter,
  wy: neteaseAdapter,
  kuwo: kuwoAdapter,
  kw: kuwoAdapter,
  kugou: kugouAdapter,
  kg: kugouAdapter,
  migu: miguAdapter,
  mg: miguAdapter,
};

function getAdapter(platform = "qq") {
  const p = String(platform).toLowerCase();
  return ADAPTERS[p] || ADAPTERS.qq;
}

// ────────────────────────────────────────────────────────────────
// Router 工厂函数
// ────────────────────────────────────────────────────────────────
function createPlaylistRouter() {
  const router = Router();

  // 1. 获取支持的平台列表
  router.get('/platforms', (req, res) => {
    res.json({
      success: true,
      platforms: [
        { id: "qq", name: "QQ音乐", enabled: true },
        { id: "netease", name: "网易云音乐", enabled: true },
        { id: "kuwo", name: "酷我音乐", enabled: true },
        { id: "kugou", name: "酷狗音乐", enabled: true },
        { id: "migu", name: "咪咕音乐", enabled: true },
      ],
    });
  });

  // 2. 获取分类列表
  router.get('/categories', async (req, res) => {
    try {
      const platform = req.query.platform || "qq";
      const cacheKey = `categories_${platform}`;
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }

      const adapter = getAdapter(platform);
      const data = await adapter.getCategories();
      setCache(cacheKey, data, 30 * 60 * 1000);
      return res.json({ success: true, data, platform: adapter.name });
    } catch (err) {
      console.error("[Playlist Categories Error]:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. 获取某分类下的歌单列表
  router.get('/list', async (req, res) => {
    try {
      const platform = req.query.platform || "qq";
      const categoryId = req.query.category_id || req.query.categoryId || "3317";
      const page = parseInt(req.query.page || "0", 10);
      const limit = parseInt(req.query.limit || "30", 10);

      const cacheKey = `list_${platform}_${categoryId}_${page}_${limit}`;
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }

      const adapter = getAdapter(platform);
      const data = await adapter.getPlaylists(categoryId, page, limit);
      setCache(cacheKey, data, 10 * 60 * 1000);
      return res.json({ success: true, data, platform: adapter.name });
    } catch (err) {
      console.error("[Playlist List Error]:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. 获取指定歌单详情及内部歌曲
  router.get('/detail', async (req, res) => {
    try {
      const platform = req.query.platform || "qq";
      const id = req.query.id;
      if (!id) {
        return res.status(400).json({ success: false, error: "Missing required param: id" });
      }

      const cacheKey = `detail_${platform}_${id}`;
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }

      const adapter = getAdapter(platform);
      const data = await adapter.getPlaylistDetail(id);
      setCache(cacheKey, data, 30 * 60 * 1000);
      return res.json({ success: true, data, platform: adapter.name });
    } catch (err) {
      console.error("[Playlist Detail Error]:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. 歌单搜索（支持聚合与各单源）
  router.get('/search', async (req, res) => {
    try {
      const keyword = req.query.keyword || req.query.key || "";
      const source = (req.query.source || req.query.platform || "all").toLowerCase();
      const page = parseInt(req.query.page || "1", 10);
      const limit = parseInt(req.query.limit || "20", 10);

      if (!keyword.trim()) {
        return res.json({ success: true, data: [], total: 0, page, limit, source });
      }

      const cacheKey = `search_${source}_${keyword.trim()}_${page}_${limit}`;
      const cached = getCache(cacheKey);
      if (cached) {
        return res.json({ success: true, ...cached, fromCache: true });
      }

      let list = [];
      if (source === "tx" || source === "qq") {
        list = await searchQQSongLists(keyword.trim(), page, limit);
      } else if (source === "wy" || source === "netease") {
        list = await searchNeteaseSongLists(keyword.trim(), page, limit);
      } else if (source === "kw" || source === "kuwo") {
        list = await searchKuwoSongLists(keyword.trim(), page, limit);
      } else if (source === "kg" || source === "kugou") {
        list = await searchKugouSongLists(keyword.trim(), page, limit);
      } else if (source === "mg" || source === "migu") {
        list = await searchMiguSongLists(keyword.trim(), page, limit);
      } else {
        list = await searchAllSongLists(keyword.trim(), page, limit);
      }

      const resultData = {
        data: list,
        total: list.length,
        page,
        limit,
        source,
      };

      setCache(cacheKey, resultData, 10 * 60 * 1000);
      return res.json({ success: true, ...resultData });
    } catch (err) {
      console.error("[Playlist Search Error]:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = createPlaylistRouter;
