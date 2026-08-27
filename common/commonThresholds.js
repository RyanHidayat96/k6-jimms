import { getEnvNumber } from './utility.js';

export const VALID_RESPONSE_RATE_METRIC = 'jimms_valid_response_rate';
export const LOAD_ERROR_RATE_METRIC = 'jimms_load_error_rate';
export const VALID_REQUEST_DURATION_METRIC = 'jimms_valid_req_duration';

export function generateThresholds(requestNames = [], prefix = 'JIMMS_LOAD') {
    const checkRate = getThresholdNumber(prefix, 'CHECK_RATE', 0.95);
    const httpErrorRate = getThresholdNumber(prefix, 'HTTP_ERROR_RATE', 0.01);
    const p95 = getThresholdNumber(prefix, 'P95_THRESHOLD_MS', 120000);
    const p99 = getThresholdNumber(prefix, 'P99_THRESHOLD_MS', 120000);
    const perEndpointP95 = getThresholdNumber(prefix, 'PER_ENDPOINT_P95_THRESHOLD_MS', 120000);

    const thresholds = {
        checks: [`rate>=${checkRate}`],
        [VALID_RESPONSE_RATE_METRIC]: [`rate>=${checkRate}`],
        [LOAD_ERROR_RATE_METRIC]: [`rate<${httpErrorRate}`],
        [VALID_REQUEST_DURATION_METRIC]: [`p(95)<${p95}`, `p(99)<${p99}`],
    };

    requestNames.forEach((requestName) => {
        thresholds[`${VALID_REQUEST_DURATION_METRIC}{request:${requestName}}`] = [`p(95)<${perEndpointP95}`];
    });

    return thresholds;
}

function getThresholdNumber(prefix, suffix, defaultValue) {
    const specificKey = `${prefix}_${suffix}`;
    const globalKey = `JIMMS_${suffix}`;

    if (__ENV[specificKey] !== undefined && __ENV[specificKey] !== '') {
        return getEnvNumber(specificKey, defaultValue);
    }

    return getEnvNumber(globalKey, defaultValue);
}
