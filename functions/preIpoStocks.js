require('dotenv').config({ quiet: true });
const axios = require('axios');
const redis = require('../redis');

const PRESTOCKS_URL = 'https://prestocks.com/api/prestocks';

const CACHE_KEY = 'preipo:catalog';
const CACHE_TTL_S = 300;

const HTTP = { timeout: 12000, headers: { accept: 'application/json' } };

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchPreStocks() {
    const { data } = await axios.get(PRESTOCKS_URL, HTTP);
    if (!Array.isArray(data)) return [];

    return data.map((x) => {
        const mark = num(x.markPrice);
        const token = num(x.tokenPrice);
        return {
            provider: 'prestocks',
            providerLabel: 'PreStocks',
            mint: x.contract_address,
            symbol: x.symbol,
            name: (x.name || '').replace(/\s+PreStocks$/i, '').trim() || x.symbol,

            description: (x.description || '').split('\n')[0].trim() || null,
            image: x.image || null,
            url: x.external_url || null,
            sector: null,
            markPrice: mark,
            tokenPrice: token,
            valuation: num(x.impliedValuation) || num(x.markValuation),
            markValuation: num(x.markValuation),
            supply: num(x.supply),
            holders: null,

            premiumPct: (mark && token) ? ((token - mark) / mark) * 100 : null,
        };
    }).filter(t => t.mint && t.symbol);
}

async function getCatalog({ force = false } = {}) {
    if (!force) {
        try {
            const hit = await redis.get(CACHE_KEY);
            if (hit) return JSON.parse(hit);
        } catch { }
    }

    let tokens = [];
    const failed = [];
    try {
        tokens = await fetchPreStocks();
    } catch (err) {
        failed.push('PreStocks');
        console.error('PreStocks fetch failed:', err.message);
    }

    tokens.sort((a, b) => (b.valuation || 0) - (a.valuation || 0));

    const payload = {
        tokens,
        count: tokens.length,
        providers: { prestocks: failed.length ? null : tokens.length },
        failed,
        fetchedAt: Date.now(),
    };

    if (tokens.length) {
        try {
            await redis.setEx(CACHE_KEY, CACHE_TTL_S, JSON.stringify(payload));
        } catch { }
    }

    return payload;
}

async function getByMint(mint) {
    const { tokens } = await getCatalog();
    return tokens.find(t => t.mint === mint) || null;
}

async function mapForMints(mints) {
    const out = {};
    if (!mints || !mints.length) return out;
    const { tokens } = await getCatalog();
    const byMint = tokens.reduce((a, t) => { a[t.mint] = t; return a; }, {});
    for (const m of mints) if (byMint[m]) out[m] = byMint[m];
    return out;
}

module.exports = { getCatalog, getByMint, mapForMints };
