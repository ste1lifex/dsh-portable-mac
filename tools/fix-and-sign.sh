#!/usr/bin/env bash
# =============================================================================
#  DSH.app 修复 / 重签名（**只能在 macOS 上运行**）
#
#  解决两个最常见的问题：
#    1) 从浏览器下载的 DSH.app 双击提示「已损坏，无法打开」或「无法验证开发者」
#    2) 你自己（或 CI）改过 App 包内的文件（壳代码 main.js、DSH.icns、dock-*.png、
#       seed、runtime…）之后签名失配
#
#  原理：本 App 没有 Apple 开发者签名（需要 99 美元/年账号 + 一台 Mac 做公证），
#  只能用 **ad-hoc 临时签名**（codesign -s -）。而 codesign 是 macOS 独有工具，
#  在 Windows 上改包内文件（例如在 Windows 上构建/改图标）就会让签名失配 —— 那个
#  包换到 Mac 上必然报「已损坏」，必须在本机重新签一次。
#
#  用法：
#    bash tools/fix-and-sign.sh                     # 自动找 DSH.app（当前目录 / dist/ / 上一级）
#    bash tools/fix-and-sign.sh /Applications/DSH.app
#    bash tools/fix-and-sign.sh ~/Downloads/DSH.app --reinstall   # 顺手覆盖安装到 /Applications
#    DSH_REZIP=1        bash tools/fix-and-sign.sh DSH.app        # 重新打成 zip（ditto，保留符号链接）
#    DSH_NO_QUARANTINE=1 bash tools/fix-and-sign.sh DSH.app       # 跳过解隔离（本来就拷来的）
#    DSH_SIGN_IDENTITY="Developer ID Application: X (TEAMID)" \
#      bash tools/fix-and-sign.sh DSH.app                         # 有正式证书时用它（可公证）
# =============================================================================
set -euo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
step() { printf '%s==>%s %s\n' "$CYN" "$RST" "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '    %s!%s %s\n' "$YEL" "$RST" "$1"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 平台检查 ---
if [ "$(uname -s)" != "Darwin" ]; then
  die "本脚本只能在 macOS 上运行（当前：$(uname -s)）。Windows/Linux 上没有 codesign，请在 Mac 上执行。"
fi
command -v codesign >/dev/null 2>&1 || die "找不到 codesign，请确认这是正常的 macOS 环境。"

# ---------------------------------------------------------------- 参数解析 ---
APP=""
REINSTALL=0
for a in "$@"; do
  case "$a" in
    --reinstall) REINSTALL=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) [ -z "$APP" ] && APP="$a" ;;
  esac
done

# ------------------------------------------------------------ 定位 DSH.app ---
if [ -z "$APP" ]; then
  for cand in "./DSH.app" "./dist/DSH.app" "../DSH.app" "$HOME/Downloads/DSH.app" "/Applications/DSH.app"; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
  done
fi
[ -n "$APP" ] || die "没找到 DSH.app。请把路径传进来： bash tools/fix-and-sign.sh /path/to/DSH.app"
[ -d "$APP" ] || die "不是目录：$APP"
case "$APP" in *.app) ;; *) die "路径看起来不是 .app 包：$APP" ;; esac
APP="$(cd "$(dirname "$APP")" && pwd -P)/$(basename "$APP")"

step "目标 App：$APP"
[ -f "$APP/Contents/Info.plist" ] || die "不像 macOS App 包（缺 Contents/Info.plist）"
[ -x "$APP/Contents/MacOS/Electron" ] || [ -f "$APP/Contents/MacOS/Electron" ] || die "缺 Contents/MacOS/Electron"
ok "包结构正常（$(plutil -extract CFBundleName raw "$APP/Contents/Info.plist" 2>/dev/null || echo DSH)）"
printf '    版本：%s\n' "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo '?')"

# --------------------------------------------------------- 1) 解除隔离标记 ---
if [ "${DSH_NO_QUARANTINE:-0}" = "1" ]; then
  step "跳过解隔离（DSH_NO_QUARANTINE=1）"
else
  step "1/5 解除下载隔离标记（com.apple.quarantine）"
  if xattr "$APP" 2>/dev/null | grep -q '^com.apple.quarantine$'; then
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
    ok "已清除隔离标记"
  else
    warn "没有隔离标记（通常是从 U 盘/局域网拷来的），跳过"
  fi
