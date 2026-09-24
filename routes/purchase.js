
const express = require('express');
const router = express.Router({ mergeParams: true });

const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { fetchMixerById } = require('../database/mixer.repo');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { planPurchase, purchaseMixer } = require('../functions/purchaseMixer');
const { getPosition, withdrawOnChain, getMixerOnChain } = require('../functions/tradeMixer');
const { quoteSell, sharesForSol, sellMixer, loadSellContext, priceSell } = require('../functions/sellMixer');
const { belowMinimum, minTrade } = require('../functions/tradeMinimum');
const { recordTrade, fetchTradesByUser, fetchTradesByMixer, fetchAvgBuyPriceUsd } = require('../database/trades.repo');
const { getHolders, getHoldersEnriched, invalidate: invalidateHolders } = require('../functions/holders');
const { getMixerStats } = require('../functions/mixerStats');
const { getMixerPriceUsd } = require('../functions/mixerPrice');
const { getTokensByAddresses } = require('../database/token.repo');
const limitRepo = require('../database/limitOrders.repo');
const redis = require('../redis');
const { PrivyWallet } = require('../functions/privySigner');
const { connection } = require('../functions/solanaConfig');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

async function loadMixer(mixerId) {
    const [mixer, allocations] = await Promise.all([
        fetchMixerById(mixerId),
        fetchMixerAllocationsByMixerId(mixerId),
    ]);
    if (!mixer) return null;

    return {
        mixer,
        mints: allocations.map(a => a.mirror_mint || a.token_address),

        realMints: allocations.map(a => a.token_address),
        allocations,
    };
}

async function symbolsForLoaded(loaded) {
    const realFor = {};
    (loaded.allocations || []).forEach(a => {
        realFor[a.mirror_mint || a.token_address] = a.token_address;
    });

    try {
        const info = await getTokensByAddresses(Object.values(realFor));
        const byReal = info.reduce((a, t) => { a[t.address] = t.symbol; return a; }, {});
        return Object.keys(realFor).reduce((a, mint) => {
            a[mint] = byReal[realFor[mint]] || mint.slice(0, 4);
            return a;
        }, {});
    } catch (err) {
        console.error('Token symbols failed:', err.message);
        return {};
    }
}

async function blockIfUntradeable(loaded) {

    try {
        const { lifecycle } = require('../functions/memeMode');
        const life = lifecycle(loaded.mixer);
        if (life && life.state !== 'live') {
            return {
                status: 409,
                body: {
                    error: life.state === 'settled'
                        ? 'This mixer has expired and holders have been paid out.'
                        : 'This mixer has expired and is being settled.',
                    reason: 'Time-limited mixers stop accepting buys at their deadline.',
                    state: life.state,
                    retryable: false,
                },
            };
        }
    } catch (err) {
        console.error('Expiry check failed:', err.message);
    }

    try {
        const { getReadiness } = require('../functions/mixerReadiness');
        const r = await getReadiness(loaded.mixer.mixer_id, loaded.allocations);

        if (!r.tradeable) {
            return {
                status: 409,
                body: {
                    error: r.state === 'unpriceable'
                        ? 'This mixer cannot be priced, so it is not tradeable.'
                        : 'This mixer is still being priced and is not tradeable yet.',
                    reason: r.reason,
                    state: r.state,
                    retryable: r.state === 'pricing',
                },
            };
        }
    } catch (err) {

        console.error('Readiness check failed:', err.message);
        return {
            status: 503,
            body: { error: 'Could not verify this mixer is tradeable. Try again shortly.' },
        };
    }
    return null;
}

