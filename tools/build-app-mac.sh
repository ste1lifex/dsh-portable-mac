#!/usr/bin/env bash
# =============================================================================
#  在 macOS 上从源码构建「已签名」的 DSH.app 并打包（**不需要 Node**）
#
#  与 tools/build-app.mjs 的区别：
#    · build-app.mjs  跨平台（Windows/Linux 也能跑），但产出的是**未签名**包 ——
#      换到 Mac 上必然报「已损坏」，必须在 Mac 上再跑一次 tools/fix-and-sign.sh
#    · 本脚本        只在 macOS 上跑，用系统自带的 ditto / codesign / tar / curl，
#      一步产出 **ad-hoc 已签名**的 dist/DSH-mac-arm64.zip（拿到即可拖进「应用程序」）
#
#  用法：
#    bash tools/build-app-mac.sh                 # 缺什么下载什么（Electron/Node/pnpm，约 180MB）
#    bash tools/build-app-mac.sh --no-sign       # 只组装，不签名
#    DSH_SIGN_IDENTITY="Developer ID Application: X (TEAMID)" bash tools/build-app-mac.sh
#    ELECTRON_ZIP=~/electron-v44.3.0-darwin-arm64.zip bash tools/build-app-mac.sh   # 用本地 Electron
#    NODE_DIR=~/dsh-mac/node bash tools/build-app-mac.sh                            # 用本地 darwin node
#
#  产物：
#    dist/DSH.app                     已签名（ad-hoc）的 App
#    dist/DSH-mac-arm64.zip           含 DSH.app + 安装.command + 使用说明.md + 首次运行必读.txt
#    runtime/store.tar.gz（可选）     若你把它放进 runtime/，会被一起打进去（离线首启）
# =============================================================================
set -euo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
step() { printf '%s==>%s %s\n' "$CYN" "$RST" "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '    %s!%s %s\n' "$YEL" "$RST" "$1"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "本脚本只在 macOS 上运行（Windows/Linux 请用 node tools/build-app.mjs，并在 Mac 上用 tools/fix-and-sign.sh 补签名）"
for t in curl tar ditto codesign; do command -v "$t" >/dev/null 2>&1 || die "缺少系统命令：$t"; done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
CACHE="$ROOT/.cache"
RUNTIME="$ROOT/runtime"
DIST="$ROOT/dist"
STAGE="$CACHE/stage"

SIGN=1
for a in "$@"; do case "$a" in --no-sign) SIGN=0 ;; -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac; done

# ------------------------------------------------------------------ 版本 ---
VJSON="$HERE/versions.json"
[ -f "$VJSON" ] || die "缺 $VJSON"
jget() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$VJSON" | head -1; }
ELECTRON_V="$(jget electron)"; NODE_V="$(jget node)"; PNPM_V="$(jget pnpm)"; DSH_V="$(jget dshVersion)"
[ -n "$ELECTRON_V" ] && [ -n "$NODE_V" ] && [ -n "$PNPM_V" ] || die "解析 versions.json 失败"
step "构建 DSH.app（Electron $ELECTRON_V / Node $NODE_V / pnpm $PNPM_V / DSH $DSH_V）"

mkdir -p "$CACHE" "$RUNTIME" "$DIST"
fetch() { # fetch <url> <dest> [最小字节数]
  local url="$1" dest="$2" min="${3:-1024}"
  if [ -f "$dest" ] && [ "$(wc -c < "$dest" | tr -d ' ')" -ge "$min" ]; then
    ok "已缓存 $(basename "$dest")（$(du -h "$dest" | cut -f1)）"; return 0
  fi
  step "下载 $(basename "$dest")"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$url" || die "下载失败：$url"
  [ "$(wc -c < "$dest.part" | tr -d ' ')" -ge "$min" ] || die "下载内容过小：$url"
  mv "$dest.part" "$dest"
  ok "$(du -h "$dest" | cut -f1) → $dest"
}

