# 代码证据与迁移陷阱

核查日期：2026-09-22；仓库 HEAD：9ec9262。仅只读检查代码，规划阶段没有运行产品测试或性能测量。

| 证据 | 已核实事实 / 实施影响 |
| --- | --- |
| package.json、vite.config.js、src-tauri/tauri.conf.json | Vite 多页，Node >=22.13.0，Tauri v2；当前没有 React、TS、lint/typecheck。保留 devUrl 与两个构建入口。 |
| src/desktop/rail.js | 原生命中区域测量、按钮命中、自动卡片、welcome.blocking、inactive 处理、pagehide 清理均是既有行为。 |
| src/desktop/host.js | desktop/embedHost/browser 分支；monitor-state、monitor-connection、初始 monitor_state；ts 防乱序；异步 listen 清理。 |
| src/desktop/settings.js、preferences.js、listening.js | 外观与监听分开保存；部分失败提示；监听保存前重新读取并保留其他字段。 |
| src/monitor/session-model.js、tests/desktop.test.js | 完成保留 1 小时、打开完成会话保留 10 秒且重复点击不延长、主机退出宽限 15 秒、超过 8 条时按 10 秒退役成功会话；不能把显示数量设置误当模型阈值。 |
| src/monitor/reminders.js | 仅 wait 自动卡；静音精确绑定 roundId 与 pending。 |
| src/desktop/avatar.js、welcome/index.js、welcome/cat-motion.js | SVG、CSS、WAAPI/rAF；reduced-motion、visibility 和原生窗口状态相关，不宜改为每帧 React 渲染。 |
| collector/lib/settings.js、collector/lib/collector.js | 直接导入 src/settings-config.js。 |
| collector/lib/codex-live.js | 直接导入 src/monitor/session-visibility.js，该文件导入 JSON 模板。 |
| collector/desktop.js | 直接导入 src/monitor/model.js。 |
| tests/*.test.js、scripts/qa-*.mjs | Node ESM 直接引用 src；需要区分生产共享 JS 和可配 loader 的测试入口。 |
| scripts/qa-ui.mjs | 当前 UI smoke 验证 empty/running/wait/done、设置持久化、无 3D；使用模拟 SSE，不证明原生穿透。 |
| src-tauri/src/native_qa.rs、scripts/qa-native-app.mjs | 原生 diagnostics 依赖 .desktop-avatar、.desktop-connection、fieldset 等 DOM；结构变化需保留语义或同步诊断，不能删除断言。 |
| .trellis/spec/、当前 bootstrap task | 没有前端 package；Rust 索引为初始化模板。本次任务不得误归为 Rust 重构。 |

现有头像模型身份列表和 avatar 视觉变体是不同实现层；迁移首先保存当前映射和截图，若发现不一致单列缺陷，不在本任务中静默换视觉或身份规则。

参考（上一轮已读取官方文档；安装前重新核实所选版本）：
- React 渐进接入：https://react.dev/learn/add-react-to-an-existing-project
- shadcn Vite 安装：https://ui.shadcn.com/docs/installation/vite
- TypeScript JS 迁移：https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html
