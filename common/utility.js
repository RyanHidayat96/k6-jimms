const defaultTargetUser = 1;

export function getEnvInt(name, defaultValue = defaultTargetUser) {
    const rawValue = __ENV[name];

    if (rawValue === undefined || rawValue === '') {
        return defaultValue;
    }

    const parsedValue = parseInt(rawValue, 10);

    if (Number.isNaN(parsedValue) || parsedValue < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }

    return parsedValue;
}

export function getEnvNumber(name, defaultValue) {
    const rawValue = __ENV[name];

    if (rawValue === undefined || rawValue === '') {
        return defaultValue;
    }

    const parsedValue = Number(rawValue);

    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        throw new Error(`${name} must be a non-negative number.`);
    }

    return parsedValue;
}

export function getLoadTestingStages(targetUser = defaultTargetUser) {
    return [
        { duration: __ENV.JIMMS_RAMP_UP || '30s', target: targetUser },
        { duration: __ENV.JIMMS_HOLD || '2m', target: targetUser },
        { duration: __ENV.JIMMS_RAMP_DOWN || '30s', target: 0 },
    ];
}

export function buildScenarioOptions(prefix, defaults = {}) {
    const executor = String(__ENV[`${prefix}_EXECUTOR`] || defaults.executor || 'ramping-vus').toLowerCase();
    const scenario = { executor };

    if (executor === 'ramping-vus') {
        scenario.stages = defaults.stages || getLoadTestingStages(defaults.vus || defaultTargetUser);
        scenario.gracefulRampDown = __ENV[`${prefix}_GRACEFUL_RAMP_DOWN`] || defaults.gracefulRampDown || '30s';
        return { scenarios: { default: scenario }, stageList: scenario.stages };
    }

    if (executor === 'constant-vus') {
        scenario.vus = getEnvInt(`${prefix}_VUS`, defaults.vus || defaultTargetUser);
        scenario.duration = __ENV[`${prefix}_DURATION`] || defaults.duration || '1m';
        return { scenarios: { default: scenario }, stageList: [] };
    }

    if (executor === 'shared-iterations') {
        scenario.vus = getEnvInt(`${prefix}_VUS`, defaults.vus || defaultTargetUser);
        scenario.iterations = getEnvInt(`${prefix}_ITERATIONS`, defaults.iterations || 1);
        scenario.maxDuration = __ENV[`${prefix}_MAX_DURATION`] || defaults.maxDuration || '10m';
        return { scenarios: { default: scenario }, stageList: [] };
    }

    if (executor === 'per-vu-iterations') {
        scenario.vus = getEnvInt(`${prefix}_VUS`, defaults.vus || defaultTargetUser);
        scenario.iterations = getEnvInt(`${prefix}_ITERATIONS`, defaults.iterations || 1);
        scenario.maxDuration = __ENV[`${prefix}_MAX_DURATION`] || defaults.maxDuration || '10m';
        return { scenarios: { default: scenario }, stageList: [] };
    }

    throw new Error(`${prefix}_EXECUTOR must be ramping-vus, constant-vus, shared-iterations, or per-vu-iterations.`);
}

export function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}
