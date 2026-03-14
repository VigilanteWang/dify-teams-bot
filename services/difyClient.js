// Dify 请求默认超时时间（毫秒）。
const DEFAULT_TIMEOUT_MS = 90000;

// 非 2xx 或网络层请求异常时抛出的统一错误类型。
class DifyRequestError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DifyRequestError';
        this.status = details.status;
        this.code = details.code;
        // details 通常是 Dify 返回的错误对象，便于上层记录结构化日志。
        this.details = details.details;
        // isRetryable 用于上层判断是否可重试（如 5xx、超时）。
        this.isRetryable = details.isRetryable || false;
        this.raw = details.raw;
    }
}

// Dify 流式返回格式不合法时抛出的错误类型。
class DifyStreamError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DifyStreamError';
        this.event = details.event;
        this.code = details.code;
        this.status = details.status;
        this.raw = details.raw;
    }
}

// 判断是否为 AbortController 触发的超时中断。
function isAbortError(error) {
    return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

// 解析超时配置，非法值回退为默认超时。
function parseTimeoutMs(value) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        // 典型非法值：undefined、空串、负数、NaN。
        return DEFAULT_TIMEOUT_MS;
    }

    return timeout;
}

// 尽可能解析错误响应体（JSON 或纯文本），便于日志与排障。
async function readErrorPayload(response) {
    const text = await response.text();
    if (!text) {
        // 某些网关错误只有状态码，没有响应体。
        return { text: '' };
    }

    try {
        const json = JSON.parse(text);
        return { text, json };
    } catch {
        return { text };
    }
}

// 解析 SSE（Server-Sent Events）数据流。
// Dify streaming 返回是一段段 data: 行，这里把它们还原为消息块。
async function* parseSseEvents(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        // 这里是“增量解码”：把当前 chunk 里的字节尽量转成字符串。
        // 注意它不会强行输出“不完整字符”的半截内容。
        // 如果一个 UTF-8 字符被拆在两个 chunk 之间，TextDecoder 会先把残余字节暂存在内部，
        // 等下一次有新字节到来时再拼成完整字符，因此这里还不代表已经把所有字节都解析了。
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以空行分隔（\n\n）。
        let splitIndex = buffer.indexOf('\n\n');
        while (splitIndex !== -1) {
            const rawEvent = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);

            const dataLines = [];
            for (const rawLine of rawEvent.split(/\r?\n/)) {
                if (rawLine.startsWith('data:')) {
                    // 仅拼接 data 行，忽略 id/event/retry 等其他 SSE 字段。
                    dataLines.push(rawLine.slice(5).trimStart());
                }
            }

            if (dataLines.length > 0) {
                const eventData = dataLines.join('\n').trim();
                if (eventData.length > 0) {
                    yield eventData;
                }
            }

            splitIndex = buffer.indexOf('\n\n');
        }
    }

    // 流结束后再调用一次不带 stream 的 decode，相当于做一次“收尾 flush”。
    // 作用不是重复解码，而是把 TextDecoder 内部缓存的最后残余字节也输出出来。
    // 否则如果最后一个字符刚好被拆包，末尾字符可能丢失或乱码。
    buffer += decoder.decode();
    const finalData = buffer.trim();
    if (finalData) {
        // 处理流结束时尚未被 \n\n 切分的尾部数据。
        // 前面的 while 只会处理“已经遇到完整事件分隔符”的内容；
        // 如果最后一个 SSE 事件后面没有补完整空行，它会留在 buffer 里。
        // 这里就是把这段尾包当成“最后一个可能的事件”再解析一次，避免漏掉最后一条消息。
        const dataLines = [];
        for (const rawLine of finalData.split(/\r?\n/)) {
            if (rawLine.startsWith('data:')) {
                dataLines.push(rawLine.slice(5).trimStart());
            }
        }

        if (dataLines.length > 0) {
            // 多个 data: 行在 SSE 语义上属于同一个事件，这里按换行重新拼回去再产出。
            yield dataLines.join('\n').trim();
        }
    }
}

// Dify API 客户端：负责请求、流解析、错误归一化。
class DifyClient {
    constructor(options = {}) {
        // 支持通过构造参数覆盖，也支持读取环境变量。
        this.endpoint = options.endpoint || process.env.API_ENDPOINT;
        this.apiKey = options.apiKey || process.env.API_KEY;
        this.timeoutMs = parseTimeoutMs(options.timeoutMs || process.env.DIFY_TIMEOUT_MS);

        if (!this.endpoint) {
            throw new Error(
                'Missing Dify API endpoint. Set API_ENDPOINT in environment variables.'
            );
        }

        if (!this.apiKey) {
            throw new Error('Missing Dify API key. Set API_KEY in environment variables.');
        }

        if (typeof fetch !== 'function') {
            throw new Error('Global fetch is not available in this Node.js runtime.');
        }
    }

    // 发送流式聊天请求，并逐条产出 Dify 的事件对象。
    // 调用方可通过 for await...of 按事件消费增量文本。
    async *streamChatMessage({ query, user, conversationId = '', inputs = {} }) {
        const controller = new AbortController();
        // 超时到达时触发 abort；finally 中必须清理定时器，避免泄漏。
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const payload = {
                inputs,
                query,
                // 要求 Dify 以流式模式返回结果。
                response_mode: 'streaming',
                // 为空串表示新会话；有值表示在历史会话上继续。
                conversation_id: conversationId,
                user
            };

            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorPayload = await readErrorPayload(response);
                throw new DifyRequestError('Dify request failed.', {
                    status: response.status,
                    code: errorPayload.json && errorPayload.json.code,
                    details: errorPayload.json || errorPayload.text,
                    // 5xx 一般是服务端/网关问题，通常可重试；4xx 多数不可重试。
                    isRetryable: response.status >= 500,
                    raw: errorPayload.text
                });
            }

            if (!response.body) {
                throw new DifyRequestError('Dify response stream is empty.', {
                    status: response.status
                });
            }

            for await (const raw of parseSseEvents(response.body)) {
                // Dify 可能发送 [DONE] 作为结束标记，这里直接忽略。
                if (raw === '[DONE]') {
                    continue;
                }

                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch (error) {
                    // 这里报错通常说明服务端返回了非 JSON data 行。
                    throw new DifyStreamError('Cannot parse Dify streaming payload.', {
                        raw,
                        details: error.message
                    });
                }

                yield parsed;
            }
        } catch (error) {
            // 把超时中断统一转成可识别的业务错误。
            if (isAbortError(error)) {
                throw new DifyRequestError(`Dify request timed out after ${this.timeoutMs}ms.`, {
                    code: 'request_timeout',
                    isRetryable: true
                });
            }

            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = {
    DifyClient,
    DifyRequestError,
    DifyStreamError
};
