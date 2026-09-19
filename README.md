# DSH Portable · macOS (Apple Silicon)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 **macOS 桌面版**：
一个内嵌 Electron + WebView 的原生窗口，把 DSH 界面装进 `DSH.app`，
**拖进「应用程序」即装即用**（无需安装 Node / Python / Xcode）。

> **English TL;DR** — A self-contained macOS (arm64) desktop shell for DeepSeek Harness.
> This repository holds the *sources*: the Electron shell (`src/app`), the app metadata
> (`src/Info.plist`, `src/DSH.icns`), the initial data (`seed/`) and the packaging toolchain
> (`tools/`) which downloads Electron and Node from their **official** sources and produces
> `dist/DSH-mac-arm64.zip` containing a drag-and-drop `DSH.app`.
> The prebuilt `DSH.app` zip (481 MB, **offline-capable**) is published as a **GitHub Release asset** (too large for the repo:
> GitHub caps single files at 100 MB and the app ships a 116 MB Node binary + Electron + a 320 MB offline store).
> MIT licensed; DSH itself is MIT by DeepSeek.

---

## 用法一：下载现成包（推荐给最终用户）

> ### ✅ 现在的发行包是**在 macOS 上构建并签名**的（不再需要你手动补签名）
> 旧的 Windows 组装包签名失效，双击必然报「已损坏」。现在这个包由
> `tools/build-app-mac.sh` 在 Mac 上 **构建 → ad-hoc 签名 → `codesign --verify` 校验通过**，
> 签名在 `ditto` 打包/解压后依然有效；并且**内置离线依赖缓存**，首启全程不联网。
>
> 你仍可能被拦一次：浏览器下载会给文件打上隔离标记（`com.apple.quarantine`），
> 首次打开提示「Apple 无法验证」（这是未公证提示，不是包损坏）。放行任选其一：
>
> ```bash
> cd ~/Downloads/你的解压目录
> xattr -dr com.apple.quarantine . && open DSH.app   # 解隔离后直接打开
> bash 安装.command                                   # 或：解隔离 → 修权限 → 校验签名 → 安装
> ```
>
> **`.dmg` 不解决这个问题**（dmg 里还是同一个 App）。
> macOS 侧的完整操作手册（含从源码构建已签名包、重新生成离线缓存、
> 修 Gitea 里 `macos/DSH.app` 的签名、验证清单、发布步骤）：[`tools/README-mac.md`](tools/README-mac.md)。

1. 打开本仓库的 **Releases**，下载 `DSH-portable-0.1.5-rc.2-mac-arm64.zip`（约 481MB，**内置离线依赖缓存**）。
2. 解压得到 `DSH.app`，**直接拖进「应用程序」**（或任意目录）。
3. 第一次启动**建议先跑一次 `安装.command`**：它会解除下载隔离标记、修好可执行权限、
   **校验签名（本包已签名，通常直接跳过重签）**，然后可选择把 App 装进「应用程序」并启动。
   > 不想跑脚本也行：右键 `DSH.app` →「打开」→「打开」；正常发行包不会提示「已损坏」，
   > 真出现了才需要补一次 `codesign --force --deep --sign - DSH.app`。
4. 首次启动会在 `~/Library/Application Support/DSH/` 展开初始数据，并从**包内离线缓存**
   重建依赖 —— **全程不需要联网**（约 1–2 分钟；顶部控制条会显示进度）。

细节见 [`使用说明.md`](使用说明.md)；完全不熟悉命令行的用户请看
[`首次运行必读.txt`](首次运行必读.txt)（含「终端怎么打开」逐步教程）。

---

## ⚠️ 升级前必读：先退出旧版，否则新版「双击没反应」

两份 DSH 共用同一个数据目录，**同一时间只允许一个 DSH 在运行**
（`src/app/main.js` 的 `app.requestSingleInstanceLock()`）。旧版还在跑时，
双击新版 `DSH.app` 会**静默退出** —— 不弹窗、不报错、什么都不发生。

```bash
pgrep -fl "DSH.app/Contents/MacOS/Electron"   # 有任何输出 = 还有 DSH 在跑
```

