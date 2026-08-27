export function textSummary(data) {
    const metrics = data.metrics || {};
    const lines = [
        '',
        'JIMMS K6 Summary',
        `  iterations: ${metricValue(metrics.iterations, 'count')}`,
        `  http_reqs: ${metricValue(metrics.http_reqs, 'count')}`,
        `  valid_response_rate: ${rateValue(metrics.jimms_valid_response_rate)}`,
        `  load_error_rate: ${rateValue(metrics.jimms_load_error_rate)}`,
        `  valid_req_duration p95: ${durationValue(metrics.jimms_valid_req_duration, 'p(95)')}`,
        `  http_req_duration max: ${durationValue(metrics.http_req_duration, 'max')}`,
        '',
    ];

    return lines.join('\n');
}

function metricValue(metric, key) {
    if (!metric || !metric.values || typeof metric.values[key] !== 'number') return '-';
    return formatNumber(metric.values[key]);
}

function rateValue(metric) {
    if (!metric || !metric.values || typeof metric.values.rate !== 'number') return '-';
    return `${(metric.values.rate * 100).toFixed(2)}%`;
}

function durationValue(metric, key) {
    if (!metric || !metric.values || typeof metric.values[key] !== 'number') return '-';
    const value = metric.values[key];
    return value >= 1000 ? `${formatNumber(value)} ms (${(value / 1000).toFixed(2)}s)` : `${formatNumber(value)} ms`;
}

function formatNumber(value) {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
