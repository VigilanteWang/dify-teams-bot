# dify-teams-bot

## 概览

这是一个基于 Microsoft Bot Framework 和 Express 的 Teams Bot 示例。它把用户在 Teams 中发送的文本消息转发给 Dify，并将 Dify 的回答回传到会话中。

Teams 对话回复支持两种模式：

1. 一次性回复：等待 Dify 返回完整答案后，再发送一条普通消息。
2. 兼容型伪流式回复：先发送一个 typing activity，再发送首条 message activity，随后通过 updateActivity 持续覆盖同一条消息内容，形成类似打字机的体验。

这里的“流式”是兼容方案，不等同于 Microsoft Teams Streaming UX 原生能力。项目这样设计，是为了兼容尚未完整实现 Streaming UX 的 Teams 客户端场景，包括部分中国区 Teams 环境。详细说明见 [document/teams-streaming.md](/workspaces/dify-teams-bot/document/teams-streaming.md)。

## 实际目录结构

```text
.
├── .env.example
├── Dockerfile
├── README.md
├── bot.js
├── dify-api.txt
├── docker-compose.yml
├── eslint.config.js
├── index.js
├── package.json
├── document/
│   └── teams-streaming.md
└── services/
    └── difyClient.js
```

## 核心文件职责

### bot.js

[bot.js](/workspaces/dify-teams-bot/bot.js) 是机器人主逻辑，代码注释里已经说明了几个关键设计点：

1. 使用 conversationIdsByUser 维护“频道 + 用户”到 Dify conversation_id 的映射，用于延续多轮上下文。
2. 通过 parseBooleanFlag、parsePositiveInt、parseChannelAllowList 统一解析环境变量，避免无效配置直接进入运行逻辑。
3. 通过 shouldStreamToClient 判断当前 turn 是否允许做客户端增量更新，而不是默认对所有渠道启用。
4. collectDifyAnswer 负责消费 Dify 的 SSE 事件流，并把 message、message_replace、message_end、error、ping 等事件转换为 Bot 可用的答案状态。
5. onPartialText 使用“首条最小字符数 + 最小字符增量 + 最小更新时间间隔”三套门槛做节流，避免每个 token 都触发一次 Teams 消息更新。
6. 如果 sendActivity 或 updateActivity 失败，会切换到 one-shot 回退路径，确保用户至少能收到最终完整答案。
7. toUserErrorMessage 会把 DifyRequestError 和 DifyStreamError 转成更适合终端用户阅读的提示，而不是直接暴露内部异常堆栈。

### index.js

[index.js](/workspaces/dify-teams-bot/index.js) 是服务入口，负责：

1. 读取 .env 配置并启动 Express。
2. 创建 Bot Framework 的 ConfigurationBotFrameworkAuthentication 和 CloudAdapter。
3. 暴露 /api/messages 作为 Bot Connector 的 HTTP 入口。
4. 通过 onTurnErrorHandler 统一处理 turn 级异常。
5. 监听 upgrade 事件，为 WebSocket 连接创建独立的 CloudAdapter。

需要注意，index.js 里的 WebSocket upgrade 支持的是 Bot Framework streaming transport；它不代表 Teams 客户端一定支持 Streaming UX。真正给终端用户看到“正在输出”的体验，仍然是 bot.js 里基于 typing 和 updateActivity 做的兼容式实现。

### services/difyClient.js

[services/difyClient.js](/workspaces/dify-teams-bot/services/difyClient.js) 负责 Dify API 访问和流解析：

1. DifyClient 在启动时检查 API_ENDPOINT、API_KEY 和全局 fetch 是否可用。
2. streamChatMessage 以 response_mode=streaming 调用 Dify /chat-messages 接口。
3. parseSseEvents 负责把 text/event-stream 里的 data: 块还原成逐条事件。
4. DifyRequestError 统一表示 HTTP 层、网络层、超时层异常。
5. DifyStreamError 统一表示 SSE 数据格式不合法或流式事件异常。
6. readErrorPayload 尽量把 JSON 或文本错误体保留下来，便于日志排查。

### 其他文件

