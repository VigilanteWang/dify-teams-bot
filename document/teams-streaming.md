# Teams 兼容型伪流式说明

## 这份文档在说明什么

这份文档说明的是本项目在 [bot.js](/workspaces/dify-teams-bot/bot.js) 里采用的“兼容型伪流式输出”方案。

它的目标不是实现 [Microsoft Teams Streaming UX](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux) 的原生体验，而是在客户端尚未完整支持 Streaming UX 时，仍然提供一种“用户看起来像在持续输出”的兼容方案。当前实现特别适合以下场景：

1. 你想对接 Dify 这类会持续返回文本块的后端。
2. 你希望用户尽快看到机器人开始响应，而不是长时间无反馈。
3. 你需要兼容部分尚未完整实现 Teams Streaming UX 的客户端，包括一些中国区 Teams 使用场景。

## 先区分两种不同的 streaming

很多人会把这两件事混在一起，但它们不是同一个层面：

### 1. 传输层 streaming

这是 Bot Framework 连接层的能力，例如 [index.js](/workspaces/dify-teams-bot/index.js) 中的 WebSocket upgrade。它的启用意味着Azure Bot Service 和 后端应用 使用 WebSocket 而不是 HTTP Post 进行消息传输。

### 2. 客户端 UI 层 streaming

这是用户在 Teams 界面里看到的“机器人正在逐步输出答案”的体验。Microsoft 官方文档里提到的 Teams Streaming UX 属于这个层面。

本项目当前实现的不是 Teams Streaming UX 原生协议，而是用标准 Bot Framework activity 组合出近似效果：

1. 先发送一个 type=typing 的 activity。
2. 然后发送一个 type=message 的 activity。
3. 再不断调用 updateActivity 更新这条 message activity 的 text。

因为这些都是 Bot Framework 的标准行为，所以兼容性通常比依赖客户端新特性的原生 Streaming UX 更稳。

## 为什么当前项目用这种兼容方案

原因很直接：Dify 的 /chat-messages 接口在 response_mode=streaming 时，会通过 SSE 持续返回文本片段，但 Teams 客户端是否能把这些片段直接渲染成原生流式体验，并不总是可控。

所以 [bot.js](/workspaces/dify-teams-bot/bot.js) 采取的是一种更保守也更兼容的做法：

1. Dify 持续吐文本块。
2. Bot 在服务端先把文本块拼接起来。
3. 每当文本累积到一定程度，就把“当前完整文本”覆盖写回同一条消息。
4. 如果覆盖写回失败，就退化为最终一次性发送完整答案。

从用户视角看，这像是“打字机效果”；从实现视角看，本质上还是标准 message activity 的多次更新。

## 不懂 Bot Framework 也能理解的背景知识

### 什么是 Activity

在 Bot Framework 里，Bot 和渠道之间交换的基本消息对象叫 Activity。你可以把它理解成“机器人发出的一次动作”。

常见的 Activity 包括：

1. type=message：真正显示在聊天窗口里的消息。
2. type=typing：告诉客户端“机器人正在输入中”。
3. type=trace：主要给调试工具看，不给普通用户看。

在代码里通常会看到常量写法：

1. ActivityTypes.Message，对应真实 activity.type 值 message。
2. ActivityTypes.Typing，对应真实 activity.type 值 typing。

也就是说，下面这段代码：

```js
await context.sendActivity({ type: ActivityTypes.Typing });
```

实际发出去的是一个 type=typing 的 activity。

而下面这种：

```js
await context.updateActivity({
    id: replyActivityId,
    type: ActivityTypes.Message,
    text: partialText
});
```

实际更新的是一个 type=message 的 activity。

### 什么是 typing

typing 不是一条聊天内容，它更像一个临时状态提示。客户端通常会把它显示成“机器人正在输入”或者类似的占位动效。

它有两个关键特点：

1. typing 本身不会承载最终答案文本。
2. typing 通常会在客户端超时后自动消失，或者在收到新的 message 后被替代。

协议层没有一个通用的“stop typing”独立命令，所以常见做法不是“停止 typing”，而是直接发 message，让客户端自然切换到真正的消息展示。