router.post('/:id/quote', checkAuthenticated, async (req, res) => {
    const solAmount = Number(req.body.solAmount);
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
        return res.status(400).json({ error: 'solAmount must be greater than zero' });
    }

    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });
        if (!loaded.mints.length) {
            return res.status(409).json({ error: 'Mixer has no token allocations' });
        }

        const blocked = await blockIfUntradeable(loaded);
        if (blocked) return res.status(blocked.status).json(blocked.body);

        const plan = await planPurchase({
            mixerState: req.params.id, solAmount, mints: loaded.mints,
        });

        const low = await belowMinimum(solAmount, 'buy');
        res.json({ ok: true, plan, below_minimum: low });
    } catch (err) {
        console.error('Quote failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.post('/:id/buy', checkAuthenticated, async (req, res) => {
    const solAmount = Number(req.body.solAmount);
    if (!Number.isFinite(solAmount) || solAmount <= 0) {
        return res.status(400).json({ error: 'solAmount must be greater than zero' });
    }
    const low = await belowMinimum(solAmount, 'buy');
    if (low) return res.status(400).json(low);

    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const blocked = await blockIfUntradeable(loaded);
        if (blocked) return res.status(blocked.status).json(blocked.body);

        const user = await findUserById(req.user.userId);
        if (!user.privyWalletId || !user.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned for this account' });
        }

        const balance = await connection.getBalance(new PublicKey(user.walletAddress));
        const needed = 0.02 * LAMPORTS_PER_SOL;
        if (balance < needed) {
            return res.status(402).json({
                error: 'Insufficient SOL for transaction fees',
                balance_sol: balance / LAMPORTS_PER_SOL,
                needed_sol: needed / LAMPORTS_PER_SOL,
                wallet: user.walletAddress,
                hint: 'Fund this wallet on devnet: solana airdrop 1 ' + user.walletAddress + ' --url devnet',
            });
        }

        const privyWallet = new PrivyWallet(user.privyWalletId, user.walletAddress);

        const totalLegs = loaded.mints.length;
        let legIndex = 0;
        const emitProgress = (payload) => {
            try {
                require('../socket').getIO().emit('trade:progress', {
                    mixerId: req.params.id,
                    wallet: user.walletAddress,
                    side: 'buy',
                    totalLegs,
                    ...payload,
                });
            } catch { }
        };

        emitProgress({ phase: 'debit', legIndex: 0 });

        const result = await purchaseMixer({
            mixerState: req.params.id,
            solAmount,
            mints: loaded.mints,
            privyWallet,
            onProgress: ({ phase, mint }) => {

                if (phase === 'swap') legIndex += 1;
                emitProgress({ phase, mint, legIndex });
            },
        });

        emitProgress({ phase: 'settling', legIndex: totalLegs });

        try {

            const priceUsd = await getMixerPriceUsd(req.params.id, {
                allocations: loaded.allocations,
            });

            await recordTrade({
                userId: req.user.userId,
                mixerId: req.params.id,
                wallet: user.walletAddress,
                side: 'buy',
                solAmount,
                sharesDelta: result.shares,
                sharesAfter: result.shares,
                priceUsd,
                signatures: result.legs.map(l => ({
                    mint: l.mint, swap: l.swap_signature, trade: l.trade_signature,
                })),
            });
        } catch (err) {

            console.error('Could not record trade:', err.message);
        }

        invalidateHolders(req.params.id);
        try {
            require('../socket').getIO().emit('mixer:trade', {
                mixerId: req.params.id, side: 'buy', solAmount,
                wallet: user.walletAddress, shares: result.shares,
                signature: result.legs.length ? result.legs[0].trade_signature : null,
                ts: Date.now(),
            });
        } catch { }

        res.json(result);
    } catch (err) {
        console.error('Purchase failed:', err);
        res.status(502).json({ error: err.message, logs: err.logs || undefined });
    }
});