1. [.env.example](/workspaces/dify-teams-bot/.env.example)：最小运行配置模板，包含 Bot 身份、Dify 地址、超时和伪流式阈值配置。
2. [docker-compose.yml](/workspaces/dify-teams-bot/docker-compose.yml)：本地容器编排，挂载 .env 到容器内的 /app/.env。
3. [Dockerfile](/workspaces/dify-teams-bot/Dockerfile)：基于 Node.js 20 镜像构建运行环境。
4. [eslint.config.js](/workspaces/dify-teams-bot/eslint.config.js)：ESLint flat config，启用推荐规则并关闭与 Prettier 冲突的规则。
5. [dify-api.txt](/workspaces/dify-teams-bot/dify-api.txt)：Dify chat-messages API 摘录，说明 streaming 模式的 SSE 事件结构。

## 请求处理流程

### 1. 用户消息进入 Bot

Teams 把用户消息发送到 Bot Framework，服务入口 [index.js](/workspaces/dify-teams-bot/index.js) 通过 /api/messages 把请求交给 EchoBot。

### 2. Bot 决定是否使用兼容型伪流式输出

[bot.js](/workspaces/dify-teams-bot/bot.js) 会同时检查：

1. BOT_STREAMING_ENABLED 是否启用。
2. 当前 channelId 是否在 BOT_STREAMING_CHANNELS 允许列表里。

只有同时满足这两个条件，才会尝试发送 typing 并更新同一条消息；否则直接等待 Dify 完整答案后一次性回复。

### 3. Bot 调用 Dify 获取 SSE 流

Bot 调用 [services/difyClient.js](/workspaces/dify-teams-bot/services/difyClient.js) 中的 streamChatMessage，请求 Dify 的 streaming 响应。Dify 会持续返回 message、message_replace、message_end、ping 等事件。

### 4. Bot 将 Dify 事件转换为 Teams 活动

1. 首先发送 type=typing 的 activity，让用户知道机器人正在处理。
2. 当累计文本达到首条门槛后，发送首条 type=message 的 activity。
3. 随着 Dify 返回更多文本，调用 updateActivity 覆盖这条已有消息的 text。
4. Dify 结束后，再做一次最终对齐，确保客户端里显示的是完整答案。
5. 如果任何增量发送失败，直接回退成一次性发送最终答案。

## 环境变量

以下配置来自 [.env.example](/workspaces/dify-teams-bot/.env.example)：

1. MicrosoftAppType、MicrosoftAppId、MicrosoftAppPassword、MicrosoftAppTenantId：Bot Framework 身份配置。
2. API_ENDPOINT、API_KEY：Dify chat-messages 接口地址和鉴权密钥。
3. DIFY_TIMEOUT_MS：Dify 请求超时，默认 90000 毫秒。
4. BOT_STREAMING_ENABLED：是否启用兼容型伪流式输出。
5. BOT_STREAMING_CHANNELS：允许伪流式输出的 channel 列表。
6. BOT_STREAM_UPDATE_INTERVAL_MS：两次 updateActivity 之间的最小时间间隔。
7. BOT_STREAM_MIN_CHARS_DELTA：触发下一次消息更新前，至少新增多少字符。
8. BOT_STREAM_FIRST_MESSAGE_MIN_CHARS：首条消息最少字符数，避免首条太短导致 UI 抖动。

## 本地运行

### Node.js 方式

1. 复制 [.env.example](/workspaces/dify-teams-bot/.env.example) 为 .env 并填写真实配置。
2. 安装依赖：npm install
3. 启动服务：npm start
4. 默认监听端口为 3978。

### Docker Compose 方式

1. 准备好本地 .env。
2. 运行：docker compose up --build
3. 容器会把宿主机的 .env 挂载到 /app/.env。

## 可用脚本

来自 [package.json](/workspaces/dify-teams-bot/package.json)：

1. npm start：启动服务。
2. npm run watch：使用 nodemon 监听变更。
3. npm run lint：执行 ESLint。
4. npm run lint:fix：自动修复可修复的 lint 问题。
5. npm run format：执行 Prettier 格式化。
6. npm run format:check：检查格式。

## 注意事项

1. 当前文档中的“流式输出”指兼容型伪流式，不代表 Teams 客户端已启用 Streaming UX 原生体验。
2. 如果某个渠道不支持 updateActivity，或更新过程中失败，代码会自动回退为最终一次性发送。
3. 真实生产环境不要提交 MicrosoftAppPassword、API_KEY 等敏感信息。
4. 如果你需要理解当前兼容方案为什么这样实现，优先阅读 [document/teams-streaming.md](/workspaces/dify-teams-bot/document/teams-streaming.md)。
