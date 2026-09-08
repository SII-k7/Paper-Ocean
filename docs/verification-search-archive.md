# 标题联想与对话论文归档验证

后续验收：用户已在本机测试并确认体验良好；本次 v1.0.0 UI 验证再次确认 Luna max 正常出现在可用配置中。以下重连失败保留为当时单次请求的记录，不代表当前持续故障。

当前模型更新：按用户最新指示切换为 `gpt-5.6-luna` / `max`。下文 Astra 验证保留为历史记录。“无 Astra 权限”不能由模型列表缺失单独证实；准确结论是当前本机客户端没有提供 Astra。

本轮实时模型列表包含 Luna，支持 low、medium、high、xhigh、max；生产窗口显示 `GPT-5.6 Luna · max` 且无不可用标记。104 项测试和类型／构建检查通过，包含旧 Astra medium 请求被切换为 Luna max。固定 OK 连接测试实际发送 Luna max，但流返回 `Reconnecting... 2/5`，未得到回答，不宣称完整生成成功。请求未含论文或附件。

日期：2026-09-08。功能已加入当前源码，尚未发布新版安装包。

## 实际验证

- Windows Electron 生产构建中，输入 `SplitAdap` 即时出现本地标题；Escape 收起联想。
- 输入 `openvl` 出现 OpenVLA，方向键选中并回车后成功下载 13,240,309 字节 PDF，渲染正文并建立 37 页索引。
- Semantic Scholar 详情接口实测返回 429、arXiv 搜索接口出现超时；补上 OpenAlex 相同标题与 arXiv 地址交叉核对后，完成上述下载流程。
- 资料库显示归档状态；实际验证手动将 SplitAdapter 改为 VLA，再恢复自动判断为运动控制，完成后核验副本存在。
- 归档目标在部分磁盘上创建硬链接返回 EISDIR；增加排他复制兼容处理，仍不覆盖已有文件。临时文件在结束时清理，归档记录在完整副本生成后写入。
- 真实原资料库中的 SplitAdapter 和 Robot Trains Robot 已归档到 `D:\paper\运动控制`，分别为 11,658,774 和 4,704,034 字节；SHA-256 内容标识与源 PDF 一致。没有对话的 DrEureka 未归档。测试用 PDF 与测试对话使用独立目录。

自动检查：`npm run check` 通过；`npm test` 103 项通过；`git diff --check` 通过。覆盖标题片段、拼写误差、缓存、查询失败、来源标识校验、备用来源同名核对、对话范围、分类、复制与改分类、缺失原件、内容冲突，以及 Web 身份与 CSRF 校验。

截图和实测结果位于被 Git 忽略的 `output/playwright/search-archive-20260908/`：`online-suggestions.png`、`opened-from-title.png`、`archive-library.png`、`checks.json`、`real-backfill.json`。

## 边界

本次续改将阅读模型固定为 `gpt-6-astra` / `medium`，移除模型切换入口；前端忽略旧选择，后端强制固定配置，Web 验证同样限制新请求。104 项测试和类型／构建检查通过，包含旧模型／旧强度不会影响实际请求、Astra 不可用时不降级。

当前实机 Codex 0.146.0 的 `model/list` 没有返回 Astra。另用新建空目录和固定字符串“连接测试，请仅回复 OK”尝试指定模型，`thread/start` 回显 `gpt-6-astra`，`turn/start` 发送 medium，但后续流报告域名解析失败（Windows 11001），没有获得回答。因此配置与请求路径已验证，Astra 成功回答尚未验证。该测试不包含论文、历史或附件；带原文的试问被自动审批拒绝，未执行。

标题片段联想、最小窗口排版与实际 D:\paper 的两份归档已在本次生产构建中重新检查。模型连接失败改为提问区内的中文提示和重试按钮，避免全局错误条遮住搜索建议。

再次以公开关键词 `openvl` 检查在线联想，实际返回 OpenVLA 并排列首位。读取当前原资料库确认有对话的论文共两篇，并重新对 D:\paper 副本计算 SHA-256 与论文内容 ID 核验，均匹配。

模型标识与 medium 支持范围另据 [OpenAI 模型文档](https://developers.openai.com/api/docs/models/gpt-6-astra) 核对；公开 API 文档不能代替本机订阅可用性验证。

在线服务仍可能同时不可用，失败时保留输入并提示重试；本地匹配可继续使用。分类为可解释的文本规则，用户可手动修正，无法确定时保留在待分类。归档仅保存 PDF，不代替完整对话与笔记备份；多个独立应用资料库的分类设置不自动同步。

## 当前请求复核

重新执行 104 项测试、类型检查与生产构建，全部通过。修正搜索框尚未选中任何结果时按 ArrowUp 的起始索引：现在选中最后一项，不再错选倒数第二项。

实际 Electron 窗口验证 `SplitAdap` 本地模糊匹配、ArrowUp 选中、Enter 打开 PDF；在线输入 `openvl` 返回 OpenVLA 并列首位。资料库显示 D:\paper 已保存两篇。再次从原资料库计算有对话的论文集合，并对 D:\paper 的实际副本计算 SHA-256：SplitAdapter、Robot Trains Robot 两份内容标识均匹配。

本轮实时读取 Codex 模型列表仍返回“当前 Codex 账户没有可用的 GPT-6 Astra 模型”。没有发送论文、附件或模型试问；界面明确显示 Astra medium 暂不可用。可继续验证搜索与归档，不能据此宣称 Astra 回答已验证成功。

本轮截图：`current-online-suggestions.png`、`current-archive-library.png`。新版试用窗口标题为“Paper Ocean · 搜索归档新版”，对话资料使用独立持久化目录，PDF 归档位置仍是 D:\paper。

参考接口：[Semantic Scholar autocomplete](https://api.semanticscholar.org/api-docs/snippets)、[arXiv API 用户手册](https://info.arxiv.org/help/api/user-manual.html)。OpenAlex 复用现有推荐模块所用的 works 检索与 locations 数据，并以实际响应核验。