# ------------------------------------------------------------- 1) 运行时 ---
step "1/5 准备运行时（node + pnpm + seed）"
NODE_BIN="$RUNTIME/node/bin/node"
if [ -x "$NODE_BIN" ] && [ "$(wc -c < "$NODE_BIN" | tr -d ' ')" -gt 30000000 ]; then
  ok "node 已就绪（$(du -h "$NODE_BIN" | cut -f1)）"
elif [ -n "${NODE_DIR:-}" ]; then
  [ -f "$NODE_DIR/bin/node" ] || die "NODE_DIR 下找不到 bin/node：$NODE_DIR"
  mkdir -p "$(dirname "$NODE_BIN")"; cp "$NODE_DIR/bin/node" "$NODE_BIN"; chmod 755 "$NODE_BIN"
  ok "用本地 node → $NODE_BIN"
else
  TGZ="$CACHE/node-v$NODE_V-darwin-arm64.tar.gz"
  fetch "https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-darwin-arm64.tar.gz" "$TGZ" 20000000
  step "解压 node"
  rm -rf "$CACHE/node-extract"; mkdir -p "$CACHE/node-extract"
  tar -xzf "$TGZ" -C "$CACHE/node-extract" "node-v$NODE_V-darwin-arm64/bin/node"
  mkdir -p "$(dirname "$NODE_BIN")"
  cp "$CACHE/node-extract/node-v$NODE_V-darwin-arm64/bin/node" "$NODE_BIN"
  chmod 755 "$NODE_BIN"
  rm -rf "$CACHE/node-extract"
  ok "node → $NODE_BIN（$(du -h "$NODE_BIN" | cut -f1)）"
fi

PNPM_CLI="$RUNTIME/node/node_modules/pnpm/bin/pnpm.mjs"
if [ -f "$PNPM_CLI" ]; then
  ok "pnpm 已就绪"
else
  PTGZ="$CACHE/pnpm-$PNPM_V.tgz"
  fetch "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_V.tgz" "$PTGZ" 102400
  step "解压 pnpm"
  rm -rf "$CACHE/pnpm-extract"; mkdir -p "$CACHE/pnpm-extract"
  tar -xzf "$PTGZ" -C "$CACHE/pnpm-extract"
  [ -d "$CACHE/pnpm-extract/package" ] || die "pnpm tarball 结构异常"
  rm -rf "$RUNTIME/node/node_modules/pnpm"
  mkdir -p "$RUNTIME/node/node_modules"
  cp -R "$CACHE/pnpm-extract/package" "$RUNTIME/node/node_modules/pnpm"
  rm -rf "$CACHE/pnpm-extract"
  [ -f "$PNPM_CLI" ] || [ -f "$RUNTIME/node/node_modules/pnpm/bin/pnpm.cjs" ] || die "pnpm 入口缺失"
  chmod 755 "$PNPM_CLI" 2>/dev/null || true
  ok "pnpm → $PNPM_CLI"
fi

[ -d "$ROOT/seed" ] || die "缺 seed/ 目录"
rm -rf "$RUNTIME/seed"; mkdir -p "$RUNTIME/seed"
cp -R "$ROOT/seed/." "$RUNTIME/seed/"
ok "seed → runtime/seed（$(find "$RUNTIME/seed" -type f | wc -l | tr -d ' ') 个文件）"
if [ -f "$RUNTIME/store.tar.gz" ]; then
  ok "检测到离线缓存 store.tar.gz（$(du -h "$RUNTIME/store.tar.gz" | cut -f1)），会一起打进包"
else
  warn "没有 runtime/store.tar.gz → 目标机首次启动需联网安装依赖"
fi

# ------------------------------------------------------------- 2) Electron -
step "2/5 解出 Electron 并改名 DSH.app"
if [ -n "${ELECTRON_ZIP:-}" ]; then
  EZIP="$ELECTRON_ZIP"; [ -f "$EZIP" ] || die "ELECTRON_ZIP 不存在：$EZIP"
  ok "用本地 Electron：$EZIP"
