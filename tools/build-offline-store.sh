#!/usr/bin/env bash
# =============================================================================
#  生成离线依赖缓存 runtime/store.tar.gz（与 Windows 便携版一致的开箱即用体验）
#
#  做三件事：
#    1) 按 main.js 期望的目录布局铺一份 scratch（app-npm / dsh-home/profiles/web /
#       plugins）—— profiles/web 里用 link:../../../plugins/... 引用本地插件，
#       所以相对层级必须一致；
#    2) 用**包内**的 node + pnpm（版本与目标机完全一致）联网把两个目录装上，
#       缓存全部落进一个全新的 store 目录；
#    3) 在一个**全新的干净副本**上用 `--offline` 复装一次做验证：
#       只有全部命中缓存、下载数为 0，才认为这份 store 真的能离线首启。
#
#  产物：runtime/store.tar.gz —— 解开后是 store/（main.js 用 tar -xzf -C SUPPORT）
# =============================================================================
set -euo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
step() { printf '%s==>%s %s\n' "$CYN" "$RST" "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '    %s!%s %s\n' "$YEL" "$RST" "$1"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
NODE="$ROOT/runtime/node/bin/node"
PNPM="$ROOT/runtime/node/node_modules/pnpm/bin/pnpm.mjs"
WORK="$ROOT/.cache/offline-work"
STORE="$WORK/store"
OUT="$ROOT/runtime/store.tar.gz"

[ -x "$NODE" ] || die "缺少包内 node：$NODE（先跑一次 tools/build-app-mac.sh 铺 runtime/）"
[ -f "$PNPM" ] || die "缺少包内 pnpm：$PNPM"

# pnpm 版本必须与目标机完全一致，否则 store 格式/索引可能不兼容
VER="$("$NODE" "$PNPM" --version)"
step "使用包内 pnpm $VER（node $("$NODE" --version)）"

# ---------------------------------------------------------------- 1) 铺布局 ---
step "1/4 按 main.js 的布局铺 scratch"
rm -rf "$WORK"
mkdir -p "$WORK/seed/dsh-home/profiles"
cp -R "$ROOT/seed/app-npm"                        "$WORK/seed/app-npm"
cp -R "$ROOT/seed/dsh-home/profiles/web"          "$WORK/seed/dsh-home/profiles/web"
cp -R "$ROOT/seed/plugins"                        "$WORK/seed/plugins"
mkdir -p "$STORE"
ok "scratch：$WORK/seed（app-npm + dsh-home/profiles/web + plugins）"

run_install() { # run_install <dir> <额外参数...>
  local dir="$1"; shift
  step "  pnpm install → $(basename "$dir")  [$*]"
  ( cd "$dir" && CI=true "$NODE" "$PNPM" install "$@" \
      --store-dir "$STORE" --reporter=append-only ) 2>&1 | sed 's/^/      /'
  return "${PIPESTATUS[0]}"
}

# -------------------------------------------------------- 2) 联网填充 store ---
step "2/4 联网安装，把依赖灌进新 store（这一步需要网络）"
run_install "$WORK/seed/app-npm"                 --force --ignore-scripts --frozen-lockfile \
  || die "核心依赖安装失败"
run_install "$WORK/seed/dsh-home/profiles/web"   --force --ignore-scripts --frozen-lockfile \
  || die "Web 插件依赖安装失败"
[ -f "$STORE/v11/index.db" ] || die "store 里没有 v11/index.db（pnpm 版本不对？）"
ok "store 已填充（$(du -sh "$STORE" | cut -f1)，$(find "$STORE" -type f | wc -l | tr -d ' ') 个文件）"

# --------------------------------------------------------- 3) 离线复装验证 ---
step "3/4 干净副本 + --offline 复装验证（模拟目标机首启）"
V="$WORK/verify"
mkdir -p "$V/dsh-home/profiles"
cp -R "$WORK/seed/app-npm"               "$V/app-npm"
cp -R "$WORK/seed/dsh-home/profiles/web" "$V/dsh-home/profiles/web"
cp -R "$WORK/seed/plugins"               "$V/plugins"
rm -rf "$V/app-npm/node_modules" "$V/dsh-home/profiles/web/node_modules"
ok "已删除 node_modules，从零开始"

verify_offline() {
  local dir="$1" label="$2"
  local logf="$WORK/offline-$label.log"
  step "  --offline 复装 → $label"
  if ( cd "$dir" && CI=true "$NODE" "$PNPM" install \
        --offline --force --ignore-scripts --frozen-lockfile \
        --store-dir "$STORE" --reporter=append-only ) >"$logf" 2>&1; then
    :
  else
    sed 's/^/      /' "$logf" | tail -30
    die "$label 离线复装失败 —— 这份 store 不足以离线首启"
  fi
  grep -E 'downloaded [0-9]+|reused [0-9]+' "$logf" | tail -3 | sed 's/^/      /' || true
  local dl; dl="$(grep -oE 'downloaded [0-9]+' "$logf" | tail -1 | grep -oE '[0-9]+' || echo '?')"
  [ "$dl" = "0" ] || warn "$label 的 downloaded 不是 0（=$dl）—— 请检查"
  local miss=0
  for p in $("$NODE" -e "const p=require('$dir/package.json');console.log(Object.keys(p.dependencies||{}).filter(n=>!n.startsWith('link:')).join(' '))"); do
    [ -f "$dir/node_modules/$p/package.json" ] || { warn "$label 缺依赖 $p"; miss=1; }
  done
  [ "$miss" = 0 ] && ok "$label 离线复装完成，依赖齐全"
}

verify_offline "$V/app-npm" "核心"
verify_offline "$V/dsh-home/profiles/web" "Web 插件"

# 顺带确认离线环境下核心入口真的存在
[ -f "$V/app-npm/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
  && ok "核心入口 bin.js 就位" || die "核心入口 bin.js 缺失"
ok "核心版本：$("$NODE" -e "console.log(require('$V/app-npm/node_modules/@deepseek-ai/dsh/package.json').version)")"

# ------------------------------------------------------------- 4) 打包 store ---
step "4/4 打包 runtime/store.tar.gz（解开为 store/，main.js 用 tar -xzf -C SUPPORT）"
rm -f "$OUT"
tar -czf "$OUT" -C "$WORK" store
[ -f "$OUT" ] || die "打包失败"
ok "store.tar.gz → $OUT（$(du -h "$OUT" | cut -f1)）"
printf '    SHA256 %s\n' "$(shasum -a 256 "$OUT" | awk '{print $1}')"

# 校验 tarball 顶层确实是 store/
TOP="$(tar -tzf "$OUT" | head -1)"
case "$TOP" in store/*) ok "tarball 顶层正确：$TOP" ;; *) die "tarball 顶层不是 store/：$TOP" ;; esac

cat <<EOF

$(printf '%s离线缓存就绪%s' "$GRN" "$RST")
  再跑一次  bash tools/build-app-mac.sh   即可把它打进 DSH.app（会自动重新签名）。
EOF
