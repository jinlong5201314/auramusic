# 🌌 AuraMusic（灵光音乐）

> **极简优雅、流体美学与智能多源容灾的现代化 Web 音乐播放平台**  
> 深度融合 **Apple Music 风格沉浸式全屏流体大字歌词**、**0 延迟切歌智能预加载**、**洛雪级自定义多音源自动容灾沙箱** 与 **全网跨源高保真音轨补全**；原生支持 **Cloudflare Pages Serverless 边缘同构** 与 **Docker 容器化** 双端部署，支持 D1 分布式数据库跨设备状态无缝漫游。

---

## 💡 致敬与灵感来源（Acknowledgements）

AuraMusic 在架构演进与功能开发过程中，深受开源社区先驱项目的启发。在此由衷感谢以下杰出项目与社区开发者：

- **[Solara](https://github.com/akudamatata/solara)**：为本项目提供了极简优雅的 Web 播放器设计理念与初始构架灵感；
- **[LX Music (洛雪音乐)](https://github.com/lyswhut/lx-music-desktop)**：为本项目提供了开放强大的第三方自定义音源脚本规范与全网音乐生态思路；
- **[GD 音乐台](https://music.gdstudio.xyz/)** 与开源音乐社区：为广大学习者提供了开放友好的 API 接口与数据检索服务。

---

## ✨ 核心特性

- 🎨 **Apple Music 风格沉浸式流体大字歌词 (P4 模块)**：
  - 点击正在播放的专辑封面、点击底栏歌词图标或**按键盘快捷键 `L`**，1 毫秒展开壁纸级全屏歌词大厅；
  - 动态提取当前歌曲封面主色谱，结合多重高斯模糊极光画布随节奏柔和弥散流动；
  - 逐句大字高亮放大、点词即播（Click-to-Seek）、5 秒防打扰智能回位，支持 F11 一键全屏（工控机/大屏视听神器）。

- ⚡ **零延迟秒播预加载 (Zero-Gap Preload)**：
  - 歌曲播放至尾段（剩余 25 秒或进度超过 85%）时，后台静音通道智能预解析下一首歌曲音频流并预热缓存；
  - 自然播完切歌或手动点击【下一曲】时，**0 毫秒零等待直接发声**，享受原生客户端般的丝滑体验。

- 🛡️ **洛雪自定义多音源自动容灾 (Auto Failover)**：
  - 支持导入多个洛雪自定义音源脚本（小枸杞、全豆要、星海等）；
  - 主音源遇到限流、网络超时或下线时，系统后台 **0.2 秒内自动无感轮询备用音源**，并动态在胶囊展示 `(自动容灾)` 状态；
  - 内置野指针与未捕获异常安全隔离网，彻底消灭控制台红色报错风暴。

- 🔍 **智能防伪拦截与全网高保真音频反查**：
  - **严密拦截假音频与试听残卷**：对 Content-Length < 2.2MB 或时长 < 45 秒的试听音频执行硬拦截，绝不下发 27 秒试听切片；
  - 遇到独家版权或未出链时，自动全网跨源反查 320k 完整音频流，确保点播 100% 顺畅。

- ☁️ **Cloudflare 边缘原生与 D1 数据库跨端漫游**：
  - 全栈代码适配 Cloudflare Pages Functions 边缘运行时；
  - 绑定 Cloudflare D1 分布式数据库，电脑、手机、工控机多端实时漫游同步播放列表、收藏夹与音源配置。

- 🏛️ **沉浸式歌单广场与随机音乐**：
  - 收录多大主流音乐平台精选官方分类大厅，支持全网歌单检索与一键载入；
  - 顶部与底栏提供 **【随机音乐】** 按钮，一键换一批推荐音乐发现宝藏好歌；
  - 提供独立显式的 **【设置】** 按钮，随时调整音质与音源管理。

---

## 🚀 部署指南 (Deployment Guide)

本项目支持两种主流部署方式：**Cloudflare Pages（推荐，全球边缘免费加速）** 和 **Docker（私有内网或 VPS 部署）**。

---

### 方案一：Cloudflare Pages 边缘一键部署（推荐）

#### 1. 本地拉取代码
```bash
git clone https://github.com/jinlong5201314/auramusic.git
cd auramusic
```

#### 2. 部署构建与发布
通过项目内置的部署脚本一键打包并发布至 Cloudflare Pages：
```bash
chmod +x deploy-cf.sh
./deploy-cf.sh
```

---

### 方案二：Docker 一键部署 (适合私有服务器 / 工控机)

在服务器上新建目录并启动 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  auramusic:
    image: node:22-alpine
    container_name: auramusic
    restart: always
    working_dir: /app
    volumes:
      - ./src:/app
      - ./data:/data
    ports:
      - "8080:8787"
    environment:
      - PASSWORD=your_secure_password_here
      - API_BASE_URL=https://music-api.gdstudio.xyz/api.php
    command: ["node", "server/index.js"]
```

运行服务：
```bash
docker compose up -d
```

---

## ⌨️ 快捷键速查

| 快捷键 | 功能说明 |
| :---: | :--- |
| **`L`** | 切换 Apple Music 风格沉浸式全屏流体大字歌词 |
| **`Space`** | 播放 / 暂停音频 |
| **`[` / `]`** | 切换上一首 / 下一首 |
| **`Esc`** | 退出全屏歌词 / 关闭搜索面板 / 关闭歌单大厅 |
| **`F11`** | 浏览器全屏显示 |

---

## 📄 免责声明

灵光音乐 (AuraMusic) 仅供个人前端工程学习、多端响应式流体视觉开发与音视频流式协议研究使用。歌曲版权归各唱片公司与音乐平台所有，请广大用户支持正版音乐。
