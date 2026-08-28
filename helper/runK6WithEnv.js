const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { loadPerformanceEnv } = require('./envLoader');

const [, , scriptPath, ...extraArgs] = process.argv;
const INTERRUPTED_EXIT_CODE = 130;

let shutdownRequested = false;
let shutdownSignal = '';
let child = null;

if (!scriptPath) {
    console.error('Usage: node helper/runK6WithEnv.js <k6-script> [k6-args...]');
    process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const env = loadPerformanceEnv(projectRoot);

env.K6_REPORT_DIR = env.K6_REPORT_DIR || './test-results/reports/k6';
fs.mkdirSync(path.resolve(projectRoot, env.K6_REPORT_DIR), { recursive: true });

const scriptName = sanitizeReportName(env.K6_REPORT_NAME || reportNameForScript(scriptPath));
const debugDir = path.resolve(projectRoot, env.K6_REPORT_DIR, 'debug');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const stdoutLog = path.join(debugDir, `${scriptName}-${timestamp}.out.log`);
const stderrLog = path.join(debugDir, `${scriptName}-${timestamp}.err.log`);
const latestLog = path.join(debugDir, `${scriptName}-latest-log.json`);

forwardSignal('SIGINT');
forwardSignal('SIGTERM');

main().catch((error) => {
    const interrupted = shutdownRequested;
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
    const exitCode = await runK6();

    if (!shutdownRequested && shouldSaveDownloadedZip()) {
        await saveDownloadedZipArtifacts();
    }

    process.exit(exitCode);
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
    });
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

function shouldSaveDownloadedZip() {
    return boolEnv('JIMMS_SAVE_DOWNLOADED_ZIP', false);
}

async function saveDownloadedZipArtifacts() {
    const jobs = downloadedZipJobsFromLogs();
    if (jobs.length === 0) {
        console.warn('[K6-DOWNLOAD-ARTIFACT] No successful ZIP download URL found. Nothing to save.');
        return;
    }

    const artifactDir = path.resolve(projectRoot, env.K6_REPORT_DIR, 'download-results', 'zip', `${scriptName}-${timestamp}`);
    fs.mkdirSync(artifactDir, { recursive: true });

    let accessToken = '';
    try {
        accessToken = await accessTokenForArtifacts();
    } catch (error) {
        console.warn(`[K6-DOWNLOAD-ARTIFACT] Cannot login for ZIP artifact download: ${error.message}`);
        return;
    }

    let saved = 0;
    let failed = 0;

    for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index];
        try {
            const response = await requestBuffer('GET', absoluteApiUrl(job.downloadUrl), {
                headers: apiHeaders(accessToken, 'application/zip, application/octet-stream, */*'),
                timeoutMs: durationToMs(env.JIMMS_DOWNLOAD_FILE_TIMEOUT || '120s', 120000),
                rejectUnauthorized: !boolEnv('JIMMS_INSECURE_SKIP_TLS_VERIFY', false),
            });

            if (response.status !== 200 || !bufferStartsWithZipMagic(response.body)) {
                throw new Error(`status=${response.status}, bytes=${response.body.length}, body=${sampleBuffer(response.body)}`);
            }

            const filePath = path.join(artifactDir, artifactZipName(index + 1, job));
            fs.writeFileSync(filePath, response.body);
            saved += 1;
            console.log(`[K6-DOWNLOAD-ARTIFACT] Saved ZIP ${index + 1}/${jobs.length}: ${filePath}`);
        } catch (error) {
            failed += 1;
            console.warn(`[K6-DOWNLOAD-ARTIFACT] Failed ZIP ${index + 1}/${jobs.length}: jobId=${job.jobId || 'N/A'} - ${error.message}`);
        }
    }

    console.log(`[K6-DOWNLOAD-ARTIFACT] Finished. saved=${saved}, failed=${failed}, folder=${artifactDir}`);
}

function downloadedZipJobsFromLogs() {
    const marker = '[K6-DOWNLOADED-ZIP-READY] ';
    const files = [stdoutLog, stderrLog].filter((filePath) => fs.existsSync(filePath));
    const seen = new Set();
    const jobs = [];

    files.forEach((filePath) => {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        lines.forEach((line) => {
            const raw = extractDebugJsonPayload(line, marker);
            if (!raw) return;

            let job;
            try {
                job = JSON.parse(raw);
            } catch (error) {
                return;
            }

            if (!job || !job.downloadUrl) return;

            const key = `${job.jobId || ''}|${job.downloadUrl}`;
            if (seen.has(key)) return;

            seen.add(key);
            jobs.push({
                jobId: String(job.jobId || ''),
                filename: String(job.filename || ''),
                downloadUrl: String(job.downloadUrl || ''),
            });
        });
    });

    return jobs;
}

