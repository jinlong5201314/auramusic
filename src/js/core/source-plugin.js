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
        this.scriptCache = new Map();
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
     * 获取当前生效的音源配置对象（跳过已禁用的音源）
     */
    getActiveSource() {
        if (!this.sources.length) return null;
        const currentActiveId = this.activeSourceId || safeGetLocalStorage("lxMusicActiveSourceId");
        const found = this.sources.find(s => s.id === currentActiveId);
        if (found && !found.disabled) return found;
        return this.sources.find(s => !s.disabled) || null;
    }

    /**
     * 辅助清洗与转译请求头，防止非法非 ASCII 字符导致浏览器原生 fetch() 抛出 ByteString 致命异常
     */
    sanitizeHeaders(rawHeaders = {}) {
        const clean = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
            if (v === undefined || v === null) continue;
            const strVal = String(v);
            // 包含非 Latin-1 (码值 > 255) 字符时，使用 encodeURI 转译为合法 ByteString 序列
            if (/[\u0080-\uFFFF]/.test(strVal)) {
                clean[k] = encodeURI(strVal);
            } else {
                clean[k] = strVal;
            }
        }
        return clean;
    }

    /**
     * 突破跨域限制的统一网络请求器
     * 如果直连失败或报错，自动通过 Solara 的同构代理 (/proxy?target=...) 回源
     */
    async httpFetch(url, options = {}) {
        const timeoutMs = options.timeout || 12000;
        const proxyTimeoutMs = Math.max(timeoutMs, 15000);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const method = (options.method || "GET").toUpperCase();
        const headers = this.sanitizeHeaders(options.headers || {});

        // 兼容 options.form 表单提交
        let bodyData = options.body;
        if (!bodyData && options.form && typeof options.form === "object") {
            bodyData = new URLSearchParams(options.form).toString();
            if (!headers["Content-Type"] && !headers["content-type"]) {
                headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
            }
        } else if (!bodyData && options.formData) {
            bodyData = options.formData;
        }

        let bodyPayload = undefined;
        if (method !== "GET" && method !== "HEAD" && bodyData !== undefined) {
            bodyPayload = typeof bodyData === "object" ? JSON.stringify(bodyData) : String(bodyData);
            if (!headers["Content-Type"] && !headers["content-type"] && typeof bodyData === "object") {
                headers["Content-Type"] = "application/json";
            }
        }

        // 尝试直连 (有些 API 支持 CORS 且速度最快)
        try {
            const fetchOpts = {
                method,
                headers,
                signal: controller.signal
            };
            if (bodyPayload !== undefined) {
                fetchOpts.body = bodyPayload;
            }
            const resp = await fetch(url, fetchOpts);
            clearTimeout(timer);

            // 若直连遇到特定跨域/网关阻断状态码 (401/403/405/502/503)，自动触发 fallback 代理兜底
            if (!resp.ok && [401, 403, 405, 502, 503].includes(resp.status)) {
                throw new Error(`直连受阻 HTTP ${resp.status}`);
            }

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
            // 直连失败（如被浏览器拦截 CORS 跨域），无缝切换到 Solara 边缘网关代理
            console.log(`[LX Sandbox] 直连受限 (${directErr.message})，转入 Solara 边缘网关代理: ${url}`);
            const proxyUrl = `/proxy?target=${encodeURIComponent(url)}`;
            const proxyController = new AbortController();
            let proxyTimer = null;
            if (proxyTimeoutMs > 0) {
                proxyTimer = setTimeout(() => proxyController.abort(), proxyTimeoutMs);
            }

            try {
                const proxyOpts = {
                    method,
                    headers,
                    signal: proxyController.signal
                };
                if (bodyPayload !== undefined) {
                    proxyOpts.body = bodyPayload;
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
            env: Object.assign(new String("desktop"), {
                platform: "desktop",
                version: "2.8.0",
                appVersion: "2.8.0"
            }),
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
                if (typeof options === "function") {
                    callback = options;
                    options = {};
                }
                engine.httpFetch(url, options)
                    .then((res) => {
                        try {
                            if (typeof callback === "function") {
                                // 规范传参：第 1 参 err，第 2 参 resp，第 3 参 resp.body
                                callback(null, res, res?.body);
                            }
                        } catch (cbErr) {
                            console.warn("[LX Sandbox] 脚本数据回调执行异常 (已安全隔离):", cbErr.message);
                        }
                    })
                    .catch((err) => {
                        try {
                            if (typeof callback === "function") {
                                callback(err, null, null);
                            }
                        } catch (cbErr) {
                            console.warn("[LX Sandbox] 脚本错误回调执行异常 (已安全隔离):", cbErr.message);
                        }
                    });
            },
            utils: {
                buffer: {
                    from: (data, encoding = "utf-8") => {
                        if (typeof data === "string") {
                            const enc = String(encoding).toLowerCase();
                            if (enc === "base64") {
                                try {
                                    const bin = atob(data.trim());
                                    const bytes = new Uint8Array(bin.length);
                                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                                    return bytes;
                                } catch {
                                    return new Uint8Array();
                                }
                            }
                            if (enc === "hex") {
                                const cleanHex = data.replace(/[^0-9a-fA-F]/g, "");
                                const bytes = new Uint8Array(cleanHex.length / 2);
                                for (let i = 0; i < cleanHex.length; i += 2) {
                                    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
                                }
                                return bytes;
                            }
                            return new TextEncoder().encode(data);
                        }
                        if (data instanceof Uint8Array) return data;
                        if (data instanceof ArrayBuffer) return new Uint8Array(data);
                        if (Array.isArray(data)) return new Uint8Array(data);
                        return new Uint8Array();
                    },
                    bufToString: (buf, encoding = "utf-8") => {
                        if (!buf) return "";
                        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
                        const enc = String(encoding).toLowerCase();
                        if (enc === "base64") {
                            let binary = "";
                            const len = u8.byteLength;
                            const chunkSize = 8192;
                            for (let i = 0; i < len; i += chunkSize) {
                                const sub = u8.subarray(i, Math.min(i + chunkSize, len));
                                binary += String.fromCharCode.apply(null, sub);
                            }
                            return btoa(binary);
                        }
                        if (enc === "hex") {
                            return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("");
                        }
                        try {
                            return new TextDecoder(encoding || "utf-8").decode(u8);
                        } catch {
                            return new TextDecoder("utf-8").decode(u8);
                        }
                    }
                },
                crypto: {
                    md5: (str) => {
                        return typeof window.CryptoJS !== "undefined" ? window.CryptoJS.MD5(str).toString() : "";
                    },
                    aesEncrypt: (data, mode, key, iv) => {
                        if (typeof window.CryptoJS !== "undefined") {
                            try {
                                const k = window.CryptoJS.enc.Utf8.parse(key);
                                const i = iv ? window.CryptoJS.enc.Utf8.parse(iv) : undefined;
                                const m = String(mode).toUpperCase() === "ECB" ? window.CryptoJS.mode.ECB : window.CryptoJS.mode.CBC;
                                const enc = window.CryptoJS.AES.encrypt(data, k, { iv: i, mode: m });
                                return enc.toString();
                            } catch {}
                        }
                        return "";
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
     * 辅助下载脚本源码：内存缓存优先，直连遇 CORS 阻断时自动降级走同构代理
     */
    async fetchScriptSource(url) {
        if (this.scriptCache && this.scriptCache.has(url)) {
            return this.scriptCache.get(url);
        }
        let text = "";
        try {
            const resp = await fetch(url);
            if (resp.ok) {
                text = await resp.text();
            }
        } catch (e) {
            console.warn(`[LX Sandbox] 脚本直连下载失败 (${e.message})，转入同构网关代理下载: ${url}`);
        }

        if (!text) {
            // 降级走代理接口
            const proxyUrl = `/proxy?target=${encodeURIComponent(url)}`;
            const proxyResp = await fetch(proxyUrl);
            if (!proxyResp.ok) {
                throw new Error(`脚本下载失败: HTTP ${proxyResp.status}`);
            }
            text = await proxyResp.text();
        }

        if (text && this.scriptCache) {
            this.scriptCache.set(url, text);
        }
        return text;
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
            const code = await this.fetchScriptSource(target.url);
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
            if (this.scriptCache) this.scriptCache.delete(url);
            await this.activateSource(existing.id);
            return existing;
        }

        // 预探测并下载脚本源码
        const code = await this.fetchScriptSource(url);
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
        try {
            const runner = new Function(code);
            runner();
        } catch (evalErr) {
            console.warn(`[LX Sandbox] 音源脚本初始化警告 (${newSource.name}):`, evalErr.message);
        }

        this.scriptInfo = meta;
        this.status = "ready";
        this.saveSourcesToStorage();
        // 自动触发一次后台健康度探测
        this.probeSource(newSource.id).catch(e => console.warn("[LX Sandbox] 自动探测异常:", e));
        return newSource;
    }

    /**
     * 移除指定 ID 的音源
     */
    removeSource(sourceId) {
        const idx = this.sources.findIndex(s => s.id === sourceId);
        if (idx === -1) return;

        const target = this.sources[idx];
        if (target && target.url && this.scriptCache) {
            this.scriptCache.delete(target.url);
        }
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
     * 切换音源的启用/禁用状态
     */
    async toggleSourceDisabled(sourceId, disabled) {
        const target = this.sources.find(s => s.id === sourceId);
        if (!target) return false;

        target.disabled = typeof disabled === "boolean" ? disabled : !target.disabled;

        // 若禁用了当前生效的音源，自动切换到下一个可用源
        if (target.disabled && this.activeSourceId === sourceId) {
            const nextActive = this.sources.find(s => !s.disabled);
            if (nextActive) {
                this.activeSourceId = nextActive.id;
                safeSetLocalStorage("lxMusicActiveSourceId", nextActive.id);
                await this.activateSource(nextActive.id);
            } else {
                this.activeSourceId = "";
                safeSetLocalStorage("lxMusicActiveSourceId", "");
                this.status = "idle";
                this.registeredHandler = null;
                this.scriptInfo = null;
            }
        } else if (!target.disabled && (!this.activeSourceId || this.sources.find(s => s.id === this.activeSourceId)?.disabled)) {
            // 若之前无激活源或激活源已禁用，启用后自动激活此源
            this.activeSourceId = target.id;
            safeSetLocalStorage("lxMusicActiveSourceId", target.id);
            await this.activateSource(target.id);
        }

        this.saveSourcesToStorage();
        return target.disabled;
    }

    /**
     * 重新拉取脚本源码更新指定音源
     */
    async updateSource(sourceId) {
        const target = this.sources.find(s => s.id === sourceId);
        if (!target) return { ok: false, message: "音源未找到" };

        const oldVer = target.version || "1.0.0";
        const oldName = target.name || "自定义音源";

        try {
            // 1. 强制清理内存缓存
            if (this.scriptCache) {
                this.scriptCache.delete(target.url);
            }

            // 2. 重新下载最新脚本
            const code = await this.fetchScriptSource(target.url);
            const newMeta = this.parseMetadata(code);

            // 3. 更新元数据
            target.name = newMeta.name || target.name;
            target.version = newMeta.version || target.version;
            target.author = newMeta.author || target.author;
            target.description = newMeta.description || target.description;
            target.updatedAt = Date.now();

            // 4. 若为当前生效且未禁用的源，重新加载沙箱
            if (this.activeSourceId === sourceId && !target.disabled) {
                this.initSandbox();
                try {
                    const runner = new Function(code);
                    runner();
                    this.status = "ready";
                    this.scriptInfo = newMeta;
                } catch (evalErr) {
                    console.warn(`[LX Sandbox] 更新脚本执行警告 (${target.name}):`, evalErr.message);
                }
            }

            this.saveSourcesToStorage();
            const isUpdated = oldVer !== target.version || oldName !== target.name;
            return {
                ok: true,
                isUpdated,
                oldVer,
                newVer: target.version,
                name: target.name,
                message: isUpdated
                    ? `已更新：v${oldVer} → v${target.version}`
                    : `已拉取最新，当前为 v${target.version}`
            };
        } catch (err) {
            console.error("[LX Engine] 音源更新失败:", err);
            return {
                ok: false,
                message: err.message || "更新失败"
            };
        }
    }

    /**
     * 批量更新所有已添加的音源
     */
    async updateAllSources(onProgress) {
        const results = [];
        for (const src of this.sources) {
            if (typeof onProgress === "function") {
                onProgress(src, { status: "updating" });
            }
            const res = await this.updateSource(src.id);
            results.push({ src, ...res });
            if (typeof onProgress === "function") {
                onProgress(src, { status: "done", result: res });
            }
        }
        return results;
    }

    /**
     * 对指定音源进行连通度与出链深度探测
     */
    async probeSource(sourceId) {
        const target = this.sources.find(s => s.id === sourceId);
        if (!target) return { ok: false, message: "音源未找到" };

        const startTime = performance.now();
        target.probeStatus = "probing";

        try {
            // 1. 测试脚本拉取 (带超时控制)
            let code = "";
            try {
                code = await this.fetchScriptSource(target.url);
            } catch (fetchErr) {
                const latencyMs = Math.round(performance.now() - startTime);
                target.probeResult = { ok: false, latencyMs, message: `拉取失败: ${fetchErr.message || "无法连接"}`, time: Date.now() };
                target.probeStatus = "done";
                this.saveSourcesToStorage();
                return target.probeResult;
            }

            if (!code || code.trim().length < 50) {
                const latencyMs = Math.round(performance.now() - startTime);
                target.probeResult = { ok: false, latencyMs, message: "脚本内容为空", time: Date.now() };
                target.probeStatus = "done";
                this.saveSourcesToStorage();
                return target.probeResult;
            }

            // 更新元信息
            const meta = this.parseMetadata(code);
            target.name = meta.name || target.name;
            target.version = meta.version || target.version;

            // 2. 独立沙箱隔离执行，捕获其 request 回调
            let probeHandler = null;
            let scriptInitError = null;

            const probeHost = {
                EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
                version: "2.8.0",
                env: Object.assign(new String("desktop"), {
                    platform: "desktop",
                    version: "2.8.0",
                    appVersion: "2.8.0"
                }),
                currentScriptInfo: meta,
                on: (eventName, handler) => {
                    if (eventName === "request") probeHandler = handler;
                },
                send: () => {},
                request: (url, options, callback) => {
                    if (typeof options === "function") {
                        callback = options;
                        options = {};
                    }
                    this.httpFetch(url, { ...(options || {}), timeout: 5000 })
                        .then(res => {
                            if (typeof callback === "function") callback(null, res, res?.body);
                        })
                        .catch(err => {
                            if (typeof callback === "function") callback(err, null, null);
                        });
                },
                utils: {
                    buffer: {
                        from: (data, encoding = "utf-8") => {
                            if (typeof data === "string") {
                                const enc = String(encoding).toLowerCase();
                                if (enc === "base64") {
                                    try {
                                        const bin = atob(data.trim());
                                        const bytes = new Uint8Array(bin.length);
                                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                                        return bytes;
                                    } catch {
                                        return new Uint8Array();
                                    }
                                }
                                if (enc === "hex") {
                                    const cleanHex = data.replace(/[^0-9a-fA-F]/g, "");
                                    const bytes = new Uint8Array(cleanHex.length / 2);
                                    for (let i = 0; i < cleanHex.length; i += 2) {
                                        bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
                                    }
                                    return bytes;
                                }
                                return new TextEncoder().encode(data);
                            }
                            if (data instanceof Uint8Array) return data;
                            if (data instanceof ArrayBuffer) return new Uint8Array(data);
                            if (Array.isArray(data)) return new Uint8Array(data);
                            return new Uint8Array();
                        },
                        bufToString: (buf, encoding = "utf-8") => {
                            if (!buf) return "";
                            const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
                            const enc = String(encoding).toLowerCase();
                            if (enc === "base64") {
                                let binary = "";
                                const len = u8.byteLength;
                                const chunkSize = 8192;
                                for (let i = 0; i < len; i += chunkSize) {
                                    const sub = u8.subarray(i, Math.min(i + chunkSize, len));
                                    binary += String.fromCharCode.apply(null, sub);
                                }
                                return btoa(binary);
                            }
                            if (enc === "hex") {
                                return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("");
                            }
                            try {
                                return new TextDecoder(encoding || "utf-8").decode(u8);
                            } catch {
                                return new TextDecoder("utf-8").decode(u8);
                            }
                        }
                    },
                    crypto: {
                        md5: (str) => typeof window.CryptoJS !== "undefined" ? window.CryptoJS.MD5(str).toString() : "",
                        aesEncrypt: (data, mode, key, iv) => {
                            if (typeof window.CryptoJS !== "undefined") {
                                try {
                                    const k = window.CryptoJS.enc.Utf8.parse(key);
                                    const i = iv ? window.CryptoJS.enc.Utf8.parse(iv) : undefined;
                                    const m = String(mode).toUpperCase() === "ECB" ? window.CryptoJS.mode.ECB : window.CryptoJS.mode.CBC;
                                    const enc = window.CryptoJS.AES.encrypt(data, k, { iv: i, mode: m });
                                    return enc.toString();
                                } catch {}
                            }
                            return "";
                        }
                    }
                }
            };

            const prevWindowLx = window.lx;
            const prevGlobalLx = globalThis.lx;
            window.lx = probeHost;
            globalThis.lx = probeHost;
            try {
                const runner = new Function(code);
                runner();
            } catch (runErr) {
                scriptInitError = runErr.message;
            } finally {
                window.lx = prevWindowLx;
                globalThis.lx = prevGlobalLx;
            }

            if (typeof probeHandler !== "function") {
                const latencyMs = Math.round(performance.now() - startTime);
                const errMsg = scriptInitError ? `脚本报错: ${scriptInitError}` : "未注册解析器";
                target.probeResult = { ok: false, latencyMs, message: errMsg, time: Date.now() };
                target.probeStatus = "done";
                this.saveSourcesToStorage();
                return target.probeResult;
            }

            // 3. 模拟请求真实测试曲目 (优先测试网易云，若未出链则测试QQ音乐)
            const testCandidates = [
                { source: "wy", info: { type: "128k", musicInfo: { id: "347230", songmid: "347230", name: "海阔天空", singer: "Beyond", hash: "e4fa35c89f0eb8900893611ca8c4af79" } } },
                { source: "tx", info: { type: "128k", musicInfo: { id: "0039MnYb0qxYAc", songmid: "0039MnYb0qxYAc", name: "晴天", singer: "周杰伦" } } }
            ];

            let resolvedUrl = null;
            let lastErr = null;

            for (const cand of testCandidates) {
                try {
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("接口响应超时 (5.5s)")), 5500)
                    );
                    const callPromise = Promise.resolve().then(() => probeHandler({
                        action: "musicUrl",
                        source: cand.source,
                        info: cand.info
                    }));

                    const res = await Promise.race([callPromise, timeoutPromise]);
                    const deadPatterns = [
                        "error", "502", "503", "523", "524",
                        "nxinxz", "175.27.166.236", "haitangw.cc",
                        "music-dl.sayqz.com", "88.lxmusic.xn--fiqs8s"
                    ];
                    if (res && typeof res === "string" && res.startsWith("http")) {
                        if (!deadPatterns.some(p => res.includes(p))) {
                            resolvedUrl = res;
                            break;
                        } else {
                            lastErr = "返回失效死节点或报错流";
                        }
                    } else if (res && typeof res === "object" && res.url && typeof res.url === "string" && res.url.startsWith("http")) {
                        if (!deadPatterns.some(p => res.url.includes(p))) {
                            resolvedUrl = res.url;
                            break;
                        } else {
                            lastErr = "返回失效死节点或报错流";
                        }
                    }
                } catch (cErr) {
                    lastErr = cErr.message;
                }
            }

            const latencyMs = Math.round(performance.now() - startTime);

            if (resolvedUrl) {
                target.probeResult = {
                    ok: true,
                    latencyMs,
                    message: `${latencyMs}ms 正常`,
                    audioUrl: resolvedUrl,
                    time: Date.now()
                };
            } else {
                target.probeResult = {
                    ok: false,
                    latencyMs,
                    message: lastErr || "未出链",
                    time: Date.now()
                };
            }

            target.probeStatus = "done";
            this.saveSourcesToStorage();
            return target.probeResult;
        } catch (globalErr) {
            const latencyMs = Math.round(performance.now() - startTime);
            target.probeResult = {
                ok: false,
                latencyMs,
                message: globalErr.message || "探测异常",
                time: Date.now()
            };
            target.probeStatus = "done";
            this.saveSourcesToStorage();
            return target.probeResult;
        }
    }

    /**
     * 批量并发/串行体检全部音源
     */
    async probeAllSources(onProgress) {
        const results = [];
        for (const src of this.sources) {
            if (typeof onProgress === "function") {
                onProgress(src, { status: "probing" });
            }
            const res = await this.probeSource(src.id);
            if (typeof onProgress === "function") {
                onProgress(src, { status: "done", result: res });
            }
            results.push({ id: src.id, result: res });
        }
        return results;
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

        const rawMeta = song.meta || {};
        const musicInfo = {
            id: String(song.id || song.songmid || rawMeta.songId || ""),
            songmid: String(song.songmid || song.id || rawMeta.songId || ""),
            name: song.name,
            singer: song.artist || rawMeta.singer || "",
            albumName: song.album || rawMeta.albumName || "",
            albumId: song.albumId || rawMeta.albumId || "",
            interval: song.interval || rawMeta.interval || "",
            hash: song.hash || rawMeta.hash || song.id || "",
            types: song.types || rawMeta.types || rawMeta.qualitys || {},
            _types: song._types || rawMeta._types || rawMeta._qualitys || {},
            picUrl: song.pic || rawMeta.picUrl || "",
            img: song.pic || rawMeta.picUrl || "",
            meta: { ...rawMeta, ...(song.hash ? { hash: song.hash } : {}) }
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

        // 验证与预处理 URL（自动升级安全协议，过滤失效报错接口）
        const isAudioUrlValid = async (url) => {
            if (!url || typeof url !== "string" || !url.startsWith("http")) return false;
            let targetUrl = url.trim();
            // 若为纯 http 且页面在 https 环境下，优先尝试升级到主流支持 HTTPS 的媒体 CDN，否则通过安全代理网关包装
            if (typeof window !== "undefined" && window.location.protocol === "https:" && targetUrl.startsWith("http://")) {
                if (
                    targetUrl.includes("haitangw.net") ||
                    targetUrl.includes("kuwo.cn") ||
                    targetUrl.includes("kugou.com") ||
                    targetUrl.includes("126.net") ||
                    targetUrl.includes("qq.com") ||
                    targetUrl.includes("tx.kugou.com") ||
                    targetUrl.includes("migu.cn")
                ) {
                    targetUrl = targetUrl.replace(/^http:\/\//i, "https://");
                } else {
                    targetUrl = `/proxy?target=${encodeURIComponent(targetUrl)}`;
                }
            }
            // 过滤已知死节点与返回纯报错 JSON 的失效接口（如 TLS 中断的 sayqz、443 阻断的 88.lxmusic、下线的 nxinxz 等）
            const deadPatterns = [
                "music-dl.sayqz.com",
                "88.lxmusic.xn--fiqs8s",
                "nxinxz",
                "175.27.166.236",
                "haitangw.cc"
            ];
            if (deadPatterns.some(pattern => targetUrl.includes(pattern))) {
                console.warn(`[LX Sandbox] 拦截命中已知死节点/失效接口: ${targetUrl.slice(0, 60)}`);
                return false;
            }
            return targetUrl;
        };

        // 构造候选音源列表：当前激活源优先，其余已添加且未禁用的源作为自动容灾备用源
        const candidateSources = [];
        const activeSrc = this.getActiveSource();
        if (activeSrc && !activeSrc.disabled) candidateSources.push(activeSrc);
        for (const s of this.sources) {
            if (s.disabled) continue; // 禁用源绝不参与播放与容灾
            if (activeSrc && s.id === activeSrc.id) continue;
            candidateSources.push(s);
        }

        const originalActiveId = this.activeSourceId;
        this.lastResolvedSourceName = null;

        for (let i = 0; i < candidateSources.length; i++) {
            const currentSrc = candidateSources[i];
            // 若音源最近连续报错触发熔断冷却，跳过避免重复报错
            if (currentSrc._failCooldown && Date.now() < currentSrc._failCooldown) {
                console.log(`[LX Failover] 音源【${currentSrc.name}】处于熔断冷却中 (${Math.ceil((currentSrc._failCooldown - Date.now()) / 1000)}s)，自动跳过...`);
                continue;
            }

            const isFallbackSrc = i > 0;
            const srcDisplayName = isFallbackSrc ? `${currentSrc.name || "备用源"}(自动容灾)` : (currentSrc.name || "自定义音源");

            let sourceSuccess = false;
            try {
                if (isFallbackSrc) {
                    console.log(`[LX Failover] 主源未命中，自动切换备用音源【${currentSrc.name}】进行容灾解析...`);
                    const switched = await this.activateSource(currentSrc.id);
                    if (!switched) {
                        currentSrc._failCooldown = Date.now() + 180000;
                        continue;
                    }
                }

                if (typeof this.registeredHandler !== "function") {
                    currentSrc._failCooldown = Date.now() + 180000;
                    continue;
                }

                console.log(`[LX Sandbox] 正在尝试通过音源【${currentSrc.name}】解析: ${song.name} (${lxSource} / ${lxQuality})`);

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error("音源响应超时 (6.5s)")), 6500);
                });

                const execPromise = Promise.resolve().then(() => this.registeredHandler({
                    action: "musicUrl",
                    source: lxSource,
                    info: {
                        type: lxQuality,
                        musicInfo
                    }
                }));

                const resolveStart = performance.now();
                const rawResult = await Promise.race([execPromise, timeoutPromise]);
                const resultUrl = (typeof rawResult === "object" && rawResult !== null) ? (rawResult.url || "") : (typeof rawResult === "string" ? rawResult : "");
                const validUrl = await isAudioUrlValid(resultUrl);
                if (validUrl) {
                    const latencyMs = Math.round(performance.now() - resolveStart);
                    console.log(`[LX Sandbox] 音源【${currentSrc.name}】解析成功 (${latencyMs}ms): ${validUrl.slice(0, 60)}...`);
                    this.lastResolvedSourceName = srcDisplayName;
                    delete currentSrc._failCooldown;
                    currentSrc._failCount = 0;
                    currentSrc.probeResult = {
                        ok: true,
                        latencyMs,
                        message: `${latencyMs}ms 正常`,
                        time: Date.now()
                    };
                    this.saveSourcesToStorage();
                    // 恢复原本选中的默认源状态标识
                    if (isFallbackSrc && originalActiveId) this.activeSourceId = originalActiveId;
                    return validUrl;
                }

                // 1. 若当前来源解析未出有效音频流，首先尝试在 QQ 音乐 (tx) 平台进行同名高品质跨源解析（覆盖企鹅独家热门版权）
                if (lxSource !== "tx" && song.name) {
                    console.log(`[LX Sandbox] 音源【${currentSrc.name}】在【${lxSource}】未出有效音频，尝试同名智能跨源至【tx】...`);
                    try {
                        let txSongMid = "";
                        // 秒查 QQ 音乐接口获取对应 songmid
                        try {
                            const txSearchUrl = `/api/search?keyword=${encodeURIComponent(song.name + " " + (song.artist || ""))}&page=1&limit=3`;
                            const txResp = await fetch(txSearchUrl, { signal: AbortSignal.timeout(1800) });
                            if (txResp.ok) {
                                const txList = await txResp.json();
                                const exactMatch = txList.find(it => it.source === "tx" && it.id?.startsWith("00")) || txList[0];
                                if (exactMatch && exactMatch.id?.startsWith("00")) {
                                    txSongMid = exactMatch.id;
                                }
                            }
                        } catch {}

                        if (txSongMid) {
                            const txPromise = Promise.resolve().then(() => this.registeredHandler({
                                action: "musicUrl",
                                source: "tx",
                                info: {
                                    type: lxQuality,
                                    musicInfo: {
                                        id: txSongMid,
                                        songmid: txSongMid,
                                        name: song.name,
                                        singer: song.artist
                                    }
                                }
                            }));
                            const rawCrossTx = await Promise.race([txPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("tx跨源超时")), 2500))]);
                            const crossTxUrl = (typeof rawCrossTx === "object" && rawCrossTx !== null) ? (rawCrossTx.url || "") : (typeof rawCrossTx === "string" ? rawCrossTx : "");
                            const validCrossTx = await isAudioUrlValid(crossTxUrl);
                            if (validCrossTx) {
                                console.log(`[LX Sandbox] 音源【${currentSrc.name}】跨源至【tx】解析成功: ${validCrossTx.slice(0, 60)}...`);
                                this.lastResolvedSourceName = `${srcDisplayName} (QQ跨源)`;
                                delete currentSrc._failCooldown;
                                currentSrc._failCount = 0;
                                if (isFallbackSrc && originalActiveId) this.activeSourceId = originalActiveId;
                                return validCrossTx;
                            }
                        }
                    } catch (txErr) {
                        console.warn("[LX Sandbox] 跨源 tx 尝试未命中:", txErr.message);
                    }
                }

                // 2. 尝试在网易云平台跨源解析（通常有完整高品质音轨）
                if (lxSource !== "wy" && song.name) {
                    console.log(`[LX Sandbox] 音源【${currentSrc.name}】尝试同名跨源至【wy】...`);
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
                        const rawCross = await Promise.race([crossPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("跨源超时")), 2500))]);
                        const crossUrl = (typeof rawCross === "object" && rawCross !== null) ? (rawCross.url || "") : (typeof rawCross === "string" ? rawCross : "");
                        const validCrossUrl = await isAudioUrlValid(crossUrl);
                        if (validCrossUrl) {
                            console.log(`[LX Sandbox] 音源【${currentSrc.name}】跨源至【wy】解析成功: ${validCrossUrl.slice(0, 60)}...`);
                            this.lastResolvedSourceName = `${srcDisplayName} (网易跨源)`;
                            delete currentSrc._failCooldown;
                            currentSrc._failCount = 0;
                            if (isFallbackSrc && originalActiveId) this.activeSourceId = originalActiveId;
                            return validCrossUrl;
                        }
                    } catch {}
                }
            } catch (err) {
                console.warn(`[LX Sandbox] 音源【${currentSrc.name}】调度异常:`, err.message);
            }

            // 若本轮调度未成功出链，累计失败计数；若连续失败达 2 次进入 3 分钟熔断冷却
            currentSrc._failCount = (currentSrc._failCount || 0) + 1;
            if (currentSrc._failCount >= 2) {
                currentSrc._failCooldown = Date.now() + 180000;
                console.warn(`[LX Failover] 音源【${currentSrc.name}】连续失败 ${currentSrc._failCount} 次，触发 3 分钟熔断冷却`);
            }
        }

        // 所有订阅源均未命中，重置回初始激活源
        if (originalActiveId) this.activateSource(originalActiveId).catch(() => {});
        return null;
    }
}

export const lxPluginEngine = new LxMusicPluginEngine();
