// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const path = require('path');

const dotenv = require('dotenv');
// 读取 .env 中的运行配置（端口、Bot 凭据等）。
const ENV_FILE = path.join(__dirname, '.env');
dotenv.config({ path: ENV_FILE });

const express = require('express');

// Bot Framework 适配器相关类型：
// - ConfigurationBotFrameworkAuthentication: 从环境变量构建鉴权信息
// - CloudAdapter: 负责把 HTTP/WebSocket 请求转成 bot turn 处理
const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require('botbuilder');

// 业务 Bot 主体（消息处理逻辑在 bot.js 中）。
const { EchoBot } = require('./bot');

// 创建 HTTP 服务；Bot Framework 渠道会通过 /api/messages 回调到这里。
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = app.listen(process.env.port || process.env.PORT || 3978, () => {
    console.log(`\nApp listening to ${server.address().port}`);
    console.log('\nGet Bot Framework Emulator: https://aka.ms/botframework-emulator');
    console.log('\nTo talk to your bot, open the emulator select "Open Bot"');
});

// 从 process.env 读取 Microsoft AppId/Password 等 Bot 鉴权配置。
const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(process.env);

// 主适配器：用于普通 HTTP 请求（最常见场景）。
const adapter = new CloudAdapter(botFrameworkAuthentication);

// 全局 turn 级错误处理：任何未捕获异常都会走这里。
const onTurnErrorHandler = async (context, error) => {
    // 本地开发先打控制台；生产建议接入集中式日志/遥测系统。
    console.error(`\n [onTurnError] unhandled error: ${error}`);

    // Emulator 可看到 Trace，方便排查调用链与异常栈。
    await context.sendTraceActivity(
        'OnTurnError Trace',
        `${error}`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
    );

    // 给终端用户一个可见提示，避免“无响应”。
    await context.sendActivity('The bot encountered an error or bug.');
    await context.sendActivity('To continue to run this bot, please fix the bot source code.');
};

// 给主适配器绑定统一错误处理函数。
adapter.onTurnError = onTurnErrorHandler;

// 初始化 Bot 实例（整个进程复用）。
const myBot = new EchoBot();

// HTTP 入口：Bot Connector 把消息 POST 到 /api/messages。
app.post('/api/messages', async (req, res) => {
    // adapter.process 会创建 turn context，再交给 myBot.run 执行。
    await adapter.process(req, res, (context) => myBot.run(context));
});

// WebSocket 升级入口：用于 Azure Bot Service streaming 连接。
server.on('upgrade', async (req, socket, head) => {
    // 每条 WS 连接单独创建适配器，便于隔离连接级状态。
    console.log(
        '>>> [Streaming Check] WebSocket Upgrade Request Received! Using WebSocket Adapter.'
    );
    const streamingAdapter = new CloudAdapter(botFrameworkAuthentication);
    // 复用同一套错误处理，确保 HTTP/WS 行为一致。
    streamingAdapter.onTurnError = onTurnErrorHandler;

    // 对该 socket 连接持续处理消息 turn。
    await streamingAdapter.process(req, socket, head, (context) => myBot.run(context));
});
