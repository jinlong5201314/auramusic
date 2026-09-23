/**
 * 代理接口 —— 移植自 functions/proxy.ts
 * GET /proxy
 *
 * 核心缓存逻辑与 Cloudflare 版完全一致：
 *   - Cache HIT  → 直接返回缓存内容，不请求上游
 *   - Cache MISS → 请求上游，成功后写入本地内存缓存（5 分钟 TTL）
 *   - 搜索结果为空 / 包含错误 → 不缓存
 */

const { Router } = require('express');
const cache = require('../cache');

const API_BASE_URL = process.env.API_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

const SAFE_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'accept-ranges',
  'content-length', 'content-range', 'etag', 'last-modified', 'expires',
];

function isAllowedKuwoHost(hostname) {
  return hostname && KUWO_HOST_PATTERN.test(hostname);
}

function buildCacheKey(url) {
  // 过滤随机防缓存签名 s 以及 nocache 参数，以便重试成功后能更新同一个缓存项
  const u = new URL(url);
  u.searchParams.delete('s');
  u.searchParams.delete('nocache');
  return u.toString();
}

/** 代理酷我音频流（带 Range 支持） */
async function proxyKuwoAudio(targetUrl, req, res) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid target');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).send('Invalid target');
  }

  const headers = {
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': req.headers['accept'] || '*/*',
  };

  if (isAllowedKuwoHost(parsed.hostname)) {
    headers['Referer'] = 'https://www.kuwo.cn/';
    parsed.protocol = 'http:';
  } else if (parsed.hostname.includes('qq.com')) {
    headers['Referer'] = 'https://y.qq.com/';
  } else if (parsed.hostname.includes('163.com')) {
    headers['Referer'] = 'https://music.163.com/';
  }

  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  try {
    const fetchOptions = {
      method: req.method,
      headers,
      signal: controller.signal
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      if (typeof req.body === 'object') {
        fetchOptions.body = JSON.stringify(req.body);
        headers['Content-Type'] = 'application/json';
      } else {
        fetchOptions.body = req.body;
      }
    }

    const upstream = await fetch(parsed.toString(), fetchOptions);
    res.status(upstream.status);

    for (const h of SAFE_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const { Readable } = require('node:stream');
    return Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    console.error('[Proxy Universal Target Node]', err);
    return res.status(502).send('Upstream error');
  }
}

// Kugou 官方移动端歌词直连解析
async function fetchKugouLyric(id, name, artist) {
  try {
    let hash = '';
    if (typeof id === 'string' && /^[a-fA-F0-9]{32}$/.test(id)) {
      hash = id;
    } else if (name) {
      const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, '').trim();
      const kw = `${cleanName} ${artist}`.trim();
      const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=3&showtype=1`;
      const searchResp = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' },
      });
      if (searchResp.ok) {
        const sData = await searchResp.json();
        const infoList = sData?.data?.info || [];
        let matched = infoList.find((item) => String(item.audio_id) === String(id));
        if (!matched && infoList.length > 0) matched = infoList[0];
        if (matched) {
          hash = matched.sqhash || matched['320hash'] || matched.hash || '';
        }
      }
    }

    if (!hash) return null;

    const lrcSearchUrl = `http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=0&hash=${hash}`;
    const lrcSearchResp = await fetch(lrcSearchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!lrcSearchResp.ok) return null;
    const lrcSearchData = await lrcSearchResp.json();
    const candidate = lrcSearchData?.candidates?.[0];
    if (!candidate?.id || !candidate?.accesskey) return null;

    const downloadUrl = `http://krcs.kugou.com/download?ver=1&client=mobi&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=lrc&charset=utf8`;
    const downloadResp = await fetch(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!downloadResp.ok) return null;
    const downloadData = await downloadResp.json();
    if (downloadData?.content) {
      const decoded = Buffer.from(downloadData.content, 'base64').toString('utf-8');
      if (decoded && decoded.includes('[')) {
        return decoded;
      }
    }
  } catch (err) {
    console.warn('[Kugou Lyric Node] Error:', err);
  }
  return null;
}

/** 代理 music API 请求，带本地缓存 */
async function fetchUnifiedLyric(source, id, name, artist) {
  // 1. QQ 音乐官方接口
  if (source === 'tencent' || source === 'tx' || (typeof id === 'string' && id.startsWith('00'))) {
    try {
      const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${id}&format=json&nobase64=0`;
      const resp = await fetch(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
      if (resp.ok) {
        const data = await resp.json();
        const b64 = data?.lyric || '';
        if (b64) {
          return Buffer.from(b64, 'base64').toString('utf-8');
        }
      }
    } catch (err) {
      console.warn('[QQ Lyric Node] Error:', err);
    }
  }

  // 2. 酷狗音乐官方移动端接口
  if (source === 'kugou' || source === 'kg' || (typeof id === 'string' && /^[a-fA-F0-9]{32}$/.test(id))) {
    const kgLyric = await fetchKugouLyric(id, name, artist);
    if (kgLyric) return kgLyric;
  }

  // 3. 网易云官方接口 (若 ID 为数字)
  if (source === 'netease' || source === 'wy') {
    try {
      const url = `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`;
      const resp = await fetch(url, { headers: { Referer: 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' } });
      if (resp.ok) {
        const data = await resp.json();
        const lrc = data?.lrc?.lyric || '';
        if (lrc) return lrc;
      }
    } catch (err) {
      console.warn('[Netease Lyric Node] Error:', err);
    }
  }

  // 3. 酷我官方接口
  if (source === 'kuwo' || source === 'kw' || (typeof id === 'string' && /^\d+$/.test(id))) {
    try {
      const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
      if (resp.ok) {
        const data = await resp.json();
        const lrclist = data?.data?.lrclist || [];
        if (Array.isArray(lrclist) && lrclist.length > 0) {
          const lines = [];
          for (const item of lrclist) {
            const t = parseFloat(item.time || '0');
            const m = Math.floor(t / 60);
            const s = (t % 60).toFixed(2);
            lines.push(`[${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}]${item.lineLyric || ''}`);
          }
          return lines.join('\n');
        }
      }
    } catch (err) {
      console.warn('[Kuwo Lyric Node] Error:', err);
    }
  }

  // 4. 若有歌名，通过多源搜索智能反查歌词
  if (name) {
    try {
      const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, '').trim();
      const queries = [
        `${cleanName} ${artist}`.trim(),
        cleanName,
      ];

      for (const q of queries) {
        if (!q) continue;
        // 5.1 尝试 GD Studio 网易云聚合反查
        try {
          const gdSearchUrl = `${DEFAULT_API_BASE_URL}?types=search&source=netease&name=${encodeURIComponent(q)}&count=3`;
          const gdSearchResp = await fetch(gdSearchUrl, { headers: { 'User-Agent': 'Meting/1.5.0' } });
          if (gdSearchResp.ok) {
            const gdSongs = await gdSearchResp.json();
            if (Array.isArray(gdSongs)) {
              for (const gds of gdSongs) {
                const lyricTargetId = gds.lyric_id || gds.id;
                if (lyricTargetId) {
                  const lUrl = `${DEFAULT_API_BASE_URL}?types=lyric&source=netease&id=${lyricTargetId}`;
                  const lResp = await fetch(lUrl, { headers: { 'User-Agent': 'Meting/1.5.0' } });
                  if (lResp.ok) {
                    const lData = await lResp.json();
                    const lrc = lData?.lyric || '';
                    if (lrc && lrc.includes('[')) return lrc;
                  }
                }
              }
            }
          }
        } catch {}

        // 5.2 尝试酷狗歌词反查
        const kgFallback = await fetchKugouLyric('', q, '');
        if (kgFallback) return kgFallback;
      }
    } catch (err) {
      console.warn('[Fallback Lyric Node] Error:', err);
    }
  }

  return null;
}

async function checkAudioUrlValid(audioUrl, minSizeBytes = 1.8 * 1024 * 1024) {
  if (!audioUrl || !audioUrl.startsWith('http')) return false;
  try {
    const resp = await fetch(audioUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) return false;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json') || ct.includes('html') || ct.includes('text')) {
      console.warn(`[Audio Validator Node] 拦截到非音频响应类型 (${ct}): ${audioUrl}`);
      return false;
    }
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    // 拦截版权提示语音（<300KB）以及 VIP 27~30秒试听音频切片（通常为 1.05MB 左右）
    if (cl > 0 && cl < minSizeBytes) {
      console.warn(`[Audio Validator Node] 拦截到残缺试听片段/版权提示语音: ${audioUrl} (大小: ${(cl/1024).toFixed(1)} KB < ${(minSizeBytes/1024).toFixed(1)} KB)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Audio Validator Node] 校验出错:', err);
    return false;
  }
}

function isArtistMatch(targetArtist, candidateArtist) {
  if (!targetArtist) return true;
  if (!candidateArtist) return false;
  const cleanTarget = targetArtist.toLowerCase().replace(/[\s\/\,\&、]/g, '');
  const cleanCand = candidateArtist.toLowerCase().replace(/[\s\/\,\&、]/g, '');
  const targetTokens = targetArtist.split(/[\s\/\,\&、]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  const candTokens = candidateArtist.split(/[\s\/\,\&、]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  for (const t of targetTokens) {
    if (candTokens.some(c => c.includes(t) || t.includes(c))) return true;
  }
  return cleanTarget.includes(cleanCand) || cleanCand.includes(cleanTarget);
}

async function findPlayableNeteaseTrack(name, artist, targetDuration = 0, apiBaseUrl = API_BASE_URL) {
  if (!name) return null;
  try {
    const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, '').trim();
    const queries = [
      `${cleanName} ${artist}`.trim(),
      cleanName,
    ];

    for (const q of queries) {
      if (!q) continue;
      const sUrl = `${apiBaseUrl}?types=search&source=netease&name=${encodeURIComponent(q)}&count=10`;
      const sResp = await fetch(sUrl, { headers: { 'User-Agent': 'Meting/1.5.0' } });
      if (!sResp.ok) continue;
      const songs = await sResp.json();
      if (!Array.isArray(songs) || songs.length === 0) continue;

      for (const song of songs) {
        const sid = song.id;
        if (!sid) continue;

        // 1. 严格比对歌手名：若提供了目标歌手，候选歌曲的歌手必须匹配，绝不接受“全网找歌君”等无关翻唱
        if (artist) {
          const songArtists = Array.isArray(song.artist) ? song.artist.join(' ') : String(song.artist || '');
          if (!isArtistMatch(artist, songArtists)) {
            console.log(`[Audio Fallback Node] 跳过歌手不匹配曲目: 《${song.name}》- ${songArtists} (目标: ${artist})`);
            continue;
          }
        }

        // 2. 严格比对歌曲时长：若原曲时长已知（如 247 秒），容差不能超过 ±25 秒，杜绝 126 秒的减半缩水翻唱
        if (targetDuration > 0) {
          try {
            const detailUrl = `https://music.163.com/api/song/detail?ids=[${sid}]`;
            const dResp = await fetch(detailUrl, { headers: { Referer: 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' } });
            if (dResp.ok) {
              const dData = await dResp.json();
              const candDurationMs = dData?.songs?.[0]?.duration || dData?.songs?.[0]?.dt || 0;
              const candDurationSec = Math.floor(candDurationMs / 1000);
              if (candDurationSec > 0 && Math.abs(candDurationSec - targetDuration) > 25) {
                console.log(`[Audio Fallback Node] 跳过时长不匹配曲目: 《${song.name}》${candDurationSec}s (目标: ${targetDuration}s)`);
                continue;
              }
            }
          } catch {}
        }

        const pUrl = `${apiBaseUrl}?types=url&source=netease&id=${sid}&br=320`;
        const pResp = await fetch(pUrl, { headers: { 'User-Agent': 'Meting/1.5.0' } });
        if (!pResp.ok) continue;
        const pData = await pResp.json();
        const realUrl = pData?.url;
        // 门槛设为 2.2MB，彻底杜绝 1.06MB 的 27 秒试听音频
        if (realUrl && (await checkAudioUrlValid(realUrl, 2.2 * 1024 * 1024))) {
          return { url: realUrl, br: 320 };
        }
      }
    }
  } catch (err) {
    console.warn('[Playable Netease Track Fallback Node] Error:', err);
  }
  return null;
}

/** 反查酷狗官方高品质完整音频（带严格歌手比对与时长校验） */
async function fetchKugouDirectFallback(name, artist, targetDuration = 0) {
  try {
    const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, '').trim();
    const kw = `${cleanName} ${artist}`.trim();
    const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=6&showtype=1`;
    const sResp = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
    if (!sResp.ok) return null;
    const sData = await sResp.json();
    const list = sData?.data?.info || [];
    for (const item of list) {
      if (artist && !isArtistMatch(artist, item.singername)) continue;
      if (targetDuration > 0 && Math.abs(item.duration - targetDuration) > 30) continue;
      const hash = item['320hash'] || item.sqhash || item.hash;
      if (!hash) continue;
      const playUrl = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
      const pResp = await fetch(playUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
      if (!pResp.ok) continue;
      const pData = await pResp.json();
      if (pData?.url && pData.fileSize > 2000000) {
        return { url: pData.url, br: 320 };
      }
    }
  } catch (err) {
    console.warn('[Kugou Direct Fallback Node] Error:', err);
  }
  return null;
}

/** 直连 QQ 音乐官方高品质原声音频解析 */
async function fetchTencentDirectUrl(id) {
  if (!id) return null;
  try {
    const url = `https://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${encodeURIComponent(id)}&level=exhigh`;
    const resp = await fetch(url, { redirect: 'manual' });
    if (resp.status === 301 || resp.status === 302) {
      const loc = resp.headers.get('location');
      if (loc && loc.startsWith('http')) return loc;
    }
  } catch (err) {
    console.warn('[Tencent Direct URL Node] Error:', err);
  }
  return null;
}

async function fetchKuwoDirectUrl(query) {
  try {
    const searchUrl = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=0&rn=1&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
    const sResp = await fetch(searchUrl, { headers: { 'User-Agent': 'okhttp/3.10.0' } });
    if (!sResp.ok) return null;
    const sData = await sResp.json();
    const abslist = sData.abslist || [];
    if (abslist.length === 0) return null;

    const rid = (abslist[0].MUSICRID || '').replace('MUSIC_', '');
    const playUrl = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${rid}&format=mp3&response=url`;
    const pResp = await fetch(playUrl, { headers: { 'User-Agent': 'okhttp/3.10.0' } });
    if (!pResp.ok) return null;
    const directUrl = (await pResp.text()).trim();
    if (directUrl.startsWith('http')) {
      const isValid = await checkAudioUrlValid(directUrl);
      if (isValid) {
        return directUrl;
      }
    }
    return null;
  } catch (err) {
    console.warn('[Kuwo Direct URL Node] Error:', err);
    return null;
  }
}

async function proxyApiRequest(reqUrl, req, res) {
  const parsedReq = new URL(reqUrl);
  const bypassCache = parsedReq.searchParams.get('nocache') === 'true';
  const cacheKey = buildCacheKey(reqUrl);

  const types = parsedReq.searchParams.get('types');
  let rawSource = (parsedReq.searchParams.get('source') || 'netease').toLowerCase();
  const sourceMap = { wy: 'netease', tx: 'tencent', kw: 'kuwo', kg: 'kugou', mg: 'migu' };
  const source = sourceMap[rawSource] || rawSource;

  const id = parsedReq.searchParams.get('id') || '';
  const name = parsedReq.searchParams.get('name') || '';
  const artist = parsedReq.searchParams.get('artist') || '';
  const durationStr = parsedReq.searchParams.get('duration') || '';
  const targetDuration = parseFloat(durationStr) || 0;

  // 1.0 如果请求类型为音频 url 且为 QQ 音乐 (tencent/tx)，优先直连官方高品质原声音频解析
  if (types === 'url' && (source === 'tencent' || source === 'tx')) {
    try {
      const directTxUrl = await fetchTencentDirectUrl(id);
      if (directTxUrl && (await checkAudioUrlValid(directTxUrl, 2.2 * 1024 * 1024))) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=1800');
        return res.json({ url: directTxUrl, br: 320, size: 0, from: 'tencent-direct' });
      }
    } catch (txErr) {
      console.warn('[Tencent URL Direct Node] Failed, fallback to search:', txErr);
    }
  }

  // 1.1 如果请求类型为音频 url 且为酷我源，先尝试酷我官方抗反爬直链接口
  if (types === 'url' && (source === 'kuwo' || source === 'kw')) {
    try {
      const playUrl = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${id}&format=mp3&response=url`;
      const pResp = await fetch(playUrl, { headers: { 'User-Agent': 'okhttp/3.10.0' } });
      const directAudioUrl = (await pResp.text()).trim();
      if (directAudioUrl.startsWith('http')) {
        const isValid = await checkAudioUrlValid(directAudioUrl);
        if (isValid) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=1800');
          return res.json({ url: directAudioUrl, br: 320, size: 0, from: 'kuwo.cn' });
        } else {
          console.warn(`[Kuwo URL Direct Node] 酷我单曲(${id})为版权保护语音(<400KB)，拒绝下发假音频，进入智能跨源检索...`);
        }
      }
    } catch (kwErr) {
      console.warn('[Kuwo URL Direct Node] Failed, fallback to search:', kwErr);
    }
  }

  // 1.2 如果请求类型为歌词 lyric，优先通过多源直连引擎解析
  if (types === 'lyric') {
    try {
      const lyricText = await fetchUnifiedLyric(source, id, name, artist);
      if (lyricText) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.json({ lyric: lyricText });
      }
    } catch (lrcErr) {
      console.warn('[Unified Lyric Node] Error:', lrcErr);
    }

    const unsupportedGdSources = ['kugou', 'kg', 'kuwo', 'kw', 'migu', 'mg', 'tencent', 'tx'];
    if (unsupportedGdSources.includes(source)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json({ lyric: '' });
    }
  }

  // ── Cache HIT 检查 ────────────────────────────────────────────────────────
  if (!bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
      return res.send(cached.body);
    }
  }

  // ── Cache MISS：请求上游 ────────────────────────────────────────────────────
  console.log(`[Cache MISS] Fetching from upstream: ${reqUrl}`);

  let upstream;
  let responseText;
  let contentType = 'application/json; charset=utf-8';

  const apiUrl = new URL(API_BASE_URL);
  parsedReq.searchParams.forEach((value, key) => {
    if (key === 'target' || key === 'callback' || key === 's' || key === 'nocache' || key === 'name' || key === 'artist') return;
    apiUrl.searchParams.set(key, value);
  });
  apiUrl.searchParams.set('source', source);

  if (!apiUrl.searchParams.has('types')) {
    return res.status(400).send('Missing types');
  }

  try {
    upstream = await fetch(apiUrl.toString(), {
      headers: {
        'User-Agent': 'Meting/1.5.0',
        'Accept': 'application/json',
      },
    });
    responseText = await upstream.text();
    contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  } catch (err) {
    console.error('[Proxy API fetch]', err);
    return res.status(502).send('Upstream error');
  }

  // 核心强化：如果获取音频 URL 返回空（无版权/VIP拦截）或被判定为版权提示语音
  if (types === 'url') {
    let parsed = null;
    try { parsed = JSON.parse(responseText); } catch {}

    let upstreamAudioUrl = parsed?.url || '';
    let isUpstreamValid = false;
    if (upstreamAudioUrl) {
      isUpstreamValid = await checkAudioUrlValid(upstreamAudioUrl);
    }

    if (upstream.status !== 200 || !isUpstreamValid) {
      const query = `${name} ${artist}`.trim();
      if (query) {
        console.log(`[Audio Fallback Node] 曲目《${query}》无有效完整直链，触发全网智能增强解析...`);
        
        // 尝试 1: 酷狗官方高品质完整音频反查（严格歌手比对 + 时长校验）
        const kugouTrack = await fetchKugouDirectFallback(name, artist, targetDuration);
        if (kugouTrack && kugouTrack.url) {
          const enhancedBody = JSON.stringify({
            url: kugouTrack.url,
            br: kugouTrack.br || 320,
            size: 0,
            from: 'kugou-direct-fallback',
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=1800');
          return res.send(enhancedBody);
        }

        // 尝试 2: 网易云全网反查可用同名高品质音轨（严格比对歌手与时长，严禁 UGC 翻唱）
        const neteaseTrack = await findPlayableNeteaseTrack(name, artist, targetDuration, API_BASE_URL);
        if (neteaseTrack && neteaseTrack.url) {
          const enhancedBody = JSON.stringify({
            url: neteaseTrack.url,
            br: neteaseTrack.br || 320,
            size: 0,
            from: 'netease-fallback',
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=1800');
          return res.send(enhancedBody);
        }

        // 尝试 3: 酷我全网检索（若非版权语音）
        const fallbackAudioUrl = await fetchKuwoDirectUrl(query);
        if (fallbackAudioUrl) {
          const enhancedBody = JSON.stringify({
            url: fallbackAudioUrl,
            br: 320,
            size: 0,
            from: 'kuwo-enhanced',
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=1800');
          return res.send(enhancedBody);
        }
      }

      // 如果全网无免费音源，明确告知版权保护，绝不下发假音频
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        url: '',
        error: 'COPYRIGHT_RESTRICTED',
        message: '该曲目受官方版权或VIP限制，暂无完整免费音源',
      });
    }
  }

  // ── 判断是否缓存（与 Cloudflare 版本逻辑完全一致） ──────────────────────────
  const isSearch = parsedReq.searchParams.get('types') === 'search';
  const isEmptyResult = responseText.trim() === '[]';
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');

  let shouldCache = upstream.status === 200 && !isError && !bypassCache;
  if (isSearch && isEmptyResult) shouldCache = false;

  if (shouldCache) {
    cache.set(cacheKey, { body: responseText, contentType }, 300); // 缓存 5 分钟
    console.log(`[Cache PUT] Saved to cache: ${reqUrl}`);
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Cache-Status', 'MISS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
  res.setHeader('Cache-Control', shouldCache ? 'public, max-age=300' : 'no-store');

  return res.status(upstream.status).send(responseText);
}

module.exports = function createProxyRouter() {
  const router = Router();

  router.options('/', (req, res) => {
    res.status(204)
      .set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      })
      .end();
  });

  router.all('/', async (req, res) => {
    const target = req.query.target;

    if (target) {
      return proxyKuwoAudio(target, req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).send('Method not allowed');
    }

    // 重建完整 URL（含查询参数）给缓存 key 使用
    const fullUrl = `http://localhost${req.originalUrl}`;
    return proxyApiRequest(fullUrl, req, res);
  });

  return router;
};
