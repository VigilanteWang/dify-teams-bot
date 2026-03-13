const DEFAULT_TIMEOUT_MS = 90000;

class DifyRequestError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DifyRequestError';
        this.status = details.status;
        this.code = details.code;
        this.details = details.details;
        this.isRetryable = details.isRetryable || false;
        this.raw = details.raw;
    }
}

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

function isAbortError(error) {
    return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function parseTimeoutMs(value) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }

    return timeout;
}

async function readErrorPayload(response) {
    const text = await response.text();
    if (!text) {
        return { text: '' };
    }

    try {
        const json = JSON.parse(text);
        return { text, json };
    } catch {
        return { text };
    }
}

async function* parseSseEvents(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let splitIndex = buffer.indexOf('\n\n');
        while (splitIndex !== -1) {
            const rawEvent = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);

            const dataLines = [];
            for (const rawLine of rawEvent.split(/\r?\n/)) {
                if (rawLine.startsWith('data:')) {
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

    buffer += decoder.decode();
    const finalData = buffer.trim();
    if (finalData) {
        const dataLines = [];
        for (const rawLine of finalData.split(/\r?\n/)) {
            if (rawLine.startsWith('data:')) {
                dataLines.push(rawLine.slice(5).trimStart());
            }
        }

        if (dataLines.length > 0) {
            yield dataLines.join('\n').trim();
        }
    }
}

class DifyClient {
    constructor(options = {}) {
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

    async *streamChatMessage({ query, user, conversationId = '', inputs = {} }) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const payload = {
                inputs,
                query,
                response_mode: 'streaming',
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
                if (raw === '[DONE]') {
                    continue;
                }

                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch (error) {
                    throw new DifyStreamError('Cannot parse Dify streaming payload.', {
                        raw,
                        details: error.message
                    });
                }

                yield parsed;
            }
        } catch (error) {
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
