const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { loadPerformanceEnv } = require('./envLoader');

const [, , scriptPath, ...extraArgs] = process.argv;
const INTERRUPTED_EXIT_CODE = 130;

let shutdownRequested = false;
let shutdownSignal = '';
let activeHttpRequest = null;
let child = null;

const ARCHIVE_SETS = {
    all: [
        'jsa_form',
        'preparation_form',
        'administration_form',
        'documents',
        'maintenance_data',
        'maintenance_stripmap',
        'inspection',
        'stripmap',
    ],
    preparation: ['jsa_form', 'preparation_form'],
    jsa: ['jsa_form'],
    'preparation-form': ['preparation_form'],
    administration: ['administration_form'],
    inspection: ['inspection'],
    documentation: ['documents'],
    documents: ['documents'],
    stripmap: ['stripmap'],
    maintenance: ['maintenance_data', 'maintenance_stripmap'],
    'maintenance-data': ['maintenance_data'],
    'maintenance-stripmap': ['maintenance_stripmap'],
};

const ARCHIVE_LABELS = {
    jsa_form: 'Form JSA',
    preparation_form: 'Form Persiapan',
    administration_form: 'Data Administrasi',
    inspection: 'Data Inspeksi Rutin',
    documents: 'Dokumentasi Inspeksi Rutin',
    stripmap: 'Stripmap Inspeksi Rutin',
    maintenance_stripmap: 'Stripmap Penanganan Inspeksi Rutin',
    maintenance_data: 'Data Penanganan Inspeksi Rutin',
};

const CHECKBOX_ARCHIVE_ENV = [
    ['JIMMS_DOWNLOAD_CHECK_FORM_JSA', 'jsa_form'],
    ['JIMMS_DOWNLOAD_CHECK_FORM_PERSIAPAN', 'preparation_form'],
    ['JIMMS_DOWNLOAD_CHECK_DATA_ADMINISTRASI', 'administration_form'],
    ['JIMMS_DOWNLOAD_CHECK_DATA_INSPEKSI', 'inspection'],
    ['JIMMS_DOWNLOAD_CHECK_DOKUMENTASI', 'documents'],
    ['JIMMS_DOWNLOAD_CHECK_STRIPMAP_INSPEKSI', 'stripmap'],
    ['JIMMS_DOWNLOAD_CHECK_STRIPMAP_PENANGANAN', 'maintenance_stripmap'],
    ['JIMMS_DOWNLOAD_CHECK_DATA_PENANGANAN', 'maintenance_data'],
];