退出旧版：DSH 窗口里按 `Command + Q`，或菜单栏「DSH」→「退出 DSH」，
或活动监视器里搜 `DSH` 强制退出。确认退干净后再打开新版。

- **数据不会丢**：会话/设置/凭证都在 `~/Library/Application Support/DSH/dsh-home/`，新旧版共用；
- **建议只保留一份 `DSH.app`**：桌面/下载/应用程序各留一份会互相抢锁，
  症状是「有时能打开、有时没反应」。

> **v0.1.5-rc.2（本版资产）起，抢锁失败会弹出说明框**，并直接列出正在运行的那份
> `DSH.app` 的路径与 PID，不会再「双击没反应」。旧资产没这个提示，仍需按上面的步骤手动退出旧版。

## 用法二：自己构建（推荐给开发者）

**在 macOS 上（推荐，一步产出已签名包，不需要 Node）：**

```bash
bash tools/build-offline-store.sh    # 可选：生成并自检离线依赖缓存 runtime/store.tar.gz
bash tools/build-app-mac.sh          # 组装 + ad-hoc 签名 + ditto 打包 → dist/DSH-mac-arm64.zip
```

**跨平台（Windows/Linux 也能跑，产出未签名包，需要在 Mac 上补签）：**

只需要 **Node 18+** 和系统自带的 `tar`（Windows 上用 Git Bash / 自带 bsdtar 均可）：

```bash
node tools/build-app.mjs
```

它会：

1. 从**官方源**下载并缓存：
   - Electron → `https://github.com/electron/electron/releases`（约 124MB）
   - Node（darwin-arm64，只取 `bin/node`）→ `https://nodejs.org/dist/`
   - pnpm（纯 JS）→ `https://registry.npmjs.org/`
2. 把 `seed/` 复制成 `runtime/seed/`；
3. 组装 `DSH.app`（保留 Electron 内部的 14 个符号链接）并打包 → `dist/DSH-mac-arm64.zip`。

离线 / 复用本地已有的二进制：

```bash
node tools/build-app.mjs --electron-zip /path/electron-v44.3.0-darwin-arm64.zip \
                         --node-dir /path/to/darwin-arm64-node   # 含 bin/node
node tools/build-app.mjs --skip-fetch                            # 完全用 .cache/ 与 runtime/
```

想要**离线首启**（把 pnpm 离线缓存一起打进包 —— 正式发行包就是这么做的）：

```bash
bash tools/build-offline-store.sh    # macOS：用包内 node+pnpm 生成 runtime/store.tar.gz
bash tools/build-app-mac.sh          # 再构建一次，store.tar.gz 会自动打进 DSH.app
```

`build-offline-store.sh` 会在一个干净副本上用 `--offline` 复装自检：
只有核心与 Web 插件都 `downloaded 0`（全部命中缓存）才算通过。
跨平台构建则手工把 `store.tar.gz` 放到 `runtime/` 下，再
`node tools/build-app.mjs --skip-fetch`。

版本单一数据源在 [`tools/versions.json`](tools/versions.json)（Electron / Node / pnpm / DSH）。

---

## 目录结构

```
dsh-portable-mac/
├─ src/
│  ├─ app/                  Electron 壳（主进程 main.js、preload.js、控制条 toolbar/、启动页）
│  ├─ Info.plist            应用描述（名称 / 图标 / 版本 / 最低系统 macOS 11）
│  └─ DSH.icns              应用图标（角色图，16@2x…512@2x 共 8 档）
├─ seed/                    首次启动展开到 ~/Library/Application Support/DSH/ 的初始数据
│  ├─ app-npm/              核心清单 + 锁文件（@deepseek-ai/dsh）
│  ├─ dsh-home/             设置 / 补丁 / profiles（web 与 headless）/ 预设
│  ├─ plugins/              本地插件源码（dsh-endfield-boot、dsh-pet-perlica）
│  ├─ plugin-track.json     版本面板与自动升级用的追踪清单
│  └─ .env.example          API Key 模板
├─ tools/
│  ├─ build-app-mac.sh      macOS 一键构建（组装 + ad-hoc 签名 + ditto 打包）★ 正式发行用
│  ├─ build-offline-store.sh 生成并自检离线依赖缓存 runtime/store.tar.gz
│  ├─ build-app.mjs         跨平台构建（取运行时 → 组装 → 打包；产出**未签名**包）
│  ├─ fix-and-sign.sh       修复/重签已有的 DSH.app（解隔离 → 修权限 → 深签 → 校验）
│  ├─ fetch-runtime.mjs     官方源下载 Electron/Node/pnpm + 铺 runtime/ + seed
│  ├─ assemble.mjs          组装 DSH.app 并打成保留符号链接的 zip
│  ├─ ziputil.mjs           极简 ZIP 读写（支持 Unix 符号链接与权限位）
│  └─ versions.json         版本单一数据源
├─ 安装.command             解隔离 → 修权限 → 校验签名 → 可选装进「应用程序」
└─ 使用说明.md              最终用户文档（安装 / 首次启动 / 认证地址 / 排错）
```

