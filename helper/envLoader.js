const fs = require('fs');
const path = require('path');

function loadPerformanceEnv(projectRoot) {
    const repoRoot = path.resolve(projectRoot, '..');

    return Object.assign(
        {},
        parseDotEnv(path.join(repoRoot, '.env')),
        parseDotEnv(path.join(projectRoot, '.env')),
        process.env,
    );
}

function parseDotEnv(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const parsed = {};
    const content = fs.readFileSync(filePath, 'utf8');

    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            return;
        }

        const separatorIndex = trimmed.indexOf('=');

        if (separatorIndex === -1) {
            return;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        if (!key) {
            return;
        }

        value = stripInlineComment(value);
        value = stripWrappingQuotes(value);

        parsed[key] = value;
    });

    return parsed;
}

function stripInlineComment(value) {
    let quote = null;

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];

        if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
            quote = quote === char ? null : quote || char;
        }

        if (char === '#' && !quote && (index === 0 || /\s/.test(value[index - 1] || ''))) {
            return value.slice(0, index).trim();
        }
    }

    return value;
}

function stripWrappingQuotes(value) {
    const first = value[0];
    const last = value[value.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
    }

    return value;
}

module.exports = {
    loadPerformanceEnv,
    parseDotEnv,
};