router.get('/:id/position', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user.walletAddress) return res.json({ exists: false, shares: '0' });

        const pos = await getPosition({
            mixerState: req.params.id, owner: user.walletAddress,
        });
        res.json(pos);
    } catch (err) {
        console.error('Position lookup failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/my-position', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user.walletAddress) return res.json({ exists: false });

        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        let valueShares = null;
        try {
            const { loadSellContext, priceSell } = require('../functions/sellMixer');
            const ctx = await loadSellContext({
                mixerState: req.params.id, mints: loaded.mints,
            });
            valueShares = (shares) => priceSell(ctx, BigInt(shares)).solTotal;
        } catch (err) {
            console.error('Position valuation failed:', err.message);
        }

        const holders = await getHoldersEnriched(req.params.id, { valueShares });
        const mine = (holders || []).find(h => h.owner === user.walletAddress);

        if (!mine || BigInt(mine.shares || '0') === 0n) {

            const closed = mine || null;
            return res.json({
                exists: false,
                everHeld: !!closed,
                boughtSol: closed ? closed.boughtSol : 0,
                soldSol: closed ? closed.soldSol : 0,
                realisedPnl: closed ? (closed.soldSol - closed.boughtSol) : null,
            });
        }

        let avgBuyPriceUsd = null;
        try {
            avgBuyPriceUsd = await fetchAvgBuyPriceUsd(req.user.userId, req.params.id);
        } catch (err) {
            console.error('Avg buy price unavailable:', err.message);
        }

        res.json({
            exists: true,
            shares: mine.shares,
            remainingSol: mine.remainingSol,
            costOfRemaining: mine.costOfRemaining,
            avgBuy: mine.avgBuy,
            avgSell: mine.avgSell,
            avgBuyPriceUsd,
            boughtSol: mine.boughtSol,
            soldSol: mine.soldSol,
            boughtShares: mine.boughtShares,
            soldShares: mine.soldShares,
            unrealisedPnl: mine.unrealisedPnl,
            unrealisedPct: mine.unrealisedPct,

            realisedPnl: mine.soldShares > 0 && mine.avgBuy != null
                ? mine.soldSol - (mine.avgBuy * mine.soldShares)
                : null,
            heldMs: mine.heldMs,
            firstTrade: mine.firstTrade,
            tradeCount: mine.tradeCount,
        });
    } catch (err) {
        console.error('My-position lookup failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.post('/:id/sell', checkAuthenticated, async (req, res) => {
    const solAmount = req.body.solAmount != null ? Number(req.body.solAmount) : null;
    const percent = req.body.percent != null ? Number(req.body.percent) : null;

    if (solAmount == null && percent == null) {
        return res.status(400).json({ error: 'Provide solAmount or percent' });
    }
    if (solAmount != null && (!Number.isFinite(solAmount) || solAmount <= 0)) {
        return res.status(400).json({ error: 'solAmount must be greater than zero' });
    }
    if (percent != null && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
        return res.status(400).json({ error: 'percent must be between 0 and 100' });
    }

    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const user = await findUserById(req.user.userId);
        if (!user.privyWalletId || !user.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned for this account' });
        }

        const pos = await getPosition({ mixerState: req.params.id, owner: user.walletAddress });
        if (!pos.exists || BigInt(pos.shares) === 0n) {
            return res.status(409).json({ error: 'You have no position in this mixer' });
        }

        let shares;
        if (solAmount != null) {
            const conv = await sharesForSol({
                mixerState: req.params.id, mints: loaded.mints,
                solAmount, ownerShares: pos.shares,
            });
            shares = conv.shares;
        } else {
            shares = (BigInt(pos.shares) * BigInt(Math.round(percent * 100)) / 10000n).toString();
            if (BigInt(shares) === 0n) {
                return res.status(400).json({ error: 'That percentage rounds to zero' });
            }
        }

        {
            const held = BigInt(pos.shares);
            if (BigInt(shares) < held && (held - BigInt(shares)) * 200n <= held) {
                shares = held.toString();
            }
        }

        if (BigInt(shares) < BigInt(pos.shares)) {
            let value = solAmount;
            if (value == null) {
                const ctx = await loadSellContext({ mixerState: req.params.id, mints: loaded.mints });
                value = priceSell(ctx, BigInt(shares)).solTotal;
            }
            const low = await belowMinimum(value, 'sell');
            if (low) {
                return res.status(400).json({ ...low, hint: 'You can always sell your whole position.' });
            }
        }

        const privyWallet = new PrivyWallet(user.privyWalletId, user.walletAddress);

        const totalLegs = loaded.mints.length;
        let legIndex = 0;
        const emitProgress = (payload) => {
            try {
                require('../socket').getIO().emit('trade:progress', {
                    mixerId: req.params.id,
                    wallet: user.walletAddress,
                    side: 'sell',
                    totalLegs,
                    ...payload,
                });
            } catch { }
        };

        const result = await sellMixer({
            mixerState: req.params.id,
            mints: loaded.mints,
            shares,
            privyWallet,
            onProgress: ({ phase, mint }) => {

                if (phase === 'redeem') legIndex += 1;
                emitProgress({ phase, mint, legIndex });
            },
        });

        emitProgress({ phase: 'settling', legIndex: totalLegs });

        if (BigInt(result.shares_burned) > 0n) {
            try {
                const priceUsd = await getMixerPriceUsd(req.params.id, {
                    allocations: loaded.allocations,
                });

                await recordTrade({
                    userId: req.user.userId,
                    mixerId: req.params.id,
                    wallet: user.walletAddress,
                    side: 'sell',

                    solAmount: result.sol_returned,
                    sharesDelta: result.shares_burned,
                    sharesAfter: result.shares_remaining,
                    priceUsd,
                    signatures: result.legs.map(l => ({
                        mint: l.mint, redeem: l.redeem_signature, sol: l.sol_signature,
                    })),
                });
            } catch (err) {
                console.error('Could not record sell:', err.message);
            }
        }

        invalidateHolders(req.params.id);
        try {
            require('../socket').getIO().emit('mixer:trade', {
                mixerId: req.params.id, side: 'sell',
                solAmount: result.sol_returned,
                wallet: user.walletAddress, shares: result.shares_burned,
                signature: (result.legs.find(l => l.sol_signature) || {}).sol_signature || null,
                ts: Date.now(),
            });
        } catch { }

        res.json(result);
    } catch (err) {
        console.error('Sell failed:', err);
        res.status(502).json({ error: err.message, logs: err.logs || undefined });
    }
});

