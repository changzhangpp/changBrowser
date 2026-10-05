# 需求文档：OpenBrowser Web 可视化控制台与运维集成

Feature Name: openbrowser-web-console
Updated: 2026-10-04

## Introduction

为 OpenBrowser 桌面应用新增一个浏览器可访问的 Web 可视化控制台，用于查看和设置浏览器实例（Profile）信息、一键随机指纹、按窗口配置定时自动刷新；集成 opsbox 作为运维管理入口（资源监控 + 文件管理 + 图片预览）；内置实例资源异常增长守护（记录日志并自动终止异常实例）；整体界面兼容移动端。

## Glossary

- **实例（Profile）**: OpenBrowser 中一个隔离的浏览器环境，含指纹、代理、内核等配置。
- **控制台（Console）**: 本需求新增的 Web 服务，默认端口 50327，提供实例管理界面。
- **本地 API**: OpenBrowser 应用内置的 Local API（127.0.0.1:50325，api-key 认证）。
- **opsbox**: 开源运维工作台（FastAPI），提供文件管理与资源监控，默认端口 8002。
- **守护（Guard）**: 控制台内置的实例资源异常增长检测与自动终止机制。
- **CDP**: Chrome DevTools Protocol，通过 debug_port 控制运行中的实例窗口。

## Requirements

### R1 Web 可视化控制台与登录

**User Story:** AS 运维人员, I want 在浏览器中打开控制台查看全部实例状态, so that 无需桌面客户端也能掌握运行情况。

#### Acceptance Criteria

1. WHEN 操作者访问控制台地址, THE 控制台 SHALL 展示实例列表（名称、分组、内核、网络、出口、状态、扩展数）。
2. WHILE 操作者未通过口令认证, THE 控制台 SHALL 返回登录页并拒绝展示任何实例数据。
3. WHEN 操作者输入正确口令, THE 控制台 SHALL 签发有效期 7 天的访问令牌并进入主界面。
4. IF 口令连续错误达到 10 次/分钟, THE 控制台 SHALL 返回限流提示并延迟响应。
5. WHEN 视口宽度小于等于 768px, THE 控制台 SHALL 以移动端布局渲染（可折叠导航、卡片式列表、不出现横向滚动）。

### R2 实例信息查看与设置

**User Story:** AS 运维人员, I want 在控制台查看并编辑实例配置, so that 远程调整实例参数。

#### Acceptance Criteria

1. WHEN 操作者点击实例详情, THE 控制台 SHALL 展示实例的名称、分组、内核类型、启动页、代理、窗口尺寸、指纹摘要。
2. WHEN 操作者修改实例字段并提交, THE 控制台 SHALL 调用本地 API 保存并回显最新配置。
3. IF 本地 API 返回失败, THE 控制台 SHALL 展示错误信息且保留操作者已输入的内容。
4. WHEN 操作者通过控制台启动或停止实例, THE 控制台 SHALL 调用本地 API 并在 3 秒内刷新实例状态。

### R3 一键随机指纹

**User Story:** AS 运维人员, I want 一键为实例生成随机指纹, so that 快速获得一套全新的浏览器画像。

#### Acceptance Criteria

1. WHEN 操作者点击"随机指纹", THE 控制台 SHALL 生成一套内部一致的人设（平台、UA 与 UA-CH、分辨率、时区、语言、WebGL 厂商/渲染器、CPU 核数、内存、Canvas/WebGL 噪声种子）并保存到实例。
2. WHEN 随机指纹保存成功, THE 控制台 SHALL 展示新指纹摘要。
3. WHILE 实例处于运行中, THE 控制台 SHALL 提示"指纹将在下次启动生效"（默认仅改配置，由操作者选择是否立即重启实例）。
4. WHEN 操作者确认立即重启, THE 控制台 SHALL 停止并在 10 秒内重新启动该实例。

### R4 窗口级定时自动刷新

**User Story:** AS 运维人员, I want 为每个实例窗口单独配置定时刷新, so that 长时间运行的页面保持活跃。

#### Acceptance Criteria

1. WHEN 操作者为实例设置刷新间隔（秒, >=5, 0 表示关闭）, THE 控制台 SHALL 持久化该窗口的刷新配置（重启控制台后仍生效）。
2. WHILE 已配置的实例处于运行中, THE 控制台 SHALL 按 CDP 以设定周期刷新该窗口的页面。
3. WHEN 刷新触发, THE 控制台 SHALL 刷新该窗口的活动标签页（可配置全部标签页, 默认仅活动标签）。
4. IF 实例处于停止状态, THE 控制台 SHALL 暂停其刷新调度并在实例启动后自动恢复。
5. WHEN 刷新连续失败 3 次（如 CDP 断开）, THE 控制台 SHALL 记录一条刷新失败日志并停止该窗口调度。

### R5 opsbox 运维管理集成

**User Story:** AS 运维人员, I want 在控制台点击"运维管理"使用资源监控和文件管理, so that 在同一入口完成主机运维操作。

#### Acceptance Criteria

