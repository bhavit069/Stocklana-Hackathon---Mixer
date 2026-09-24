const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { fetchMemeMixers } = require('../database/mixer.repo');
const { fetchAllocationsForMixers } = require('../database/mixer_allocations.repo');
const { getTokensByAddresses } = require('../database/token.repo');
const { marketDataFor } = require('../functions/marketData');
const { investedFor } = require('../functions/investedFor');
const { inceptionPricesFor, closingPricesFor } = require('../functions/sinceInception');
const { getTrendingMemes } = require('../functions/trendingMemes');
const { lifecycle, describeDuration, MEME_DURATIONS } = require('../functions/memeMode');
const { query } = require('../database');

const ARCHIVE_PAGE = 12;

function shortWallet(w) {
    return w ? String(w).slice(0, 4) + '…' + String(w).slice(-4) : 'someone';
}

async function creatorsFor(userIds) {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return {};
    try {
        const rows = await query(
            `SELECT user_id, username, x_username, x_profile_picture
               FROM users WHERE user_id = ANY($1)`,
            [ids]
        );
        return rows.reduce((a, r) => {
            a[r.user_id] = {
                handle: r.x_username || null,
                name: r.x_username ? '@' + r.x_username : (r.username || 'anon'),
                avatar: r.x_profile_picture || null,
            };
            return a;
        }, {});
    } catch (err) {
        console.error('Creator lookup failed:', err.message);
        return {};
    }
}

async function heatFor(ids) {
    if (!ids.length) return {};
    try {
        const rows = await query(
            `SELECT mixer_id, count(*) AS n, coalesce(sum(sol_amount), 0) AS vol
               FROM mixer_trades
              WHERE mixer_id = ANY($1) AND created_at > now() - interval '1 hour'
              GROUP BY mixer_id`,
            [ids]
        );
        return rows.reduce((a, r) => {
            const n = Number(r.n) || 0;
            const vol = Number(r.vol) || 0;

            const level = n >= 15 || vol >= 5 ? 3 : n >= 5 || vol >= 1 ? 2 : n >= 1 ? 1 : 0;
            a[r.mixer_id] = { trades1h: n, volume1h: vol, level };
            return a;
        }, {});
    } catch (err) {
        console.error('Heat query failed:', err.message);
        return {};
    }
}

async function loadCards(userId) {
    const mixers = await fetchMemeMixers();
    const ids = mixers.map(m => m.mixer_id);
    if (!ids.length) return [];

    const [md, invested, allocs, opens, closes, heat, creators] = await Promise.all([
        marketDataFor(ids),
        investedFor(ids),
        fetchAllocationsForMixers(ids),
        inceptionPricesFor(ids),
        closingPricesFor(mixers.filter(m => lifecycle(m) && lifecycle(m).state !== 'live')),
        heatFor(ids),
        creatorsFor(mixers.map(m => m.created_by)),
    ]);

    const addrs = [...new Set(allocs.map(a => a.token_address))];
    let tokenMap = {};
    if (addrs.length) {
        try {
            const infos = await getTokensByAddresses(addrs);
            tokenMap = (infos || []).reduce((a, t) => { a[t.address] = t; return a; }, {});
        } catch (err) {
            console.error('Token metadata failed:', err.message);
        }
    }
    const allocsByMixer = allocs.reduce((acc, a) => {
        (acc[a.mixer_id] = acc[a.mixer_id] || []).push(a);
        return acc;
    }, {});

    const now = Date.now();
    return mixers.map((m) => {
        const life = lifecycle(m, now) || { state: 'live', remainingMs: 0 };
        const d = md[m.mixer_id] || {};
        const cap = invested[m.mixer_id] || {};
        const open = opens[m.mixer_id] || null;

        const mark = life.state === 'live' ? (d.price ?? null) : (closes[m.mixer_id] ?? d.price ?? null);
        const ret = open && mark ? (mark / open - 1) * 100 : null;
        const tokens = (allocsByMixer[m.mixer_id] || [])
            .map(a => ({
                address: a.token_address,
                weight: Number(a.weight),
                symbol: (tokenMap[a.token_address] || {}).symbol || a.token_address.slice(0, 4),
            }))
            .sort((x, y) => y.weight - x.weight);
        const dur = describeDuration(m.duration_ms);
        const creator = creators[m.created_by] || { name: 'anon', handle: null, avatar: null };

        return {
            id: m.mixer_id,
            name: m.name,
            ticker: m.ticker,
            image: m.image && m.image.trim() ? m.image
                : (tokens[0] ? '/images/tokens/' + tokens[0].address : null),
            creator,
            state: life.state,
            createdAt: new Date(m.created_at).getTime(),
            expiresAt: life.expiresAt || (m.expires_at ? new Date(m.expires_at).getTime() : null),
            settledAt: m.settled_at ? new Date(m.settled_at).getTime() : null,
            durationMs: Number(m.duration_ms) || null,
            durationLabel: dur ? dur.short : null,
            remainingMs: life.remainingMs || 0,
            price: mark,
            ret,
            change1h: (d.changes && d.changes['1h'] !== undefined) ? d.changes['1h'] : null,
            netSol: cap.netSol || 0,
            investedSol: cap.investedSol || 0,
            investors: cap.investors || 0,
            trades: d.trades || 0,
            lastTrade: d.lastTrade ? new Date(d.lastTrade).getTime() : null,
            heat: (heat[m.mixer_id] || { level: 0, trades1h: 0, volume1h: 0 }),
            tokens,
            isMine: m.created_by === userId,
        };
    });
}

