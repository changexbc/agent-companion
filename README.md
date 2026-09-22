# Agent Companion · Agent 小伴

独立、轻量的桌面 Agent 会话助手：查看任务状态、接收提问提醒，并跳转回原会话。

悬浮栏、头像、欢迎动画、空闲小灯、设置、托盘和原生监控服务已从 `agent-mac-office` 迁入。安装包不包含 3D 办公室、Three.js、模型或光照资源。

两个窗口的前端已改用 React + TypeScript；共享的会话模型与设置 schema 仍是带类型 JSDoc 的 JS，供 collector 直接用 Node 加载。

## 开发和构建

需要 Node.js 22.13+、npm、Rust stable，以及对应平台的 Tauri 2 编译工具链。当前迁移在 macOS 上验证；其他平台未验证。

```sh
npm ci
npm run dev
```

开发模式先构建原生监控服务，再启动 Vite 和 Tauri。独立开发端口为 `4189`，不会引用旧项目目录。

```sh
npm run build                 # 仅构建悬浮栏和设置前端
npm run desktop:build         # 构建 macOS .app（包含 Rust 服务）
```

产物：`src-tauri/target/release/bundle/macos/Agent Companion.app`。本地构建未进行开发者签名或公证。

`npm run desktop:web` 可打开 `/desktop.html` 检查浏览器 UI；浏览器预览不启动监听服务，真实监控请使用桌面模式。

## 验证

```sh
npm run typecheck             # tsc --noEmit，含前端 TS/TSX 与带 @ts-check 的共享 JS
npm run lint                  # eslint，范围是 src/ 下已迁移的 TS/TSX
npm test
npm run test:rust
npm run test:runtime
npm run test:bundle           # 先执行 npm run build
npx playwright install chromium
npm run test:ui               # 已构建前端，使用隔离模拟会话
npm run test:native-app       # macOS，诊断构建 + 隔离的原生应用验证
CODEG_RUNTIME_BINARY="$PWD/target/release/agent-studio-runtime" node --test tests/codeg-hooks.test.js
```

监控自动测试使用临时用户目录，避免更改真实 Agent Hook。UI 测试使用浏览器临时上下文；原生应用测试会短暂显示测试窗口并自动退出，不设置开机启动。`collector/` 是兼容性测试的 Node 参考实现，正式桌面应用只使用 Rust 服务，不依赖 Node 或 Python。

## 前端结构

两个窗口是两个独立的 Vite 入口，各自拥有一个 React root；跨窗口状态继续走原生事件与存储，没有共享的 Context。

- `src/desktop/rail.tsx` / `settings.tsx`：入口，只负责挂载。
- `src/desktop/components/`：视图。`SettingsForm` 是设置页；`Rail`／`SessionAvatar`／`SessionCard` 是悬浮栏。
- `src/desktop/rail-controller.ts`：悬浮栏唯一的状态所有者，持有模型、静音集合、菜单、提示和欢迎动画。
- `src/desktop/rail-animations.ts`：所有 Web Animations 调用。
- `src/desktop/hit-regions.ts`：点击穿透用的显式表面注册表。
- `src/components/ui/`：按需引入的 shadcn 源码，目前只有设置页在用。

三条约定，违反它们会让「React 与控制器同时写同一个 DOM 属性」这类问题重新出现：

1. `#desktop-rail` 是 React 的**容器**而不是 React 元素，所以 React 不写它的属性；`desktop-inactive`、`companion-motion-paused`、`welcome-blocking` 等由控制器写。
2. 悬浮卡、自动问题卡、提示条是**按布局放置**的（是否可见取决于头像列表滚到哪里），它们的 `hidden` 与 `style.top` 属于控制器，JSX 里不为它们声明 `style` 或 `hidden`。
3. 动画只在 `afterCommit()` 里启动，它跑在每次提交后的 layout effect 中，用「上一次提交结束时测量到的位置」作为起点。FLIP 基线用 `offsetTop` 而不是 rect：rect 会把正在跑的动画的 transform 算进去。

悬浮栏不引入 Tailwind：那里没有 shadcn 组件，而 preflight 会覆盖旧样式表从未声明过的 UA 默认值，设置页迁移时就因此出过四个回归。

### Node 共享的 JS 例外

以下文件保持 JS 形式，因为 collector 直接用 Node 加载它们，不能要求转译：

`src/settings-config.js`、`src/monitor/model.js`、`src/monitor/session-visibility.js`（及其 `codex-internal-prompts.json`）。

它们都带 `// @ts-check` 与 JSDoc 类型，所以 `npm run typecheck` 会检查它们——`checkJs` 是关闭的，靠 pragma 逐个开启，避免把 `scripts/`、`tests/` 和 `collector/` 一起拖进来。

## 目录

- `src/desktop/`：悬浮框、SVG 头像、欢迎动画和设置（React + TypeScript，结构见下）。
- `src/monitor/`：会话生命周期、展示、提醒和跳转；其中 `model.js` 与 `session-visibility.js` 是被 collector 共享的 JS。
- `crates/agent-studio-core/`：监控与状态归一化。
- `crates/agent-studio-runtime/`：本地共享监控服务及客户端。
- `crates/agent-studio-desktop/`：Tauri 桌面集成，仅提供会话栏和设置窗口。
- `src-tauri/`：Agent Companion 独立应用壳。

## 与旧应用共存

应用标识为 `com.agentcompanion.desktop`，拥有独立的窗口偏好与开机启动项。安装本应用不会删除或禁用旧应用；切换使用时请在旧应用中隐藏悬浮栏或退出旧应用，避免同时显示两套悬浮栏。

为了兼容现有宿主，监控协议、Rust crate 名称、Hook 标记以及 `~/.agent-studio` 配置目录暂时保留。它们是数据/协议兼容约定，不是旧仓库的文件依赖。服务通过锁与客户端租约共享，系统通知由服务分配的 owner 接收。旧版宿主尚未升级时，会使用已运行的兼容服务，重启全部宿主后才会运行新构建的服务。

旧设置中的 `scene`、工位与日程字段仅保留为协议 v1 的往返兼容数据；悬浮框不展示或执行这些场景功能。改动监听开关会影响共享服务的其他宿主。

Codex 会话状态沿用 Hook 驱动逻辑；完成会话的已读检测保留低频读取全局已读状态文件的既有行为，不恢复历史会话或扫描会话日志。完成状态只显示小标记，提问保留提醒。

## 来源及后续边界

迁移来源和文件哈希见 `docs/migration-source.json`，包含来源工作区的未提交成果。原仓库未被修改或清理。沿用源码内已有版权/许可证声明与资源归属；本次迁移不新增覆盖全部文件的许可证授权。Agent 图标归属见 `public/icons/agents/README.md`。

现有 WB Switch / 办公室继续使用原有集成，不会被本次迁移自动替换。未来迁移宿主时应采用本仓库的桌面插件，将旧 `Config.office_route` 改为 `manage_autostart`（嵌入宿主设为 `false`），移除办公室路由。办公室的数据接口重接和旧仓库代码清理单独进行。

本次迁移验证结果见 [验证记录](docs/validation.md)。
