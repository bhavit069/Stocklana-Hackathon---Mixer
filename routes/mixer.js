const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const  { getTokenByAddress, tokenExists, getTokensByAddresses } = require("../database/token.repo");
const { addToken } = require("../functions/newToken");
const { createMixerOnChain } = require("../functions/setupMixer");
const { tokenProgramForMint } = require("../functions/solanaConfig");
const { createMixer, fetchMixerById } = require("../database/mixer.repo");
const { addMixerAllocation, fetchMixerAllocationsByMixerId } = require("../database/mixer_allocations.repo")
const timeframesWorker = require('../services/timeframes');
const redis = require("../redis");

router.get('/', checkAuthenticated, (req, res) => {
    res.send(req.user)
})

async function requireXLink(req, res, next) {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) {
            res.clearCookie('token');
            return res.redirect('/login');
        }

        if (user.xUsername) {

            req.fullUser = user;
            return next();
        }

        const msg = 'Link your X account before creating a mixer';
        if ((req.headers.accept || '').includes('application/json')) {
            return res.status(403).json({ error: msg, reason: 'x_link_required' });
        }

        const back = req.method === 'GET' ? req.originalUrl : '/mixer/create';
        return res.redirect('/settings?needsX=1&next=' + encodeURIComponent(back));
    } catch (err) {
        console.error('X link check failed:', err.message);
        return res.status(500).json({ error: 'Could not verify your account' });
    }
}

async function createSuggestions() {
    const { query } = require('../database');
    const popularP = query(
        `SELECT t.address, t.symbol, t.name, t.logo, count(a.mixer_id) AS uses
           FROM token_info t
           LEFT JOIN mixer_allocations a ON a.token_address = t.address
          WHERE t.is_verified = true AND coalesce(t.rugged, false) = false
          GROUP BY t.address, t.symbol, t.name, t.logo
          ORDER BY uses DESC, t.symbol ASC
          LIMIT 8`
    ).catch((err) => { console.error('Popular tokens failed:', err.message); return []; });

    const { getTrendingMemes } = require('../functions/trendingMemes');
    const trendingP = Promise.race([
        getTrendingMemes().catch(() => []),
        new Promise(resolve => setTimeout(() => resolve([]), 1500)),
    ]);

    const { getCatalog } = require('../functions/preIpoStocks');
    const preIpoP = Promise.race([
        getCatalog().then(c => c.tokens || []).catch(() => []),
        new Promise(resolve => setTimeout(() => resolve([]), 1500)),
    ]);

    const [popular, trending, preIpo] = await Promise.all([popularP, trendingP, preIpoP]);

    const icons = require('../functions/iconRegistry');
    for (const s of preIpo) if (s.mint && s.image) icons.remember(s.mint, s.image);

    return {
        popular: popular.map(t => ({ address: t.address, symbol: t.symbol, name: t.name, logo: t.logo, verified: true })),
        trending: (trending || []).slice(0, 10).map(t => ({
            address: t.address, symbol: t.symbol, name: t.name, logo: t.icon,
            verified: t.verified, mcap: t.mcap, change24h: t.change24h,
        })),
        preIpo: preIpo.filter(s => s.mint).map(s => ({
            address: s.mint, symbol: s.symbol, name: s.name, logo: s.image, verified: true,
            price: s.tokenPrice || s.markPrice || null,
            valuation: s.markValuation || s.valuation || null,
        })),
    };
}

router.get('/create', checkAuthenticated, requireXLink, async (req, res) => {

    const user = req.fullUser;
    const { CATEGORIES } = require('../functions/categories');
    const { MEME_DURATIONS } = require('../functions/memeMode');
    res.render('create', {
        user, categories: CATEGORIES, durations: MEME_DURATIONS, prefill: null,

        mode: req.query.type === 'meme' ? 'meme' : 'mixer',
        suggestions: await createSuggestions(),
    });
});