## 当前 bot.js 的完整执行流程

下面按一次用户提问的顺序解释整个流程。

### 第 1 步：Teams 把用户消息发给 Bot

用户在 Teams 输入文本后，请求会进入 [index.js](/workspaces/dify-teams-bot/index.js) 的 /api/messages，再交给 EchoBot 处理。

### 第 2 步：Bot 判断要不要启用兼容型伪流式

[bot.js](/workspaces/dify-teams-bot/bot.js) 会调用 shouldStreamToClient，判断两个条件：

1. BOT_STREAMING_ENABLED 是否为 true。
2. 当前渠道是否在 BOT_STREAMING_CHANNELS 中。

如果任何一个条件不满足，就不做伪流式，而是等 Dify 完整返回后一次性发送。

### 第 3 步：先发一个 type=typing activity

如果允许伪流式，Bot 会先执行：

```js
await context.sendActivity({ type: ActivityTypes.Typing });
```

这一步的目的只是让用户看到“机器人已经开始处理”，不是发送答案。

### 第 4 步：Bot 请求 Dify 的 SSE 流

[services/difyClient.js](/workspaces/dify-teams-bot/services/difyClient.js) 会向 Dify 发送 response_mode=streaming 的请求。Dify 返回的是 SSE，也就是一段段以 data: 开头、以空行分隔的事件流。

项目里 parseSseEvents 会把这类文本流拆回事件，再交给 collectDifyAnswer 逐条处理。

### 第 5 步：message 事件不断累积答案

当 Dify 返回 event=message 时，说明有新的答案文本片段。代码会把它追加到当前 answer 后面。

如果返回的是 event=message_replace，则不是追加，而是直接整段替换当前答案。这通常用于服务端要求覆盖已有文本的场景。

### 第 6 步：达到门槛后发送首条 type=message activity

Bot 不会在收到第一个字符时立刻发 message，因为那样容易让界面出现很短、很碎的闪烁内容。

因此项目用 BOT_STREAM_FIRST_MESSAGE_MIN_CHARS 控制“首条消息的最小字符数”。只有达到这个门槛，才会执行第一条真正的 message activity：

```js
const initialReply = await context.sendActivity(MessageFactory.text(partialText, partialText));
```

这一步返回的 id 会保存到 replyActivityId，后续 updateActivity 都依赖这个 id。

### 第 7 步：继续用 updateActivity 模拟打字机效果

首条消息发出后，后续不会新增很多条 message，而是重复更新同一条消息：

```js
await context.updateActivity({
    id: replyActivityId,
    type: ActivityTypes.Message,
    text: partialText
});
```

这就是当前项目“看起来像流式输出”的核心。

用户看到的是同一条消息不断变长，而不是聊天窗口里刷出一堆碎片消息。

### 第 8 步：用节流避免抖动和限流

如果 Dify 每来一个 token 就更新一次 Teams，常见问题包括：

1. 聊天窗口抖动明显。
2. updateActivity 调用频率过高。
3. 更容易触发渠道限流或失败。

所以 [bot.js](/workspaces/dify-teams-bot/bot.js) 使用了三道门槛：

1. BOT_STREAM_FIRST_MESSAGE_MIN_CHARS：控制首条 message 不要太短。
2. BOT_STREAM_MIN_CHARS_DELTA：距离上次展示文本，至少新增多少字符才值得更新。
3. BOT_STREAM_UPDATE_INTERVAL_MS：即使字符增量不大，也不要太久不刷新。

这三项合在一起，本质上是在平衡“足够快地让用户看到进度”和“不要频繁到影响稳定性”。

### 第 9 步：收到结束事件后做最终对齐

当 Dify 返回 event=message_end，或流结束后 answer 已经完整，Bot 会再做一次最终检查：

1. 如果当前消息内容和最终 answer 一致，就不再更新。
2. 如果不一致，就再执行一次 updateActivity，把最终完整文本写回去。

这样可以保证客户端最终显示的内容，和 Dify 的完整答案一致。

### 第 10 步：如果中途失败，回退为一次性回复

当前实现非常强调“最终答案必须送达”。因此只要下面任意一步失败：

