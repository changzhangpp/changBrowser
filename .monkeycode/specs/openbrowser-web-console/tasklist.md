# 实施任务清单：openbrowser-web-console

- [x] 1. 需求文档与技术设计（requirements.md / design.md）
- [x] 2. 随机指纹生成模块 `webconsole/fingerprint.js` + 单测
- [x] 3. 资源守护模块 `webconsole/guard.js`（/proc 采样、规则、JSONL 日志、自动终止）+ 单测
- [x] 4. 定时刷新模块 `webconsole/refresher.js`（CDP 刷新、活动标签、失败熔断）+ 单测
- [x] 5. 控制台服务 `webconsole/server.js`（登录、聚合 API、Local API 转发、opsbox 反代）+ 单测
- [x] 6. Web UI `webconsole/public/index.html`（实例列表/详情/编辑/随机指纹/刷新配置/守护事件，移动端适配）
- [x] 7. opsbox vendored 到 `opsbox/` 并接入运行（资源管理、文件管理、图片预览）
- [x] 8. 启动接线（package.json 脚本、与 OpenBrowser 客户端联调）
- [x] 9. 整体验证 + 移动端视口截图 + 部署预览

## 验证记录（2026-10-04）

- `npm run selftest:webconsole` 全部通过（指纹一致性 x50、守护三规则、刷新熔断、登录限流、代理透传）
- 真实链路：env-001 实例启动（Chrome 154 内核, CDP 36829）→ 守护采样 RSS/进程数 → 60s 活动标签刷新循环无错误
- opsbox 经 `/opsbox/` 反代登录、文件列表、图片预览正常
- 桌面 1280x800 与移动 375x812 视口截图核对通过

## 追加修复（2026-10-04 下午）

- 修复实时浏览器查看器画面不显示：重写 UI 时遗漏全局 `.hidden{display:none!important}` 规则，
  "正在连接实例..."提示层（绝对定位、不透明背景）一直盖在画面上。
  DOM 状态（imgs=1、hint 已带 hidden 类、帧到达）自始正确，仅 CSS 缺失。一行修复。
- 端到端视觉验证：复用 env-001 现有标签页经 CDP 导航到控制台并触发 openViewer，
  screencast 帧成功渲染（自递归镜像画面即证明管线全通），hint 消失。
- 移除 server.js WS 桥临时埋点日志（cdp-upgrade/cdp-client-msg/cdp-bridge-error），桥接错误改为关闭客户端。
- 自测 8 组全部重跑通过；控制台服务已以清理后代码重启（term_15，HOME=/home/openbrowser）。
- 环境备注：本时段宿主内存气球膨胀致可用内存 ~200MB，新开 Chromium/Electron 渲染进程均 OOM 崩溃
  （SIGTRAP / Render process gone），与代码无关；验证需复用已有渲染进程。

## 移动端重构 + 登录持久化（2026-10-04 晚，用户反馈驱动）

用户三点反馈：每次进页面要输口令；移动端字大块大、缺导入导出/运维管理；画面可看不可调。修复：

- 登录持久化：token 存 localStorage（原 sessionStorage 手机端易丢），有效期 7→30 天，
  prompt() 换成样式化登录弹窗。自测过期断言同步改为 31 天。
- 移动端全面紧凑化（对齐用户参考截图）：body 13px、顶栏双行（标题+导航芯片行：快捷/代理库/日志/运维管理；
  右侧 新建实例+横屏）、抽屉面板初始收起、卡片/按钮/表格/弹窗全部缩小。
- 移动端功能补全：新建/批量创建/导出/导入 在抽屉内、运维管理在导航、查看器工具条
  （跳转/键盘/截图/全屏/画质 流畅-标清-高清）、地址栏 datalist 历史（下拉显示）。
- 触屏交互：轻点=鼠标点击、滑动=滚轮滚动（touchmove→mouseWheel）、键盘按钮呼出底部输入条
  （input 事件→Input.insertText 自动发送、Enter/Backspace 派发）、全屏+横屏锁定。
- 验证：env-001 内开轻量标签页 CDP 驱动（Emulation 375x812 dsf:1，dsf:2 会 OOM），
  移动/桌面截图核对：导航、新建/横屏/工具条/导入导出/画质/历史 全部在位，viewer frame:true。
  注意 env-001 主标签页（50326 启动页）被桌面客户端绑定，导航走会被拉回，勿用它做测试。

## 移动端布局二修（2026-10-04 晚，用户反馈：按钮散块、抽屉过大、折叠后无法展开）

