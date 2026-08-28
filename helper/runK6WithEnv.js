const fs = require('fs');
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
