require('dotenv').config({ quiet: true });
const axios = require('axios');
const redis = require('../redis');

const JUP_PRICE = 'https://api.jup.ag/price/v3';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BTC_MINT = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

const CACHE_KEY = 'ticker:refs';

const CACHE_TTL_S = 20;

const HTTP = { timeout: 8000 };

function shape(entry) {
    if (!entry) return null;
    const price = Number(entry.usdPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    const change = Number(entry.priceChange24h);
    return {
        price,

        change24h: Number.isFinite(change) ? change : null,
    };
}

async function getTicker({ force = false } = {}) {
    if (!force) {
        try {
            const hit = await redis.get(CACHE_KEY);
            if (hit) return JSON.parse(hit);
        } catch { }
    }

    const out = { sol: null, btc: null, fetchedAt: Date.now() };

    try {
        const { data } = await axios.get(
            `${JUP_PRICE}?ids=${SOL_MINT},${BTC_MINT}`, HTTP
        );
        out.sol = shape(data && data[SOL_MINT]);
        out.btc = shape(data && data[BTC_MINT]);
    } catch (err) {
        console.error('Ticker fetch failed:', err.message);
        return out;
    }

    if (out.sol || out.btc) {
        try {
            await redis.setEx(CACHE_KEY, CACHE_TTL_S, JSON.stringify(out));
        } catch { }
    }

    return out;
}

async function solUsd() {
    const t = await getTicker();
    return t.sol ? t.sol.price : null;
}

module.exports = { getTicker, solUsd, SOL_MINT, BTC_MINT };
