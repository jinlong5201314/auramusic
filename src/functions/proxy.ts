const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyUniversalTarget(targetUrl: string, request: Request): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response("Invalid protocol", { status: 400 });
    }
  } catch {
    return new Response("Invalid target URL", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": request.headers.get("Accept") ?? "*/*",
    },
  };

  // 针对酷我等音源特殊处理防盗链 Referer
  if (isAllowedKuwoHost(parsed.hostname)) {
    (init.headers as Record<string, string>)["Referer"] = "https://www.kuwo.cn/";
    parsed.protocol = "http:";
  } else if (parsed.hostname.includes("qq.com")) {
    (init.headers as Record<string, string>)["Referer"] = "https://y.qq.com/";
  } else if (parsed.hostname.includes("163.com")) {
    (init.headers as Record<string, string>)["Referer"] = "https://music.163.com/";
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  // 传递 body（如果是 POST/PUT 等）
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const bodyBlob = await request.blob();
      if (bodyBlob && bodyBlob.size > 0) {
        init.body = bodyBlob;
      }
      const cType = request.headers.get("Content-Type");
      if (cType) {
        (init.headers as Record<string, string>)["Content-Type"] = cType;
      }
    } catch {}
  }

  try {
    const upstream = await fetch(parsed.toString(), init);
    const headers = createCorsHeaders(upstream.headers);
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "public, max-age=3600");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Proxy target failed", message: err?.message || String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

function decodeBase64Utf8(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

// Kugou 官方移动端歌词直连解析
async function fetchKugouLyric(id: string, name: string, artist: string): Promise<string | null> {
  try {
    let hash = "";
    if (typeof id === "string" && /^[a-fA-F0-9]{32}$/.test(id)) {
      hash = id;
    } else if (name) {
      const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
      const kw = `${cleanName} ${artist}`.trim();
      const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=3&showtype=1`;
      const searchResp = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)" },
      });
      if (searchResp.ok) {
        const sData: any = await searchResp.json();
        const infoList = sData?.data?.info || [];
        let matched = infoList.find((item: any) => String(item.audio_id) === String(id));
        if (!matched && infoList.length > 0) matched = infoList[0];
        if (matched) {
          hash = matched.sqhash || matched["320hash"] || matched.hash || "";
        }
      }
    }

    if (!hash) return null;

    const lrcSearchUrl = `http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=0&hash=${hash}`;
    const lrcSearchResp = await fetch(lrcSearchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!lrcSearchResp.ok) return null;
    const lrcSearchData: any = await lrcSearchResp.json();
    const candidate = lrcSearchData?.candidates?.[0];
    if (!candidate?.id || !candidate?.accesskey) return null;

    const downloadUrl = `http://krcs.kugou.com/download?ver=1&client=mobi&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=lrc&charset=utf8`;
    const downloadResp = await fetch(downloadUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!downloadResp.ok) return null;
    const downloadData: any = await downloadResp.json();
    if (downloadData?.content) {
      const decoded = decodeBase64Utf8(downloadData.content);
      if (decoded && decoded.includes("[")) {
        return decoded;
      }
    }
  } catch (err) {
    console.warn("[Kugou Lyric] Error:", err);
  }
  return null;
}

/** 官方多源直连歌词解析引擎 */
async function fetchUnifiedLyric(source: string, id: string, name: string, artist: string, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<string | null> {
  // 1. QQ 音乐官方接口
  if (source === "tencent" || source === "tx" || (typeof id === "string" && id.startsWith("00"))) {
    try {
      const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${id}&format=json&nobase64=0`;
      const resp = await fetch(url, { headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" } });
      if (resp.ok) {
        const data: any = await resp.json();
        const b64 = data?.lyric || "";
        if (b64) {
          return decodeBase64Utf8(b64);
        }
      }
    } catch (err) {
      console.warn("[QQ Lyric] Error:", err);
    }
  }

  // 2. 酷狗音乐官方移动端接口
  if (source === "kugou" || source === "kg" || (typeof id === "string" && /^[a-fA-F0-9]{32}$/.test(id))) {
    const kgLyric = await fetchKugouLyric(id, name, artist);
    if (kgLyric) return kgLyric;
  }

  // 3. 网易云官方接口 (若 ID 为数字)
  if (source === "netease" || source === "wy") {
    try {
      const url = `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`;
      const resp = await fetch(url, { headers: { Referer: "https://music.163.com", "User-Agent": "Mozilla/5.0" } });
      if (resp.ok) {
        const data: any = await resp.json();
        const lrc = data?.lrc?.lyric || "";
        if (lrc) return lrc;
      }
    } catch (err) {
      console.warn("[Netease Lyric] Error:", err);
    }
  }

  // 4. 酷我官方接口
  if (source === "kuwo" || source === "kw" || (typeof id === "string" && /^\d+$/.test(id))) {
    try {
      const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (iPhone)" } });
      if (resp.ok) {
        const data: any = await resp.json();
        const lrclist = data?.data?.lrclist || [];
        if (Array.isArray(lrclist) && lrclist.length > 0) {
          const lines: string[] = [];
          for (const item of lrclist) {
            const t = parseFloat(item.time || "0");
            const m = Math.floor(t / 60);
            const s = (t % 60).toFixed(2);
            lines.push(`[${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}]${item.lineLyric || ""}`);
          }
          return lines.join("\n");
        }
      }
    } catch (err) {
      console.warn("[Kuwo Lyric] Error:", err);
    }
  }

  // 5. 若有歌名，通过全局边缘兼容的网易云聚合搜索反查歌词
  if (name) {
    try {
      const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
      const queries = [
        `${cleanName} ${artist}`.trim(),
        cleanName,
      ];

      for (const q of queries) {
        if (!q) continue;
        // 5.1 优先通过 GD Studio 网易云聚合接口（带严格歌手比对）
        try {
          const gdSearchUrl = `${apiBaseUrl}?types=search&source=netease&name=${encodeURIComponent(q)}&count=6`;
          const gdSearchResp = await fetch(gdSearchUrl, { headers: { "User-Agent": "Meting/1.5.0", Accept: "application/json" } });
          if (gdSearchResp.ok) {
            const gdSongs: any = await gdSearchResp.json();
            if (Array.isArray(gdSongs)) {
              for (const gds of gdSongs) {
                // 严格比对歌手名，杜绝“全网找歌君”、“沈幼楚”等无关翻唱
                const gdsArtist = Array.isArray(gds.artist) ? gds.artist.join(" ") : String(gds.artist || "");
                if (artist && !isArtistMatch(artist, gdsArtist)) {
                  continue;
                }
                const lyricTargetId = gds.lyric_id || gds.id;
                if (lyricTargetId) {
                  const lUrl = `${apiBaseUrl}?types=lyric&source=netease&id=${lyricTargetId}`;
                  const lResp = await fetch(lUrl, { headers: { "User-Agent": "Meting/1.5.0", Accept: "application/json" } });
                  if (lResp.ok) {
                    const lData: any = await lResp.json();
                    const lrc = lData?.lyric || "";
                    if (lrc && lrc.includes("[")) return lrc;
                  }
                }
              }
            }
          }
        } catch {}

        // 5.2 尝试酷狗歌词兜底（带歌手与歌名）
        const kgFallback = await fetchKugouLyric("", q, artist);
        if (kgFallback) return kgFallback;
      }
    } catch (err) {
      console.warn("[Fallback Lyric] Error:", err);
    }
  }

  return null;
}

/** 严格检测音频直链有效性：过滤版权提示语音、报错JSON以及VIP试听片段（通常 < 1.8MB） */
async function checkAudioUrlValid(audioUrl: string, minSizeBytes: number = 1.8 * 1024 * 1024): Promise<boolean> {
  if (!audioUrl || !audioUrl.startsWith("http")) return false;
  try {
    const resp = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return false;
    const ct = (resp.headers.get("Content-Type") || "").toLowerCase();
    if (ct.includes("json") || ct.includes("html") || ct.includes("text")) {
      console.warn(`[Audio Validator] 拦截到非音频响应类型 (${ct}): ${audioUrl}`);
      return false;
    }
    const cl = parseInt(resp.headers.get("Content-Length") || "0", 10);
    // 拦截版权提示语音（<300KB）以及 VIP 27~30秒试听音频切片（通常为 1.05MB 左右）
    if (cl > 0 && cl < minSizeBytes) {
      console.warn(`[Audio Validator] 拦截到残缺试听片段/版权提示语音: ${audioUrl} (大小: ${(cl/1024).toFixed(1)} KB < ${(minSizeBytes/1024).toFixed(1)} KB)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Audio Validator] 校验出错:", err);
    return false;
  }
}

function isArtistMatch(targetArtist: string, candidateArtist: string, songName?: string): boolean {
  if (!targetArtist) return true;
  if (!candidateArtist) return false;
  // 特殊容灾：若曲名中明确包含了目标原唱（例如 "Cover 张妙格"、"(张妙格)"），视为官方伴奏/翻唱，属于合法替代音频
  if (songName && songName.includes(targetArtist)) {
    return true;
  }
  const cleanTarget = targetArtist.toLowerCase().replace(/[\s\/\,\&、]/g, "");
  const cleanCand = candidateArtist.toLowerCase().replace(/[\s\/\,\&、]/g, "");
  const targetTokens = targetArtist.split(/[\s\/\,\&、]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  const candTokens = candidateArtist.split(/[\s\/\,\&、]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  for (const t of targetTokens) {
    if (candTokens.some(c => c.includes(t) || t.includes(c))) return true;
  }
  return cleanTarget.includes(cleanCand) || cleanCand.includes(cleanTarget);
}

/** 跨平台寻找可正常播放的完整音轨（严格比对歌手名与时长，杜绝下发 UGC 翻唱与试听短音频） */
async function findPlayableNeteaseTrack(name: string, artist: string, targetDuration: number = 0, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<{ url: string; br: number } | null> {
  if (!name) return null;
  try {
    const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
    const queries = [
      `${cleanName} ${artist}`.trim(),
      cleanName,
    ];

    for (const q of queries) {
      if (!q) continue;
      const sUrl = `${apiBaseUrl}?types=search&source=netease&name=${encodeURIComponent(q)}&count=10`;
      const sResp = await fetch(sUrl, { headers: { "User-Agent": "Meting/1.5.0" } });
      if (!sResp.ok) continue;
      const songs: any = await sResp.json();
      if (!Array.isArray(songs) || songs.length === 0) continue;

      for (const song of songs) {
        const sid = song.id;
        if (!sid) continue;

        // 1. 严格比对歌手名：若提供了目标歌手，候选歌曲的歌手或曲名必须匹配
        if (artist) {
          const songArtists = Array.isArray(song.artist) ? song.artist.join(" ") : String(song.artist || "");
          if (!isArtistMatch(artist, songArtists, song.name)) {
            console.log(`[Audio Fallback] 跳过歌手不匹配曲目: 《${song.name}》- ${songArtists} (目标: ${artist})`);
            continue;
          }
        }

        // 2. 严格比对歌曲时长：若原曲时长已知（如 247 秒），容差不能超过 ±25 秒，杜绝 126 秒的减半缩水翻唱
        if (targetDuration > 0) {
          try {
            const detailUrl = `https://music.163.com/api/song/detail?ids=[${sid}]`;
            const dResp = await fetch(detailUrl, { headers: { Referer: "https://music.163.com", "User-Agent": "Mozilla/5.0" } });
            if (dResp.ok) {
              const dData: any = await dResp.json();
              const candDurationMs = dData?.songs?.[0]?.duration || dData?.songs?.[0]?.dt || 0;
              const candDurationSec = Math.floor(candDurationMs / 1000);
              if (candDurationSec > 0 && Math.abs(candDurationSec - targetDuration) > 25) {
                console.log(`[Audio Fallback] 跳过时长不匹配曲目: 《${song.name}》${candDurationSec}s (目标: ${targetDuration}s)`);
                continue;
              }
            }
          } catch {}
        }

        const pUrl = `${apiBaseUrl}?types=url&source=netease&id=${sid}&br=320`;
        const pResp = await fetch(pUrl, { headers: { "User-Agent": "Meting/1.5.0" } });
        if (!pResp.ok) continue;
        const pData: any = await pResp.json();
        const realUrl = pData?.url;
        // 门槛设为 2.2MB，彻底杜绝 1.06MB 的 27 秒试听音频
        if (realUrl && (await checkAudioUrlValid(realUrl, 2.2 * 1024 * 1024))) {
          return { url: realUrl, br: 320 };
        }
      }
    }
  } catch (err) {
    console.warn("[Playable Netease Track Fallback] Error:", err);
  }
  return null;
}

/** 反查酷狗官方高品质完整音频（带严格歌手比对与时长校验） */
async function fetchKugouDirectFallback(name: string, artist: string, targetDuration: number = 0): Promise<{ url: string; br: number } | null> {
  try {
    const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
    const kw = `${cleanName} ${artist}`.trim();
    const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=6&showtype=1`;
    const sResp = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0 (iPhone)" } });
    if (!sResp.ok) return null;
    const sData: any = await sResp.json();
    const list = sData?.data?.info || [];
    for (const item of list) {
      if (artist && !isArtistMatch(artist, item.singername)) continue;
      if (targetDuration > 0 && Math.abs(item.duration - targetDuration) > 30) continue;
      const hash = item["320hash"] || item.sqhash || item.hash;
      if (!hash) continue;
      const playUrl = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
      const pResp = await fetch(playUrl, { headers: { "User-Agent": "Mozilla/5.0 (iPhone)" } });
      if (!pResp.ok) continue;
      const pData: any = await pResp.json();
      if (pData?.url && pData.fileSize > 2000000) {
        return { url: pData.url, br: 320 };
      }
    }
  } catch (err) {
    console.warn("[Kugou Direct Fallback] Error:", err);
  }
  return null;
}

/** 直连 QQ 音乐官方高品质原声音频解析 */
async function fetchTencentDirectUrl(id: string): Promise<string | null> {
  if (!id) return null;
  try {
    const url = `https://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${encodeURIComponent(id)}&level=exhigh`;
    const resp = await fetch(url, { redirect: "manual" });
    if (resp.status === 301 || resp.status === 302) {
      const loc = resp.headers.get("location");
      if (loc && loc.startsWith("http")) return loc;
    }
  } catch (err) {
    console.warn("[Tencent Direct URL] Error:", err);
  }
  return null;
}

/** 反查酷我免 VIP 官方音频直链（带防版权语音验证） */
async function fetchKuwoDirectUrl(query: string): Promise<string | null> {
  try {
    const searchUrl = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=0&rn=1&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
    const sResp = await fetch(searchUrl, { headers: { "User-Agent": "okhttp/3.10.0" } });
    if (!sResp.ok) return null;
    const sData: any = await sResp.json();
    const abslist = sData.abslist || [];
    if (abslist.length === 0) return null;

    const rid = (abslist[0].MUSICRID || "").replace("MUSIC_", "");
    const playUrl = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${rid}&format=mp3&response=url`;
    const pResp = await fetch(playUrl, { headers: { "User-Agent": "okhttp/3.10.0" } });
    if (!pResp.ok) return null;
    const directUrl = (await pResp.text()).trim();
    if (directUrl.startsWith("http")) {
      const isValid = await checkAudioUrlValid(directUrl);
      if (isValid) {
        return directUrl;
      }
    }
    return null;
  } catch (err) {
    console.warn("[Kuwo Direct URL] Error:", err);
    return null;
  }
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;

  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache，加入全局缓存版本号杜绝历史污染缓存）
  const CACHE_VERSION = "v3.2.5";
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  cacheUrl.searchParams.set("_v", CACHE_VERSION);

  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  const types = url.searchParams.get("types");
  let rawSource = (url.searchParams.get("source") || "netease").toLowerCase();
  const sourceMap: Record<string, string> = { wy: "netease", tx: "tencent", kw: "kuwo", kg: "kugou", mg: "migu" };
  const source = sourceMap[rawSource] || rawSource;

  const id = url.searchParams.get("id") || "";
  const name = url.searchParams.get("name") || "";
  const artist = url.searchParams.get("artist") || "";
  const durationStr = url.searchParams.get("duration") || "";
  const targetDuration = parseFloat(durationStr) || 0;

  // 1.0 如果请求类型为音频 url 且为 QQ 音乐 (tencent/tx)，优先直连官方高品质原声音频解析
  if (types === "url" && (source === "tencent" || source === "tx")) {
    try {
      const directTxUrl = await fetchTencentDirectUrl(id);
      if (directTxUrl && (await checkAudioUrlValid(directTxUrl, 2.2 * 1024 * 1024))) {
        const jsonBody = JSON.stringify({ url: directTxUrl, br: 320, size: 0, from: "tencent-direct" });
        const resp = new Response(jsonBody, {
          status: 200,
          headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" })),
        });
        if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      }
    } catch (txErr) {
      console.warn("[Tencent URL Direct] Failed, fallback to search:", txErr);
    }
  }

  // 1.1 如果请求类型为音频 url 且为酷我源，直接调用酷我官方抗反爬直链接口
  if (types === "url" && (source === "kuwo" || source === "kw")) {
    try {
      const playUrl = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${id}&format=mp3&response=url`;
      const pResp = await fetch(playUrl, { headers: { "User-Agent": "okhttp/3.10.0" } });
      const directAudioUrl = (await pResp.text()).trim();
      if (directAudioUrl.startsWith("http")) {
        const isValid = await checkAudioUrlValid(directAudioUrl);
        if (isValid) {
          const jsonBody = JSON.stringify({ url: directAudioUrl, br: 320, size: 0, from: "kuwo.cn" });
          const resp = new Response(jsonBody, {
            status: 200,
            headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" })),
          });
          if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, resp.clone()));
          return resp;
        } else {
          console.warn(`[Kuwo URL Direct] 酷我单曲(${id})为版权保护语音(<400KB)，拒绝下发假音频，进入智能跨源检索...`);
        }
      }
    } catch (kwErr) {
      console.warn("[Kuwo URL Direct] Failed, fallback to search:", kwErr);
    }
  }

  // 1.2 如果请求类型为歌词 lyric，优先通过多源直连引擎解析（完美规避第三方网关不支持 tencent/kuwo/kugou 报 400）
  if (types === "lyric") {
    try {
      const lyricText = await fetchUnifiedLyric(source, id, name, artist, apiBaseUrl);
      if (lyricText) {
        const jsonBody = JSON.stringify({ lyric: lyricText });
        const resp = new Response(jsonBody, {
          status: 200,
          headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" })),
        });
        if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      }
    } catch (lrcErr) {
      console.warn("[Unified Lyric] Error:", lrcErr);
    }

    // 核心兜底保护：GD Studio 不支持 kugou/kg/kuwo/kw/migu/mg/tencent/tx 的 lyric 请求，直接返回空歌词 200，绝不透传报 400
    const unsupportedGdSources = ["kugou", "kg", "kuwo", "kw", "migu", "mg", "tencent", "tx"];
    if (unsupportedGdSources.includes(source)) {
      return new Response(JSON.stringify({ lyric: "" }), {
        status: 200,
        headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" })),
      });
    }
  }

  // 1.3 如果请求类型为封面 pic，且为非网易源，拦截 400 报错并安全兜底
  if (types === "pic") {
    const unsupportedPicSources = ["kugou", "kg", "kuwo", "kw", "migu", "mg", "tencent", "tx"];
    if (unsupportedPicSources.includes(source)) {
      return new Response(JSON.stringify({ url: "" }), {
        status: 200,
        headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" })),
      });
    }
  }

  // 2. 向上游发起标准转发
  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache" || key === "name" || key === "artist") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  // 规范化 source 给上游
  apiUrl.searchParams.set("source", source);

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  let upstreamResponseText = "";
  let upstreamStatus = 200;
  try {
    const upstream = await fetch(apiUrl.toString(), {
      headers: {
        "User-Agent": "Meting/1.5.0",
        Accept: "application/json",
      },
    });
    upstreamStatus = upstream.status;
    upstreamResponseText = await upstream.text();
  } catch (upErr: any) {
    upstreamStatus = 500;
    upstreamResponseText = JSON.stringify({ error: upErr.message });
  }

  // 3. 核心强化：如果获取音频 URL 返回空（无版权/会员下架/400），或被检测为版权保护音频
  if (types === "url") {
    let parsed: any = null;
    try { parsed = JSON.parse(upstreamResponseText); } catch {}

    let upstreamAudioUrl = parsed?.url || "";
    let isUpstreamValid = false;
    if (upstreamAudioUrl) {
      isUpstreamValid = await checkAudioUrlValid(upstreamAudioUrl);
    }

    if (upstreamStatus !== 200 || !isUpstreamValid) {
      const query = `${name} ${artist}`.trim();
      if (query) {
        console.log(`[Audio Fallback] 曲目《${query}》无有效完整直链，触发全网智能增强解析...`);
        
        // 尝试 1: 酷狗官方高品质完整音频反查（严格歌手比对 + 时长校验）
        const kugouTrack = await fetchKugouDirectFallback(name, artist, targetDuration);
        if (kugouTrack && kugouTrack.url) {
          const enhancedBody = JSON.stringify({
            url: kugouTrack.url,
            br: kugouTrack.br || 320,
            size: 0,
            from: "kugou-direct-fallback",
          });
          const enhancedResp = new Response(enhancedBody, {
            status: 200,
            headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" })),
          });
          if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, enhancedResp.clone()));
          return enhancedResp;
        }

        // 尝试 2: 网易云全网反查可用同名高品质音轨（严格比对歌手与时长，严禁 UGC 翻唱）
        const neteaseTrack = await findPlayableNeteaseTrack(name, artist, targetDuration, apiBaseUrl);
        if (neteaseTrack && neteaseTrack.url) {
          const enhancedBody = JSON.stringify({
            url: neteaseTrack.url,
            br: neteaseTrack.br || 320,
            size: 0,
            from: "netease-fallback",
          });
          const enhancedResp = new Response(enhancedBody, {
            status: 200,
            headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" })),
          });
          if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, enhancedResp.clone()));
          return enhancedResp;
        }

        // 尝试 3: 酷我全网检索（若非版权语音）
        const fallbackAudioUrl = await fetchKuwoDirectUrl(query);
        if (fallbackAudioUrl) {
          const enhancedBody = JSON.stringify({
            url: fallbackAudioUrl,
            br: 320,
            size: 0,
            from: "kuwo-enhanced",
          });
          const enhancedResp = new Response(enhancedBody, {
            status: 200,
            headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" })),
          });
          if (waitUntil && !bypassCache) waitUntil(cache.put(cacheKey, enhancedResp.clone()));
          return enhancedResp;
        }
      }

      // 如果全网无免费音源，明确告知版权保护，绝不下发假音频
      const notFoundBody = JSON.stringify({
        url: "",
        error: "COPYRIGHT_RESTRICTED",
        message: "该曲目受官方版权或VIP限制，暂无完整免费音源",
      });
      return new Response(notFoundBody, {
        status: 200,
        headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })),
      });
    }
  }

  const headers = createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8" }));
  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  const isSearch = types === "search";
  const isEmptyResult = upstreamResponseText.trim() === "[]";
  const isError = upstreamResponseText.includes('"error"') || upstreamResponseText.includes('"status":0');
  let shouldCache = upstreamStatus === 200 && request.method === "GET" && !isError && !bypassCache;
  if (isSearch && isEmptyResult) shouldCache = false;

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(upstreamResponseText, {
    status: upstreamStatus,
    headers,
  });

  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }: { request: Request; waitUntil: (promise: Promise<any>) => void; env: any }): Promise<Response> {
  const apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyUniversalTarget(target, request);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
