require('dotenv').config({ quiet: true });
const redis = require('../redis');

const TIMEFRAMES = ['5m', '1h', '6h', '24h'];

async function changesFor(mixerIds) {
    const out = {};
    if (!mixerIds.length) return out;

    const pipeline = redis.multi();
    mixerIds.forEach(id => pipeline.hGetAll(`mixer:timeframes:${id}`));

    let results = [];
    try {
        results = await pipeline.exec();
    } catch (err) {
        console.error('Timeframe read failed:', err.message);
        return out;
    }

    mixerIds.forEach((id, i) => {
        const h = results[i];
        const row = {};
        for (const tf of TIMEFRAMES) {
            const raw = h && h[`${tf}_change`];

            row[tf] = raw === undefined || raw === '' ? null : Number(raw);
        }
        out[id] = row;
    });

    return out;
}

async function sparklinesFor(mixerIds, points = 32) {
    const out = {};
    const spans = {};
    if (!mixerIds.length) return out;

    const pipeline = redis.multi();

    mixerIds.forEach(id => pipeline.lRange(`mixer:ticks:${id}`, 0, -1));

    let results = [];
    try {
        results = await pipeline.exec();
    } catch (err) {
        console.error('Tick read failed:', err.message);
        return out;
    }

    mixerIds.forEach((id, i) => {
        const raw = Array.isArray(results[i]) ? results[i] : [];
        const parsed = raw
            .map(r => { try { return JSON.parse(r); } catch { return null; } })
            .filter(t => t && Number.isFinite(t.price))
            .reverse();

        if (parsed.length < 2) { out[id] = []; return; }

        const step = Math.max(1, Math.floor(parsed.length / points));
        const sampled = [];
        for (let j = 0; j < parsed.length; j += step) sampled.push(parsed[j].price);

        const last = parsed[parsed.length - 1].price;
        if (sampled[sampled.length - 1] !== last) sampled.push(last);

        out[id] = sampled;

        const firstTs = Number(parsed[0].ts);
        const lastTs = Number(parsed[parsed.length - 1].ts);
        if (Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs > firstTs) {
            spans[id] = lastTs - firstTs;
        }
    });

    return { series: out, spans };
}

async function activityFor(mixerIds) {
    const out = {};
    if (!mixerIds.length) return out;

    try {
        const { query } = require('../database');
        const rows = await query(
            `SELECT mixer_id,
                    sum(sol_amount) AS volume_sol,
                    count(*) AS trades,
                    count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS trades_24h,
                    coalesce(sum(sol_amount) FILTER (
                        WHERE created_at > now() - interval '24 hours'), 0)          AS volume_24h,
                    count(DISTINCT wallet) AS traders,
                    max(created_at) AS last_trade
             FROM mixer_trades
             WHERE mixer_id = ANY($1)
             GROUP BY mixer_id`,
            [mixerIds]
        );

        for (const r of rows) {
            out[r.mixer_id] = {
                volumeSol: Number(r.volume_sol || 0),
                volume24h: Number(r.volume_24h || 0),
                trades: Number(r.trades || 0),
                trades24h: Number(r.trades_24h || 0),
                traders: Number(r.traders || 0),
                lastTrade: r.last_trade || null,
            };
        }
    } catch (err) {
        console.error('Activity query failed:', err.message);
    }

    for (const id of mixerIds) {
        if (!out[id]) {
            out[id] = {
                volumeSol: 0, volume24h: 0, trades: 0,
                trades24h: 0, traders: 0, lastTrade: null,
            };
        }
    }

    return out;
}

async function pricesFor(mixerIds) {
    try {
        const all = (await redis.hGetAll('mixer:prices')) || {};
        const out = {};
        for (const id of mixerIds) {
            out[id] = all[id] !== undefined && all[id] !== '' ? Number(all[id]) : null;
        }
        return out;
    } catch (err) {
        console.error('Price read failed:', err.message);
        return {};
    }
}

async function marketDataFor(mixerIds) {
    const ids = [...new Set(mixerIds)].filter(Boolean);
    if (!ids.length) return {};

    const [prices, changes, activity, sparks] = await Promise.all([
        pricesFor(ids),
        changesFor(ids),
        activityFor(ids),
        sparklinesFor(ids),
    ]);

    const out = {};
    for (const id of ids) {
        out[id] = {
            price: prices[id] ?? null,
            changes: changes[id] || { '5m': null, '1h': null, '6h': null, '24h': null },
            sparkline: (sparks.series && sparks.series[id]) || [],

            sparklineSpanMs: (sparks.spans && sparks.spans[id]) || null,
            ...activity[id],
        };
    }
    return out;
}

async function priceHistoryFor(mixerIds, opts = {}) {
    const ids = [...new Set(mixerIds)].filter(Boolean);
    const out = {};
    if (!ids.length) return out;

    const windowSec = opts.windowSec || 86400;
    const bucketSec = opts.bucketSec || 1800;
    const since = Math.floor(Date.now() / 1000) - windowSec;

    try {
        const { query } = require('../database');
        const rows = await query(
            `SELECT mixer_id, (time - time % $3) AS bucket, avg(close) AS close
               FROM mixer_candles
              WHERE mixer_id = ANY($1) AND time >= $2
              GROUP BY mixer_id, bucket
              ORDER BY mixer_id, bucket`,
            [ids, since, bucketSec]
        );
        for (const r of rows) {
            const v = Number(r.close);
            if (!Number.isFinite(v) || v <= 0) continue;
            (out[r.mixer_id] = out[r.mixer_id] || []).push(v);
        }
    } catch (err) {
        console.error('Price history query failed:', err.message);
    }

    const live = opts.live || {};
    for (const id of ids) {
        const series = out[id] || [];
        const now = Number(live[id]);
        if (Number.isFinite(now) && now > 0) series.push(now);
        out[id] = series;
    }
    return out;
}

module.exports = { marketDataFor, priceHistoryFor, TIMEFRAMES };
