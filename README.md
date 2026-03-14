# dify-teams-bot

## 概览

这是一个基于 Microsoft Bot Framework 的 Teams 机器人示例项目，核心目标是把用户在 Teams 中发送的消息转发到 Dify，并把 Dify 的回答返回给用户。

项目支持两种回复方式：

1. 一次性回复：等待 Dify 完整答案后一次发送。
2. 流式回复：先发送一次 typing，再按增量文本更新同一条消息，最终补齐完整答案。

## 目录结构

```text
.
├── bot.js                         # 机器人核心对话逻辑（消息处理、流式更新、回退策略）
├── index.js                       # Web 服务入口，挂载 Bot Framework Adapter
├── services/
│   └── difyClient.js              # Dify API 客户端（请求、SSE 解析、异常封装）
├── deploymentScripts/             # 部署脚本（Linux/Windows）
├── deploymentTemplates/           # Azure 部署模板
├── .env.example                   # 环境变量模板
├── docker-compose.yml             # 本地容器编排
├── Dockerfile                     # 镜像构建文件
└── document/
	 └── teams-streaming.md         # Teams Streaming 调优与排障说明
```

## 主要文件说明

1. `index.js`
    - 启动 Express 服务。
    - 创建 Bot Framework `CloudAdapter`。
    - 暴露 `/api/messages` 接口处理来自 Teams 的消息。

2. `bot.js`
    - 处理 `onMessage` 事件。
    - 根据环境变量判断是否开启流式输出。
    - 与 Dify 客户端配合，按增量更新 Teams 消息。
    - 在更新失败时自动回退为一次性发送，保证用户一定能收到最终答案。

3. `services/difyClient.js`
    - 封装 Dify 请求。
    - 解析 SSE 流式返回（`data:` 块）。
    - 统一抛出请求错误和流解析错误，便于上层处理。

4. `.env.example`
    - 提供运行本项目所需的最小配置模板。
    - 包含 Teams 应用凭据、Dify 接口、流式节流参数等。

## 说明与注意事项

1. 配置建议先从 `.env.example` 复制到 `.env` 再填写密钥。
2. 流式体验调优建议查看文档：[Teams Streaming 说明](document/teams-streaming.md)。
3. 生产环境不要提交真实密钥（`MicrosoftAppPassword`、`API_KEY` 等）。
4. 如果频道不支持消息更新，代码会自动走 one-shot 回退，不会影响最终可用性。
