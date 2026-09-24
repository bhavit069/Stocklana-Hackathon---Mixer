
const express = require('express');
const router = express.Router();

const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { fetchMixersByCreator } = require('../database/mixer.repo');
const { creatorFeesFor, claimCreatorFees } = require('../functions/creatorFees');
const { getHolders } = require('../functions/holders');
const { query } = require('../database');
const redis = require('../redis');

async function creatorTotals(userId, mixers) {
    const ids = mixers.map(m => m.mixer_id);
    if (!ids.length) {
        return { volumeSol: 0, tradeCount: 0, uniqueTraders: 0, holders: 0 };
    }

    const rows = await query(
        `SELECT
            coalesce(sum(CASE WHEN side = 'buy' THEN sol_amount ELSE 0 END), 0) AS volume,
            count(*) AS trades,
            count(DISTINCT user_id) AS traders
         FROM mixer_trades WHERE mixer_id = ANY($1)`,
        [ids]
    );
    const r = rows[0] || {};

    let holders = 0;
    for (const id of ids) {
        try {
            holders += (await getHolders(id)).length;
        } catch (err) {
            console.error(`Holder count failed for ${id}:`, err.message);
        }
    }

    return {
        volumeSol: Number(r.volume || 0),
        tradeCount: Number(r.trades || 0),
        uniqueTraders: Number(r.traders || 0),
        holders,
    };
}

async function buildProfile(userId, { withFees = false } = {}) {
    const creator = await findUserById(userId);
    if (!creator) return null;

    const mixers = await fetchMixersByCreator(userId);

    let priceMap = {};
    try {
        priceMap = (await redis.hGetAll('mixer:prices')) || {};
    } catch { }

    const [totals, fees] = await Promise.all([
        creatorTotals(userId, mixers),
        withFees
            ? creatorFeesFor(userId).catch((err) => {
                console.error('Creator fees failed:', err.message);
                return null;
            })
            : null,
    ]);

    return {
        creator,
        mixers: mixers.map(m => ({
            ...m,
            price: priceMap[m.mixer_id] ? Number(priceMap[m.mixer_id]) : null,
        })),
        totals,
        fees,
    };
}

router.get('/fees', checkAuthenticated, async (req, res) => {
    try {
        res.json({ ok: true, fees: await creatorFeesFor(req.user.userId) });
    } catch (err) {
        console.error('Creator fees failed:', err);
        res.status(502).json({ error: 'Could not read your fees right now' });
    }
});

router.post('/claim', checkAuthenticated, async (req, res) => {
    const mixerId = req.body && req.body.mixerId ? String(req.body.mixerId) : undefined;

    try {
        const user = await findUserById(req.user.userId);
        if (!user || !user.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned for this account' });
        }

        const result = await claimCreatorFees({
            userId: user.userId,
            wallet: user.walletAddress,
            mixerId,
        });
        const fees = await creatorFeesFor(user.userId).catch(() => null);

        res.json({ ok: true, ...result, fees });
    } catch (err) {
        console.error('Claim failed:', err.message);
        res.status(err.status || 502).json({ error: err.message });
    }
});

router.get('/:userId', checkAuthenticated, async (req, res) => {

    const wantsJson = req.params.userId.endsWith('.json');
    const userId = wantsJson ? req.params.userId.slice(0, -5) : req.params.userId;

    try {
        const profile = await buildProfile(userId, { withFees: userId === req.user.userId });
        if (!profile) {
            return wantsJson
                ? res.status(404).json({ error: 'Creator not found' })
                : res.status(404).send('Creator not found');
        }

        if (wantsJson) return res.json({ ok: true, profile });

        const viewer = await findUserById(req.user.userId);
        res.render('creator', {
            user: viewer,
            profile,
            isSelf: userId === req.user.userId,
        });
    } catch (err) {
        console.error('Creator profile failed:', err);
        return wantsJson
            ? res.status(502).json({ error: err.message })
            : res.status(500).send('Could not load creator profile: ' + err.message);
    }
});

module.exports = router;
