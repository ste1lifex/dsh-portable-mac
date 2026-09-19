# macOS 端操作手册（给 Mac 上的 agent / 维护者）

本仓库的 Windows/Linux 侧只能组装出**未签名**的 `DSH.app`（`codesign` 是 macOS 独有工具），
拿这样的包在 Mac 上双击必然报「已损坏」。**所有与签名有关的事都在 Mac 上做**，
本文件就是那份操作清单 —— 全部是纯 `bash` + 系统命令，**不需要装 Node**。

> App 未做 Apple 开发者签名（需要 99 美元/年账号 + 公证）。我们用的是 **ad-hoc 临时签名**
> （`codesign -s -`）：只在本机有效，但足以消除「已损坏」，且不需要任何账号。

> **正式发行包（v0.1.5-rc.2 起）就是这么产出的**：`bash tools/build-app-mac.sh` 在 Mac 上
> 构建 + ad-hoc 签名 + `codesign --verify --deep --strict` 校验，并内置
> `runtime/store.tar.gz` 离线依赖缓存（首启全程不联网）。签名在 `ditto` 打包/解压后依然有效。

---

## 症状 → 原因 → 动作

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| 双击 `DSH.app`：「已损坏，无法打开」 | 包内签名失效（在 Windows 上构建/改过包内文件）**且/或**带下载隔离标记 | `bash tools/fix-and-sign.sh /Applications/DSH.app` |
| 双击 `DSH.app`：「无法验证开发者」 | 签名有效（ad-hoc）但未公证，被 Gatekeeper 拦 | 右键 App →「打开」→「打开」；或先跑上面的脚本（会解隔离） |
| 双击 `安装.command` 没反应/被拦 | 脚本带隔离标记，LaunchServices 拒绝执行未验证的可执行脚本 | `bash 安装.command`（终端里用 bash 跑不经过验证） |
| 自己改了 `src/app/*`、图标、seed 后包打不开 | 包内容变化 → 签名失配 | 重新 `bash tools/fix-and-sign.sh <app>` |

**`.dmg` 不解决任何一条**：dmg 只是分发外壳，里面还是同一个 App，隔离标记照样带、
签名照样失配。别往这个方向做。

---

## 三种常用操作

### A. 修好一个已经下载/已有的 App（最常见）

```bash
# 自动找 DSH.app（当前目录 / dist/ / 上一级 / ~/Downloads / /Applications）
bash tools/fix-and-sign.sh

# 指定路径 + 顺手装到 /Applications
bash tools/fix-and-sign.sh ~/Downloads/DSH.app --reinstall

# 顺便重新打成 zip（ditto，保留符号链接与权限位）
DSH_REZIP=1 bash tools/fix-and-sign.sh DSH.app
```

脚本做的事：解除 `com.apple.quarantine` → 修可执行权限 → `codesign --force --deep --sign -`
→ `codesign --verify --deep --strict` 校验 → 打印 Gatekeeper 判定 →（可选）ditto 重新打包。
预期结果：`codesign --verify` 通过；`spctl` 对 ad-hoc 包显示 `rejected`（**这是正常的**，
第一次启动用右键「打开」放行即可）。

### B. 从源码构建一个「构建时就已签名」的包

```bash
bash tools/build-app-mac.sh                  # 缺什么自动下载（Electron/Node/pnpm ≈ 180MB）
bash tools/build-app-mac.sh --no-sign        # 只组装不签名
ELECTRON_ZIP=~/electron-v44.3.0-darwin-arm64.zip NODE_DIR=~/dsh-mac/node \
  bash tools/build-app-mac.sh                # 离线：复用本地已有的 Electron 与 darwin node
```

产物：`dist/DSH.app`（已签名）+ `dist/DSH-mac-arm64.zip`（含 `安装.command`、
`使用说明.md`、`首次运行必读.txt`）+ SHA256。它用的是系统自带 `ditto`/`codesign`/`tar`/`curl`，
所以**不需要 Node**；跨平台的 `tools/build-app.mjs` 仍可用于 Windows/Linux（产出未签名包）。

