/**
 * Solara 播放控制界面底部音频频谱律动动画引擎 (Bottom Spectrum Visualizer)
 * 完全移植自 LXMusic Web (https://github.com/XCQ0607/lxserver) 的 public/music/js/visualizer.js 与 wave.js
 * 
 * 核心特性：
 * 1. 真实 Web Audio API 驱动：基于 AnalyserNode 真实抓取音频 FFT 频域能量，100% 跟随音乐高低起伏律动；
 * 2. 忠实移植 LXMusic 经典高动态方块积木（Wave.animations.Cubes）；
 * 3. 动态高对比对应色：根据当前主题色反向旋转 160° 互补色谱，随主题变幻但绝对不与主题同色，清晰醒目；
 * 4. 音乐暂停、结束、无音乐时彻底停止清空，绝无多余杂影，0% CPU 占用。
 */

function parseColorToHsl(str) {
    str = String(str || "").trim();
    let r = 99, g = 102, b = 241;
    if (str.startsWith("#")) {
        const hex = str.slice(1);
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length >= 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        }
    } else if (str.startsWith("rgb")) {
        const m = str.match(/\(([^)]+)\)/);
        if (m) {
            const parts = m[1].split(/[,\\s/]+/).map(p => parseFloat(p.trim())).filter(n => !isNaN(n));
            if (parts.length >= 3) {
                r = parts[0]; g = parts[1]; b = parts[2];
            }
        }
    }
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
            case g: h = ((b - r) / d + 2) * 60; break;
            case b: h = ((r - g) / d + 4) * 60; break;
        }
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export class LXMusicVisualizerIntegration {
    constructor(dom, state = {}) {
        this.dom = dom;
        this.state = state;
        this.audio = dom?.audioPlayer || document.getElementById("audioPlayer");
        this.footerCanvas = dom?.controlsSpectrumCanvas || document.getElementById("controlsSpectrumCanvas");
        this.visualizerContainer = dom?.controlsSpectrum || document.getElementById("controlsSpectrum");

        this.audioContext = null;
        this.audioSource = null;
        this.audioAnalyser = null;
        this.waveFooter = null;
        this.isInitialized = false;
        this.isPlaying = false;

        this.init();
    }

    /**
     * 初始化 AudioContext 与 AnalyserNode (完全遵循 lxserver visualizer.js)
     */
    initAudioNodes() {
        if (this.isInitialized || !this.audio) return;
        const WaveConstructor = window.Wave || (typeof Wave !== "undefined" ? Wave : null);
        if (!WaveConstructor) {
            console.warn("[Visualizer] window.Wave 尚未就绪，将在稍后重试");
            return;
        }

        try {
            console.log("[Visualizer] 正在初始化 Web Audio AudioContext 与 AnalyserNode (LXMusic 架构)...");
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioCtx();

            this.audioSource = this.audioContext.createMediaElementSource(this.audio);
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioSource.connect(this.audioAnalyser);
            this.audioAnalyser.connect(this.audioContext.destination);

            this.audioAnalyser.smoothingTimeConstant = 0.8;
            this.audioAnalyser.fftSize = 512;

            this.waveFooter = new WaveConstructor(this.audioAnalyser, this.footerCanvas);
            this.isInitialized = true;
            console.log("[Visualizer] LXMusic Web 律动频谱引擎初始化成功！");

            this.syncSize();
            this.applySettings();
        } catch (e) {
            console.warn("[Visualizer] AudioContext 初始化捕获 (将在后续交互中激活):", e.message);
        }
    }

    init() {
        if (!this.footerCanvas || !this.visualizerContainer) return;

        // 绑定音频播放生命周期事件
        if (this.audio) {
            const handlePlay = () => {
                this.isPlaying = true;
                if (!this.isInitialized) {
                    this.initAudioNodes();
                }
                if (this.audioContext && this.audioContext.state === "suspended") {
                    this.audioContext.resume().catch(() => {});
                }
                if (this.isInitialized) {
                    this.applySettings();
                }
            };

            const handleStop = () => {
                this.isPlaying = false;
                this.clear();
            };

            this.audio.addEventListener("play", handlePlay);
            this.audio.addEventListener("playing", handlePlay);
            this.audio.addEventListener("pause", handleStop);
            this.audio.addEventListener("ended", handleStop);
            this.audio.addEventListener("emptied", handleStop);
            this.audio.addEventListener("error", handleStop);

            // 用户首次交互唤醒
            const userGestureHandler = () => {
                if (this.audioContext && this.audioContext.state === "suspended") {
                    this.audioContext.resume().catch(() => {});
                }
            };
            document.addEventListener("click", userGestureHandler, { passive: true });
            document.addEventListener("touchstart", userGestureHandler, { passive: true });
        }

        // 尺寸与窗口变化
        window.addEventListener("resize", () => {
            this.syncSize();
            if (this.isPlaying && this.isInitialized) {
                this.applySettings();
            }
        }, { passive: true });

        // 初始状态检测
        if (this.audio && !this.audio.paused && !this.audio.ended) {
            this.isPlaying = true;
            this.initAudioNodes();
        } else {
            this.clear();
        }
    }

    /**
     * 同步 Canvas 分辨率 (移植自 lxserver syncSize)
     */
    syncSize() {
        if (!this.footerCanvas) return;
        const rect = this.footerCanvas.getBoundingClientRect();
        if (rect.width === 0) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.footerCanvas.width = Math.floor(rect.width * dpr);
        this.footerCanvas.height = Math.floor(rect.height * dpr);
    }

    /**
     * 高反差对应色算法 (随主题变幻但绝不与主题撞色)
     */
    getContrastingColor() {
        if (typeof window === "undefined") return "#f59e0b";
        const styles = getComputedStyle(document.documentElement);
        const p = styles.getPropertyValue("--primary-color").trim() || "#6366f1";
        const isDark = document.body.classList.contains("dark-mode") || document.documentElement.classList.contains("dark-mode");
        const { h, s } = parseColorToHsl(p);

        // 互补对比色相：反向旋转 160°
        const compH = (h + 160) % 360;
        const sat = Math.max(s, 85);

        if (isDark) {
            return `hsl(${compH}, ${sat}%, 62%)`;
        } else {
            return `hsl(${compH}, ${sat}%, 40%)`;
        }
    }

    /**
     * 应用配置并构建动画 (移植自 lxserver visualizer.js applySettings)
     */
    applySettings() {
        if (!this.isInitialized || !this.waveFooter || !this.footerCanvas) return;

        this.syncSize();
        this.waveFooter.clearAnimations();

        if (!this.isPlaying || (this.audio && this.audio.paused)) {
            this.clear();
            return;
        }

        const containerRect = this.visualizerContainer.getBoundingClientRect();
        const containerWidth = containerRect.width || 320;

        // 洛雪标准 Cubes 方块积木配置
        const gap = 1; // 极小间距，更细腻
        const lineWidth = 0;
        const cubeHeight = 4; // 方块高度
        const targetPitch = 5; // 单柱宽度 ~4px

        const maxCount = Math.floor(containerWidth / targetPitch);
        const count = Math.min(Math.max(maxCount, 24), 1024);

        this.footerCanvas.style.width = "100%";
        this.footerCanvas.style.height = "100%";
        this.footerCanvas.style.opacity = "0.75";

        this.syncSize();

        const themeColor = this.getContrastingColor();

        const options = {
            fillColor: themeColor,
            lineColor: themeColor,
            lineWidth: lineWidth,
            count: count,
            rounded: true,
            bottom: true,
            gap: gap,
            cubeHeight: cubeHeight
        };

        if (this.waveFooter.animations && this.waveFooter.animations.Cubes) {
            const AnimationClass = this.waveFooter.animations.Cubes;
            this.waveFooter.addAnimation(new AnimationClass(options));
        }

        if (this.audioContext && this.audioContext.state === "suspended" && this.audio && !this.audio.paused) {
            this.audioContext.resume().catch(() => {});
        }
    }

    /**
     * 停止并清空可视化 (移植自 lxserver clear)
     */
    clear() {
        if (this.waveFooter) {
            this.waveFooter.clearAnimations();
        }
        if (this.footerCanvas) {
            const ctx = this.footerCanvas.getContext("2d");
            if (ctx) {
                ctx.clearRect(0, 0, this.footerCanvas.width, this.footerCanvas.height);
            }
        }
    }
}

export function initBottomSpectrum(dom, state) {
    if (typeof window === "undefined" || !document) return null;
    try {
        const visualizer = new LXMusicVisualizerIntegration(dom, state);
        window.__solaraBottomSpectrum = visualizer;
        window.musicVisualizer = visualizer;
        return visualizer;
    } catch (err) {
        console.warn("[Visualizer] LXMusic 底部律动频谱引擎初始化异常:", err);
        return null;
    }
}
