#!/usr/bin/env bash
set -e

echo "=== 🚀 开始打包并部署 Solara 到 Cloudflare Pages ==="

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/src" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
BUILD_TMP="/tmp/solara-cf-build"

# 如果外部已提供环境变量则直接使用，否则尝试从常用凭证路径加载
if [ -z "$CLOUDFLARE_API_TOKEN" ] && [ -f "$HOME/.hermes/cf-token.txt" ]; then
    export CLOUDFLARE_API_TOKEN="$(cat "$HOME/.hermes/cf-token.txt")"
fi

if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    export CLOUDFLARE_ACCOUNT_ID="cdc2e56aa9c052f22a9bd82c7b61d3ba"
fi

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "❌ 错误：未设置 CLOUDFLARE_API_TOKEN 环境变量"
    echo "请执行：export CLOUDFLARE_API_TOKEN=\"your_token\""
    exit 1
fi

PROJECT_NAME="${CLOUDFLARE_PROJECT_NAME:-solara}"
BRANCH_NAME="${CLOUDFLARE_BRANCH:-main}"

# 1. 准备目录
rm -rf "$DIST_DIR" "$BUILD_TMP"
mkdir -p "$DIST_DIR" "$BUILD_TMP"

# 2. 拷贝核心前端静态资源
echo "📦 正在收集静态资源..."
cp "$SRC_DIR/index.html" "$DIST_DIR/"
cp "$SRC_DIR/login.html" "$DIST_DIR/"
cp "$SRC_DIR/favicon.svg" "$DIST_DIR/" 2>/dev/null || true
cp "$SRC_DIR/favicon.png" "$DIST_DIR/" 2>/dev/null || true
cp -r "$SRC_DIR/css" "$DIST_DIR/"
cp -r "$SRC_DIR/js" "$DIST_DIR/"

# 3. 编译 Cloudflare Pages Functions
echo "⚙️ 正在编译 Cloudflare Functions..."
cd "$SRC_DIR"
npx wrangler pages functions build \
    --outdir "$BUILD_TMP" \
    --output-routes-path "$BUILD_TMP/_routes.json"

# 4. 植入 _worker.js 与 _routes.json
cp "$BUILD_TMP/index.js" "$DIST_DIR/_worker.js"
if [ -f "$BUILD_TMP/_routes.json" ]; then
    cp "$BUILD_TMP/_routes.json" "$DIST_DIR/_routes.json"
fi

# 5. 上传部署到 Cloudflare Pages
echo "☁️ 正在上传部署至 Cloudflare Pages (project: $PROJECT_NAME, branch: $BRANCH_NAME)..."
npx wrangler pages deploy "$DIST_DIR" \
    --project-name "$PROJECT_NAME" \
    --branch "$BRANCH_NAME" \
    --commit-message "Deploy Solara with full multi-source music engine"

echo "=== ✅ Solara 部署成功！==="