> 想彻底离线：把 `store.tar.gz` 放到 `runtime/` 再构建，它会被一起打进包，
> 目标机首次启动就从包内离线重建依赖（Windows 版发布包就是这么做的）。
> 生成它用下一节 B2 的脚本。

### B2. 生成 / 刷新离线依赖缓存（开箱即用的关键）

```bash
bash tools/build-offline-store.sh          # 用包内 node+pnpm 生成 runtime/store.tar.gz
bash tools/build-app-mac.sh                # 再构建一次，缓存会被打进 DSH.app
```

脚本做的事：按 `main.js` 期望的布局铺 scratch（`app-npm` / `dsh-home/profiles/web` /
`plugins`，因为 web profile 用 `link:../../../plugins/...`，相对层级必须一致）→
用**包内**的 pnpm（版本必须与目标机一致）联网把两个目录装进一个全新 store →
在一个**干净副本**上 `--offline` 复装自检 → `tar -czf runtime/store.tar.gz -C <work> store`。

自检通过的标准是核心与 Web 插件都 **`downloaded 0`**（全部命中缓存）。当前缓存约 320MB。

> 改了 `seed/app-npm/package.json`、`seed/dsh-home/profiles/web/package.json` 或锁文件后，
> **必须重新生成 store**，否则目标机离线复装会缺包并退回联网。

### C. 修复 `dsh` 仓库里那份现成的 `macos/DSH.app` 并提交

局域网 Gitea 仓库里的 `dsh/macos/DSH.app` 是**手动组装**的成品包（不是本仓库构建产物）。
在 Windows 上改过包内文件后（例如换图标、改 `main.js`），它的签名同样失效，需要在 Mac 上：

```bash
cd <你的 dsh 仓库>/macos
bash fix-and-sign.sh DSH.app                 # 该目录下也有这份脚本的副本
codesign --verify --deep --strict DSH.app    # 应通过
git add DSH.app/Contents/_CodeSignature DSH.app/Contents/MacOS/Electron
git commit -m "chore(mac): 换图标/改壳代码后重新 ad-hoc 签名"
git push
```

注意 `macos/.gitattributes` 里 `DSH.app/** -text -diff`：整包按字节存储，
提交后**不要再让任何工具重写包内文件**，否则签名又会失配。

---

## 验证清单（Mac 上跑一遍再发）

```bash
bash -n tools/fix-and-sign.sh tools/build-app-mac.sh tools/build-offline-store.sh  # 语法
codesign --verify --deep --strict --verbose=2 DSH.app   # 期望：valid on disk / satisfies its Designated Requirement
codesign -dv --verbose=4 DSH.app 2>&1 | head -20        # 看 Signature=adhoc、Identifier
spctl -a -vvv DSH.app                                   # ad-hoc 期望：rejected（正常）
# 解压后确认符号链接还在（14 个）：先解压 zip，再
find DSH.app -type l | wc -l
# 试跑
open DSH.app
```

从 zip 里解出来的目录里，`安装.command` **必须是可执行的**（`-rwxr-xr-x`）。
若不可执行：`chmod +x 安装.command`（仓库里该文件已标记 +x，见 `git ls-files -s`）。

**离线首启验证（发版必做）**：在干净副本 + **故意把 registry 指向不可达地址**的前提下启动，
证明真的没有走网络：

```bash
TEST=$(mktemp -d); rm -rf "$TEST"; mkdir -p "$TEST"
ditto -x -k dist/DSH-mac-arm64.zip /tmp/dsh-check      # 模拟用户解压
env DSH_SUPPORT_DIR="$TEST" DSH_PORT=3199 \
    NPM_CONFIG_REGISTRY=http://127.0.0.1:1 npm_config_registry=http://127.0.0.1:1 \
    /tmp/dsh-check/DSH.app/Contents/MacOS/Electron &
# 等 1-2 分钟，然后检查：
grep -aE "reused [0-9]+, downloaded [0-9]+" "$TEST/logs/dsh-web.out.log"   # 期望 downloaded 0
grep -a "依赖就绪" "$TEST/logs/dsh-web.out.log"                           # 期望 核心版本 0.1.5-rc.2
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3199/"          # 期望 401（认证生效）
```

