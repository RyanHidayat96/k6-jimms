import { sleep } from 'k6';
import { processData } from '../../common/base.js';
import { generateThresholds } from '../../common/commonThresholds.js';
import { authenticate } from '../../common/jimmsAuth.js';
import { runDownloadFlow, selectedRequestNames } from '../../common/jimmsDownloadClient.js';
import { assertJimmsConfigured } from '../../common/jimmsSafeGuard.js';
import { environment } from '../../config/environment.js';
import { testProfile } from '../support/profileConfig.js';

const scriptPath = 'tests/downloadTest/jimmsDownloadScenarios.js';
const profile = testProfile(scriptPath);

assertJimmsConfigured(environment);

export const options = {
    scenarios: profile.scenarioOptions.scenarios,
    thresholds: generateThresholds(selectedRequestNames()),
    systemTags: ['status', 'method', 'url', 'name', 'group', 'check'],
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    insecureSkipTLSVerify: environment.insecureSkipTLSVerify,
    setupTimeout: environment.setupTimeout,
};

export function setup() {
    return authenticate();
}

export default function (authContext) {
    runDownloadFlow(authContext);
    sleep(profile.thinkTimeSeconds);
}

export function handleSummary(data) {
    return processData(data, profile.scenarioOptions.stageList, profile.testingType, profile.scriptPath);
}
