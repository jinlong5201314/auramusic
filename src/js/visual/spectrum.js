/**
 * Solara 播放控制界面底部流体音频频谱律动动画引擎 (Bottom Spectrum Visualizer)
 * 具备 60fps 动态拟真多频段均衡器、流体波形、立体声脉冲三模切换，随主题色彩与音量自适应。
 */

const STORAGE_KEY_MODE = "solaraSpectrumMode";
const MODES = ["bars", "wave", "pulse"];
const MODE_NAMES = {
    bars: "经典频段柱",
    wave: "流体声波",
    pulse: "立体声脉冲"
};

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

        // 动效参数
        this.mode = localStorage.getItem(STORAGE_KEY_MODE) || "bars";
        if (!MODES.includes(this.mode)) this.mode = "bars";

        this.energy = 0; // 0 (静止) ~ 1 (全力律动)
        this.time = 0;
        this.bars = [];
        this.primaryColor = "#6366f1";
        this.accentColor = "#a855f7";

        this.init();
    }

    init() {
        if (!this.canvas || !this.container) return;
        this.ctx = this.canvas.getContext("2d");
        if (!this.ctx) return;

        this.updateDimensions();

        // 监听尺寸变化以自适应 Retina 屏
        if (typeof ResizeObserver !== "undefined" && this.controls) {
            this.resizeObserver = new ResizeObserver(() => this.updateDimensions());
            this.resizeObserver.observe(this.controls);
        } else {
            window.addEventListener("resize", () => this.updateDimensions(), { passive: true });
        }

        // 绑定音频播放生命周期事件
        if (this.audio) {
            this.audio.addEventListener("play", () => this.start());
            this.audio.addEventListener("playing", () => this.start());
            this.audio.addEventListener("timeupdate", () => {
                if (!this.isRunning && !this.audio.paused) this.start();
            });
            this.audio.addEventListener("pause", () => this.stopGradually());
            this.audio.addEventListener("ended", () => this.stopGradually());
            this.audio.addEventListener("volumechange", () => {
                if (this.isRunning) this.renderFrame();
            });
        }

        // 页面可见性管理：页面后台切出时暂挂动画节约算力
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

        // 点击底栏频谱区域循环切换动效模式
        this.container.addEventListener("click", (e) => {
            e.stopPropagation();
            this.switchNextMode();
        });

        // 初始若正在播放，直接开启动画
        if (this.audio && !this.audio.paused) {
            this.start();
        } else {
            this.renderRestState();
        }
    }

    updateDimensions() {
        if (!this.container || !this.canvas) return;
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(rect.width, 200);
        this.height = Math.max(rect.height, 16);
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
        const barSpacing = 5; // 柱条中心距
        const count = Math.max(32, Math.min(Math.floor(this.width / barSpacing), 88));
        this.bars = [];
        for (let i = 0; i < count; i++) {
            this.bars.push({
                h: 0,
                target: 0,
                peak: 0,
                peakSpeed: 0
            });
        }
    }

    updateThemeColors() {
        if (typeof window === "undefined") return;
        const styles = getComputedStyle(document.documentElement);
        const p = styles.getPropertyValue("--primary-color").trim();
        const a = styles.getPropertyValue("--accent-color").trim();
        if (p) this.primaryColor = p;
        if (a) this.accentColor = a;
        else this.accentColor = this.primaryColor;
    }

    switchNextMode() {
        const nextIdx = (MODES.indexOf(this.mode) + 1) % MODES.length;
        this.mode = MODES[nextIdx];
        try {
            localStorage.setItem(STORAGE_KEY_MODE, this.mode);
        } catch {}

        const modeName = MODE_NAMES[this.mode] || this.mode;
        if (typeof window.showNotification === "function") {
            window.showNotification(`🎵 底部频谱动效切换为：${modeName}`);
        }
        if (!this.isRunning) this.renderRestState();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.energy = Math.max(this.energy, 0.2);
        this.loop();
    }

    stopGradually() {
        // 不立即切断，让能量自然衰减平滑落地
    }

    loop() {
        if (!this.isRunning) return;

        const isPlaying = this.audio && !this.audio.paused && !this.audio.ended;

        if (isPlaying) {
            this.energy += (1 - this.energy) * 0.12;
        } else {
            this.energy += (0 - this.energy) * 0.08;
        }

        this.time += 0.04;
        this.renderFrame();

        // 当完全归零且已暂停时，停止 requestAnimationFrame 循环以实现 0% 待机功耗
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
            case "wave":
                this.drawFluidWave(w, h, effectiveEnergy);
                break;
            case "pulse":
                this.drawStereoPulse(w, h, effectiveEnergy);
                break;
            case "bars":
            default:
                this.drawSpectrumBars(w, h, effectiveEnergy);
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

        // 待机微光底线（极低存在感、克制优雅）
        ctx.save();
        ctx.strokeStyle = this.primaryColor;
        ctx.globalAlpha = 0.15;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(12, h - 2);
        ctx.lineTo(w - 12, h - 2);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * 模式 1：经典多频段跳动频谱柱 (含浮动峰值点)
     */
    drawSpectrumBars(w, h, energy) {
        const ctx = this.ctx;
        const count = this.bars.length;
        if (count === 0) return;

        const maxBarH = h - 3;
        const totalGap = (count - 1) * 2;
        const availableW = w - 24; // 左右各留 12px 边距
        const barW = Math.max(1.8, (availableW - totalGap) / count);
        const gap = 2;
        const startX = 12;

        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, this.primaryColor);
        grad.addColorStop(1, this.accentColor);

        for (let i = 0; i < count; i++) {
            const bar = this.bars[i];
            const ratio = i / count;

            // 拟真频段合成物理建模
            const bass = Math.pow(Math.sin(this.time * 4.8), 6) * Math.max(0, 1 - ratio * 2.2);
            const mid = (Math.sin(this.time * 3.2 + i * 0.35) * 0.5 + 0.5) * (1 - Math.abs(ratio - 0.45));
            const treble = (Math.sin(this.time * 8.6 + i * 0.72) * 0.5 + 0.5) * (0.2 + ratio * 0.8);
            const pulse = (Math.sin(this.time * 2.1 + i * 0.12) * 0.5 + 0.5) * 0.3;

            const sim = (bass * 0.55 + mid * 0.35 + treble * 0.25 + pulse) * maxBarH * energy;
            bar.target = Math.max(1.5, Math.min(sim, maxBarH));

            // 平滑插值
            bar.h += (bar.target - bar.h) * 0.32;

            // 浮动峰值点计算 (重力下落)
            if (bar.h >= bar.peak) {
                bar.peak = bar.h;
                bar.peakSpeed = 0;
            } else {
                bar.peakSpeed += 0.22;
                bar.peak = Math.max(1.5, bar.peak - bar.peakSpeed);
            }

            const x = startX + i * (barW + gap);
            const barH = bar.h;
            const y = h - barH;

            // 绘制主频谱柱
            ctx.save();
            ctx.fillStyle = grad;
            ctx.globalAlpha = 0.45 + (barH / maxBarH) * 0.5;
            this.fillRoundedRect(ctx, x, y, barW, barH, Math.min(barW / 2, 2));
            ctx.restore();

            // 绘制顶部浮动峰值点
            if (energy > 0.1 && bar.peak > 3) {
                ctx.save();
                ctx.fillStyle = this.accentColor;
                ctx.globalAlpha = 0.85;
                ctx.shadowColor = this.accentColor;
                ctx.shadowBlur = 4;
                const peakY = Math.max(1, h - bar.peak - 1.5);
                ctx.fillRect(x, peakY, barW, 1.2);
                ctx.restore();
            }
        }
    }

    /**
     * 模式 2：灵动流体声波渐变曲面
     */
    drawFluidWave(w, h, energy) {
        const ctx = this.ctx;
        const points = 32;
        const step = (w - 24) / (points - 1);
        const startX = 12;
        const maxAmp = (h - 4) * energy;

        const waveGrad = ctx.createLinearGradient(0, h, 0, 0);
        waveGrad.addColorStop(0, "rgba(99, 102, 241, 0.05)");
        waveGrad.addColorStop(1, "rgba(168, 85, 247, 0.35)");

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(startX, h);

        const coords = [];
        for (let i = 0; i < points; i++) {
            const x = startX + i * step;
            const norm = i / (points - 1);
            const w1 = Math.sin(this.time * 3.6 + i * 0.45) * 0.5 + 0.5;
            const w2 = Math.cos(this.time * 5.2 - i * 0.32) * 0.5 + 0.5;
            const envelope = Math.sin(norm * Math.PI); // 两端低中间高包络
            const y = h - (w1 * 0.65 + w2 * 0.35) * maxAmp * envelope - 2;
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
        ctx.strokeStyle = this.accentColor;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.85;
        ctx.shadowColor = this.accentColor;
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.restore();
    }

    /**
     * 模式 3：立体声对称脉冲 (Stereo Mirror Pulse)
     */
    drawStereoPulse(w, h, energy) {
        const ctx = this.ctx;
        const halfCount = Math.floor(this.bars.length / 2);
        const center = w / 2;
        const maxH = h - 4;
        const barW = Math.max(1.8, (w - 24) / (halfCount * 2 * 1.5));
        const gap = 1.5;

        ctx.save();
        ctx.fillStyle = this.primaryColor;
        ctx.shadowColor = this.primaryColor;
        ctx.shadowBlur = 4;

        for (let i = 0; i < halfCount; i++) {
            const norm = i / halfCount;
            const kick = Math.pow(Math.sin(this.time * 5 + i * 0.2), 4);
            const barH = Math.max(1.5, kick * maxH * (1 - norm * 0.65) * energy);

            ctx.globalAlpha = 0.4 + (barH / maxH) * 0.55;

            // 右声道
            const rx = center + i * (barW + gap) + 4;
            this.fillRoundedRect(ctx, rx, h - barH, barW, barH, 1.2);

            // 左声道 (镜像对称)
            const lx = center - (i + 1) * (barW + gap) - 4;
            this.fillRoundedRect(ctx, lx, h - barH, barW, barH, 1.2);
        }
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
        console.log("[Visualizer] 播放底栏频谱律动引擎初始化成功");
        return visualizer;
    } catch (err) {
        console.warn("[Visualizer] 底部频谱引擎初始化异常:", err);
        return null;
    }
}
