/**
 * Solara 洛雪自定义音乐源运行时插件沙箱 (LX Music Source Engine)
 * 兼容标准洛雪桌面端自定义脚本规范 (支持 QDY、星海、六音等脚本)
 */

import { safeGetLocalStorage, safeSetLocalStorage } from "./storage.js";

class LxMusicPluginEngine {
    constructor() {
        this.currentScriptUrl = safeGetLocalStorage("lxMusicSourceUrl") || "";
        this.isEnabled = safeGetLocalStorage("lxMusicSourceEnabled") === "true";
        this.registeredHandler = null;
        this.scriptInfo = null;
        this.status = "idle"; // idle | loading | ready | error
        this.lastError = null;
        this.listeners = new Map();
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
                // 回调风格转 Promise
                engine.httpFetch(url, options)
                    .then((res) => callback(null, res))
                    .catch((err) => callback(err, null));
            },
            utils: {
                buffer: {
                    from: (data) => new Uint8Array(typeof data === "string" ? new TextEncoder().encode(data) : data),
                    bufToString: (buf, encoding = "utf-8") => new TextDecoder(encoding).decode(buf)
                },
                crypto: {
                    md5: (str) => {
                        // 简易 MD5 实现或回退
                        return typeof window.CryptoJS !== "undefined" ? window.CryptoJS.MD5(str).toString() : "";
                    }
                }
            }
        };

        window.lx = lxHost;
        globalThis.lx = lxHost;
    }

    /**
     * 提取并解析脚本头部元信息
     */
    parseMetadata(code) {
        const head = code.slice(0, 1000);
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
     * 加载并执行远程音源脚本
     */
    async loadScript(url, forceEnable = true) {
        if (!url || typeof url !== "string") {
            this.status = "idle";
            this.registeredHandler = null;
            return false;
        }

        this.status = "loading";
        this.lastError = null;

        try {
            console.log(`[LX Sandbox] 正在下载音源脚本: ${url}`);
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`脚本下载失败: HTTP ${resp.status}`);
            }
            const code = await resp.text();
            this.scriptInfo = this.parseMetadata(code);

            // 初始化宿主环境
            this.initSandbox();

            // 执行脚本代码 (Function 作用域沙箱)
            const runner = new Function(code);
            runner();

            this.currentScriptUrl = url;
            this.isEnabled = forceEnable;
            safeSetLocalStorage("lxMusicSourceUrl", url);
            safeSetLocalStorage("lxMusicSourceEnabled", String(forceEnable));

            this.status = "ready";
            console.log(`[LX Sandbox] 音源脚本已就绪: ${this.scriptInfo.name} (${this.scriptInfo.version})`);
            return true;
        } catch (err) {
            this.status = "error";
            this.lastError = err.message;
            console.error("[LX Sandbox] 音源加载失败:", err);
            return false;
        }
    }

    /**
     * 核心调度：通过自定义音源解析歌曲直链
     * @param {Object} song 歌曲对象 { id, name, artist, source }
     * @param {String} quality 音质 '128' | '320' | 'flac'
     * @returns {Promise<string|null>} 解析成功的音频直链
     */
    async resolveAudioUrl(song, quality = "320") {
        if (!this.isEnabled || !this.registeredHandler || this.status !== "ready") {
            return null;
        }

        // 映射平台 ID 为洛雪规范
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

        // 映射音质
        const qualityMap = {
            "128": "128k",
            "192": "192k",
            "320": "320k",
            "999": "flac",
            "flac": "flac"
        };
        const lxQuality = qualityMap[quality] || "320k";

        // 构造洛雪规范的标准 songInfo
        const musicInfo = {
            id: String(song.id || song.songmid || ""),
            songmid: String(song.songmid || song.id || ""),
            name: song.name,
            singer: song.artist,
            hash: song.hash || song.id || ""
        };

        console.log(`[LX Sandbox] 正在尝试通过自定义音源 [${this.scriptInfo?.name}] 解析: ${song.name} (${lxSource} / ${lxQuality})`);

        // 设置 3.5 秒严格超时，绝不让外部音源拖慢播放体验
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("自定义音源响应超时 (3.5s)")), 3500);
        });

        try {
            const execPromise = this.registeredHandler({
                action: "musicUrl",
                source: lxSource,
                info: {
                    type: lxQuality,
                    musicInfo
                }
            });

            const resultUrl = await Promise.race([execPromise, timeoutPromise]);
            if (typeof resultUrl === "string" && resultUrl.startsWith("http")) {
                console.log(`[LX Sandbox] 自定义音源解析成功: ${resultUrl.slice(0, 60)}...`);
                return resultUrl;
            }
            return null;
        } catch (err) {
            console.warn(`[LX Sandbox] 自定义音源解析未命中或异常 (${err.message})，平滑降级至 Solara 原生直连`);
            return null;
        }
    }
}

export const lxPluginEngine = new LxMusicPluginEngine();
