import { buildScenarioOptions, getEnvInt, getLoadTestingStages, getStressTestingStages } from '../../common/utility.js';

export function loadOrStressProfile(scriptPath, rawProfile = __ENV.JIMMS_PROFILE || 'load') {
    const profile = normalizeLoadProfile(rawProfile);
    const isStress = profile === 'stress';
    const profilePrefix = isStress ? 'JIMMS_STRESS' : 'JIMMS';
    const thresholdPrefix = isStress ? 'JIMMS_STRESS' : 'JIMMS_LOAD';
    const targetVus = getEnvInt(isStress ? 'JIMMS_STRESS_TARGET_VUS' : 'JIMMS_TARGET_VUS', 1);
    const scenarioOptions = buildScenarioOptions(profilePrefix, {
        executor: 'ramping-vus',
        vus: targetVus,
        stages: isStress ? getStressTestingStages(targetVus) : getLoadTestingStages(targetVus),
        gracefulRampDown: isStress ? (__ENV.JIMMS_STRESS_GRACEFUL_RAMP_DOWN || '30s') : (__ENV.JIMMS_GRACEFUL_RAMP_DOWN || '30s'),
    });

    return {
        profile,
        scriptPath,
        testingType: `Download ${isStress ? 'Stress' : 'Load'} Testing`,
        thresholdPrefix,
        scenarioOptions,
        thinkTimeSeconds: Number(__ENV[isStress ? 'JIMMS_STRESS_THINK_TIME_SECONDS' : 'JIMMS_THINK_TIME_SECONDS'] || 1),
        requiresStress: isStress,
    };
}

export function smokeProfile(scriptPath) {
    return {
        profile: 'smoke',
        scriptPath,
        testingType: 'Download Smoke Performance Testing',
        thresholdPrefix: 'JIMMS_SMOKE',
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