## 控制条（顶部）

| 区域 | 说明 |
| --- | --- |
| 最左 | 服务状态（dot + 文案）。**不重复品牌字标** —— 品牌由网页侧栏与 Dock 图标承担 |
| 按钮 | 启动 / 停止 / 重启 │ 刷新界面 / 浏览器打开 / 日志 / 版本信息（窄窗口自动收成图标） |
| 最右 | **DeepSeek 官方账户余额**（悬停看赠送/充值明细，点击刷新，每 5 分钟自动刷新） |

- **主题跟随**：控制条与启动页跟着内嵌界面一起浅色/深色（网页端按系统或
  `ui-theme.preference` 变色时同步换色，连设计令牌都一起读）；**Dock 图标**也随
  macOS 外观在深/浅两版之间切换。
- **版本信息窗口**（820×680，独立窗口；菜单栏「DSH → 版本信息…」也能开）：
  桌面外壳 / 核心版本、插件、端口、数据目录、数据根目录、错误日志末尾
  （可滚动、可选中复制，另有「复制全部」）。
  > 早先版本把它做成控制条里的 `<dialog>`，而控制条只有 46px 高，`dialog` 的
  > UA 默认样式 `max-height: calc(100% - 6px - 2em)` 算下来只剩约 8px，
  > 内容全被压没了 —— 现已改为独立窗口。
- 按钮是 8px 圆角、深色用抬升底色不描边 —— 与 Windows 版和网页端同一套观感。

## 数据放在哪

| 内容 | 位置 |
| --- | --- |
| 会话 / 设置 / 凭证 / 插件配置 | `~/Library/Application Support/DSH/dsh-home/` |
| 离线依赖缓存（构建时可选） | App 包内 `DSH.app/Contents/Resources/runtime/store.tar.gz` → 首启展开到 `.../DSH/store/` |
| 日志 | `~/Library/Application Support/DSH/logs/` |
| 只读运行时（Node、初始数据） | App 包内 `DSH.app/Contents/Resources/runtime/` |

备份只需备份 `~/Library/Application Support/DSH/dsh-home/`。

## 安全

- 仓库**不含**任何 API Key、凭证、聊天记录、附件（`seed/` 已剔除；`.gitignore` 兜底）。
- App 未做 Apple 开发者签名（需要 99 美元/年账号 + 一台 Mac）。发行包**在 macOS 上构建时
  就做了 ad-hoc 签名**，足以保证包未损坏、本机正常使用；想彻底消除「无法验证开发者」
  警告只能买账号做正式签名 + 公证。
- 默认权限预设 `danger-full-access`（agent 可直接执行命令）；如需收紧请改
  `dsh-home/settings.yaml` 的 `permission.defaultPreset`。

## 许可证

本仓库以 **MIT** 发布（见 [`LICENSE`](LICENSE)）；构建产物内含的第三方组件见 [`NOTICE`](NOTICE)。
DSH 本体与随包插件遵循各自许可证 ——
上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 为 MIT。
构建产物内含 Electron 与 Node.js（均为 MIT，第三方许可随包于
`DSH.app/Contents/Resources/electron-licenses/`）。
