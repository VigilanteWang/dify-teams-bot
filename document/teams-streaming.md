# Teams Streaming 实践说明

## 背景

本项目采用的是 Bot Framework 的常见流式模式：

1. 先发送一次 typing activity，提示“机器人正在处理”。
2. 当 Dify 返回首批可展示文本后，发送首条消息。
3. 后续将增量文本通过 updateActivity 更新同一条消息。
4. 结束时再做一次最终对齐，确保最终文本完整。

这种方式兼顾了用户感知速度与平台稳定性。

## 我们讨论过的关键点

### 1. typing 何时消失

- 协议层没有单独的“stop typing activity”。
- 客户端通常会在以下场景隐藏 typing：
    1. 收到新的 message activity。
    2. typing 状态到期（客户端实现相关）。

因此，“发送消息后 typing 消失”通常是预期行为。

### 2. 为什么需要流式节流

如果每个 token 都立即更新 Teams，容易出现：

1. UI 抖动明显。
2. 请求频率过高，可能被节流。
3. updateActivity 失败率上升。

所以项目中通过“字符增量 + 时间间隔”双阈值控制更新节奏。

### 3. 首条消息门槛

首条消息太短会让界面频繁闪烁，因此新增了“首条最小字符数”策略：

- `BOT_STREAM_FIRST_MESSAGE_MIN_CHARS`

在未达到阈值时先等待更多文本，达到后再发送首条消息。

## 如何调环境变量（给初级开发者）

以下变量在 `.env` 中配置：

1. `BOT_STREAMING_ENABLED`
    - 是否开启流式输出。
    - `true`：启用流式。
    - `false`：只发最终完整消息。

2. `BOT_STREAMING_CHANNELS`
    - 允许流式输出的频道列表（逗号分隔）。
    - 示例：`msteams,webchat,directline`。

3. `BOT_STREAM_UPDATE_INTERVAL_MS`
    - 两次 updateActivity 的最小时间间隔。
    - 建议初始值：`1000`。
    - 太小会更“丝滑”但更容易抖动或被限流。

4. `BOT_STREAM_MIN_CHARS_DELTA`
    - 与上次已展示文本相比，最少新增多少字符才触发更新。
    - 建议初始值：`20`。

5. `BOT_STREAM_FIRST_MESSAGE_MIN_CHARS`
    - 首条消息的最小字符数。
    - 建议值：`10`。
    - 如果你希望更早看到首条回复，可调小到 `6-8`。

## 调优建议

1. 回复看起来太慢：
    - 适当降低 `BOT_STREAM_UPDATE_INTERVAL_MS`（例如 800）。
    - 适当降低 `BOT_STREAM_MIN_CHARS_DELTA`（例如 12-16）。

2. 回复看起来太抖：
    - 增大 `BOT_STREAM_UPDATE_INTERVAL_MS`（例如 1200-1500）。
    - 增大 `BOT_STREAM_MIN_CHARS_DELTA`（例如 25-40）。

3. 首条出现太晚：
    - 降低 `BOT_STREAM_FIRST_MESSAGE_MIN_CHARS`。

## 排障清单

1. 首条消息不出现：
    - 检查 `BOT_STREAM_FIRST_MESSAGE_MIN_CHARS` 是否过高。

2. 一直不是流式：
    - 检查 `BOT_STREAMING_ENABLED=true`。
    - 检查当前 channel 是否在 `BOT_STREAMING_CHANNELS` 内。

3. update 失败后变成一次性输出：
    - 这是设计好的回退行为，保证最终答案可达。
