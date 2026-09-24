
const express = require('express');
const router = express.Router();

const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { fetchAllMixers } = require('../database/mixer.repo');
const { fetchUserCostBasis, fetchTradesByUser } = require('../database/trades.repo');
const { getPosition } = require('../functions/tradeMixer');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { marketDataFor, priceHistoryFor } = require('../functions/marketData');
const { connection } = require('../functions/solanaConfig');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const redis = require('../redis');

const PALETTE = ['#8b6ff0', '#c98500', '#d55181', '#3987e5', '#d95926', '#199e70'];
const OTHER_COLOUR = '#5b616b';

function tradeSignature(t) {
    const legs = Array.isArray(t.signatures) ? t.signatures : [];
    for (const l of legs) {
        const sig = t.side === 'buy' ? (l.trade || l.swap) : (l.sol || l.redeem);
        if (typeof sig === 'string' && sig.length > 40) return sig;
    }
    return null;
}

function mixerImage(mixer, allocs) {
    if (mixer && mixer.image && String(mixer.image).trim()) return String(mixer.image).trim();
    const first = allocs && allocs[0];
    return first ? '/images/tokens/' + first.token_address : null;
}

async function buildHoldings(user, userId, byId) {
    const basis = await fetchUserCostBasis(userId);
    if (!basis.length) return [];

    let priceMap = {};
    try {
        priceMap = (await redis.hGetAll('mixer:prices')) || {};
    } catch (err) {
        console.error('Portfolio price read failed:', err.message);
    }

    const holdings = [];
    for (const b of basis) {
        const mixer = byId[b.mixerId];
        if (!mixer) continue;

        let shares = '0';
        let exists = false;
        try {
            const pos = await getPosition({ mixerState: b.mixerId, owner: user.walletAddress });
            shares = pos.shares;
            exists = pos.exists;
        } catch (err) {
            console.error(`Position read failed for ${b.mixerId}:`, err.message);
        }

        if (!exists || BigInt(shares) === 0n) continue;

        let allocs = [];
        try {
            allocs = await fetchMixerAllocationsByMixerId(b.mixerId);
        } catch (err) {
            console.error(`Allocations read failed for ${b.mixerId}:`, err.message);
        }

        const price = priceMap[b.mixerId] ? Number(priceMap[b.mixerId]) : null;

        let valueSol = null;
        try {
            const mints = allocs.map(a => a.mirror_mint || a.token_address);
            const { loadSellContext, priceSell } = require('../functions/sellMixer');
            const ctx = await loadSellContext({ mixerState: b.mixerId, mints });
            valueSol = priceSell(ctx, BigInt(shares)).solTotal;
        } catch (err) {

            console.error(`Portfolio valuation failed for ${b.mixerId}:`, err.message);
        }

        const costSol = b.boughtShares > 0
            ? b.boughtSol * (Number(shares) / b.boughtShares)
            : b.netSol;
        const realisedSol = b.boughtShares > 0 && b.soldSol > 0
            ? b.soldSol - b.boughtSol * (1 - Number(shares) / b.boughtShares)
            : null;

        const pnlSol = (valueSol != null && costSol > 0) ? valueSol - costSol : null;
        const pnlPct = (pnlSol != null && costSol > 0) ? (pnlSol / costSol) * 100 : null;

        holdings.push({
            mixer_id: b.mixerId,
            name: mixer.name,
            ticker: mixer.ticker,
            image: mixerImage(mixer, allocs),
            token_count: allocs.length,
            shares,
            cost_sol: costSol,
            realised_sol: realisedSol,
            trade_count: b.tradeCount,
            first_trade: b.firstTrade,
            last_trade: b.lastTrade,
            price,
            value_sol: valueSol,
            pnl_sol: pnlSol,
            pnl_pct: pnlPct,

            expires_at: mixer.expires_at || null,
            settled_at: mixer.settled_at || null,
        });
    }

    return holdings;
}

