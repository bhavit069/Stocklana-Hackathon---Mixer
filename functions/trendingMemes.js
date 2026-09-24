require('dotenv').config({ quiet: true });

const TRENDING_URL = 'https://api.jup.ag/tokens/v2/toptrending/';
const CACHE_KEY = 'meme:trending';
const CACHE_TTL_SEC = 60;
const MIN_LIQUIDITY = 20_000;
const MAX_ITEMS = 24;

const NOT_MEME = new Set([
    'stocks', 'xstocks', 'rwa', 'equities', 'stable', 'major', 'defi', 'lst', 'yield', 'infra',
]);

const NOT_MEME_LAUNCHPADS = new Set(['metadao']);

let lastGood = [];

function shape(t) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    require('./iconRegistry').remember(t.id, t.icon);
    return {
        address: t.id,
        symbol: t.symbol,
        name: t.name,
        icon: t.icon,
        mcap: num(t.mcap),
        price: num(t.usdPrice),
        change1h: t.stats1h ? num(t.stats1h.priceChange) : null,
        change24h: t.stats24h ? num(t.stats24h.priceChange) : null,
        liquidity: num(t.liquidity),
        verified: t.isVerified === true,
        launchpad: t.launchpad || null,
    };
}

function isMeme(t) {
    if (!t || !t.id || !t.symbol || !t.icon) return false;
    const tags = Array.isArray(t.tags) ? t.tags : [];
    if (tags.some(tag => NOT_MEME.has(tag))) return false;

    const fromLaunchpad = !!t.launchpad && !NOT_MEME_LAUNCHPADS.has(t.launchpad);
    if (!tags.includes('meme') && !fromLaunchpad) return false;
    if (!(Number(t.liquidity) >= MIN_LIQUIDITY)) return false;
    if (!(Number(t.mcap) > 0)) return false;
    if (t.organicScoreLabel === 'low') return false;
    return true;
}

async function fetchWindow(window, limit) {
    const res = await fetch(`${TRENDING_URL}${window}?limit=${limit}`, {
        headers: { 'x-api-key': process.env.JUP_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Jupiter trending ${window} -> ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [];
}

async function getTrendingMemes() {
    let redis = null;
    try {
        redis = require('../redis');
        const hit = await redis.get(CACHE_KEY);
        if (hit) {
            const coins = JSON.parse(hit);

            const { remember } = require('./iconRegistry');
            coins.forEach(c => remember(c.address, c.icon));
            return coins;
        }
    } catch { }

    if (!process.env.JUP_API_KEY) return lastGood;

    try {

        const seen = new Set();
        const out = [];
        for (const window of ['1h', '6h']) {
            if (out.length >= MAX_ITEMS) break;
            for (const t of await fetchWindow(window, 100)) {
                if (out.length >= MAX_ITEMS) break;
                if (seen.has(t.id) || !isMeme(t)) continue;
                seen.add(t.id);
                out.push(shape(t));
            }
            if (out.length >= 12) break;
        }

        if (out.length) {
            lastGood = out;
            try { if (redis) await redis.set(CACHE_KEY, JSON.stringify(out), { EX: CACHE_TTL_SEC }); } catch { }
        }
        return out.length ? out : lastGood;
    } catch (err) {
        console.error('Trending memes failed:', err.message);
        return lastGood;
    }
}

module.exports = { getTrendingMemes };
