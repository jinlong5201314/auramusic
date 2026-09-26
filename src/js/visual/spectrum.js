/**
 * Solara 播放控制界面底部流体音频频谱律动动画引擎 (Bottom Spectrum Visualizer)
 * 纯净声学规整频段均衡器 (Fixed Frequency Equalizer)
 * 
 * 核心原则：
 * 1. 绝不劫持 <audio> 节点 (杜绝任何跨域音频导致静音的风险)，保证系统原生音频播放 100% 正常；
 * 2. 纯原地垂直弹跳，绝对不进行任何横向行波滚动，规整不杂乱；
 * 3. 没音乐或暂停时立即彻底清空并停止渲染，0% CPU 占用；
 * 4. 颜色与主题色形成鲜明互补对应（色相旋转 160°），绝不重合，清晰醒目。
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

        // 32 根固定独立频段均衡器柱 (原地上下跳跃，杜绝滚动)
        this.barCount = 32;
        this.bars = [];
        this.initFixedBands();

        // 对应色系
        this.colors = {
            base: "#f59e0b",
            top: "#fbbf24",
            peak: "#fef08a"
        };

        this.init();
    }

    initFixedBands() {
        this.bars = [];
        for (let i = 0; i < this.barCount; i++) {
            // 每根柱子有独立的本征特征（绝无空间行波项，每个频柱纯粹在原地起伏）
            this.bars.push({
                h: 0,
                target: 0,
                peak: 0,
                peakHold: 0,
                peakSpeed: 0,
                // 伪随机独立共振系数 (无线性相位差)
                weight: 0.4 + 0.6 * Math.sin((i * 17.3 + 5.1) % Math.PI),
                decay: 0.18 + 0.08 * (i % 3)
            });
        }
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

        // 绑定音频播放生命周期事件：绝不劫持音频流
        if (this.audio) {
            const onPlay = () => this.start();
            const onStop = () => this.stopImmediately();

            this.audio.addEventListener("play", onPlay);
            this.audio.addEventListener("playing", onPlay);
            this.audio.addEventListener("pause", onStop);
            this.audio.addEventListener("ended", onStop);
            this.audio.addEventListener("emptied", onStop);
            this.audio.addEventListener("error", onStop);
        }

        // 页面可见性管理
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                this.stopImmediately();
            } else if (this.audio && !this.audio.paused && !this.audio.ended) {
                this.start();
            }
        });

        // 初始状态：若未在播放，完全清空停止
        if (this.audio && !this.audio.paused && !this.audio.ended) {
            this.start();
        } else {
            this.stopImmediately();
        }
    }

    updateDimensions() {
        if (!this.container || !this.canvas) return;
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(rect.width, 240);
        this.height = Math.max(rect.height, 36);
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.canvas.width = Math.floor(this.width * this.dpr);
        this.canvas.height = Math.floor(this.height * this.dpr);

        if (this.ctx) {
            this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        }

        if (!this.isRunning) this.stopImmediately();
    }

    /**
     * 核心对应色计算：随主题联动但绝对不同色
     */
    updateThemeColors() {
        if (typeof window === "undefined") return;
        const styles = getComputedStyle(document.documentElement);
        const p = styles.getPropertyValue("--primary-color").trim() || "#6366f1";
        const isDark = document.body.classList.contains("dark-mode") || document.documentElement.classList.contains("dark-mode");

        const { h, s } = parseColorToHsl(p);

        // 互补对比色相：旋转 160°，确保绝对不与当前主题色重合撞色
        const compH1 = (h + 160) % 360;
        const compH2 = (h + 190) % 360;
        const sat = Math.max(s, 90);

        if (isDark) {
            // 深色背景下使用高对比明亮金橙/青翠色
            this.colors = {
                base: `hsl(${compH1}, ${sat}%, 58%)`,
                top: `hsl(${compH2}, 100%, 72%)`,
                peak: `hsl(${compH2}, 100%, 84%)`,
                glow: `hsla(${compH2}, 100%, 70%, 0.4)`
            };
        } else {
            // 浅色背景下使用浓郁宝石对比色，清晰分明不发白
            this.colors = {
                base: `hsl(${compH1}, ${sat}%, 38%)`,
                top: `hsl(${compH2}, 100%, 48%)`,
                peak: `hsl(${compH2}, 100%, 30%)`,
                glow: `hsla(${compH2}, 100%, 42%, 0.3)`
            };
        }
    }

    start() {
        if (this.isRunning) return;
        if (!this.audio || this.audio.paused || this.audio.ended) return;
        this.isRunning = true;
        this.loop();
    }

    /**
     * 没音乐或暂停时立即彻底清空停止，绝无残留跳动
     */
    stopImmediately() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.isRunning = false;
        for (let i = 0; i < this.bars.length; i++) {
            this.bars[i].h = 0;
            this.bars[i].target = 0;
            this.bars[i].peak = 0;
            this.bars[i].peakHold = 0;
            this.bars[i].peakSpeed = 0;
        }
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.width, this.height);
        }
    }

    loop() {
        if (!this.isRunning) return;

        // 强校验：如果已暂停或停止，立刻停止渲染并清空
        if (!this.audio || this.audio.paused || this.audio.ended) {
            this.stopImmediately();
            return;
        }

        this.renderFrame();
        this.animationId = requestAnimationFrame(() => this.loop());
    }

    renderFrame() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        ctx.clearRect(0, 0, w, h);
        this.updateThemeColors();

        const count = this.barCount;
        const maxH = h - 6;

        // 方块积木尺寸参数
        const cubeHeight = 3;
        const cubeGap = 1.2;
        const cubePitch = cubeHeight + cubeGap;
        const maxCubes = Math.floor(maxH / cubePitch);

        // 居中规整排布：左右留出均等空间，端正不杂乱
        const barW = 4;
        const colGap = 2.5;
        const totalSpectrumW = count * barW + (count - 1) * colGap;
        const startX = Math.max(12, Math.floor((w - totalSpectrumW) / 2));

        // 基于音频实际播放时间与音量模拟真实声学固定频带跳动
        const ct = this.audio.currentTime || 0;
        const vol = this.audio.muted ? 0 : (this.audio.volume ?? 1);
        if (vol <= 0.01) return;

        // 模拟节拍打击动力学：BPM 128 节拍脉冲（原地垂直弹起，无横向行波）
        const beatCycle = (ct * 2.13) % 1; // 节拍周期
        const kickPulse = Math.pow(Math.max(0, 1 - beatCycle * 2.2), 3); // 瞬间上冲而后指数下坠
        const snarePulse = Math.pow(Math.max(0, 1 - ((ct * 2.13 + 0.5) % 1) * 2.5), 3);

        for (let i = 0; i < count; i++) {
            const bar = this.bars[i];
            const ratio = i / count;

            let targetHeight = 0;

            if (ratio < 0.28) {
                // 低频区 (0~8)：受大鼓与贝斯重锤垂直冲击
                const bassWeight = 1 - ratio * 2;
                targetHeight = (kickPulse * 0.75 * bassWeight + 0.25 * bar.weight) * maxH * vol;
            } else if (ratio < 0.65) {
                // 中频区 (9~20)：人声与主旋律节奏
                const midWeight = Math.sin((ratio - 0.28) / 0.37 * Math.PI);
                const subPulse = Math.sin(ct * 6.5 + bar.weight * 4) * 0.5 + 0.5;
                targetHeight = (snarePulse * 0.45 * midWeight + subPulse * 0.55 * bar.weight) * maxH * 0.85 * vol;
            } else {
                // 高频区 (21~31)：镲片泛音与细碎闪烁
                const shimmer = Math.sin(ct * 14.5 + bar.weight * 10) * 0.5 + 0.5;
                targetHeight = (shimmer * 0.6 + kickPulse * 0.4) * maxH * 0.7 * vol * (0.4 + 0.6 * bar.weight);
            }

            bar.target = Math.max(cubeHeight, Math.min(targetHeight, maxH));

            // 原地快速上升，平滑回落
            if (bar.target > bar.h) {
                bar.h += (bar.target - bar.h) * 0.45;
            } else {
                bar.h += (bar.target - bar.h) * bar.decay;
            }

            // 悬停峰值方块 (Peak Hold)：悬停后重力滑落
            if (bar.h >= bar.peak) {
                bar.peak = bar.h;
                bar.peakSpeed = 0;
                bar.peakHold = 4;
            } else if (bar.peakHold > 0) {
                bar.peakHold--;
            } else {
                bar.peakSpeed += 0.3;
                bar.peak = Math.max(cubeHeight, bar.peak - bar.peakSpeed);
            }

            const x = startX + i * (barW + colGap);
            const activeCubes = Math.floor(bar.h / cubePitch);

            // 绘制原地垂直方块积木
            for (let c = 0; c < activeCubes; c++) {
                const cubeY = h - (c + 1) * cubePitch;
                const cubeRatio = c / maxCubes;

                ctx.save();
                ctx.fillStyle = cubeRatio > 0.6 ? this.colors.top : this.colors.base;
                ctx.globalAlpha = 0.88;
                this.fillRoundedRect(ctx, x, cubeY, barW, cubeHeight, 0.6);
                ctx.restore();
            }

            // 绘制顶部悬停峰值小方块
            if (bar.peak > cubePitch * 1.5) {
                const peakCubeIdx = Math.floor(bar.peak / cubePitch);
                const peakY = h - (peakCubeIdx + 1) * cubePitch;

                ctx.save();
                ctx.fillStyle = this.colors.peak;
                ctx.shadowColor = this.colors.glow;
                ctx.shadowBlur = 4;
                ctx.globalAlpha = 0.95;
                this.fillRoundedRect(ctx, x, peakY, barW, cubeHeight, 0.6);
                ctx.restore();
            }
        }
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
        console.log("[Visualizer] 播放底栏纯净规整频段均衡器已装载");
        return visualizer;
    } catch (err) {
        console.warn("[Visualizer] 底部频谱引擎装载异常:", err);
        return null;
    }
}