else
  EZIP="$CACHE/electron-v$ELECTRON_V-darwin-arm64.zip"
  fetch "https://github.com/electron/electron/releases/download/v$ELECTRON_V/electron-v$ELECTRON_V-darwin-arm64.zip" "$EZIP" 50000000
fi
rm -rf "$CACHE/electron-extract" "$DIST/DSH.app"
mkdir -p "$CACHE/electron-extract"
ditto -x -k "$EZIP" "$CACHE/electron-extract"          # ditto 会保留符号链接
[ -d "$CACHE/electron-extract/Electron.app" ] || die "Electron zip 里没有 Electron.app"
mv "$CACHE/electron-extract/Electron.app" "$DIST/DSH.app"
APP="$DIST/DSH.app"
rm -rf "$APP/Contents/_CodeSignature"                   # 旧签名作废，稍后重签
rm -f "$APP/Contents/Resources/default_app.asar"
ok "DSH.app 就位（$(du -sh "$APP" | cut -f1)）"

# --------------------------------------------------------------- 3) 覆盖层 -
step "3/5 叠加壳代码 / 图标 / Info.plist / 运行时"
[ -f "$ROOT/src/Info.plist" ] || die "缺 src/Info.plist"
[ -d "$ROOT/src/app" ] || die "缺 src/app"
[ -f "$ROOT/src/DSH.icns" ] || die "缺 src/DSH.icns"
cp "$ROOT/src/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/src/DSH.icns" "$APP/Contents/Resources/DSH.icns"
rm -rf "$APP/Contents/Resources/app"
cp -R "$ROOT/src/app" "$APP/Contents/Resources/app"
rm -rf "$APP/Contents/Resources/runtime"
cp -R "$RUNTIME" "$APP/Contents/Resources/runtime"
mkdir -p "$APP/Contents/Resources/electron-licenses"
for f in LICENSE LICENSES.chromium.html version; do
  if [ -f "$CACHE/electron-extract/$f" ]; then mv "$CACHE/electron-extract/$f" "$APP/Contents/Resources/electron-licenses/$f"; fi
done
chmod 755 "$APP/Contents/Resources/runtime/node/bin/node"
ok "覆盖完成"

# ------------------------------------------------------- 4) 打包暂存目录 -
step "4/5 组装备用文件（安装.command / 使用说明.md / 首次运行必读.txt）"
rm -rf "$STAGE"; mkdir -p "$STAGE"
mv "$APP" "$STAGE/DSH.app"; APP="$STAGE/DSH.app"
for f in "安装.command" "使用说明.md" "首次运行必读.txt"; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/$f"
done
chmod 755 "$STAGE/安装.command" 2>/dev/null || true
ok "暂存目录：$STAGE"

# ------------------------------------------------------------- 5) 签名+打包
if [ "$SIGN" = "1" ]; then
  step "5/5 签名（ad-hoc，1–3 分钟）并打包"
  DSH_NO_QUARANTINE=1 bash "$HERE/fix-and-sign.sh" "$APP"
  codesign --verify --deep --strict "$APP" || die "签名校验未通过"
else
  step "5/5 跳过签名（--no-sign）并打包"
  warn "未签名的包换到别的机器上会报「已损坏」，需要时在 Mac 上跑 tools/fix-and-sign.sh"
fi

OUT="$DIST/DSH-mac-arm64.zip"
rm -f "$OUT"
( cd "$STAGE" && ditto -c -k --sequesterRsrc . "$OUT" )   # 保留符号链接与权限位
ok "zip → $OUT（$(du -h "$OUT" | cut -f1)）"
printf '    SHA256 %s\n' "$(shasum -a 256 "$OUT" | awk '{print $1}')"

cat <<EOF

$(printf '%s构建完成%s' "$GRN" "$RST")
  App：$APP
  zip：$OUT

本机试跑：open "$APP"
安装到系统：ditto "$APP" /Applications/DSH.app
把 zip 发给别人 / 传到 Release：用上面那行 SHA256 做校验值即可。
EOF
