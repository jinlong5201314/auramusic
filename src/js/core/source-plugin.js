/**
 * Solara 洛雪自定义音乐源运行时插件沙箱 (LX Music Source Engine)
 * 支持多音源订阅管理、自定义切换、状态漫游与标准 globalThis.lx 规范
 */

import { safeGetLocalStorage, safeSetLocalStorage, persistStorageItems } from "./storage.js";

class LxMusicPluginEngine {
    constructor() {
        this.sources = this.loadSourcesFromStorage();
        this.activeSourceId = safeGetLocalStorage("lxMusicActiveSourceId") || (this.sources[0]?.id || "");
        this.isEnabled = safeGetLocalStorage("lxMusicSourceEnabled") !== "false";
        this.registeredHandler = null;
        this.scriptInfo = null;
        this.status = "idle"; // idle | loading | ready | error
        this.lastError = null;
    }

    /**
     * 从本地持久化还原音源列表（兼容旧版本单 URL 迁移）
     */
    loadSourcesFromStorage() {
        const raw = safeGetLocalStorage("lxMusicSourcesList");
        if (raw) {
            try {
                const list = JSON.parse(raw);
                if (Array.isArray(list) && list.length > 0) {
                    return list;
                }
            } catch (e) {
                console.warn("[LX Engine] 解析音源列表失败:", e);
            }
        }

        // 兼容单源旧字段 lxMusicSourceUrl
        const oldUrl = safeGetLocalStorage("lxMusicSourceUrl");
        if (oldUrl) {
            return [{
                id: "src_" + Math.random().toString(36).substring(2, 9),
                name: "自定义音源",
                url: oldUrl,
                version: "1.0.0",
                author: "社区",
                addedAt: Date.now()
            }];
        }

        return [];
    }

    /**
     * 保存音源列表到 LocalStorage 并同步 D1
     */
    saveSourcesToStorage() {
        safeSetLocalStorage("lxMusicSourcesList", JSON.stringify(this.sources));
        safeSetLocalStorage("lxMusicActiveSourceId", this.activeSourceId);
        safeSetLocalStorage("lxMusicSourceEnabled", String(this.isEnabled));

        if (typeof persistStorageItems === "function") {
            persistStorageItems({
                lxMusicSourcesList: JSON.stringify(this.sources),
                lxMusicActiveSourceId: this.activeSourceId,
                lxMusicSourceEnabled: String(this.isEnabled)
            });
        }
    }

    /**
     * 获取当前生效的音源配置对象
     */
    getActiveSource() {
        if (!this.sources.length) return null;
        return this.sources.find(s => s.id === this.activeSourceId) || this.sources[0];
    }

