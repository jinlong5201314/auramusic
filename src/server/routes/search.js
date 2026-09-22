const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const CHINA_FORWARD_HEADERS = {
  'X-Forwarded-For': '116.23.12.34',
  'X-Real-IP': '116.23.12.34',
  'Client-IP': '116.23.12.34',
  'True-Client-IP': '116.23.12.34',
};

// ─── 小秋音乐 (QQ/tx) zzc 动态签名 ──────────────────────────────────────────
const TX_PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const TX_PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const TX_SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getTxSearchId() {
  let guid = '';
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16);
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
}

function zzcSign(text) {
  const hash = sha1(text) + '0';
  const part1 = TX_PART_1_INDEXES.map((idx) => hash[idx] || '0').join('');
  const part2 = TX_PART_2_INDEXES.map((idx) => hash[idx] || '0').join('');
  const part3Bytes = [];
  for (let i = 0; i < TX_SCRAMBLE_VALUES.length; i++) {
    const hexByte = parseInt(hash.slice(i * 2, i * 2 + 2), 16) || 0;
    part3Bytes.push(TX_SCRAMBLE_VALUES[i] ^ hexByte);
  }
  const b64 = Buffer.from(part3Bytes).toString('base64').replace(/[\/+=]/g, '');
  return `zzc${part1}${b64}${part2}`.toLowerCase();
}

async function searchTx(keyword, page = 1, limit = 20) {
  try {
    const searchId = getTxSearchId();
    const payload = {
      comm: {
        _channelid: '0',
        _os_version: '6.2.9200-2',
        ct: '19',
        cv: '2151',
        guid: '1F70E520B2EAA7D25E11760783C53CA9',
        patch: '118',
        psrf_access_token_expiresAt: 0,
        psrf_qqaccess_token: '',
        psrf_qqopenid: '',
        psrf_qqunionid: '',
        tmeAppID: 'qqmusic',
        tmeLoginType: 0,
        uin: '0',
        wid: '7223299733393904640',
      },
      'music.search.SearchCgiService': {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          grp: 1,
          num_per_page: limit,
          page_num: page,
          query: keyword,
          remoteplace: 'txt.newclient.top',
          search_type: 0,
          searchid: searchId,
        },
      },
    };

    const bodyStr = JSON.stringify(payload);
    const sign = zzcSign(bodyStr);
    const url = `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'QQMusic 14090508(android 12)',
        'Content-Type': 'application/json',
      },
      body: bodyStr,
    });

    if (!resp.ok) return [];
    const res = await resp.json();
    const songs = res?.['music.search.SearchCgiService']?.data?.body?.song?.list || [];

    return songs.map((s) => {
      const f = s.file || {};
      const formats = [];
      if (f.size_128mp3) formats.push('128k');
      if (f.size_320mp3) formats.push('320k');
      if (f.size_flac) formats.push('flac');
      if (f.size_hires) formats.push('flac24bit');

      const singer = (s.singer || []).map((sg) => sg.name).join(' / ');
      const mid = s.mid || '';
      const albumMid = s.album?.mid || '';
      const cover = albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
        : (s.singer?.[0]?.mid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${s.singer[0].mid}.jpg` : '');

      return {
        id: mid,
        name: s.title || '',
        artist: singer,
        album: s.album?.name || '',
        pic_id: mid,
        pic: cover,
        url_id: mid,
        lyric_id: mid,
        source: 'tx',
        source_name: '小秋音乐',
        duration: s.interval || 0,
        formats: formats.length > 0 ? formats : ['128k', '320k'],
      };
    });
  } catch (err) {
    console.error('[Search TX] Error:', err);
    return [];
  }
}

