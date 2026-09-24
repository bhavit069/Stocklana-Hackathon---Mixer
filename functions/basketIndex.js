
const redis = require('../redis');
const { query } = require('../database');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const inceptionCache = new Map();

async function inceptionPrices(mixerId) {
    if (inceptionCache.has(mixerId)) return inceptionCache.get(mixerId);

    let out = null;
    try {

        const stored = await query(
            `SELECT token_address, inception_price
               FROM mixer_allocations
              WHERE mixer_id = $1 AND inception_price IS NOT NULL AND inception_price > 0`,
            [mixerId]
        );
        if (stored.length) {
            const byToken = {};
            for (const r of stored) byToken[r.token_address] = Number(r.inception_price);
            inceptionCache.set(mixerId, byToken);
            return byToken;
        }

        const rows = await query(
            `SELECT m.real_mint, m.rate, m.created_at
               FROM mirror_mints m
               JOIN mixer_allocations a
                 ON a.token_address = m.real_mint AND a.mixer_id = $1
              WHERE m.rate IS NOT NULL AND m.rate > 0`,
            [mixerId]
        );
        if (rows.length) {

            const solAtMint = Number(await redis.hGet('prices', SOL_MINT)) || 0;
            out = {};
            for (const r of rows) {
                const rate = Number(r.rate);
                if (rate > 0 && solAtMint > 0) out[r.real_mint] = solAtMint / rate;
            }
            if (!Object.keys(out).length) out = null;
        }
    } catch (err) {
        console.error('[basketIndex] inception prices unavailable:', err.message);
    }

    inceptionCache.set(mixerId, out);
    return out;
}

function invalidate(mixerId) {
    if (mixerId) inceptionCache.delete(mixerId);
    else inceptionCache.clear();
}

function valueBasket(allocs, priceNow, priceThen, openPrice) {
    let valueThen = 0;
    let valueNow = 0;
    let pricedWeight = 0;
    let totalWeight = 0;
    const missing = [];

    for (const a of allocs) {
        const w = Number(a.weight);
        if (!Number.isFinite(w) || w <= 0) continue;
        totalWeight += w;

        const then = Number(priceThen && priceThen[a.token_address]);
        const now = Number(priceNow && priceNow[a.token_address]);

        if (!(then > 0) || !(now > 0)) {
            missing.push(a.token_address);
            continue;
        }

        const qty = w / then;
        valueThen += w;
        valueNow += qty * now;
        pricedWeight += w;
    }

    if (pricedWeight <= 0 || valueThen <= 0) {
        return { price: null, pricedWeight: 0, totalWeight, missing };
    }

    const open = Number(openPrice);
    const base = open > 0 ? open : 1;

    return {
        price: (valueNow / valueThen) * base,
        pricedWeight,
        totalWeight,
        missing,
    };
}

module.exports = { valueBasket, inceptionPrices, invalidate, SOL_MINT };
