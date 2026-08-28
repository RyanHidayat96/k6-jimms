function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function boolEnv(name, defaultValue = false) {
    const rawValue = __ENV[name];
    if (rawValue === undefined || rawValue === '') return defaultValue;
    return String(rawValue).toLowerCase() === 'true';
}

function intEnv(name, defaultValue) {
    const value = Number.parseInt(__ENV[name], 10);
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

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
    downloadRowStrategy: __ENV.JIMMS_DOWNLOAD_ROW_STRATEGY || 'rotate',
    downloadAllArchive: boolEnv('JIMMS_DOWNLOAD_ALL_ARCHIVE', true),
    downloadCheckFormJsa: boolEnv('JIMMS_DOWNLOAD_CHECK_FORM_JSA', false),
    downloadCheckFormPersiapan: boolEnv('JIMMS_DOWNLOAD_CHECK_FORM_PERSIAPAN', false),
    downloadCheckDataAdministrasi: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_ADMINISTRASI', false),
    downloadCheckDataInspeksi: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_INSPEKSI', false),
    downloadCheckDokumentasi: boolEnv('JIMMS_DOWNLOAD_CHECK_DOKUMENTASI', false),
    downloadCheckStripmapInspeksi: boolEnv('JIMMS_DOWNLOAD_CHECK_STRIPMAP_INSPEKSI', false),
    downloadCheckStripmapPenanganan: boolEnv('JIMMS_DOWNLOAD_CHECK_STRIPMAP_PENANGANAN', false),
    downloadCheckDataPenanganan: boolEnv('JIMMS_DOWNLOAD_CHECK_DATA_PENANGANAN', false),
    exportTimeout: '120s',
    downloadFileTimeout: '120s',
    downloadProgressTimeout: __ENV.JIMMS_DOWNLOAD_PROGRESS_TIMEOUT || '80s',
    downloadProgressAttempts: intEnv('JIMMS_DOWNLOAD_PROGRESS_ATTEMPTS', 60),
    downloadResponseType: 'binary',
    saveDownloadedZip: boolEnv('JIMMS_SAVE_DOWNLOADED_ZIP', false),
    setupTimeout: '5m',
    insecureSkipTLSVerify: false,
    reportDir: __ENV.K6_REPORT_DIR || './test-results/reports/k6',
};
