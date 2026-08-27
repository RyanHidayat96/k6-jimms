import { sleep } from 'k6';
import { processData } from '../../common/base.js';
import { generateThresholds } from '../../common/commonThresholds.js';
import { authenticate } from '../../common/jimmsAuth.js';
import { prepareDownloadRun, runDownloadFlow, selectedRequestNames } from '../../common/jimmsDownloadClient.js';
import { assertJimmsConfigured, assertJimmsRunAllowed } from '../../common/jimmsSafeGuard.js';
import { environment } from '../../config/environment.js';
import { smokeProfile } from '../support/profileConfig.js';

const scriptPath = 'tests/downloadTest/jimmsDownloadSmoke.js';
const profile = smokeProfile(scriptPath);

assertJimmsConfigured(environment);
assertJimmsRunAllowed('JIMMS download smoke performance test', {
    requiresStress: profile.requiresStress,
});

export const options = {
    scenarios: profile.scenarioOptions.scenarios,
    thresholds: generateThresholds(selectedRequestNames(), profile.thresholdPrefix),
    systemTags: ['status', 'method', 'url', 'name', 'group', 'check'],
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    insecureSkipTLSVerify: environment.insecureSkipTLSVerify,
    setupTimeout: environment.setupTimeout,
};

export function setup() {
    return prepareDownloadRun(authenticate());
}

export default function (authContext) {
    runDownloadFlow(authContext);
    sleep(profile.thinkTimeSeconds);
}

export function handleSummary(data) {
    return processData(data, profile.scenarioOptions.stageList, profile.testingType, profile.scriptPath);
}
