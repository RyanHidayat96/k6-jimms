const loggedEvidenceKeys = {};

export function recordRuntimeEvidence(endpointOrName, evidence = {}) {
    if (typeof __VU !== 'undefined' && __VU !== 1) return;

    const request = typeof endpointOrName === 'string'
        ? endpointOrName
        : endpointOrName && endpointOrName.name
            ? endpointOrName.name
            : 'Unknown request';
    const endpointId = typeof endpointOrName === 'object' && endpointOrName ? endpointOrName.id : evidence.endpointId;
    const steps = normalizeList(evidence.steps);
    const sources = normalizeList(evidence.sources);

    if (steps.length === 0 && sources.length === 0) return;

    const payload = {
        endpoint_id: endpointId || 'N/A',
        request,
        steps,
        sources,
    };
    const key = [payload.endpoint_id, payload.request, steps.join('|'), sources.join('|')].join('|');
    if (loggedEvidenceKeys[key]) return;

    loggedEvidenceKeys[key] = true;
    console.log('[K6-RUNTIME-EVIDENCE] ' + JSON.stringify(payload));
}

export function visibleRuntimeValue(value) {
    if (value === undefined || value === null || value === '') return '<empty>';
    const text = String(value);
    if (/bearer\s+/i.test(text) || text.length > 120) return '<available, hidden>';
    return text;
}

function normalizeList(value) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map((item) => String(item || '').trim()).filter(Boolean);
}
