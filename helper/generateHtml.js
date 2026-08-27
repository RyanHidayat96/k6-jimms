const fs = require('fs');
const path = require('path');
const { loadPerformanceEnv } = require('./envLoader');

const projectRoot = path.resolve(__dirname, '..');
const env = loadPerformanceEnv(projectRoot);
const reportDir = path.resolve(projectRoot, env.K6_REPORT_DIR || './test-results/reports/k6');
const debugDir = path.join(reportDir, 'debug');
const summaryFiles = fs.existsSync(reportDir)
    ? fs.readdirSync(reportDir).filter((file) => file.endsWith('-summary.json')).filter(shouldIncludeSummaryFile)
    : [];
const endpointCatalog = loadEndpointCatalog();

const VALID_RESPONSE_RATE_METRIC = 'jimms_valid_response_rate';
const LOAD_ERROR_RATE_METRIC = 'jimms_load_error_rate';
const VALID_REQUEST_DURATION_METRIC = 'jimms_valid_req_duration';
const DATA_PRECONDITION_COUNT_METRIC = 'jimms_data_precondition_count';

if (summaryFiles.length === 0) {
    removeStaleOverviewFiles();
    console.error(`No JIMMS K6 summary files found in ${reportDir}. Run smoke/load until K6 writes *-summary.json.`);
    latestRunErrors().forEach((item) => console.error(`Latest ${item.scriptName}: ${item.status}${item.error ? ` - ${item.error}` : ''}`));
    process.exit(1);
}

const generatedReports = summaryFiles.map((file) => {
    const summaryPath = path.join(reportDir, file);
    const summary = readJsonFile(summaryPath);
    const reportName = file.replace(/-summary\.json$/, '');
    const reportFileName = `${reportFileBaseName(reportName)}.html`;
    const outputPath = path.join(reportDir, reportFileName);

    fs.writeFileSync(outputPath, renderDetailHtml(reportName, summary), 'utf8');
    console.log(`Generated HTML report: ${outputPath}`);
    return { reportName, summary, fileName: reportFileName, outputPath };
});

const overviewHtml = renderOverviewHtml(generatedReports);
const overviewPath = path.join(reportDir, 'jimmsDownloadPerformanceOverview.html');
const indexPath = path.join(reportDir, 'index.html');
fs.writeFileSync(overviewPath, overviewHtml, 'utf8');
fs.writeFileSync(indexPath, overviewHtml, 'utf8');
console.log(`Generated HTML report: ${overviewPath}`);
console.log(`Generated HTML report: ${indexPath}`);

function loadEndpointCatalog() {
    const catalogPath = path.join(projectRoot, 'data', 'jimms', 'downloadEndpoints.json');
    if (!fs.existsSync(catalogPath)) return [];
    try {
        return readJsonFile(catalogPath);
    } catch (error) {
        return [];
    }
}

function shouldIncludeSummaryFile(file) {
    if (String(env.K6_INCLUDE_PROBE_REPORTS || '').toLowerCase() === 'true') return true;
    return !/probe/i.test(file);
}