1. 首条 message 发送失败。
2. 某次 updateActivity 失败。
3. 某个渠道虽然被允许，但运行时不接受更新。

代码就会把 updateFailed 设为 true，停止继续伪流式刷新，最后直接发送完整答案。

这也是为什么当前方案比“强依赖客户端支持某种 Streaming UX”更稳。

## 一个非 Bot Framework 视角的简化理解

如果你完全不熟悉 Bot Framework，可以把当前方案想成下面这个普通 Web 产品逻辑：

1. 用户提交问题。
2. 页面先显示“系统处理中”。
3. 后端从 AI 服务持续拿到文本片段。
4. 页面上的同一个答案框被不断重绘，内容越来越长。
5. 最后答案完成，如果中途局部刷新失败，就直接把最终整段答案重新渲染出来。

Bot Framework 只是把这个过程包装成 typing activity、message activity 和 updateActivity 调用。

## 环境变量说明

这些变量定义在 [.env.example](/workspaces/dify-teams-bot/.env.example)：

### BOT_STREAMING_ENABLED

是否开启兼容型伪流式。

1. true：允许发送 typing 并尝试更新同一条 message。
2. false：完全关闭伪流式，只发最终答案。

### BOT_STREAMING_CHANNELS

允许启用伪流式的渠道列表，逗号分隔。例如 msteams,webchat,directline。

### BOT_STREAM_UPDATE_INTERVAL_MS

两次 updateActivity 之间的最小时间间隔。值越小，刷新越频繁；值越大，刷新越稳但看起来更慢。

### BOT_STREAM_MIN_CHARS_DELTA

相对于上一次已展示文本，至少新增多少字符才触发下一次更新。

### BOT_STREAM_FIRST_MESSAGE_MIN_CHARS

首条 message 最少要积累多少字符才发送。这个值太小会让界面闪，太大又会让首条消息出现得太晚。

## 调优建议

### 如果看起来太慢

1. 适度降低 BOT_STREAM_UPDATE_INTERVAL_MS，例如从 1000 调到 700 到 800。
2. 适度降低 BOT_STREAM_MIN_CHARS_DELTA，例如从 50 调到 20 到 30。
3. 适度降低 BOT_STREAM_FIRST_MESSAGE_MIN_CHARS，让首条消息更早出现。

### 如果看起来太抖

1. 提高 BOT_STREAM_UPDATE_INTERVAL_MS，例如调到 1200 或 1500。
2. 提高 BOT_STREAM_MIN_CHARS_DELTA，减少过于细碎的刷新。
3. 提高 BOT_STREAM_FIRST_MESSAGE_MIN_CHARS，避免首条消息太短。

### 如果你要优先兼容性

1. 保守使用 msteams 等经过验证的渠道列表。
2. 不要把刷新频率调得过高。
3. 保留当前 one-shot fallback，不要在 update 失败后继续强行重试。

## 常见问题

### typing 为什么会消失

因为 typing 只是临时状态提示。客户端通常会在以下情况隐藏它：

1. 收到新的 type=message activity。
2. typing 状态自身超时。

所以“发出首条 message 后 typing 消失”是正常现象。

### 为什么不直接把每个 token 都发成一条消息

因为那样会让聊天窗口出现大量碎片消息，体验很差，也更容易触发渠道限制。更新同一条消息通常更符合聊天产品的展示习惯。

### 为什么这里叫兼容型伪流式

因为它不是 Teams Streaming UX 原生渲染链路，而是用标准 activity 做出的近似体验。它的优势是兼容性更好，尤其适合客户端能力不一致的环境。

## 排障清单

1. 完全没有伪流式效果：检查 BOT_STREAMING_ENABLED 和 BOT_STREAMING_CHANNELS。
2. 首条消息太晚才出现：检查 BOT_STREAM_FIRST_MESSAGE_MIN_CHARS 是否过高。
3. 更新几次后变成一次性输出：这是预期的 fallback，说明某次 sendActivity 或 updateActivity 失败了。
4. typing 出现后很快消失：通常是客户端收到 message 后正常切换，不代表异常。
