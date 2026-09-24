const crypto = require('crypto');

function normaliseWeight(w) {
    const n = Number(w);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10000) / 10000;
}

function compositionKey(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return null;

    const parts = tokens
        .map(t => ({
            address: String(t.address || t.token_address || '').trim(),
            weight: normaliseWeight(t.weight),
        }))
        .filter(t => t.address)

        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
        .map(t => `${t.address}:${t.weight}`);

    if (!parts.length) return null;
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { compositionKey, normaliseWeight };
