/**
 * Solara 播放控制界面底部流体音频频谱律动动画引擎 (Bottom Spectrum Visualizer)
 * 仿照 LXMusic Web (洛雪 Web 版) 经典动态频段方块积木 (Cubes) 与动态流体均衡器
 * 核心升级：
 * 1. 采用高对比对应色算法：色相逆向互补偏移 160°，随主题智能联动但绝对不重合，清晰醒目；
 * 2. 深度扩大动态振幅 (0 ~ 55px)，强劲节奏打击感与悬浮峰值方块 (Peak Hold)，律动极其剧烈明显；
 * 3. 仿照洛雪默认采用 Cubes 方块矩阵，支持点击底栏在 方块积木 / 连体光柱 / 流体声波 间无缝切换；
 * 4. 具备 Web Audio 实时声频分析能力与超高灵敏物理声学反应引擎双通道无缝容灾。
 */

const STORAGE_KEY_MODE = "solaraSpectrumMode";
const MODES = ["cubes", "bars", "wave"];
const MODE_NAMES = {
    cubes: "洛雪经典方块 (Cubes)",
    bars: "连体高光频柱 (Bars)",
    wave: "灵动流体声波 (Wave)"
};

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
            const parts = m[1].split(/[,\s/]+/).map(p => parseFloat(p.trim())).filter(n => !isNaN(n));
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

export class BottomSpectrumVisualizer {
    constructor(dom, state = {}) {
        this.dom = dom;
        this.state = state;
        this.container = dom?.controlsSpectrum || document.getElementById("controlsSpectrum");
        this.canvas = dom?.controlsSpectrumCanvas || document.getElementById("controlsSpectrumCanvas");
        this.audio = dom?.audioPlayer || document.getElementById("audioPlayer");
        this.controls = dom?.controls || document.querySelector(".controls");

        this.ctx = null;
        this.animationId = null;
        this.isRunning = false;

        // 视口与尺寸
        this.width = 0;
        this.height = 0;
        this.dpr = 1;

        // 动效模式：默认经典洛雪方块 (cubes)
        this.mode = localStorage.getItem(STORAGE_KEY_MODE) || "cubes";
        if (!MODES.includes(this.mode)) this.mode = "cubes";

        this.energy = 0;
        this.time = 0;
        this.bars = [];

        // 对应色系调色板缓存 (与主题联动但绝对不同色)
        this.colors = {
            base: "#f59e0b",
            top: "#fbbf24",
            peak: "#fef08a",
            glow: "rgba(245, 158, 11, 0.4)",
            line: "rgba(245, 158, 11, 0.25)"
        };

        // Web Audio API 分析器
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.hasRealAudioData = false;

        this.init();
    }

