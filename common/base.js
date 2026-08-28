import { check, fail } from 'k6';
import { textSummary } from './k6-summary.js';
import { environment } from '../config/environment.js';

export function checkWithFail(response, checkName, checkFunction) {
    const checks = {};
    checks[checkName] = checkFunction;

    const passed = check(response, checks);

    if (!passed) {
        logFailedCheck('Check failed', response, checkName);
        fail(`${checkName} condition was not met`);
    }
}

export function checkWithSoftFail(response, checkName, checkFunction) {
    const checks = {};
    checks[checkName] = checkFunction;

    const passed = check(response, checks);

    if (!passed) {
        logFailedCheck('Soft check failed', response, checkName);
    }

    return passed;
}

export function processData(data, stageList, testingType, scriptPath) {
    const scriptName = reportScriptName(scriptPath, testingType);
    const reportDir = (environment.reportDir || './test-results/reports/k6').replace(/\/+$/, '');
    const summaryFile = `${reportDir}/${scriptName}-summary.json`;
    const optionFile = `${reportDir}/${scriptName}-optionHtml.json`;
    const reportData = {
        ...data,
        setup_data: sanitizeSetupData(data.setup_data),
        reportConfig: buildReportConfig(stageList, testingType, scriptPath),
    };

    const htmlOption = {
        jsonFile: summaryFile,
        output: `${reportDir}/${scriptName}`,
        title: `K6 ${testingType}: ${scriptName}`,
    };

    return {
        stdout: textSummary(data),
        [summaryFile]: JSON.stringify(reportData, null, 2),
        [optionFile]: JSON.stringify(htmlOption, null, 2),
    };
}

function sanitizeSetupData(value) {
    if (!value || typeof value !== 'object') return value;

    return JSON.parse(JSON.stringify(value, (key, item) => {
        if (/token|password|authorization|api[-_]?key|csrf/i.test(String(key || ''))) {
            return '<hidden in performance report>';
        }
        return item;
    }));
}

function reportScriptName(scriptPath, testingType) {
    const overrideName = envValue('K6_REPORT_NAME');
    if (overrideName) return sanitizeReportName(overrideName);

    const baseName = scriptPath.split('/').pop().replace('.js', '');

    if (baseName === 'jimmsDownloadScenarios') return 'jimmsDownloadTest';

    return baseName;
}

function buildReportConfig(stageList, testingType, scriptPath) {
    const profile = profileFromTestingType(testingType);
    const prefix = profile === 'smoke' ? 'JIMMS_SMOKE' : 'JIMMS';

    return {
        testingType,
        scriptPath,
        feBaseUrl: environment.feBaseUrl,
        apiBaseUrl: environment.apiBaseUrl,
        statusFilter: `status_id[]=${environment.regularInspectionStatusId}`,
        archiveSelection: downloadArchiveSelectionLabel(),
        downloadAllArchive: environment.downloadAllArchive ? 'true' : 'false',
        downloadProgressTimeout: environment.downloadProgressTimeout,
        downloadProgressAttempts: environment.downloadProgressAttempts,
        executor: envValue(`${prefix}_EXECUTOR`) || envValue('JIMMS_EXECUTOR'),
        targetVus: envValue(`${prefix}_TARGET_VUS`) || envValue('JIMMS_TARGET_VUS'),
        vus: envValue(`${prefix}_VUS`) || envValue('JIMMS_VUS'),
        iterations: envValue(`${prefix}_ITERATIONS`) || envValue('JIMMS_ITERATIONS'),
        duration: envValue(`${prefix}_DURATION`) || envValue('JIMMS_DURATION'),
        maxDuration: envValue(`${prefix}_MAX_DURATION`) || envValue('JIMMS_MAX_DURATION'),
        rampUp: envValue(`${prefix}_RAMP_UP`) || envValue('JIMMS_RAMP_UP'),
        hold: envValue(`${prefix}_HOLD`) || envValue('JIMMS_HOLD'),
        rampDown: envValue(`${prefix}_RAMP_DOWN`) || envValue('JIMMS_RAMP_DOWN'),
        gracefulRampDown: envValue(`${prefix}_GRACEFUL_RAMP_DOWN`) || envValue('JIMMS_GRACEFUL_RAMP_DOWN'),
        thinkTimeSeconds: envValue(`${prefix}_THINK_TIME_SECONDS`) || envValue('JIMMS_THINK_TIME_SECONDS'),
        thresholds: {
            checkRate: envValue('JIMMS_CHECK_RATE'),
            httpErrorRate: envValue('JIMMS_HTTP_ERROR_RATE'),
            p95Ms: envValue('JIMMS_P95_THRESHOLD_MS'),
            p99Ms: envValue('JIMMS_P99_THRESHOLD_MS'),
            perEndpointP95Ms: envValue('JIMMS_PER_ENDPOINT_P95_THRESHOLD_MS'),
        },
        stageList,
    };
}

function downloadArchiveSelectionLabel() {
    if (environment.downloadAllArchive) return 'all checkbox';

    const labels = [];
    if (environment.downloadCheckFormJsa) labels.push('Form JSA');
    if (environment.downloadCheckFormPersiapan) labels.push('Form Persiapan');
    if (environment.downloadCheckDataAdministrasi) labels.push('Data Administrasi');
    if (environment.downloadCheckDataInspeksi) labels.push('Data Inspeksi Rutin');
    if (environment.downloadCheckDokumentasi) labels.push('Dokumentasi Inspeksi Rutin');
    if (environment.downloadCheckStripmapInspeksi) labels.push('Stripmap Inspeksi Rutin');
    if (environment.downloadCheckStripmapPenanganan) labels.push('Stripmap Penanganan Inspeksi Rutin');
    if (environment.downloadCheckDataPenanganan) labels.push('Data Penanganan Inspeksi Rutin');

    return labels.length > 0 ? labels.join(', ') : '-';
}

function profileFromTestingType(testingType) {
    const normalized = String(testingType || '').toLowerCase();
    if (normalized.includes('smoke')) return 'smoke';
    return 'test';
}

function envValue(key) {
    const value = __ENV[key];
    return value === undefined || value === null || value === '' ? '' : String(value);
}

function sanitizeReportName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'k6-report';
}

function logFailedCheck(prefix, response, checkName) {
    const url = response && response.request && response.request.url ? response.request.url : 'N/A';
    const status = response && response.status ? response.status : 'N/A';
    const body = response && response.body ? response.body.slice(0, 1000) : 'N/A';
    const duration = response && response.timings && response.timings.duration ? `${response.timings.duration}ms` : 'N/A';

    console.error(`${prefix}: "${checkName}"`);
    console.error(`URL: ${url}`);
    console.error(`Status: ${status}`);
    console.error(`Body: ${body}`);
    console.error(`Duration: ${duration}`);
    console.error(`VU: ${__VU}, Iteration: ${__ITER}`);
}
