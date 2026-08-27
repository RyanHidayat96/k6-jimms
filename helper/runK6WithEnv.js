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
let child = null;

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});

async function main() {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(latestLog, JSON.stringify({ scriptName, stdoutLog, stderrLog, createdAt: new Date().toISOString(), status: 'preparing' }, null, 2), 'utf8');
    await prepareDownloadJobsBeforeRun();

    const command = process.platform === 'win32' ? 'k6.exe' : 'k6';
    const stdoutStream = fs.createWriteStream(stdoutLog, { flags: 'w' });
    const stderrStream = fs.createWriteStream(stderrLog, { flags: 'w' });

    fs.writeFileSync(latestLog, JSON.stringify({ scriptName, stdoutLog, stderrLog, createdAt: new Date().toISOString(), status: 'running' }, null, 2), 'utf8');

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
            fs.mkdirSync(path.dirname(latestLog), { recursive: true });
            fs.writeFileSync(latestLog, JSON.stringify({ scriptName, stdoutLog, stderrLog, createdAt: new Date().toISOString(), status: 'failed-to-start', error: error.message }, null, 2), 'utf8');
            console.error(error.message);
            process.exit(1);
        });
    });

    child.on('close', (status, signal) => {
        closeStreams(stdoutStream, stderrStream, async () => {
            let downloadResult;
            const childInterrupted = shutdownRequested || signal === 'SIGINT' || signal === 'SIGTERM';

            if (childInterrupted) {
                downloadResult = {
                    enabled: String(env.JIMMS_SAVE_DOWNLOAD_RESULT || '').toLowerCase() === 'true',
                    skipped: true,
                    reason: `Interrupted by ${signal || shutdownSignal || 'signal'} before post-run ZIP saving.`,
                };
            } else {
                try {
                    downloadResult = await saveDownloadResultsIfEnabled();
                } catch (error) {
                    downloadResult = { enabled: true, error: error.message };
                    console.error(`[K6-DOWNLOAD-RESULT] ${error.message}`);
                }
            }

            const interrupted = shutdownRequested || childInterrupted || (downloadResult && downloadResult.interrupted);

            fs.mkdirSync(path.dirname(latestLog), { recursive: true });
            fs.writeFileSync(latestLog, JSON.stringify({
                scriptName,
                stdoutLog,
                stderrLog,
                createdAt: new Date().toISOString(),
                status: interrupted ? 'interrupted' : status === 0 ? 'passed' : 'failed',
                exitCode: interrupted ? INTERRUPTED_EXIT_CODE : status,
                signal,
                downloadResult,
            }, null, 2), 'utf8');
            process.exit(interrupted ? INTERRUPTED_EXIT_CODE : status === null ? 1 : status);
        });
    });
}

forwardSignal('SIGINT');
forwardSignal('SIGTERM');

function forwardSignal(signal) {
    process.on(signal, () => {
        if (!shutdownRequested) {
            console.error(`[K6-RUNNER] Received ${signal}. Stopping K6 and post-run ZIP saving.`);
        }

        shutdownRequested = true;
        shutdownSignal = signal;

        if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
        }

        if (activeHttpRequest) {
            activeHttpRequest.destroy(interruptedError(signal));
        }
    });
}

function closeStreams(stdoutStream, stderrStream, callback) {
    let pending = 2;
    const done = () => {
        pending -= 1;
        if (pending === 0) {
            Promise.resolve(callback()).catch((error) => {
                console.error(error.message);
                process.exit(1);
            });
        }
    };

    stdoutStream.end(done);
    stderrStream.end(done);
}

function sanitizeReportName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'k6-report';
}