function archiveOf(cards, filter) {
    let list = cards.filter(c => c.state !== 'live');
    if (filter === 'winners') list = list.filter(c => c.state === 'settled' && c.ret !== null && c.ret > 0);
    else if (filter === 'rekt') list = list.filter(c => c.state === 'settled' && c.ret !== null && c.ret <= 0);
    else if (filter === 'paying') list = list.filter(c => c.state === 'expired');
    return list.sort((a, b) => {
        if ((a.state === 'expired') !== (b.state === 'expired')) return a.state === 'expired' ? -1 : 1;
        return (b.settledAt || b.expiresAt || 0) - (a.settledAt || a.expiresAt || 0);
    });
}

async function feedFor(cards, me) {
    const byId = cards.reduce((a, c) => { a[c.id] = c; return a; }, {});
    const events = [];

    if (cards.length) {
        try {
            const rows = await query(
                `SELECT t.mixer_id, t.side, t.sol_amount, t.wallet, t.user_id, t.created_at
                   FROM mixer_trades t
                   JOIN mixers m ON m.mixer_id = t.mixer_id
                  WHERE m.expires_at IS NOT NULL
                  ORDER BY t.created_at DESC
                  LIMIT 25`
            );
            for (const r of rows) {
                const c = byId[r.mixer_id];
                if (!c) continue;
                events.push({
                    kind: r.side === 'sell' ? 'sell' : 'buy',
                    ts: new Date(r.created_at).getTime(),
                    mixerId: c.id, ticker: c.ticker, image: c.image,
                    sol: Number(r.sol_amount) || 0,
                    who: r.user_id === me.userId ? 'You' : shortWallet(r.wallet),
                });
            }
        } catch (err) {
            console.error('Meme feed failed:', err.message);
        }
    }

    for (const c of cards) {
        events.push({
            kind: 'launch', ts: c.createdAt, mixerId: c.id, ticker: c.ticker, image: c.image,
            who: c.isMine ? 'You' : c.creator.name, durationLabel: c.durationLabel,
        });
        if (c.state === 'settled' && c.settledAt) {
            events.push({
                kind: 'settle', ts: c.settledAt, mixerId: c.id, ticker: c.ticker, image: c.image,
                ret: c.ret,
            });
        }
    }

    return events.sort((a, b) => b.ts - a.ts).slice(0, 25);
}

function leaderboardOf(cards) {
    const by = {};
    for (const c of cards) {
        const key = c.creator.name;
        const e = by[key] = by[key] || { creator: c.creator, runs: 0, best: null, bestTicker: null, raised: 0 };
        e.runs += 1;
        e.raised += c.investedSol;
        if (c.ret !== null && (e.best === null || c.ret > e.best)) {
            e.best = c.ret;
            e.bestTicker = c.ticker;
        }
    }
    return Object.values(by)
        .sort((a, b) => ((b.best ?? -Infinity) - (a.best ?? -Infinity)) || (b.runs - a.runs))
        .slice(0, 5);
}

