import http from 'k6/http';
import { check, sleep } from 'k6';
import { environment } from '../config/environment.js';
import { recordApiMetrics } from './errorMetrics.js';
import { recordRuntimeEvidence, visibleRuntimeValue } from './runtimeEvidence.js';

const LIST_REQUEST_NAME = 'GET /v1/regular-inspection filtered-list';
const EXPORT_REQUEST_NAME = 'POST /v1/regular-inspection/export/{id}';
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

const CHECKBOX_ARCHIVES = [
    ['downloadCheckFormJsa', 'jsa_form'],
    ['downloadCheckFormPersiapan', 'preparation_form'],
    ['downloadCheckDataAdministrasi', 'administration_form'],
    ['downloadCheckDataInspeksi', 'inspection'],
    ['downloadCheckDokumentasi', 'documents'],
    ['downloadCheckStripmapInspeksi', 'stripmap'],
    ['downloadCheckStripmapPenanganan', 'maintenance_stripmap'],
    ['downloadCheckDataPenanganan', 'maintenance_data'],
];

export function selectedRequestNames() {
    return [EXPORT_REQUEST_NAME, PROGRESS_REQUEST_NAME, DOWNLOAD_FILE_REQUEST_NAME];
}

export function prepareDownloadRun(authContext) {
    if (authContext && authContext.skipped) return authContext;

    if (isRealUserFlow()) {
        console.log('[K6-DOWNLOAD-FLOW] ' + JSON.stringify({ mode: 'real-user' }));
        return authContext;
    }

    const preparedJobs = preparedDownloadJobsFromEnv();

    if (preparedJobs.length === 0) {
        throw new Error('No prepared ZIP download jobs found. Fill JIMMS_DOWNLOAD_DIRECT_URLS/JIMMS_DOWNLOAD_JOB_IDS, or set JIMMS_DOWNLOAD_FLOW_MODE=real-user.');
    }

    console.log('[K6-DOWNLOAD-PREPARED] ' + JSON.stringify({
        count: preparedJobs.length,
        source: preparedJobs[0].source || 'runner-env',
    }));

    return {
        ...authContext,
        preparedDownloadJobs: preparedJobs,
    };
}

export function runDownloadFlow(authContext) {
    if (authContext && authContext.skipped) {
        console.warn('[K6-SKIPPED] ' + JSON.stringify({
            stage: authContext.skipStage || 'support',
            reason: authContext.skipReason || 'Support/precondition API failed.',
        }));
        return;
    }

    if (isRealUserFlow()) {
        runRealUserDownloadFlow(authContext);
        return;
    }

    downloadZipWithRetry(authContext, pickPreparedDownloadJob(authContext));
}

function runRealUserDownloadFlow(authContext) {
    const inspectionId = pickInspectionId(authContext);
    if (!inspectionId) {
        console.warn('[K6-SKIPPED] ' + JSON.stringify({
            stage: LIST_REQUEST_NAME,
            reason: 'No inspection id available for download flow.',
        }));
        return;
    }

    const archiveScenario = pickArchiveScenario();
    const exportJob = createExportJob(authContext, inspectionId, archiveScenario);
    const progress = downloadUrlFromProgressStream(authContext, exportJob.jobId);
    const downloadUrl = progress.downloadUrl || `${environment.apiBaseUrl}/v1/regular-inspection/export/${encodeURIComponent(exportJob.jobId)}/download`;

    downloadZipWithRetry(authContext, {
        inspectionId: String(inspectionId),
        archiveScenario: archiveScenario.name,
        jobId: exportJob.jobId,
        filename: exportJob.filename,
        downloadUrl,
        source: progress.downloadUrl ? 'real-user-progress-stream' : 'real-user-download-poll',
    });
}

function pickInspectionId(authContext) {
    const configuredIds = splitCsv(environment.downloadInspectionIds);
    const candidates = configuredIds.length > 0 ? configuredIds : listRegularInspectionIds(authContext);

    if (candidates.length === 0) {
        return '';
    }

    if (String(environment.downloadRowStrategy || '').toLowerCase() === 'first') {
        return candidates[0];
    }

    return candidates[(__VU + __ITER - 1) % candidates.length];
}