async function accessTokenForArtifacts() {
    if (env.JIMMS_ACCESS_TOKEN) return env.JIMMS_ACCESS_TOKEN;

    const feBaseUrl = normalizeBaseUrl(env.JIMMS_FE_BASE_URL || env.BASE_URL || '');
    const username = env.JIMMS_USERNAME || env.USERNAME || '';
    const password = env.JIMMS_PASSWORD || env.PASSWORD || '';

    if (!feBaseUrl || !username || !password) {
        throw new Error('Isi JIMMS_ACCESS_TOKEN atau JIMMS_USERNAME/JIMMS_PASSWORD.');
    }

    const cookieJar = createCookieJar();
    const csrfResponse = await requestJson('GET', `${feBaseUrl}/api/auth/csrf`, {
        headers: { Accept: 'application/json' },
        cookieJar,
        timeoutMs: 30000,
    });
    const csrfToken = csrfResponse.json && csrfResponse.json.csrfToken;
    if (csrfResponse.status !== 200 || !csrfToken) {
        throw new Error(`csrf failed. status=${csrfResponse.status}`);
    }

    const body = new URLSearchParams({
        username,
        password,
        redirect: 'false',
        csrfToken,
        callbackUrl: env.JIMMS_CALLBACK_URL || `${feBaseUrl}/login`,
        json: 'true',
    }).toString();

    const loginResponse = await requestJson('POST', `${feBaseUrl}/api/auth/callback/credentials`, {
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        cookieJar,
        timeoutMs: 30000,
    });
    if (loginResponse.status !== 200) {
        throw new Error(`login failed. status=${loginResponse.status}`);
    }

    const sessionResponse = await requestJson('GET', `${feBaseUrl}/api/auth/session`, {
        headers: { Accept: 'application/json' },
        cookieJar,
        timeoutMs: 30000,
    });
    const accessToken = sessionResponse.json
        && sessionResponse.json.user
        && sessionResponse.json.user.accessToken;

    if (sessionResponse.status !== 200 || !accessToken) {
        throw new Error(`session token not found. status=${sessionResponse.status}`);
    }

    return String(accessToken);
}

function requestJson(method, url, options = {}) {
    return requestBuffer(method, url, options).then((response) => ({
        ...response,
        json: parseJson(response.body.toString('utf8')),
    }));
}

function requestBuffer(method, url, options = {}) {
    const timeoutMs = options.timeoutMs || 120000;
    const redirectCount = options.redirectCount || 0;
    const rejectUnauthorized = options.rejectUnauthorized !== false;
    const cookieJar = options.cookieJar;
    const requestBody = options.body === undefined || options.body === null
        ? null
        : Buffer.isBuffer(options.body)
            ? options.body
            : Buffer.from(String(options.body));

    return new Promise((resolve, reject) => {
        const urlObject = new URL(url);
        const client = urlObject.protocol === 'https:' ? https : http;
        const headers = { ...(options.headers || {}) };
        const cookieHeader = cookieJar ? cookieJar.header() : '';

        if (cookieHeader) headers.Cookie = cookieHeader;
        if (requestBody && !headerExists(headers, 'Content-Length')) {
            headers['Content-Length'] = String(requestBody.length);
        }
        if (!requestBody) {
            removeHeader(headers, 'Content-Length');
        }

        const request = client.request(urlObject, {
            method,
            headers,
            rejectUnauthorized,
        }, (response) => {
            if (cookieJar) cookieJar.store(response.headers['set-cookie']);

            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                const location = response.headers.location;

                if (isRedirect(response.statusCode) && location && redirectCount < 5) {
                    const nextUrl = new URL(location, urlObject).toString();
                    const nextMethod = response.statusCode === 303 ? 'GET' : method;
                    const nextBody = response.statusCode === 303 ? null : requestBody;

                    requestBuffer(nextMethod, nextUrl, {
                        ...options,
                        body: nextBody,
                        redirectCount: redirectCount + 1,
                    }).then(resolve).catch(reject);
                    return;
                }

                resolve({
                    status: response.statusCode || 0,
                    headers: response.headers || {},
                    body,
                });
            });
        });

        request.on('error', reject);
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`timeout after ${timeoutMs}ms: ${method} ${url}`));
        });

        if (requestBody) request.write(requestBody);
        request.end();
    });
}

