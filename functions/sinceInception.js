
const { query } = require('../database');

const inceptionCache = new Map();

async function inceptionPrice(mixerId) {
    if (inceptionCache.has(mixerId)) return inceptionCache.get(mixerId);

    const rows = await query(
        `SELECT open FROM mixer_candles
          WHERE mixer_id = $1 ORDER BY time ASC LIMIT 1`,
        [mixerId]
    );

    const first = rows.length ? Number(rows[0].open) : null;
    if (first === null || !isFinite(first) || first <= 0) return null;

    inceptionCache.set(mixerId, first);
    return first;
}

async function sinceInceptionReturn(mixerId, currentPrice) {
    if (currentPrice === null || !isFinite(currentPrice) || currentPrice <= 0) return null;
    try {
        const first = await inceptionPrice(mixerId);
        if (first === null) return null;
        return (currentPrice / first - 1) * 100;
    } catch (err) {
        console.error('SIR computation failed:', err.message);
        return null;
    }
}

async function inceptionPricesFor(mixerIds) {
    const ids = [...new Set(mixerIds || [])].filter(Boolean);
    const out = {};
    const missing = [];
    for (const id of ids) {
        if (inceptionCache.has(id)) out[id] = inceptionCache.get(id);
        else missing.push(id);
    }
    if (!missing.length) return out;

    try {
        const rows = await query(
            `SELECT DISTINCT ON (mixer_id) mixer_id, open
               FROM mixer_candles
              WHERE mixer_id = ANY($1)
              ORDER BY mixer_id, time ASC`,
            [missing]
        );
        for (const r of rows) {
            const v = Number(r.open);
            if (!isFinite(v) || v <= 0) continue;
            inceptionCache.set(r.mixer_id, v);
            out[r.mixer_id] = v;
        }
    } catch (err) {
        console.error('Batch inception lookup failed:', err.message);
    }
    return out;
}

const closingCache = new Map();

async function closingPricesFor(mixers) {
    const out = {};
    const now = Date.now();
    const pending = [];
    for (const m of mixers || []) {
        if (!m || !m.mixer_id || !m.expires_at) continue;
        if (closingCache.has(m.mixer_id)) out[m.mixer_id] = closingCache.get(m.mixer_id);
        else pending.push(m);
    }
    if (!pending.length) return out;

    try {
        const rows = await query(
            `SELECT DISTINCT ON (c.mixer_id) c.mixer_id, c.close
               FROM mixer_candles c
               JOIN mixers m ON m.mixer_id = c.mixer_id
              WHERE c.mixer_id = ANY($1)
                AND c.time <= extract(epoch FROM m.expires_at)::INT8
              ORDER BY c.mixer_id, c.time DESC`,
            [pending.map(m => m.mixer_id)]
        );
        const ended = new Set(pending
            .filter(m => new Date(m.expires_at).getTime() <= now)
            .map(m => m.mixer_id));
        for (const r of rows) {
            const v = Number(r.close);
            if (!isFinite(v) || v <= 0) continue;
            out[r.mixer_id] = v;
            if (ended.has(r.mixer_id)) closingCache.set(r.mixer_id, v);
        }
    } catch (err) {
        console.error('Closing price lookup failed:', err.message);
    }
    return out;
}

module.exports = { sinceInceptionReturn, inceptionPrice, inceptionPricesFor, closingPricesFor };
