# 🌌 AuraMusic（灵光音乐）项目工程归档手册 (Project Archive & Handoff)

> **归档日期**：2026年9月26日  
> **当前版本**：v4.2.2 (自定义音源实时体检与死节点熔断容灾加固版)  
> **归档定位**：本项目已完成从原版 Solara 的彻底脱胎重构、洛雪生态移植、多源容灾、自建歌单与 D1 云端持久化，正式进入稳定维护与阶段性归档状态。本文件为后续继续推进、交接或多 Agent 协同提供唯一的工程事实基准。

---

## 📌 一、核心资产与访问句柄 (Handles & Endpoints)

| 资产类型 | 句柄 / 路径 / 标识 | 说明 |
| :--- | :--- | :--- |
| **本地源码目录** | `/opt/solara` | 本机长期正式工作目录，保留完整 git 仓库 |
| **GitHub 仓库** | `https://github.com/jinlong5201314/auramusic.git` | 主分支 `main`，由 gh CLI 认证同步 |
| **生产访问域名** | `https://music.28687844.xyz/` | Cloudflare Pages + 边缘 Anycast CDN 加速 |
| **Pages 内部域名** | `https://solara-fyv.pages.dev` | 部署项目名：`solara` |
| **内网测试服务** | `http://192.168.123.105:8080/` | Docker 容器 `solara` 映射运行 |
| **云端数据库** | Cloudflare D1 Database (`DB`) | 绑定至 Pages Functions，持久化歌单、收藏与音源配置 |
| **全量快照归档** | `/mnt/myfile/backups/auramusic/` 及 `/root/backups/auramusic/` | 本地与 R2 云对象存储双重冷备 |

---

## 🛠️ 二、系统架构与核心文件索引 (Architecture Map)

```
/opt/solara/
├── deploy-cf.sh                  # 生产一键打包与部署脚本 (Wrangler Functions 编译 + Pages 部署)
├── docker-compose.yml            # 本地容器编排配置
├── Dockerfile                    # 本地 Node/Express 镜像构建配置
├── README.md                     # 开源项目用户手册与详细部署指南
├── PROJECT_ARCHIVE.md            # [本文档] 核心技术机密、架构细节与归档备忘
├── dist/                         # 编译产物目录（包含 _worker.js 与静态文件）
└── src/                          # 核心源码目录
    ├── index.html                # 主舞台骨架、播放器底栏、抽屉容器、全局弹窗
    ├── login.html                # 密码鉴权登录页 (Pages PASSWORD 保护)
    ├── css/
    │   ├── style.css             # 桌面端全局样式入口
    │   ├── mobile.css            # 移动端样式聚合入口
    │   ├── components/
    │   │   ├── player-stage.css  # 播放器核心底栏、操作槽与单曲刷新动画
    │   │   └── ...
    │   └── mobile/
    │       ├── sheet.css         # 移动端底部自适应抽屉与三 Tab 胶囊
    │       └── stage.css         # 移动端播放条与触控微动效
    ├── js/
    │   ├── app.js                # 全局中枢、事件调度、生命周期装配与单曲清理事件分发
    │   ├── dom.js                # DOM 元素缓存字典 (严格规范管理)
    │   ├── state.js              # 全局响应式状态树
    │   ├── constants.js          # API 地址、存储 Key 与枚举常量
    │   ├── mobile.js             # 移动端手势、抽屉弹出控制中枢
    │   ├── core/
    │   │   ├── audio.js          # 音频引擎、多源解析瀑布流、防假音频过滤、D1直链写入/清理
    │   │   ├── source-plugin.js  # 洛雪自定义音源 JavaScript 沙箱引擎、多源容灾调度
    │   │   └── storage.js        # LocalStorage 与 Cloudflare D1 边缘存储双向同步桥
    │   └── features/
    │       ├── custom-playlists.js # 自建歌单增删改查、加歌弹窗、D1 漫游与详情页
    │       ├── favorites.js      # 收藏夹列表、D1 持久化、单曲重刷
    │       ├── playlist.js       # 当前待播队列、切歌、高亮、单曲重刷
    │       ├── square.js         # 四大平台（QQ/网易/酷我/酷狗）分类歌单广场
    │       └── lyrics.js         # Apple Music 风格沉浸式流体歌词与主色拾取
    └── functions/api/            # Cloudflare Pages 边缘 Functions
        ├── _middleware.ts        # 全站密码校验中间件 (PASSWORD 变量)
        ├── proxy.ts              # 跨域音频/歌词边缘代理网关
        └── storage.ts            # D1 数据库增删改查 REST API
```

---

## 💡 三、核心技术实现与避坑经验 (Hard Lessons Learned)

