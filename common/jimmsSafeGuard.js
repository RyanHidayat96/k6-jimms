export function assertJimmsConfigured(env) {
    const missing = [];

    if (!env.apiBaseUrl) missing.push('JIMMS_API_BASE_URL');
    if (!env.apiKey) missing.push('JIMMS_API_KEY');

    if (!env.accessToken) {
        if (!env.feBaseUrl) missing.push('JIMMS_FE_BASE_URL');
        if (!env.username) missing.push('JIMMS_USERNAME');
        if (!env.password) missing.push('JIMMS_PASSWORD');
    }

    if (missing.length > 0) {
        throw new Error(`Missing required env: ${missing.join(', ')}`);
    }
}