    /**
     * 突破跨域限制的统一网络请求器
     * 如果直连失败或报错，自动通过 Solara 的同构代理 (/proxy?target=...) 回源
     */
    async httpFetch(url, options = {}) {
        const timeoutMs = options.timeout || 8000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const method = options.method || "GET";
        const headers = { ...(options.headers || {}) };

        // 尝试直连 (有些 API 支持 CORS 且速度最快)
        try {
            const fetchOpts = {
                method,
                headers,
                signal: controller.signal
            };
            if (options.body) {
                fetchOpts.body = typeof options.body === "object" ? JSON.stringify(options.body) : options.body;
            }
            const resp = await fetch(url, fetchOpts);
            clearTimeout(timer);

            let body = await resp.text();
            try {
                const trimmed = body.trim();
                if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                    body = JSON.parse(trimmed);
                }
            } catch {}

            return {
                statusCode: resp.status,
                headers: Object.fromEntries(resp.headers.entries()),
                body
            };
        } catch (directErr) {
            clearTimeout(timer);
            // 直连失败（如被浏览器拦截 CORS 跨域），无缝切换到 Solara 同构代理网关
            console.log(`[LX Sandbox] 直连受限 (${directErr.message})，转入 Solara 边缘网关代理: ${url}`);
            const proxyUrl = `/proxy?target=${encodeURIComponent(url)}`;
            const proxyController = new AbortController();
            const proxyTimer = setTimeout(() => proxyController.abort(), timeoutMs);

            try {
                const proxyOpts = {
                    method,
                    headers,
                    signal: proxyController.signal
                };
                if (options.body) {
                    proxyOpts.body = typeof options.body === "object" ? JSON.stringify(options.body) : options.body;
                }
                const proxyResp = await fetch(proxyUrl, proxyOpts);
                clearTimeout(proxyTimer);

                let proxyBody = await proxyResp.text();
                try {
                    const trimmed = proxyBody.trim();
                    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                        proxyBody = JSON.parse(trimmed);
                    }
                } catch {}

                return {
                    statusCode: proxyResp.status,
                    headers: Object.fromEntries(proxyResp.headers.entries()),
                    body: proxyBody
                };
            } catch (proxyErr) {
                clearTimeout(proxyTimer);
                throw new Error(`网络请求失败: ${proxyErr.message}`);
            }
        }
    }

    /**
     * 搭建标准洛雪全局宿主对象 globalThis.lx
     */
    initSandbox() {
        const engine = this;

        const lxHost = {
            EVENT_NAMES: {
                request: "request",
                inited: "inited",
                updateAlert: "updateAlert"
            },
            version: "2.8.0",
            env: "desktop",
            currentScriptInfo: {
                name: engine.scriptInfo?.name || "未知音源",
                description: engine.scriptInfo?.description || "",
                version: engine.scriptInfo?.version || "1.0.0",
                author: engine.scriptInfo?.author || "社区作者"
            },
            on: (eventName, handler) => {
                if (eventName === "request") {
                    engine.registeredHandler = handler;
                    engine.status = "ready";
                    console.log("[LX Sandbox] 音源脚本 request 监听器注册成功");
                }
            },
            send: (eventName, data) => {
                console.log(`[LX Sandbox Event] ${eventName}:`, data);
                if (eventName === "inited") {
                    engine.status = "ready";
                }
            },
            request: (url, options, callback) => {
                engine.httpFetch(url, options)
                    .then((res) => {
                        try {
                            if (typeof callback === "function") callback(null, res);
                        } catch (cbErr) {
                            console.warn("[LX Sandbox] 脚本数据回调执行异常 (已安全隔离):", cbErr.message);
                        }
                    })
                    .catch((err) => {
                        try {
                            if (typeof callback === "function") callback(err, null);
                        } catch (cbErr) {
                            console.warn("[LX Sandbox] 脚本错误回调执行异常 (已安全隔离):", cbErr.message);
                        }
                    });
            },
            utils: {
                buffer: {
                    from: (data) => new Uint8Array(typeof data === "string" ? new TextEncoder().encode(data) : data),
                    bufToString: (buf, encoding = "utf-8") => new TextDecoder(encoding).decode(buf)
                },
                crypto: {
                    md5: (str) => {
                        return typeof window.CryptoJS !== "undefined" ? window.CryptoJS.MD5(str).toString() : "";
                    }
                }
            }
        };

        window.lx = lxHost;
        globalThis.lx = lxHost;

        // 全局拦截第三方音源脚本在异步 Promise 中抛出的未捕获错误，防止控制台爆红
        if (typeof window !== "undefined" && !window.__LX_REJECTION_LISTENER_BOUND__) {
            window.__LX_REJECTION_LISTENER_BOUND__ = true;
            window.addEventListener("unhandledrejection", (event) => {
                const msg = event?.reason?.message || String(event?.reason || "");
                if (
                    msg.includes("音源已关闭") ||
                    msg.includes("脚本初始化失败") ||
                    msg.includes("lerd.dpdns.org") ||
                    msg.includes("lingchuan") ||
                    msg.includes("lxmusic") ||
                    msg.includes("sixyin") ||
                    msg.includes("reading 'trim'")
                ) {
                    console.warn("[LX Sandbox] 已安全拦截第三方音源脚本异步异常:", msg);
                    event.preventDefault();
                }
            });
        }
    }

    /**
     * 提取并解析脚本头部元信息
     */
    parseMetadata(code) {
        const head = code.slice(0, 1500);
        const nameMatch = head.match(/@name\s+([^\n\r]+)/);
        const descMatch = head.match(/@description\s+([^\n\r]+)/);
        const verMatch = head.match(/@version\s+([^\n\r]+)/);
        const authorMatch = head.match(/@author\s+([^\n\r]+)/);

        return {
            name: nameMatch ? nameMatch[1].trim() : "自定义音源",
            description: descMatch ? descMatch[1].trim() : "洛雪自定义音源脚本",
            version: verMatch ? verMatch[1].trim() : "1.0.0",
            author: authorMatch ? authorMatch[1].trim() : "第三方作者"
        };
    }

    /**
     * 激活并执行指定 ID 的音源脚本
     */
    async activateSource(sourceId) {
        const target = this.sources.find(s => s.id === sourceId);
        if (!target) {
            this.status = "idle";
            this.registeredHandler = null;
            return false;
        }

        this.activeSourceId = sourceId;
        this.status = "loading";
        this.lastError = null;

        try {
            console.log(`[LX Sandbox] 正在切换并加载音源: ${target.name} (${target.url})`);
            const resp = await fetch(target.url);
            if (!resp.ok) {
                throw new Error(`脚本下载失败: HTTP ${resp.status}`);
            }
            const code = await resp.text();
            this.scriptInfo = this.parseMetadata(code);

            // 更新已存信息以反映最新脚本属性
            target.name = this.scriptInfo.name;
            target.version = this.scriptInfo.version;
            target.author = this.scriptInfo.author;

            this.initSandbox();

            try {
                const runner = new Function(code);
                runner();
            } catch (evalErr) {
                console.warn(`[LX Sandbox] 音源脚本执行警告 (${target.name}):`, evalErr.message);
            }

            this.saveSourcesToStorage();
            this.status = "ready";
            console.log(`[LX Sandbox] 音源脚本已就绪: ${this.scriptInfo.name} (${this.scriptInfo.version})`);
            return true;
        } catch (err) {
            this.status = "error";
            this.lastError = err.message;
            console.error("[LX Sandbox] 音源激活失败:", err);
            return false;
        }
    }

    /**
     * 添加新的音源脚本并自动设为当前激活源
     */
    async addSource(url) {
        if (!url || typeof url !== "string") {
            throw new Error("请输入有效的音源脚本 URL");
        }
        url = url.trim();

        // 检查是否已存在相同 URL
        const existing = this.sources.find(s => s.url === url);
        if (existing) {
            await this.activateSource(existing.id);
            return existing;
        }

        // 预探测并下载脚本元信息
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`脚本下载失败: HTTP ${resp.status}`);
        }
        const code = await resp.text();
        const meta = this.parseMetadata(code);

        const newSource = {
            id: "src_" + Math.random().toString(36).substring(2, 9),
            name: meta.name || "自定义音源",
            url: url,
            version: meta.version || "1.0.0",
            author: meta.author || "社区作者",
            description: meta.description || "",
            addedAt: Date.now()
        };

        this.sources.push(newSource);
        this.activeSourceId = newSource.id;
        this.isEnabled = true;

        this.initSandbox();
        const runner = new Function(code);
        runner();

        this.scriptInfo = meta;
        this.status = "ready";
        this.saveSourcesToStorage();
        return newSource;
    }

    /**
     * 移除指定 ID 的音源
     */
    removeSource(sourceId) {
        const idx = this.sources.findIndex(s => s.id === sourceId);
        if (idx === -1) return;

        this.sources.splice(idx, 1);
        if (this.activeSourceId === sourceId) {
            if (this.sources.length > 0) {
                this.activateSource(this.sources[0].id);
            } else {
                this.activeSourceId = "";
                this.status = "idle";
                this.registeredHandler = null;
                this.scriptInfo = null;
            }
        }
        this.saveSourcesToStorage();
    }

    /**
     * 核心调度：通过当前激活的音源解析歌曲直链
     */
    async resolveAudioUrl(song, quality = "320") {
        if (!this.isEnabled || !this.registeredHandler || this.status !== "ready") {
            return null;
        }

        const sourceMap = {
            netease: "wy",
            wy: "wy",
            tencent: "tx",
            tx: "tx",
            kuwo: "kw",
            kw: "kw",
            kugou: "kg",
            kg: "kg",
            migu: "mg",
            mg: "mg"
        };
        const lxSource = sourceMap[song.source] || "wy";

        const qualityMap = {
            "128": "128k",
            "192": "192k",
            "320": "320k",
            "999": "flac",
            "flac": "flac"
        };
        const lxQuality = qualityMap[quality] || "320k";

        const musicInfo = {
            id: String(song.id || song.songmid || ""),
            songmid: String(song.songmid || song.id || ""),
            name: song.name,
            singer: song.artist,
            hash: song.hash || song.id || ""
        };

        // 针对酷狗源：若 hash 缺失或为纯数字 ID，秒查酷狗官方补齐 32 位 MD5 Hash
        if (lxSource === "kg" && (!musicInfo.hash || !/^[a-fA-F0-9]{32}$/.test(musicInfo.hash))) {
            try {
                const kgSearchUrl = `/proxy?target=${encodeURIComponent(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(song.name + " " + (song.artist || ""))}&page=1&pagesize=2`)}`;
                const kgResp = await fetch(kgSearchUrl, { signal: AbortSignal.timeout(1500) });
                if (kgResp.ok) {
                    const kgData = await kgResp.json();
                    const infoList = kgData?.data?.info || [];
                    if (infoList.length > 0) {
                        const targetHash = infoList[0].sqhash || infoList[0]["320hash"] || infoList[0].hash;
                        if (targetHash) {
                            musicInfo.hash = targetHash;
                            musicInfo.songmid = targetHash;
                        }
                    }
                }
            } catch (kgErr) {
                console.warn("[LX Sandbox] 补齐酷狗 Hash 失败:", kgErr);
            }
        }

        // 验证 URL 是否返回有效音频（过滤返回报错 JSON 如 201 error 或非音频网页）
        const isAudioUrlValid = async (url) => {
            if (!url || typeof url !== "string" || !url.startsWith("http")) return false;
            // 若为海棠网等已知失效的 JSON 报错接口，直接识别为无效
            if (url.includes(".php?") && (url.includes("haitangw") || url.includes("nxinxz") || url.includes("175.27.166.236"))) {
                try {
                    const checkResp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
                    const ct = (checkResp.headers.get("content-type") || "").toLowerCase();
                    if (ct.includes("json") || ct.includes("html") || ct.includes("text")) return false;
                } catch {
                    return false;
                }
            }
            return true;
        };

        // 构造候选音源列表：当前激活源优先，其余已添加源作为自动容灾备用源
        const candidateSources = [];
        const activeSrc = this.getActiveSource();
        if (activeSrc) candidateSources.push(activeSrc);
        for (const s of this.sources) {
            if (activeSrc && s.id === activeSrc.id) continue;
            candidateSources.push(s);
        }

        const originalActiveId = this.activeSourceId;
        this.lastResolvedSourceName = null;

        for (let i = 0; i < candidateSources.length; i++) {
            const currentSrc = candidateSources[i];
            // 若音源最近连续报错触发熔断冷却，跳过避免重复报错
            if (currentSrc._failCooldown && Date.now() < currentSrc._failCooldown) {
                continue;
            }

            const isFallbackSrc = i > 0;
            const srcDisplayName = isFallbackSrc ? `${currentSrc.name || "备用源"}(自动容灾)` : (currentSrc.name || "自定义音源");

            try {
                if (isFallbackSrc) {
                    console.log(`[LX Failover] 主源未命中，自动切换备用音源【${currentSrc.name}】进行容灾解析...`);
                    const switched = await this.activateSource(currentSrc.id);
                    if (!switched) {
                        currentSrc._failCooldown = Date.now() + 120000;
                        continue;
                    }
                }

                if (typeof this.registeredHandler !== "function") {
                    currentSrc._failCooldown = Date.now() + 120000;
                    continue;
                }

                console.log(`[LX Sandbox] 正在尝试通过音源【${currentSrc.name}】解析: ${song.name} (${lxSource} / ${lxQuality})`);

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error("音源响应超时 (2.8s)")), 2800);
                });

                const execPromise = Promise.resolve().then(() => this.registeredHandler({
                    action: "musicUrl",
                    source: lxSource,
                    info: {
                        type: lxQuality,
                        musicInfo
                    }
                }));

                const resultUrl = await Promise.race([execPromise, timeoutPromise]);
                if (await isAudioUrlValid(resultUrl)) {
                    console.log(`[LX Sandbox] 音源【${currentSrc.name}】解析成功: ${resultUrl.slice(0, 60)}...`);
                    this.lastResolvedSourceName = srcDisplayName;
                    delete currentSrc._failCooldown;
                    // 恢复原本选中的默认源状态标识
                    if (isFallbackSrc && originalActiveId) this.activeSourceId = originalActiveId;
                    return resultUrl;
                }

                // 若当前来源解析未出有效音频流，尝试在网易云平台跨源解析（通常有完整高品质音轨）
                if (lxSource !== "wy" && song.name) {
                    console.log(`[LX Sandbox] 音源【${currentSrc.name}】在【${lxSource}】未出链，尝试同名跨源至【wy】...`);
                    try {
                        const crossPromise = Promise.resolve().then(() => this.registeredHandler({
                            action: "musicUrl",
                            source: "wy",
                            info: {
                                type: lxQuality,
                                musicInfo: {
                                    ...musicInfo,
                                    id: String(song.lyric_id || song.id || ""),
                                }
                            }
                        }));
                        const crossUrl = await Promise.race([crossPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("跨源超时")), 2500))]);
                        if (await isAudioUrlValid(crossUrl)) {
                            console.log(`[LX Sandbox] 音源【${currentSrc.name}】跨源至【wy】解析成功: ${crossUrl.slice(0, 60)}...`);
                            this.lastResolvedSourceName = srcDisplayName;
                            if (isFallbackSrc && originalActiveId) this.activeSourceId = originalActiveId;
                            return crossUrl;
                        }
                    } catch {}
                }
            } catch (err) {
                console.warn(`[LX Sandbox] 音源【${currentSrc.name}】调度异常:`, err.message);
            }
        }

        // 所有订阅源均未命中，重置回初始激活源
        if (originalActiveId) this.activateSource(originalActiveId).catch(() => {});
        return null;
    }
}

export const lxPluginEngine = new LxMusicPluginEngine();