function listRegularInspectionIds(authContext) {
    const response = http.get(regularInspectionListUrl(), {
        headers: apiHeaders(authContext),
        tags: { request: LIST_REQUEST_NAME },
        timeout: '60s',
    });
    const body = responseJson(response);
    const rows = rowsFromBody(body);
    const success = response.status === 200 && body && body.success === true && rows.length > 0;

    check(response, {
        'regular inspection filtered list status is 200': () => response.status === 200,
        'regular inspection filtered list has rows': () => rows.length > 0,
    });
    recordApiMetrics(response, LIST_REQUEST_NAME, {
        valid: success,
        result: success ? 'PASSED' : 'SKIPPED',
        category: success ? 'passed' : 'support_skipped',
        message: success
            ? `Rows available from status_id[]=${environment.regularInspectionStatusId}`
            : `No rows available from status_id[]=${environment.regularInspectionStatusId}`,
        skipPerformance: true,
    });

    if (!success) return [];

    recordRuntimeEvidence(LIST_REQUEST_NAME, {
        endpointId: 'JIMMS_REGULAR_INSPECTION_LIST',
        steps: [
            `GET ${listPathWithQuery()} untuk mengambil row Perkerasan Rutin status Verifikasi Tindak Lanjut - ME.`,
        ],
        sources: [
            `inspectionId kandidat=${visibleRuntimeValue(rows.map((row) => row.id).filter(Boolean).join(', '))}.`,
        ],
    });

    return rows.map((row) => row && row.id).filter(Boolean);
}

function createExportJob(authContext, inspectionId, archiveScenario) {
    if (!inspectionId) throw new Error('No regular inspection id available for download export.');

    const multipart = buildMultipartArchiveBody(archiveScenario.archives);
    const response = http.post(
        `${environment.apiBaseUrl}/v1/regular-inspection/export/${inspectionId}`,
        multipart.body,
        {
            headers: {
                ...apiHeaders(authContext),
                'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
            },
            tags: { request: EXPORT_REQUEST_NAME, archive_scenario: archiveScenario.name },
            timeout: environment.exportTimeout,
        },
    );
    const body = responseJson(response);
    const jobId = body && body.data ? body.data.jobId : '';
    const filename = body && body.data ? body.data.filename : '';
    const success = response.status === 200
        && body
        && body.success === true
        && jobId
        && String(filename || '').toLowerCase().endsWith('.zip');

    check(response, {
        'export job queued status is 200': () => response.status === 200,
        'export job queued success true': () => Boolean(body && body.success === true),
        'export job id exists': () => Boolean(jobId),
        'export filename zip exists': () => String(filename || '').toLowerCase().endsWith('.zip'),
    });
    recordApiMetrics(response, EXPORT_REQUEST_NAME, {
        valid: Boolean(success),
        message: success ? 'Export job queued successfully' : 'Export job queue failed',
    });
    recordRuntimeEvidence(EXPORT_REQUEST_NAME, {
        endpointId: 'JIMMS_REGULAR_INSPECTION_EXPORT',
        steps: [
            `POST /v1/regular-inspection/export/${visibleRuntimeValue(inspectionId)} dengan multipart archive[].`,
        ],
        sources: [
            `archive[]=${archiveScenario.archives.map((value) => visibleRuntimeValue(value)).join(', ')}.`,
            `jobId=${visibleRuntimeValue(jobId)}.`,
        ],
    });

    if (!success) {
        throw new Error(`Export job queue failed. status=${response.status}, body=${sampleBody(response)}`);
    }

    return { jobId: String(jobId), filename: String(filename || '') };
}

