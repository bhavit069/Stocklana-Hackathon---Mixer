require('dotenv').config({ quiet: true });
const redis = require('../redis');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { getDevnetPrices } = require('./devnetPrices');
const { valueBasket, inceptionPrices } = require('./basketIndex');
const { inceptionPrice } = require('./sinceInception');

async function fromTokenPrices(allocs, mixerId) {
    const addrs = allocs.map(a => a.token_address);
    if (!addrs.length) return null;

    let cached = [];
    try {
        cached = await redis.hmGet('prices', addrs);
    } catch {
        return null;
    }

    const priceNow = {};
    const missing = [];

    allocs.forEach((a, i) => {
        const p = Number(cached[i]);
        if (Number.isFinite(p) && p > 0) priceNow[a.token_address] = p;
        else missing.push(a);
    });

    if (missing.length) {
        try {
            const local = await getDevnetPrices(missing.map(a => a.token_address));
            for (const a of missing) {
                const entry = local[a.token_address];
                if (entry && entry.usdPrice > 0) priceNow[a.token_address] = entry.usdPrice;
            }
        } catch { }
    }

    const [then, open] = await Promise.all([
        inceptionPrices(mixerId),
        inceptionPrice(mixerId).catch(() => null),
    ]);
    if (!then) return null;

    const res = valueBasket(allocs, priceNow, then, open);
    return res.price;
}

async function getMixerPriceUsd(mixerId, opts = {}) {
    if (!mixerId) return null;

    try {
        const cached = await redis.hGet('mixer:prices', mixerId);
        const n = Number(cached);
        if (Number.isFinite(n) && n > 0) return n;
    } catch { }

    try {
        const allocs = opts.allocations
            || await fetchMixerAllocationsByMixerId(mixerId);
        if (!allocs || !allocs.length) return null;

        const price = await fromTokenPrices(allocs, mixerId);
        if (Number.isFinite(price) && price > 0) {

            try { await redis.hSet('mixer:prices', mixerId, String(price)); } catch {  }
            return price;
        }
    } catch (err) {
        console.error('[mixerPrice] recompute failed for', mixerId + ':', err.message);
    }

    return null;
}

module.exports = { getMixerPriceUsd };
