require('dotenv').config({ quiet: true });
const axios = require('axios');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_BASE = 'https://api.jup.ag/price/v3';

let solUsdCache = { value: null, at: 0 };
const SOL_CACHE_MS = 60_000;

function parseRates() {
    const raw = process.env.SWAP_DUMMY_RATES;
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error('SWAP_DUMMY_RATES is not valid JSON:', err.message);
        return {};
    }
}

const RATES = parseRates();

function isDevnetMint(mint) {
    return Object.prototype.hasOwnProperty.call(RATES, mint);
}

async function getSolUsd() {
    const now = Date.now();
    if (solUsdCache.value !== null && now - solUsdCache.at < SOL_CACHE_MS) {
        return solUsdCache.value;
    }

    try {
        const r = await axios.get(`${JUP_BASE}?ids=${SOL_MINT}`, { timeout: 8000 });
        const entry = r.data && r.data[SOL_MINT];
        if (entry && entry.usdPrice) {
            solUsdCache = { value: entry.usdPrice, at: now };
            return entry.usdPrice;
        }
    } catch (err) {
        console.error('SOL price fetch failed:', err.message);
    }

    if (solUsdCache.value !== null) return solUsdCache.value;

    const fallback = Number(process.env.DEVNET_SOL_USD_FALLBACK || 150);
    solUsdCache = { value: fallback, at: now };
    return fallback;
}

async function getDevnetPrices(mints) {
    const known = mints.filter(isDevnetMint);
    if (!known.length) return {};

    const solUsd = await getSolUsd();
    const out = {};

    for (const mint of known) {
        const tokensPerSol = Number(RATES[mint]);
        if (!Number.isFinite(tokensPerSol) || tokensPerSol <= 0) continue;

        out[mint] = {
            usdPrice: solUsd / tokensPerSol,
            source: 'devnet-rates',
        };
    }

    return out;
}

module.exports = { getDevnetPrices, isDevnetMint, getSolUsd, RATES, SOL_MINT };
