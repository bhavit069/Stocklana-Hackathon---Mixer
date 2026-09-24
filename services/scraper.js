const {
  fetchWatchlist
} = require('../database/watcher.repo');
const axios = require('axios');
const redis = require('../redis');
const mixer = require('../database/mixer.repo');
const allocations = require('../database/mixer_allocations.repo');
require('dotenv').config();
const { getIO } = require("../socket");
const { getDevnetPrices, isDevnetMint } = require("../functions/devnetPrices");
const { valueBasket, inceptionPrices } = require("../functions/basketIndex");
const { inceptionPrice } = require("../functions/sinceInception");

const BASE = 'https://api.jup.ag/price/v3';

const API_KEY = process.env.JUP_API_KEY;

let watchlist = [];
let activeMixers = [];
let mixerAllocationsMap = new Map();

const lastStoredPrice = new Map();

let isFetchingPrices = false;

console.log("Pricing Services Initialized");

async function fetchPricesFromJup(tokens) {
  if (!tokens.length) return null;

  const remote = [];
  const local = [];
  for (const t of tokens) (isDevnetMint(t) ? local : remote).push(t);

  let data = {};

  if (remote.length) {
    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < remote.length; i += CHUNK) {
      chunks.push(remote.slice(i, i + CHUNK));
    }

    const results = await Promise.allSettled(chunks.map(ids =>
      axios.get(`${BASE}?ids=${ids.join(',')}`, {
        headers: API_KEY ? { 'x-api-key': API_KEY } : undefined,
        timeout: 5000
      })
    ));

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        Object.assign(data, r.value.data || {});
      } else {

        console.error(`Jup API request failed (chunk ${i + 1}/${chunks.length}):`,
          r.reason && r.reason.message);
      }
    });
  }

  const unpriced = tokens.filter(t => !data[t] || !data[t].usdPrice);
  if (unpriced.length) {
    try {
      Object.assign(data, await getDevnetPrices(unpriced));
    } catch (err) {
      console.error("Devnet price fallback failed:", err.message);
    }
  }

  return Object.keys(data).length ? data : null;
}

async function refreshMetadata() {
  try {

    const newWatchlist = await fetchWatchlist();
    if (newWatchlist && Array.isArray(newWatchlist)) {
      watchlist = newWatchlist;
    }

    const mixers = await mixer.fetchMixersByStatus("active");
    activeMixers = mixers;

    const newAllocMap = new Map();
    try {
      const rows = await allocations.fetchAllocationsForMixers(mixers.map(m => m.mixer_id));
      for (const row of rows) {
        const list = newAllocMap.get(row.mixer_id) || [];
        list.push(row);
        newAllocMap.set(row.mixer_id, list);
      }
      mixerAllocationsMap = newAllocMap;
    } catch (err) {

      console.error('Failed to refresh allocations:', err.message);
    }

  } catch (err) {
    console.error('Failed to refresh metadata:', err);
  }
}

const lastEmitTsMap = new Map();

const warnedUnpriced = new Set();

function optionalIO() {
  try { return getIO(); } catch { return null; }
}

