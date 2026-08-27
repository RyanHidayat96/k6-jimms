import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { environment } from '../config/environment.js';
import { recordApiMetrics } from './errorMetrics.js';
import { recordRuntimeEvidence, visibleRuntimeValue } from './runtimeEvidence.js';
import { splitCsv } from './utility.js';

export const exportJobCreated = new Rate('jimms_export_job_created');
export const exportProgressAvailable = new Rate('jimms_export_progress_available');
export const exportPayloadArchives = new Counter('jimms_export_payload_archives');

const LIST_REQUEST_NAME = 'GET /v1/regular-inspection filtered-list';
const PROGRESS_REQUEST_NAME = 'GET /v1/regular-inspection/export/{jobId}/progress-stream';
const DOWNLOAD_FILE_REQUEST_NAME = 'GET /v1/regular-inspection/export/{jobId}/download';

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

export function selectedRequestNames() {
    return [DOWNLOAD_FILE_REQUEST_NAME];
}

export function prepareDownloadRun(authContext) {
    const preparedJobsFromRunner = preparedDownloadJobsFromEnv();

    if (preparedJobsFromRunner.length > 0) {
        console.log('[K6-DOWNLOAD-PREPARED] ' + JSON.stringify({
            count: preparedJobsFromRunner.length,
            source: 'runner-env',
        }));

        return {
            ...authContext,
            preparedDownloadJobs: preparedJobsFromRunner,
        };
    }

    throw new Error('No prepared ZIP download jobs found. Run via npm script so helper/runK6WithEnv.js prepares JIMMS_PREPARED_DOWNLOAD_JOBS_JSON before K6 starts.');
}

export function prepareDownloadRunInK6(authContext) {
    const listResponse = listRegularInspections(authContext, { recordMetrics: false });
    const preparedJobs = [];
    const prepareJobs = positiveInteger(environment.downloadPrepareJobs, 1);

    for (let index = 0; index < prepareJobs; index += 1) {
        const inspectionId = pickInspectionId(listResponse, index);
        const archiveScenario = pickArchiveScenario(index);
        const exportResponse = exportRegularInspection(authContext, inspectionId, archiveScenario, {
            recordMetrics: false,
            logExportMarker: false,
        });
        const exportBody = responseJson(exportResponse);
        const jobId = exportBody && exportBody.data ? exportBody.data.jobId : '';
        const filename = exportBody && exportBody.data ? exportBody.data.filename : '';
        const progress = waitForDownloadUrl(authContext, jobId);

        preparedJobs.push({
            inspectionId: String(inspectionId),
            archiveScenario: archiveScenario.name,
            archiveLabels: archiveScenario.archives.map((value) => ARCHIVE_LABELS[value] || value),
            archiveValues: archiveScenario.archives,
            jobId,
            filename,
            downloadUrl: absoluteApiUrl(progress.downloadUrl),
            progressStatus: progress.status,
            progressPercentage: progress.percentage,
            archiveName: progress.archiveName,
            expiredAt: progress.expiredAt,
        });
    }

    console.log('[K6-DOWNLOAD-PREPARED] ' + JSON.stringify({
        count: preparedJobs.length,
        strategy: prepareJobs === 1 ? 'all VUs use the same prepared ZIP URL' : 'VUs rotate prepared ZIP URLs',
        jobs: preparedJobs.map((job) => ({
            inspectionId: job.inspectionId,
            archiveScenario: job.archiveScenario,
            jobId: job.jobId,
            filename: job.filename,
            downloadUrl: job.downloadUrl,
        })),
    }));

    return {
        ...authContext,
        preparedDownloadJobs: preparedJobs,
    };
}

export function runDownloadFlow(authContext) {
    const preparedJob = pickPreparedDownloadJob(authContext);
    downloadPreparedZip(authContext, preparedJob);
}