router.get('/:id/remix', checkAuthenticated, requireXLink, async (req, res) => {
    try {

        const user = req.fullUser;

        const parent = await fetchMixerById(req.params.id);
        if (!parent) {
            return res.status(404).render('error', {
                status: 404,
                title: 'Nothing to remix',
                message: 'No mixer exists at this address, so there is no basket to fork.',
                detail: req.params.id,
                user,
            });
        }

        const allocs = await fetchMixerAllocationsByMixerId(parent.mixer_id);
        const infos = await getTokensByAddresses(allocs.map(a => a.token_address));
        const byAddr = (infos || []).reduce((a, t) => { a[t.address] = t; return a; }, {});

        let creatorHandle = null;
        try {
            const c = await findUserById(parent.created_by);
            creatorHandle = (c && c.xUsername) || null;
        } catch { }

        const pct = allocs.map(a => ({
            address: a.token_address,
            weight: Math.round(Number(a.weight) * 1000) / 10,
            symbol: (byAddr[a.token_address] || {}).symbol || null,
            name: (byAddr[a.token_address] || {}).name || null,
            logo: (byAddr[a.token_address] || {}).logo || null,
        })).sort((x, y) => y.weight - x.weight);

        if (pct.length) {
            const sum = pct.reduce((s, t) => s + t.weight, 0);
            const residual = Math.round((100 - sum) * 10) / 10;
            if (residual !== 0) {
                pct[0].weight = Math.round((pct[0].weight + residual) * 10) / 10;
            }
        }

        const { CATEGORIES } = require('../functions/categories');
        const { MEME_DURATIONS } = require('../functions/memeMode');
        res.render('create', {
            user,
            categories: CATEGORIES,
            durations: MEME_DURATIONS,
            prefill: {
                parent: {
                    mixer_id: parent.mixer_id,
                    name: parent.name,
                    ticker: parent.ticker,
                    image: parent.image,
                    category: parent.category,
                    thesis_title: parent.thesis_title,
                    thesis: parent.thesis,
                    created_at: parent.created_at,
                    website: parent.website || null,
                    duration_ms: parent.expires_at ? (Number(parent.duration_ms) || null) : null,
                    creatorHandle,
                },
                tokens: pct,
            },

            mode: parent.expires_at ? 'meme' : 'mixer',
            suggestions: await createSuggestions(),
        });
    } catch (err) {
        console.error('Remix prefill failed:', err);
        res.status(500).send('Could not start a remix: ' + err.message);
    }
});

router.get('/:id/compare/:otherId', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) {
            res.clearCookie('token');
            return res.redirect('/login');
        }

        const [left, right] = await Promise.all([
            fetchMixerById(req.params.id),
            fetchMixerById(req.params.otherId),
        ]);
        if (!left || !right) {
            return res.status(404).render('error', {
                status: 404,
                title: 'Nothing to compare',
                message: 'One of these two mixers does not exist, so there is no comparison to draw.',
                detail: !left ? req.params.id : req.params.otherId,
                user,
            });
        }
        if (left.mixer_id === right.mixer_id) {
            return res.status(400).render('error', {
                status: 400,
                title: 'Nothing to compare',
                message: 'A mixer cannot be compared with itself. Pick two different baskets.',
                detail: null,
                user,
            });
        }

        let original = left, challenger = right;
        if (left.parent_mixer_id === right.mixer_id) { original = right; challenger = left; }
        else if (right.parent_mixer_id === left.mixer_id) { original = left; challenger = right; }

        const related = challenger.parent_mixer_id === original.mixer_id;

        const [origAllocsLive, challAllocs] = await Promise.all([
            fetchMixerAllocationsByMixerId(original.mixer_id),
            fetchMixerAllocationsByMixerId(challenger.mixer_id),
        ]);

        let origAllocs = origAllocsLive;
        let usedSnapshot = false;
        if (related && challenger.parent_snapshot) {
            try {
                const snap = typeof challenger.parent_snapshot === 'string'
                    ? JSON.parse(challenger.parent_snapshot)
                    : challenger.parent_snapshot;
                if (snap && Array.isArray(snap.allocations) && snap.allocations.length) {
                    origAllocs = snap.allocations;
                    usedSnapshot = true;
                }
            } catch (err) {
                console.error('Parent snapshot unreadable:', err.message);
            }
        }

        const { diffAllocations, summarise } = require('../functions/allocationDiff');
        const rows = diffAllocations(origAllocs, challAllocs);
        const summary = summarise(rows);

        const addrs = [...new Set(rows.map(r => r.address))];
        let tokenMap = {};
        if (addrs.length) {
            const infos = await getTokensByAddresses(addrs);
            tokenMap = (infos || []).reduce((a, t) => { a[t.address] = t; return a; }, {});
        }

        const { investedFor } = require('../functions/investedFor');
        const { marketDataFor } = require('../functions/marketData');
        const ids = [original.mixer_id, challenger.mixer_id];
        const [invested, md] = await Promise.all([investedFor(ids), marketDataFor(ids)]);

        const handles = {};
        await Promise.all([original.created_by, challenger.created_by]
            .filter(Boolean)
            .map(async (uid) => {
                try {
                    const u = await findUserById(uid);
                    if (u) handles[uid] = u.xUsername || null;
                } catch { }
            }));

        res.render('compare', {
            user, original, challenger, related, usedSnapshot,
            rows, summary, tokenMap, invested, market: md, handles,
        });
    } catch (err) {
        console.error('Compare failed:', err);
        res.status(500).send('Could not build the comparison: ' + err.message);
    }
});