---

## 发布（把签好的 zip 传上去）

```bash
shasum -a 256 dist/DSH-mac-arm64.zip
# 用 gh（推荐）
gh release upload v0.1.5-rc.2 dist/DSH-mac-arm64.zip --repo <owner>/dsh-portable-mac --clobber
# 或网页：Releases → 该 tag → Edit → 上传资产（旧的同名资产先删）
```

没有 `gh` 时用 REST API（asset 名冲突会返回 422，所以先改名或删掉旧资产；
上传走 `uploads.github.com`，实测 481MB 上传中途中断会留下 `starter` 状态的半成品，直接 DELETE 掉重来）：

```bash
TOK=<PAT>
RID=$(curl -sS -H "Authorization: Bearer $TOK" \
  https://api.github.com/repos/<owner>/dsh-portable-mac/releases/tags/v0.1.5-rc.2 | jq -r .id)
curl -sS -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/zip" \
  --data-binary @dist/DSH-mac-arm64.zip \
  "https://uploads.github.com/repos/<owner>/dsh-portable-mac/releases/$RID/assets?name=DSH-portable-0.1.5-rc.2-mac-arm64.zip"
```

传完把新的 SHA256 同步进 Release 说明、`README.md` / `使用说明.md` / `首次运行必读.txt`
里引用的文件名与体积（后两者在 zip 内，**必须重新构建再上传**才生效）。

---

## 常见坑

1. **`codesign --deep` 的顺序**：Electron 包里有 14 个符号链接、4 个 helper `.app`
   （GPU / Plugin / Renderer / 主 helper）、框架与 crashpad handler。
   `--deep` 会按正确顺序逐个签，**不要**手工只签主程序。
2. **`xattr -dr` 要在签名之前**：先清隔离再签名，否则可能带着旧属性被 Gatekeeper 记住。
3. **改包内任何文件都会让签名失效**，包括 `Contents/Resources/app/main.js`、
   `DSH.icns`、`dock-*.png`、`runtime/seed/**`。
4. **别用 `zip` 压 App**：会用 0 字节占位符替换符号链接，解出来就是坏包。
   用 `ditto -c -k --sequesterRsrc`（本仓库脚本已经这么做了）。
5. **`spctl` 显示 rejected 不是错误** —— 那是「未公证」的意思，ad-hoc 签名必然如此。
   用户首次启动用右键「打开」即可；要彻底消除只能买开发者账号做正式签名 + 公证。
6. **升级时「双击没反应」＝单实例锁，不是签名问题**。`src/app/main.js` 用了
   `app.requestSingleInstanceLock()`，而锁是按 **userData 目录**算的 —— 本 App 把
   userData 固定成 `~/Library/Application Support/DSH/electron`，所以**任何位置的两份
   `DSH.app` 共用同一把锁**。旧副本还在跑时，新版一启动就拿不到锁并
   `app.quit()`（**零输出、无弹窗**），用户只会看到「什么都没发生」。

   排查：
   ```bash
   ls -l ~/Library/Application\ Support/DSH/electron/SingletonLock   # → MacBookAir.lan-<pid>
   pgrep -fl "DSH.app/Contents/MacOS/Electron"                        # 正在跑的那份的完整路径
   ```
   处理：**先彻底退出旧实例，再打开新版**；长期方案是只保留一份 `DSH.app`。

   验证某份包本身是否正常（绕开锁，用独立数据目录跑）：
   ```bash
   DSH_SUPPORT_DIR=$(mktemp -d) DSH_PORT=3499 DSH.app/Contents/MacOS/Electron
   ```

   > 发版前建议实测一次：**不要**在旧实例还跑着的时候验证新包，否则会误判成签名问题。