router.get('/', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) {
            res.clearCookie('token');
            return res.redirect('/login');
        }

        const allMixers = await fetchAllMixers();
        const byId = allMixers.reduce((a, m) => { a[m.mixer_id] = m; return a; }, {});

        const [holdings, trades] = await Promise.all([
            user.walletAddress ? buildHoldings(user, req.user.userId, byId) : [],
            fetchTradesByUser(req.user.userId, 20),
        ]);

        let solBalance = 0;
        if (user.walletAddress) {
            try {
                solBalance = (await connection.getBalance(new PublicKey(user.walletAddress))) / LAMPORTS_PER_SOL;
            } catch (err) {
                console.error('Portfolio balance failed:', err.message);
            }
        }

        let solUsd = null;
        try {
            solUsd = await require('../functions/devnetPrices').getSolUsd();
        } catch { }
        const usd = (sol) => (solUsd && sol != null && Number.isFinite(sol)) ? sol * solUsd : null;

        [...holdings]
            .sort((a, b) => new Date(a.first_trade) - new Date(b.first_trade))
            .forEach((h, i) => { h.colour = i < PALETTE.length ? PALETTE[i] : OTHER_COLOUR; });

        const ids = holdings.map(h => h.mixer_id);
        const livePrices = holdings.reduce((a, h) => { a[h.mixer_id] = h.price; return a; }, {});
        const [market, history] = await Promise.all([
            marketDataFor(ids).catch(() => ({})),
            priceHistoryFor(ids, { windowSec: 86400, bucketSec: 900, live: livePrices }),
        ]);

        const valued = holdings.filter(h => h.value_sol != null);
        const totalValue = valued.reduce((s, h) => s + h.value_sol, 0);
        const valuedCost = valued.reduce((s, h) => s + h.cost_sol, 0);
        const totalInvested = holdings.reduce((s, h) => s + h.cost_sol, 0);
        const totalPnl = valued.length ? totalValue - valuedCost : null;
        const totalPnlPct = (totalPnl != null && valuedCost > 0) ? (totalPnl / valuedCost) * 100 : null;

        for (const h of holdings) {
            const md = market[h.mixer_id] || {};
            h.change24h = md.changes && md.changes['24h'] != null ? Number(md.changes['24h']) : null;
            h.history = history[h.mixer_id] || [];

            if (h.change24h != null) {
                h.chg = h.change24h;
                h.chgLabel = '24h';
            } else if (h.history.length >= 2 && h.history[0] > 0) {
                const hist = h.history;
                h.chg = (hist[hist.length - 1] / hist[0] - 1) * 100;
                const created = new Date((byId[h.mixer_id] || {}).created_at).getTime();
                const start = Math.max(Date.now() - 86400000, Number.isFinite(created) ? created : 0);
                const spanH = Math.max(1, Math.round((Date.now() - start) / 3600000));
                h.chgLabel = spanH >= 24 ? '24h' : spanH + 'h';
            } else {
                h.chg = null;
                h.chgLabel = null;
            }
            h.value_usd = usd(h.value_sol);
            h.pnl_usd = usd(h.pnl_sol);
            h.share = (h.value_sol != null && totalValue > 0) ? (h.value_sol / totalValue) * 100 : null;
        }

        holdings.sort((a, b) => (b.value_sol ?? -1) - (a.value_sol ?? -1));

        const allocation = [];
        let other = { name: 'Other', colour: OTHER_COLOUR, share: 0, value_sol: 0, count: 0 };
        for (const h of holdings) {
            if (h.share == null) continue;
            if (h.colour === OTHER_COLOUR) {
                other.share += h.share; other.value_sol += h.value_sol; other.count += 1;
            } else {
                allocation.push({ name: h.name, ticker: h.ticker, colour: h.colour,
                    share: h.share, value_sol: h.value_sol, mixer_id: h.mixer_id });
            }
        }
        if (other.count) allocation.push(other);

        const ranked = holdings.filter(h => h.pnl_pct != null)
            .sort((a, b) => b.pnl_pct - a.pnl_pct);
        const best = ranked.length >= 2 ? ranked[0] : null;
        const worst = ranked.length >= 2 ? ranked[ranked.length - 1] : null;

        const colourById = holdings.reduce((a, h) => { a[h.mixer_id] = h.colour; return a; }, {});
        const activity = trades.map(t => {
            const m = byId[t.mixerId] || {};
            return {
                side: t.side,
                sol: t.solAmount,
                price_usd: t.priceUsd,
                created_at: t.createdAt,
                mixer_id: t.mixerId,
                name: m.name || (t.mixerId.slice(0, 4) + '…' + t.mixerId.slice(-4)),
                ticker: m.ticker || null,
                image: m.image && String(m.image).trim() ? String(m.image).trim() : null,
                colour: colourById[t.mixerId] || null,
                signature: tradeSignature(t),
            };
        });

        res.render('portfolio', {
            user,
            holdings,
            allocation,
            activity,
            solBalance,
            solUsd,
            cashUsd: usd(solBalance),
            totalInvested,
            totalValue,
            totalValueUsd: usd(totalValue),
            totalPnl,
            totalPnlUsd: usd(totalPnl),
            totalPnlPct,
            unvalued: holdings.length - valued.length,
            best,
            worst,
        });
    } catch (err) {
        console.error('Portfolio failed:', err);
        res.status(500).send('Could not load portfolio');
    }
});

router.get('/api', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        const allMixers = await fetchAllMixers();
        const byId = allMixers.reduce((a, m) => { a[m.mixer_id] = m; return a; }, {});
        const holdings = user.walletAddress ? await buildHoldings(user, req.user.userId, byId) : [];
        res.json({ ok: true, holdings });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = router;
