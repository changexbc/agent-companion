# 技术设计

## 架构
保持两套独立入口：desktop.html → rail.tsx，desktop-settings.html → settings.tsx。每个窗口拥有自己的 React root；跨窗口状态继续通过现有原生事件/存储同步，不能假设 React Context 跨 WebView 共享。

数据流：Rust monitor-state / 初始 monitor_state（浏览器为现有 SSE）→ host/transport 边界 → 既有纯模型 → React 视图。DOM 布局结果 → 命中区域控制器 → set_hit_regions。设置依旧使用现有 host/preferences/listening 数据路径。

建议职责（路径可小幅调整，边界不可混合）：
- src/types/：Session、Snapshot、SourceHealth、PendingQuestion、RailPreferences、Settings、命令参数/结果映射、事件载荷。
- src/desktop/host.ts、preferences.ts、listening.ts：原生桥接和设置服务。
- src/desktop/components/：Rail、SessionAvatar、SessionCard、AutomaticQuestionCard、RailMenu、SettingsForm。
- src/desktop/hooks/：监控订阅、设置同步、命中区域与窗口状态。
- src/components/ui/：按需引入且可定制的 shadcn 源码。
- src/desktop/welcome/ 与 avatar：动画控制器及 React 包装，保留现有 CSS/SVG。

## 类型和 Node 共享边界
1. UI 及前端专属模块迁移为 TS/TSX；迁移期 allowJs，最终不遗留未说明的前端 JS。
2. 明确保留以下 Node 共享源码的 JS 形式：src/settings-config.js、src/monitor/model.js、src/monitor/session-visibility.js 及其 JSON 模板。由 collector 直接加载；不新增 Node 运行时转译要求，不提升 Node >=22.13.0 的最低约束。
3. 对以上 JS 添加类型化 JSDoc，使用 allowJs + checkJs；纯 type import 不产生运行时依赖。与前端共用契约定义，不能通过一个宽泛 .d.ts 隐藏真实实现问题。
4. 仅被测试引用、未被 collector 引用的模块可以迁移 TS；测试和 QA 脚本仍可保留 JS。采用 tsx 开发依赖运行会加载 TS 的 Node 测试（例如 node --import tsx --test tests/*.test.js），同步更新 import 路径。检查子进程入口及传递依赖，不能假设父进程 loader 自动传到所有子进程。
5. 先根据实际生产快照、fixtures 与 Rust 输出整理可选字段及 null 语义，不能照一条 fixture 猜完整协议。保留现有校验，在外部输入边界从 unknown 收窄；无效输入可报告/丢弃，不能清空正确状态或悄悄改变容错行为。
6. typed desktopCommand 以命令映射约束参数与结果；Tauri invoke 泛型不是运行时校验。保留 embedHost 分支、事件名、乱序 ts 防护、异步订阅释放逻辑。

## React 状态和生命周期
保留 createRailModel 的规则，使用单一控制器处理 accept/connect/refresh/dismiss/retainOpened/cancelOpened 后发布 UI 快照。组件不复制一份会话淘汰逻辑。到期继续使用 nextExpiry 的单次计时器，不添加高频轮询。

如使用 useSyncExternalStore，getSnapshot 在没有变化时必须返回缓存的同一对象；不能直接返回每次新建数组的 model.items。订阅在 effect 中建立，构造和 render 保持无副作用。开发 StrictMode 的挂载→清理→挂载必须成立：异步 listen 晚返回也应立即解除已销毁实例的监听，初始请求晚返回不得覆盖新快照。

保留 questionKey 和 mutedQuestions 规则、窗口不活跃表现、打开失败后的 retain 回滚。头像使用稳定 session id/身份映射作为 key，不能用列表索引使动画和身份随排序重置。

## 命中区域与弹层
以 useLayoutEffect/ResizeObserver 和必要的布局事件在 React commit 后测量。覆盖列表滚动、窗口 resize、卡片动画结束、展开收起、错误提示消失、欢迎动画阻塞切换和 Portal 挂载。

优先为 rail 弹层提供受控容器或显式 surface 注册。原有 root.querySelectorAll 不会自动覆盖 body 下的 Portal。命中区域与可点击控件都应来自已注册、实际可见的表面；关闭后及时清除。禁止直接把整块透明 WebView 声明为可点击来绕过点击穿透。

设置页可以优先用 NativeSelect 减少行为变化。rail 菜单/悬浮卡若 shadcn 默认焦点捕获、遮罩或定位不符合桌面行为，保留定制组件；shadcn 不是每个元素必须替换的指标。

## 动画和样式
React 负责动画容器的挂载、参数和销毁；现有 requestAnimationFrame/Web Animations/CSS 负责逐帧动作，不按帧 setState。React 与动画控制器不能同时写同一 DOM 属性。保留 visibility/reduced-motion/窗口 active/动画开关的暂停和恢复条件。

采用 shadcn Vite 所需的 Tailwind 构建接入与路径别名，版本在实施时核实并锁定。Tailwind reset/preflight 和全局主题不能破坏透明窗口、hidden 属性、SVG、拖动区及既有 CSS；必要时限制 reset 作用域或不启用全局 preflight。新控件使用现有色彩/圆角/尺寸变量，不进行视觉重设计。

## 回滚与范围
按基础设施→设置页→rail→清理分阶段，每阶段保持可构建。使用独立 codex/frontend-react-shadcn-ts 分支，保留用户已有未提交文件；不要为了创建基线提交全部 WIP。提交需遵守用户授权和本地流程。仅回退该阶段明确属于本任务的改动，不使用全目录 reset/clean。原有业务路径被新入口及测试证明替代后再清理，避免长期保留两套 UI。
