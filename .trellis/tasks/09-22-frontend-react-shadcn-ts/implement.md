# DeepSeek 实施计划

## 开始前
本文件是执行交接，不是已经实施的记录。先读 prd.md、design.md、research/current-state.md、research/acceptance-matrix.md。用户明确授权执行此最终计划后再运行：

```sh
python3 .trellis/scripts/task.py start .trellis/tasks/09-22-frontend-react-shadcn-ts
```

按 AGENTS.md 和当前平台的 Trellis 流程加载上下文；平台不支持子代理时直接按相同契约实施，不要为此修改项目配置。需要让另一位代理审查时传入本任务路径和真实上下文。

## P0：锁定基线
- [ ] 检查 git status、分支、当前任务和环境；保护已有未提交的 .trellis/.agents 等文件。创建 codex/frontend-react-shadcn-ts 分支（若已存在先确认内容，勿覆盖）。
- [ ] 补全 src 模块被 collector/scripts/tests 引用的传递依赖清单；核实 Rust 命令参数与快照结构。
- [ ] 跑 npm test、npm run build、npm run test:bundle、npm run test:ui，保存日志与截图到 artifacts/frontend-migration/before/；先复制基线，再运行会覆盖 artifacts/ui 的脚本。
- [ ] 建立原生行为与性能基线，环境限制独立记录；已有失败先记录，不通过删测试“修复”。

## P1：工具链、类型与桥接
- [ ] 接入 React/react-dom、对应类型、Vite React 插件、TypeScript、必要 Tailwind/shadcn 配置和 tsx；保留两个 Vite HTML 入口与所有 desktop 脚本。
- [ ] 增加 strict 的 typecheck（tsc --noEmit）与适合 TS/React Hooks 的 lint 命令；checkJs 覆盖共享例外，lint 以新增/迁移前端为范围，不顺便重写整个 collector。
- [ ] 建立 types、typed host 与 preferences/listening/transport；处理未知载荷、异步清理及错误，保持存储键和事件名。
- [ ] 将前端专属纯模型迁移 TS；共享 JS 添加 JSDoc；同步测试 import 和 loader。npm test、typecheck、lint、build 必须通过再进入 P2。

## P2：设置页
- [ ] 将旧设置入口换成 React；用必要的 shadcn 控件复现现有布局和交互。
- [ ] 覆盖加载禁用、读取失败重试、未保存状态、防重复保存、部分保存失败与再次重试、原生/浏览器 autostart 差异、Escape 关闭。
- [ ] 保持 saveListening 保存前重新读取及字段合并；跨窗口同步不丢弃其他设置。
- [ ] 适配 qa-ui 的选择器为语义或稳定 data 属性，保留原有业务断言；检查 native_qa.rs 的 fieldset 依赖，优先保留兼容 DOM。
- [ ] 验证 typecheck/lint/test/build/UI 与设置截图。

## P3：悬浮栏和动画
- [ ] 拆分 rail/card/menu/avatar/welcome，复用纯模型，单一状态发布路径；缓存外部 store 快照。
- [ ] 保持自动问题卡片、静音键、quiet done、连接状态、身份映射、展开及打开失败反馈。
- [ ] 通过 refs 接入动画控制器，避免 React 和控制器同时控制节点属性；实现重复挂载/卸载清理。
- [ ] 提交布局后测量所有可交互表面；覆盖 Portal、滚动、resize、动画和欢迎阻塞态。
- [ ] 浏览器行为、几何与截图通过后在真实原生窗口检查点击穿透/拖动/非激活悬停；浏览器结果不能代替该项。

## P4：集成与交付
- [ ] 删除已被替代的前端入口/渲染代码，保留明确的 Node JS 例外；复查 collector 仍可直接用 Node 运行。
- [ ] 按 acceptance-matrix.md 完成自动化、原生、视觉、资源检查，并把前后结果保存到 artifacts/frontend-migration/。
- [ ] 更新前端使用说明、实际 spec 和 docs/validation.md 的本次结果；不要把尚未通过项写为成功。若 bootstrap spec 任务有并行修改，合并协作，不覆盖。
- [ ] 交付 changed files、检查结果、包体/性能数据、截图路径及未验证项目；提交/归档按用户授权和 Trellis 流程，不自动推送发布。

## 最终检查命令
按顺序执行，前置命令失败先解决，不把后续检查当成已通过：

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:bundle
npm run test:ui
npm run test:rust
npm run test:runtime
npm run test:native-app
git diff --check
```

typecheck/lint 是本任务待新增的命令。其余来自当前 package.json；test:ui 依赖新构建 dist；test:native-app 会构建 diagnostics app。原生 QA 使用现有隔离 home，禁止把测试 Hook 装进用户日常配置。模型测试使用可控时钟；不要为所有机械改名写重复测试。以完整验收为结束条件，不以“构建成功”代替完成。