// ─── 小芸音乐 (网易云/wy) ─────────────────────────────────────────────────────
async function searchWy(keyword, page = 1, limit = 20) {
  try {
    const offset = (page - 1) * limit;
    const url = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(keyword)}&type=1&offset=${offset}&total=true&limit=${limit}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://music.163.com',
        Cookie: 'os=pc; appver=2.9.8',
        ...CHINA_FORWARD_HEADERS,
      },
    });

    if (resp.ok) {
      const data = await resp.json();
      const songs = data?.result?.songs || [];
      if (Array.isArray(songs) && songs.length > 0) {
        return songs.map((s) => {
          const artists = (s.artists || []).map((a) => a.name).join(' / ');
          const id = String(s.id);
          const album = s.album || {};
          const cover = album.picUrl || '';

          return {
            id,
            name: s.name || '',
            artist: artists,
            album: album.name || '',
            pic_id: id,
            pic: cover,
            url_id: id,
            lyric_id: id,
            source: 'wy',
            source_name: '小芸音乐',
            duration: Math.round((s.duration || 0) / 1000),
            formats: ['128k', '320k', 'flac'],
          };
        });
      }
    }
  } catch (err) {
    console.error('[Search WY 官方] Error:', err);
  }

  // 备用兜底：走 GD 音乐台网易云接口
  try {
    const fallbackUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${encodeURIComponent(keyword)}&count=${limit}&pages=${page}`;
    const fbResp = await fetch(fallbackUrl);
    if (fbResp.ok) {
      const fbData = await fbResp.json();
      if (Array.isArray(fbData)) {
        return fbData.map((s) => ({
          id: String(s.id),
          name: s.name || '',
          artist: Array.isArray(s.artist) ? s.artist.join(' / ') : (s.artist || ''),
          album: s.album || '',
          pic_id: String(s.pic_id || s.id),
          pic: '',
          url_id: String(s.url_id || s.id),
          lyric_id: String(s.lyric_id || s.id),
          source: 'wy',
          source_name: '小芸音乐',
          duration: 0,
          formats: ['128k', '320k'],
        }));
      }
    }
  } catch (fbErr) {
    console.error('[Search WY 兜底] Error:', fbErr);
  }

  return [];
}

// ─── 小蜗音乐 (酷我/kw) ───────────────────────────────────────────────────────
async function searchKw(keyword, page = 1, limit = 20) {
  try {
    const pn = page - 1;
    const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${pn}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'okhttp/3.10.0',
        ...CHINA_FORWARD_HEADERS,
      },
    });

    if (!resp.ok) return [];
    const text = await resp.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    const abslist = data.abslist || [];
    return abslist.map((item) => {
      const rid = (item.MUSICRID || '').replace('MUSIC_', '');
      const formats = ['128k'];
      const rawFormats = item.FORMATS || item.formats || '';
      if (rawFormats.includes('MP3') || rawFormats.includes('128')) formats.push('320k');
      if (rawFormats.includes('FLAC')) formats.push('flac');

      return {
        id: rid,
        name: decodeHtmlEntities(item.SONGNAME || ''),
        artist: decodeHtmlEntities(item.ARTIST || ''),
        album: decodeHtmlEntities(item.ALBUM || ''),
        pic_id: rid,
        pic: '',
        url_id: rid,
        lyric_id: rid,
        source: 'kw',
        source_name: '小蜗音乐',
        duration: parseInt(item.DURATION || '0', 10),
        formats,
      };
    });
  } catch (err) {
    console.error('[Search KW] Error:', err);
    return [];
  }
}

// ─── 小枸音乐 (酷狗/kg) ───────────────────────────────────────────────────────
async function searchKg(keyword, page = 1, limit = 20) {
  try {
    const url = `http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=${encodeURIComponent(keyword)}&hifiquality=0&pagesize=${limit}&PrivilegeFilter=0&page=${page}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10)',
        ...CHINA_FORWARD_HEADERS,
      },
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    const lists = data?.data?.lists || [];

    return lists.map((item) => {
      const formats = [];
      if (item.FileSize) formats.push('128k');
      if (item.HQFileSize) formats.push('320k');
      if (item.SQFileSize) formats.push('flac');
      if (item.ResFileSize) formats.push('flac24bit');

      const hash = item.FileHash || '';
      const audioId = String(item.Audioid || '');

      return {
        id: hash,
        name: decodeHtmlEntities(item.SongName || ''),
        artist: decodeHtmlEntities(item.SingerName || ''),
        album: decodeHtmlEntities(item.AlbumName || ''),
        pic_id: hash,
        pic: '',
        url_id: audioId || hash,
        lyric_id: hash,
        source: 'kg',
        source_name: '小枸音乐',
        duration: item.Duration || 0,
        formats: formats.length > 0 ? formats : ['128k', '320k'],
      };
    });
  } catch (err) {
    console.error('[Search KG] Error:', err);
    return [];
  }
}

