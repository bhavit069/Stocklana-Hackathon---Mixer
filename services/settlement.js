require('dotenv').config({ quiet: true });

const {
    fetchExpiredUnsettled,
    markSettled,
} = require('../database/mixer.repo');
const { fetchMixerAllocationsByMixerId } = require('../database/mixer_allocations.repo');
const { getHolders, invalidate: invalidateHolders } = require('../functions/holders');
const { sellMixer } = require('../functions/sellMixer');
const { PrivyWallet } = require('../functions/privySigner');
const { recordTrade } = require('../database/trades.repo');
const { getMixerPriceUsd } = require('../functions/mixerPrice');
const { query } = require('../database');

const TICK_MS = Number(process.env.SETTLEMENT_TICK_MS || 60_000);

const MAX_PER_TICK = Number(process.env.SETTLEMENT_MAX_PER_TICK || 3);

let running = false;
let timer = null;

async function walletsFor(addresses) {
    if (!addresses.length) return {};
    try {
        const rows = await query(
            `SELECT user_id, wallet_address, privy_wallet_id
             FROM users WHERE wallet_address = ANY($1)`,
            [addresses]
        );
        return rows.reduce((a, r) => {
            a[r.wallet_address] = { userId: r.user_id, walletId: r.privy_wallet_id };
            return a;
        }, {});
    } catch (err) {
        console.error('[settlement] wallet lookup failed:', err.message);
        return {};
    }
}

async function settleMixer(mixer) {
    const mixerId = mixer.mixer_id;
    console.log(`[settlement] settling ${mixer.ticker} (${mixerId})`);

    const allocs = await fetchMixerAllocationsByMixerId(mixerId);
    const mints = allocs.map(a => a.mirror_mint || a.token_address);

    const holders = await getHolders(mixerId, { force: true });
    if (!holders.length) {
        console.log(`[settlement] ${mixer.ticker}: no holders, closing`);
        await markSettled(mixerId);
        return { ok: true, paid: 0, failed: 0, skipped: 0 };
    }

    try {
        const { getMixerOnChain } = require('../functions/tradeMixer');
        const state = await getMixerOnChain({ mixerState: mixerId, mints });
        if (BigInt(state.total_shares) === 0n) {
            const stranded = holders.filter(h => BigInt(h.shares) > 0n).length;
            console.warn(
                `[settlement] ${mixer.ticker}: on-chain total_shares is 0 but ` +
                `${stranded} position(s) still hold shares -- unsellable, closing without payout. ` +
                `See docs/SHARE_MINTING_BUG.md.`
            );
            await markSettled(mixerId);
            return { ok: true, paid: 0, failed: 0, skipped: stranded, stranded: true };
        }
    } catch (err) {
        console.error(`[settlement] ${mixer.ticker}: share state unreadable:`, err.message);
    }

    const wallets = await walletsFor(holders.map(h => h.owner));

    let paid = 0, failed = 0, skipped = 0;

    for (const h of holders) {
        if (BigInt(h.shares) === 0n) { skipped++; continue; }

        const w = wallets[h.owner];
        if (!w || !w.walletId) {

            console.warn(`[settlement] ${mixer.ticker}: no signer for ${h.owner}, leaving position`);
            skipped++;
            continue;
        }

        try {
            const privyWallet = new PrivyWallet(w.walletId, h.owner);
            const result = await sellMixer({
                mixerState: mixerId,
                mints,
                shares: h.shares,
                privyWallet,
            });

            const solOut = Number(result.sol_returned || 0);
            const burned = result.shares_burned || '0';
            const remaining = result.shares_remaining || '0';

            try {
                await recordTrade({
                    userId: w.userId,
                    mixerId,
                    wallet: h.owner,
                    side: 'sell',
                    solAmount: solOut,
                    sharesDelta: burned,
                    sharesAfter: remaining,

                    priceUsd: await getMixerPriceUsd(mixerId, { allocations: allocs }),
                    signatures: { settlement: true, legs: result.legs || [] },
                });
            } catch (err) {
                console.error(`[settlement] trade log failed for ${h.owner}:`, err.message);
            }

            if (BigInt(remaining) > 0n) {
                failed++;
                console.warn(`[settlement] ${mixer.ticker}: ${h.owner.slice(0, 8)} only partly sold, ${remaining} shares left`);
                continue;
            }

            paid++;
            console.log(`[settlement] ${mixer.ticker}: paid ${h.owner.slice(0, 8)} ${solOut.toFixed(6)} SOL`);
        } catch (err) {
            failed++;
            console.error(`[settlement] ${mixer.ticker}: sale failed for ${h.owner.slice(0, 8)}:`, err.message);
        }
    }

    invalidateHolders(mixerId);

    if (failed === 0) {
        await markSettled(mixerId);
        console.log(`[settlement] ${mixer.ticker}: settled (${paid} paid, ${skipped} skipped)`);
        return { ok: true, paid, failed, skipped };
    }

    console.warn(`[settlement] ${mixer.ticker}: ${failed} sale(s) failed, will retry next tick`);
    return { ok: false, paid, failed, skipped };
}

async function runOnce() {
    if (running) return { skipped: 'already running' };
    running = true;
    try {
        const due = await fetchExpiredUnsettled();
        if (!due.length) return { due: 0 };

        console.log(`[settlement] ${due.length} mixer(s) due`);
        const batch = due.slice(0, MAX_PER_TICK);
        const results = [];
        for (const m of batch) {
            try {
                results.push({ mixer: m.ticker, ...(await settleMixer(m)) });
            } catch (err) {
                console.error(`[settlement] ${m.ticker} failed:`, err.message);
                results.push({ mixer: m.ticker, ok: false, error: err.message });
            }
        }
        return { due: due.length, processed: batch.length, results };
    } catch (err) {
        console.error('[settlement] tick failed:', err.message);
        return { error: err.message };
    } finally {
        running = false;
    }
}

function start() {
    if (timer) return;
    timer = setInterval(() => { runOnce().catch(() => {}); }, TICK_MS);

    console.log(`⏳ Settlement worker started (every ${Math.round(TICK_MS / 1000)}s)`);
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce, settleMixer };
