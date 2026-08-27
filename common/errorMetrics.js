import { Counter, Rate, Trend } from 'k6/metrics';

export const jimmsApiErrorCount = new Counter('jimms_api_error_count');
export const jimmsDataPreconditionCount = new Counter('jimms_data_precondition_count');
export const jimmsLoadErrorRate = new Rate('jimms_load_error_rate');
export const jimmsValidResponseRate = new Rate('jimms_valid_response_rate');
export const jimmsValidRequestDuration = new Trend('jimms_valid_req_duration', true);

const loggedResponseSampleKeys = {};

export function recordApiMetrics(response, requestName, options = {}) {
    recordApiResponseSample(response, requestName, options);
    if (options.skipPerformance === true) return;

    recordApiError(response, requestName, options);
    recordPerformanceMetrics(response, requestName, options);
}

export function recordApiResponseSample(response, requestName, options = {}) {
    if (!response) return;

    const sample = responseSampleFrom(response, requestName, options);
    logResponseSample(sample);
}

export function recordBusinessMismatchSample(response, requestName, message) {
    if (!response) return;

    const sample = responseSampleFrom(response, requestName, {
        result: 'FAILED',
        category: 'business_mismatch',
        message,
    });
    logResponseSample(sample);
}

export function classifyJimmsResponse(response, options = {}) {
    if (!response) {
        return {
            category: 'load_capacity',
            isError: true,
            status: 0,
            responseCode: 0,
            message: 'No response',
        };
    }

    const body = parseBody(response.body);
    const status = Number(response.status || 0);
    const responseCode = numericValue(body && (body.responseCode || body.statusCode || body.code));
    const message = errorMessageFromBody(body, status);
    const hasSuccessEnvelope = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'success');
    const successEnvelopeFailed = hasSuccessEnvelope && body.success !== true;
    const explicitBusinessFail = options.valid === false;
    const isError = status >= 400 || responseCode >= 4000000 || successEnvelopeFailed || explicitBusinessFail;

    if (isLoadCapacityError(status, responseCode, message)) {
        return { category: 'load_capacity', isError: true, status, responseCode, message };
    }

    if (isAuthSecurityError(status, responseCode, message)) {
        return { category: 'auth_security', isError: true, status, responseCode, message };
    }

    if (isDataPreconditionError(status, responseCode, message)) {
        return { category: 'data_precondition', isError: true, status, responseCode, message };
    }

    if (isError) {
        return { category: 'functional_api', isError: true, status, responseCode, message };
    }

    return { category: 'passed', isError: false, status, responseCode, message };
}

function recordPerformanceMetrics(response, requestName, options = {}) {
    if (!response) return;

    const classification = classifyJimmsResponse(response, options);
    const request = requestTagValue(requestName || requestNameFromResponse(response));
    const tags = {
        request,
        category: classification.category,
        status: String(classification.status || 'N/A'),
        response_code: sanitizeTagValue(classification.responseCode || 'N/A'),
    };

    if (classification.category === 'data_precondition') {
        jimmsDataPreconditionCount.add(1, tags);
        console.warn('[K6-DATA-PRECONDITION] ' + JSON.stringify({
            request,
            status: tags.status,
            response_code: tags.response_code,
            message: sanitizeTagValue(classification.message),
        }));
        return;
    }

    jimmsLoadErrorRate.add(classification.category === 'load_capacity', tags);
    jimmsValidResponseRate.add(!classification.isError, tags);

    if (!classification.isError && response.timings && typeof response.timings.duration === 'number') {
        jimmsValidRequestDuration.add(response.timings.duration, { request });
    }
}

function recordApiError(response, requestName, options = {}) {
    if (!response) return;

    const classification = classifyJimmsResponse(response, options);
    if (!classification.isError) return;

    const error = {
        request: requestTagValue(requestName || requestNameFromResponse(response)),
        category: classification.category,
        status: String(classification.status || 'N/A'),
        response_code: sanitizeTagValue(classification.responseCode || 'N/A'),
        error_message: sanitizeTagValue(classification.message),
    };

    jimmsApiErrorCount.add(1, error);
    console.error('[K6-API-ERROR] ' + JSON.stringify(error));
    recordApiResponseSample(response, requestName, options);
}

function responseSampleFrom(response, requestName, options = {}) {
    const body = parseBody(response.body);
    const classification = classifyJimmsResponse(response, options);
    const actualMessage = rawMessageFromBody(body, Number(response.status || 0));
    const sampleMessage = options.message || actualMessage;

    return {
        request: requestTagValue(requestName || requestNameFromResponse(response)),
        result: options.result || (classification.isError ? 'ERROR' : 'PASSED'),
        category: options.category || classification.category,
        status: String(classification.status || 'N/A'),
        response_code: sanitizeTagValue(classification.responseCode || 'N/A'),
        message: sanitizeTagValue(sampleMessage),
        normalized_message: sanitizeTagValue(normalizeDynamicMessage(sampleMessage)),
        response_body: sampleResponseBody(body, response.body),
    };
}

