const redis = require("../redis");
const mixerCandleRepo = require("../database/mixerCandles.repo");

const CANDLE_Interval_MS = 15_000;

const MIN_RANGE_PERCENT = 0.01;
const MIN_BODY_PERCENT = 0.005;

function bucket15sMs(tsMs) {
  return Math.floor(tsMs / CANDLE_Interval_MS) * CANDLE_Interval_MS;
}

function aggregateTicksToCandles(ticks, mixerId) {
  if (!ticks.length) return [];

  ticks.sort((a, b) => a.ts - b.ts);

  const buckets = new Map();

  for (const t of ticks) {
    const bucket = bucket15sMs(t.ts);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(t);
  }

  const candles = [];
  let skippedCount = 0;
  let totalBuckets = buckets.size;

  for (const [bucketMs, bucketTicks] of buckets.entries()) {
    const prices = bucketTicks.map(t => t.price);

    const open = prices[0];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const close = prices[prices.length - 1];

    const range = high - low;
    const bodySize = Math.abs(close - open);
    const averagePrice = (high + low) / 2;

    if (averagePrice === 0) {
      skippedCount++;
      continue;
    }

    const rangePercent = (range / averagePrice) * 100;
    const bodyPercent = (bodySize / averagePrice) * 100;

    if (rangePercent < MIN_RANGE_PERCENT && bodyPercent < MIN_BODY_PERCENT) {
      skippedCount++;
      continue;
    }

    candles.push({
      mixer_id: mixerId,
      interval: "15s",
      time: Math.floor(bucketMs / 1000),
      open: open,
      high: high,
      low: low,
      close: close,
    });
  }

  if (totalBuckets > 0) {
    const saveRate = ((candles.length / totalBuckets) * 100).toFixed(1);

  }

  candles.sort((a, b) => a.time - b.time);
  return candles;
}

async function processMixer(mixerId) {
  const redisKey = `mixer:ticks:${mixerId}`;

  await redis.watch(redisKey);

  const raw = await redis.lRange(redisKey, 0, -1);
  if (!raw.length) {
    await redis.unwatch();
    return;
  }

  const ticks = raw.map(t => JSON.parse(t));
  const now = Date.now();
  const currentBucketStart = bucket15sMs(now);

  const completedTicks = ticks.filter(t => bucket15sMs(t.ts) < currentBucketStart);
  const activeTicks = ticks.filter(t => bucket15sMs(t.ts) >= currentBucketStart);

  if (completedTicks.length === 0) {
    await redis.unwatch();
    return;
  }

  const candlesToInsert = aggregateTicksToCandles(completedTicks, mixerId);

  for (const candle of candlesToInsert) {
    await mixerCandleRepo.insertMixerCandle(candle);
  }

  const multi = redis.multi();
  multi.del(redisKey);

  if (activeTicks.length > 0) {
    activeTicks.sort((a, b) => a.ts - b.ts);
    const strings = activeTicks.map(t => JSON.stringify(t));
    multi.lPush(redisKey, ...strings);
  }

  const res = await multi.exec();

  if (!res) {

  }
}

async function getLiveCandles(mixerId) {
  const redisKey = `mixer:ticks:${mixerId}`;
  const raw = await redis.lRange(redisKey, 0, -1);
  const ticks = raw.map(t => JSON.parse(t));

  return aggregateTicksToCandles(ticks, mixerId);
}

async function runWorker() {
  try {
    const mixerIds = await redis.hKeys("mixer:prices");
    for (const mixerId of mixerIds) {
      await processMixer(mixerId);
    }
  } catch (err) {
    console.error("❌ Mixer candle worker error:", err);
  }
}

module.exports = { runWorker, getLiveCandles, bucket15sMs };