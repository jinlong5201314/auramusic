/**
 * Solara 进度条音频频谱律动动画引擎 (Progress Bar Spectrum Visualizer)
 * 仿照 LXMusic Web 核心方块积木 (Cubes) 物理动力学
 * 
 * 核心升级：
 * 1. 严格限制在进度条长度内：精准嵌套在进度条包装器内，宽度与进度条 100% 严丝合缝对齐；
 * 2. 彻底解决“所有列同样跳动”问题：对数分频（Logarithmic Mel-scale）映射，每一列对应独立的声学频段，
 *    每一列拥有独立的物理振幅、上升速度、衰减阻尼与悬停峰值，各自独立上下跳跃；
 * 3. 动态高对比对应色：随主题色反向旋转 160° 互补色谱，清晰醒目，绝不与进度条或底栏按钮同色；
 * 4. 音乐暂停、结束、无音乐时彻底清空静止，绝无多余杂影，0% CPU 占用；
 * 5. 纯原地垂直弹跳，绝无左右横向行波滚动。
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

export class LXMusicProgressBarVisualizer {
    constructor(dom, state = {}) {
        this.dom = dom;
        this.state = state;
        this.audio = dom?.audioPlayer || document.getElementById("audioPlayer");
        this.container = dom?.controlsSpectrum || document.getElementById("controlsSpectrum");
        this.canvas = dom?.controlsSpectrumCanvas || document.getElementById("controlsSpectrumCanvas");
        this.controlsBar = document.querySelector(".controls") || this.container?.parentElement;

        this.ctx = null;
        this.animationId = null;
        this.isRunning = false;

        // 真实的 Web Audio 节点
        this.audioContext = null;
        this.audioSource = null;
        this.audioAnalyser = null;
        this.freqData = null;
        this.isAudioNodesReady = false;

        // 视口尺寸
        this.width = 0;
        this.height = 0;
        this.dpr = 1;

        // 每根柱子独立的物理状态数组
        this.bars = [];
        this.barCount = 0;

        // 对应高反差互补色系
        this.colors = {
            base: "#f59e0b",
            top: "#fbbf24",
            peak: "#fef08a",
            glow: "rgba(251, 191, 36, 0.35)"
        };

        this.init();
    }

    init() {
        if (!this.canvas || !this.container) return;
        this.ctx = this.canvas.getContext("2d");
        if (!this.ctx) return;

        this.updateThemeColors();
        this.updateDimensions();

        // 监听尺寸变化（跟随播放控制栏全宽）
        if (typeof ResizeObserver !== "undefined" && this.controlsBar) {
            this.resizeObserver = new ResizeObserver(() => this.updateDimensions());
            this.resizeObserver.observe(this.controlsBar);
        } else {
            window.addEventListener("resize", () => this.updateDimensions(), { passive: true });
        }

        // 绑定音频播放生命周期事件
        if (this.audio) {
            const handlePlay = () => {
                this.ensureAudioNodes();
                this.start();
            };

            const handleStop = () => {
                this.stopImmediately();
            };

            this.audio.addEventListener("play", handlePlay);
            this.audio.addEventListener("playing", handlePlay);
            this.audio.addEventListener("pause", handleStop);
            this.audio.addEventListener("ended", handleStop);
            this.audio.addEventListener("emptied", handleStop);
            this.audio.addEventListener("error", handleStop);

            // 用户手势激活挂起的 AudioContext
            const resumeContext = () => {
                if (this.audioContext && this.audioContext.state === "suspended") {
                    this.audioContext.resume().catch(() => {});
                }
            };
            document.addEventListener("click", resumeContext, { passive: true });
            document.addEventListener("touchstart", resumeContext, { passive: true });
        }

        // 页面可见性管理
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                this.stopImmediately();
            } else if (this.audio && !this.audio.paused && !this.audio.ended) {
                this.start();
            }
        });

        // 初始状态判断
        if (this.audio && !this.audio.paused && !this.audio.ended) {
            this.ensureAudioNodes();
            this.start();
        } else {
            this.stopImmediately();
        }
    }

    /**
     * 初始化 Web Audio 分析器
     */
    ensureAudioNodes() {
        if (this.isAudioNodesReady || !this.audio) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;

            this.audioContext = new AudioCtx();
            this.audioSource = this.audioContext.createMediaElementSource(this.audio);
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioSource.connect(this.audioAnalyser);
            this.audioAnalyser.connect(this.audioContext.destination);

            this.audioAnalyser.smoothingTimeConstant = 0.72; // 敏捷瞬态反应
            this.audioAnalyser.fftSize = 512; // 256 频段
            this.freqData = new Uint8Array(this.audioAnalyser.frequencyBinCount);
            this.isAudioNodesReady = true;
            console.log("[Visualizer] Web Audio 实时频域分析节点初始化成功");
        } catch (e) {
            console.warn("[Visualizer] Web Audio 初始化捕获:", e.message);
        }
    }

    /**
     * 根据当前控制栏的实际全宽重新规划独立频柱
     */
    updateDimensions() {
        if (!this.container || !this.canvas) return;
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(rect.width, 300);
        this.height = Math.max(rect.height, 16);
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.canvas.width = Math.floor(this.width * this.dpr);
        this.canvas.height = Math.floor(this.height * this.dpr);

        if (this.ctx) {
            this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        }

        // 方块积木几何规格：柱宽 7.5px，间距 2.5px (每 10px 一根柱子，列数减半更清晰大气)
        // 650px 居中通栏下精确容纳 65 根宽域高精频谱柱
        const pitch = 10.0;
        const newCount = Math.max(16, Math.min(Math.floor(this.width / pitch), 90));

        if (newCount !== this.barCount) {
            this.barCount = newCount;
            this.rebuildBars(newCount);
        }

        if (!this.isRunning) {
            this.stopImmediately();
        }
    }

    /**
     * 为每一列建立完全独立的声学对数频段与物理动力学状态
     */
    rebuildBars(count) {
        this.bars = [];
        const totalBins = 256;

        for (let i = 0; i < count; i++) {
            // 对数 Mel-scale 频率映射：使每一列分配到不同的声学频段
            const startRatio = Math.pow(i / count, 2.0);
            const endRatio = Math.pow((i + 1) / count, 2.0);

            const startBin = Math.floor(startRatio * (totalBins - 4));
            const endBin = Math.max(startBin + 1, Math.floor(endRatio * (totalBins - 4)));

            // 人耳听觉等响度补偿加权（高频泛音振幅自然衰减，给予物理增益补偿）
            const normPos = i / count;
            const eqWeight = 0.85 + 1.25 * Math.pow(normPos, 1.3);

            // 每列独立的互质共振特征（用于无真实流或网络缓冲时的独立平滑保底）
            const resonanceFreq = 2.1 + (i * 0.77) % 3.7 + Math.sin(i * 12.3) * 1.1;

            this.bars.push({
                startBin,
                endBin,
                eqWeight,
                resonanceFreq,
                h: 0,
                target: 0,
                peak: 0,
                peakHold: 0,
                peakSpeed: 0,
                // 每列独立的弹跳与阻尼特征（各跳各的，参差错落）
                riseRate: 0.42 + 0.18 * ((i * 7) % 5) / 5,
                decayRate: 0.14 + 0.08 * ((i * 3) % 4) / 4
            });
        }
    }

    /**
     * 高反差互补对应色（随主题变化，但绝不与主题撞色）
     */
    updateThemeColors() {
        if (typeof window === "undefined") return;
        const styles = getComputedStyle(document.documentElement);
        const p = styles.getPropertyValue("--primary-color").trim() || "#6366f1";
        const isDark = document.body.classList.contains("dark-mode") || document.documentElement.classList.contains("dark-mode");

        const { h, s } = parseColorToHsl(p);

        // 互补对比色相：反向旋转 160°
        const compH = (h + 160) % 360;
        const compH2 = (h + 185) % 360;
        const sat = Math.max(s, 88);

        if (isDark) {
            // 深色背景下使用高通透金橙/霓虹发光色
            this.colors = {
                base: `hsl(${compH}, ${sat}%, 58%)`,
                top: `hsl(${compH2}, 100%, 72%)`,
                peak: `hsl(${compH2}, 100%, 86%)`,
                glow: `hsla(${compH2}, 100%, 70%, 0.38)`
            };
        } else {
            // 浅色背景下使用浓郁宝石色，清晰分明
            this.colors = {
                base: `hsl(${compH}, ${sat}%, 38%)`,
                top: `hsl(${compH2}, 100%, 46%)`,
                peak: `hsl(${compH2}, 100%, 28%)`,
                glow: `hsla(${compH2}, 100%, 40%, 0.25)`
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
     * 暂停或停止时立即彻底清空停止，绝无多余跳动
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

        // 强校验：暂停或播放结束瞬间静止
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

        const count = this.bars.length;
        if (count === 0) return;

        // 方块积木参数 (列数减半版：方块宽 7.5px，高 4.0px，水平间距 2.5px，垂直间隙 1.5px)
        const cubeHeight = 4.0;
        const cubeGap = 1.5;
        const cubePitch = cubeHeight + cubeGap;
        const maxH = Math.max(cubePitch * 2, h - 4);
        const maxCubes = Math.floor(maxH / cubePitch);

        const barW = 7.5;
        const colGap = 2.5;
        const totalSpectrumW = count * barW + (count - 1) * colGap;
        const startX = Math.max(0, Math.floor((w - totalSpectrumW) / 2));

        // 尝试从 Web Audio 真实获取 FFT 频域能量
        let hasRealAudio = false;
        if (this.isAudioNodesReady && this.audioAnalyser && this.freqData) {
            this.audioAnalyser.getByteFrequencyData(this.freqData);
            // 探针检测是否有非零声音信号
            for (let k = 0; k < 32; k++) {
                if (this.freqData[k] > 0) {
                    hasRealAudio = true;
                    break;
                }
            }
        }

        const ct = this.audio.currentTime || 0;

        // 渲染每一列（独立律动）
        for (let i = 0; i < count; i++) {
            const bar = this.bars[i];
            let rawEnergy = 0;

            if (hasRealAudio) {
                // 1. 真实 Web Audio API 频域映射：从分配到的独立 bin 区间求平均能量
                let sum = 0;
                let binSpan = bar.endBin - bar.startBin;
                for (let b = bar.startBin; b < bar.endBin; b++) {
                    sum += this.freqData[b] || 0;
                }
                const avg = sum / binSpan; // 0 ~ 255
                rawEnergy = (avg / 255) * bar.eqWeight;
            } else {
                // 2. 独立声学频段本征波动保底（互质频率，杜绝所有列同样跳动）
                const pulse1 = Math.sin(ct * bar.resonanceFreq + i * 1.618) * 0.5 + 0.5;
                const pulse2 = Math.cos(ct * (bar.resonanceFreq * 1.37) + i * 0.73) * 0.5 + 0.5;
                const kick = Math.pow(Math.max(0, Math.sin(ct * 2.13 * Math.PI)), 4) * Math.max(0, 1 - (i / count) * 2);
                rawEnergy = (pulse1 * 0.5 + pulse2 * 0.3 + kick * 0.6) * 0.85;
            }

            // 映射到目标像素高度 (固定饱满高度，不随音量滑块大小缩放)
            const targetHeight = Math.max(cubeHeight, Math.min(rawEnergy * maxH, maxH));
            bar.target = targetHeight;

            // 独立上升与回落阻尼
            if (bar.target > bar.h) {
                bar.h += (bar.target - bar.h) * bar.riseRate;
            } else {
                bar.h += (bar.target - bar.h) * bar.decayRate;
            }

            // 独立顶部悬停方块 (Peak Hold & Fall)
            if (bar.h >= bar.peak) {
                bar.peak = bar.h;
                bar.peakSpeed = 0;
                bar.peakHold = 4;
            } else if (bar.peakHold > 0) {
                bar.peakHold--;
            } else {
                bar.peakSpeed += 0.25;
                bar.peak = Math.max(cubeHeight, bar.peak - bar.peakSpeed);
            }

            const x = startX + i * (barW + colGap);
            const activeCubes = Math.floor(bar.h / cubePitch);

            // 绘制该列堆叠方块积木
            for (let c = 0; c < activeCubes; c++) {
                const cubeY = h - (c + 1) * cubePitch;
                const cubeRatio = c / maxCubes;

                ctx.save();
                ctx.fillStyle = cubeRatio > 0.65 ? this.colors.top : this.colors.base;
                ctx.globalAlpha = 0.88;
                this.fillRoundedRect(ctx, x, cubeY, barW, cubeHeight, 1.0);
                ctx.restore();
            }

            // 绘制该列顶部悬停峰值方块
            if (bar.peak > cubePitch * 1.5) {
                const peakCubeIdx = Math.floor(bar.peak / cubePitch);
                const peakY = h - (peakCubeIdx + 1) * cubePitch;

                ctx.save();
                ctx.fillStyle = this.colors.peak;
                ctx.shadowColor = this.colors.glow;
                ctx.shadowBlur = 3;
                ctx.globalAlpha = 0.95;
                this.fillRoundedRect(ctx, x, peakY, barW, cubeHeight, 1.0);
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
        const visualizer = new LXMusicProgressBarVisualizer(dom, state);
        window.__solaraBottomSpectrum = visualizer;
        window.musicVisualizer = visualizer;
        console.log("[Visualizer] 进度条独立频柱方块频谱引擎已就绪");
        return visualizer;
    } catch (err) {
        console.warn("[Visualizer] 进度条频谱引擎初始化异常:", err);
        return null;
    }
}
