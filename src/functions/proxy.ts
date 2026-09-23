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
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
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

/** 官方多源直连歌词解析引擎 */
async function fetchUnifiedLyric(source: string, id: string, name: string, artist: string): Promise<string | null> {
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

  // 2. 网易云官方接口 (若 ID 为数字)
  if (source === "netease" || source === "wy" || (typeof id === "string" && /^\d+$/.test(id))) {
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

  // 3. 酷我官方接口
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

      // 4. 若有歌名，通过网易云搜索反查歌词
      if (name) {
        try {
          const cleanName = name.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
          const queries = [
            `${name} ${artist}`.trim(),
            `${cleanName} ${artist}`.trim(),
            name.trim(),
            cleanName,
          ];

          for (const q of queries) {
            if (!q) continue;
            // 4.1 尝试网易云搜索反查
            const sUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=3`;
            const sResp = await fetch(sUrl, { headers: { Referer: "https://music.163.com", "User-Agent": "Mozilla/5.0" } });
            if (sResp.ok) {
              const sData: any = await sResp.json();
              const songs = sData?.result?.songs || [];
              for (const song of songs) {
                if (song.id) {
                  const lUrl = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`;
                  const lResp = await fetch(lUrl, { headers: { Referer: "https://music.163.com", "User-Agent": "Mozilla/5.0" } });
                  if (lResp.ok) {
                    const lData: any = await lResp.json();
                    const lrc = lData?.lrc?.lyric || "";
                    if (lrc && lrc.includes("[")) return lrc;
                  }
                }
              }
            }

            // 4.2 尝试 QQ 音乐官方搜索反查歌词（极速且带精准逐句歌词）
            const qqSearchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=3&w=${encodeURIComponent(q)}&format=json`;
            const qqSearchResp = await fetch(qqSearchUrl, { headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" } });
            if (qqSearchResp.ok) {
              const qqData: any = await qqSearchResp.json();
              const qqSongs = qqData?.data?.song?.list || [];
              for (const qs of qqSongs) {
                if (qs.songmid) {
                  const qqLrcUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${qs.songmid}&format=json&nobase64=0`;
                  const qqLrcResp = await fetch(qqLrcUrl, { headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" } });
                  if (qqLrcResp.ok) {
                    const lrcData: any = await qqLrcResp.json();
                    if (lrcData?.lyric) {
                      const decoded = decodeBase64Utf8(lrcData.lyric);
                      if (decoded && decoded.includes("[")) return decoded;
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn("[Fallback Lyric] Error:", err);
        }
      }

  return null;
}

/** 严格检测音频直链有效性：过滤掉平台下发的短小版权声明语音（通常 < 300KB） */
async function checkAudioUrlValid(audioUrl: string): Promise<boolean> {
  if (!audioUrl || !audioUrl.startsWith("http")) return false;
  try {
    const resp = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return false;
    const cl = parseInt(resp.headers.get("Content-Length") || "0", 10);
    // 酷我/腾讯等平台的版权提示音频通常为 80KB ~ 181KB
    // 完整歌曲即使 128k 2分钟也在 1.8MB 以上，设定 400KB 拦截阈值
    if (cl > 0 && cl < 400 * 1024) {
      console.warn(`[Audio Validator] 拦截到版权提示语音: ${audioUrl} (文件大小: ${cl} 字节 < 400KB)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Audio Validator] 校验出错:", err);
    return false;
  }
}

/** 跨平台寻找可正常播放的完整音轨 */
async function findPlayableNeteaseTrack(name: string, artist: string, apiBaseUrl: string): Promise<{ url: string; br: number } | null> {
  if (!name) return null;
  try {
    const q = `${name} ${artist}`.trim();
    const sUrl = `${apiBaseUrl}?types=search&source=netease&name=${encodeURIComponent(q)}&count=8`;
    const sResp = await fetch(sUrl, { headers: { "User-Agent": "Meting/1.5.0" } });
    if (!sResp.ok) return null;
    const songs: any = await sResp.json();
    if (!Array.isArray(songs) || songs.length === 0) return null;

    for (const song of songs) {
      const sid = song.id;
      if (!sid) continue;
      const pUrl = `${apiBaseUrl}?types=url&source=netease&id=${sid}&br=320`;
      const pResp = await fetch(pUrl, { headers: { "User-Agent": "Meting/1.5.0" } });
      if (!pResp.ok) continue;
      const pData: any = await pResp.json();
      const realUrl = pData?.url;
      if (realUrl && (await checkAudioUrlValid(realUrl))) {
        return { url: realUrl, br: 320 };
      }
    }
  } catch (err) {
    console.warn("[Playable Netease Track Fallback] Error:", err);
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

  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");

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

  // 1. 如果请求类型为音频 url 且为酷我源，直接调用酷我官方抗反爬直链接口
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

  // 1.2 如果请求类型为歌词 lyric，优先通过多源直连引擎解析（完美规避第三方网关不支持 tencent/kuwo 报 400）
  if (types === "lyric") {
    try {
      const lyricText = await fetchUnifiedLyric(source, id, name, artist);
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
        
        // 尝试 1: 酷我全网检索（若非版权语音）
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

        // 尝试 2: 网易云全网反查可用同名高品质音轨
        const neteaseTrack = await findPlayableNeteaseTrack(name, artist, apiBaseUrl);
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

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyUniversalTarget(target, request);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