- 根因 1：顶栏「实例」切换按钮在 375px 下被挤断行不可见 → 折叠后永远无法展开。
  改为左缘常驻悬浮把手「≡ 实例」（z-index 29，抽屉打开时自然被盖住），删除顶栏切换按钮。
- 根因 2：移动端 aside width:262px 被基础样式 min-width:300px 顶住，收起后仍露 38px 残条。
  移动端显式 min-width:262px 修复。
- 新增点空白处自动收起抽屉（pointerdown 委托，仅 ≤768px 生效）。
- 抽屉紧凑化：262px 宽、搜索/分组/批量创建/新建/导出/导入/实例卡片全部 26-30px 高 12px 字。
- 顶栏收敛：手机端隐藏 Local API 文字（仅状态点）、按钮 28px 高。
- CDP 交互实测：把手展开、收起按钮、点空白收起 全部通过；展开态截图核对紧凑度。

## 移动端三修（2026-10-04 晚，用户五点反馈）

1. 画面太小 → 双指缩放(1-5x)+缩放后单指拖动+双击复位（transform scale，坐标映射按
   getBoundingClientRect 实时换算仍精确）；桌面 Ctrl+滚轮缩放。
2. 横屏无效 → 移入查看器工具条与跳转/键盘/截图/全屏/画质同行；逻辑改为
   全屏+screen.orientation.lock，lock 失败且全屏也失败时 CSS rotate(90deg) 兜底
   （.viewer.rot，含坐标系换算：内容x=relY,y=rect.width-relX）；全屏成功但锁失败仅提示。
   注意 :fullscreen UA 样式带 transform:none!important，故全屏元素本身不能做 CSS 旋转。
3. 顶栏「+新建」移除 → 新建/批量创建保留在实例抽屉内。
4. 实例点击颜色标识 → 点卡片主体切换 .selected（蓝框+辉光）；打开后 .active 常亮。
5. vtools 按钮防换行（white-space:nowrap + overflow-x:auto）。
   附：aside 移动端需显式 min-width 覆盖基础 min-width:300px，否则收起露残条。
   验证：LAYOUT/SELECT/ROTATE/restore 全绿，portrait/landscape/selected 三截图核对。

## 断连根治 + 运维能力补全（2026-10-04 深夜，用户第六轮反馈）

根因：CDP screencast 静态页不发帧 → WS 全静默 → 平台边缘代理掐断空闲 WSS →
「连接已断开/CDP 未连接」→ 点击跳转全部失效（用户截图实锤）。

1. WS 保活三件套：桥每 15s WS ping（浏览器自动 pong）+ 客户端 12s 应用层
   {bridge:ping}→pong + 25s 无帧看门狗（先重发 startScreencast，两轮无帧强制重连）。
2. 客户端自动重连：断开后指数退避重连 8 次（状态点 黄→绿），失败后点击 v-state 手动重试；
   cdpSend 未连接时 waitWs(4s) 等重连而非直接报错；navbar 增加 #v-dot 状态点。
3. 上游韧性：桥端 CDP 断开自动重连 6 次并重放 Page.enable/startScreencast（去 id 通知帧）。
4. 缩放按钮化：vtools 前 4 键 －/100%/＋/复位（视口中心缩放，g.apply 同步显示百分比），
   捏合仍可用；画质 maxWidth 1600→1920 配合 1920 宽实例。
5. 分辨率：env-001 持久化 1920x1080（console API update），运行中窗口经
   Browser.setWindowBounds 实时调到 1920x1080（innerWidth 1905）；新建实例空尺寸默认 1920x1080，
   窗口尺寸输入框加常用分辨率 datalist。
6. opsbox（改 root 运行）：新增 POST /api/mem/cleanup（sync+drop_caches，实测 +32MB）、
   POST /api/proc/kill（白名单：openbrowser/browser-profiles-v2/desktop-shell/webconsole/opsbox，
   拒 1/self/parent）；进程表加 tag 列（env-001·主进程/渲染进程/GPU进程/服务进程/zygote、
   桌面客户端·x、Web控制台、运维工作台，按 --user-data-dir basename + cwd 映射）与 结束 按钮；
   内存卡片加 🧹内存清理；tab 默认 资源管理（含 hash 路由 #files/#res 互换）。
7. 验证：selftest 8 组全过；ws-bridge-test.js（帧+pong）PASS；cdp-v6b 实测
   openViewer→dot ok→缩放 169% 平移生效；kill 守卫拒 pid1；截图 v6b.jpg。

## 第七/八轮修复（2026-10-05 凌晨）

