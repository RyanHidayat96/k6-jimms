import http from 'k6/http';
import { check } from 'k6';
import { environment } from '../config/environment.js';

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
    check(csrfResponse, {
        'auth csrf status is 200': (response) => response.status === 200,
        'auth csrf token exists': (response) => Boolean(jsonValue(response, 'csrfToken')),
    });

    const csrfToken = jsonValue(csrfResponse, 'csrfToken');
    if (!csrfToken) {
        throw new Error(`Cannot login: csrfToken not found. Status=${csrfResponse.status}`);
    }

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
    check(loginResponse, {
        'auth login status is 200': (response) => response.status === 200,
        'auth login returns url': (response) => Boolean(jsonValue(response, 'url')),
    });

    const sessionResponse = http.get(`${environment.feBaseUrl}/api/auth/session`, {
        headers: { Accept: 'application/json' },
        tags: { request: 'GET /api/auth/session' },
        timeout: '30s',
    });
    check(sessionResponse, {
        'auth session status is 200': (response) => response.status === 200,
        'auth session accessToken exists': (response) => Boolean(jsonValue(response, 'user.accessToken')),
    });

    const accessToken = jsonValue(sessionResponse, 'user.accessToken');
    if (!accessToken) {
        throw new Error(`Cannot login: accessToken not found. Status=${sessionResponse.status}`);
    }

    return {
        accessToken,
        username: environment.username,
        authenticatedAt: new Date().toISOString(),
    };
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
