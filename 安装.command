#!/bin/bash
# ============================================================
#  DSH (DeepSeek Harness) —— macOS 首次安装助手
#
#  为什么需要这一步：
#   本 App 没有使用 Apple 开发者账号签名（那需要 99 美元/年的账号 + 一台 Mac），
#   所以 Gatekeeper 仍会提示「无法验证开发者」；而从浏览器下载的文件还会被 Apple
#   打上隔离标记（com.apple.quarantine），首次打开会被拦下。
#   本脚本做三件事即可正常使用：
#     1) 解除下载隔离标记（quarantine）
#     2) 修复可执行权限
#     3) 校验签名；只有在签名缺失/失效时（改过包内文件、或在非 macOS 机器上组装过）
#        才用 ad-hoc（-）临时签名重新签一次
#
#  注：本发行包的 DSH.app 是在 macOS 上构建时就签好名的，第 3 步通常直接跳过。
#
#  用法：双击本文件；或在「终端」里执行  bash 安装.command
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

APP="DSH.app"

if [ ! -d "$APP" ]; then
  echo "❌ 当前目录下找不到 DSH.app，请确认压缩包已完整解压。"
  echo "   当前目录：$(pwd)"
  read -r -p "按回车键退出…" _
  exit 1
fi

echo "=============================================="
echo "  DSH 安装助手（macOS / Apple Silicon）"
echo "=============================================="
echo

echo "[1/4] 解除下载隔离标记…"
if xattr -dr com.apple.quarantine "$APP" 2>/dev/null; then
  echo "      完成"
else
  echo "      跳过（没有隔离标记，通常是从 U 盘/局域网拷贝过来的）"
fi

echo "[2/4] 修复可执行权限…"
chmod +x "$APP/Contents/MacOS/Electron" 2>/dev/null || true
chmod +x "$APP/Contents/Resources/runtime/node/bin/node" 2>/dev/null || true
# Electron Framework 的主程序（不是 .dylib，最容易漏掉）
for fw in "$APP"/Contents/Frameworks/*.framework; do
  if [ -d "$fw" ]; then
    chmod +x "$fw"/Versions/A/* 2>/dev/null || true
    chmod +x "$fw"/Versions/Current/* 2>/dev/null || true
  fi
done
# Helper（辅助进程）主程序
for h in "$APP"/Contents/Frameworks/*.app; do
  if [ -d "$h" ]; then
    chmod +x "$h"/Contents/MacOS/* 2>/dev/null || true
  fi
done
find "$APP/Contents/Frameworks" -type f -name "*.dylib" -exec chmod +x {} \; 2>/dev/null || true
find "$APP/Contents/Frameworks" -type f -name "chrome_crashpad_handler" -exec chmod +x {} \; 2>/dev/null || true
# 兜底：Frameworks 下所有没有扩展名的可执行文件（Electron Framework / ShipIt 等）
find "$APP/Contents/Frameworks" -type f ! -name "*.*" -exec chmod +x {} \; 2>/dev/null || true
echo "      完成"

echo "[3/4] 校验签名（ad-hoc，无需开发者账号）…"
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  echo "      ✅ 包内签名有效 —— 本包在 macOS 上构建时已签名，无需重新签名"
else
  echo "      签名缺失或已失效（在非 macOS 机器上组装过 / 改过包内文件）"
  echo "      正在重新签名，包体较大，预计需要 1-3 分钟，请勿关闭窗口…"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
  if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    echo "      ✅ 签名校验通过"
  else
    echo "      ⚠️  签名校验未通过（可能缺少命令行工具）。"
    echo "         仍可尝试启动；若打不开，请先安装命令行工具后重跑本脚本："
    echo "           xcode-select --install"
    codesign --verify --verbose=2 "$APP" 2>&1 | tail -3
  fi
fi

echo "[4/4] 安装位置"
printf "      把 DSH.app 复制到「应用程序」文件夹？[Y/n] "
read -r ans
case "$ans" in
  n|N)
    echo "      就地启动：$(pwd)/$APP"
    open "$APP"
    ;;
  *)
    DEST="/Applications/DSH.app"
    rm -rf "$DEST" 2>/dev/null || true
    if ditto "$APP" "$DEST" 2>/dev/null || cp -R "$APP" "$DEST" 2>/dev/null; then
      echo "      ✅ 已安装到 $DEST"
      open "$DEST"
    else
      echo "      ⚠️  复制失败（可能需要管理员权限），改为就地启动。"
      echo "         你也可以手动把 DSH.app 拖进「应用程序」。"
      open "$APP"
    fi
    ;;
esac

echo
echo "----------------------------------------------"
echo "首次启动会自动准备数据目录（约 1-2 分钟，界面顶部会显示进度），"
echo "完成后即可正常使用。数据目录："
echo "  ~/Library/Application Support/DSH"
echo "----------------------------------------------"
echo
read -r -p "按回车键关闭本窗口…" _