async function prepareDownloadJobsBeforeRun() {
    if (!shouldPrepareDownloadJobsBeforeRun()) {
        return;
    }

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

        const progress = await resolveDownloadUrl(authContext, { jobId, filename: exportData.filename || '' }, timeoutMs);
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

function shouldPrepareDownloadJobsBeforeRun() {
    if (String(env.JIMMS_PREPARE_DOWNLOAD_BEFORE_RUN || 'true').toLowerCase() !== 'true') {
        return false;
    }

    if (env.JIMMS_PREPARED_DOWNLOAD_JOBS_JSON) {
        return false;
    }

    return /jimmsDownload/i.test(String(scriptPath || ''));
}

function regularInspectionListUrl() {
    const params = [];
    addQueryParam(params, 'status_id[]', env.JIMMS_REGULAR_INSPECTION_STATUS_ID || '27');
    addQueryParam(params, 'page', env.JIMMS_LIST_PAGE || '1');
    addQueryParam(params, 'per_page', env.JIMMS_LIST_PER_PAGE || '5');

    return `${String(env.JIMMS_API_BASE_URL || '').replace(/\/+$/, '')}/v1/regular-inspection?${params.join('&')}`;
}

function addQueryParam(params, name, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
}

function inspectionIdCandidates(listBody) {
    const configuredIds = splitCsv(env.JIMMS_DOWNLOAD_INSPECTION_IDS);
    if (configuredIds.length > 0) return configuredIds;

    if (!listBody || !listBody.data || !Array.isArray(listBody.data.data)) return [];
    return listBody.data.data.map((row) => row && row.id).filter(Boolean);
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

function archiveScenarioByIndex(index) {
    const names = splitCsv(env.JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS);
    const scenarioNames = names.length > 0 ? names : ['all'];
    const scenarioName = scenarioNames[index % scenarioNames.length];
    return archiveScenarioByName(scenarioName);
}

function archiveScenarioByName(rawName) {
    const name = String(rawName || 'all').trim().toLowerCase();
    const predefined = ARCHIVE_SETS[name];

    if (predefined) {
        return { name, archives: predefined.slice() };
    }

    const customArchives = name.split(/[+|]/).map((item) => item.trim()).filter(Boolean);
    const invalid = customArchives.filter((value) => !ARCHIVE_LABELS[value]);

    if (customArchives.length > 0 && invalid.length === 0) {
        return { name, archives: customArchives };
    }

    throw new Error(`Unknown JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS value "${rawName}".`);
}

function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

async function saveDownloadResultsIfEnabled() {
    if (String(env.JIMMS_SAVE_DOWNLOAD_RESULT || '').toLowerCase() !== 'true') {
        return { enabled: false };
    }

    assertNotInterrupted();

    const results = collectDownloadResults([stdoutLog, stderrLog]);
    const resultDir = path.resolve(projectRoot, env.JIMMS_DOWNLOAD_RESULT_DIR || path.join(env.K6_REPORT_DIR, 'download-results'));
    const zipDir = path.join(resultDir, 'zip', `${scriptName}-${timestamp}`);
    const outputPath = path.join(resultDir, `${scriptName}-${timestamp}.json`);
    const latestPath = path.join(resultDir, `${scriptName}-latest.json`);
    const payload = {
        scriptName,
        createdAt: new Date().toISOString(),
        saveMode: 'zip-files',
        note: 'ZIP files are downloaded from progress-stream downloadUrl after K6 finishes.',
        count: results.length,
        savedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        interrupted: false,
        zipDir,
        sourceLogs: { stdoutLog, stderrLog },
        results,
    };

    fs.mkdirSync(resultDir, { recursive: true });
    fs.mkdirSync(zipDir, { recursive: true });

    if (results.length > 0) {
        let authContext;

        try {
            authContext = await authenticateForDownload();
        } catch (error) {
            payload.failedCount = results.length;
            payload.error = `Failed to authenticate before ZIP download: ${error.message}`;
            payload.results = results.map((result) => ({ ...result, saved: false, error: payload.error }));
            writeDownloadManifest(outputPath, latestPath, payload);
            console.error(`[K6-DOWNLOAD-RESULT] ${payload.error}`);
            return { enabled: true, count: results.length, savedCount: 0, failedCount: results.length, outputPath, latestPath, zipDir, error: payload.error };
        }

        const enrichedResults = [];

        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];

            if (shutdownRequested) {
                payload.interrupted = true;
                payload.skippedCount = appendSkippedDownloadResults(enrichedResults, results, index);
                break;
            }

            try {
                const savedZip = await saveZipForExport(authContext, result, index, zipDir);
                const savedResult = { ...result, saved: true, ...savedZip };
                enrichedResults.push(savedResult);
                payload.savedCount += 1;
                console.log(`[K6-DOWNLOAD-RESULT] Saved ZIP ${index + 1}/${results.length}: ${savedZip.filePath}`);
            } catch (error) {
                if (isInterruptedError(error)) {
                    payload.interrupted = true;
                    payload.skippedCount = appendSkippedDownloadResults(enrichedResults, results, index);
                    break;
                }

                payload.failedCount += 1;
                enrichedResults.push({ ...result, saved: false, error: error.message });
                console.error(`[K6-DOWNLOAD-RESULT] Failed ZIP ${index + 1}/${results.length} jobId=${result.jobId || '-'}: ${error.message}`);
            }
        }

        payload.results = enrichedResults;
    }

    writeDownloadManifest(outputPath, latestPath, payload);
    console.log(`[K6-DOWNLOAD-RESULT] Saved ${payload.savedCount}/${results.length} ZIP file(s): ${zipDir}`);
    if (payload.interrupted) {
        console.log(`[K6-DOWNLOAD-RESULT] Interrupted. Skipped ${payload.skippedCount} remaining ZIP file(s).`);
    }
    console.log(`[K6-DOWNLOAD-RESULT] Manifest: ${outputPath}`);

    return { enabled: true, count: results.length, savedCount: payload.savedCount, failedCount: payload.failedCount, skippedCount: payload.skippedCount, interrupted: payload.interrupted, outputPath, latestPath, zipDir };
}

