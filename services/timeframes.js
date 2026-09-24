const mixers = require('../database/mixer.repo');
const mixerCandles = require('../database/mixerCandles.repo');
const redis = require("../redis");

class TimeframesWorker {

  constructor() {
    this.isRunning = false;
    this.updateInterval = 30000;
    this.intervalId = null;

    this.timeframes = {
      '5m': 300,
      '1h': 3600,
      '6h': 21600,
      '24h': 86400
    };

    this.candleLimit = 6000;
  }

  async start() {
    if (this.isRunning) {
      console.log('⚠️  Timeframes worker already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Timeframes Worker started');
    console.log(`   Update interval: ${this.updateInterval / 1000}s`);
    console.log(`   Timeframes: ${Object.keys(this.timeframes).join(', ')}`);

    await this.updateAllMixers();

    this.intervalId = setInterval(() => {
      this.updateAllMixers();
    }, this.updateInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('⏹️  Timeframes Worker stopped');
  }

  async updateAllMixers() {
    const startTime = Date.now();

    try {

      const allMixers = await mixers.fetchAllMixers();

      if (!allMixers || allMixers.length === 0) {
        console.log('⚠️  No mixers found');
        return;
      }

      console.log(`📊 Updating timeframes for ${allMixers.length} mixers...`);

      let successful = 0;
      let failed = 0;
      let skipped = 0;

      const batchSize = 10;

      for (let i = 0; i < allMixers.length; i += batchSize) {
        const batch = allMixers.slice(i, i + batchSize);

        const results = await Promise.allSettled(
          batch.map(mixer => this.updateMixerTimeframes(mixer.mixer_id))
        );

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            if (result.value === 'skipped') {
              skipped++;
            } else {
              successful++;
            }
          } else {
            failed++;
            console.error(`❌ Failed to update ${batch[index].mixer_id}:`, result.reason?.message || result.reason);
          }
        });
      }

      const duration = Date.now() - startTime;

      console.log(`✅ Timeframes update complete in ${duration}ms`);
      console.log(`   Successful: ${successful}, Failed: ${failed}, Skipped: ${skipped}`);

      await redis.hSet('timeframes:metrics', {
        last_update: Date.now(),
        duration_ms: duration,
        total: allMixers.length,
        successful,
        failed,
        skipped
      });

    } catch (error) {
      console.error('❌ Critical error in updateAllMixers:', error);
    }
  }

  async updateMixerTimeframes(mixerId) {
    try {

      const candles = await mixerCandles.getMixerCandles(mixerId, '15s', this.candleLimit);

      if (!candles || candles.length === 0) {
        console.log(`⚠️  No candles for ${mixerId}, skipping`);
        return 'skipped';
      }

      candles.sort((a, b) => parseInt(a.time) - parseInt(b.time));

      const now = Math.floor(Date.now() / 1000);
      const currentCandle = candles[candles.length - 1];
      const currentPrice = parseFloat(currentCandle.close);

      const changes = {};

      for (const [label, seconds] of Object.entries(this.timeframes)) {
        const targetTime = now - seconds;

        const historicalCandle = this.findClosestCandle(candles, targetTime);

        if (historicalCandle) {
          const historicalPrice = parseFloat(historicalCandle.close);
          const priceChange = ((currentPrice - historicalPrice) / historicalPrice) * 100;

          changes[label] = {
            current_price: currentPrice,
            historical_price: historicalPrice,
            change_percent: parseFloat(priceChange.toFixed(4)),
            change_formatted: (priceChange >= 0 ? '+' : '') + priceChange.toFixed(2) + '%',
            historical_time: parseInt(historicalCandle.time),
            age_seconds: now - parseInt(historicalCandle.time)
          };
        } else {

          changes[label] = {
            current_price: currentPrice,
            historical_price: null,
            change_percent: null,
            change_formatted: null,
            historical_time: null,
            age_seconds: null
          };
        }
      }

      const redisKey = `mixer:timeframes:${mixerId}`;
      const redisData = {
        mixer_id: mixerId,
        current_price: currentPrice.toString(),
        last_updated: now.toString(),
        candle_count: candles.length,
        ...this.flattenChanges(changes)
      };

      await redis.hSet(redisKey, redisData);

      await this.updateTrendingSets(mixerId, changes);

      return 'success';

    } catch (error) {
      console.error(`❌ Error updating ${mixerId}:`, error.message);
      throw error;
    }
  }

  findClosestCandle(candles, targetTime) {
    if (!candles || candles.length === 0) return null;

    let left = 0;
    let right = candles.length - 1;
    let closest = null;
    let minDiff = Infinity;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const candleTime = parseInt(candles[mid].time);
      const diff = Math.abs(candleTime - targetTime);

      if (diff < minDiff) {
        minDiff = diff;
        closest = candles[mid];
      }

      if (candleTime < targetTime) {
        left = mid + 1;
      } else if (candleTime > targetTime) {
        right = mid - 1;
      } else {

        return candles[mid];
      }
    }

    if (closest && parseInt(closest.time) <= targetTime + 60) {
      return closest;
    }

    return null;
  }

  flattenChanges(changes) {
    const flattened = {};

    for (const [label, data] of Object.entries(changes)) {

      flattened[`${label}_current`] = data.current_price != null ? data.current_price.toString() : '';
      flattened[`${label}_historical`] = data.historical_price != null ? data.historical_price.toString() : '';
      flattened[`${label}_change`] = data.change_percent != null ? data.change_percent.toString() : '';
      flattened[`${label}_formatted`] = data.change_formatted || '';
      flattened[`${label}_time`] = data.historical_time ? data.historical_time.toString() : '';
      flattened[`${label}_age`] = data.age_seconds ? data.age_seconds.toString() : '';
    }

    return flattened;
  }

  async updateTrendingSets(mixerId, changes) {
    try {

      const ranked = ['5m', '1h', '6h', '24h']
        .filter(tf => changes[tf] && changes[tf].change_percent != null)
        .map(tf => redis.zAdd(`trending:${tf}`, {
          score: changes[tf].change_percent, value: mixerId,
        }));
      await Promise.all(ranked);

      await Promise.all([
        redis.expire('trending:5m', 7200),
        redis.expire('trending:1h', 7200),
        redis.expire('trending:6h', 7200),
        redis.expire('trending:24h', 7200)
      ]);

    } catch (error) {
      console.error(`⚠️  Failed to update trending sets for ${mixerId}:`, error.message);

    }
  }

  async getMixerTimeframes(mixerId) {
    try {
      const data = await redis.hGetAll(`mixer:timeframes:${mixerId}`);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      const num = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      };

      const window = (label) => ({
        change_percent: num(data[`${label}_change`]),
        change_formatted: data[`${label}_formatted`] || null,
        historical_price: num(data[`${label}_historical`]),
        historical_time: data[`${label}_time`] ? parseInt(data[`${label}_time`]) : null,
      });

      return {
        mixer_id: data.mixer_id,
        current_price: num(data.current_price),
        last_updated: data.last_updated ? parseInt(data.last_updated) : null,
        candle_count: data.candle_count ? parseInt(data.candle_count) : 0,
        timeframes: {
          '5m': window('5m'),
          '1h': window('1h'),
          '6h': window('6h'),
          '24h': window('24h'),
        }
      };

    } catch (error) {
      console.error(`Error fetching timeframes for ${mixerId}:`, error);
      return null;
    }
  }

  async getTrendingMixers(timeframe = '24h', limit = 20, direction = 'gainers') {
    try {
      const key = `trending:${timeframe}`;

      const entries = direction === 'gainers'
        ? await redis.zRangeWithScores(key, 0, limit - 1, { REV: true })
        : await redis.zRangeWithScores(key, 0, limit - 1);

      return entries.map(({ value, score }) => ({
        mixer_id: value,
        change_percent: score,
        change_formatted: (score >= 0 ? '+' : '') + score.toFixed(2) + '%'
      }));

    } catch (error) {
      console.error(`Error fetching trending ${direction}:`, error);
      return [];
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      update_interval_ms: this.updateInterval,
      timeframes: Object.keys(this.timeframes),
      candle_limit: this.candleLimit
    };
  }
}

const timeframesWorker = new TimeframesWorker();

module.exports = timeframesWorker;