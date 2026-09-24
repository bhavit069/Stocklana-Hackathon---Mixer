const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { getTokensByAddresses } = require('../database/token.repo');
const { fetchAllMixers } = require('../database/mixer.repo');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { marketDataFor, priceHistoryFor } = require('../functions/marketData');

const SORTS = {
    volume: (a, b) => b.volume24h - a.volume24h,
    price: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    change: (a, b) => (b.changes['24h'] ?? -Infinity) - (a.changes['24h'] ?? -Infinity),
    gainers: (a, b) => (b.changes['24h'] ?? -Infinity) - (a.changes['24h'] ?? -Infinity),
    losers: (a, b) => (a.changes['24h'] ?? Infinity) - (b.changes['24h'] ?? Infinity),
    trades: (a, b) => b.trades - a.trades,
    holders: (a, b) => b.holders - a.holders,
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
};

router.get('/', checkAuthenticated, async (req, res) => {
    try {
        const [user, allMixers] = await Promise.all([
            findUserById(req.user.userId),
            fetchAllMixers(),
        ]);

        const mixers = allMixers.filter(m => !m.expires_at);

        const ids = mixers.map(m => m.mixer_id);
        const market = await marketDataFor(ids);

        const livePx = ids.reduce((a, id) => { a[id] = (market[id] || {}).price; return a; }, {});
        const history = await priceHistoryFor(ids, { windowSec: 86400, bucketSec: 900, live: livePx });

        const allocsByMixer = {};
        const everyAddress = new Set();
        await Promise.all(mixers.map(async (m) => {
            try {
                const allocs = await fetchMixerAllocationsByMixerId(m.mixer_id);
                allocsByMixer[m.mixer_id] = allocs;
                allocs.forEach(a => everyAddress.add(a.token_address));
            } catch (err) {
                console.error(`Allocations failed for ${m.mixer_id}:`, err.message);
                allocsByMixer[m.mixer_id] = [];
            }
        }));

        let tokenInfo = {};
        if (everyAddress.size) {
            try {
                const info = await getTokensByAddresses([...everyAddress]);
                tokenInfo = info.reduce((a, t) => { a[t.address] = t; return a; }, {});
            } catch (err) {
                console.error('Token metadata failed:', err.message);
            }
        }

        const readiness = {};
        await Promise.all(mixers.map(async (m) => {
            try {
                const { getReadiness } = require('../functions/mixerReadiness');
                readiness[m.mixer_id] = await getReadiness(m.mixer_id, allocsByMixer[m.mixer_id] || []);
            } catch {
                readiness[m.mixer_id] = { state: 'pricing', tradeable: false, price: null };
            }
        }));

        const holderCounts = {};
        await Promise.all(mixers.map(async (m) => {
            try {
                const { getHolders } = require('../functions/holders');
                holderCounts[m.mixer_id] = (await getHolders(m.mixer_id)).length;
            } catch {
                holderCounts[m.mixer_id] = 0;
            }
        }));

        let rows = mixers.map((m) => {
            const md = market[m.mixer_id] || {};
            const tokens = (allocsByMixer[m.mixer_id] || [])
                .map(a => ({
                    address: a.token_address,
                    weight: Number(a.weight),
                    symbol: (tokenInfo[a.token_address] || {}).symbol || a.token_address.slice(0, 4),
                    name: (tokenInfo[a.token_address] || {}).name || null,
                }))
                .sort((x, y) => y.weight - x.weight);

            return {
                ...m,
                tokens,
                token_count: tokens.length,

                price: (readiness[m.mixer_id] && readiness[m.mixer_id].price != null)
                    ? readiness[m.mixer_id].price
                    : null,
                readiness: readiness[m.mixer_id] || { state: 'pricing', tradeable: false },
                changes: md.changes || { '5m': null, '1h': null, '6h': null, '24h': null },
                sparkline: (history[m.mixer_id] && history[m.mixer_id].length >= 2)
                    ? history[m.mixer_id] : (md.sparkline || []),

                sparklineSpanMs: (history[m.mixer_id] && history[m.mixer_id].length >= 2)
                    ? Math.min(86400000, Math.max(0, Date.now() - new Date(m.created_at).getTime()))
                    : (md.sparklineSpanMs || null),

                is_new: (Date.now() - new Date(m.created_at).getTime()) < 86400000,
                volumeSol: md.volumeSol || 0,
                volume24h: md.volume24h || 0,
                trades: md.trades || 0,
                trades24h: md.trades24h || 0,
                holders: holderCounts[m.mixer_id] || 0,
                lastTrade: md.lastTrade || null,
                is_mine: m.created_by === req.user.userId,
            };
        });

        const { CATEGORIES, isCategory } = require('../functions/categories');
        const categoryCounts = rows.reduce((acc, r) => {
            const key = isCategory(r.category) ? r.category : 'uncategorised';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        const category = isCategory(req.query.category) ? req.query.category : null;
        if (category) rows = rows.filter(r => r.category === category);

        const sort = SORTS[req.query.sort] ? req.query.sort : 'volume';
        rows.sort(SORTS[sort]);

        const totals = rows.reduce((acc, r) => ({
            mixers: acc.mixers + 1,
            volume24h: acc.volume24h + r.volume24h,
            trades: acc.trades + r.trades,
            holders: acc.holders + r.holders,
        }), { mixers: 0, volume24h: 0, trades: 0, holders: 0 });

        let competitions = [];
        try {
            const { allCompetitions } = require('../functions/competitions');
            const { sinceInceptionReturn } = require('../functions/sinceInception');
            const redis = require('../redis');

            const families = await allCompetitions();
            if (families.size) {
                const everyId = [...families.values()].flat().map(m => m.mixer_id);

                let priceById = {};
                try {
                    const vals = await redis.hmGet('mixer:prices', everyId);
                    everyId.forEach((id, i) => {
                        const v = vals[i];
                        if (v !== null && v !== undefined && v !== '') priceById[id] = Number(v);
                    });
                } catch { }

                const sirList = await Promise.all(everyId.map(
                    id => sinceInceptionReturn(id, priceById[id] ?? null).catch(() => null)
                ));
                const sirById = {};
                everyId.forEach((id, i) => {
                    const v = sirList[i];
                    sirById[id] = (v === null || v === undefined || !isFinite(v)) ? null : v;
                });

                competitions = [...families.entries()].map(([rootId, members]) => {
                    const ranked = members
                        .map(m => ({
                            mixer_id: m.mixer_id,
                            name: m.name,
                            ticker: m.ticker,
                            image: m.image,
                            depth: m.depth,
                            isRoot: m.mixer_id === rootId,
                            sir: sirById[m.mixer_id],
                        }))
                        .sort((a, b) => {
                            if (a.sir === null && b.sir === null) return 0;
                            if (a.sir === null) return 1;
                            if (b.sir === null) return -1;
                            return b.sir - a.sir;
                        });

                    const root = members.find(m => m.mixer_id === rootId) || members[0];
                    const leader = ranked[0] && ranked[0].sir !== null ? ranked[0] : null;

                    return {
                        rootId,
                        title: root.thesis_title || root.name,
                        rootName: root.name,
                        rootTicker: root.ticker,
                        image: root.image,
                        total: members.length,

                        maxDepth: members.reduce((d, m) => Math.max(d, m.depth), 0),
                        leader,

                        top: ranked.slice(0, 3),
                    };
                });

                competitions.sort((a, b) => {
                    if (b.total !== a.total) return b.total - a.total;
                    const x = a.leader ? a.leader.sir : -Infinity;
                    const y = b.leader ? b.leader.sir : -Infinity;
                    return y - x;
                });
            }
        } catch (err) {

            console.error('Competitions section failed:', err.message);
        }

        const { lifecycle } = require('../functions/memeMode');
        const liveMemes = allMixers.filter((m) => {
            const life = lifecycle(m);
            return life && life.state === 'live';
        }).length;

        res.render('mixers', {
            user, mixers: rows, sort, totals, competitions,
            categories: CATEGORIES, category, categoryCounts, liveMemes,
        });
    } catch (err) {
        console.error('Mixers page failed:', err);
        res.status(500).send('Could not load mixers');
    }
});

module.exports = router;