export function listRegularInspections(authContext, options = {}) {
    const url = regularInspectionListUrl();
    const response = http.get(url, {
        headers: apiHeaders(authContext),
        tags: { request: LIST_REQUEST_NAME },
        timeout: '60s',
    });
    const body = responseJson(response);
    const rows = rowsFromBody(body);
    const success = response.status === 200 && body && body.success === true && rows.length > 0;

    check(response, {
        'regular inspection filtered list status is 200': () => response.status === 200,
        'regular inspection filtered list success true': () => Boolean(body && body.success === true),
        'regular inspection filtered list has rows': () => rows.length > 0,
    });

    if (options.recordMetrics !== false) {
        recordApiMetrics(response, LIST_REQUEST_NAME, {
            valid: success,
            message: success
                ? `Rows available from status_id[]=${environment.regularInspectionStatusId}`
                : `No rows available from status_id[]=${environment.regularInspectionStatusId}`,
        });
        recordRuntimeEvidence(LIST_REQUEST_NAME, {
            endpointId: 'JIMMS_REGULAR_INSPECTION_LIST',
            steps: [
                'Login NextAuth via /api/auth/csrf, /api/auth/callback/credentials, lalu /api/auth/session.',
                `GET ${listPathWithQuery()} memakai Authorization Bearer dan x-api-key.`,
            ],
            sources: [
                `status_id[]=${visibleRuntimeValue(environment.regularInspectionStatusId)} dari inspeksi UI status Verifikasi Tindak Lanjut - ME.`,
                `inspectionId kandidat dari response list: ${visibleRuntimeValue(rows.map((row) => row.id).filter(Boolean).join(', '))}.`,
            ],
        });
    }

    return response;
}

export function exportRegularInspection(authContext, inspectionId, archiveScenario, options = {}) {
    if (!inspectionId) {
        throw new Error('No regular inspection id available for download export.');
    }

    const requestName = exportRequestName(archiveScenario.name);
    const multipart = buildMultipartArchiveBody(archiveScenario.archives);
    const response = http.post(
        `${environment.apiBaseUrl}/v1/regular-inspection/export/${inspectionId}`,
        multipart.body,
        {
            headers: {
                ...apiHeaders(authContext),
                'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
            },
            tags: { request: requestName, archive_scenario: archiveScenario.name },
            timeout: environment.exportTimeout,
        },
    );
    const body = responseJson(response);
    const success = response.status === 200
        && body
        && body.success === true
        && body.data
        && body.data.jobId
        && String(body.data.filename || '').toLowerCase().endsWith('.zip');

    check(response, {
        [`export ${archiveScenario.name} status is 200`]: () => response.status === 200,
        [`export ${archiveScenario.name} success true`]: () => Boolean(body && body.success === true),
        [`export ${archiveScenario.name} jobId exists`]: () => Boolean(body && body.data && body.data.jobId),
        [`export ${archiveScenario.name} filename zip exists`]: () => Boolean(body && body.data && String(body.data.filename || '').toLowerCase().endsWith('.zip')),
    });

    exportPayloadArchives.add(archiveScenario.archives.length, { archive_scenario: archiveScenario.name });
    exportJobCreated.add(Boolean(success), { archive_scenario: archiveScenario.name });

    if (options.recordMetrics !== false) {
        recordApiMetrics(response, requestName, {
            valid: Boolean(success),
            message: success ? 'Export process queued successfully' : `Export did not return successful job for scenario ${archiveScenario.name}`,
        });
        recordRuntimeEvidence(requestName, {
            endpointId: 'JIMMS_REGULAR_INSPECTION_EXPORT',
            steps: [
                `GET ${listPathWithQuery()} untuk memilih inspectionId.`,
                `POST /v1/regular-inspection/export/${visibleRuntimeValue(inspectionId)} dengan multipart archive[].`,
            ],
            sources: [
                `inspectionId=${visibleRuntimeValue(inspectionId)} dari row hasil filter status_id[]=${environment.regularInspectionStatusId}.`,
                `archive[]=${archiveScenario.archives.map((value) => visibleRuntimeValue(value)).join(', ')} dari scenario ${archiveScenario.name}.`,
                `jobId response=${visibleRuntimeValue(body && body.data ? body.data.jobId : '')}.`,
            ],
        });
    }

    if (options.logExportMarker !== false) {
        console.log(JSON.stringify({
            marker: 'JIMMS_EXPORT',
            inspectionId: String(inspectionId),
            archiveScenario: archiveScenario.name,
            archiveLabels: archiveScenario.archives.map((value) => ARCHIVE_LABELS[value] || value),
            archiveValues: archiveScenario.archives,
            status: response.status,
            jobId: body && body.data ? body.data.jobId : '',
            filename: body && body.data ? body.data.filename : '',
        }));
    }

    return response;
}

