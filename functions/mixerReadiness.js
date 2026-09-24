require('dotenv').config({ quiet: true });
const redis = require('../redis');

const MIN_TICKS = 2;

async function getReadiness(mixerId, allocations) {
    const addrs = [...new Set((allocations || []).map(a => a.token_address))];

    const result = {
        state: 'pricing',
        tradeable: false,
        price: null,
        pricedWeight: 0,
        totalWeight: 0,
        missing: [],
        ticks: 0,
        reason: null,
    };

    if (!addrs.length) {
        result.state = 'unpriceable';
        result.reason = 'This mixer has no token allocations.';
        return result;
    }

    let prices = [];
    try {
        prices = await redis.hmGet('prices', addrs);
    } catch (err) {
        console.error('Readiness price read failed:', err.message);
    }

    const priceByAddr = {};
    addrs.forEach((a, i) => {
        const v = prices[i];
        if (v !== null && v !== undefined && v !== '') {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) priceByAddr[a] = n;
        }
    });

    for (const a of allocations) {
        const w = Number(a.weight) || 0;
        result.totalWeight += w;
        if (priceByAddr[a.token_address]) result.pricedWeight += w;
        else result.missing.push(a.token_address);
    }

    try {
        result.ticks = Number(await redis.hGet('mixer:priced', mixerId)) || 0;
    } catch { }

    let cached = null;
    try {
        const raw = await redis.hGet('mixer:prices', mixerId);
        if (raw) {
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0) cached = n;
        }
    } catch { }

    if (result.pricedWeight <= 0) {
        result.state = 'unpriceable';
        result.reason =
            'None of this mixer\'s tokens have a market price, so it cannot be valued or traded.';
        return result;
    }

    if (cached === null || result.ticks < MIN_TICKS) {
        result.state = 'pricing';
        result.reason =
            'Waiting for the first price updates. This usually takes under a minute.';
        return result;
    }

    result.price = cached;

    const coverage = result.totalWeight > 0 ? result.pricedWeight / result.totalWeight : 0;
    if (result.missing.length > 0) {
        result.state = 'partial';
        result.tradeable = true;
        result.coverage = coverage;
        result.reason =
            `${result.missing.length} of ${allocations.length} tokens have no market price. ` +
            `Pricing covers ${(coverage * 100).toFixed(0)}% of the basket.`;
        return result;
    }

    result.state = 'ready';
    result.tradeable = true;
    result.coverage = 1;
    return result;
}

module.exports = { getReadiness, MIN_TICKS };
