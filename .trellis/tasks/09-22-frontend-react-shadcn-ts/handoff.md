# 给 DeepSeek 的交接提示

可复制以下内容到下一次任务：

> 请阅读 `.trellis/tasks/09-22-frontend-react-shadcn-ts/` 下的 prd.md、design.md、implement.md 和 research/。这是 Agent Companion 从纯 JS 前端迁移到 React + shadcn/ui + TypeScript 的计划。按阶段改写，保持外观、动画、状态规则和 Tauri 原生行为，先核对工作区与共享 Node 模块引用；不要一次性推倒重写。当前任务仍是 planning，开始实现需要我明确授权。若我只要求审阅计划，请只给修改意见。实现获授权后按 implement.md 激活任务并执行，逐阶段验证，最后明确报告已验证与未验证项。重点注意共享 JS 的 Node 兼容、React 订阅清理、Portal 命中区域、quiet done 和部分设置保存失败。

若用户在新会话明确说“批准此计划，请开始实现”，即为该次实施授权；不要把本次计划创建误认作授权。无需访问本轮聊天记录，所有核心约束已写入上述文件。