router.get('/:id/value', checkAuthenticated, async (req, res) => {
    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const user = await findUserById(req.user.userId);
        if (!user.walletAddress) return res.json({ exists: false, shares: '0', solValue: 0 });

        const pos = await getPosition({ mixerState: req.params.id, owner: user.walletAddress });
        if (!pos.exists || BigInt(pos.shares) === 0n) {
            return res.json({ exists: false, shares: '0', solValue: 0 });
        }

        const { loadSellContext } = require('../functions/sellMixer');
        const ctx = await loadSellContext({
            mixerState: req.params.id, mints: loaded.mints,
        });

        const q = await quoteSell({
            mixerState: req.params.id, mints: loaded.mints,
            shares: pos.shares, context: ctx,
        });

        let ownershipPct = null;
        let totalShares = null;
        try {
            totalShares = String(ctx.totalShares);
            const total = BigInt(ctx.totalShares);
            if (total > 0n) {

                ownershipPct = Number((BigInt(pos.shares) * 1000000n) / total) / 10000;
            }
        } catch (err) {
            console.error('Ownership share unavailable:', err.message);
        }

        let costSol = null;
        try {
            const { query } = require('../database');
            const rows = await query(
                `SELECT
                    coalesce(sum(CASE WHEN side='buy'  THEN sol_amount   ELSE 0 END),0) AS bought_sol,
                    coalesce(sum(CASE WHEN side='buy'  THEN shares_delta ELSE 0 END),0) AS bought_shares
                 FROM mixer_trades WHERE mixer_id = $1 AND wallet = $2`,
                [req.params.id, user.walletAddress]
            );
            const boughtSol = Number(rows[0] && rows[0].bought_sol) || 0;
            const boughtShares = Number(rows[0] && rows[0].bought_shares) || 0;
            if (boughtSol > 0 && boughtShares > 0) {

                const held = Math.min(1, Number(pos.shares) / boughtShares);
                costSol = boughtSol * held;
            }
        } catch (err) {
            console.error('Cost basis unavailable:', err.message);
        }

        let solUsd = null, mixerPriceUsd = null, units = null;
        try {
            const { solUsd: getSolUsd } = require('../functions/marketTicker');
            [solUsd, mixerPriceUsd] = await Promise.all([
                getSolUsd(),
                getMixerPriceUsd(req.params.id, { allocations: loaded.allocations }),
            ]);
            if (solUsd > 0 && mixerPriceUsd > 0) {
                units = (q.solTotal * solUsd) / mixerPriceUsd;
            }
        } catch (err) {
            console.error('Unit valuation unavailable:', err.message);
        }

        res.json({
            exists: true,
            shares: pos.shares,
            solValue: q.solTotal,
            usdValue: solUsd > 0 ? q.solTotal * solUsd : null,
            units,
            solUsd,
            mixerPriceUsd,
            lamports: q.lamportsTotal,
            legs: q.legs,
            ownershipPct,
            totalShares,
            costSol,
            pnlSol: costSol != null ? q.solTotal - costSol : null,
            pnlPct: costSol > 0 ? ((q.solTotal - costSol) / costSol) * 100 : null,
        });
    } catch (err) {
        console.error('Value lookup failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.post('/:id/sell-quote', checkAuthenticated, async (req, res) => {

    const solAmount = req.body.solAmount != null ? Number(req.body.solAmount) : null;
    const percent = req.body.percent != null ? Number(req.body.percent) : null;
    if (solAmount == null && percent == null) {
        return res.status(400).json({ error: 'Provide solAmount or percent' });
    }
    if (solAmount != null && (!Number.isFinite(solAmount) || solAmount <= 0)) {
        return res.status(400).json({ error: 'solAmount must be greater than zero' });
    }
    if (percent != null && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
        return res.status(400).json({ error: 'percent must be between 0 and 100' });
    }

    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const user = await findUserById(req.user.userId);
        const pos = await getPosition({ mixerState: req.params.id, owner: user.walletAddress });
        if (!pos.exists || BigInt(pos.shares) === 0n) {
            return res.status(409).json({ error: 'You have no position in this mixer' });
        }

        let shares, full, positionSolValue, context;
        if (percent != null) {
            const { loadSellContext, priceSell } = require('../functions/sellMixer');
            context = await loadSellContext({ mixerState: req.params.id, mints: loaded.mints });
            full = percent >= 100;
            shares = full ? String(pos.shares)
                : (BigInt(pos.shares) * BigInt(Math.round(percent * 100)) / 10000n).toString();
            if (BigInt(shares) === 0n) {
                return res.status(400).json({ error: 'That amount rounds to zero' });
            }
            positionSolValue = priceSell(context, BigInt(pos.shares)).solTotal;
        } else {
            const conv = await sharesForSol({
                mixerState: req.params.id, mints: loaded.mints,
                solAmount, ownerShares: pos.shares,
            });
            ({ shares, full, context } = conv);
            positionSolValue = conv.positionValue.solTotal;
        }

        {
            const held = BigInt(pos.shares);
            if (BigInt(shares) < held && (held - BigInt(shares)) * 200n <= held) {
                shares = held.toString();
                full = true;
            }
        }

        const q = await quoteSell({
            mixerState: req.params.id, mints: loaded.mints, shares, context,
        });

        res.json({
            ok: true,
            shares,
            sellingWholePosition: full,
            positionSolValue,
            solOut: q.solTotal,
            legs: q.legs,
        });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/trades', checkAuthenticated, async (req, res) => {
    try {
        const all = await fetchTradesByUser(req.user.userId, 100);
        res.json({ ok: true, trades: all.filter(t => t.mixerId === req.params.id) });
    } catch (err) {
        console.error('Trade history failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/holders', checkAuthenticated, async (req, res) => {
    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        let valueShares = null;
        let solPerShare = null;
        try {
            const { loadSellContext, priceSell } = require('../functions/sellMixer');
            const ctx = await loadSellContext({
                mixerState: req.params.id, mints: loaded.mints,
            });

            valueShares = (shares) => priceSell(ctx, BigInt(shares)).solTotal;

            if (ctx.totalShares > 0n) {
                solPerShare = priceSell(ctx, ctx.totalShares).solTotal / Number(ctx.totalShares);
            }
        } catch (err) {
            console.error('Share valuation failed:', err.message);
        }

        const holders = await getHoldersEnriched(req.params.id, {
            valueShares, solPerShare, withBalances: true,
        });
        res.json({ ok: true, holders, count: holders.length, solPerShare });
    } catch (err) {
        console.error('Holders lookup failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/tradelog', checkAuthenticated, async (req, res) => {
    try {
        const trades = await fetchTradesByMixer(req.params.id, 40);
        res.json({
            ok: true,
            trades: trades.map(t => ({
                side: t.side,
                solAmount: t.solAmount,
                shares: t.sharesDelta,
                priceUsd: t.priceUsd,

                wallet: t.wallet ? t.wallet.slice(0, 4) + '…' + t.wallet.slice(-4) : null,

                walletFull: t.wallet || null,
                createdAt: t.createdAt,
                signature: Array.isArray(t.signatures) && t.signatures.length
                    ? (t.signatures[0].trade || t.signatures[0].withdraw || null)
                    : null,
            })),
        });
    } catch (err) {
        console.error('Trade log failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.post('/:id/limit', checkAuthenticated, async (req, res) => {
    const { side, amount, triggerPrice } = req.body;

    if (side !== 'buy' && side !== 'sell') {
        return res.status(400).json({ error: "side must be 'buy' or 'sell'" });
    }
    const amt = Number(amount);
    const trigger = Number(triggerPrice);
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'amount must be greater than zero' });
    }
    if (!Number.isFinite(trigger) || trigger <= 0) {
        return res.status(400).json({ error: 'triggerPrice must be greater than zero' });
    }
    if (side === 'sell' && amt > 100) {
        return res.status(400).json({ error: 'sell amount is a percentage (1-100)' });
    }

    if (side === 'buy') {
        const low = await belowMinimum(amt, 'buy');
        if (low) return res.status(400).json(low);
    }

    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const user = await findUserById(req.user.userId);
        if (!user.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned for this account' });
        }

        const order = await limitRepo.createOrder({
            userId: req.user.userId,
            mixerId: req.params.id,
            wallet: user.walletAddress,
            side, amount: amt, triggerPrice: trigger,
        });

        res.json({ ok: true, order });
    } catch (err) {
        console.error('Limit order failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/limit', checkAuthenticated, async (req, res) => {
    try {
        const all = await limitRepo.fetchOrdersByUser(req.user.userId, 100);
        res.json({ ok: true, orders: all.filter(o => o.mixerId === req.params.id) });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

router.delete('/:id/limit/:orderId', checkAuthenticated, async (req, res) => {
    try {
        const cancelled = await limitRepo.cancelOrder(req.params.orderId, req.user.userId);
        if (!cancelled) {
            return res.status(409).json({ error: 'Order not found, not yours, or no longer open' });
        }
        res.json({ ok: true, order: cancelled });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

router.get('/:id/info', checkAuthenticated, async (req, res) => {
    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).send('Mixer not found');

        const user = await findUserById(req.user.userId);

        const stats = await getMixerStats({
            mixerId: req.params.id,
            mixer: loaded.mixer,
            mints: loaded.mints,
        });

        const symbols = await symbolsForLoaded(loaded);

        const allocations = await fetchMixerAllocationsByMixerId(req.params.id);
        const weights = allocations.reduce((a, x) => {
            a[x.token_address] = Number(x.weight);
            return a;
        }, {});

        res.render('mixer-info', {
            user,
            stats,
            symbols,
            weights,
            isCreator: loaded.mixer.created_by === req.user.userId,
        });
    } catch (err) {
        console.error('Mixer info failed:', err);
        res.status(500).send('Could not load mixer stats: ' + err.message);
    }
});

router.get('/:id/info.json', checkAuthenticated, async (req, res) => {
    try {
        const loaded = await loadMixer(req.params.id);
        if (!loaded) return res.status(404).json({ error: 'Mixer not found' });

        const stats = await getMixerStats({
            mixerId: req.params.id,
            mixer: loaded.mixer,
            mints: loaded.mints,
        });
        res.json({ ok: true, stats });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

module.exports = router;