if (!scriptPath) {
    console.error('Usage: node helper/runK6WithEnv.js <k6-script> [k6-args...]');
    process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const env = loadPerformanceEnv(projectRoot);

env.K6_REPORT_DIR = env.K6_REPORT_DIR || './test-results/reports/k6';
fs.mkdirSync(path.resolve(projectRoot, env.K6_REPORT_DIR), { recursive: true });

const scriptName = sanitizeReportName(env.K6_REPORT_NAME || path.basename(scriptPath, path.extname(scriptPath)));
const debugDir = path.resolve(projectRoot, env.K6_REPORT_DIR, 'debug');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const stdoutLog = path.join(debugDir, `${scriptName}-${timestamp}.out.log`);
const stderrLog = path.join(debugDir, `${scriptName}-${timestamp}.err.log`);
const latestLog = path.join(debugDir, `${scriptName}-latest-log.json`);

forwardSignal('SIGINT');
forwardSignal('SIGTERM');

main().catch((error) => {
    const interrupted = isInterruptedError(error) || shutdownRequested;
    writeLatestLog({
        status: interrupted ? 'interrupted' : 'failed',
        exitCode: interrupted ? INTERRUPTED_EXIT_CODE : 1,
        signal: shutdownSignal,
        error: error.message,
    });
    console.error(error.message);
    process.exit(interrupted ? INTERRUPTED_EXIT_CODE : 1);
});

async function main() {
    fs.mkdirSync(debugDir, { recursive: true });
    writeLatestLog({ status: 'preparing' });
    await prepareDownloadJobsBeforeRun();
    assertNotInterrupted();
    await runK6();
}

function runK6() {
    return new Promise((resolve) => {
        const command = process.platform === 'win32' ? 'k6.exe' : 'k6';
        const stdoutStream = fs.createWriteStream(stdoutLog, { flags: 'w' });
        const stderrStream = fs.createWriteStream(stderrLog, { flags: 'w' });

        writeLatestLog({ status: 'running' });
        child = spawn(command, ['run', ...extraArgs, scriptPath], {
            cwd: projectRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
            stdoutStream.write(chunk);
            process.stdout.write(chunk);
        });

        child.stderr.on('data', (chunk) => {
            stderrStream.write(chunk);
            process.stderr.write(chunk);
        });

        child.on('error', (error) => {
            stderrStream.write(`${error.message}\n`);
            closeStreams(stdoutStream, stderrStream, () => {
                writeLatestLog({ status: 'failed-to-start', exitCode: 1, error: error.message });
                console.error(error.message);
                resolve(1);
            });
        });

        child.on('close', (status, signal) => {
            closeStreams(stdoutStream, stderrStream, () => {
                const interrupted = shutdownRequested || signal === 'SIGINT' || signal === 'SIGTERM';
                const exitCode = interrupted ? INTERRUPTED_EXIT_CODE : status === null ? 1 : status;

                writeLatestLog({
                    status: interrupted ? 'interrupted' : status === 0 ? 'passed' : 'failed',
                    exitCode,
                    signal,
                });
                resolve(exitCode);
            });
        });
    }).then((exitCode) => {
        process.exit(exitCode);
    });
}

async function prepareDownloadJobsBeforeRun() {
    if (!isJimmsDownloadScript()) return;
    if (downloadFlowMode() === 'real-user') return;
    if (env.JIMMS_PREPARED_DOWNLOAD_JOBS_JSON) return;

    const directJobs = directDownloadJobsFromEnv();
    if (directJobs.length > 0) {
        console.log(`[K6-DOWNLOAD-PREPARE] Using ${directJobs.length} direct ZIP download URL(s) from env. Skip list/export/progress-stream.`);
        env.JIMMS_PREPARED_DOWNLOAD_JOBS_JSON = JSON.stringify(directJobs);
        env.JIMMS_PREPARED_DOWNLOAD_JOBS_COUNT = String(directJobs.length);
        env.JIMMS_PREPARE_DOWNLOAD_SOURCE = 'direct-env';
        return;
    }

    if (!shouldPrepareDownloadJobsBeforeRun()) return;

    assertNotInterrupted();
    const prepareJobs = positiveInteger(env.JIMMS_DOWNLOAD_PREPARE_JOBS, 1);
    const timeoutMs = durationToMs(env.JIMMS_DOWNLOAD_FILE_TIMEOUT || env.JIMMS_EXPORT_TIMEOUT, 120000);
    console.log(`[K6-DOWNLOAD-PREPARE] Preparing ${prepareJobs} ZIP download URL(s) before K6 starts.`);

    const authContext = await authenticateForDownload();
    const listResponse = await authContext.client.requestText('GET', regularInspectionListUrl(), {
        headers: apiHeaders(authContext.accessToken, 'application/json, text/plain, */*'),
        timeoutMs,
    });
    const listBody = parseJson(listResponse.text);
    const inspectionIds = inspectionIdCandidates(listBody);

    if (listResponse.status !== 200 || inspectionIds.length === 0) {
        throw new Error(`Cannot prepare ZIP download: no inspection id from list. status=${listResponse.status}, body=${listResponse.text.slice(0, 200)}`);
    }

    const jobs = [];

    for (let index = 0; index < prepareJobs; index += 1) {
        assertNotInterrupted();
        const inspectionId = inspectionIds[index % inspectionIds.length];
        const archiveScenario = archiveScenarioByIndex(index);
        const exportResponse = await exportRegularInspectionForPrepare(authContext, inspectionId, archiveScenario, timeoutMs);
        const exportBody = parseJson(exportResponse.text);
        const exportData = exportBody && exportBody.data ? exportBody.data : {};
        const jobId = exportData.jobId || '';

        if (exportResponse.status !== 200 || !jobId) {
            throw new Error(`Cannot prepare ZIP download: export failed. status=${exportResponse.status}, body=${exportResponse.text.slice(0, 200)}`);
        }

        const progress = await resolveDownloadUrl(authContext, jobId);
        jobs.push({
            inspectionId: String(inspectionId),
            archiveScenario: archiveScenario.name,
            jobId,
            filename: exportData.filename || progress.archiveName || '',
            downloadUrl: progress.downloadUrl,
        });

        console.log(`[K6-DOWNLOAD-PREPARE] Ready ${index + 1}/${prepareJobs}: jobId=${jobId}`);
    }

    env.JIMMS_PREPARED_DOWNLOAD_JOBS_JSON = JSON.stringify(jobs);
    env.JIMMS_PREPARED_DOWNLOAD_JOBS_COUNT = String(jobs.length);
}

async function authenticateForDownload() {
    assertNotInterrupted();

    const client = createHttpClient();
    if (env.JIMMS_ACCESS_TOKEN) return { accessToken: env.JIMMS_ACCESS_TOKEN, client };

    const timeoutMs = durationToMs(env.JIMMS_DOWNLOAD_FILE_TIMEOUT || env.JIMMS_EXPORT_TIMEOUT, 120000);
    const csrfResponse = await client.requestText('GET', joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/csrf'), {
        headers: { Accept: 'application/json' },
        timeoutMs,
    });
    const csrfBody = parseJson(csrfResponse.text);
    const csrfToken = csrfBody && csrfBody.csrfToken;

    if (!csrfToken) {
        throw new Error(`Cannot login: csrfToken not found. status=${csrfResponse.status}`);
    }

    const loginBody = new URLSearchParams({
        username: env.JIMMS_USERNAME || '',
        password: env.JIMMS_PASSWORD || '',
        redirect: 'false',
        csrfToken,
        callbackUrl: joinUrl(env.JIMMS_FE_BASE_URL, '/login'),
        json: 'true',
    }).toString();

    const loginResponse = await client.requestText('POST', joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/callback/credentials'), {
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(loginBody),
        },
        body: loginBody,
        timeoutMs,
    });

    if (loginResponse.status < 200 || loginResponse.status >= 400) {
        throw new Error(`Cannot login: login failed. status=${loginResponse.status}, body=${loginResponse.text.slice(0, 200)}`);
    }

    const sessionResponse = await client.requestText('GET', joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/session'), {
        headers: { Accept: 'application/json' },
        timeoutMs,
    });
    const sessionBody = parseJson(sessionResponse.text);
    const accessToken = sessionBody && sessionBody.user && sessionBody.user.accessToken;

    if (!accessToken) {
        throw new Error(`Cannot login: accessToken not found. status=${sessionResponse.status}`);
    }

    return { accessToken, client };
}

