
const MIN_TRADE_USD = Number(process.env.MIN_TRADE_USD || 3);

const FALLBACK_MIN_SOL = Number(process.env.MIN_TRADE_SOL_FALLBACK || 0.027);

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function solUsd() {
    try {
        const redis = require('../redis');
        const cached = Number(await redis.hGet('prices', SOL_MINT));
        if (cached > 0) return cached;
    } catch { }
    try {
        const { getSolUsd } = require('./devnetPrices');
        const live = Number(await getSolUsd());
        if (live > 0) return live;
    } catch { }
    return null;
}

async function minTrade() {
    if (!(MIN_TRADE_USD > 0)) return { usd: 0, sol: 0 };
    const px = await solUsd();
    const sol = px ? MIN_TRADE_USD / px : FALLBACK_MIN_SOL;
    return { usd: MIN_TRADE_USD, sol, solUsd: px };
}

const fmtSol = (n) => n.toFixed(n < 0.1 ? 4 : 3);

async function belowMinimum(solAmount, what = 'trade') {
    const min = await minTrade();

    if (!(min.sol > 0) || solAmount >= min.sol * 0.999) return null;
    return {
        error: `The minimum ${what} is $${min.usd} (about ${fmtSol(min.sol)} SOL)`,
        min_usd: min.usd,
        min_sol: Number(min.sol.toFixed(6)),
    };
}

module.exports = { MIN_TRADE_USD, minTrade, belowMinimum };