fi

# ------------------------------------------------------------ 2) 修权限位 ---
step "2/5 修复可执行权限"
chmod +x "$APP/Contents/MacOS/Electron" 2>/dev/null || true
chmod +x "$APP/Contents/Resources/runtime/node/bin/node" 2>/dev/null || true
# Electron Framework 的主程序（不是 .dylib，最容易漏）
for fw in "$APP"/Contents/Frameworks/*.framework; do
  [ -d "$fw" ] || continue
  chmod +x "$fw"/Versions/A/* 2>/dev/null || true
  chmod +x "$fw"/Versions/Current/* 2>/dev/null || true
done
# Helper（辅助进程）主程序
for h in "$APP"/Contents/Frameworks/*.app; do
  [ -d "$h" ] || continue
  chmod +x "$h"/Contents/MacOS/* 2>/dev/null || true
done
find "$APP/Contents/Frameworks" -type f -name "*.dylib" -exec chmod +x {} \; 2>/dev/null || true
find "$APP/Contents/Frameworks" -type f -name "chrome_crashpad_handler" -exec chmod +x {} \; 2>/dev/null || true
find "$APP/Contents/Frameworks" -type f ! -name "*.*" -exec chmod +x {} \; 2>/dev/null || true
ok "权限就绪"

# ------------------------------------------------------------ 3) 签名 ------
IDENTITY="${DSH_SIGN_IDENTITY:--}"
if [ "$IDENTITY" = "-" ]; then
  step "3/5 ad-hoc 临时签名（无需开发者账号；包较大，1–3 分钟）"
else
  step "3/5 用证书签名：$IDENTITY"
fi
rm -rf "$APP/Contents/_CodeSignature" 2>/dev/null || true
codesign --force --deep --sign "$IDENTITY" "$APP" || die "签名失败（可先看上面输出；缺命令行工具时执行 xcode-select --install）"
ok "签名完成"

# ------------------------------------------------------------ 4) 校验 ------
step "4/5 校验签名"
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'; then
  ok "codesign --verify 通过"
else
  die "签名校验未通过 —— 上面那几行说明了哪个嵌套组件有问题（可用 DSH_SIGN_IDENTITY 指定证书重试）"
fi
# Gatekeeper 视角（ad-hoc 一定显示 rejected，这是预期的）
printf '    Gatekeeper 判定（ad-hoc 显示 rejected 属于预期）：\n'
spctl -a -vvv "$APP" 2>&1 | sed 's/^/      /' || true

# ------------------------------------------------------------ 5) 重打包 ----
if [ "${DSH_REZIP:-0}" = "1" ]; then
  step "5/5 重新打包 zip（ditto，保留符号链接与权限位）"
  OUT="$(dirname "$APP")/DSH-mac-arm64.zip"
  rm -f "$OUT"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"
  ok "已生成 $OUT（$(du -h "$OUT" | cut -f1)）"
  printf '    SHA256 %s\n' "$(shasum -a 256 "$OUT" | awk '{print $1}')"
else
  step "5/5 跳过重打包（需要时加 DSH_REZIP=1）"
fi

# ------------------------------------------------------------ 安装位置 ----
if [ "$REINSTALL" = "1" ]; then
  step "额外：安装到 /Applications"
  DEST="/Applications/DSH.app"
  rm -rf "$DEST" 2>/dev/null || true
  if ditto "$APP" "$DEST" 2>/dev/null; then
    ok "已安装到 $DEST"
    APP="$DEST"
  else
    warn "复制失败（可能需要管理员权限）；也可以手动把 DSH.app 拖进「应用程序」"
  fi
fi

cat <<EOF

$(printf '%s完成%s' "$GRN" "$RST")

现在可以正常启动了：
  open "$APP"

说明：
  · 本 App 是 **ad-hoc 签名**（没有 Apple 开发者账号做公证），首次启动若仍被拦，
    右键 App →「打开」→ 再点「打开」即可；或在 系统设置 → 隐私与安全性 里点「仍要打开」。
  · **每次**从浏览器下载/解压出新副本，或改过包内文件，都要重新跑一次本脚本。
  · Windows 上构建出来的包一定需要这一步（Windows 没有 codesign）。
  · 打 .dmg 没用：隔离标记与签名问题是 dmg 里那同一个 App 的问题，换壳不解决。
EOF