async function exportRegularInspectionForPrepare(authContext, inspectionId, archiveScenario, timeoutMs) {
    const multipart = buildMultipartArchiveBody(archiveScenario.archives);

    return authContext.client.requestText('POST', joinUrl(env.JIMMS_API_BASE_URL, `/v1/regular-inspection/export/${inspectionId}`), {
        headers: {
            ...apiHeaders(authContext.accessToken, 'application/json, text/plain, */*'),
            'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        },
        body: multipart.body,
        timeoutMs,
    });
}

async function resolveDownloadUrl(authContext, jobId) {
    const attempts = positiveInteger(env.JIMMS_DOWNLOAD_FILE_POLL_ATTEMPTS, 60);
    const intervalMs = durationToMs(`${env.JIMMS_DOWNLOAD_FILE_POLL_INTERVAL_SECONDS || 2}s`, 2000);
    const progressTimeoutMs = durationToMs(env.JIMMS_DOWNLOAD_PROGRESS_TIMEOUT || '10s', 10000);
    const progressUrl = joinUrl(env.JIMMS_API_BASE_URL, `/v1/regular-inspection/export/${encodeURIComponent(jobId)}/progress-stream`);
    let lastError = null;
    let lastProgress = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        assertNotInterrupted();

        try {
            const response = await authContext.client.requestText('GET', progressUrl, {
                headers: apiHeaders(authContext.accessToken, 'text/event-stream'),
                timeoutMs: progressTimeoutMs,
                finishOnFirstChunk: true,
            });

            if (response.status !== 200) {
                throw new Error(`progress-stream status=${response.status}, body=${response.text.slice(0, 200)}`);
            }

            lastProgress = lastSseJson(response.text);
            console.log(`[K6-DOWNLOAD-PREPARE] progress attempt ${attempt}/${attempts}: status=${lastProgress && lastProgress.status ? lastProgress.status : '-'} percentage=${lastProgress && lastProgress.percentage !== undefined ? lastProgress.percentage : '-'}`);

            if (lastProgress && lastProgress.status === 'FAILED') {
                throw new Error(lastProgress.message || 'Export job failed.');
            }

            if (lastProgress && lastProgress.downloadUrl) {
                return {
                    downloadUrl: absoluteApiUrl(lastProgress.downloadUrl),
                    status: lastProgress.status,
                    percentage: lastProgress.percentage,
                    archiveName: lastProgress.archiveName,
                    expiredAt: lastProgress.expiredAt,
                };
            }
        } catch (error) {
            if (isInterruptedError(error)) throw error;
            lastError = error;
            console.log(`[K6-DOWNLOAD-PREPARE] progress attempt ${attempt}/${attempts}: ${error.message}`);
        }

        if (attempt < attempts) await sleep(intervalMs);
    }

    if (lastProgress && !lastProgress.downloadUrl) {
        throw new Error(`No downloadUrl from progress-stream. status=${lastProgress.status || '-'}, percentage=${lastProgress.percentage || '-'}`);
    }

    if (lastError) throw lastError;
    throw new Error(`No downloadUrl from progress-stream for jobId=${jobId}.`);
}