export function downloadPreparedZip(authContext, preparedJob) {
    if (!preparedJob || !preparedJob.downloadUrl) {
        throw new Error('No prepared ZIP download URL available. Setup did not prepare download job.');
    }

    const response = http.get(preparedJob.downloadUrl, {
        headers: apiHeaders(authContext, 'application/zip, application/octet-stream, */*'),
        tags: { request: DOWNLOAD_FILE_REQUEST_NAME },
        timeout: environment.downloadFileTimeout,
        responseType: environment.downloadResponseType,
    });
    const success = isZipDownloadResponse(response);

    check(response, {
        'zip download status is 200': () => response.status === 200,
        'zip download returns file headers': () => isZipDownloadResponse(response),
    });
    recordApiMetrics(response, DOWNLOAD_FILE_REQUEST_NAME, {
        valid: success,
        message: success ? 'ZIP downloaded successfully' : 'ZIP download failed',
    });
    recordRuntimeEvidence(DOWNLOAD_FILE_REQUEST_NAME, {
        endpointId: 'JIMMS_EXPORT_DOWNLOAD_FILE',
        steps: [
            'Setup login dan membuat export job agar downloadUrl siap sebelum load dimulai.',
            'Default function hanya hit GET download ZIP.',
        ],
        sources: [
            `jobId=${visibleRuntimeValue(preparedJob.jobId)} dari setup export.`,
            `downloadUrl=${visibleRuntimeValue(preparedJob.downloadUrl)} dari progress-stream.`,
            `responseType=${visibleRuntimeValue(environment.downloadResponseType)}.`,
        ],
    });

    return response;
}

export function pollProgressStream(authContext, jobId) {
    const response = http.get(`${environment.apiBaseUrl}/v1/regular-inspection/export/${jobId}/progress-stream`, {
        headers: {
            ...apiHeaders(authContext),
            Accept: 'text/event-stream',
        },
        tags: { request: PROGRESS_REQUEST_NAME },
        timeout: environment.progressTimeout,
    });
    const success = response.status === 200;

    check(response, {
        'export progress stream status is 200': () => success,
    });

    exportProgressAvailable.add(success);
    recordApiMetrics(response, PROGRESS_REQUEST_NAME, {
        valid: success,
        message: success ? 'Progress stream available' : 'Progress stream unavailable',
    });
    recordRuntimeEvidence(PROGRESS_REQUEST_NAME, {
        endpointId: 'JIMMS_EXPORT_PROGRESS_STREAM',
        steps: [
            'POST export membuat jobId.',
            'GET progress-stream memakai Accept: text/event-stream.',
        ],
        sources: [
            `jobId=${visibleRuntimeValue(jobId)} dari response export.`,
            'Default JIMMS_EXPORT_POLL_PROGRESS=false karena SSE long-lived.',
        ],
    });
}

export function waitForDownloadUrl(authContext, jobId) {
    if (!jobId) {
        throw new Error('Cannot wait for download URL: jobId is empty.');
    }

    const attempts = positiveInteger(environment.downloadFilePollAttempts, 3);
    const intervalSeconds = positiveNumber(environment.downloadFilePollIntervalSeconds, 2);
    const downloadUrl = `${environment.apiBaseUrl}/v1/regular-inspection/export/${jobId}/download`;
    let lastStatus = 0;
    let lastContentType = '';
    let lastBody = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const response = http.get(downloadUrl, {
            headers: apiHeaders(authContext, 'application/zip, application/octet-stream, */*'),
            tags: { request: DOWNLOAD_FILE_REQUEST_NAME, purpose: 'setup-readiness-probe' },
            timeout: environment.downloadFileTimeout,
            responseType: 'none',
        });
        lastStatus = response.status;
        lastContentType = headerValue(response, 'Content-Type');
        lastBody = String(response.body || '').slice(0, 300);

        if (isZipDownloadResponse(response)) {
            return {
                downloadUrl,
                status: 'READY',
                percentage: 100,
                archiveName: '',
                expiredAt: '',
            };
        }

        if (attempt < attempts) {
            sleep(intervalSeconds);
        }
    }

    throw new Error(`Download URL not ready for jobId=${jobId}. Last status=${lastStatus}, content-type=${lastContentType || '-'}, body=${lastBody || '-'}`);
}

export function regularInspectionListUrl() {
    const params = [];

    addParam(params, 'status_id[]', environment.regularInspectionStatusId);
    addParam(params, 'page', environment.listPage);
    addParam(params, 'per_page', environment.listPerPage);

    const query = params.join('&');
    const extraQuery = String(environment.extraListQuery || '').replace(/^\?+|^&+/g, '');
    const mergedQuery = [query, extraQuery].filter(Boolean).join('&');

    return `${environment.apiBaseUrl}/v1/regular-inspection${mergedQuery ? `?${mergedQuery}` : ''}`;
}

function listPathWithQuery() {
    return regularInspectionListUrl().replace(environment.apiBaseUrl, '');
}

