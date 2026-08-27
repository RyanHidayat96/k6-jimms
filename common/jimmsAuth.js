import http from 'k6/http';
import { check } from 'k6';
import { environment } from '../config/environment.js';
import { recordApiMetrics } from './errorMetrics.js';

export function authenticate() {
    if (environment.accessToken) {
        return {
            accessToken: environment.accessToken,
            username: environment.username || 'JIMMS_ACCESS_TOKEN',
            authenticatedAt: new Date().toISOString(),
        };
    }

    const csrfResponse = http.get(`${environment.feBaseUrl}/api/auth/csrf`, {
        tags: { request: 'GET /api/auth/csrf' },
        timeout: '30s',
    });
    const csrfOk = check(csrfResponse, {
        'auth csrf status is 200': (response) => response.status === 200,
        'auth csrf token exists': (response) => Boolean(jsonValue(response, 'csrfToken')),
    });

    const csrfToken = jsonValue(csrfResponse, 'csrfToken');
    recordSupportApi(csrfResponse, 'GET /api/auth/csrf', csrfOk, csrfOk ? 'CSRF token ready' : `Cannot login: csrfToken not found. Status=${csrfResponse.status}`);
    if (!csrfOk || !csrfToken) return skippedAuth(`Cannot login: csrfToken not found. Status=${csrfResponse.status}`, 'GET /api/auth/csrf');

    const loginResponse = http.post(
        `${environment.feBaseUrl}/api/auth/callback/credentials`,
        {
            username: environment.username,
            password: environment.password,
            redirect: 'false',
            csrfToken,
            callbackUrl: environment.callbackUrl,
            json: 'true',
        },
        {
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            tags: { request: 'POST /api/auth/callback/credentials' },
            timeout: '30s',
        },
    );
    const loginOk = check(loginResponse, {
        'auth login status is 200': (response) => response.status === 200,
        'auth login returns url': (response) => Boolean(jsonValue(response, 'url')),
    });
    recordSupportApi(loginResponse, 'POST /api/auth/callback/credentials', loginOk, loginOk ? 'Login support API ready' : `Cannot login: login failed. Status=${loginResponse.status}`);
    if (!loginOk) return skippedAuth(`Cannot login: login failed. Status=${loginResponse.status}`, 'POST /api/auth/callback/credentials');

    const sessionResponse = http.get(`${environment.feBaseUrl}/api/auth/session`, {
        headers: { Accept: 'application/json' },
        tags: { request: 'GET /api/auth/session' },
        timeout: '30s',
    });
    const sessionOk = check(sessionResponse, {
        'auth session status is 200': (response) => response.status === 200,
        'auth session accessToken exists': (response) => Boolean(jsonValue(response, 'user.accessToken')),
    });

    const accessToken = jsonValue(sessionResponse, 'user.accessToken');
    recordSupportApi(sessionResponse, 'GET /api/auth/session', sessionOk, sessionOk ? 'Session accessToken ready' : `Cannot login: accessToken not found. Status=${sessionResponse.status}`);
    if (!sessionOk || !accessToken) return skippedAuth(`Cannot login: accessToken not found. Status=${sessionResponse.status}`, 'GET /api/auth/session');

    return {
        accessToken,
        username: environment.username,
        authenticatedAt: new Date().toISOString(),
    };
}

function recordSupportApi(response, requestName, success, message) {
    recordApiMetrics(response, requestName, {
        valid: success,
        result: success ? 'PASSED' : 'SKIPPED',
        category: success ? 'passed' : 'support_skipped',
        message,
        skipPerformance: true,
    });
}

function skippedAuth(reason, stage) {
    const context = {
        skipped: true,
        skipStage: stage,
        skipReason: reason,
        username: environment.username,
        authenticatedAt: new Date().toISOString(),
    };

    console.warn('[K6-SKIPPED] ' + JSON.stringify(context));
    return context;
}

function jsonValue(response, path) {
    let body;

    try {
        body = response.json();
    } catch (error) {
        return '';
    }

    return String(path || '').split('.').reduce((current, key) => {
        if (current === undefined || current === null) return undefined;
        return current[key];
    }, body);
}
