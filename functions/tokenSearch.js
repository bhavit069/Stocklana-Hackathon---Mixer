require('dotenv').config({ quiet: true });

const SEARCH_URL = 'https://api.jup.ag/ultra/v1/search?query=';
const CACHE_TTL_SEC = 60;
const MAX_RESULTS = 10;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isMintAddress(q) {
    return BASE58.test(String(q || '').trim());
}

function shape(t) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    require('./iconRegistry').remember(t.id, t.icon);
    return {
        address: t.id,
        name: t.name || null,
        symbol: t.symbol || null,
        logo: t.icon || null,
        verified: t.isVerified === true,
        liquidity: num(t.liquidity),
        mcap: num(t.mcap),
        price: num(t.usdPrice),
        change24h: t.stats24h ? num(t.stats24h.priceChange) : null,
        organic: t.organicScoreLabel || null,
        tags: Array.isArray(t.tags) ? t.tags.slice(0, 8) : [],
    };
}

function rank(results, q) {
    const needle = String(q).trim().toLowerCase().replace(/^\$/, '');
    const bare = (s) => String(s || '').toLowerCase().replace(/^\$/, '');
    const score = (t) => {
        let s = 0;
        if (t.address === String(q).trim()) s += 1000;
        if (bare(t.symbol) === needle) s += 40;
        if (t.verified) s += 60;
        s += Math.log10(Math.max(1, t.liquidity || 0)) * 10;
        if (t.organic === 'high') s += 20;
        else if (t.organic === 'medium') s += 10;
        else if (t.organic === 'low') s -= 20;
        return s;
    };
    return results
        .map((t, i) => ({ t, i, s: score(t) }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map(x => x.t);
}

async function searchTokens(q) {
    const query = String(q || '').trim().slice(0, 64);
    if (query.length < 2 && !isMintAddress(query)) return [];

    const key = 'tokensearch:' + query.toLowerCase();
    let redis = null;
    try {
        redis = require('../redis');
        const hit = await redis.get(key);
        if (hit) {
            const cached = JSON.parse(hit);

            const { remember } = require('./iconRegistry');
            cached.forEach(t => remember(t.address, t.logo));
            return cached;
        }
    } catch { }

    if (!process.env.JUP_API_KEY) throw new Error('JUP_API_KEY is not configured');

    const res = await fetch(SEARCH_URL + encodeURIComponent(query), {
        headers: { 'x-api-key': process.env.JUP_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('Token search failed (' + res.status + ')');
    const raw = await res.json();

    const shaped = (Array.isArray(raw) ? raw : [])
        .filter(t => t && t.id && (t.symbol || t.name))
        .map(shape);
    const out = rank(shaped, query).slice(0, MAX_RESULTS);

    try { if (redis) await redis.set(key, JSON.stringify(out), { EX: CACHE_TTL_SEC }); } catch { }
    return out;
}

module.exports = { searchTokens, isMintAddress };
