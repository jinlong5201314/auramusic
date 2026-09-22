# 🎵 Solara 2.9 (Cloudflare Pages & Docker)

> **极简优雅、全端自适应的流媒体 Web 音乐播放器**  
> 深度移植洛雪音乐桌面端（`lx-music-desktop`）六大音源聚合搜索与歌单引擎，支持全平台官方逐句歌词、周杰伦等无版权音源全网同名高保真智能补全、酷我 VIP 语音防伪拦截，并支持 **Cloudflare Pages Serverless 边缘同构** 与 **Docker 容器化** 双端部署。

---

## ✨ 核心特性

- 🎧 **洛雪级六大音源聚合搜索**：
  - 聚合大会 (`all`)、小秋音乐 (`tx` / QQ音乐)、小芸音乐 (`wy` / 网易云)、小蜗音乐 (`kw` / 酷我)、小枸音乐 (`kg` / 酷狗)、小蜜音乐 (`mg` / 咪咕)。
  - 接入 QQ 音乐客户端动态哈希签名与咪咕 MD5 时间戳防盗链校验，突破常规 API 限制。
- 🏛️ **沉浸式歌单广场 (Square Area)**：
  - 5 大主流音乐平台精选官方分类大厅，支持全网歌单关键词检索与一键载入播放。
- 🛡️ **智能防伪拦截与全网高保真兜底**：
  - **酷我版权假音频过滤**：秒级 HEAD 探测文件体积，坚决拦截小于 400KB 的“前往官方客户端”提示音；
  - **全网跨源完整音轨自动反查**：针对网易云下架或无版权歌曲，自动全网检索同名 320k 完整音频流，确保点播 100% 顺畅发声。
- 📜 **全平台逐句歌词直连**：
  - 解决公共音乐台非网易云歌词报 400 的顽疾，直连各大官方歌词通道并采用 UTF-8 字节流解码，杜绝中文乱码。
- ☁️ **Cloudflare 边缘原生与 D1 数据库漫游**：
  - 支持绑定 Cloudflare D1 数据库，实现跨设备、跨浏览器实时同步播放进度与收藏夹。
- 📱 **移动端全景适配与 Apple 风格设计**：
  - 流畅手势上滑呼出、极光背景色彩自适应、分类矩阵抽屉与毛玻璃视觉质感。

---

## 🚀 部署指南 (Deployment Guide)

本项目支持两种主流部署方式：**Cloudflare Pages（推荐，全球边缘免费加速）** 和 **Docker（私有内网或 VPS 部署）**。

---

### 方案一：Cloudflare Pages 边缘一键部署（推荐）

#### 1. 前置准备
- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号；
- 本地安装 Node.js (>= 18) 与 npm；
- 获取 Cloudflare API Token（需拥有 `Cloudflare Pages: Edit` 与 `D1: Edit` 权限）以及你的 Account ID。

#### 2. 本地拉取代码
```bash
git clone https://github.com/jinlong5201314/solara.git
cd solara
```

#### 3. 创建 Cloudflare Pages 项目与 D1 数据库 (CLI 方式)
```bash
# 登录或导出凭据
export CLOUDFLARE_API_TOKEN="你的_Cloudflare_API_Token"
export CLOUDFLARE_ACCOUNT_ID="你的_Cloudflare_Account_ID"

# 1. 创建 Pages 项目 (名称为 solara)
npx wrangler pages project create solara --production-branch main

# 2. 创建 D1 数据库 (用于跨设备收藏与播放进度漫游)
npx wrangler d1 create solara-db
```
执行后会输出类似如下信息：
```text
database_name = "solara-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

#### 4. 在 Cloudflare Dashboard 控制台绑定 D1 与口令
打开 Cloudflare 控制台 -> **Workers 和 Pages** -> 找到 **solara** 项目 -> **设置 (Settings)**：
1. **环境变量 (Environment variables)**：
   - 生产环境中添加变量：
     - `PASSWORD`: `your_secure_password`（你自定义的访问密码，不填则公开免密访问）
2. **D1 数据库绑定 (D1 Database Bindings)**：
   - 变量名称：`DB`
   - D1 数据库：选择刚刚创建的 `solara-db`

#### 5. 执行一键构建与部署
```bash
chmod +x deploy-cf.sh
./deploy-cf.sh
```
部署完成后，控制台将输出你的生产环境网址：
`https://solara-xxx.pages.dev`

---

### 方案二：Docker 容器化部署

如果你偏好部署在本地 NAS、PVE LXC、群晖或云服务器 VPS 上，可以使用 Docker 一键启动：

#### 1. 使用 docker-compose 部署
在项目根目录下查看 `docker-compose.yml`：
```yaml
services:
  solara:
    image: ghcr.io/akudamatata/solara:latest
    container_name: solara
    restart: always
    init: true
    ports:
      - "8080:8787"
    environment:
      # 聚合音乐 API 基地址（可保持默认或替换为你的自建 API）
      - API_BASE_URL=https://music-api.gdstudio.xyz/api.php
    volumes:
      - ./data:/data
      - ./src:/app
```

#### 2. 启动容器
```bash
docker compose up -d
```
启动后直接在浏览器中打开：
`http://你的服务器IP:8080`

---

## 🛠️ 本地开发与代码结构

```text
solara/
├── src/
│   ├── functions/                 # Cloudflare Pages Functions (Serverless 边缘计算)
│   │   ├── api/
│   │   │   ├── playlist/          # 多平台分类歌单与全网歌单搜索
│   │   │   ├── search/            # 洛雪六大音源聚合搜索与签名加密
│   │   │   └── sync.ts            # D1 跨设备数据漫游同步
│   │   ├── proxy.ts               # 音频/歌词网关、体积防伪校验与同名全网兜底
│   │   └── _middleware.ts         # 单口令身份鉴权中间件
│   ├── server/                    # Node.js Express 本地同构路由
│   │   └── routes/
│   ├── js/                        # 前端播放器核心逻辑
│   ├── css/                       # 桌面与移动端 Apple 设计风格样式
│   └── index.html                 # 播放器单页应用主入口
├── docker-compose.yml             # Docker 编排配置
├── deploy-cf.sh                   # Cloudflare Pages 一键打包编译与部署脚本
└── README.md
```

---

## 📄 开源与免责声明

- 本项目遵循开源精神，仅供个人前端技术学习、Cloudflare Serverless 架构研究交流使用。
- 音乐及歌词所有版权归各大音乐平台与创作者所有，严禁将本项目用于任何商业盈利活动。
