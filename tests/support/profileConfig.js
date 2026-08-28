import { buildScenarioOptions, getEnvInt, getLoadTestingStages } from '../../common/utility.js';

export function testProfile(scriptPath) {
    const targetVus = getEnvInt('JIMMS_TARGET_VUS', 1);
    const scenarioOptions = buildScenarioOptions('JIMMS', {
        executor: 'ramping-vus',
        vus: targetVus,
        stages: getLoadTestingStages(targetVus),
        gracefulRampDown: __ENV.JIMMS_GRACEFUL_RAMP_DOWN || '30s',
    });

    return {
        profile: 'test',
        scriptPath,
        testingType: 'Download Test Performance Testing',
        scenarioOptions,
        thinkTimeSeconds: Number(__ENV.JIMMS_THINK_TIME_SECONDS || 1),
    };
}

export function smokeProfile(scriptPath) {
    return {
        profile: 'smoke',
        scriptPath,
        testingType: 'Download Smoke Performance Testing',
        scenarioOptions: buildScenarioOptions('JIMMS_SMOKE', {
            executor: 'shared-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '3m',
        }),
        thinkTimeSeconds: Number(__ENV.JIMMS_SMOKE_THINK_TIME_SECONDS || 0),
    };
}