1. 资源管理页横向滚动：grid minmax(340px) + 卡片内容 min-width:auto 撑破页面。
   修复 .grid>*{min-width:0} + ≤768px 单列 + #tab-res overflow-x:hidden + 进程表
   .pwrap 内部滚动（table min-width:560px）。实测 400px scrollWidth=400。
2. 查看器自动刷新下拉（v-refresh）：关/5s/15s/30s/1/2/5/10/30 分钟 + 自定义…
   （prompt 输入 5~86400 秒，动态插 option）；openViewer 时 loadRefreshCfg 回读，
   非标间隔动态建 option。实测 45s 往返。
3. 「莫名断开」强化：重连改为无限次（间隔封顶 5s，状态提示点击立即重试）；
   visibilitychange 回前台时 WS 已死立即重连 / 活着则置 lastFrame=0 让看门狗补帧。
   手机锁屏/切后台冻结定时器是断开主因。
4. 缩放 NaN 根治：g.apply 入口硬清洗（z/tx/ty 非 IsFinite 归位）；touchstart 用
   e.touches 全量重建触点表（清除残留触点）；pinch 仅在 d>0 且 pinch0>0 时更新；
   zoomBy NaN→1。注入 NaN 实测自愈 100%，随后 + 号直接 130%。

## 后台稳定性加固：keeper 全链路守护（2026-10-05）

用户要求：实例后台长期稳定、关网页不影响、永不中途死亡/卡死。

新增 webconsole/keeper.js（root，15s 巡检，后台终端 term_20 常驻）：
1. Xvfb :99 死 → 拉起
2. 桌面客户端：Local API(50325) 探活；进程在但连续 3 次无响应=卡死 → 强杀重启；
   进程不在 → 直接拉起（node scripts/run-app.js，setpriv uid1000 + DISPLAY=:99）
3. webconsole(50327) 死/僵尸 → 清理并拉起；opsbox(8002) 同理（root uvicorn）
4. 期望存活实例集合 console/keeper-state.json：死亡实例 15s 内经 Local API
   /api/browser/start 复活（90s 超时，失败 60s 冷却，per-id 锁防重入）
5. 状态登记：控制台 start=加入 / stop·删除·guard保护性停止=移除（keeperMark，
   env KEEPER_MARK_DISABLE 供自测禁写）；keeper 首次启动播种当前活跃实例
6. 关网页零影响本就成立：刷新/守护/实例全在服务端
验证：selftest 8 组过；keeper 实测拉起控制台、env-999 假实例失败冷却不倒；
播种 {"env-001":true} 正确。实测局限：整机宕机/平台回收无法防御（如实告知）。

## 工具条精简 + 常驻输入条（2026-10-05 上午）

按用户要求：复位/截图/横屏/键盘 四按钮移除（复位功能保留：双击画面复位；
横屏逻辑已无入口，CSS/坐标映射保留备用）；vtools 精简为 －/100%/＋/跳转/全屏/画质/刷新。
键盘输入条常驻视口底部（去掉 hidden 切换与「收起」按钮）；点输入框弹系统键盘，
点画面（mousedown/touchstart → kbBlur）自动收起。CDP 实测：5 元素均已移除、
kb-bar 无 hidden、占位文案更新。

## 跳转移入地址栏（2026-10-05 上午·二）

「跳转」按钮从 vtools 移到上方地址栏（v-url 右侧，icon 样式自适应宽度）；
回车跳转逻辑不变。vtools 精简为 －/100%/＋/全屏/画质/刷新。CDP 实测 goInBar=true。

## HTTP 兼容模式兜底 + 去顶栏（2026-10-05 下午）

用户手机 WSS 升级持续被运营商/网关拦截（HTTP 正常、红点、零帧）。新增兜底架构：
1. 服务端 /api/cast/shot/<pid>/<tid>（captureScreenshot jpeg55）与
   /api/cast/cmd/...（任意 CDP 指令），castPool 会话池复用 CDP 连接
   （30s sweep 清理 60s 空闲），鉴权同 console token。
2. 客户端：WS 失败≥2 次 → startPoll（1s 轮询画面 + 指令全部走 REST）；
   每 15s 试探 WSS，通了自动切回实时模式；tab 切换在 poll 模式仅换 targetId；
   cdpSend 按 mode 分流；画质切换在 poll 模式提示固定。
