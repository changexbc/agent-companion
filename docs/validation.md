# 迁移验证记录

验证环境：macOS，本地独立新仓库；未使用旧仓库的 node_modules、target 或路径依赖。

## 已通过

- Node 回归：85 项通过；默认跳过的 Codeg 原生测试在指定新构建二进制后补跑通过（Codeg 文件全部 11 项通过）。
- Rust workspace：35 项测试通过。
- Rust/Node 快照一致性：轮次、提问、完成、旧事件与 token 状态一致。
- 原生服务：隔离用户目录中的 Codex / IDE Hooks、禁用接入、双客户端、服务锁、通知 owner 交接及 RPC 鉴权通过。
- 前端构建与资源检查：两个入口，约 139 KB，无 Three.js、办公室模型、光照贴图或旧仓库路径依赖。
- 浏览器实际页面：空闲、运行、待确认、完成状态；提问自动提醒；完成不弹提醒；设置保存恢复；保留共享配置字段；无页面错误与失败资源请求。
- macOS 打包：独立 Agent Companion.app，约 17 MB。
- 原生诊断构建：隔离目录下收到 Hook 后显示 1 个待确认会话；设置加载成功；仅有 rail / settings 两个窗口，打开 office 返回“未知视图”。
- 来源保护：已迁移源文件的 SHA-256 与复制前一致，来源仓库 Git 状态也未改变。

## 证据

- `artifacts/ui/`：浏览器页面截图与检查报告。
- `artifacts/native-*/`：原生 WebView 截图、窗口列表与检查报告；以含有 `summary.json` 的成功运行目录为准。
- `docs/migration-source.json`：来源基线及文件哈希。

上述 artifacts 是本机可重建的验证产物，不进入 Git。

## 验证边界

- 原生 Codex 适配器沿用通用“需要你确认”文案，本次未扩展提问文本解析。浏览器完整提问文案检查使用模拟快照。
- 原生应用验证使用真实 Rust Hook 通道和隔离会话，未代替用户对日常真实会话、实际跳转、通知授权与开机启动的验收。
- 未验证 Windows/Linux，未签名公证、安装、发布或修改旧办公室/WB Switch 的集成。

---

# 前端迁移验证记录（React + shadcn/ui + TypeScript）

把两个窗口的前端从手写 DOM 代码迁移到 React + TypeScript；设置页同时引入 shadcn/ui 与 Tailwind。分四个阶段完成，提交 `3eff739`（工具链与类型）、`b05404a`（设置页）、`ac64a21`（悬浮栏）、`8c38620`（按独立复查修正）。

## 已通过（自动化）

| 验收矩阵行 | 命令 | 结果 |
| --- | --- | --- |
| 工具链 | `npm run typecheck`、`npm run lint`、`npm test` | 通过。共享 JS 用 `// @ts-check` 逐个开启检查 |
| 模型 | `npm test` | 95 项，94 通过 / 0 失败 / 1 跳过 |
| 问题卡 | `npm run test:ui`、`tests/reminders.test.js` | 通过。wait 自动卡、done 安静、静音按轮次与问题清除 |
| 桥接生命周期 | `tests/bridge.test.js` | 通过。活动订阅数归零、迟到的 listen 被立即释放、乱序初始响应不覆盖新快照 |
| 定时清理 | `npm test`、`npm run test:ui` | 通过。模型使用可控时钟；销毁后不再响应事件也不再与宿主通信 |
| 设置 | `npm run test:ui` | 通过。读失败重试、部分保存、双击保存、保留 `source.path` 与 `scene`、跨窗口同步 |
| 可访问性 | `npm run test:ui`、`focus-diff.mjs` | 通过。设置页 9 个 Tab 停靠点焦点环一致；悬浮栏 Escape 关闭并归还焦点 |
| 集成 | `npm run test:rust` / `test:runtime` / `test:native-app` / `test:bundle` | 通过。打包产物 422492 字节，无 3D 资源 |
| 视觉（设置页） | `style-diff.mjs` + `pixdiff` | 与迁移前逐像素一致（480x937）；属性对照 29 条，全部为按需挂载的结构性差异 |
| 视觉（悬浮栏） | `rail-diff.mjs` + `rail-pixels.mjs` | 11 个场景。语义状态差异 0；属性差异 20 条，全部是同一个结构性事实；像素对照多数逐像素一致 |

一次完整运行及逐条日志见 `artifacts/frontend-migration/after/acceptance.json` 与 `after/logs/`。

## 迁移后新增的检查手段

- `artifacts/frontend-migration/rail-diff.mjs`：从 `80d6c55` 逐字节取出的迁移前悬浮栏，与迁移后逐元素对照计算样式、几何，加一个语义探针。先做过自检（同一份代码对自己跑出 11 场景 0 差异）。
- `focus-diff.mjs`：伪类样式在默认态的计算样式里看不见，所以焦点环必须单独探。
- `artifacts/frontend-migration/{rail-pixels,measure-rail-startup,measure-idle}.mjs`：像素、启动、空闲资源。

## 已知的测量限制

- **悬浮栏的 1x 像素对照不是确定性的。** Chromium 对这个 app 的 SVG 在每次冷载入时可能选不同的栅格化路径，差异是抗锯齿边缘上 15–20 个像素；8 倍放大下同一区域逐字节相同，矢量几何没有变化。实测**迁移前**的构建产物自身在 12 次冷载入里就产生两种渲染（10 和 2），所以这不是迁移引入的。因此像素关卡允许「至多 64 像素且落在 32x32 的框内」，并把数量、盒子和两侧渲染种类数打印出来。**盲区**：约 16 像素、局限在 SVG 边缘的改动会被它放过，只能靠确定性的属性对照兜住——属性清单已包含 `fill`/`stroke`/`filter` 等 SVG 呈现属性（用 1/255 的填充改动验证过会被抓到）。
- **冷启动到「悬浮栏可交互」的原生耗时未测量**，没有埋点。同机生产包对照（Chromium 代理）：首帧中位 14 → 27 ms，首屏传输 61.0 → 289.1 KB 未压缩。
- **空闲 CPU / 内存不足以断言没有回归**：采样期间同机有其他应用，run 间波动大于迁移差异。WebContent RSS 上升约 2.5–9 MB，记录在 `after/idle-resources.json`。
- 悬浮栏的窗口加载量从约 43 KB 涨到约 271 KB（React 变成两个窗口共享的 chunk）；总 JS 315.5 → 320.7 KB。悬浮栏 CSS 逐字节不变。

## 仍待人工确认

拖动、点击穿透、非激活悬停、点击菜单与卡片；用户对迁移后外观的确认；Portal 挂载的表面被测量（悬浮栏当前没有 Portal，注册表在结构上支持）；屏幕阅读器播报与悬浮栏菜单方向键。逐条步骤见 `after/acceptance.json` 的 `unverified` 字段。

自动化测试通过、原生诊断通过、用户视觉接受是三件不同的事；本文件只覆盖前两者。
