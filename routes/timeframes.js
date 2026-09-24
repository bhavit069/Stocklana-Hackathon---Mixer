const express = require('express');
const router = express.Router();
const timeframesWorker = require('../services/timeframes');
const redis = require('../redis');

router.get('/:mixerId', async (req, res) => {
  try {
    const { mixerId } = req.params;

    const data = await timeframesWorker.getMixerTimeframes(mixerId);

    if (!data) {
      return res.status(404).json({
        error: 'Timeframe data not found',
        message: 'This mixer may not have enough historical data yet'
      });
    }

    res.json(data);

  } catch (error) {
    console.error('Error fetching timeframes:', error);
    res.status(500).json({ error: 'Failed to fetch timeframe data' });
  }
});

router.get('/trending/:timeframe', async (req, res) => {
  try {
    const { timeframe } = req.params;
    const { limit = 20, direction = 'gainers' } = req.query;

    if (!['5m', '1h', '6h', '24h'].includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        message: 'Timeframe must be one of: 5m, 1h, 6h, 24h'
      });
    }

    if (!['gainers', 'losers'].includes(direction)) {
      return res.status(400).json({
        error: 'Invalid direction',
        message: 'Direction must be either "gainers" or "losers"'
      });
    }

    const trending = await timeframesWorker.getTrendingMixers(
      timeframe,
      parseInt(limit),
      direction
    );

    res.json({
      timeframe,
      direction,
      count: trending.length,
      mixers: trending
    });

  } catch (error) {
    console.error('Error fetching trending:', error);
    res.status(500).json({ error: 'Failed to fetch trending mixers' });
  }
});

router.get('/worker/status', (req, res) => {
  try {
    const status = timeframesWorker.getStatus();

    redis.hGetAll('timeframes:metrics').then(metrics => {
      res.json({
        ...status,
        last_update: metrics.last_update ? new Date(parseInt(metrics.last_update)).toISOString() : null,
        last_duration_ms: metrics.duration_ms ? parseInt(metrics.duration_ms) : null,
        last_stats: {
          total: parseInt(metrics.total) || 0,
          successful: parseInt(metrics.successful) || 0,
          failed: parseInt(metrics.failed) || 0,
          skipped: parseInt(metrics.skipped) || 0
        }
      });
    }).catch(err => {
      console.error('Error fetching metrics:', err);
      res.json(status);
    });

  } catch (error) {
    console.error('Error fetching worker status:', error);
    res.status(500).json({ error: 'Failed to fetch worker status' });
  }
});

module.exports = router;