function createHttpClient() {
    const cookies = new Map();

    function rememberCookies(headers) {
        const setCookie = headers['set-cookie'];
        if (!setCookie) return;

        (Array.isArray(setCookie) ? setCookie : [setCookie]).forEach((cookie) => {
            const pair = String(cookie).split(';')[0];
            const separatorIndex = pair.indexOf('=');
            if (separatorIndex > 0) cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
        });
    }

    function cookieHeader() {
        return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
    }

    function requestText(method, urlString, options = {}, redirectCount = 0) {
        return requestBuffer(method, urlString, options, redirectCount)
            .then((response) => ({ ...response, text: response.body.toString('utf8') }));
    }

    function requestBuffer(method, urlString, options = {}, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (shutdownRequested) {
                reject(interruptedError());
                return;
            }

            const body = requestBodyBuffer(options.body);
            const headers = withContentLength(options.headers || {}, body);
            const url = new URL(urlString);
            const lib = url.protocol === 'https:' ? https : http;
            const cookie = cookieHeader();

            if (cookie && !hasHeader(headers, 'Cookie')) headers.Cookie = cookie;

            const request = lib.request({
                method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                headers,
                rejectUnauthorized: String(env.JIMMS_INSECURE_SKIP_TLS_VERIFY || '').toLowerCase() !== 'true',
            }, (response) => {
                rememberCookies(response.headers);

                if (shouldFollowRedirect(response, options, redirectCount)) {
                    response.resume();
                    response.on('end', () => {
                        const nextUrl = new URL(response.headers.location, urlString).toString();
                        const nextMethod = redirectMethod(method, response.statusCode);
                        const nextOptions = redirectOptions(options, headers, urlString, nextUrl, nextMethod, body);
                        requestBuffer(nextMethod, nextUrl, nextOptions, redirectCount + 1).then(resolve, reject);
                    });
                    return;
                }

                const chunks = [];
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                        url: urlString,
                    });
                };

                response.on('data', (chunk) => {
                    chunks.push(chunk);
                    if (options.finishOnFirstChunk) {
                        finish();
                        request.destroy();
                    }
                });
                response.on('end', finish);
                response.on('error', (error) => {
                    if (!settled) reject(error);
                });
            });

            trackActiveRequest(request);
            request.on('error', (error) => {
                if (String(error.message) === 'socket hang up') return;
                reject(error);
            });
            request.setTimeout(options.timeoutMs || 120000, () => request.destroy(new Error(`Request timeout after ${options.timeoutMs || 120000}ms: ${method} ${urlString}`)));
            if (body) request.write(body);
            request.end();
        });
    }

    return { requestText };
}

function shouldPrepareDownloadJobsBeforeRun() {
    if (String(env.JIMMS_PREPARE_DOWNLOAD_BEFORE_RUN || 'true').toLowerCase() !== 'true') return false;
    return true;
}

function isJimmsDownloadScript() {
    return /jimmsDownload/i.test(String(scriptPath || ''));
}

function downloadFlowMode() {
    return String(env.JIMMS_DOWNLOAD_FLOW_MODE || 'real-user').trim().toLowerCase();
}

