import http from 'k6/http';
import { check, sleep } from 'k6';
import { environment } from '../config/environment.js';
import { recordApiMetrics } from './errorMetrics.js';
import { recordRuntimeEvidence, visibleRuntimeValue } from './runtimeEvidence.js';

const LIST_REQUEST_NAME = 'GET /v1/regular-inspection filtered-list';
const EXPORT_REQUEST_NAME = 'POST /v1/regular-inspection/export/{id}';
const PROGRESS_REQUEST_NAME = 'GET /v1/regular-inspection/export/{jobId}/progress-stream';
const DOWNLOAD_FILE_REQUEST_NAME = 'GET /v1/regular-inspection/export/{jobId}/download';

const ALL_ARCHIVES = [
    'jsa_form',
    'preparation_form',
    'administration_form',
    'documents',
    'maintenance_data',
    'maintenance_stripmap',
    'inspection',
    'stripmap',
];

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

export function runDownloadFlow(authContext) {
    if (authContext && authContext.skipped) {
        console.warn('[K6-SKIPPED] ' + JSON.stringify({
            stage: authContext.skipStage || 'support',
            reason: authContext.skipReason || 'Support/precondition API failed.',
        }));
        return;
    }

    runRealUserDownloadFlow(authContext);
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

    downloadZip(authContext, {
        inspectionId: String(inspectionId),
        archiveScenario: archiveScenario.name,
        jobId: exportJob.jobId,
        filename: exportJob.filename,
        downloadUrl: progress.downloadUrl,
        source: 'real-user-progress-stream',
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

    const attempts = Math.max(1, Number(environment.downloadProgressAttempts || 1));
    let lastResponse = null;
    let lastProgress = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const response = http.get(`${environment.apiBaseUrl}/v1/regular-inspection/export/${encodeURIComponent(jobId)}/progress-stream`, {
            headers: apiHeaders(authContext, 'text/event-stream'),
            tags: { request: PROGRESS_REQUEST_NAME },
            timeout: environment.downloadProgressTimeout,
        });
        const progress = lastSseJson(String(response.body || ''));
        const hasProgressEvent = Boolean(progress);
        const hasDownloadUrl = Boolean(progress && progress.downloadUrl);
        const jobFailed = Boolean(progress && String(progress.status || '').toUpperCase() === 'FAILED');

        lastResponse = response;
        lastProgress = progress;

        if (!hasDownloadUrl && !jobFailed && attempt < attempts) {
            sleep(2);
            continue;
        }

        check(response, {
            'progress stream is readable': () => response.status === 200 || hasProgressEvent,
            'progress stream returns downloadUrl': () => hasDownloadUrl,
        });
        recordApiMetrics(response, PROGRESS_REQUEST_NAME, {
            valid: hasDownloadUrl,
            message: hasDownloadUrl
                ? 'Download URL ready from progress-stream'
                : `Progress stream did not return downloadUrl. status=${progress && progress.status ? progress.status : 'N/A'}`,
        });

        if (!hasDownloadUrl) break;

        recordRuntimeEvidence(PROGRESS_REQUEST_NAME, {
            endpointId: 'JIMMS_EXPORT_PROGRESS_STREAM',
            steps: [
                'UI menunggu job queued lewat progress-stream sampai downloadUrl tersedia.',
            ],
            sources: [
                `jobId=${visibleRuntimeValue(jobId)}.`,
                `attempt=${visibleRuntimeValue(attempt)}/${visibleRuntimeValue(attempts)}.`,
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

    throw new Error(`Progress stream did not return downloadUrl. http=${lastResponse && lastResponse.status ? lastResponse.status : 'N/A'}, status=${lastProgress && lastProgress.status ? lastProgress.status : 'N/A'}, percentage=${lastProgress && lastProgress.percentage !== undefined ? lastProgress.percentage : 'N/A'}`);
}

function downloadZip(authContext, downloadJob) {
    if (!downloadJob || !downloadJob.downloadUrl) {
        throw new Error('No ZIP download URL available.');
    }

    const response = http.get(downloadJob.downloadUrl, {
        headers: apiHeaders(authContext, 'application/zip, application/octet-stream, */*'),
        tags: { request: DOWNLOAD_FILE_REQUEST_NAME },
        timeout: environment.downloadFileTimeout,
        responseType: environment.downloadResponseType,
    });

    validateZipDownload(response, downloadJob);
    return response;
}

function validateZipDownload(response, downloadJob) {
    const success = isZipDownloadResponse(response);

    check(response, {
        'zip download status is 200': () => response.status === 200,
        'zip download returns file headers': () => isZipDownloadResponse(response),
        'zip download body downloaded': () => responseBodyLength(response.body) > 0,
        'zip download body starts with PK': () => bodyStartsWithZipMagic(response.body),
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
            `source=${visibleRuntimeValue(downloadJob.source || 'real-user-progress-stream')}.`,
            `jobId=${visibleRuntimeValue(downloadJob.jobId)}.`,
            `downloadUrl=${visibleRuntimeValue(downloadJob.downloadUrl)}.`,
            'responseType=binary.',
        ],
    });

    if (success && environment.saveDownloadedZip) {
        console.log('[K6-DOWNLOADED-ZIP-READY] ' + JSON.stringify({
            jobId: String(downloadJob.jobId || ''),
            filename: String(downloadJob.filename || ''),
            downloadUrl: String(downloadJob.downloadUrl || ''),
        }));
    }
}

function apiHeaders(authContext, accept = 'application/json, text/plain, */*') {
    return {
        Accept: accept,
        Authorization: `Bearer ${authContext.accessToken}`,
        'x-api-key': environment.apiKey,
    };
}

function pickArchiveScenario() {
    if (environment.downloadAllArchive) {
        return { name: 'all', archives: ALL_ARCHIVES.slice() };
    }

    const archives = CHECKBOX_ARCHIVES
        .filter(([configKey]) => Boolean(environment[configKey]))
        .map(([, archiveValue]) => archiveValue);

    if (archives.length === 0) {
        throw new Error('No download checkbox selected. Set JIMMS_DOWNLOAD_ALL_ARCHIVE=true or set at least one JIMMS_DOWNLOAD_CHECK_* value to true.');
    }

    return {
        name: archives.join('+'),
        archives,
    };
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

function splitCsv(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
