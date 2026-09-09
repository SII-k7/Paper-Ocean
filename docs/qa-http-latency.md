# v1.2.3 问答连接延迟修复（基于 v1.2.2）

## 原因与修改

2026-09-09 在 Windows、Codex CLI 0.146.0 上记录了逐阶段事件。原来的
`--disable responses_websockets --disable responses_websockets_v2` 没有实际关闭
WebSocket。首问连接 `wss://chatgpt.com/backend-api/codex/responses` 时发生 DNS
失败，重试 5 次后才回退 HTTP；一段极短资料也要接近 99 秒才出字。
日志中首次连接失败在进程启动后约 22 秒，最后一次失败在约 84 秒。

现在使用应用子进程专用的 `paper_ocean_http` provider，并设置
`supports_websockets=false`。继续通过 `requires_openai_auth=true` 使用现有
OpenAI 登录及默认端点，不写入全局 Codex 配置、不读取或复制登录凭据。
新建和恢复对话都显式选择该 provider，使旧对话也使用 HTTP 流式响应。
恢复沿用原 thread ID；CLI 保存的历史元数据仍可能显示原始 provider。

依据：[官方 provider 配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。
内置 provider ID 不可覆盖，因此使用独立名称，不能继续依赖旧 feature flags。

## 实测

同一台机器、同一账号、Luna max、Fast（目录返回的 `priority`），20 页合成
机器人控制资料。修复前后都发送完整的 122 个上下文条目，首问请求体均为
95,217 字节，没有缩减论文、降低思考强度或改写论文注入方式。
首字计时从发送问题前开始，包含该轮剩余的后台初始化等待；不含之前的
模型目录获取和论文索引时间。

| 场景 | 修复前首字 / 完成 | HTTP 首字 / 完成 |
| --- | --- | --- |
| 新进程、新对话、完整资料首问 | 90.4 / 92.6 秒 | 27.3 / 30.1 秒 |
| 同一对话追问 | 14.1 / 16.6 秒 | 11.6 / 13.5 秒 |
| 再次启动新进程、新对话，重复首问 | — | 34.8 / 36.6 秒 |
| 第二次测试的追问 | — | 14.5 / 15.8 秒 |
| 新进程恢复旧版合成测试对话 | 未单独测量 | 21.4 / 22.9 秒 |

旧对话恢复测试没有再次注入论文，回答仍正确识别先前讨论的 PD 控制器并引用
第 1 页。独立短资料探针从进程启动到首字由 98.7 秒降至 26.5 秒，修复后没有
出现 WebSocket 重连诊断。

这些是少量合成资料实测，不是所有论文的速度保证。缓存、MCP 冷启动、网络及
回答复杂度仍会影响耗时；尤其长推理不能保证即时开始输出。arXikun 的公开
仓库主要提供安装包和更新记录，无法据此测出其内部连接实现或作公平速度对比。

## 验证与本地测试

- `npm test`：125 项通过，包括新旧对话 provider、Luna max、Fast、论文上下文、流式回答等回归检查。
- `npm run check`：TypeScript 与生产构建通过。
- 真实 Codex 调用：完整资料首问、追问、冷进程恢复旧对话均完成。

退出之前启动的本地开发实例，在仓库目录运行 `npm start`，即可使用已构建的
本地修复版。安装版须在 v1.2.3 Release 发布完成后，通过应用内更新获取修复。
