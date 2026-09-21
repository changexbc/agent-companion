# 验收矩阵与证据要求

以下均为待实施检查，不是已通过记录。

| 范围 | 场景 | 方法 / 证据 |
| --- | --- | --- |
| 工具链 | 双入口、TS strict、共享 JS checkJs、Node collector 无 loader 依赖 | typecheck/lint/build、npm test；记录迁移例外 |
| 模型 | 完成淘汰、打开宽限、轮次切换、主机退出、断连、头像缓存 | 保留 tests/desktop.test.js、monitor.test.js 等原断言 |
| 问题卡 | wait 自动卡，done 安静，静音后同问题不再弹，新轮次/新问题恢复 | 现有 UI smoke + 缺失场景行为用例 |
| 桥接生命周期 | StrictMode 重挂载、异步 listen 晚返回、卸载后回包、乱序初始响应 | mock bridge 行为测试：活动订阅数恢复正确、旧事件不更新 UI |
| 定时清理 | 卡片切换、过期调度、关闭窗口、动画中卸载 | 可控计时器及 mount/unmount；无重复回调或残留 observer/rAF |
| 设置 | 读失败重试、部分写成功、再次保存、双击保存、保留 source.path/scene、跨窗口同步 | UI 路由 mock + 原生事件检查；重启持久化 |
| 可访问性 | Switch/Select/菜单键盘操作、焦点恢复、状态播报、Escape | Playwright role/name 选择器；不依赖 React 内部状态 |
| 原生交互 | 透明处穿透，头像/菜单/Portal 可点，拖动，非激活 hover，resize/关闭后命中更新 | 真正 macOS Tauri 应用；现有 diagnostics + 人工验证；浏览器仅辅助几何 |
| 视觉与动画 | 空闲、running、wait、done、断连、展开、设置、welcome；正常及 reduced motion | 同 viewport 前后截图/必要动画录制；用户人工视觉确认独立标记 |
| 集成 | Rust parity、隔离 runtime、打包 app、无 3D | test:rust/runtime/native-app/bundle；记录日志和环境 |

## 资源与启动对照
同一机器、同一构建模式、同一窗口和会话数量，关闭无关调试工具。分别记录空闲无会话与固定 8 会话场景；暖机后观察至少 60 秒，至少 3 次独立运行。记录主应用、WebView 相关进程、runtime 的 CPU/内存（可分清进程时分别列出，无法分清时说明）、冷启动到 rail 可交互耗时，以及 dist JS/CSS 原始与 gzip 大小。

包体因 React/shadcn 增加可以解释，不能直接视为性能失败；可重复的空闲 CPU/内存增长、启动变慢或可见掉帧要定位并披露。不给出未经基线验证的百分比承诺。原生数据采集受限时标为未验证，并列出待执行步骤。

## 结果格式
每项记录：基线、迁移后、命令/场景、日志或截图路径、通过/失败/未验证、原因。现有自动化测试通过、原生人工确认、用户视觉接受是三个不同结论。Windows/Linux、签名、公证与发布不在本次验收范围。