function logResponseSample(sample) {
    const key = [sample.request, sample.result, sample.category, sample.status, sample.response_code, sample.normalized_message].join('|');
    if (loggedResponseSampleKeys[key]) return;

    loggedResponseSampleKeys[key] = true;
    console.log('[K6-API-RESPONSE-SAMPLE] ' + JSON.stringify(sample));
}

function sampleResponseBody(body, rawBody) {
    if (body && typeof body === 'object') return compactSampleValue(body, 0);

    const raw = String(rawBody || '').trim();
    if (!raw) return 'N/A';

    return raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}

function compactSampleValue(value, depth, key = '') {
    if (isSensitiveKey(key)) return '<hidden in performance report>';
    if (value === undefined || value === null) return value;
    if (typeof value === 'string') return value.slice(0, 500);
    if (typeof value !== 'object') return value;
    if (depth >= 5) return '<nested object truncated>';

    if (Array.isArray(value)) {
        const sample = value.slice(0, 3).map((item) => compactSampleValue(item, depth + 1));
        if (value.length > 3) sample.push(`<${value.length - 3} more item(s)>`);
        return sample;
    }

    return Object.entries(value).reduce((result, [entryKey, entryValue]) => {
        result[entryKey] = compactSampleValue(entryValue, depth + 1, entryKey);
        return result;
    }, {});
}

function isSensitiveKey(key) {
    return /token|signature|authorization|api[-_]?key|client[-_]?key|password|csrf/i.test(String(key || ''));
}

function parseBody(rawBody) {
    if (!rawBody || typeof rawBody !== 'string') return undefined;

    try {
        return JSON.parse(rawBody);
    } catch (error) {
        return undefined;
    }
}

function requestNameFromResponse(response) {
    if (response && response.request && response.request.tags && response.request.tags.request) {
        return response.request.tags.request;
    }

    if (response && response.request && response.request.url) {
        return response.request.url;
    }

    return 'Unknown request';
}

function errorMessageFromBody(body, status) {
    return normalizeDynamicMessage(rawMessageFromBody(body, status));
}

function rawMessageFromBody(body, status) {
    if (!body || typeof body !== 'object') return `HTTP ${status || 'N/A'}`;

    const responseMessage = stringValue(body.responseMessage);
    const apiError = stringValue(body.error);
    const apiMessage = stringValue(body.message);
    const message = responseMessage
        || (apiError && apiMessage && apiError !== apiMessage ? `${apiError}: ${apiMessage}` : apiMessage || apiError)
        || `HTTP ${status || 'N/A'}`;
    const detail = detailMessage(body.data);
    return detail ? `${message}: ${detail}` : message;
}

function isLoadCapacityError(status, responseCode, message) {
    if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return true;
    if (responseCode === 429 || responseCode >= 5000000) return true;
    return includesAny(message, ['too many request', 'too many requests', 'rate limit', 'timeout', 'timed out', 'bad gateway', 'service unavailable', 'gateway timeout', 'connection reset']);
}

function isAuthSecurityError(status, responseCode, message) {
    if (status === 401 || status === 403) return true;
    if (responseCode === 4000001 || responseCode === 4010101 || responseCode === 4012401) return true;
    return includesAny(message, ['invalid header', 'invalid headers', 'x-api-key', 'authorization', 'unauthorized', 'forbidden']);
}

function isDataPreconditionError(status, responseCode, message) {
    if (status === 404 && includesAny(message, ['not found', 'tidak ditemukan', 'data is not available'])) return true;
    if (status === 422) return true;
    if (responseCode >= 4040000 && responseCode < 4050000) return true;
    if (responseCode >= 4220000 && responseCode < 4230000) return true;

    return includesAny(message, [
        'data tidak ditemukan',
        'not found',
        'tidak tersedia',
        'data is not available',
        'checkbox',
        'archive',
        'dokumen tidak tersedia',
    ]);
}

function includesAny(value, keywords) {
    const normalized = String(value || '').toLowerCase();
    return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

function detailMessage(data) {
    if (Array.isArray(data)) {
        const first = data.find((item) => item && typeof item === 'object');
        if (!first) return '';
        const field = stringValue(first.field);
        const message = stringValue(first.message);
        if (field && message) return `${field} - ${message}`;
        return message || field;
    }

    if (data && typeof data === 'object') {
        const field = stringValue(data.field);
        const message = stringValue(data.message);
        if (field && message) return `${field} - ${message}`;
        return message || field;
    }

    return '';
}

function normalizeDynamicMessage(value) {
    return String(value || '')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<timestamp>')
        .replace(/\b\d{10,}\b/g, '<number>');
}

function requestTagValue(value) {
    const normalized = String(value === undefined || value === null || value === '' ? 'N/A' : value)
        .replace(/[,]/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized.slice(0, 180) || 'N/A';
}

function sanitizeTagValue(value) {
    const normalized = String(value === undefined || value === null || value === '' ? 'N/A' : value)
        .replace(/[{},]/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized.slice(0, 180) || 'N/A';
}

function numericValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}