// ─── 小蜜音乐 (咪咕/mg) ───────────────────────────────────────────────────────
async function searchMg(keyword, page = 1, limit = 20) {
  try {
    const timestamp = Date.now().toString();
    const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
    const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73';
    const sign = md5(`${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`);

    const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;

    const resp = await fetch(url, {
      headers: {
        uiVersion: 'A_music_3.6.1',
        deviceId,
        timestamp,
        sign,
        channel: '0146921',
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
        ...CHINA_FORWARD_HEADERS,
      },
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    const resultList = data?.songResultData?.resultList || [];

    const res = [];
    for (const group of resultList) {
      const items = Array.isArray(group) ? group : [group];
      for (const s of items) {
        if (!s || !s.name) continue;
        const singers = (s.singers || []).map((sg) => sg.name).filter(Boolean).join(' / ');
        const formats = [];
        for (const af of s.audioFormats || []) {
          if (af.formatType === 'PQ') formats.push('128k');
          else if (af.formatType === 'HQ') formats.push('320k');
          else if (af.formatType === 'SQ') formats.push('flac');
          else if (af.formatType === 'ZQ24') formats.push('flac24bit');
        }

        let cover = s.img3 || s.img2 || s.img1 || '';
        if (cover && !cover.startsWith('http')) cover = `http://d.musicapp.migu.cn${cover}`;

        const songId = String(s.id || s.copyrightId || '');
        res.push({
          id: s.copyrightId || songId,
          name: decodeHtmlEntities(s.name),
          artist: decodeHtmlEntities(singers),
          album: decodeHtmlEntities(s.albums?.[0]?.name || ''),
          pic_id: songId,
          pic: cover,
          url_id: songId,
          lyric_id: songId,
          source: 'mg',
          source_name: '小蜜音乐',
          duration: 0,
          formats: formats.length > 0 ? formats : ['128k', '320k'],
        });
      }
    }
    return res;
  } catch (err) {
    console.error('[Search MG] Error:', err);
    return [];
  }
}

// ─── 聚合大会 (all) ────────────────────────────────────────────────────────
async function searchAll(keyword, page = 1, limit = 20) {
  const perSourceLimit = Math.max(5, Math.ceil(limit / 2));
  const tasks = [
    searchTx(keyword, page, perSourceLimit),
    searchWy(keyword, page, perSourceLimit),
    searchKw(keyword, page, perSourceLimit),
    searchKg(keyword, page, perSourceLimit),
    searchMg(keyword, page, perSourceLimit),
  ];

  const results = await Promise.allSettled(tasks);
  const combined = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      combined.push(...r.value);
    }
  }

  const seen = new Set();
  const scoredList = [];
  const normKw = keyword.toLowerCase().trim();

  for (const song of combined) {
    const cleanName = song.name.toLowerCase().replace(/\s+/g, '').replace(/\(.*?\)|（.*?）/g, '');
    const cleanArtist = song.artist.toLowerCase().replace(/\s+/g, '');
    const dedupeKey = `${cleanName}__${cleanArtist}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let score = 0;
    const fullName = `${song.name} ${song.artist}`.toLowerCase();
    if (song.name.toLowerCase() === normKw) score += 100;
    else if (song.name.toLowerCase().includes(normKw)) score += 50;
    if (song.artist.toLowerCase().includes(normKw)) score += 30;
    if (fullName.includes(normKw)) score += 10;
    if (song.formats.includes('flac') || song.formats.includes('flac24bit')) score += 5;

    song.score = score;
    scoredList.push(song);
  }

  scoredList.sort((a, b) => (b.score || 0) - (a.score || 0));
  return scoredList.slice(0, limit);
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ─── Express 路由入口 ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const keyword = req.query.keyword || req.query.name || '';
  const source = (req.query.source || 'all').toLowerCase();
  const page = parseInt(req.query.page || req.query.pages || '1', 10) || 1;
  const limit = parseInt(req.query.limit || req.query.count || '20', 10) || 20;

  if (!keyword.trim()) {
    return res.status(400).json({ success: false, error: '缺少搜索关键词 keyword' });
  }

  let list = [];
  switch (source) {
    case 'tx':
    case 'qq':
      list = await searchTx(keyword, page, limit);
      break;
    case 'wy':
    case 'netease':
      list = await searchWy(keyword, page, limit);
      break;
    case 'kw':
    case 'kuwo':
      list = await searchKw(keyword, page, limit);
      break;
    case 'kg':
    case 'kugou':
      list = await searchKg(keyword, page, limit);
      break;
    case 'mg':
    case 'migu':
      list = await searchMg(keyword, page, limit);
      break;
    case 'all':
    default:
      list = await searchAll(keyword, page, limit);
      break;
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json(list);
});

module.exports = router;