function downloadUrlFromProgressStream(authContext, jobId) {
    if (!jobId) return {};

    const response = http.get(`${environment.apiBaseUrl}/v1/regular-inspection/export/${encodeURIComponent(jobId)}/progress-stream`, {
        headers: apiHeaders(authContext, 'text/event-stream'),
        tags: { request: PROGRESS_REQUEST_NAME },
        timeout: environment.downloadProgressTimeout,
    });
    const progress = lastSseJson(String(response.body || ''));
    const hasProgressEvent = Boolean(progress);
    const hasDownloadUrl = Boolean(progress && progress.downloadUrl);
    const success = hasDownloadUrl;

    check(response, {
        'progress stream is readable': () => response.status === 200 || hasProgressEvent,
        'progress stream returns downloadUrl': () => hasDownloadUrl,
    });
    recordApiMetrics(response, PROGRESS_REQUEST_NAME, {
        valid: Boolean(success),
        message: success
            ? 'Download URL ready from progress-stream'
            : `Progress stream did not return downloadUrl. status=${progress && progress.status ? progress.status : 'N/A'}`,
    });

    if (success) {
        recordRuntimeEvidence(PROGRESS_REQUEST_NAME, {
            endpointId: 'JIMMS_EXPORT_PROGRESS_STREAM',
            steps: [
                'UI menunggu job queued lewat progress-stream sampai downloadUrl tersedia.',
            ],
            sources: [
                `jobId=${visibleRuntimeValue(jobId)}.`,
                `status=${visibleRuntimeValue(progress.status)}.`,
                `percentage=${visibleRuntimeValue(progress.percentage)}.`,
            ],
        });

        return {
            downloadUrl: absoluteApiUrl(progress.downloadUrl),
            status: progress.status,
            percentage: progress.percentage,
        };
    }

    if (!environment.downloadAllowPollFallback) {
        throw new Error(`Progress stream did not return downloadUrl. http=${response.status}, status=${progress && progress.status ? progress.status : 'N/A'}, percentage=${progress && progress.percentage !== undefined ? progress.percentage : 'N/A'}`);
    }

    return {};
}

function downloadZipWithRetry(authContext, preparedJob) {
    if (!preparedJob || !preparedJob.downloadUrl) {
        throw new Error('No prepared ZIP download URL available.');
    }

    const attempts = positiveInteger(environment.downloadFilePollAttempts, 1);
    const intervalSeconds = positiveNumber(environment.downloadFilePollIntervalSeconds, 2);
    let response = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        response = http.get(preparedJob.downloadUrl, {
            headers: apiHeaders(authContext, 'application/zip, application/octet-stream, */*'),
            tags: { request: DOWNLOAD_FILE_REQUEST_NAME },
            timeout: environment.downloadFileTimeout,
            responseType: environment.downloadResponseType,
        });

        if (isZipDownloadResponse(response)) {
            validateZipDownload(response, preparedJob, attempt);
            return response;
        }

        if (attempt < attempts) sleep(intervalSeconds);
    }

    validateZipDownload(response, preparedJob, attempts);
    return response;
}

function validateZipDownload(response, preparedJob, attempt) {
    const success = isZipDownloadResponse(response);

    check(response, {
        'zip download status is 200': () => response.status === 200,
        'zip download returns file headers': () => isZipDownloadResponse(response),
        'zip download body downloaded': () => environment.downloadResponseType !== 'binary' || responseBodyLength(response.body) > 0,
        'zip download body starts with PK': () => environment.downloadResponseType !== 'binary' || bodyStartsWithZipMagic(response.body),
    });
    recordApiMetrics(response, DOWNLOAD_FILE_REQUEST_NAME, {
        valid: success,
        message: success ? 'ZIP downloaded successfully' : 'ZIP download failed',
    });
    recordRuntimeEvidence(DOWNLOAD_FILE_REQUEST_NAME, {
        endpointId: 'JIMMS_EXPORT_DOWNLOAD_FILE',
        steps: [
            'VU membuat export job queued.',
            'VU menunggu ZIP siap.',
            'VU hit GET download ZIP dan validasi body file.',
        ],
        sources: [
            `source=${visibleRuntimeValue(preparedJob.source || 'runner-env')}.`,
            `jobId=${visibleRuntimeValue(preparedJob.jobId)}.`,
            `downloadUrl=${visibleRuntimeValue(preparedJob.downloadUrl)}.`,
            `attempt=${visibleRuntimeValue(attempt)}.`,
            `responseType=${visibleRuntimeValue(environment.downloadResponseType)}.`,
        ],
    });
}

function apiHeaders(authContext, accept = 'application/json, text/plain, */*') {
    return {
        Accept: accept,
        Authorization: `Bearer ${authContext.accessToken}`,
        'x-api-key': environment.apiKey,
    };
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
    if (!raw) return directDownloadJobsFromEnv();

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((job) => job && job.downloadUrl)
            .map(normalizePreparedJob);
    } catch (error) {
        throw new Error(`Invalid JIMMS_PREPARED_DOWNLOAD_JOBS_JSON: ${error.message}`);
    }
}

