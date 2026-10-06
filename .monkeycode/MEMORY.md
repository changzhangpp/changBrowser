# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### Project Knowledge Entry
[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.

## Entries

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: Deploying and modifying OpenBrowser (Electron 指纹浏览器) in this workspace
- Category: Operations & Deployment
- Instructions:
  - OpenBrowser 拒绝以 root 运行（run-app.js 与 main.js 双重检查），必须用 `setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/home/openbrowser USER=openbrowser LOGNAME=openbrowser` 启动
  - 图形环境：Xvfb :99（-ac 关闭访问控制）常驻后台终端；Electron 需 `ELECTRON_DISABLE_SANDBOX=1`，缺库时安装 libasound2 等桌面库
  - 端口约定：Local API 50325（api-key 认证）、桌面启动页 50326（token 认证）、Web 控制台 50327、opsbox 8002（仅回环，经控制台 /opsbox/ 反代）
  - 控制台与 opsbox 登录口令从 `<userData>/console-password.txt` 读取（env CONSOLE_PASSWORD / OPS_PASSWORD 可覆盖），不写入仓库
  - uid 1000 数据目录：/home/openbrowser/.config/openbrowser/（local-api-key.txt、console/ 配置、logs/ 守护日志）
  - 临时 uid 1000 的文件输出目录用 /tmp/obshots（chown 1000:1000），/tmp/opencode 归 root 不可写

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: Building and verifying the webconsole feature
- Category: Build Methods & Testing Methods
- Instructions:
  - 依赖安装：`cd Browserapp && npm ci --include=dev`，Electron 二进制需单独执行 `node node_modules/desktop-shell/install.js`（包名是 desktop-shell 别名，无 electron/install.js）
  - Linux 内核下载：`npm run prepare:linux-kernel`（Chrome Stable 154 → kernels/chrome-stable/）
  - 控制台自测：`npm run selftest:webconsole`；仓库自带大量 selftest:* 脚本
  - 实例启动耗时约 10-20s，Local API browser/start 需 90s 超时（webconsole 已内置）
  - UI 截图验证：`node_modules/desktop-shell/dist/electron /tmp/opencode/console-shot.js <url> <out.png> <w> <h> [token]`（离屏 capturePage，DISPLAY=:99）

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: Troubleshooting viewer screenshot failures and Electron SIGTRAP crashes during verification
- Category: Troubleshooting & Debugging & Environment Configuration
- Instructions:
  - 宿主内存气球可能膨胀到只剩 ~200MB 可用（ps 汇总 RSS 仅 ~1.7GB 但 free 显示 used ~6.8GB）：此时新启 Electron（SIGTRAP）或新开 CDP 标签页（Render process gone）都会 OOM 崩溃，与代码无关
  - 低内存下的验证方法：不要新开渲染进程，用 `/json/list` 找 env-001 现有 page 目标，CDP `Page.navigate` 到被测页面（旧页释放、渲染进程复用），验证完导航回原 URL；参考 /tmp/opencode/cdp-shot2.js（零依赖 WS 客户端 + Page.captureScreenshot）
  - X :99 截屏命令只有 `import`（ImageMagick），无 xdotool/xwininfo；root 层截屏会拍到最顶层窗口，Electron 窗口需 setAlwaysOnTop 但低内存时 Electron 本身起不来
  - 排查"画面不显示"类问题时先比对 DOM 状态与视觉层：用 bootJs 覆盖层（绿色 pre 写内部状态到页面）+ X import 同帧抓屏可裁决"DOM 对但显示错"（CSS 缺失类）与"DOM 就错"（JS 逻辑）两类问题

[Project Knowledge Summary]
- Date: 2026-10-04
- Context: 第六轮反馈排查「连接已断开/CDP未连接」根因
- Category: Troubleshooting & Debugging
- Instructions:
  - 平台边缘代理会掐断空闲 WSS：CDP screencast 静态页不发帧即全静默，数十秒后被断开。凡经预览域名的 WS 必须做应用层心跳（12s ping/pong）+ 服务端 WS ping + 客户端自动重连
  - opsbox 以 root 运行（uvicorn 直启）才能写 /proc/sys/vm/drop_caches 做内存清理；进程白名单按 cmdline 特征 + /proc/pid/cwd 判定
  - 实例进程名映射：Electron 主进程/子进程 cmdline 的 --user-data-dir 尾段即实例 id（browser-profiles-v2/<id>）
  - 浏览器窗口可经 Browser.getWindowForTarget/setWindowBounds（浏览器级 WS）实时调尺寸；窗口可大于 Xvfb 屏面

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 用户要求实例后台永不掉线，新增 keeper 守护
- Category: Operations & Deployment
- Instructions:
  - keeper.js（term_20 常驻 root）守护全链路：Xvfb/桌面客户端/webconsole/opsbox 死后自动拉起，期望存活实例（console/keeper-state.json）死亡 15s 内复活
  - 服务重启顺序依赖：Xvfb → 桌面客户端(Local API 50325) → 其余；客户端启动命令 node scripts/run-app.js（setpriv uid1000 + DISPLAY=:99 + ELECTRON_DISABLE_SANDBOX=1）
  - Local API 进程在但无响应连续 3 次（45s）判定卡死强杀重启；实例重启失败 60s 冷却防打爆
  - guard 保护性停止的实例 keeper 不复活（keeperMark 移除）；自测需设 KEEPER_MARK_DISABLE=1 防污染真实状态文件

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 用户运营商网络拦截 WSS 升级，画面通道需要 HTTP 兜底
- Category: Environment Configuration
- Instructions:
  - 部分运营商/预览网关会拦截 WSS 升级（HTTP 正常但 WS 建不起来）：查看器已内置 HTTP 兼容模式，WS 失败 2 次自动降级为 1s 轮询截图 + REST 指令（/api/cast/shot、/api/cast/cmd），每 15s 试探 WSS 自动切回
  - keeper 会自动拉起被杀的控制台（15s 内），重启控制台只需 pkill 进程，无需手动重启

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 排查 viewer 无帧（enable ack 正常但收不到 screencastFrame）
- Category: Troubleshooting & Debugging
- Instructions:
  - Electron 实例窗口被遮挡时 Chromium 停止 screencast 推帧（CalculateNativeWinOcclusion），表现为连接正常但永远没画面；已加 disable-features 修复
  - viewer 连接时 server 会自动 /json/activate 置前目标 target
  - 同一 target 的 CDP page-level 连接被半开残留占用时，新连接升级成功但消息全部被拒/挂死；server 端已做同 target 互斥（新连接踢旧）
  - 排障口诀：无帧先查窗口是否被遮挡/最小化，再查半开残留连接（ss -tnp 看 CDP 端口 ESTAB）

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 将当前程序推送至用户 GitHub 公共仓库 changBrowser
- Category: Operations & Deployment / Workflow & Collaboration
- Instructions:
  - 代码托管于 https://github.com/changzhangpp/changBrowser（public，默认 main），remote 名 `changbrowser`
  - GitHub 凭证：用户 PAT 写入 /root/.git-credentials，`git config --global credential.helper store`（常规 git 命令免密）
  - 本地 /workspace/OpenBrowser 是上游仓库的浅克隆（--depth 1），直接 push 会报 `did not receive expected object`；推送当前程序用 orphan 快照：`git checkout --orphan <b> && git add -A && git commit && git push <b>:main`
  - push 必须临时重置凭证助手（默认 agent 助手返回 500）：`git -c credential.helper= -c "credential.helper=store --file=/root/.git-credentials" push --force changbrowser <b>:main`；禁止把令牌嵌进 URL（会随 git 错误输出泄漏）；大仓库推送偶发 TLS 断连，重试并用 `ls-remote` 核对远端 main 哈希
  - 控制台/opsbox 口令不再硬编码：优先 env CONSOLE_PASSWORD/OPS_PASSWORD，其次 `<userData>/console-password.txt`（本地已写入真实口令，登录行为不变）
- .gitignore 排除 Browserapp/kernels/chrome-stable（437M 下载内核）及 **/.secret、**/console-password.txt、**/local-api-key.txt

[Project Knowledge Summary]
- Date: 2026-10-06
- Context: 为 changBrowser README 拍摄真实页面截图（控制台/opsbox/画面通道）
- Category: Build Methods / Troubleshooting & Debugging
- Instructions:
  - 低内存截图方法（比 Electron 离屏更轻，不需 X）：用 kernels/chrome-stable 的 chrome `--headless=new --no-sandbox --remote-debugging-port=<p> --user-data-dir=/tmp/...`，CDP `Runtime.evaluate` 写 `localStorage.console_token`（控制台）或 `localStorage.ops_token`（opsbox）后 reload，再 `Page.captureScreenshot`
  - 控制台登录 POST /api/console/login {password}；opsbox 登录 POST /api/login {password}（同一口令 console-password.txt）
  - opsbox init() 启动缺陷已修复（2026-10-06）：原带 token 启动时不调 resStart()，资源页停留占位符「—」；现 init 无条件 `switchTab(t0, true)`，由 switchTab 统一 `resRefresh()+resStart()`（opsbox/index.html 每次请求重读，改完即生效，无需重启）
  - 画面通道截图：POST /api/console/profiles/<id>/targets {action:'new',url} 开临时标签 → 前端 openViewer(id) 后 click `.tab[data-id]` → 截图 → {action:'close',targetId} 还原；实例内容有隐私风险时用公开页面做临时标签

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 实现窗口级定时刷新与查看器倒计时
- Category: Troubleshooting & Debugging / Workflow & Collaboration
- Instructions:
  - 刷新配置层级：`configs[profileId].windows[targetId]` 优先，未配置窗口继承实例级 `intervalSec/scope/enabled`
  - targets API 会返回窗口刷新来源、间隔、上次刷新和 `nextFireAt`；前端每秒本地倒计时，并通过 4 秒 targets 轮询校准
  - 真实刷新由服务端 Refresher 通过 CDP `Page.reload` 执行，与查看器页面是否打开无关；连续失败 3 次按实例熔断

[Project Knowledge Summary]
- Date: 2026-10-05
- Context: 排查实例 3 进程存活但前台无法连接
- Category: Troubleshooting & Debugging
- Instructions:
   - 实例进程和 CDP 端口都存在时，仍需请求 `/json/version` 验证 CDP 是否真正响应；监听端口可能处于卡死状态
   - keeper 已增加每个期望存活实例的 CDP 健康检查；连续 3 次无响应会通过 Local API 定向停止并重启该实例
   - 页面级 JS 卡死（如抖音 oauth 页渲染进程 CPU 空转）CDP 端口仍正常响应，端口探测发现不了；webconsole 渲染看门狗每 30s 用 Runtime.evaluate 探测各页面，探测失败先 unpauseTarget 原地解冻；连续失败只记日志（hang-detected），**绝不关页重建**（用户要求登录流程不可打断，selftest 断言无 /json/close 与 /json/new）
   - 抖音 oauth 等风控页存在不确定反自动化行为：裸内核（无扩展无指纹参数）也复现加载后 ~20s 整页冻结（渲染暂停 CPU 0、evaluate 超时）或崩溃（/json/list 中 url 为空）；触发条件页面侧随机
   - 内存假设已被 cgroup A/B 实验否定：同实例同页面 memory.max 600M 与放开两组行为完全一致、无 OOM 事件；服务器内存本为动态分配（总 8G 按需），`free` 的 available 不代表真实约束
   - 冻结取证已上线：看门狗第 1/2 次探测失败时自动采集全部相关进程的 /proc state/wchan/cpuTicks 写入 logs/freeze-forensics.log；实例启动参数支持 OPENBROWSER_NETLOG=1 写 netlog（keeper 已透传，客户端重启后生效）
   - **2026-10-05 事故复盘（登录被杀真凶）**：webconsole/guard.js 默认 rssLimitMb=1536，登录流程（GitHub/抖音 OAuth 多标签）轻松超限 → guard 每 40-80s 强停实例 → keeper 拉起 → 再杀，形成杀-复活死循环。已放宽为应急刹车（RSS 4096MB / CPU 98%×900s，guard-config.json 持久化），正常运行上限由 keeper 内存守护（单实例 2.5G 持续 45s + 总量 7G）承担
   - 抖音 oauth 冻结取证结论：渲染进程 busy-spin 死循环（/proc state=R、wchan=0、约 50% 单核持续烧 CPU），随后目标崩溃（/json/list url=""）；Debugger 暂停假说与内存不足假说均被证据排除
   - 查看器工具栏新增「刷新此页」按钮（reload-target 接口）：先 Page.reload，冻结/崩溃目标自动按上次已知 URL navigate 兜底（OAuth state 参数保留，流程可续）；仅用户手动触发，服务端绝不主动杀页
   - 排查方法论：先读全部证据链（console-ops.log、guard events API、freeze-forensics.log、keeper 日志）对齐时间戳找真凶，再动手改代码；勿在未证实根因前加新防护层
   - 深层防御已实装：所有控制台发起的页面级 CDP 会话（ws-bridge/castSession/reloadTarget）打开即发 Debugger.enable + setSkipAllPauses(true)；看门狗探测失败先 unpauseTarget（enable+skip+resume）原地解冻保登录态，救不活才关页重建（hang-unpaused/hang-recovery 日志）
   - 查看器看门狗区分"链路死"与"页面静"：watch 定时器发 Runtime.evaluate 探活（lastCdp），只有帧和 CDP 双双超时才断连重连，静态页面不再循环断开
   - keeper 自动纳管所有在运行实例（含桌面客户端启动的），写入 keeper-state.json；控制台 stop 会显式置 false 不复活
   - 实例卡片已有启动/停止按钮；stop 后 keeper 不再拉起，等用户手动 start