function removeStaleOverviewFiles() {
    ['jimmsDownloadPerformanceOverview.html', 'index.html'].forEach((file) => {
        const filePath = path.join(reportDir, file);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
}

function latestRunErrors() {
    if (!fs.existsSync(debugDir)) return [];

    return fs.readdirSync(debugDir)
        .filter((file) => file.endsWith('-latest-log.json'))
        .map((file) => {
            try {
                return readJsonFile(path.join(debugDir, file));
            } catch (error) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
        .slice(0, 5);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function reportFileBaseName(reportName) {
    const names = {
        jimmsDownloadSmoke: 'jimmsDownloadSmoke',
        jimmsDownloadScenariosLoad: 'jimmsDownloadScenariosLoad',
        jimmsDownloadScenariosStress: 'jimmsDownloadScenariosStress',
    };
    return names[reportName] || reportName;
}

function displayReportName(reportName) {
    const names = {
        jimmsDownloadSmoke: 'Download - Smoke',
        jimmsDownloadScenariosLoad: 'Download - Load',
        jimmsDownloadScenariosStress: 'Download - Stress',
    };
    return names[reportName] || reportName;
}

function renderOverviewHtml(reports) {
    const rows = reports
        .sort((left, right) => displayReportName(left.reportName).localeCompare(displayReportName(right.reportName)))
        .map((report) => {
            const summary = buildReportSummary(report.reportName, report.summary);
            return `<tr>
<td><a href="${escapeHtml(report.fileName)}">${escapeHtml(displayReportName(report.reportName))}</a></td>
<td class="${summary.status === 'PASS' ? 'status-pass' : 'status-fail'}">${escapeHtml(summary.status)}</td>
<td>${escapeHtml(formatNumber(summary.iterations))}</td>
<td>${escapeHtml(formatNumber(summary.httpRequests))}</td>
<td>${escapeHtml(formatPercent(summary.validResponseRate))}</td>
<td>${escapeHtml(formatPercent(summary.loadErrorRate))}</td>
<td>${escapeHtml(formatMsReadable(summary.validP95))}</td>
<td>${escapeHtml(formatMsReadable(summary.max))}</td>
</tr>`;
        })
        .join('');
    const failedRows = reports
        .flatMap((report) => {
            const summary = buildReportSummary(report.reportName, report.summary);
            return summary.failedChecks.slice(0, 8).map((check) => ({ reportName: report.reportName, check }));
        })
        .sort((left, right) => right.check.fails - left.check.fails)
        .slice(0, 12)
        .map((item) => `<tr><td>${escapeHtml(displayReportName(item.reportName))}</td><td>${escapeHtml(item.check.name)}</td><td>${formatNumber(item.check.passes)}</td><td>${formatNumber(item.check.fails)}</td></tr>`)
        .join('');
    const errorRows = reports
        .flatMap((report) => {
            const summary = buildReportSummary(report.reportName, report.summary);
            return summary.errors.slice(0, 8).map((error) => ({ reportName: report.reportName, error }));
        })
        .sort((left, right) => right.error.count - left.error.count)
        .slice(0, 12)
        .map((item) => `<tr><td>${escapeHtml(displayReportName(item.reportName))}</td><td>${escapeHtml(item.error.request)}</td><td>${escapeHtml(displayErrorCategory(item.error.category))}</td><td>${escapeHtml(item.error.status)}</td><td>${escapeHtml(item.error.responseCode)}</td><td>${escapeHtml(item.error.message)}</td><td>${formatNumber(item.error.count)}</td></tr>`)
        .join('');

    return page('K6 Performance Overview', 'JIMMS download performance reports', `
${section('Ringkasan Report', `<p class="small">Klik nama report untuk detail request, header, response sample, checks, thresholds, dan metrik lengkap.</p><table><thead><tr><th>Report</th><th>Status</th><th>Iterations</th><th>HTTP Requests</th><th>Valid Response</th><th>Load Error Rate</th><th>Valid P95</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table>`)}
${section('Failed Check Terbanyak', failedRows ? `<table><thead><tr><th>Report</th><th>Check</th><th>Pass</th><th>Fail</th></tr></thead><tbody>${failedRows}</tbody></table>` : '<p class="small">Tidak ada failed check.</p>')}
${section('Error Terbanyak', errorRows ? `<table><thead><tr><th>Report</th><th>Endpoint / Request</th><th>Kategori</th><th>HTTP Status</th><th>Response Code</th><th>Pesan Error</th><th>Jumlah</th></tr></thead><tbody>${errorRows}</tbody></table>` : '<p class="small">Tidak ada error HTTP/API yang tercatat.</p>')}
`);
}

function renderDetailHtml(reportName, summary) {
    const displayName = displayReportName(reportName);
    const metrics = summary.metrics || {};
    const checks = collectChecks(summary.root_group);
    const thresholds = collectThresholds(metrics);
    const durationMs = summary.state && typeof summary.state.testRunDurationMs === 'number'
        ? summary.state.testRunDurationMs
        : undefined;
    const errors = collectApiErrors(metrics);
    const responseSamples = collectApiResponseSamples();
    const runtimeEvidence = collectRuntimeEvidence();
    const status = reportStatus(thresholds, checks);

    return page('K6 Performance Report', displayName, `
<a class="back-link" href="index.html" aria-label="Kembali ke halaman awal">&larr; Kembali ke halaman awal</a>
<section class="card grid">
${kpi('Status', status, status === 'PASS' ? 'status-pass' : 'status-fail')}
${kpi('Duration', durationMs === undefined ? '-' : formatMs(durationMs))}
${kpi('Valid Response Rate', preferredMetricRate(metrics, VALID_RESPONSE_RATE_METRIC, 'checks'))}
${kpi('Load Error Rate', preferredMetricRate(metrics, LOAD_ERROR_RATE_METRIC, 'http_req_failed'))}
${kpi('Data/Precondition', metricValue(metrics[DATA_PRECONDITION_COUNT_METRIC], 'count'))}
${kpi('HTTP Requests', metricValue(metrics.http_reqs, 'count'))}
${kpi('Iterations', metricValue(metrics.iterations, 'count'))}
</section>
${section('Konfigurasi Run', runConfigurationTable(runConfigurationForReport(summary, displayName, metrics, thresholds, durationMs)))}
${section('Kesimpulan Pengujian', conclusionHtml(metrics, checks, thresholds, durationMs, status))}
${section('Error Summary', errorSummaryTable(errors))}
${section('Request, Header & Response Ringkasan', requestSummaryTable(endpointCatalog, responseSamples, runtimeEvidence))}
${section('Response Time per Endpoint', endpointDurationTable(endpointDurationsForReport(metrics, thresholds)))}
${section('Valid Traffic Duration Global', metricTable(metrics[VALID_REQUEST_DURATION_METRIC]))}
${section('HTTP Duration Global', metricTable(metrics.http_req_duration))}
${section('Checks', checksTable(checks))}
${section('Thresholds', thresholdsTable(thresholds))}
${section('Key Metrics', keyMetricsTable(metrics))}
`);
}

function page(title, subtitle, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${sharedStyles()}
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<div>${escapeHtml(subtitle || 'JIMMS TAMS Perkerasan Rutin download export')}</div>
</header>
<main>
${body}
<p class="small">Generated at ${escapeHtml(new Date().toISOString())}</p>
</main>
</body>
</html>`;
}

function sharedStyles() {
    return `<style>
:root { color-scheme: light; --ink:#142033; --muted:#64748b; --line:#d8e0ea; --head:#0f4c81; --pass:#12805c; --fail:#bf1d2d; --bg:#f6f8fb; --card:#ffffff; }
body { margin:0; font-family: Arial, Helvetica, sans-serif; background:var(--bg); color:var(--ink); }
header { background:var(--head); color:white; padding:28px 36px; }
h1 { margin:0 0 8px; font-size:28px; }
main { padding:28px 36px 42px; }
a { color:#0f4c81; font-weight:700; text-decoration:none; }
a:hover { text-decoration:underline; }
.back-link { display:inline-flex; align-items:center; gap:6px; margin-bottom:16px; padding:8px 12px; border:1px solid rgba(255,255,255,.55); border-radius:6px; color:white; background:rgba(255,255,255,.12); font-weight:700; }
.back-link:hover { background:rgba(255,255,255,.2); text-decoration:none; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:20px; margin-bottom:18px; box-shadow:0 1px 2px rgba(20,32,51,.05); }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; }
.kpi { border:1px solid var(--line); border-radius:8px; padding:14px; background:#fbfdff; }
.kpi .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.kpi .value { margin-top:6px; font-size:22px; font-weight:700; }
.status-pass { color:var(--pass); }
.status-fail { color:var(--fail); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th { background:#eaf2f9; text-align:left; color:#123b5d; }
th, td { border:1px solid var(--line); padding:10px 12px; vertical-align:top; }
code { background:#edf2f7; border-radius:4px; padding:2px 5px; }
details summary { cursor:pointer; color:#0f4c81; font-weight:700; }
pre { margin:8px 0 0; padding:10px; background:#0f172a; color:#e2e8f0; border-radius:6px; white-space:pre-wrap; word-break:break-word; max-width:760px; }
.small { color:var(--muted); font-size:13px; }
.conclusion { display:grid; gap:14px; }
.conclusion-lead { font-size:16px; line-height:1.5; margin:0; }
.pill { display:inline-block; padding:4px 10px; border-radius:999px; font-weight:700; font-size:12px; letter-spacing:.03em; }
.pill-pass { color:#065f46; background:#d1fae5; }
.pill-fail { color:#991b1b; background:#fee2e2; }
.summary-list { margin:0; padding-left:18px; line-height:1.55; }
</style>`;
}

function buildReportSummary(reportName, summary) {
    const metrics = summary.metrics || {};
    const checks = collectChecks(summary.root_group);
    const thresholds = collectThresholds(metrics);
    return {
        reportName,
        status: reportStatus(thresholds, checks),
        validResponseRate: preferredMetricPercentNumber(metrics, VALID_RESPONSE_RATE_METRIC, 'checks'),
        loadErrorRate: preferredMetricPercentNumber(metrics, LOAD_ERROR_RATE_METRIC, 'http_req_failed'),
        dataPreconditions: metricCounterTotal(metrics, DATA_PRECONDITION_COUNT_METRIC),
        httpRequests: metricNumber(metrics.http_reqs, 'count'),
        iterations: metricNumber(metrics.iterations, 'count'),
        validP95: preferredMetricNumber(metrics, VALID_REQUEST_DURATION_METRIC, 'http_req_duration', 'p(95)'),
        max: metricNumber(metrics.http_req_duration, 'max'),
        failedChecks: checks.filter((item) => item.fails > 0).sort((a, b) => b.fails - a.fails),
        errors: collectApiErrors(metrics),
    };
}

function runConfigurationForReport(summary, displayName, metrics, thresholds, durationMs) {
    const config = summary.reportConfig || {};
    const thresholdValues = config.thresholds || {};
    return [
        ['Report', displayName],
        ['FE Base URL', safeConfigValue(config.feBaseUrl || env.JIMMS_FE_BASE_URL || '-')],
        ['API Base URL', safeConfigValue(config.apiBaseUrl || env.JIMMS_API_BASE_URL || '-')],
        ['Status filter', safeConfigValue(config.statusFilter || `status_id[]=${env.JIMMS_REGULAR_INSPECTION_STATUS_ID || 27}`)],
        ['Archive scenarios', safeConfigValue(config.archiveScenarios || env.JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS || 'all')],
        ['Download flow mode', safeConfigValue(config.downloadFlowMode || env.JIMMS_DOWNLOAD_FLOW_MODE || 'real-user')],
        ['Executor', safeConfigValue(config.executor)],
        ['Configured VU', safeConfigValue(config.vus || config.targetVus)],
        ['Actual max VU', safeConfigValue(metricNumber(metrics.vus_max, 'max') || metricNumber(metrics.vus_max, 'value'))],
        ['Configured iterations', safeConfigValue(config.iterations)],
        ['Completed iterations', safeConfigValue(metricNumber(metrics.iterations, 'count'))],
        ['HTTP requests', safeConfigValue(metricNumber(metrics.http_reqs, 'count'))],
        ['Duration / maxDuration', `${safeConfigValue(config.duration)} / ${safeConfigValue(config.maxDuration)}`],
        ['Actual run duration', durationMs === undefined ? '-' : formatMs(durationMs)],
        ['Ramp up / hold / ramp down', `${safeConfigValue(config.rampUp)} / ${safeConfigValue(config.hold)} / ${safeConfigValue(config.rampDown)}`],
        ['Think time', `${safeConfigValue(config.thinkTimeSeconds)} second(s)`],
        ['Prepare download before run', safeConfigValue(config.prepareDownloadBeforeRun || env.JIMMS_PREPARE_DOWNLOAD_BEFORE_RUN || 'true')],
        ['Direct download URLs configured', safeConfigValue(config.downloadDirectUrlsConfigured || (env.JIMMS_DOWNLOAD_DIRECT_URLS ? 'true' : 'false'))],
        ['Direct job IDs configured', safeConfigValue(config.downloadJobIdsConfigured || (env.JIMMS_DOWNLOAD_JOB_IDS ? 'true' : 'false'))],
        ['Prepared ZIP jobs', safeConfigValue(config.downloadPrepareJobs || env.JIMMS_DOWNLOAD_PREPARE_JOBS || '1')],
        ['Download response type', safeConfigValue(config.downloadResponseType || env.JIMMS_DOWNLOAD_RESPONSE_TYPE || 'none')],
        ['Download timeout', safeConfigValue(config.downloadFileTimeout || env.JIMMS_DOWNLOAD_FILE_TIMEOUT || '-')],
        ['Progress timeout', safeConfigValue(config.downloadProgressTimeout || env.JIMMS_DOWNLOAD_PROGRESS_TIMEOUT || '-')],
        ['Poll fallback allowed', safeConfigValue(config.downloadAllowPollFallback || env.JIMMS_DOWNLOAD_ALLOW_POLL_FALLBACK || 'false')],
        ['Threshold valid response rate', safeConfigValue(thresholdValues.checkRate || thresholdRuleFor(thresholds, VALID_RESPONSE_RATE_METRIC))],
        ['Threshold load/capacity error rate', safeConfigValue(thresholdValues.httpErrorRate || thresholdRuleFor(thresholds, LOAD_ERROR_RATE_METRIC))],
        ['Threshold valid traffic P95 / P99', `${safeConfigValue(thresholdValues.p95Ms ? `${thresholdValues.p95Ms} ms` : thresholdRuleFor(thresholds, VALID_REQUEST_DURATION_METRIC, 'p(95)'))} / ${safeConfigValue(thresholdValues.p99Ms ? `${thresholdValues.p99Ms} ms` : thresholdRuleFor(thresholds, VALID_REQUEST_DURATION_METRIC, 'p(99)'))}`],
    ];
}

function conclusionHtml(metrics, checks, thresholds, durationMs, status) {
    const failedChecks = checks.filter((item) => item.fails > 0);
    const failedThresholds = thresholds.filter((item) => item.ok === false);
    const validRate = preferredMetricPercentNumber(metrics, VALID_RESPONSE_RATE_METRIC, 'checks');
    const loadErrorRate = preferredMetricPercentNumber(metrics, LOAD_ERROR_RATE_METRIC, 'http_req_failed');
    const validP95 = preferredMetricNumber(metrics, VALID_REQUEST_DURATION_METRIC, 'http_req_duration', 'p(95)');
    const lead = status === 'PASS'
        ? 'Run lulus threshold yang dikonfigurasi.'
        : 'Run belum lulus. Lihat failed checks, error summary, dan threshold yang merah.';

    return `<div class="conclusion">
<p class="conclusion-lead"><span class="pill ${status === 'PASS' ? 'pill-pass' : 'pill-fail'}">${status}</span> ${escapeHtml(lead)}</p>
<ul class="summary-list">
<li>Duration: ${escapeHtml(durationMs === undefined ? '-' : formatMs(durationMs))}</li>
<li>Valid response rate: ${escapeHtml(formatPercent(validRate))}</li>
<li>Load error rate: ${escapeHtml(formatPercent(loadErrorRate))}</li>
<li>Valid traffic P95: ${escapeHtml(formatMsReadable(validP95))}</li>
<li>Failed checks: ${escapeHtml(String(failedChecks.length))}</li>
<li>Failed thresholds: ${escapeHtml(String(failedThresholds.length))}</li>
</ul>
</div>`;
}

function runConfigurationTable(rows) {
    const intro = '<p class="small">Nilai sensitif seperti token, password, dan API key tidak ditampilkan.</p>';
    const body = rows.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    return `${intro}<table><tbody>${body}</tbody></table>`;
}

function requestSummaryTable(items, responseSamples = [], runtimeEvidence = []) {
    if (!items || items.length === 0) return '<p class="small">Tidak ada request metadata.</p>';
    const intro = '<p class="small">Data ini berasal dari katalog request JIMMS dan log runtime K6. Response yang sama hanya diwakili satu sample.</p>';
    const rows = items.map((item) => {
        const samples = responseSamplesForEndpoint(item, responseSamples);
        const evidence = runtimeEvidenceForEndpoint(item, runtimeEvidence);
        return `<tr>
<td><strong>${escapeHtml(item.name)}</strong><div class="small">${escapeHtml(item.method)} ${escapeHtml(item.path)}</div></td>
<td>${escapeHtml(item.dataStrategy || '-')}</td>
<td>${detailsBlock('Headers', item.headers || {})}</td>
<td>${detailsBlock('Request', item.requestTemplate || {})}</td>
<td>${responseSamplesBlock(samples, evidence)}</td>
</tr>`;
    }).join('');

    return `${intro}<table><thead><tr><th>Endpoint</th><th>Strategi Data</th><th>Header</th><th>Request Template</th><th>Response Sample</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function errorSummaryTable(errors) {
    if (!errors || errors.length === 0) return '<p class="small">Tidak ada error HTTP/API yang tercatat pada summary ini.</p>';
    const rows = errors.map((item) => `<tr><td>${escapeHtml(item.request)}</td><td>${escapeHtml(displayErrorCategory(item.category))}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.responseCode)}</td><td>${escapeHtml(item.message)}</td><td>${formatNumber(item.count)}</td></tr>`).join('');
    return `<table><thead><tr><th>Endpoint / Request</th><th>Kategori</th><th>HTTP Status</th><th>Response Code</th><th>Pesan Error</th><th>Jumlah</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function endpointDurationsForReport(metrics, thresholds) {
    const validEntries = metricEntriesByRequest(metrics, VALID_REQUEST_DURATION_METRIC);
    const rawEntries = metricEntriesByRequest(metrics, 'http_req_duration');
    const requestNames = new Set([...validEntries.keys(), ...rawEntries.keys()]);
    return Array.from(requestNames).map((request) => {
        const valid = validEntries.get(request);
        const raw = rawEntries.get(request);
        const metricInfo = valid || raw;
        const threshold = valid ? endpointThresholdFor(thresholds, metricInfo.metricName) : undefined;
        return {
            request,
            scope: valid ? 'Valid traffic' : 'Raw only',
            avg: durationMetricValue(metricInfo.metric, 'avg'),
            min: durationMetricValue(metricInfo.metric, 'min'),
            med: durationMetricValue(metricInfo.metric, 'med'),
            p90: durationMetricValue(metricInfo.metric, 'p(90)'),
            p95: durationMetricValue(metricInfo.metric, 'p(95)'),
            p99: durationMetricValue(metricInfo.metric, 'p(99)'),
            max: durationMetricValue(metricInfo.metric, 'max'),
            thresholdRule: threshold ? threshold.rule : valid ? '-' : 'Tidak dihitung SLA valid',
            thresholdOk: threshold ? threshold.ok : undefined,
        };
    }).sort((left, right) => left.request.localeCompare(right.request));
}

function endpointDurationTable(rows) {
    if (!rows || rows.length === 0) return '<p class="small">Tidak ada data response time per endpoint.</p>';
    const body = rows.map((item) => {
        const status = item.thresholdOk === undefined ? '-' : item.thresholdOk ? 'PASS' : 'FAIL';
        const statusClass = item.thresholdOk === undefined ? '' : item.thresholdOk ? 'status-pass' : 'status-fail';
        return `<tr>
<td>${escapeHtml(item.request)}</td>
<td>${escapeHtml(item.scope)}</td>
<td>${escapeHtml(formatMsReadable(item.avg))}</td>
<td>${escapeHtml(formatMsReadable(item.min))}</td>
<td>${escapeHtml(formatMsReadable(item.med))}</td>
<td>${escapeHtml(formatMsReadable(item.p90))}</td>
<td class="${statusClass}">${escapeHtml(formatMsReadable(item.p95))}</td>
<td>${escapeHtml(formatMsReadable(item.p99))}</td>
<td>${escapeHtml(formatMsReadable(item.max))}</td>
<td>${escapeHtml(item.thresholdRule)}</td>
<td class="${statusClass}">${escapeHtml(status)}</td>
</tr>`;
    }).join('');
    return `<table><thead><tr><th>Endpoint / Request</th><th>Scope</th><th>Avg</th><th>Min</th><th>Median</th><th>P90</th><th>P95</th><th>P99</th><th>Max</th><th>Threshold</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

function metricEntriesByRequest(metrics, metricPrefix) {
    const entries = new Map();
    Object.entries(metrics || {})
        .filter(([metricName]) => String(metricName).startsWith(`${metricPrefix}{request:`))
        .filter(([, metric]) => metricPrefix !== VALID_REQUEST_DURATION_METRIC || hasTrendSamples(metric))
        .forEach(([metricName, metric]) => {
            const tags = parseMetricTags(metricName);
            const request = tags.request || metricName;
            entries.set(request, { metricName, metric });
        });
    return entries;
}

function responseSamplesForEndpoint(item, responseSamples = []) {
    return groupResponseSamples(responseSamples.filter((sample) => sampleMatchesEndpoint(sample, item)));
}

function sampleMatchesEndpoint(sample, item) {
    const request = String(sample && sample.request ? sample.request : '');
    if (!request || !item) return false;
    const method = String(item.method || '').toUpperCase();
    const pathValue = String(item.path || '');
    if (method && !request.startsWith(method)) return false;
    return requestPathEquals(request, method, pathValue) || request.includes(String(item.name || ''));
}

function requestPathEquals(request, method, pathValue) {
    if (!method || !pathValue) return false;
    const match = String(request || '').match(new RegExp(`^${method}\\s+([^\\s]+)`, 'i'));
    if (!match) return false;

    const requestPath = normalizePlaceholderPath(match[1]);
    const expectedPath = normalizePlaceholderPath(pathValue);
    return requestPath === expectedPath;
}

function normalizePlaceholderPath(value) {
    return String(value || '')
        .split('\\').join('/')
        .replace(/\/$/, '')
        .replace(/\{[^}]+\}/g, '{}');
}

function responseSamplesBlock(samples, evidence) {
    if (!samples || samples.length === 0) {
        const steps = evidence && Array.isArray(evidence.steps) ? evidence.steps : [];
        const sources = evidence && Array.isArray(evidence.sources) ? evidence.sources : [];
        if (steps.length > 0 || sources.length > 0) {
            return detailsBlock('TIDAK DI-HIT | Belum ada response sample', {
                alasan: 'Endpoint belum punya sample response di log yang dibaca.',
                apiSebelumnya: steps,
                sumberData: sources,
            });
        }
        return '<span class="small">Belum ada sample response untuk endpoint ini.</span>';
    }

    return samples.map((item) => {
        const countSuffix = item.sampleCount > 1 ? ` | ${item.sampleCount} sample serupa` : '';
        const label = `${item.result} | ${displayErrorCategory(item.category)} | HTTP ${item.status} | code ${item.responseCode} | ${item.message}${countSuffix}`;
        return detailsBlock(label, item.responseBody === undefined ? 'N/A' : item.responseBody);
    }).join('');
}

function groupResponseSamples(samples) {
    const grouped = new Map();

    samples.forEach((sample) => {
        const key = responseSampleKey(sample);
        const existing = grouped.get(key);

        if (existing) {
            existing.sampleCount += 1;
            return;
        }

        grouped.set(key, { ...sample, sampleCount: 1 });
    });

    return Array.from(grouped.values()).sort(compareResponseSamples);
}

function responseSampleKey(sample) {
    return JSON.stringify([
        sample.request || 'N/A',
        sample.result || 'N/A',
        sample.category || 'N/A',
        sample.status || 'N/A',
        sample.responseCode || 'N/A',
        sample.message || 'N/A',
    ]);
}

function compareResponseSamples(left, right) {
    const leftPassed = left.category === 'passed' ? 1 : 0;
    const rightPassed = right.category === 'passed' ? 1 : 0;

    if (leftPassed !== rightPassed) return leftPassed - rightPassed;
    if (String(left.status) !== String(right.status)) return String(left.status).localeCompare(String(right.status));
    return String(left.message).localeCompare(String(right.message));
}

function runtimeEvidenceForEndpoint(item, runtimeEvidence = []) {
    return runtimeEvidence.find((entry) => sampleMatchesEndpoint({ request: entry.request }, item)) || {};
}

function runtimeEvidenceText(evidence, key) {
    return evidence && Array.isArray(evidence[key]) && evidence[key].length > 0 ? evidence[key] : ['Belum ada runtime evidence pada log yang dibaca.'];
}

function collectApiErrors(metrics) {
    return Object.entries(metrics || {})
        .filter(([metricName]) => String(metricName).startsWith('jimms_api_error_count{'))
        .map(([metricName, metric]) => {
            const tags = parseMetricTags(metricName);
            return {
                request: tags.request || 'N/A',
                category: tags.category || 'N/A',
                status: tags.status || 'N/A',
                responseCode: tags.response_code || 'N/A',
                message: tags.error_message || 'N/A',
                count: metricNumber(metric, 'count'),
            };
        })
        .sort((left, right) => right.count - left.count);
}

function collectApiResponseSamples() {
    return collectDebugJson('[K6-API-RESPONSE-SAMPLE] ').map((item) => ({
        request: item.request || 'N/A',
        result: item.result || 'N/A',
        category: item.category || 'N/A',
        status: item.status || 'N/A',
        responseCode: item.response_code || 'N/A',
        message: item.message || 'N/A',
        responseBody: item.response_body,
    }));
}

function collectRuntimeEvidence() {
    return collectDebugJson('[K6-RUNTIME-EVIDENCE] ').map((item) => ({
        endpointId: item.endpoint_id || 'N/A',
        request: item.request || 'N/A',
        steps: Array.isArray(item.steps) ? item.steps : [],
        sources: Array.isArray(item.sources) ? item.sources : [],
    }));
}

function collectDebugJson(marker) {
    if (!fs.existsSync(debugDir)) return [];
    const files = fs.readdirSync(debugDir)
        .filter((file) => file.endsWith('.log'))
        .map((file) => ({ fullPath: path.join(debugDir, file), mtimeMs: fs.statSync(path.join(debugDir, file)).mtimeMs }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(0, 30);
    const entries = [];

    files.forEach((file) => {
        const lines = fs.readFileSync(file.fullPath, 'utf8').split(/\r?\n/);
        lines.forEach((line) => {
            const raw = extractDebugJsonPayload(line, marker);
            if (!raw) return;
            try {
                entries.push(JSON.parse(raw));
            } catch (error) {
                // Ignore malformed log lines.
            }
        });
    });

    return dedupeObjects(entries);
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
            // k6 text logger can produce {\"key\":\"value\"}; decode below.
        }
    }

    try {
        const decodedJsonString = JSON.parse(`"${raw}"`);
        if (String(decodedJsonString).trim().startsWith('{')) {
            return decodedJsonString.trim();
        }
    } catch (error) {
        // Fall through to a conservative escape cleanup.
    }

    const decoded = raw
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();

    return decoded.startsWith('{') ? decoded : '';
}

function dedupeObjects(items) {
    const seen = new Set();
    return items.filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function collectChecks(group, prefix = '') {
    if (!group) return [];
    const current = (group.checks || []).map((check) => ({
        name: prefix ? `${prefix} / ${check.name}` : check.name,
        passes: Number(check.passes || 0),
        fails: Number(check.fails || 0),
    }));
    const nested = (group.groups || []).flatMap((item) => collectChecks(item, prefix ? `${prefix} / ${item.name}` : item.name));
    return current.concat(nested);
}

function collectThresholds(metrics) {
    return Object.entries(metrics || {})
        .flatMap(([metricName, metric]) =>
            Object.entries(metric.thresholds || {}).map(([rule, value]) => ({
                metricName,
                rule,
                ok: thresholdOkForMetric(metricName, metric, value),
            }))
        )
        .sort(compareThresholds);
}

function thresholdOkForMetric(metricName, metric, thresholdValue) {
    if (String(metricName || '').startsWith(`${VALID_REQUEST_DURATION_METRIC}{request:`) && !hasTrendSamples(metric)) {
        return undefined;
    }
    return thresholdValue.ok === true;
}

function hasTrendSamples(metric) {
    if (!metric || !metric.values) return false;
    const keys = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];
    return keys.some((key) => typeof metric.values[key] === 'number' && metric.values[key] > 0);
}

function compareThresholds(left, right) {
    const leftEndpoint = String(left.metricName).includes('{request:');
    const rightEndpoint = String(right.metricName).includes('{request:');
    if (leftEndpoint !== rightEndpoint) return leftEndpoint ? 1 : -1;
    return `${left.metricName} ${left.rule}`.localeCompare(`${right.metricName} ${right.rule}`);
}

function reportStatus(thresholds, checks) {
    if ((thresholds || []).some((item) => item.ok === false)) return 'FAIL';
    if ((checks || []).some((item) => item.fails > 0)) return 'FAIL';
    return 'PASS';
}

function thresholdRuleFor(thresholds, metricName, rulePart = '') {
    const threshold = (thresholds || []).find((item) => item.metricName === metricName && (!rulePart || String(item.rule).includes(rulePart)));
    return threshold ? threshold.rule : '-';
}

function endpointThresholdFor(thresholds, metricName) {
    return (thresholds || []).find((item) => item.metricName === metricName && String(item.rule || '').includes('p(95)'))
        || (thresholds || []).find((item) => item.metricName === metricName);
}

function durationMetricValue(metric, key) {
    if (!metric || !metric.values || typeof metric.values[key] !== 'number') return undefined;
    return metric.values[key];
}

function metricTable(metric) {
    if (!metric || !metric.values) return '<p class="small">No data.</p>';
    const rows = Object.entries(metric.values).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(formatNumber(value))}</td></tr>`).join('');
    return `<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function checksTable(checks) {
    if (!checks || checks.length === 0) return '<p class="small">No checks.</p>';
    const rows = checks.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.passes)}</td><td>${formatNumber(item.fails)}</td><td class="${item.fails === 0 ? 'status-pass' : 'status-fail'}">${item.fails === 0 ? 'PASS' : 'FAIL'}</td></tr>`).join('');
    return `<table><thead><tr><th>Check</th><th>Pass</th><th>Fail</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function thresholdsTable(thresholds) {
    if (!thresholds || thresholds.length === 0) return '<p class="small">No thresholds.</p>';
    const rows = thresholds.map((item) => {
        const status = item.ok === undefined ? 'N/A' : item.ok ? 'PASS' : 'FAIL';
        const statusClass = item.ok === undefined ? '' : item.ok ? 'status-pass' : 'status-fail';
        return `<tr><td><code>${escapeHtml(item.metricName)}</code></td><td>${escapeHtml(item.rule)}</td><td class="${statusClass}">${status}</td></tr>`;
    }).join('');
    return `<table><thead><tr><th>Metric</th><th>Rule</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function keyMetricsTable(metrics) {
    const preferred = [
        VALID_RESPONSE_RATE_METRIC,
        LOAD_ERROR_RATE_METRIC,
        DATA_PRECONDITION_COUNT_METRIC,
        VALID_REQUEST_DURATION_METRIC,
        'jimms_api_error_count',
        'http_reqs',
        'http_req_failed',
        'http_req_duration',
        'http_req_waiting',
        'data_sent',
        'data_received',
        'iterations',
        'vus',
        'vus_max',
    ];
    const names = Object.keys(metrics || {}).sort((left, right) => {
        const leftIndex = preferred.indexOf(left.split('{')[0]);
        const rightIndex = preferred.indexOf(right.split('{')[0]);
        if (leftIndex !== rightIndex) return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
        return left.localeCompare(right);
    });
    const rows = names.map((name) => {
        const metric = metrics[name];
        const values = Object.entries(metric.values || {}).map(([key, value]) => `${key}: ${formatNumber(value)}`).join(', ');
        return `<tr><td><code>${escapeHtml(name)}</code></td><td>${escapeHtml(metric.type || '')}</td><td>${escapeHtml(values)}</td></tr>`;
    }).join('');
    return `<table><thead><tr><th>Metric</th><th>Type</th><th>Values</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function detailsBlock(label, value) {
    return `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(formatRequestValue(value))}</pre></details>`;
}

function formatRequestValue(value) {
    if (value === undefined || value === null) return 'N/A';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

function section(title, body) {
    return `<section class="card"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function kpi(label, value, valueClass = '') {
    return `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value ${valueClass}">${escapeHtml(String(value))}</div></div>`;
}

function safeConfigValue(value) {
    if (value === undefined || value === null || value === '') return '-';
    return String(value);
}

function preferredMetricRate(metrics, primaryName, fallbackName) {
    const value = preferredMetricPercentNumber(metrics, primaryName, fallbackName);
    return formatPercent(value);
}

function preferredMetricPercentNumber(metrics, primaryName, fallbackName) {
    const primary = metricOptionalPercentNumber(metrics && metrics[primaryName]);
    if (primary !== undefined) return primary;
    return metricOptionalPercentNumber(metrics && metrics[fallbackName]);
}

function preferredMetricNumber(metrics, primaryName, fallbackName, key) {
    const primary = metricOptionalNumber(metrics && metrics[primaryName], key);
    if (primary !== undefined) return primary;
    return metricOptionalNumber(metrics && metrics[fallbackName], key);
}

function metricCounterTotal(metrics, metricName) {
    const direct = metricOptionalNumber(metrics && metrics[metricName], 'count');
    if (direct !== undefined) return direct;
    return Object.entries(metrics || {})
        .filter(([name]) => String(name).startsWith(`${metricName}{`))
        .reduce((total, [, metric]) => total + metricNumber(metric, 'count'), 0);
}

function metricOptionalPercentNumber(metric) {
    if (!metric || !metric.values || typeof metric.values.rate !== 'number') return undefined;
    return metric.values.rate * 100;
}

function metricOptionalNumber(metric, key) {
    if (!metric || !metric.values || typeof metric.values[key] !== 'number') return undefined;
    return metric.values[key];
}

function metricNumber(metric, key) {
    if (!metric || !metric.values || typeof metric.values[key] !== 'number') return 0;
    return metric.values[key];
}

function metricValue(metric, key) {
    if (!metric || !metric.values) return '-';
    const value = metric.values[key] || metric.values.value || metric.values.rate;
    return value === undefined ? '-' : formatNumber(value);
}

function displayErrorCategory(value) {
    const category = String(value || 'N/A');
    const labels = {
        passed: 'Passed',
        data_precondition: 'Data / Precondition',
        load_capacity: 'Load / Capacity',
        auth_security: 'Auth / Security',
        functional_api: 'Functional / API',
        business_mismatch: 'Business / Response Mismatch',
        'N/A': 'N/A',
    };
    return labels[category] || category;
}

function parseMetricTags(metricName) {
    const start = String(metricName || '').indexOf('{');
    const end = String(metricName || '').lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return {};

    return String(metricName)
        .slice(start + 1, end)
        .split(',')
        .reduce((tags, pair) => {
            const separator = pair.indexOf(':');
            if (separator === -1) return tags;
            const key = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (key) tags[key] = value;
            return tags;
        }, {});
}

function formatPercent(value) {
    if (typeof value !== 'number') return '-';
    return `${value.toFixed(2)}%`;
}

function formatMs(value) {
    if (typeof value !== 'number') return '-';
    if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
    return `${value.toFixed(2)}ms`;
}

function formatMsReadable(value) {
    if (typeof value !== 'number') return '-';
    if (value >= 1000) return `${formatNumber(value)} ms (${(value / 1000).toFixed(2)} detik)`;
    return `${formatNumber(value)} ms`;
}

function formatNumber(value) {
    if (typeof value !== 'number') return String(value);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