function apiHeaders(authContext, accept = 'application/json, text/plain, */*') {
    return {
        Accept: accept,
        Authorization: `Bearer ${authContext.accessToken}`,
        'x-api-key': environment.apiKey,
    };
}

function addParam(params, name, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
}

function pickInspectionId(listResponse, index = __VU + __ITER - 1) {
    const body = responseJson(listResponse);
    const rows = rowsFromBody(body);
    const idsFromList = rows.map((row) => row && row.id).filter(Boolean);
    const configuredIds = splitCsv(environment.downloadInspectionIds);
    const candidates = idsFromList.length > 0 ? idsFromList : configuredIds;

    if (candidates.length === 0) {
        throw new Error(`No inspection rows found from ${regularInspectionListUrl()} and JIMMS_DOWNLOAD_INSPECTION_IDS is empty.`);
    }

    if (String(environment.downloadRowStrategy || '').toLowerCase() === 'first') {
        return candidates[0];
    }

    return candidates[index % candidates.length];
}

function pickArchiveScenario(index = __VU + __ITER - 1) {
    const names = archiveScenarioNames();
    const scenarioIndex = environment.randomizeScenario
        ? Math.floor(Math.random() * names.length)
        : index % names.length;

    return archiveScenarioByName(names[scenarioIndex]);
}

function archiveScenarioNames() {
    const names = splitCsv(environment.downloadArchiveScenarios);
    return names.length > 0 ? names : ['all'];
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

    throw new Error(`Unknown JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS value "${rawName}". Use one of: ${Object.keys(ARCHIVE_SETS).join(', ')}, or custom archive values joined by +.`);
}

function exportRequestName(scenarioName) {
    return `POST /v1/regular-inspection/export/{id} ${scenarioName}`;
}

function buildMultipartArchiveBody(archives) {
    const vu = typeof __VU === 'undefined' ? 'setup' : __VU;
    const iteration = typeof __ITER === 'undefined' ? 'setup' : __ITER;
    const boundary = `----k6JimmsDownload${vu}${iteration}${Date.now()}`;
    const body = archives.map((archiveValue) => [
        `--${boundary}`,
        'Content-Disposition: form-data; name="archive[]"',
        '',
        archiveValue,
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;

    return { boundary, body };
}

function responseJson(response) {
    try {
        return response.json();
    } catch (error) {
        return null;
    }
}

function rowsFromBody(body) {
    if (!body || !body.data || !Array.isArray(body.data.data)) return [];
    return body.data.data;
}

function pickPreparedDownloadJob(authContext) {
    const jobs = authContext && Array.isArray(authContext.preparedDownloadJobs)
        ? authContext.preparedDownloadJobs
        : [];

    if (jobs.length === 0) {
        throw new Error('No prepared ZIP download jobs available from setup.');
    }

    return jobs[(__VU + __ITER - 1) % jobs.length];
}

function preparedDownloadJobsFromEnv() {
    const raw = __ENV.JIMMS_PREPARED_DOWNLOAD_JOBS_JSON || '';
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((job) => job && job.downloadUrl)
            .map((job) => ({
                inspectionId: String(job.inspectionId || ''),
                archiveScenario: String(job.archiveScenario || ''),
                jobId: String(job.jobId || ''),
                filename: String(job.filename || ''),
                downloadUrl: String(job.downloadUrl || ''),
            }));
    } catch (error) {
        throw new Error(`Invalid JIMMS_PREPARED_DOWNLOAD_JOBS_JSON: ${error.message}`);
    }
}

function isZipDownloadResponse(response) {
    const contentType = headerValue(response, 'Content-Type').toLowerCase();
    const contentDisposition = headerValue(response, 'Content-Disposition').toLowerCase();
    const contentLength = Number(headerValue(response, 'Content-Length') || 0);
    const zipHeaders = contentType.includes('zip')
        || contentType.includes('octet-stream')
        || contentDisposition.includes('.zip')
        || contentDisposition.includes('attachment');

    return response.status === 200 && zipHeaders && contentLength >= 0;
}

function headerValue(response, name) {
    const headers = response && response.headers ? response.headers : {};
    const match = Object.keys(headers).find((key) => key.toLowerCase() === String(name).toLowerCase());
    return match ? String(headers[match] || '') : '';
}

function lastSseJson(text) {
    const events = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                return null;
            }
        })
        .filter(Boolean);

    return events.length > 0 ? events[events.length - 1] : null;
}

function absoluteApiUrl(value) {
    const raw = String(value || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${environment.apiBaseUrl}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
