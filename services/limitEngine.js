require('dotenv').config({ quiet: true });

const redis = require('../redis');
const { getIO } = require('../socket');
const {
    fetchOpenOrders, claimOrder, markFilled, markFailed,
} = require('../database/limitOrders.repo');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { findUserById } = require('../database/users.repo');
const { recordTrade } = require('../database/trades.repo');
const { purchaseMixer } = require('../functions/purchaseMixer');
const { getPosition, withdrawOnChain } = require('../functions/tradeMixer');
const { PrivyWallet } = require('../functions/privySigner');
const { invalidate: invalidateHolders } = require('../functions/holders');

const TICK_MS = Number(process.env.LIMIT_ENGINE_TICK_MS || 10_000);

let timer = null;
let running = false;
let stats = { ticks: 0, filled: 0, failed: 0, lastRun: null };

function shouldFill(order, price) {
    if (!Number.isFinite(price) || price <= 0) return false;
    return order.side === 'buy'
        ? price <= order.triggerPrice
        : price >= order.triggerPrice;
}

async function executeOrder(order, price) {
    const user = await findUserById(order.userId);
    if (!user || !user.privyWalletId || !user.walletAddress) {
        throw new Error('User has no provisioned wallet');
    }

    const allocations = await fetchMixerAllocationsByMixerId(order.mixerId);
    const mints = allocations.map(a => a.token_address);
    if (!mints.length) throw new Error('Mixer has no allocations');

    const privyWallet = new PrivyWallet(user.privyWalletId, user.walletAddress);

    if (order.side === 'buy') {
        const result = await purchaseMixer({
            mixerState: order.mixerId,
            solAmount: order.amount,
            mints,
            privyWallet,
        });

        await recordTrade({
            userId: order.userId,
            mixerId: order.mixerId,
            wallet: user.walletAddress,
            side: 'buy',
            solAmount: order.amount,
            sharesDelta: result.shares,
            sharesAfter: result.shares,
            priceUsd: price,
            signatures: result.legs.map(l => ({
                mint: l.mint, swap: l.swap_signature, trade: l.trade_signature,
            })),
        });

        return { signatures: result.legs.map(l => l.trade_signature), shares: result.shares };
    }

    const pos = await getPosition({ mixerState: order.mixerId, owner: user.walletAddress });
    if (!pos.exists || BigInt(pos.shares) === 0n) {
        throw new Error('No shares to sell');
    }

    const total = BigInt(pos.shares);
    const toBurn = total * BigInt(Math.round(order.amount * 100)) / 10000n;
    if (toBurn === 0n) throw new Error('Percentage rounds to zero shares');

    const per = toBurn / BigInt(mints.length);
    if (per === 0n) throw new Error('Amount too small to split across vaults');

    const sigs = [];
    let remaining = toBurn;
    for (let i = 0; i < mints.length; i++) {
        const amount = i === mints.length - 1 ? remaining : per;
        if (amount <= 0n) continue;
        try {
            const w = await withdrawOnChain({
                mixerState: order.mixerId, mint: mints[i],
                shares: amount.toString(), privyWallet,
            });
            sigs.push(w.signature);
            remaining -= amount;
        } catch (err) {

            console.error(`Limit sell leg failed (${mints[i]}):`, err.message);
        }
    }

    if (!sigs.length) throw new Error('Every redemption leg failed');

    const after = await getPosition({ mixerState: order.mixerId, owner: user.walletAddress });
    await recordTrade({
        userId: order.userId,
        mixerId: order.mixerId,
        wallet: user.walletAddress,
        side: 'sell',
        solAmount: 0,
        sharesDelta: (total - BigInt(after.shares)).toString(),
        sharesAfter: after.shares,
        priceUsd: price,
        signatures: sigs.map(s => ({ withdraw: s })),
    });

    return { signatures: sigs, shares: after.shares };
}

async function tick() {
    if (running) return;
    running = true;
    stats.ticks++;
    stats.lastRun = new Date().toISOString();

    try {
        const open = await fetchOpenOrders();
        if (!open.length) return;

        let prices = {};
        try {
            prices = (await redis.hGetAll('mixer:prices')) || {};
        } catch (err) {
            console.error('Limit engine price read failed:', err.message);
            return;
        }

        for (const order of open) {
            const price = Number(prices[order.mixerId]);
            if (!shouldFill(order, price)) continue;

            const claimed = await claimOrder(order.id);
            if (!claimed) continue;

            console.log(`Limit ${order.side} triggered: ${order.mixerId.slice(0, 8)}… @ $${price} (trigger $${order.triggerPrice})`);

            try {
                const out = await executeOrder(order, price);
                await markFilled(order.id, price, out.signatures);
                invalidateHolders(order.mixerId);
                stats.filled++;

                try {
                    getIO().emit('limit:filled', {
                        orderId: order.id, mixerId: order.mixerId, side: order.side,
                        price, signatures: out.signatures,
                    });
                } catch { }
            } catch (err) {
                console.error(`Limit order ${order.id} failed:`, err.message);
                await markFailed(order.id, err.message);
                stats.failed++;
            }
        }
    } catch (err) {
        console.error('Limit engine tick failed:', err.message);
    } finally {
        running = false;
    }
}

function start() {
    if (timer) return;
    console.log(`⚡ Limit order engine started (every ${TICK_MS / 1000}s)`);
    timer = setInterval(tick, TICK_MS);
    tick();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

const getStats = () => ({ ...stats, tickMs: TICK_MS, running: !!timer });

module.exports = { start, stop, tick, getStats, shouldFill };
