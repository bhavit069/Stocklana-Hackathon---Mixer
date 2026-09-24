require('dotenv').config({ quiet: true });
const axios = require('axios');
const { getSolUsd, SOL_MINT } = require('./devnetPrices');

const JUP_PRICE = 'https://api.jup.ag/price/v3';

async function realUsdPrices(mints) {
    if (!mints.length) return {};

    const key = process.env.JUP_API_KEY || process.env.JUPITER_API_KEY;

    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < mints.length; i += CHUNK) {
        chunks.push(mints.slice(i, i + CHUNK));
    }

    const data = {};
    const results = await Promise.allSettled(chunks.map(ids =>
        axios.get(`${JUP_PRICE}?ids=${ids.join(',')}`, {
            headers: key ? { 'x-api-key': key } : undefined,
            timeout: 8000,
        })
    ));

    for (const r of results) {
        if (r.status === 'fulfilled') Object.assign(data, r.value.data || {});
        else console.error('Real price lookup failed:', r.reason && r.reason.message);
    }

    const out = {};
    for (const m of mints) {
        if (data[m] && typeof data[m].usdPrice === 'number' && data[m].usdPrice > 0) {
            out[m] = data[m].usdPrice;
        }
    }
    return out;
}

async function ratesForTokens(mints) {
    const unique = [...new Set(mints)];
    const [prices, solUsd] = await Promise.all([
        realUsdPrices(unique),
        getSolUsd(),
    ]);

    const out = {};
    for (const m of unique) {

        if (m === SOL_MINT) { out[m] = 1; continue; }

        const usd = prices[m];
        out[m] = usd ? solUsd / usd : null;
    }
    return out;
}

module.exports = { ratesForTokens, realUsdPrices };