1. WHEN 操作者点击"运维管理", THE 控制台 SHALL 在同源地址下打开 opsbox 界面（控制台反向代理, 单端口访问）。
2. WHEN 操作者使用文件管理, THE 控制台代理 SHALL 提供文件列表、查看、编辑、保存、新建、删除、重命名、复制、移动、上传、下载、解压、搜索。
3. WHEN 操作者预览图片文件（png/jpg/jpeg/gif/webp/svg/bmp/ico）, opsbox SHALL 在页面内联渲染图片。
4. WHEN 操作者查看资源监控, opsbox SHALL 展示 CPU、内存、网络、磁盘 IO、Top 进程与分区使用率。
5. IF opsbox 服务未运行, THE 控制台 SHALL 在运维管理入口展示明确的"服务不可用"提示。

### R6 实例资源异常增长守护

**User Story:** AS 运维人员, I want 系统自动发现并处置资源异常增长的实例, so that 单个实例拖垮主机前被及时拦截。

#### Acceptance Criteria

1. WHILE 存在运行中的实例, THE 守护 SHALL 每 5 秒采样每个实例进程树的 RSS 与 CPU（阈值与周期可通过配置调整）。
2. IF 实例 RSS 超过上限（默认 1536MB）, THE 守护 SHALL 向 instance-guard.log 追加一条结构化日志（时间、实例、指标、触发规则、进程清单）。
3. IF 实例 RSS 每分钟增幅超过 15% 且连续 3 个采样窗口成立, THE 守护 SHALL 记录日志并判定为异常增长。
4. IF 实例 CPU 使用率超过 90% 持续 300 秒, THE 守护 SHALL 记录日志并判定为异常。
5. WHEN 判定异常成立, THE 守护 SHALL 调用本地 API 终止该实例（仅终止触发异常的实例）并在控制台展示告警事件。
6. WHEN 守护执行终止, THE 守护 SHALL 在日志中记录处置结果（成功/失败）。

### R7 移动端适配

**User Story:** AS 移动端操作者, I want 在手机上完成查看与常用操作, so that 离开工位也能管理实例。

#### Acceptance Criteria

1. WHEN 视口宽度小于等于 768px, THE 控制台 SHALL 将实例表格转换为卡片列表。
2. WHEN 在移动端操作, THE 控制台 SHALL 保证可点击元素触控区域不小于 44x44px。
3. WHEN opsbox 在移动端访问, THE opsbox 界面 SHALL 可正常浏览文件列表与查看图片。

### R8 实例实时浏览器窗口（多标签）【2026-10-04 新增】

**User Story:** AS 操作者, I want 点击实例后直接在控制台内看到并可操作该实例的浏览器窗口, so that 无需本地浏览器即可远程操作。

#### Acceptance Criteria

1. WHEN 操作者点击实例"打开", THE 控制台 SHALL 通过 CDP screencast 实时显示该实例当前页面画面（JPEG 流, 帧延迟可接受）。
2. WHEN 操作者在画面上点击/滚动/输入, THE 控制台 SHALL 将输入事件经 CDP Input 域派发到实例窗口并生效。
3. WHEN 操作者点击"+"新建标签、点击"×"关闭标签或点击标签切换, THE 控制台 SHALL 通过 CDP Target 域创建/关闭/切换对应页面。
4. WHEN 操作者在地址栏输入网址回车或点击前进/后退/刷新, THE 控制台 SHALL 通过 CDP Page 域执行对应导航。
5. IF 实例处于停止状态, THE 控制台 SHALL 在视图中提示"实例已停止"并提供启动入口。
6. WHILE 实例窗口视图开启, THE 控制台 SHALL 经由自身 WebSocket 桥接转发 CDP 消息（浏览器端直连 debug_port）。

### R9 桌面功能对齐【2026-10-04 新增】

**User Story:** AS 操作者, I want 在 Web 控制台使用与桌面客户端对齐的实例管理功能, so that 网页端完成日常操作。

#### Acceptance Criteria

1. WHEN 操作者点击"批量创建", THE 控制台 SHALL 按前缀与数量循环调用本地 API 创建实例并回显结果。
2. WHEN 操作者点击"导出", THE 控制台 SHALL 下载包含全部实例配置的 JSON 文件。
3. WHEN 操作者选择 JSON 文件"导入", THE 控制台 SHALL 逐条创建实例并汇总成功/失败数量。
4. WHEN 操作者在实例卡片点击"删除"并确认, THE 控制台 SHALL 调用本地 API 删除该实例及数据。
5. WHEN 操作者进入"代理库", THE 控制台 SHALL 展示代理列表并支持新建/删除/检测（经本地 API 代理接口透传）。
6. WHEN 操作者进入"日志", THE 控制台 SHALL 展示守护事件、刷新错误与控制台操作日志三类记录。
7. WHEN 操作者使用搜索框与分组下拉, THE 控制台 SHALL 按名称/备注过滤并按 group_name 分组筛选实例。

### R10 opsbox 免密互通【2026-10-04 新增】

**User Story:** AS 操作者, I want 点击运维管理直接进入 opsbox, so that 无需二次输入密码。

#### Acceptance Criteria

1. WHEN 已登录控制台的操作者打开 opsbox 页面, THE 控制台 SHALL 自动签发 opsbox token 并注入, 跳过其登录页。
2. WHEN opsbox 页面经控制台代理访问, THE 控制台 SHALL 保证其相对 API 路径正确路由（路径前缀兼容）。
3. IF opsbox token 过期, THE 控制台 SHALL 在下次进入时自动重新签发。

## 非目标

- 不改变 OpenBrowser 桌面客户端现有功能与数据格式。
- 不修改指纹内核注入逻辑, 随机指纹复用应用现有指纹配置模型。
