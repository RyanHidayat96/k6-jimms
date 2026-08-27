function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function boolEnv(name, defaultValue = false) {
    const rawValue = __ENV[name];
    if (rawValue === undefined || rawValue === '') return defaultValue;
    return String(rawValue).toLowerCase() === 'true';
}

const downloadArchiveScenarios = __ENV.JIMMS_DOWNLOAD_ARCHIVE_SCENARIOS || '';
const downloadAllArchiveDefault = downloadArchiveScenarios ? false : true;

export const environment = {
    feBaseUrl: stripTrailingSlash(__ENV.JIMMS_FE_BASE_URL || __ENV.BASE_URL || ''),
    apiBaseUrl: stripTrailingSlash(__ENV.JIMMS_API_BASE_URL || __ENV.API_BASE_URL || ''),
    apiKey: __ENV.JIMMS_API_KEY || __ENV.API_KEY || '',
    accessToken: __ENV.JIMMS_ACCESS_TOKEN || '',
    username: __ENV.JIMMS_USERNAME || __ENV.USERNAME || '',
    password: __ENV.JIMMS_PASSWORD || __ENV.PASSWORD || '',
    callbackUrl: __ENV.JIMMS_CALLBACK_URL || `${stripTrailingSlash(__ENV.JIMMS_FE_BASE_URL || __ENV.BASE_URL || '')}/login`,
    regularInspectionStatusId: __ENV.JIMMS_REGULAR_INSPECTION_STATUS_ID || '27',
    listPage: __ENV.JIMMS_LIST_PAGE || '1',
    listPerPage: __ENV.JIMMS_LIST_PER_PAGE || '5',
    extraListQuery: __ENV.JIMMS_EXTRA_LIST_QUERY || '',
    downloadInspectionIds: __ENV.JIMMS_DOWNLOAD_INSPECTION_IDS || '',
    downloadDirectUrls: __ENV.JIMMS_DOWNLOAD_DIRECT_URLS || '',
    downloadJobIds: __ENV.JIMMS_DOWNLOAD_JOB_IDS || '',
    downloadFlowMode: __ENV.JIMMS_DOWNLOAD_FLOW_MODE || 'real-user',
    downloadRowStrategy: __ENV.JIMMS_DOWNLOAD_ROW_STRATEGY || 'rotate',
    downloadArchiveScenarios,
    downloadAllArchive: boolEnv('JIMMS_DOWNLOAD_ALL_ARCHIVE', downloadAllArchiveDefault),
    downloadCheckFormJsa: boolEnv('JIMMS_DOWNLOAD_CHECK_FORM_JSA', false),
    downloadCheckFormPersiapan: boolEnv('JIMMS_DOWNLOAD_CHECK_FORM_PERSIAPAN', false),
    downloadCheckDataAdministrasi: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_ADMINISTRASI', false),
    downloadCheckDataInspeksi: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_INSPEKSI', false),
    downloadCheckDokumentasi: boolEnv('JIMMS_DOWNLOAD_CHECK_DOKUMENTASI', false),
    downloadCheckStripmapInspeksi: boolEnv('JIMMS_DOWNLOAD_CHECK_STRIPMAP_INSPEKSI', false),
    downloadCheckStripmapPenanganan: boolEnv('JIMMS_DOWNLOAD_CHECK_STRIPMAP_PENANGANAN', false),
    downloadCheckDataPenanganan: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_PENANGANAN', false),
    randomizeScenario: boolEnv('JIMMS_DOWNLOAD_RANDOMIZE_SCENARIO', false),
    exportTimeout: __ENV.JIMMS_EXPORT_TIMEOUT || '120s',
    downloadPrepareJobs: __ENV.JIMMS_DOWNLOAD_PREPARE_JOBS || '1',
    downloadFileTimeout: __ENV.JIMMS_DOWNLOAD_FILE_TIMEOUT || __ENV.JIMMS_EXPORT_TIMEOUT || '120s',
    downloadProgressTimeout: __ENV.JIMMS_DOWNLOAD_PROGRESS_TIMEOUT || __ENV.JIMMS_DOWNLOAD_FILE_TIMEOUT || '120s',
    downloadFilePollAttempts: __ENV.JIMMS_DOWNLOAD_FILE_POLL_ATTEMPTS || '3',
    downloadFilePollIntervalSeconds: __ENV.JIMMS_DOWNLOAD_FILE_POLL_INTERVAL_SECONDS || '2',
    downloadResponseType: __ENV.JIMMS_DOWNLOAD_RESPONSE_TYPE || 'none',
    setupTimeout: __ENV.JIMMS_SETUP_TIMEOUT || '5m',
    downloadAllowPollFallback: boolEnv('JIMMS_DOWNLOAD_ALLOW_POLL_FALLBACK', false),
    insecureSkipTLSVerify: boolEnv('JIMMS_INSECURE_SKIP_TLS_VERIFY', false),
    reportDir: __ENV.K6_REPORT_DIR || './test-results/reports/k6',
};