function directDownloadJobsFromEnv() {
    const urls = splitCsv(env.JIMMS_DOWNLOAD_DIRECT_URLS).map((downloadUrl, index) => ({
        inspectionId: '',
        archiveScenario: 'direct-url',
        jobId: jobIdFromDownloadUrl(downloadUrl),
        filename: '',
        downloadUrl: absoluteApiUrl(downloadUrl),
        source: 'JIMMS_DOWNLOAD_DIRECT_URLS',
        index: index + 1,
    }));
    const jobIds = splitCsv(env.JIMMS_DOWNLOAD_JOB_IDS).map((jobId, index) => ({
        inspectionId: '',
        archiveScenario: 'direct-job-id',
        jobId,
        filename: '',
        downloadUrl: joinUrl(env.JIMMS_API_BASE_URL, `/v1/regular-inspection/export/${encodeURIComponent(jobId)}/download`),
        source: 'JIMMS_DOWNLOAD_JOB_IDS',
        index: index + 1,
    }));

    return urls.concat(jobIds);
}

function jobIdFromDownloadUrl(value) {
    const match = String(value || '').match(/\/export\/([^/]+)\/download(?:[?#].*)?$/i);
    return match ? decodeURIComponent(match[1]) : '';
}

function regularInspectionListUrl() {
    const params = [];
    addQueryParam(params, 'status_id[]', env.JIMMS_REGULAR_INSPECTION_STATUS_ID || '27');
    addQueryParam(params, 'page', env.JIMMS_LIST_PAGE || '1');
    addQueryParam(params, 'per_page', env.JIMMS_LIST_PER_PAGE || '5');
    return `${String(env.JIMMS_API_BASE_URL || '').replace(/\/+$/, '')}/v1/regular-inspection?${params.join('&')}`;
}

function inspectionIdCandidates(listBody) {
    const configuredIds = splitCsv(env.JIMMS_DOWNLOAD_INSPECTION_IDS);
    if (configuredIds.length > 0) return configuredIds;
    if (!listBody || !listBody.data || !Array.isArray(listBody.data.data)) return [];
    return listBody.data.data.map((row) => row && row.id).filter(Boolean);
}

function archiveScenarioByIndex(index) {
    const checkboxScenario = archiveScenarioFromCheckboxes();
    if (checkboxScenario) return checkboxScenario;

    const names = splitCsv(env.JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS);
    if (names.length === 0) {
        throw new Error('No download checkbox selected. Set JIMMS_DOWNLOAD_ALL_ARCHIVE=true or set at least one JIMMS_DOWNLOAD_CHECK_* value to true.');
    }

    return archiveScenarioByName(names[index % names.length]);
}

function archiveScenarioFromCheckboxes() {
    const allDefault = env.JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS ? false : true;
    if (boolEnv('JIMMS_DOWNLOAD_ALL_ARCHIVE', allDefault)) return archiveScenarioByName('all');

    const archives = CHECKBOX_ARCHIVE_ENV
        .filter(([envKey]) => boolEnv(envKey, false))
        .map(([, archiveValue]) => archiveValue);

    if (archives.length === 0) return null;

    return {
        name: archives.join('+'),
        archives,
    };
}

function archiveScenarioByName(rawName) {
    const name = String(rawName || 'all').trim().toLowerCase();
    const predefined = ARCHIVE_SETS[name];
    if (predefined) return { name, archives: predefined.slice() };

    const customArchives = name.split(/[+|]/).map((item) => item.trim()).filter(Boolean);
    const invalid = customArchives.filter((value) => !ARCHIVE_LABELS[value]);
    if (customArchives.length > 0 && invalid.length === 0) return { name, archives: customArchives };

    throw new Error(`Unknown JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS value "${rawName}".`);
}

function buildMultipartArchiveBody(archives) {
    const boundary = `----nodeJimmsDownload${process.pid}${Date.now()}${Math.random().toString(16).slice(2)}`;
    const body = archives.map((archiveValue) => [
        `--${boundary}`,
        'Content-Disposition: form-data; name="archive[]"',
        '',
        archiveValue,
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;
    return { boundary, body };
}

function writeLatestLog(extra) {
    fs.mkdirSync(path.dirname(latestLog), { recursive: true });
    fs.writeFileSync(latestLog, JSON.stringify({
        scriptName,
        stdoutLog,
        stderrLog,
        createdAt: new Date().toISOString(),
        ...extra,
    }, null, 2), 'utf8');
}

function forwardSignal(signal) {
    process.on(signal, () => {
        if (!shutdownRequested) console.error(`[K6-RUNNER] Received ${signal}. Stopping run.`);

        shutdownRequested = true;
        shutdownSignal = signal;

        if (child && !child.killed && child.exitCode === null && child.signalCode === null) child.kill(signal);
        if (activeHttpRequest) activeHttpRequest.destroy(interruptedError(signal));
    });
}

function closeStreams(stdoutStream, stderrStream, callback) {
    let pending = 2;
    const done = () => {
        pending -= 1;
        if (pending === 0) callback();
    };
    stdoutStream.end(done);
    stderrStream.end(done);
}

function trackActiveRequest(request) {
    activeHttpRequest = request;
    request.on('close', () => {
        if (activeHttpRequest === request) activeHttpRequest = null;
    });
}

function assertNotInterrupted() {
    if (shutdownRequested) throw interruptedError();
}

function interruptedError(signal = shutdownSignal || 'signal') {
    const error = new Error(`Interrupted by ${signal}.`);
    error.code = 'K6_RUNNER_INTERRUPTED';
    return error;
}

function isInterruptedError(error) {
    return Boolean(error && (error.code === 'K6_RUNNER_INTERRUPTED' || String(error.message || '').startsWith('Interrupted by ')));
}

function shouldFollowRedirect(response, options, redirectCount) {
    const maxRedirects = options.maxRedirects === undefined ? 5 : options.maxRedirects;
    return [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirectCount < maxRedirects;
}

function redirectMethod(method, statusCode) {
    if (statusCode === 303) return 'GET';
    if ((statusCode === 301 || statusCode === 302) && method !== 'GET' && method !== 'HEAD') return 'GET';
    return method;
}

function redirectOptions(options, headers, fromUrl, toUrl, nextMethod, body) {
    const nextHeaders = stripCrossOriginHeaders(headers, fromUrl, toUrl);
    const nextOptions = { ...options, headers: nextHeaders };

    if (nextMethod === 'GET' || nextMethod === 'HEAD') {
        deleteHeader(nextHeaders, 'Content-Type');
        deleteHeader(nextHeaders, 'Content-Length');
        delete nextOptions.body;
    } else if (body) {
        nextOptions.body = body;
    }

    return nextOptions;
}

function stripCrossOriginHeaders(headers, fromUrl, toUrl) {
    const nextHeaders = { ...headers };
    const from = new URL(fromUrl);
    const to = new URL(toUrl);

    if (from.origin !== to.origin) {
        deleteHeader(nextHeaders, 'Authorization');
        deleteHeader(nextHeaders, 'x-api-key');
        deleteHeader(nextHeaders, 'Cookie');
    }

    return nextHeaders;
}

function apiHeaders(accessToken, accept) {
    return {
        Accept: accept,
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': env.JIMMS_API_KEY,
    };
}

function requestBodyBuffer(body) {
    if (body === undefined || body === null) return null;
    return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function withContentLength(headers, body) {
    const nextHeaders = { ...headers };
    if (body && !hasHeader(nextHeaders, 'Content-Length')) nextHeaders['Content-Length'] = body.length;
    return nextHeaders;
}

function hasHeader(headers, name) {
    return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function deleteHeader(headers, name) {
    Object.keys(headers).forEach((key) => {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    });
}

function addQueryParam(params, name, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
}

function lastSseJson(text) {
    const events = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .map(parseJson)
        .filter(Boolean);
    return events.length > 0 ? events[events.length - 1] : null;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function absoluteApiUrl(value) {
    const raw = String(value || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    return joinUrl(env.JIMMS_API_BASE_URL, raw.startsWith('/') ? raw : `/${raw}`);
}

function joinUrl(baseUrl, pathname) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}${pathname}`;
}

function splitCsv(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function boolEnv(name, defaultValue = false) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue === '') return defaultValue;
    return String(rawValue).toLowerCase() === 'true';
}

function durationToMs(value, fallbackMs) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return fallbackMs;

    const amount = Number(match[1]);
    const unit = String(match[2] || 'ms').toLowerCase();
    const multiplier = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
    return Math.max(1, Math.floor(amount * multiplier));
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeReportName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'k6-report';
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
