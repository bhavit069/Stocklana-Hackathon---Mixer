
const express = require("express");
const router = express.Router();

const mixerCandleRepo = require("../database/mixerCandles.repo");
const candleService = require("../services/candles");

router.get("/:mixerId/candles", async (req, res) => {
    try {
        const { mixerId } = req.params;

        const limit = Number(req.query.limit || 300);
        const interval = req.query.interval || "15s";

        const dbCandles = await mixerCandleRepo.getMixerCandles(
            mixerId,
            interval,
            limit
        );

        let liveCandles = [];
        if (interval === "15s") {
            liveCandles = await candleService.getLiveCandles(mixerId);
        }

        let merged = [...dbCandles];

        if (merged.length > 0) {
            const lastDbTime = merged[merged.length - 1].time;
            const newCandles = liveCandles.filter(c => c.time > lastDbTime);
            merged = merged.concat(newCandles);
        } else {
            merged = liveCandles;
        }

        if (merged.length > limit) {
            merged = merged.slice(merged.length - limit);
        }

        const validated = merged.filter(c => {

            return c.time < 2000000000;
        });

        res.json(validated);
    } catch (err) {
        console.error("Failed to fetch candles:", err);
        res.status(500).json({ error: "Failed to fetch candles" });
    }
});

router.get("/:mixerId/trade-markers", async (req, res) => {
    try {
        const { mixerId } = req.params;
        const { tradeMarkers } = require("../functions/tradeMarkers");
        const { fetchMixerById } = require("../database/mixer.repo");

        let creatorUserId = null;
        try {
            const mixer = await fetchMixerById(mixerId);
            creatorUserId = mixer ? mixer.created_by : null;
        } catch { }

        const markers = await tradeMarkers(mixerId, {
            limit: Number(req.query.limit || 100),
            creatorUserId,
        });

        res.json({ ok: true, markers });
    } catch (err) {
        console.error("Failed to fetch trade markers:", err);
        res.status(500).json({ error: "Failed to fetch trade markers" });
    }
});

module.exports = router;