async function myStats(userId, cards) {
    const byId = cards.reduce((a, c) => { a[c.id] = c; return a; }, {});
    const out = { runs: 0, live: 0, closed: 0, wins: 0, pnlSol: 0, best: null, created: 0 };
    out.created = cards.filter(c => c.isMine).length;
    try {
        const rows = await query(
            `SELECT t.mixer_id,
                    coalesce(sum(t.sol_amount) FILTER (WHERE t.side = 'buy'), 0)  AS sol_in,
                    coalesce(sum(t.sol_amount) FILTER (WHERE t.side = 'sell'), 0) AS sol_out
               FROM mixer_trades t
               JOIN mixers m ON m.mixer_id = t.mixer_id
              WHERE t.user_id = $1 AND m.expires_at IS NOT NULL
              GROUP BY t.mixer_id`,
            [userId]
        );
        for (const r of rows) {
            const c = byId[r.mixer_id];
            const solIn = Number(r.sol_in) || 0;
            const solOut = Number(r.sol_out) || 0;
            if (solIn <= 0) continue;
            out.runs += 1;

            if (c && c.state === 'settled') {
                out.closed += 1;
                out.pnlSol += solOut - solIn;
                if (solOut > solIn) out.wins += 1;
                const r2 = (solOut / solIn - 1) * 100;
                if (out.best === null || r2 > out.best) out.best = r2;
            } else if (c && c.state === 'live') {
                out.live += 1;
            }
        }
    } catch (err) {
        console.error('My meme stats failed:', err.message);
    }
    out.winRate = out.closed ? Math.round((out.wins / out.closed) * 100) : null;
    out.title = out.runs >= 10 ? 'Meme lord'
        : out.runs >= 3 ? 'Certified degen'
            : out.runs >= 1 ? 'Degen in training'
                : 'Fresh wallet';
    return out;
}

router.get('/meme', checkAuthenticated, async (req, res) => {
    try {
        const me = { userId: req.user.userId };
        const [user, cards, trending] = await Promise.all([
            findUserById(req.user.userId),
            loadCards(req.user.userId),
            getTrendingMemes(),
        ]);

        const live = cards.filter(c => c.state === 'live');
        const liveIds = live.map(c => c.id);

        const ranked = live.filter(c => c.ret !== null).sort((a, b) => b.ret - a.ret);
        const king = ranked[0] || live.slice().sort((a, b) => b.netSol - a.netSol)[0] || null;

        let degens = 0;
        if (liveIds.length) {
            try {
                const r = await query(
                    `SELECT count(DISTINCT wallet) AS n FROM mixer_trades
                      WHERE side = 'buy' AND mixer_id = ANY($1)`,
                    [liveIds]
                );
                degens = Number(r[0] && r[0].n) || 0;
            } catch (err) {
                console.error('Degen count failed:', err.message);
            }
        }

        const settled = cards.filter(c => c.state === 'settled');
        const wins = settled.filter(c => c.ret !== null);
        const [feed, mine] = await Promise.all([feedFor(cards, me), myStats(req.user.userId, cards)]);
        const archive = archiveOf(cards, 'all');

        res.render('meme', {
            user,
            walletAddress: user && user.walletAddress,
            trending,
            king,
            live,
            archive: archive.slice(0, ARCHIVE_PAGE),
            archiveTotal: archive.length,
            archiveCounts: {
                all: archive.length,
                winners: archiveOf(cards, 'winners').length,
                rekt: archiveOf(cards, 'rekt').length,
                paying: archiveOf(cards, 'paying').length,
            },
            feed,
            leaders: leaderboardOf(cards),
            mine,
            durations: MEME_DURATIONS,
            stats: {
                live: live.length,
                solInPlay: live.reduce((s, c) => s + c.netSol, 0),
                degens,
                settled: settled.length,
                biggestWin: wins.length ? Math.max(...wins.map(c => c.ret)) : null,
            },
        });
    } catch (err) {
        console.error('Meme page failed:', err);
        res.status(500).send('Could not load meme mixers');
    }
});

router.get('/api/meme/archive', checkAuthenticated, async (req, res) => {
    try {
        const filter = ['all', 'winners', 'rekt', 'paying'].includes(req.query.filter) ? req.query.filter : 'all';
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const list = archiveOf(await loadCards(req.user.userId), filter);
        res.json({
            ok: true,
            total: list.length,
            items: list.slice(offset, offset + ARCHIVE_PAGE),
            next: offset + ARCHIVE_PAGE < list.length ? offset + ARCHIVE_PAGE : null,
        });
    } catch (err) {
        console.error('Meme archive failed:', err.message);
        res.status(502).json({ ok: false, error: 'Could not load finished runs' });
    }
});

router.get('/api/meme/trending', checkAuthenticated, async (req, res) => {
    try {
        res.json({ ok: true, coins: await getTrendingMemes() });
    } catch (err) {
        res.status(502).json({ ok: false, error: err.message });
    }
});

router.get('/api/meme/status', checkAuthenticated, async (req, res) => {
    try {
        const mixers = await fetchMemeMixers();
        const now = Date.now();
        res.json({
            ok: true,
            now,
            mixers: mixers.map(m => {
                const life = lifecycle(m, now);
                return {
                    mixer_id: m.mixer_id,
                    state: life ? life.state : 'live',
                    remainingMs: life ? life.remainingMs : 0,
                };
            }),
        });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = router;
