require('dotenv').config({ quiet: true });
const redis = require('../redis');

const TARGET_POINTS = 180;

function parseTicks(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
        let p;
        try { p = JSON.parse(row); } catch { continue; }
        const price = Number(p && p.price);
        const ts = Number(p && p.ts);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (!Number.isFinite(ts) || ts <= 0) continue;
        out.push({ ts, price });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
}

function downsample(points, target) {
    if (points.length <= target) return points;
    const step = (points.length - 1) / (target - 1);
    const out = [];
    for (let i = 0; i < target; i++) out.push(points[Math.round(i * step)]);

    if (out[out.length - 1] !== points[points.length - 1]) {
        out[out.length - 1] = points[points.length - 1];
    }
    return out;
}

async function tokenSeriesFor(allocations, tokenMap = {}) {
    const addrs = (allocations || []).map(a => a.token_address);
    const result = { interval: 'tick', tokens: {} };
    if (!addrs.length) return result;

    let raw = [];
    try {
        const pipeline = redis.multi();

        for (const a of addrs) pipeline.lRange(`ticks:${a}`, 0, 599);
        raw = await pipeline.exec();
    } catch (err) {
        console.error('Tick read failed:', err.message);
        return result;
    }

    const parsed = addrs.map((a, i) => ({ addr: a, points: parseTicks(raw[i]) }));

    const withData = parsed.filter(p => p.points.length >= 2);
    if (!withData.length) return result;

    const commonStart = Math.max(...withData.map(p => p.points[0].ts));

    for (const { addr, points } of parsed) {

        let clipped = points.filter(p => p.ts >= commonStart);
        if (clipped.length < 2) clipped = points;
        if (clipped.length < 2) continue;

        const alloc = (allocations || []).find(x => x.token_address === addr) || {};
        const meta = tokenMap[addr] || {};

        result.tokens[addr] = {
            weight: Number(alloc.weight) || 0,
            meta: {
                symbol: meta.symbol || null,
                name: meta.name || null,
                image: meta.logo || meta.image || null,
                decimals: meta.decimals ?? null,
            },
            data: downsample(clipped, TARGET_POINTS),
        };
    }

    return result;
}

module.exports = { tokenSeriesFor, TARGET_POINTS };