### 1. 洛雪音源插件沙箱与多源容灾 (Source Plugin Sandbox)
- **原理**：将第三方洛雪自定义音源脚本（如星海源、QDY 全豆要等）在隔离上下文中执行，模拟标准 `lx` 运行时。
- **容灾机制**：当激活的主音源因网络波动或接口下线报错时，系统在 200ms 内静默轮询备用音源（Fallback Waterfall），界面状态胶囊自动标识为 `(自动容灾)`，消灭控制台报错风暴。

### 2. 酷我防盗链假音频硬拦截 (Anti-Fake Audio)
- **技术陷阱**：酷我部分收费歌曲官方接口会返回一段约 2.2MB、时长 27 秒的版权语音文件（“请到酷我官方听歌”），而非真实歌曲。
- **解决方案**：在 `audio.js` 中加入了二进制头校验与特征拦截，对命中假音频特征的响应直接判定为失败，顺延降级到网易云/聚合备用源全网反查。

### 3. Cloudflare D1 音频直链缓存与容量安全 (D1 AudioUrl Cache)
- **机制**：收藏夹与自建歌单中成功播放的有效直链直接回写 D1 数据库，二次点播 0ms 秒开。
- **配额评估**：10,000 首歌曲直链仅占 D1 约 5MB（免费额度 5GB，占比 0.1%）；全天切歌 500 次仅占写入配额 0.5%（免费额度 10 万次/天），无需担心超标。

### 4. 移动端加载与抽屉弹出陷阱 (Mobile View Architecture)
- **教训**：切勿在条件加载器中出现变量拼写差异（如 `__SOLARA_IS_MOBILE__` vs `__SOLARA_IS_MOBILE`），必须做多重 UA、屏幕宽度与全局变量的复合判定；
- **事件冒泡**：所有列表操作按钮（收藏、加歌单、清理缓存、下载、删除）必须严格调用 `e.stopPropagation()`，避免事件冒泡至全局点击监听器误关抽屉。

### 5. 单曲颗粒度缓存靶向清理与重获取 (v4.2.0)
- **场景**：外部音源经常换域或失效，若歌曲锁定了旧失效直链会导致播放卡顿。
- **设计**：在底栏当前播放行、收藏夹、播放列表及自建歌单中均部署【旋转刷新】按钮。点击后精准移除该歌曲在内存短期字典、本地列表、自建歌单及 D1 数据库中的 `audioUrl`，并立即无缓存重新发起全网/洛雪源重抓，体验无缝丝滑。

### 6. 自定义音源实时测速体检与死节点熔断 (v4.2.2)
- **实时探测与测速**：在沙箱中新增两阶段探测引擎（`probeSource` 与 `probeAllSources`），支持模拟真实曲目出链验证并返回网络时延毫秒数；
- **死节点黑名单**：拦截 `music-dl.sayqz.com`（TLS 异常）、`88.lxmusic.xn--fiqs8s`（443 阻断）及返回报错 JSON 的失效 php 域名；
- **熔断与快跳**：单源连续失败 2 次自动进入 3 分钟熔断冷却，切歌时 0ms 瞬间跳过冷却源，保障切歌无卡顿；
- **脚本内存缓存**：增加 `scriptCache` 缓存已下载的音源脚本代码，避免容灾切源时重复发生网络请求。

---

## 🚀 四、后续启动与日常运维指南 (Operations Guide)

### 1. 本地开发与内网测试
```bash
cd /opt/solara

# 修改代码后重启本地 Docker 容器热更
docker restart solara

# 验证内网访问
curl -sI http://127.0.0.1:8080/
```

### 2. 发布上线至 Cloudflare Pages 生产环境
```bash
cd /opt/solara

# 执行一键部署脚本 (自动收集静态资源、编译 Functions 并上传)
./deploy-cf.sh

# 检查线上生产状态
curl -sI https://music.28687844.xyz/
```

### 3. 同步至 GitHub 开源仓库
```bash
cd /opt/solara
git add -A
git commit -m "feat/fix: your commit message"
git push origin main
```

---

## 🔮 五、未来优化方向储备 (Future Roadmap)

如未来重新启动项目迭代，可优先考虑以下方向：
1. **歌单死链后台静默巡检**：定时或打开歌单时，通过 HEAD 探针轻量检测直链有效性，失效自动触发后台重定向；
2. **PWA 离线播放支持**：引入 ServiceWorker，将用户收藏的喜爱歌曲缓存至 CacheStorage，无网络亦可离线畅听；
3. **音效均衡器与沉浸混响**：基于 Web Audio API 扩展多段 EQ 与空间混响音效调节；
4. **洛雪歌单 URL 订阅直连**：支持直接输入洛雪分享链接或在线歌单订阅地址一键自动同步。
