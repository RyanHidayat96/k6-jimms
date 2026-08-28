const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadPerformanceEnv } = require('./envLoader');

const projectRoot = path.resolve(__dirname, '..');
const env = loadPerformanceEnv(projectRoot);
const reportDir = path.resolve(projectRoot, env.K6_REPORT_DIR || './test-results/reports/k6');

if (!fs.existsSync(reportDir)) {
    console.error(`K6 report directory does not exist: ${reportDir}`);
    process.exit(1);
}

const htmlFiles = fs.readdirSync(reportDir)
    .filter((file) => file.toLowerCase().endsWith('.html'))
    .map((file) => ({ file, fullPath: path.join(reportDir, file), mtimeMs: fs.statSync(path.join(reportDir, file)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

if (htmlFiles.length === 0) {
    console.error(`No K6 HTML report found in ${reportDir}. Run npm run report:html first.`);
    process.exit(1);
}

const indexPath = path.join(reportDir, 'index.html');
const target = fs.existsSync(indexPath)
    ? { fullPath: indexPath }
    : htmlFiles[0];
openFile(target.fullPath);
console.log(`Opened K6 HTML report: ${target.fullPath}`);

function openFile(filePath) {
    if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
        return;
    }

    if (process.platform === 'darwin') {
        spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
        return;
    }

    spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
}