async function computeMixerPrices(currentPrices) {
  try {
    const now = Date.now();
    const pipeline = redis.multi();
    const io = optionalIO();

    const MIN_PRICE_CHANGE_PERCENT = 0.005;
    const MIN_TIME_SINCE_LAST_MS = 500;

    for (const mx of activeMixers) {
      const mxId = mx.mixer_id;
      const allocs = mixerAllocationsMap.get(mxId) || [];

      if (!allocs.length) continue;

      const priceNow = {};
      for (const alloc of allocs) {
        const o = currentPrices[alloc.token_address];
        if (o && typeof o.usdPrice === 'number' && o.usdPrice > 0) {
          priceNow[alloc.token_address] = o.usdPrice;
        }
      }

      const [thenPrices, openPrice] = await Promise.all([
        inceptionPrices(mxId),
        inceptionPrice(mxId).catch(() => null),
      ]);

      const valued = thenPrices
        ? valueBasket(allocs, priceNow, thenPrices, openPrice)
        : { price: null, pricedWeight: 0, totalWeight: 0, missing: [] };

      const pricedWeight = valued.pricedWeight;
      const missing = valued.missing.length;

      if (valued.price === null) {
        if (!warnedUnpriced.has(mxId)) {
          warnedUnpriced.add(mxId);
          console.warn(`⚠️  ${mxId}: no constituent has a price; mixer cannot be valued`);
        }
        continue;
      }

      if (missing > 0 && !warnedUnpriced.has(mxId)) {
        warnedUnpriced.add(mxId);
        console.warn(
          `⚠️  ${mxId}: ${missing} of ${allocs.length} tokens have no Jupiter price; ` +
          `pricing the remaining ${(pricedWeight * 100).toFixed(0)}% of the basket`
        );
      }

      const mixerPrice = valued.price;

      const lastStored = lastStoredPrice.get(mxId);

      let shouldStore = true;

      if (lastStored) {
        const timeSinceLast = now - lastStored.ts;
        const priceChange = Math.abs(mixerPrice - lastStored.price);
        const priceChangePercent = (priceChange / lastStored.price) * 100;

        if (priceChangePercent < MIN_PRICE_CHANGE_PERCENT && timeSinceLast < MIN_TIME_SINCE_LAST_MS) {
          shouldStore = false;
        }
      }

      pipeline.hSet("mixer:prices", mxId, mixerPrice.toString());

      pipeline.hIncrBy("mixer:priced", mxId, 1);

      if (shouldStore) {
        pipeline.lPush(`mixer:ticks:${mxId}`, JSON.stringify({ price: mixerPrice, ts: now }));
        pipeline.lTrim(`mixer:ticks:${mxId}`, 0, 1200);

        lastStoredPrice.set(mxId, { price: mixerPrice, ts: now });
      }

      const lastEmit = lastEmitTsMap.get(mxId) || 0;
      if (now - lastEmit >= 300) {
        lastEmitTsMap.set(mxId, now);
        if (io) io.emit("mixer:price", {
          mixerId: mxId,
          price: mixerPrice,
          ts: now,
        });
      }
    }

    await pipeline.exec();

  } catch (err) {
    console.error("Error computing mixer prices:", err);
  }
}

const lastTokenTick = new Map();

const TOKEN_TICK_HEARTBEAT_MS = 60_000;

async function priceTick() {
  if (isFetchingPrices) return;
  if (!watchlist.length) return;

  isFetchingPrices = true;

  try {
    const data = await fetchPricesFromJup(watchlist);
    if (!data || typeof data !== 'object') return;

    const pipeline = redis.multi();
    const io = optionalIO();
    const now = Date.now();

    for (const id of watchlist) {
      const entry = data[id];
      if (!entry || typeof entry.usdPrice !== 'number') continue;

      const price = entry.usdPrice;

      pipeline.hSet('prices', id, price.toString());

      if (typeof entry.liquidity === 'number' && entry.liquidity >= 0) {
        pipeline.hSet('liquidity', id, String(entry.liquidity));
      }

      const last = lastTokenTick.get(id);
      const moved = !last
        || last.price !== price
        || (now - last.ts) >= TOKEN_TICK_HEARTBEAT_MS;

      if (moved) {
        lastTokenTick.set(id, { price, ts: now });
        pipeline.lPush(`ticks:${id}`, JSON.stringify({ price, ts: now }));
        pipeline.lTrim(`ticks:${id}`, 0, 1200);
      }

      if (moved) {
        if (io) io.emit("token:price", { tokenAddress: id, price, ts: now });
      }
    }

    await pipeline.exec();

    await computeMixerPrices(data);

  } catch (err) {
    console.error("Error fetching prices from Jup:", err.message);
  } finally {
    isFetchingPrices = false;
  }
}

module.exports = {
  refreshWatchlist: refreshMetadata,
  priceTick
};