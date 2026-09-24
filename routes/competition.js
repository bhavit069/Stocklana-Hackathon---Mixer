const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { fetchMixerById, fetchFamilyOf, fetchRootOf } = require('../database/mixer.repo');
const { fetchAllocationsForMixers } = require('../database/mixer_allocations.repo');
const { getTokensByAddresses } = require('../database/token.repo');

router.get('/competition/:id', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) {
            res.clearCookie('token');
            return res.redirect('/login');
        }

        const asked = await fetchMixerById(req.params.id);
        if (!asked) {
            return res.status(404).render('error', {
                status: 404,
                title: 'No such competition',
                message: 'No mixer exists at this address, so there is no contest to show.',
                detail: req.params.id,
                user,
            });
        }

        const rootId = await fetchRootOf(asked.mixer_id);
        if (rootId !== asked.mixer_id) return res.redirect('/competition/' + rootId);

        const members = await fetchFamilyOf(rootId);
        if (!members.length) {
            return res.status(404).render('error', {
                status: 404,
                title: 'No such competition',
                message: 'The original basket for this contest no longer exists.',
                detail: rootId,
                user,
            });
        }

        const root = members[0];
        const ids = members.map(m => m.mixer_id);

        const nameById = members.reduce((a, m) => { a[m.mixer_id] = m.name; return a; }, {});

        const { marketDataFor } = require('../functions/marketData');
        const { investedFor } = require('../functions/investedFor');
        const { sinceInceptionReturn } = require('../functions/sinceInception');
        const redis = require('../redis');

        const [md, invested, allocs, prices] = await Promise.all([
            marketDataFor(ids).catch(() => ({})),
            investedFor(ids).catch(() => ({})),
            fetchAllocationsForMixers(ids).catch(() => []),
            redis.hmGet('mixer:prices', ids).catch(() => []),
        ]);

        const priceById = {};
        ids.forEach((id, i) => {
            const v = prices[i];
            if (v !== null && v !== undefined && v !== '') priceById[id] = Number(v);
        });

        const sirs = await Promise.all(
            ids.map(id => sinceInceptionReturn(id, priceById[id] ?? null).catch(() => null))
        );
        const sirById = {};
        ids.forEach((id, i) => { sirById[id] = sirs[i]; });

        const addrs = [...new Set(allocs.map(a => a.token_address))];
        let tokens = {};
        if (addrs.length) {
            try {
                const infos = await getTokensByAddresses(addrs);
                tokens = (infos || []).reduce((a, t) => { a[t.address] = t; return a; }, {});
            } catch { }
        }

        const allocsByMixer = allocs.reduce((acc, a) => {
            (acc[a.mixer_id] = acc[a.mixer_id] || []).push(a);
            return acc;
        }, {});

        const creatorIds = [...new Set(members.map(m => m.created_by).filter(Boolean))];
        const handles = {};
        await Promise.all(creatorIds.map(async (uid) => {
            try {
                const u = await findUserById(uid);
                if (u) handles[uid] = u.xUsername || null;
            } catch { }
        }));

        const rows = members.map((m) => {
            const d = md[m.mixer_id] || {};
            const cap = invested[m.mixer_id] || {};
            const mine = (allocsByMixer[m.mixer_id] || [])
                .slice()
                .sort((a, b) => Number(b.weight) - Number(a.weight));

            const ch = (d.changes && d.changes['24h'] !== undefined) ? d.changes['24h'] : null;

            return {
                mixer_id: m.mixer_id,
                name: m.name,
                ticker: m.ticker,
                image: m.image,
                thesis_title: m.thesis_title,
                isRoot: m.mixer_id === rootId,

                depth: m.depth,

                parentName: m.parent_mixer_id
                    ? (nameById[m.parent_mixer_id] || m.parent_name || null)
                    : null,
                creatorHandle: handles[m.created_by] || null,
                created_at: m.created_at,
                price: priceById[m.mixer_id] ?? null,
                change24h: ch,
                sir: sirById[m.mixer_id],
                volume24h: d.volume24h ?? null,
                netSol: cap.netSol || 0,
                investedSol: cap.investedSol || 0,
                investors: cap.investors || 0,
                tokenCount: mine.length,
                topTokens: mine.slice(0, 5).map(a => ({
                    address: a.token_address,
                    weight: Number(a.weight),
                    symbol: (tokens[a.token_address] || {}).symbol
                        || a.token_address.slice(0, 4),
                })),
            };
        });

        const sortKey = (r) => (r.sir === null || r.sir === undefined || !isFinite(r.sir)) ? null : r.sir;
        rows.sort((a, b) => {
            const x = sortKey(a), y = sortKey(b);
            if (x === null && y === null) return 0;
            if (x === null) return 1;
            if (y === null) return -1;
            return y - x;
        });
        rows.forEach((r, i) => { r.rank = i + 1; });

        const totals = rows.reduce((acc, r) => {
            acc.netSol += r.netSol;
            acc.investors += r.investors;
            acc.volume24h += Number(r.volume24h || 0);
            return acc;
        }, { netSol: 0, investors: 0, volume24h: 0 });

        res.render('competition', {
            user,
            rootId,
            root,
            rows,
            totals,

            leader: rows.length && sortKey(rows[0]) !== null ? rows[0] : null,
        });
    } catch (err) {
        console.error('Competition page failed:', err);
        res.status(500).render('error', {
            status: 500,
            title: 'Could not load the competition',
            message: 'Something went wrong building this leaderboard.',
            detail: err.message ? String(err.message).slice(0, 200) : null,
            user: null,
        });
    }
});

module.exports = router;