3. 修复历史误伤：v-fs/v-q 监听被按钮清理轮次误删，已恢复。
4. 顶部 h1「OpenBrowser Web 控制台」按用户要求移除（保留导航行）。
5. 状态点语义更新：poll 模式出帧即绿色。
验证：selftest 8 组过；SHOT 41KB@1920x937、CMD getNavigationHistory 往返 OK；
h1 计数 0。keeper 拉起新控制台（15:45:21）。

## 指纹信息可见可编辑（2026-10-05 傍晚）

用户要求：指纹完整可见、可手动改、随机只填表单、保存才生效，新增/修改都有一键随机。

1. 实例对话框新增「指纹信息」区：操作系统/CPU 核数/内存 GB/DNT/UserAgent/
   WebGL 厂商/WebGL 渲染器（留空=不修改）。
2. GET /api/console/fingerprint-random：generatePersona 只生成不落库；
   🎲一键随机 填表单（含尺寸/时区/语言），toast 提示保存生效。
3. detail 扁平化补 os/webglVendor/hardwareConcurrency/deviceMemory/doNotTrack；
   openDialog 回填全部指纹字段（当前值可见）。
4. 保存：fp 字段非空才提交（update 端点 allowed 已含全部键）；运行中实例保存指纹后
   询问是否立即重启生效；新建路径 import+followup update。
5. DNT 对齐 Local API 字符串风格：'1'=开启 / 'unset'=关闭。
6. 顺带修复：refresh 配置被此前测试脚本覆盖（已恢复用户 10 分钟）；公网 WSS 全链路
   实测通（网关 101+ack+帧），用户侧故障为间歇性网络，HTTP 兼容模式兜底。
   验证：CDP 实测对话框回填（os/cores/ua/glr/dnt 全出现）+ 随机填表（os/size/tz/ua/glr 全新值）。

## 实例查看交互重构（2026-10-05 晚）

用户三点要求：点实例即展示其最后打开页面；新建网页自动跳转空白页；点卡片=选中+右侧展示。

1. 卡片点击 = openViewer（原"打开"按钮删除，acts 只剩 启动/设置/删除）。
2. openViewer 首连 latestTabId()=targets 末尾（CDP 列表按创建顺序追加，末尾=最后打开页）。
3. + 新建：直接用 POST targets 响应里的新 target id 连接（消除列表 race 导致的"停在老页面"），600ms 后 refreshTabs 校正高亮；poll 模式 connectTab 立即 pollFrame 拉帧。
4. **重大排障发现**：viewer 收不到帧的真正根因 = Linux 原生窗口遮挡计算
   （CalculateNativeWinOcclusion）让被遮挡窗口停止 screencast 推帧——enable ack 正常、
   就是没帧，表现为"时好时坏/换 target 才有画面"。修复：
   a) main.js 加 disable-features=CalculateNativeWinOcclusion（治本）
   b) server handleUpgrade 桥接前 /json/activate 置前目标（治标+符合"看哪个就置前"直觉）
5. 半开连接治理：WsConnection 40s 无入站帧自动 teardown；server 端 cdpClients
   registry 同 target 互斥，新连接踢旧连接（手机断网残留连接不再永久占住 CDP 单客户端位）。
6. 顺带删除 openViewer 中未定义的 loadRefreshCfg() 调用（遗留引用会让点卡片后
    connectTab 永不执行——另一个"点开没画面"根因）。
    验证：CDP E2E 点卡片 frames=1 frameShown=true；+新建自动切 about:blank 帧到达；标签切换正常。

## 窗口级定时刷新与倒计时（2026-10-05 晚）

用户要求：窗口级配置优先，未设置窗口时继承实例级配置；查看器显示真实倒计时和自动刷新状态。

1. Refresher 改为 per-target 调度：实例级配置保留 `scope=active/all`，窗口级配置保存于
   `configs[profileId].windows[targetId]`，窗口配置优先，未配置窗口继承实例配置。
2. 每个窗口独立维护 `lastFireAt`，targets API 返回 `source`、`intervalSec`、`lastFireAt`、`nextFireAt`。
3. 新增 `/profiles/:id/refresh/window/:targetId` GET/PUT/POST API；`inherit` 清除窗口覆盖，
   `0` 关闭当前窗口刷新。
4. 查看器 `v-refresh` 已绑定当前标签页，支持跟随实例/关闭/预设间隔/自定义间隔；旁边每秒显示
   `下次刷新 mm:ss`，刷新发生后提示真实刷新时间。
5. selftest 新增窗口级优先、实例级继承和窗口 refresh API 覆盖测试；完整 selftest 通过，
   CDP E2E 实测实例继承倒计时、窗口 5 秒覆盖、恢复跟随实例均生效。