function createCookieJar() {
    const cookies = new Map();

    return {
        store(setCookieHeader) {
            const values = Array.isArray(setCookieHeader)
                ? setCookieHeader
                : setCookieHeader
                    ? [setCookieHeader]
                    : [];

            values.forEach((value) => {
                const pair = String(value || '').split(';')[0];
                const separatorIndex = pair.indexOf('=');
                if (separatorIndex <= 0) return;

                cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
            });
        },
        header() {
            return Array.from(cookies.entries())
                .map(([key, value]) => `${key}=${value}`)
                .join('; ');
        },
    };
}

function apiHeaders(accessToken, accept) {
    const headers = { Accept: accept };
    const apiKey = env.JIMMS_API_KEY || env.API_KEY || '';

    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (apiKey) headers['x-api-key'] = apiKey;

    return headers;
}

function absoluteApiUrl(value) {
    const raw = String(value || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;

    const apiBaseUrl = normalizeBaseUrl(env.JIMMS_API_BASE_URL || env.API_BASE_URL || '');
    if (!apiBaseUrl) throw new Error('JIMMS_API_BASE_URL is required.');

    return `${apiBaseUrl}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function extractDebugJsonPayload(line, marker) {
    const index = line.indexOf(marker);
    if (index === -1) return '';

    let raw = line.slice(index + marker.length).trim();
    const sourceIndex = raw.indexOf('" source=');
    if (sourceIndex !== -1) raw = raw.slice(0, sourceIndex);
    if (raw.endsWith('"')) raw = raw.slice(0, -1);
    raw = raw.trim();

    if (raw.startsWith('{')) {
        try {
            JSON.parse(raw);
            return raw;
        } catch (error) {
            // k6 logger can escape quotes inside msg="...".
        }
    }

    try {
        const decodedJsonString = JSON.parse(`"${raw}"`);
        if (String(decodedJsonString).trim().startsWith('{')) {
            return decodedJsonString.trim();
        }
    } catch (error) {
        // Fall through to conservative cleanup.
    }

    const decoded = raw
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();

    return decoded.startsWith('{') ? decoded : '';
}

function artifactZipName(index, job) {
    const paddedIndex = String(index).padStart(3, '0');
    const shortJobId = sanitizeFileName(String(job.jobId || 'job').replace(/-/g, '').slice(0, 8) || 'job');
    const sourceName = String(job.filename || `${job.jobId || 'download'}.zip`).replace(/\.zip$/i, '');
    return `${paddedIndex}-${shortJobId}-${sanitizeFileName(sourceName)}.zip`;
}

function sanitizeFileName(value) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .trim()
        .slice(0, 150) || 'download';
}

function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '');
}

function durationToMs(value, defaultValue) {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return defaultValue;

    const amount = Number(match[1]);
    const unit = String(match[2] || 'ms').toLowerCase();
    const multiplier = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;

    return Math.max(1, Math.round(amount * multiplier));
}

function boolEnv(name, defaultValue = false) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue === '') return defaultValue;
    return String(rawValue).toLowerCase() === 'true';
}

function headerExists(headers, name) {
    return Object.keys(headers).some((key) => key.toLowerCase() === String(name).toLowerCase());
}

function removeHeader(headers, name) {
    Object.keys(headers)
        .filter((key) => key.toLowerCase() === String(name).toLowerCase())
        .forEach((key) => {
            delete headers[key];
        });
}

function isRedirect(status) {
    return [301, 302, 303, 307, 308].includes(Number(status));
}

function parseJson(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

function bufferStartsWithZipMagic(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function sampleBuffer(buffer) {
    return Buffer.isBuffer(buffer)
        ? buffer.toString('utf8', 0, Math.min(buffer.length, 300)).replace(/\s+/g, ' ')
        : '';
}

function sanitizeReportName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140) || 'k6-report';
}

function reportNameForScript(value) {
    const baseName = path.basename(value, path.extname(value));
    if (baseName === 'jimmsDownloadScenarios') return 'jimmsDownloadTest';
    return baseName;
}
