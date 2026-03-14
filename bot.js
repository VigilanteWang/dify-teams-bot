// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
const path = require('path');

const { ActivityHandler, ActivityTypes, MessageFactory } = require('botbuilder');
const { DifyClient, DifyRequestError, DifyStreamError } = require('./services/difyClient');

const dotenv = require('dotenv');
// Import required bot configuration.
const ENV_FILE = path.join(__dirname, '.env');
dotenv.config({ path: ENV_FILE });
const conversationIdsByUser = new Map();

const DEFAULT_STREAM_UPDATE_INTERVAL_MS = 700;
const DEFAULT_STREAM_MIN_CHARS = 20;
const DEFAULT_STREAM_FIRST_MESSAGE_MIN_CHARS = 10;
const DEFAULT_STREAM_CHANNELS = ['msteams', 'webchat', 'directline'];

function parseBooleanFlag(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function parseChannelAllowList(value) {
    if (!value) {
        return new Set(DEFAULT_STREAM_CHANNELS);
    }

    const channels = String(value)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

    if (channels.length === 0) {
        return new Set(DEFAULT_STREAM_CHANNELS);
    }

    return new Set(channels);
}

const clientStreamingConfig = {
    enabled: parseBooleanFlag(process.env.BOT_STREAMING_ENABLED, false),
    allowedChannels: parseChannelAllowList(process.env.BOT_STREAMING_CHANNELS),
    updateIntervalMs: parsePositiveInt(
        process.env.BOT_STREAM_UPDATE_INTERVAL_MS,
        DEFAULT_STREAM_UPDATE_INTERVAL_MS
    ),
    minCharsDelta: parsePositiveInt(
        process.env.BOT_STREAM_MIN_CHARS_DELTA,
        DEFAULT_STREAM_MIN_CHARS
    ),
    firstMessageMinChars: parsePositiveInt(
        process.env.BOT_STREAM_FIRST_MESSAGE_MIN_CHARS,
        DEFAULT_STREAM_FIRST_MESSAGE_MIN_CHARS
    )
};

function resolveUserKey(context) {
    const channelId = context.activity.channelId || 'unknown';
    const userId =
        (context.activity.from && context.activity.from.id) ||
        (context.activity.conversation && context.activity.conversation.id) ||
        'anonymous';

    return `${channelId}:${userId}`;
}

function toUserErrorMessage(error) {
    const fallbackMessage =
        'I hit an issue while talking to Dify. Please try again in a few seconds.';

    if (error instanceof DifyRequestError) {
        const parts = [
            'Dify request failed.',
            error.status ? `status=${error.status}` : null,
            error.code ? `code=${error.code}` : null,
            error.message ? `message=${error.message}` : null
        ].filter(Boolean);
        return `${parts.join(' ')}\n${fallbackMessage}`;
    }

    if (error instanceof DifyStreamError) {
        return `Dify streaming response was invalid: ${error.message}.\n${fallbackMessage}`;
    }

    return fallbackMessage;
}

function shouldStreamToClient(context) {
    if (!clientStreamingConfig.enabled) {
        return false;
    }

    const channelId = (context.activity.channelId || '').toLowerCase();
    if (!channelId) {
        return false;
    }

    return clientStreamingConfig.allowedChannels.has(channelId);
}

async function collectDifyAnswer(client, { query, user, conversationId, onPartialText }) {
    let answer = '';
    let updatedConversationId = conversationId;
    let streamEnded = false;

    for await (const eventPayload of client.streamChatMessage({
        query,
        user,
        conversationId,
        inputs: {}
    })) {
        if (eventPayload.conversation_id) {
            updatedConversationId = eventPayload.conversation_id;
        }

        switch (eventPayload.event) {
            case 'message':
                answer += eventPayload.answer || '';
                if (onPartialText && answer) {
                    await onPartialText(answer);
                }
                break;
            case 'message_replace':
                answer = eventPayload.answer || '';
                if (onPartialText && answer) {
                    await onPartialText(answer);
                }
                break;
            case 'message_end':
                streamEnded = true;
                break;
            case 'error':
                throw new DifyStreamError(
                    `Dify stream error: ${eventPayload.message || 'Unknown error'}`,
                    {
                        code: eventPayload.code,
                        status: eventPayload.status,
                        event: eventPayload.event,
                        raw: eventPayload
                    }
                );
            case 'ping':
                break;
            default:
                break;
        }
    }

    if (!streamEnded && answer.length === 0) {
        throw new DifyStreamError('Dify stream ended without answer content.');
    }

    return {
        answer,
        conversationId: updatedConversationId
    };
}

class EchoBot extends ActivityHandler {
    constructor() {
        super();
        this.difyClient = new DifyClient();

        // See https://aka.ms/about-bot-activity-message to learn more about the message and other activity types.
        this.onMessage(async (context, next) => {
            const userKey = resolveUserKey(context);

            try {
                const userMessage = (context.activity.text || '').trim();
                if (!userMessage) {
                    await context.sendActivity('Please send a text message.');
                    await next();
                    return;
                }

                const streamToClient = shouldStreamToClient(context);
                let replyActivityId = '';
                let lastUpdatedText = '';
                let lastUpdateAt = 0;
                let updateFailed = false;

                if (streamToClient) {
                    try {
                        await context.sendActivity({ type: ActivityTypes.Typing });
                    } catch (error) {
                        console.warn('Unable to send typing activity', {
                            message: error.message,
                            channelId: context.activity.channelId
                        });
                    }
                }

                const onPartialText = async (partialText) => {
                    if (updateFailed || !partialText) {
                        return;
                    }

                    const now = Date.now();

                    if (!replyActivityId) {
                        if (partialText.length < clientStreamingConfig.firstMessageMinChars) {
                            return;
                        }

                        try {
                            const initialReply = await context.sendActivity(
                                MessageFactory.text(partialText, partialText)
                            );
                            replyActivityId =
                                initialReply && initialReply.id ? initialReply.id : '';
                            lastUpdatedText = partialText;
                            lastUpdateAt = now;
                        } catch (error) {
                            updateFailed = true;
                            console.warn(
                                'Initial streamed message send failed, fallback to one-shot.',
                                {
                                    message: error.message,
                                    channelId: context.activity.channelId
                                }
                            );
                        }
                        return;
                    }

                    const hasMeaningfulDelta =
                        partialText.length - lastUpdatedText.length >=
                        clientStreamingConfig.minCharsDelta;
                    const dueByTime = now - lastUpdateAt >= clientStreamingConfig.updateIntervalMs;

                    if (!hasMeaningfulDelta && !dueByTime) {
                        return;
                    }

                    try {
                        await context.updateActivity({
                            id: replyActivityId,
                            type: ActivityTypes.Message,
                            text: partialText
                        });

                        lastUpdatedText = partialText;
                        lastUpdateAt = now;
                    } catch (error) {
                        updateFailed = true;
                        console.warn('Incremental update failed, fallback to one-shot.', {
                            message: error.message,
                            channelId: context.activity.channelId
                        });
                    }
                };

                const difyResult = await collectDifyAnswer(this.difyClient, {
                    query: userMessage,
                    user: userKey,
                    conversationId: conversationIdsByUser.get(userKey) || '',
                    onPartialText: streamToClient ? onPartialText : null
                });

                if (difyResult.conversationId) {
                    conversationIdsByUser.set(userKey, difyResult.conversationId);
                }

                const answer = difyResult.answer || '(No answer from Dify)';

                if (replyActivityId && !updateFailed) {
                    if (answer !== lastUpdatedText) {
                        try {
                            await context.updateActivity({
                                id: replyActivityId,
                                type: ActivityTypes.Message,
                                text: answer
                            });
                        } catch (error) {
                            console.warn('Final activity update failed, sending new message.', {
                                message: error.message,
                                channelId: context.activity.channelId
                            });
                            await context.sendActivity(MessageFactory.text(answer, answer));
                        }
                    }
                } else {
                    // Fallback path for channels or clients that cannot render message updates.
                    await context.sendActivity(MessageFactory.text(answer, answer));
                }

                // By calling next() you ensure that the next BotHandler is run.
                await next();
            } catch (err) {
                console.error('Dify bot error', {
                    message: err.message,
                    name: err.name,
                    status: err.status,
                    code: err.code,
                    raw: err.raw,
                    stack: err.stack
                });

                await context.sendActivity(MessageFactory.text(toUserErrorMessage(err)));
            }
        });

        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
            const welcomeText =
                'This bot routes your messages to Dify and returns the generated response.';
            for (let cnt = 0; cnt < membersAdded.length; ++cnt) {
                if (membersAdded[cnt].id !== context.activity.recipient.id) {
                    await context.sendActivity(MessageFactory.text(welcomeText, welcomeText));
                }
            }
            // By calling next() you ensure that the next BotHandler is run.
            await next();
        });
    }
}

module.exports.EchoBot = EchoBot;
