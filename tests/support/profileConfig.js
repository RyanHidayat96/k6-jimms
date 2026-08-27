import { buildScenarioOptions, getEnvInt, getLoadTestingStages } from '../../common/utility.js';

export function loadOrStressProfile(scriptPath, rawProfile = __ENV.JIMMS_PROFILE || 'load') {
    const profile = normalizeLoadProfile(rawProfile);
    const isStress = profile === 'stress';
    const targetVus = getEnvInt('JIMMS_TARGET_VUS', 1);
    const scenarioOptions = buildScenarioOptions('JIMMS', {
        executor: 'ramping-vus',
        vus: targetVus,
        stages: getLoadTestingStages(targetVus),
        gracefulRampDown: __ENV.JIMMS_GRACEFUL_RAMP_DOWN || '30s',
    });

    return {
        profile,
        scriptPath,
        testingType: `Download ${isStress ? 'Stress' : 'Load'} Testing`,
        thresholdPrefix: 'JIMMS',
        scenarioOptions,
        thinkTimeSeconds: Number(__ENV.JIMMS_THINK_TIME_SECONDS || 1),
        requiresStress: isStress,
    };
}

export function smokeProfile(scriptPath) {
    return {
        profile: 'smoke',
        scriptPath,
        testingType: 'Download Smoke Performance Testing',
        thresholdPrefix: 'JIMMS',
        scenarioOptions: buildScenarioOptions('JIMMS_SMOKE', {
            executor: 'shared-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '3m',
        }),
        thinkTimeSeconds: Number(__ENV.JIMMS_SMOKE_THINK_TIME_SECONDS || 0),
        requiresStress: false,
    };
}

function normalizeLoadProfile(value) {
    const normalized = String(value || 'load').toLowerCase();
    if (['load', 'stress'].includes(normalized)) return normalized;
    throw new Error('JIMMS_PROFILE must be load or stress.');
}