    init() {
        if (!this.canvas || !this.container) return;
        this.ctx = this.canvas.getContext("2d");
        if (!this.ctx) return;

        this.updateThemeColors();
        this.updateDimensions();

        // 监听尺寸变化自适应
        if (typeof ResizeObserver !== "undefined" && this.controls) {
            this.resizeObserver = new ResizeObserver(() => this.updateDimensions());
            this.resizeObserver.observe(this.controls);
        } else {
            window.addEventListener("resize", () => this.updateDimensions(), { passive: true });
        }

        // 绑定音频播放生命周期事件
        if (this.audio) {
            const onPlayTrigger = () => {
                this.tryInitWebAudio();
                this.start();
            };
            this.audio.addEventListener("play", onPlayTrigger);
            this.audio.addEventListener("playing", onPlayTrigger);
            this.audio.addEventListener("timeupdate", () => {
                if (!this.isRunning && !this.audio.paused) this.start();
            });
            this.audio.addEventListener("pause", () => this.stopGradually());
            this.audio.addEventListener("ended", () => this.stopGradually());
            this.audio.addEventListener("volumechange", () => {
                if (this.isRunning) this.renderFrame();
            });
        }

        // 页面前后台切出挂起
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (this.isRunning) {
                    cancelAnimationFrame(this.animationId);
                    this.isRunning = false;
                }
            } else if (this.audio && !this.audio.paused) {
                this.start();
            }
        });

        // 点击底栏频谱区域快速切换模式
        this.container.addEventListener("click", (e) => {
            e.stopPropagation();
            this.switchNextMode();
        });

        if (this.audio && !this.audio.paused) {
            this.start();
        } else {
            this.renderRestState();
        }
    }

    /**
     * 尝试接入 Web Audio API 获得 100% 真实频段
     */
    tryInitWebAudio() {
        if (this.analyser || !this.audio) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!this.audioContext) {
                this.audioContext = new AudioCtx();
            }
            if (this.audioContext.state === "suspended") {
                this.audioContext.resume().catch(() => {});
            }

            // 优先尝试与媒体节点建立连接
            if (!this.audioSource) {
                try {
                    this.audioSource = this.audioContext.createMediaElementSource(this.audio);
                    this.analyser = this.audioContext.createAnalyser();
                    this.analyser.fftSize = 256;
                    this.analyser.smoothingTimeConstant = 0.72;
                    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

                    this.audioSource.connect(this.analyser);
                    this.analyser.connect(this.audioContext.destination);
                    console.log("[Visualizer] Web Audio 实时分析器装载成功");
                } catch (corsErr) {
                    // 若受跨域 CORS 影响或已被占用，平滑降级为高灵敏拟真引擎
                    console.log("[Visualizer] 启用高动态自适应声学共振引擎:", corsErr.message);
                }
            }
        } catch (e) {
            console.warn("[Visualizer] AudioContext 初始化跳过:", e.message);
        }
    }

    updateDimensions() {
        if (!this.container || !this.canvas) return;
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(rect.width, 240);
        this.height = Math.max(rect.height, 40);
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.canvas.width = Math.floor(this.width * this.dpr);
        this.canvas.height = Math.floor(this.height * this.dpr);

        if (this.ctx) {
            this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        }

        this.initBars();
        if (!this.isRunning) this.renderRestState();
    }

    initBars() {
        // 仿照洛雪 targetPitch: 5~6px，大幅增加频段柱数量，填满控制栏
        const targetPitch = 6;
        const availableW = this.width - 24;
        const count = Math.max(48, Math.min(Math.floor(availableW / targetPitch), 128));
        this.bars = [];
        for (let i = 0; i < count; i++) {
            this.bars.push({
                h: 0,
                target: 0,
                peak: 0,
                peakHold: 0,
                peakSpeed: 0
            });
        }
    }

    /**
     * 核心算法：根据主题色推导强反差、高对比、绝不重合的“相对应变幻色系”
     */
    updateThemeColors() {
        if (typeof window === "undefined") return;
        const styles = getComputedStyle(document.documentElement);
        const p = styles.getPropertyValue("--primary-color").trim() || "#6366f1";
        const isDark = document.body.classList.contains("dark-mode") || document.documentElement.classList.contains("dark-mode");

        const { h, s } = parseColorToHsl(p);

        // 互补对比色相：在色相环上旋转 155° ~ 195° 对应区间，保证与当前主题色具有极高视觉辨识度
        const compH1 = (h + 155) % 360;
        const compH2 = (h + 195) % 360;
        const compHPeak = (h + 175) % 360;
        const sat = Math.max(s, 92); // 饱和度维持在 92% 以上，色泽饱满不发灰

        if (isDark) {
            // 暗色玻璃背景：使用通透鲜艳的霓虹发光色，高纯度，明度拉高
            this.colors = {
                base: `hsl(${compH1}, ${sat}%, 58%)`,
                top: `hsl(${compH2}, 100%, 72%)`,
                peak: `hsl(${compHPeak}, 100%, 84%)`,
                glow: `hsla(${compHPeak}, 100%, 70%, 0.45)`,
                line: `hsla(${compHPeak}, 95%, 65%, 0.28)`,
                cubeBg: `hsla(${compH1}, ${sat}%, 55%, 0.88)`
            };
        } else {
            // 浅色玻璃背景：为了防止泛白看不清，明度调至 38%~48% 浓郁宝石色，轮廓极其鲜明
            this.colors = {
                base: `hsl(${compH1}, ${sat}%, 38%)`,
                top: `hsl(${compH2}, 100%, 48%)`,
                peak: `hsl(${compHPeak}, 100%, 30%)`,
                glow: `hsla(${compHPeak}, 100%, 42%, 0.35)`,
                line: `hsla(${compHPeak}, 95%, 45%, 0.28)`,
                cubeBg: `hsla(${compH1}, ${sat}%, 40%, 0.92)`
            };
        }
    }

    switchNextMode() {
        const nextIdx = (MODES.indexOf(this.mode) + 1) % MODES.length;
        this.mode = MODES[nextIdx];
        try {
            localStorage.setItem(STORAGE_KEY_MODE, this.mode);
        } catch {}

        const modeName = MODE_NAMES[this.mode] || this.mode;
        if (typeof window.showNotification === "function") {
            window.showNotification(`🎵 底部频谱切换为：${modeName}`);
        }
        if (!this.isRunning) this.renderRestState();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.energy = Math.max(this.energy, 0.4);
        this.loop();
    }

    stopGradually() {
        // 自然能量阻尼递减
    }

    loop() {
        if (!this.isRunning) return;

        const isPlaying = this.audio && !this.audio.paused && !this.audio.ended;

        if (isPlaying) {
            this.energy += (1 - this.energy) * 0.16; // 攻击响应极快
        } else {
            this.energy += (0 - this.energy) * 0.08;
        }

        this.time += 0.045;

        // 尝试采集真实音频数据
        if (this.analyser && this.dataArray) {
            this.analyser.getByteFrequencyData(this.dataArray);
            let sum = 0;
            for (let i = 0; i < 16; i++) sum += this.dataArray[i];
            this.hasRealAudioData = sum > 10;
        }

        this.renderFrame();

        // 待机完全静止后归零
        if (!isPlaying && this.energy < 0.008) {
            this.energy = 0;
            this.isRunning = false;
            this.renderRestState();
            return;
        }

        this.animationId = requestAnimationFrame(() => this.loop());
    }

    renderFrame() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        ctx.clearRect(0, 0, w, h);
        this.updateThemeColors();

        const vol = this.audio ? (this.audio.muted ? 0 : this.audio.volume) : 0.8;
        const effectiveEnergy = this.energy * vol;

        switch (this.mode) {
            case "bars":
                this.drawSpectrumBars(w, h, effectiveEnergy);
                break;
            case "wave":
                this.drawFluidWave(w, h, effectiveEnergy);
                break;
            case "cubes":
            default:
                this.drawLxCubes(w, h, effectiveEnergy);
                break;
        }
    }

    renderRestState() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        ctx.clearRect(0, 0, w, h);

        this.updateThemeColors();

        // 待机状态：清晰优雅的对应色微光底轨
        ctx.save();
        ctx.strokeStyle = this.colors.line;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(12, h - 2);
        ctx.lineTo(w - 12, h - 2);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * 模式 1：仿照 LXMusic 经典高动态方块积木 (Cubes / Blocks)
     * 极高视觉张力：小方块逐级向上爆发堆叠，带悬停重力下落峰值 (Peak Block)
     */
    drawLxCubes(w, h, energy) {
        const ctx = this.ctx;
        const count = this.bars.length;
        if (count === 0) return;

        const availableW = w - 24;
        const colGap = 2;
        const barW = Math.max(2.2, (availableW - (count - 1) * colGap) / count);
        const startX = 12;

        // 方块参数：高 3.5px，垂直间隙 1.2px
        const cubeHeight = 3.5;
        const cubeGap = 1.2;
        const cubePitch = cubeHeight + cubeGap;
        const maxCubes = Math.floor((h - 6) / cubePitch);
        const maxBarH = maxCubes * cubePitch;

        for (let i = 0; i < count; i++) {
            const bar = this.bars[i];
            const ratio = i / count;

            let val = 0;
            if (this.hasRealAudioData && this.dataArray) {
                const dataIdx = Math.floor((i / count) * (this.dataArray.length * 0.75));
                val = (this.dataArray[dataIdx] / 255) * maxBarH * energy;
            } else {
                // 超强动态声学模拟 (大幅低音重锤与密集泛音爆发)
                const kick = Math.pow(Math.sin(this.time * 5.2), 4) * Math.max(0, 1 - ratio * 1.8) * 1.3;
                const bass = Math.sin(this.time * 3.8 + i * 0.18) * 0.5 + 0.5;
                const mid = (Math.sin(this.time * 6.5 + i * 0.42) * 0.5 + 0.5) * (1 - Math.abs(ratio - 0.4));
                const treble = (Math.sin(this.time * 11.2 + i * 0.85) * 0.5 + 0.5) * (0.3 + ratio * 0.7);

                const sim = (kick * 0.65 + bass * 0.4 + mid * 0.45 + treble * 0.35) * maxBarH * energy;
                val = sim;
            }

            bar.target = Math.max(cubeHeight, Math.min(val, maxBarH));
            // 极速上升，平滑回落
            if (bar.target > bar.h) {
                bar.h += (bar.target - bar.h) * 0.55;
            } else {
                bar.h += (bar.target - bar.h) * 0.22;
            }

            // 悬停峰值方块 (Peak Cube) 物理模拟：悬停 5 帧后受重力下坠
            if (bar.h >= bar.peak) {
                bar.peak = bar.h;
                bar.peakSpeed = 0;
                bar.peakHold = 6;
            } else if (bar.peakHold > 0) {
                bar.peakHold--;
            } else {
                bar.peakSpeed += 0.35;
                bar.peak = Math.max(cubeHeight, bar.peak - bar.peakSpeed);
            }

            const x = startX + i * (barW + colGap);
            const activeCubes = Math.floor(bar.h / cubePitch);

            // 绘制一节一节的方块积木
            for (let c = 0; c < activeCubes; c++) {
                const cubeY = h - (c + 1) * cubePitch;
                const cubeRatio = c / maxCubes;

                ctx.save();
                // 自底向上颜色渐变加亮 (由深色基调跃升为高光)
                ctx.fillStyle = cubeRatio > 0.6 ? this.colors.top : this.colors.base;
                ctx.globalAlpha = 0.88;
                this.fillRoundedRect(ctx, x, cubeY, barW, cubeHeight, 0.8);
                ctx.restore();
            }

            // 绘制顶部浮动峰值方块 (带有高亮霓虹光晕)
            if (energy > 0.1 && bar.peak > cubePitch * 1.5) {
                const peakCubeIdx = Math.floor(bar.peak / cubePitch);
                const peakY = h - (peakCubeIdx + 1) * cubePitch;

                ctx.save();
                ctx.fillStyle = this.colors.peak;
                ctx.shadowColor = this.colors.glow;
                ctx.shadowBlur = 5;
                ctx.globalAlpha = 1.0;
                this.fillRoundedRect(ctx, x, peakY, barW, cubeHeight, 0.8);
                ctx.restore();
            }
        }
    }

    /**
     * 模式 2：连体高光频柱 (Bars)
     */
    drawSpectrumBars(w, h, energy) {
        const ctx = this.ctx;
        const count = this.bars.length;
        if (count === 0) return;

        const maxBarH = h - 6;
        const colGap = 2;
        const availableW = w - 24;
        const barW = Math.max(2.2, (availableW - (count - 1) * colGap) / count);
        const startX = 12;

        const grad = ctx.createLinearGradient(0, h, 0, h - maxBarH);
        grad.addColorStop(0, this.colors.base);
        grad.addColorStop(1, this.colors.top);

        for (let i = 0; i < count; i++) {
            const bar = this.bars[i];
            const ratio = i / count;

            let val = 0;
            if (this.hasRealAudioData && this.dataArray) {
                const dataIdx = Math.floor((i / count) * (this.dataArray.length * 0.75));
                val = (this.dataArray[dataIdx] / 255) * maxBarH * energy;
            } else {
                const kick = Math.pow(Math.sin(this.time * 5.2), 4) * Math.max(0, 1 - ratio * 1.8) * 1.2;
                const bass = Math.sin(this.time * 3.8 + i * 0.18) * 0.5 + 0.5;
                const mid = (Math.sin(this.time * 6.5 + i * 0.42) * 0.5 + 0.5) * (1 - Math.abs(ratio - 0.4));
                const treble = (Math.sin(this.time * 11.2 + i * 0.85) * 0.5 + 0.5) * (0.3 + ratio * 0.7);
                val = (kick * 0.65 + bass * 0.4 + mid * 0.45 + treble * 0.35) * maxBarH * energy;
            }

            bar.target = Math.max(2, Math.min(val, maxBarH));
            if (bar.target > bar.h) {
                bar.h += (bar.target - bar.h) * 0.55;
            } else {
                bar.h += (bar.target - bar.h) * 0.22;
            }

            if (bar.h >= bar.peak) {
                bar.peak = bar.h;
                bar.peakSpeed = 0;
                bar.peakHold = 5;
            } else if (bar.peakHold > 0) {
                bar.peakHold--;
            } else {
                bar.peakSpeed += 0.35;
                bar.peak = Math.max(2, bar.peak - bar.peakSpeed);
            }

            const x = startX + i * (barW + colGap);
            const barH = bar.h;
            const y = h - barH;

            ctx.save();
            ctx.fillStyle = grad;
            ctx.globalAlpha = 0.92;
            this.fillRoundedRect(ctx, x, y, barW, barH, Math.min(barW / 2, 1.5));
            ctx.restore();

            // 顶部悬浮峰值条
            if (energy > 0.1 && bar.peak > 4) {
                ctx.save();
                ctx.fillStyle = this.colors.peak;
                ctx.shadowColor = this.colors.glow;
                ctx.shadowBlur = 6;
                ctx.globalAlpha = 1.0;
                const peakY = Math.max(2, h - bar.peak - 2);
                ctx.fillRect(x, peakY, barW, 2);
                ctx.restore();
            }
        }
    }

    /**
     * 模式 3：灵动流体声波渐变曲面 (Wave)
     */
    drawFluidWave(w, h, energy) {
        const ctx = this.ctx;
        const points = 36;
        const step = (w - 24) / (points - 1);
        const startX = 12;
        const maxAmp = (h - 8) * energy;

        const waveGrad = ctx.createLinearGradient(0, h, 0, h - maxAmp);
        waveGrad.addColorStop(0, this.colors.line);
        waveGrad.addColorStop(1, this.colors.glow);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(startX, h);

        const coords = [];
        for (let i = 0; i < points; i++) {
            const x = startX + i * step;
            const norm = i / (points - 1);
            const w1 = Math.sin(this.time * 4.2 + i * 0.42) * 0.5 + 0.5;
            const w2 = Math.cos(this.time * 6.8 - i * 0.28) * 0.5 + 0.5;
            const envelope = Math.sin(norm * Math.PI);
            const y = h - (w1 * 0.65 + w2 * 0.35) * maxAmp * envelope - 3;
            coords.push({ x, y });
        }

        ctx.lineTo(coords[0].x, coords[0].y);
        for (let i = 0; i < coords.length - 1; i++) {
            const p0 = coords[i];
            const p1 = coords[i + 1];
            const midX = (p0.x + p1.x) / 2;
            const midY = (p0.y + p1.y) / 2;
            ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
        }
        ctx.lineTo(coords[coords.length - 1].x, coords[coords.length - 1].y);
        ctx.lineTo(startX + (points - 1) * step, h);
        ctx.closePath();

        ctx.fillStyle = waveGrad;
        ctx.fill();

        // 顶层流体霓虹描边
        ctx.strokeStyle = this.colors.top;
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = 0.95;
        ctx.shadowColor = this.colors.glow;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
    }

    fillRoundedRect(ctx, x, y, w, h, r) {
        if (h <= 0) return;
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, w, h, [radius, radius, 0, 0]);
        } else {
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + w - radius, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x, y + h);
            ctx.lineTo(x, y + radius);
            ctx.quadraticCurveTo(x, y, x + radius, y);
        }
        ctx.fill();
    }
}

export function initBottomSpectrum(dom, state) {
    if (typeof window === "undefined" || !document) return null;
    try {
        const visualizer = new BottomSpectrumVisualizer(dom, state);
        window.__solaraBottomSpectrum = visualizer;
        console.log("[Visualizer] 播放底栏频谱律动引擎初始化成功 (仿照 LXMusic Web)");
        return visualizer;
    } catch (err) {
        console.warn("[Visualizer] 底部频谱引擎初始化异常:", err);
        return null;
    }
}