function directDownloadJobsFromEnv() {
    const urls = splitCsv(environment.downloadDirectUrls).map((downloadUrl, index) => normalizePreparedJob({
        downloadUrl: absoluteApiUrl(downloadUrl),
        jobId: jobIdFromDownloadUrl(downloadUrl),
        archiveScenario: 'direct-url',
        source: 'JIMMS_DOWNLOAD_DIRECT_URLS',
        index: index + 1,
    }));
    const jobIds = splitCsv(environment.downloadJobIds).map((jobId, index) => normalizePreparedJob({
        downloadUrl: `${environment.apiBaseUrl}/v1/regular-inspection/export/${encodeURIComponent(jobId)}/download`,
        jobId,
        archiveScenario: 'direct-job-id',
        source: 'JIMMS_DOWNLOAD_JOB_IDS',
        index: index + 1,
    }));

    return urls.concat(jobIds);
}

function normalizePreparedJob(job) {
    return {
        inspectionId: String(job.inspectionId || ''),
        archiveScenario: String(job.archiveScenario || ''),
        jobId: String(job.jobId || ''),
        filename: String(job.filename || ''),
        downloadUrl: absoluteApiUrl(job.downloadUrl || ''),
        source: String(job.source || 'runner-env'),
        index: Number(job.index || 0),
    };
}

function pickArchiveScenario(index = __VU + __ITER - 1) {
    const checkboxScenario = archiveScenarioFromCheckboxes();
    if (checkboxScenario) return checkboxScenario;

    const names = archiveScenarioNames();
    const scenarioIndex = environment.randomizeScenario
        ? Math.floor(Math.random() * names.length)
        : index % names.length;

    return archiveScenarioByName(names[scenarioIndex]);
}

function archiveScenarioNames() {
    const names = splitCsv(environment.downloadArchiveScenarios);
    if (names.length === 0) {
        throw new Error('No download checkbox selected. Set JIMMS_DOWNLOAD_ALL_ARCHIVE=true or set at least one JIMMS_DOWNLOAD_CHECK_* value to true.');
    }

    return names;
}

function archiveScenarioFromCheckboxes() {
    if (environment.downloadAllArchive) return archiveScenarioByName('all');

    const archives = CHECKBOX_ARCHIVES
        .filter(([configKey]) => Boolean(environment[configKey]))
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

function buildMultipartArchiveBody(archives) {
    const boundary = `----k6JimmsDownload${__VU}${__ITER}${Date.now()}`;
    const body = archives.map((archiveValue) => [
        `--${boundary}`,
        'Content-Disposition: form-data; name="archive[]"',
        '',
        archiveValue,
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;

    return { boundary, body };
}

function regularInspectionListUrl() {
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

function addParam(params, name, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
}

function rowsFromBody(body) {
    if (!body || !body.data || !Array.isArray(body.data.data)) return [];
    return body.data.data;
}

function responseJson(response) {
    try {
        return response.json();
    } catch (error) {
        return null;
    }
}

function sampleBody(response) {
    return String(response && response.body ? response.body : '').slice(0, 300);
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

function isZipDownloadResponse(response) {
    const contentType = headerValue(response, 'Content-Type').toLowerCase();
    const contentDisposition = headerValue(response, 'Content-Disposition').toLowerCase();
    const zipHeaders = contentType.includes('zip')
        || contentType.includes('octet-stream')
        || contentDisposition.includes('.zip')
        || contentDisposition.includes('attachment');

    return response && response.status === 200 && zipHeaders;
}

function headerValue(response, name) {
    const headers = response && response.headers ? response.headers : {};
    const match = Object.keys(headers).find((key) => key.toLowerCase() === String(name).toLowerCase());
    return match ? String(headers[match] || '') : '';
}

function absoluteApiUrl(value) {
    const raw = String(value || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${environment.apiBaseUrl}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function jobIdFromDownloadUrl(value) {
    const match = String(value || '').match(/\/export\/([^/]+)\/download(?:[?#].*)?$/i);
    return match ? decodeURIComponent(match[1]) : '';
}

function responseBodyLength(body) {
    if (!body) return 0;
    if (typeof body.byteLength === 'number') return body.byteLength;
    return String(body).length;
}

function bodyStartsWithZipMagic(body) {
    if (!body) return false;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
        const bytes = new Uint8Array(body);
        return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    }

    return String(body).slice(0, 2) === 'PK';
}

function isRealUserFlow() {
    return String(environment.downloadFlowMode || '').toLowerCase() === 'real-user';
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
