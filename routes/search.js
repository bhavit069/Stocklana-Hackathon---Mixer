const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { fetchAllMixers } = require('../database/mixer.repo');
const { fetchAllocationsForMixers } = require('../database/mixer_allocations.repo');
const { getTokensByAddresses } = require('../database/token.repo');
const { marketDataFor } = require('../functions/marketData');
const { lifecycle } = require('../functions/memeMode');

const MAX_RESULTS = 12;

router.get('/api/search', checkAuthenticated, async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();

    try {
        const mixers = await fetchAllMixers();

        const ids = mixers.map(m => m.mixer_id);
        const allocs = ids.length ? await fetchAllocationsForMixers(ids) : [];

        const byMixer = allocs.reduce((acc, a) => {
            (acc[a.mixer_id] = acc[a.mixer_id] || []).push(a);
            return acc;
        }, {});

        const addrs = [...new Set(allocs.map(a => a.token_address))];
        let symbolFor = {};
        if (addrs.length) {
            try {
                const info = await getTokensByAddresses(addrs);
                symbolFor = (info || []).reduce((a, t) => {
                    a[t.address] = t.symbol || '';
                    return a;
                }, {});
            } catch (err) {
                console.error('Search token metadata failed:', err.message);
            }
        }

        let hits = mixers.filter((m) => {
            if (!q) return true;
            if (String(m.name || '').toLowerCase().includes(q)) return true;
            if (String(m.ticker || '').toLowerCase().includes(q)) return true;

            if (String(m.mixer_id || '').toLowerCase().includes(q)) return true;
            return (byMixer[m.mixer_id] || []).some((a) => {
                const sym = String(symbolFor[a.token_address] || '').toLowerCase();
                return sym.includes(q) || String(a.token_address).toLowerCase().includes(q);
            });
        });

        hits = hits.filter((m) => {
            const life = lifecycle(m);
            if (!life || life.state === 'live') return true;
            if (!q) return false;
            return String(m.ticker || '').toLowerCase() === q
                || String(m.mixer_id || '').toLowerCase() === q;
        });

        hits = hits.slice(0, MAX_RESULTS);

        let market = {};
        if (hits.length) {
            try {
                market = await marketDataFor(hits.map(m => m.mixer_id));
            } catch (err) {
                console.error('Search market data failed:', err.message);
            }
        }

        res.json({
            ok: true,
            query: q,
            results: hits.map((m) => {
                const d = market[m.mixer_id] || {};
                const life = lifecycle(m);
                const toks = (byMixer[m.mixer_id] || [])
                    .map(a => ({
                        address: a.token_address,
                        symbol: symbolFor[a.token_address] || a.token_address.slice(0, 4),
                        weight: Number(a.weight),
                    }))
                    .sort((x, y) => y.weight - x.weight);

                return {
                    mixerId: m.mixer_id,
                    name: m.name,
                    ticker: m.ticker,
                    image: m.image || null,
                    tokens: toks.slice(0, 5),
                    tokenCount: toks.length,
                    price: d.price ?? null,
                    change24h: (d.changes && d.changes['24h'] !== undefined) ? d.changes['24h'] : null,
                    volume24h: d.volume24h || 0,
                    holders: null,
                    createdAt: m.created_at,
                    expiresAt: life ? life.expiresAt : null,
                    isMine: m.created_by === req.user.userId,
                };
            }),
        });
    } catch (err) {
        console.error('Search failed:', err.message);
        res.status(502).json({ error: err.message, results: [] });
    }
});

module.exports = router;