router.get('/:id/live-stats', checkAuthenticated, async (req, res) => {
    const mixerId = req.params.id;
    try {
        const redis = require('../redis');

        let price = null;
        try {
            const p = await redis.hGet('mixer:prices', mixerId);
            if (p) price = Number(p);
        } catch { }

        const timeframesWorker = require('../services/timeframes');
        const { marketDataFor } = require('../functions/marketData');
        const { sinceInceptionReturn } = require('../functions/sinceInception');
        const { getHolders } = require('../functions/holders');

        const [tf, md, sir, holders] = await Promise.all([
            timeframesWorker.getMixerTimeframes(mixerId).catch(() => null),
            marketDataFor([mixerId]).then(m => m[mixerId] || {}).catch(() => ({})),
            sinceInceptionReturn(mixerId, price),
            getHolders(mixerId).then(h => h.length).catch(() => null),
        ]);

        const changes = {};
        for (const k of ['5m', '1h', '6h', '24h']) {
            let v = null;
            try { v = tf.timeframes[k].change_percent; } catch { }
            changes[k] = (v === undefined) ? null : v;
        }

        res.json({
            ok: true,
            price,
            sir,
            changes,
            volume24h: md.volume24h != null ? md.volume24h : null,
            holders,
        });
    } catch (err) {
        console.error('Live stats failed for', mixerId + ':', err.message);
        res.status(502).json({ ok: false, error: err.message });
    }
});

router.get('/token-search', checkAuthenticated, async (req, res) => {
    try {
        const { searchTokens } = require('../functions/tokenSearch');
        res.json({ ok: true, results: await searchTokens(req.query.q) });
    } catch (err) {
        console.error('Token search failed:', err.message);
        res.status(502).json({ ok: false, error: 'Token search is unavailable right now' });
    }
});

router.get('/min-trade', checkAuthenticated, async (req, res) => {
    const { minTrade } = require('../functions/tradeMinimum');
    const m = await minTrade();
    res.json({ ok: true, usd: m.usd, sol: Number(m.sol.toFixed(6)) });
});