function writeDownloadManifest(outputPath, latestPath, payload) {
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), 'utf8');
}

function collectDownloadResults(logFiles) {
    const results = [];

    logFiles.forEach((logFile) => {
        if (!fs.existsSync(logFile)) return;

        fs.readFileSync(logFile, 'utf8').split(/\r?\n/).forEach((line) => {
            const message = extractK6Message(line);
            if (!message || !message.includes('JIMMS_EXPORT')) return;

            try {
                const parsed = JSON.parse(message);
                if (parsed && parsed.marker === 'JIMMS_EXPORT') {
                    results.push(parsed);
                }
            } catch (error) {
                // Ignore non-JSON log lines.
            }
        });
    });

    return dedupeResults(results);
}

function extractK6Message(line) {
    const match = String(line || '').match(/\bmsg="((?:\\"|[^"])*)"/);
    if (!match) return String(line || '').trim();

    try {
        return JSON.parse(`"${match[1]}"`);
    } catch (error) {
        return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

function dedupeResults(results) {
    const seen = new Set();
    return results.filter((result) => {
        const key = [result.jobId, result.filename, result.inspectionId, result.archiveScenario].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function authenticateForDownload() {
    assertNotInterrupted();

    const client = createHttpClient();
    const timeoutMs = durationToMs(env.JIMMS_DOWNLOAD_FILE_TIMEOUT || env.JIMMS_EXPORT_TIMEOUT, 120000);
    const csrfUrl = joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/csrf');
    const loginUrl = joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/callback/credentials');
    const sessionUrl = joinUrl(env.JIMMS_FE_BASE_URL, '/api/auth/session');
    const csrfResponse = await client.requestText('GET', csrfUrl, {
        headers: { Accept: 'application/json' },
        timeoutMs,
    });
    const csrfBody = parseJson(csrfResponse.text);
    const csrfToken = csrfBody && csrfBody.csrfToken;

    if (!csrfToken) {
        throw new Error(`No csrfToken from ${csrfUrl}. status=${csrfResponse.status}`);
    }

    const loginBody = new URLSearchParams({
        username: env.JIMMS_USERNAME || '',
        password: env.JIMMS_PASSWORD || '',
        redirect: 'false',
        csrfToken,
        callbackUrl: joinUrl(env.JIMMS_FE_BASE_URL, '/login'),
        json: 'true',
    }).toString();

    const loginResponse = await client.requestText('POST', loginUrl, {
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(loginBody),
        },
        body: loginBody,
        timeoutMs,
    });

    if (loginResponse.status < 200 || loginResponse.status >= 400) {
        throw new Error(`Login failed. status=${loginResponse.status}, body=${loginResponse.text.slice(0, 200)}`);
    }

    const sessionResponse = await client.requestText('GET', sessionUrl, {
        headers: { Accept: 'application/json' },
        timeoutMs,
    });
    const sessionBody = parseJson(sessionResponse.text);
    const accessToken = sessionBody && sessionBody.user && sessionBody.user.accessToken;

    if (!accessToken) {
        throw new Error(`No accessToken from ${sessionUrl}. status=${sessionResponse.status}`);
    }

    return { accessToken, client };
}

async function saveZipForExport(authContext, result, index, zipDir) {
    assertNotInterrupted();

    if (!result || !result.jobId) {
        throw new Error('Missing jobId from K6 export log.');
    }

    const timeoutMs = durationToMs(env.JIMMS_DOWNLOAD_FILE_TIMEOUT || env.JIMMS_EXPORT_TIMEOUT, 120000);
    const progress = await resolveDownloadUrl(authContext, result, timeoutMs);
    const fileName = buildZipFileName(result, progress, index);
    const filePath = path.join(zipDir, fileName);
    const downloaded = await authContext.client.downloadFile('GET', progress.downloadUrl, filePath, {
        headers: apiHeaders(authContext.accessToken, 'application/zip, application/octet-stream, */*'),
        timeoutMs,
    });

    finalizeZipDownload(downloaded);

    return {
        filePath,
        bytes: downloaded.bytes,
        downloadUrl: progress.downloadUrl,
        progressStatus: progress.status,
        progressPercentage: progress.percentage,
        archiveName: progress.archiveName,
        expiredAt: progress.expiredAt,
    };
}

async function resolveDownloadUrl(authContext, result, timeoutMs) {
    const attempts = positiveInteger(env.JIMMS_DOWNLOAD_FILE_POLL_ATTEMPTS, 3);
    const intervalMs = durationToMs(env.JIMMS_DOWNLOAD_FILE_POLL_INTERVAL || `${env.JIMMS_DOWNLOAD_FILE_POLL_INTERVAL_SECONDS || 2}s`, 2000);
    const progressUrl = joinUrl(env.JIMMS_API_BASE_URL, `/v1/regular-inspection/export/${encodeURIComponent(result.jobId)}/progress-stream`);
    let lastError = null;
    let lastProgress = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        assertNotInterrupted();

        try {
            const response = await authContext.client.requestText('GET', progressUrl, {
                headers: apiHeaders(authContext.accessToken, 'text/event-stream'),
                timeoutMs,
                previewBytes: 12000,
                finishOnFirstChunk: true,
            });

            if (response.status !== 200) {
                throw new Error(`progress-stream status=${response.status}, body=${response.text.slice(0, 200)}`);
            }

            lastProgress = lastSseJson(response.text);

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
            lastError = error;
        }

        if (attempt < attempts) {
            await sleep(intervalMs);
        }
    }

    if (lastProgress && !lastProgress.downloadUrl) {
        throw new Error(`No downloadUrl from progress-stream. status=${lastProgress.status || '-'}, percentage=${lastProgress.percentage || '-'}`);
    }

    if (lastError) {
        throw lastError;
    }

    return {
        downloadUrl: joinUrl(env.JIMMS_API_BASE_URL, `/v1/regular-inspection/export/${encodeURIComponent(result.jobId)}/download`),
        status: 'UNKNOWN',
    };
}

function createHttpClient() {
    const cookies = new Map();

    function rememberCookies(headers) {
        const setCookie = headers['set-cookie'];
        if (!setCookie) return;

        (Array.isArray(setCookie) ? setCookie : [setCookie]).forEach((cookie) => {
            const pair = String(cookie).split(';')[0];
            const separatorIndex = pair.indexOf('=');
            if (separatorIndex > 0) {
                cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
            }
        });
    }

    function cookieHeader() {
        return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
    }

    function requestOptions(method, urlString, headers) {
        const url = new URL(urlString);
        const finalHeaders = { ...headers };
        const cookie = cookieHeader();

        if (cookie && !hasHeader(finalHeaders, 'Cookie')) {
            finalHeaders.Cookie = cookie;
        }

        return {
            lib: url.protocol === 'https:' ? https : http,
            url,
            options: {
                method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                headers: finalHeaders,
                rejectUnauthorized: String(env.JIMMS_INSECURE_SKIP_TLS_VERIFY || '').toLowerCase() !== 'true',
            },
        };
    }

    async function requestText(method, urlString, options = {}, redirectCount = 0) {
        const response = await requestBuffer(method, urlString, options, redirectCount);
        return { ...response, text: response.body.toString('utf8') };
    }

    function requestBuffer(method, urlString, options = {}, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (shutdownRequested) {
                reject(interruptedError());
                return;
            }

            const body = requestBodyBuffer(options.body);
            const headers = withContentLength(options.headers || {}, body);
            const prepared = requestOptions(method, urlString, headers);
            const request = prepared.lib.request(prepared.options, (response) => {
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
                let bytes = 0;
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
                    bytes += chunk.length;
                    if (options.finishOnFirstChunk || (options.previewBytes && bytes >= options.previewBytes)) {
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

    function downloadFile(method, urlString, targetPath, options = {}, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (shutdownRequested) {
                reject(interruptedError());
                return;
            }

            const headers = { ...(options.headers || {}) };
            const prepared = requestOptions(method, urlString, headers);
            const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
            let failDownload = null;
            const request = prepared.lib.request(prepared.options, (response) => {
                rememberCookies(response.headers);

                if (shouldFollowRedirect(response, options, redirectCount)) {
                    response.resume();
                    response.on('end', () => {
                        const nextUrl = new URL(response.headers.location, urlString).toString();
                        const nextMethod = redirectMethod(method, response.statusCode);
                        const nextOptions = redirectOptions(options, headers, urlString, nextUrl, nextMethod);
                        downloadFile(nextMethod, nextUrl, targetPath, nextOptions, redirectCount + 1).then(resolve, reject);
                    });
                    return;
                }

                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                const output = fs.createWriteStream(tempPath, { flags: 'w' });
                const firstChunks = [];
                let firstBytesLength = 0;
                let bytes = 0;
                let settled = false;
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    safeUnlink(tempPath);
                    reject(error);
                };
                failDownload = fail;

                response.on('data', (chunk) => {
                    bytes += chunk.length;
                    if (firstBytesLength < 512) {
                        const slice = chunk.slice(0, 512 - firstBytesLength);
                        firstChunks.push(slice);
                        firstBytesLength += slice.length;
                    }
                });
                response.on('error', fail);
                output.on('error', fail);
                output.on('finish', () => {
                    if (settled) return;
                    settled = true;
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        bytes,
                        firstBytes: Buffer.concat(firstChunks),
                        tempPath,
                        filePath: targetPath,
                        url: urlString,
                    });
                });
                response.pipe(output);
            });

            trackActiveRequest(request);
            request.on('error', (error) => {
                if (failDownload) {
                    failDownload(error);
                    return;
                }
                safeUnlink(tempPath);
                reject(error);
            });
            request.setTimeout(options.timeoutMs || 120000, () => request.destroy(new Error(`Request timeout after ${options.timeoutMs || 120000}ms: ${method} ${urlString}`)));
            request.end();
        });
    }

    return { requestText, downloadFile };
}

function appendSkippedDownloadResults(enrichedResults, results, startIndex) {
    const skipped = results.slice(startIndex).map((result) => ({
        ...result,
        saved: false,
        skipped: true,
        error: `Interrupted by ${shutdownSignal || 'signal'}.`,
    }));

    enrichedResults.push(...skipped);
    return skipped.length;
}

function assertNotInterrupted() {
    if (shutdownRequested) {
        throw interruptedError();
    }
}

function interruptedError(signal = shutdownSignal || 'signal') {
    const error = new Error(`Interrupted by ${signal}.`);
    error.code = 'K6_RUNNER_INTERRUPTED';
    return error;
}

function isInterruptedError(error) {
    return Boolean(error && (error.code === 'K6_RUNNER_INTERRUPTED' || String(error.message || '').startsWith('Interrupted by ')));
}

function trackActiveRequest(request) {
    activeHttpRequest = request;
    request.on('close', () => {
        if (activeHttpRequest === request) {
            activeHttpRequest = null;
        }
    });
}

function shouldFollowRedirect(response, options, redirectCount) {
    const maxRedirects = options.maxRedirects === undefined ? 5 : options.maxRedirects;
    return [301, 302, 303, 307, 308].includes(response.statusCode)
        && response.headers.location
        && redirectCount < maxRedirects;
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

function requestBodyBuffer(body) {
    if (body === undefined || body === null) return null;
    return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function withContentLength(headers, body) {
    const nextHeaders = { ...headers };

    if (body && !hasHeader(nextHeaders, 'Content-Length')) {
        nextHeaders['Content-Length'] = body.length;
    }

    return nextHeaders;
}

function hasHeader(headers, name) {
    return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function deleteHeader(headers, name) {
    Object.keys(headers).forEach((key) => {
        if (key.toLowerCase() === name.toLowerCase()) {
            delete headers[key];
        }
    });
}

function finalizeZipDownload(downloaded) {
    const contentType = String(downloaded.headers['content-type'] || '').toLowerCase();
    const contentDisposition = String(downloaded.headers['content-disposition'] || '').toLowerCase();
    const firstBytes = downloaded.firstBytes || Buffer.alloc(0);
    const looksLikeZip = firstBytes.slice(0, 2).toString('utf8') === 'PK'
        || contentType.includes('zip')
        || contentType.includes('octet-stream')
        || contentDisposition.includes('.zip')
        || contentDisposition.includes('attachment');

    if (downloaded.status !== 200 || !looksLikeZip) {
        const preview = safeReadPreview(downloaded.tempPath);
        safeUnlink(downloaded.tempPath);
        throw new Error(`Download did not return ZIP. status=${downloaded.status}, content-type=${contentType || '-'}, body=${preview}`);
    }

    if (fs.existsSync(downloaded.filePath)) {
        fs.unlinkSync(downloaded.filePath);
    }

    fs.renameSync(downloaded.tempPath, downloaded.filePath);
}

function apiHeaders(accessToken, accept) {
    return {
        Accept: accept,
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': env.JIMMS_API_KEY,
    };
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

function buildZipFileName(result, progress, index) {
    const sourceName = progress.archiveName || result.filename || `${result.jobId}.zip`;
    const withExtension = String(sourceName).toLowerCase().endsWith('.zip') ? sourceName : `${sourceName}.zip`;
    const prefix = `${String(index + 1).padStart(3, '0')}-${String(result.jobId).slice(0, 8)}`;

    return sanitizeFileName(`${prefix}-${withExtension}`);
}

function sanitizeFileName(value) {
    const sanitized = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');

    return sanitized || 'jimms-download.zip';
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

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeReadPreview(filePath) {
    try {
        return fs.readFileSync(filePath).toString('utf8', 0, 200).replace(/\s+/g, ' ').trim();
    } catch (error) {
        return '';
    }
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        // Ignore cleanup errors.
    }
}