router.get('/creation-cost', checkAuthenticated, async (req, res) => {
    const n = Math.max(1, Math.min(20, Number(req.query.tokens) || 1));
    const { isMintAddress } = require('../functions/tokenSearch');
    const mints = String(req.query.mints || '').split(',').filter(isMintAddress).slice(0, 20);
    try {
        const { creationCost } = require('../functions/creationCost');
        res.json({ ok: true, ...(await creationCost(n, mints)) });
    } catch (err) {
        console.error('Creation cost lookup failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id', checkAuthenticated, async (req, res) => {
    const { id: mixerId } = req.params;

    const user = await findUserById(req.user.userId);
    if (!user) {

        res.clearCookie('token');
        return res.redirect('/login');
    }

    if (!mixerId) {
        return res.status(400).json({ error: 'Mixer ID is required' });
    }

    try {
        const [mixer, allocations] = await Promise.all([
            fetchMixerById(mixerId),
            fetchMixerAllocationsByMixerId(mixerId)
        ]);

        if (!mixer) {

            if ((req.headers.accept || '').includes('application/json')) {
                return res.status(404).json({ error: 'Mixer not found' });
            }
            return res.status(404).render('error', {
                status: 404,
                title: 'Mixer not found',
                message: 'No mixer exists at this address. It may have been removed, or the link may be wrong.',
                detail: mixerId,
                user: await findUserById(req.user.userId).catch(() => null),
            });
        }

        const tokenAddresses = [
            ...new Set(allocations.map(a => a.token_address))
        ];

        const tokens = await getTokensByAddresses(tokenAddresses);

        const tokenMap = tokens.reduce((acc, token) => {
            acc[token.address] = token;
            return acc;
        }, {});

        const enrichedAllocations = allocations.map(allocation => ({
            ...allocation,
            token: tokenMap[allocation.token_address] || null
        }));

        let tokenPrices = {};
        let mixerPrice = null;
        try {
            const addrs = tokenAddresses;
            if (addrs.length) {
                const vals = await redis.hmGet('prices', addrs);
                addrs.forEach((a, i) => {
                    const v = vals[i];
                    if (v !== null && v !== undefined && v !== '') tokenPrices[a] = Number(v);
                });
            }
            const mp = await redis.hGet('mixer:prices', mixerId);
            if (mp) mixerPrice = Number(mp);
        } catch (err) {
            console.error('Price cache read failed:', err.message);
        }

        let stats = { volume24h: 0, volumeTotal: 0, trades: 0, holders: 0 };
        try {
            const { marketDataFor } = require('../functions/marketData');
            const md = (await marketDataFor([mixerId]))[mixerId] || {};
            stats.volume24h = md.volume24h || 0;
            stats.volumeTotal = md.volumeSol || 0;
            stats.trades = md.trades || 0;
        } catch (err) {
            console.error('Header market data failed:', err.message);
        }
        try {
            const { getHolders } = require('../functions/holders');
            stats.holders = (await getHolders(mixerId)).length;
        } catch { }

        let creatorHandle = null;
        let creatorWallet = null;
        try {
            const c = await findUserById(mixer.created_by);
            creatorHandle = (c && c.xUsername) || null;
            creatorWallet = (c && c.walletAddress) || null;
        } catch { }

        let readiness = { state: 'pricing', tradeable: false, price: null, reason: null };
        try {
            const { getReadiness } = require('../functions/mixerReadiness');
            readiness = await getReadiness(mixerId, allocations);
        } catch (err) {
            console.error('Readiness check failed:', err.message);
        }

        if (readiness.price === null) mixerPrice = null;

        const { sinceInceptionReturn, inceptionPrice } = require('../functions/sinceInception');
        const [sir, sirBase] = await Promise.all([
            sinceInceptionReturn(mixerId, mixerPrice),
            inceptionPrice(mixerId).catch(() => null),
        ]);

        let parentMixer = null;
        let competing = [];
        let remixCount = 0;
        try {
            const { fetchRemixesOf, countRemixesOf } = require('../database/mixer.repo');
            const { fetchAllocationsForMixers } = require('../database/mixer_allocations.repo');
            const { investedFor } = require('../functions/investedFor');
            const { marketDataFor } = require('../functions/marketData');

            const [children, count] = await Promise.all([
                fetchRemixesOf(mixerId),
                countRemixesOf(mixerId),
            ]);
            remixCount = count;

            if (mixer.parent_mixer_id) {
                parentMixer = await fetchMixerById(mixer.parent_mixer_id);
            }

            if (children.length) {
                const ids = children.map(c => c.mixer_id);
                const [md, childAllocs, invested] = await Promise.all([
                    marketDataFor(ids),
                    fetchAllocationsForMixers(ids),
                    investedFor(ids),
                ]);

                const childAddrs = [...new Set(childAllocs.map(a => a.token_address))];
                let childTokens = {};
                if (childAddrs.length) {
                    const infos = await getTokensByAddresses(childAddrs);
                    childTokens = (infos || []).reduce((a, t) => { a[t.address] = t; return a; }, {});
                }

                const creatorIds = [...new Set(children.map(c => c.created_by).filter(Boolean))];
                const handles = {};
                await Promise.all(creatorIds.map(async (uid) => {
                    try {
                        const u = await findUserById(uid);
                        if (u) handles[uid] = u.xUsername || null;
                    } catch { }
                }));

                const allocsByMixer = childAllocs.reduce((acc, a) => {
                    (acc[a.mixer_id] = acc[a.mixer_id] || []).push(a);
                    return acc;
                }, {});

                competing = children.map((c) => {
                    const mine = allocsByMixer[c.mixer_id] || [];
                    const cap = invested[c.mixer_id] || {};
                    const m = md[c.mixer_id] || {};
                    return {
                        ...c,
                        creatorHandle: handles[c.created_by] || null,
                        tokenCount: mine.length,
                        topTokens: mine.map(a => ({
                            address: a.token_address,
                            weight: Number(a.weight),
                            symbol: (childTokens[a.token_address] || {}).symbol
                                || a.token_address.slice(0, 4),
                        })),
                        netSol: cap.netSol || 0,
                        investedSol: cap.investedSol || 0,
                        investors: cap.investors || 0,
                        change24h: (m.changes && m.changes['24h'] !== undefined)
                            ? m.changes['24h'] : null,
                    };
                });
            }
        } catch (err) {

            console.error('Lineage lookup failed:', err.message);
        }

        let competition = null;
        try {
            const { fetchFamilyOf, fetchRootOf } = require('../database/mixer.repo');
            const { sinceInceptionReturn } = require('../functions/sinceInception');

            const rootId = await fetchRootOf(mixerId);
            const members = await fetchFamilyOf(rootId);

            if (members.length > 1) {
                const ids = members.map(m => m.mixer_id);

                let priceById = {};
                try {
                    const vals = await redis.hmGet('mixer:prices', ids);
                    ids.forEach((id, i) => {
                        const v = vals[i];
                        if (v !== null && v !== undefined && v !== '') priceById[id] = Number(v);
                    });
                } catch { }

                const sirs = await Promise.all(
                    ids.map(id => sinceInceptionReturn(id, priceById[id] ?? null).catch(() => null))
                );

                const scored = ids.map((id, i) => ({
                    id,
                    sir: (sirs[i] === null || sirs[i] === undefined || !isFinite(sirs[i]))
                        ? null : sirs[i],
                }));

                scored.sort((x, y) => {
                    if (x.sir === null && y.sir === null) return 0;
                    if (x.sir === null) return 1;
                    if (y.sir === null) return -1;
                    return y.sir - x.sir;
                });

                const idx = scored.findIndex(s => s.id === mixerId);
                const me = scored[idx] || {};
                const leader = scored[0] || {};

                competition = {
                    rank: idx >= 0 ? idx + 1 : null,
                    total: scored.length,
                    rootId,
                    isRoot: rootId === mixerId,
                    mySir: me.sir ?? null,
                    leaderId: leader.id || null,
                    leaderSir: leader.sir ?? null,
                    isLeader: idx === 0 && me.sir !== null,
                };
            }
        } catch (err) {
            console.error('Competition ranking failed:', err.message);
        }

        let performanceData = { mixerId, interval: 'tick', tokens: {} };
        try {
            const { tokenSeriesFor } = require('../functions/tokenSeries');
            const series = await tokenSeriesFor(allocations, tokenMap);
            performanceData = { mixerId, ...series };
        } catch (err) {
            console.error('Performance series failed:', err.message);
        }

        const timeframes = await timeframesWorker.getMixerTimeframes(mixerId);

        const { lifecycle } = require('../functions/memeMode');
        const memeLife = lifecycle(mixer);

        let riskScore = null;
        let riskCoverage = 0;
        let riskDetail = null;
        try {
            const { basketRisk, withLiquidity } = require('../functions/riskScore');

            riskDetail = basketRisk(await withLiquidity(enrichedAllocations));
            riskScore = riskDetail.score;
            riskCoverage = riskDetail.coverage;
        } catch (err) {
            console.error('Risk score failed:', err.message);
        }

        let fees = null;
        try {
            const { getMixerOnChain } = require('../functions/tradeMixer');
            const mints = enrichedAllocations.map(a => a.mirror_mint || a.token_address);
            const state = await getMixerOnChain({ mixerState: mixerId, mints });
            if (state && state.trade_fee_bps != null) {
                fees = {
                    tradeFeeBps: Number(state.trade_fee_bps),
                    creatorShareBps: Number(state.creator_fee_share_bps),
                };
            }
        } catch (err) {
            console.error('On-chain fee read failed:', err.message);
        }

        res.render('chart', {
            user,
            mixer,
            allocations: enrichedAllocations,
            performance: performanceData,
            tokenPrices,
            mixerPrice,
            sir,
            sirBase,
            stats,
            creatorHandle,
            readiness,
            parentMixer,
            competing,
            remixCount,
            competition,
            memeLife,
            riskScore,
            riskCoverage,
            riskDetail,
            fees,
            creatorWallet,
            timeframes: timeframes || {
                    timeframes: {
                        '5m': { change_formatted: '—', change_percent: 0 },
                        '1h': { change_formatted: '—', change_percent: 0 },
                        '6h': { change_formatted: '—', change_percent: 0 },
                        '24h': { change_formatted: '—', change_percent: 0 }
                    }
                }

        });

    } catch (err) {
        console.error('Error fetching mixer data:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

const MAX_TOKENS = 10;
const MIN_TOKENS = 2;
const MAX_NAME = 64;

function weightVerification(vaults, epsilon = 1e-9) {
  const total = vaults.reduce((sum, v) => sum + v.weight, 0);
  return Math.abs(total - 1) < epsilon;
}

router.post('/create', checkAuthenticated, requireXLink, async (req, res) => {

    let index_info = {
        name: req.body.name ? req.body.name.trim() : "",
        ticker: req.body.ticker ? req.body.ticker.trim().toUpperCase() : "",
        image: req.body.logo ? req.body.logo.trim() : "",
        description: req.body.description ? req.body.description.trim() : "",

        category: require('../functions/categories').normalise(req.body.category),
        thesis_title: req.body.thesisTitle ? String(req.body.thesisTitle).trim() : "",
        thesis: req.body.thesis ? String(req.body.thesis).trim() : "",
        counter_thesis: req.body.counterThesis ? String(req.body.counterThesis).trim() : "",

        initial_price: null,
    }

    if (!Array.isArray(req.body.tokens) || req.body.tokens.length < MIN_TOKENS) {
        return res.status(400).json({ error: 'A mixer needs at least ' + MIN_TOKENS + ' tokens' });
    }

    if (req.body.tokens.length > MAX_TOKENS) {
        return res.status(400).json({
            error: `A mixer can hold at most ${MAX_TOKENS} tokens (you selected ${req.body.tokens.length})`,
        });
    }
    if (!index_info.name) {
        return res.status(400).json({ error: 'Mixer name is required' });
    }

    if (index_info.name.length > MAX_NAME) {
        return res.status(400).json({
            error: `Mixer name must be ${MAX_NAME} characters or fewer`,
        });
    }
    if (!index_info.ticker || index_info.ticker.length > 10) {
        return res.status(400).json({ error: 'Ticker is required and must be 10 characters or fewer' });
    }
    if (index_info.description.length > 1000) {
        return res.status(400).json({ error: 'Description must be 1000 characters or fewer' });
    }
    if (index_info.thesis_title.length > 120) {
        return res.status(400).json({ error: 'Thesis title must be 120 characters or fewer' });
    }
    if (index_info.thesis.length > 5000) {
        return res.status(400).json({ error: 'Thesis must be 5000 characters or fewer' });
    }
    if (index_info.counter_thesis.length > 2000) {
        return res.status(400).json({ error: 'Counter-thesis must be 2000 characters or fewer' });
    }

    {
        const { normaliseWebsite } = require('../functions/website');
        const site = normaliseWebsite(req.body.website);
        if (!site.ok) return res.status(400).json({ error: site.error });
        index_info.website = site.value;
    }
    if (weightVerification(req.body.tokens) == false) {
        return res.status(400).json({ error: "Weights don't add up to 1" });
    }

    {
        const opening = Number(req.body.initialInvestment);
        if (Number.isFinite(opening) && opening > 0) {
            const { belowMinimum } = require('../functions/tradeMinimum');
            const low = await belowMinimum(opening, 'opening buy');
            if (low) return res.status(400).json(low);
        }
    }

    let parent = null;
    if (req.body.parentMixerId) {
        try {
            parent = await fetchMixerById(String(req.body.parentMixerId).trim());
        } catch (err) {
            console.error('Parent lookup failed:', err.message);
        }
        if (!parent) {
            return res.status(400).json({ error: 'The mixer this remixes could not be found' });
        }
    }

    let parentSnapshot = null;
    if (parent) {
        try {
            const pAllocs = await fetchMixerAllocationsByMixerId(parent.mixer_id);
            parentSnapshot = {
                captured_at: new Date().toISOString(),
                allocations: pAllocs.map(a => ({
                    token_address: a.token_address,
                    weight: Number(a.weight),
                })),
            };
        } catch (err) {

            console.error('Parent snapshot failed:', err.message);
        }
    }

    const tokens = req.body.tokens.map(t => ({
        address: t.address || t.token,
        weight: Number(t.weight)
    }));

    if (new Set(tokens.map(t => t.address)).size !== tokens.length) {
        return res.status(400).json({ error: 'Each token can only be in the basket once' });
    }

    const { compositionKey } = require('../functions/compositionKey');
    const composition = compositionKey(tokens);
    if (composition) {
        try {
            const { findByCompositionKey } = require('../database/mixer.repo');
            const twin = await findByCompositionKey(composition);
            if (twin) {
                return res.status(409).json({
                    error: 'A mixer with this exact composition already exists',
                    detail: `"${twin.name}" (${twin.ticker}) already holds these tokens at these weights.`,
                    hint: 'Change a weight, add a token, or remove one to make this basket your own.',
                    existing: { mixer_id: twin.mixer_id, name: twin.name, ticker: twin.ticker },
                });
            }
        } catch (err) {

            console.error('Duplicate check failed:', err.message);
        }
    }

    const { MEME_DURATIONS, isMemeDuration } = require('../functions/memeMode');
    let durationMs = null;
    let expiresAt = null;
    if (req.body.durationMs !== undefined && req.body.durationMs !== null && req.body.durationMs !== '') {
        durationMs = Number(req.body.durationMs);
        if (!isMemeDuration(durationMs)) {
            return res.status(400).json({
                error: 'Invalid duration',
                hint: 'Choose one of: ' + MEME_DURATIONS.map(d => d.label).join(', '),
            });
        }
        expiresAt = new Date(Date.now() + durationMs);
    }

    let livePx = {};
    {
        const { realUsdPrices } = require('../functions/mirrorRates');
        livePx = await realUsdPrices(tokens.map(t => t.address));
        const unpriced = tokens.filter(t => !livePx[t.address]);
        if (unpriced.length === tokens.length) {

            return res.status(502).json({
                error: 'Could not reach the price service',
                hint: 'Nothing was deployed. Try again in a moment.',
            });
        }
        if (unpriced.length) {
            const names = [];
            for (const t of unpriced) {
                const info = await getTokenByAddress(t.address).catch(() => null);
                names.push(info && info.symbol ? info.symbol : t.address.slice(0, 4) + '…');
            }
            return res.status(400).json({
                error: names.join(', ') + (names.length === 1 ? ' has' : ' have') + ' no reliable price',
                hint: 'Jupiter does not price tokens with too little liquidity, so a mixer holding them could never be valued. Swap it for another token.',
                unpriced: unpriced.map(t => t.address),
            });
        }
    }

    let deployPayment = null;
    let refundDeploy = async () => {};
    {
        const { creationCost } = require('../functions/creationCost');
        const { connection } = require('../functions/solanaConfig');
        const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

        const payer = await findUserById(req.user.userId);
        if (!payer || !payer.privyWalletId || !payer.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned for this account' });
        }

        const cost = await creationCost(tokens.length, tokens.map(t => t.address));
        const opening = Number(req.body.initialInvestment);
        const openingLamports = Number.isFinite(opening) && opening > 0
            ? Math.floor(opening * LAMPORTS_PER_SOL) + cost.firstBuyLamports
            : 0;
        const needed = cost.deployLamports + openingLamports;

        const balance = await connection.getBalance(new PublicKey(payer.walletAddress));
        if (balance < needed) {
            return res.status(402).json({
                error: 'Your wallet needs ' + (needed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL for this launch',
                hint: 'It holds ' + (balance / LAMPORTS_PER_SOL).toFixed(4) + ' SOL. Nothing was deployed.',
                needed_sol: needed / LAMPORTS_PER_SOL,
                balance_sol: balance / LAMPORTS_PER_SOL,
            });
        }

        const { PrivyWallet } = require('../functions/privySigner');
        const { debitBuyer } = require('../functions/swap');
        const wallet = new PrivyWallet(payer.privyWalletId, payer.walletAddress);
        try {
            const signature = await debitBuyer({ lamports: cost.deployLamports, privyWallet: wallet });
            deployPayment = { sol: cost.deployLamports / LAMPORTS_PER_SOL, signature };
        } catch (err) {
            return res.status(502).json({
                error: 'Could not take the deploy payment: ' + err.message,
                hint: 'Nothing was deployed.',
            });
        }

        refundDeploy = async (why) => {
            try {
                const { Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
                const { keypairFromEnv } = require('../functions/solanaConfig');
                const kp = keypairFromEnv('MIXER_CREATOR_SECRET_KEY');
                const tx = new Transaction().add(SystemProgram.transfer({
                    fromPubkey: kp.publicKey,
                    toPubkey: new PublicKey(payer.walletAddress),
                    lamports: cost.deployLamports,
                }));
                const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
                console.log('Refunded deploy payment (' + why + '):', sig);
                return sig;
            } catch (err) {

                console.error('DEPLOY REFUND FAILED for', payer.walletAddress, cost.deployLamports, 'lamports:', err.message);
                return null;
            }
        };
    }

    let mirrors;
    try {
        const { ensureMirrors } = require('../functions/mirrorMint');
        const { ratesForTokens } = require('../functions/mirrorRates');

        const rates = await ratesForTokens(tokens.map(t => t.address));

        const enriched = [];
        for (const t of tokens) {
            const info = await getTokenByAddress(t.address);
            if (!info) {
                await refundDeploy('unknown token');
                return res.status(400).json({
                    error: 'Unknown token: ' + t.address,
                    hint: 'Look the token up in the create form first so its details are cached.',
                });
            }
            enriched.push({ ...info, rate: rates[t.address] ?? null });
        }

        mirrors = await ensureMirrors(enriched);
    } catch (err) {
        console.error('Mirror minting failed:', err);
        const refunded = await refundDeploy('mirror minting failed');
        return res.status(502).json({
            error: 'Could not prepare devnet tokens: ' + err.message,
            hint: refunded ? 'Your deploy payment was refunded.' : 'Your deploy payment could not be refunded automatically; contact support.',
        });
    }

    const mirrorByReal = mirrors.reduce((a, m) => { a[m.real_mint] = m.mirror_mint; return a; }, {});
    const chainTokens = tokens.map(t => ({ address: mirrorByReal[t.address], weight: t.weight }));

    const creatorKey = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!creatorKey) {
        return res.status(500).send(
            "MIXER_CREATOR_SECRET_KEY is not configured -- cannot deploy on chain."
        );
    }

    let contract;
    try {
        contract = await createMixerOnChain({
            tokens: chainTokens,
            creator: req.user.userId,
            mixer_name: index_info.name,
            mixer_ticker: index_info.ticker,
            creatorWalletKey: creatorKey,
            treasury: process.env.MIXER_TREASURY_WALLET
        });
    } catch (err) {
        console.error("On-chain mixer creation failed:", err);

        const refunded = await refundDeploy('on-chain deploy failed');
        return res.status(502).json({
            error: 'On-chain mixer creation failed: ' + err.message,
            hint: refunded ? 'Your deploy payment was refunded.' : 'Your deploy payment could not be refunded automatically; contact support.',
        });
    }

    try {
        const created = await createMixer({
            mixer_id: contract.mixer_state,
            created_by: req.user.userId,
            name: index_info.name,
            ticker: index_info.ticker,
            image: index_info.image,
            description: index_info.description,
            category: index_info.category,
            thesis_title: index_info.thesis_title,
            thesis: index_info.thesis,
            parent_mixer_id: parent ? parent.mixer_id : null,
            counter_thesis: index_info.counter_thesis,
            parent_name: parent ? parent.name : null,
            parent_ticker: parent ? parent.ticker : null,
            parent_snapshot: parentSnapshot,
            composition_key: composition,
            expires_at: expiresAt,
            duration_ms: durationMs,
            website: index_info.website,
            initial_price: index_info.initial_price,
            mixer_authority_pda: contract.mixer_authority
        });
        console.log("MIXER CREATED IN DB:", created.mixer_id);
    } catch (err) {
        console.error('DB insert failed AFTER successful on-chain deploy:', err);
        return res.status(500).json({
            error: 'The mixer deployed on chain but could not be saved: ' + err.message,
            mixer_state: contract.mixer_state,
            hint: 'The on-chain mixer exists at the address above but is not listed. Quote it when reporting this.',
        });
    }

    try {
        const { addToWatchlist } = require('../database/watcher.repo');
        for (const t of tokens) await addToWatchlist(t.address);
    } catch (err) {

        console.error('Could not watchlist mixer tokens:', err.message);
    }

    const realByMirror = mirrors.reduce((a, m) => { a[m.mirror_mint] = m.real_mint; return a; }, {});

    let inceptionPx = {};
    try {
        const addrs = tokens.map(t => t.address);
        const vals = await redis.hmGet('prices', addrs);
        addrs.forEach((a, i) => {
            const n = Number(vals[i]);
            if (Number.isFinite(n) && n > 0) inceptionPx[a] = n;

            else if (livePx[a]) inceptionPx[a] = livePx[a];
        });
    } catch (err) {

        console.error('Could not capture inception prices:', err.message);
    }

    for (let i = 0; i < contract.vaults.length; i++) {
        let vault = contract.vaults[i];
        const real = realByMirror[vault.address] || vault.address;
        await addMixerAllocation({
            mixer_id: contract.mixer_state,
            token_address: real,
            mirror_mint: vault.address,
            vault_pda: vault.vault,
            weight: vault.weight,
            inception_price: inceptionPx[real] ?? null
        })
    }

    let initialBuy = null;
    const wanted = Number(req.body.initialInvestment);
    if (Number.isFinite(wanted) && wanted > 0) {
        try {
            const creator = await findUserById(req.user.userId);
            if (!creator || !creator.privyWalletId || !creator.walletAddress) {
                initialBuy = { ok: false, error: 'No wallet provisioned for this account' };
            } else {
                const { PrivyWallet } = require('../functions/privySigner');
                const { purchaseMixer } = require('../functions/purchaseMixer');
                const { recordTrade } = require('../database/trades.repo');

                const wallet = new PrivyWallet(creator.privyWalletId, creator.walletAddress);
                const mints = contract.vaults.map(v => v.address);

                const bought = await purchaseMixer({
                    mixerState: contract.mixer_state,
                    solAmount: wanted,
                    mints,
                    privyWallet: wallet,
                });

                try {

                    const { getMixerPriceUsd } = require('../functions/mixerPrice');
                    const openPrice = await getMixerPriceUsd(contract.mixer_state);

                    await recordTrade({
                        userId: req.user.userId,
                        mixerId: contract.mixer_state,
                        wallet: creator.walletAddress,
                        side: 'buy',
                        solAmount: wanted,
                        sharesDelta: bought.shares,
                        sharesAfter: bought.shares,
                        priceUsd: openPrice,
                        signatures: bought.legs.map(l => ({
                            mint: l.mint, swap: l.swap_signature, trade: l.trade_signature,
                        })),
                    });
                } catch (err) {
                    console.error('Could not record opening buy:', err.message);
                }

                initialBuy = { ok: true, sol: wanted, shares: bought.shares, legs: bought.legs.length };
            }
        } catch (err) {
            console.error('Opening buy failed:', err.message);
            initialBuy = { ok: false, error: err.message };
        }
    }

    res.json({
        ok: true,
        initial_buy: initialBuy,
        deploy_payment: deployPayment,
        mixer_state: contract.mixer_state,
        mixer_authority: contract.mixer_authority,
        treasury: contract.treasury,
        trade_fee_bps: contract.trade_fee_bps,
        creator_fee_share_bps: contract.creator_fee_share_bps,
        vaults: contract.vaults,
        mirrors: mirrors.map(m => ({
            real_mint: m.real_mint, mirror_mint: m.mirror_mint,
            symbol: m.symbol, name: m.name, created: m.created,
        })),
        explorer: `https://explorer.solana.com/address/${contract.mixer_state}?cluster=devnet`,
        signatures: contract.signatures
    })
})

router.put('/token-info', checkAuthenticated, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const { isMintAddress } = require('../functions/tokenSearch');
    if (!isMintAddress(token)) {
        return res.status(400).json({ error: 'That is not a valid token address' });
    }
    try {
        const info = (await tokenExists(token)) ? await getTokenByAddress(token) : await addToken(token);
        if (!info) return res.status(404).json({ error: 'No token was found at that address' });

        let priceable = null;
        try {

            const SOL = 'So11111111111111111111111111111111111111112';
            const { realUsdPrices } = require('../functions/mirrorRates');
            const px = await realUsdPrices([...new Set([token, SOL])]);
            if (px[SOL]) priceable = !!px[token];
        } catch { }

        return res.json({ ...info, priceable });
    } catch (err) {
        console.error('Token lookup failed for', token + ':', err.message);
        return res.status(502).json({ error: 'Could not look that token up right now' });
    }
});

router.get("/:id/token-performance", async (req, res) => {
  const { id: mixerId } = req.params;

  try {

    const mixer = await fetchMixerById(mixerId);
    if (!mixer) {
      return res.status(404).json({ error: "Mixer not found" });
    }

    const allocations = await fetchMixerAllocationsByMixerId(mixerId);

    if (!Array.isArray(allocations) || allocations.length === 0) {
      return res.json({
        mixerId,
        interval: "5m",
        windowHours: 72,
        tokens: {}
      });
    }

    const tokenAddresses = allocations.map(a => a.token_address);

    const tokenInfos = await getTokensByAddresses(tokenAddresses);

    const tokenInfoMap = {};
    for (const t of tokenInfos || []) {
      tokenInfoMap[t.address] = t;
    }

    let response = { mixerId, interval: 'tick', tokens: {} };
    try {
      const { tokenSeriesFor } = require('../functions/tokenSeries');
      const series = await tokenSeriesFor(allocations, tokenInfoMap);
      response = { mixerId, ...series };
    } catch (err) {
      console.error('Performance series failed:', err.message);
    }

    res.render('tokenPerformance', {
        performance: response
    });

  } catch (err) {
    console.error("token-performance error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
