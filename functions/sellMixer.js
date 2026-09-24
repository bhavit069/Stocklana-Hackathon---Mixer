require('dotenv').config({ quiet: true });
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddressSync } = require('@solana/spl-token');

const { connection, sleep, tokenProgramForMint } = require('./solanaConfig');
const { quoteToSol, executeSwapToSol } = require('./swap');
const { getPosition, withdrawOnChain, redeemOnChain, getMixerOnChain } = require('./tradeMixer');
const { supports } = require('./programFeatures');

const LEG_PACING_MS = Number(process.env.BUY_LEG_PACING_MS ?? 200);

async function loadSellContext({ mixerState, mints }) {

    const mode = (await supports('redeem')) ? 'redeem' : 'withdraw';
    const state = await getMixerOnChain({ mixerState, mints });
    const totalShares = BigInt(state.total_shares);
    if (totalShares === 0n) throw new Error('Mixer has no shares outstanding');

    const rated = [];
    for (const mint of mints) {
        const v = state.vaults.find(x => x.mint === mint);
        if (!v || !v.vault) continue;

        const whole = BigInt(v.total_deposited);
        if (whole === 0n) continue;

        const q = await quoteToSol(mint, whole.toString());
        rated.push({
            mint,
            deposited: whole,
            lamportsPerWholeVault: q.lamportsOut,
            decimals: q.decimals,
            rate: q.rate,
        });
    }

    return { mode, totalShares, rated };
}

async function quoteSell({ mixerState, mints, shares, context }) {
    const ctx = context || await loadSellContext({ mixerState, mints });
    return priceSell(ctx, BigInt(shares));
}

function allocateBurn(rated, order, burn, totalShares) {
    const n = order.length;
    const split = rated.map(() => 0n);
    if (n === 0 || burn <= 0n) return split;
    if (n === 1) { split[order[0]] = burn; return split; }

    const valueOf = (fractions) => {
        let running = Number(totalShares);
        let total = 0;
        for (let k = 0; k < n; k++) {
            const idx = order[k];
            const s = fractions[k] * Number(burn);
            if (s <= 0 || running <= 0) continue;
            total += rated[idx].lamportsPerWholeVault * (s / running);
            running -= s;
        }
        return total;
    };

    const build = (head) => {
        const f = [];
        let left = 1;
        for (let k = 0; k < n - 1; k++) {
            const take = left * head;
            f.push(take);
            left -= take;
        }
        f.push(left);
        return f;
    };

    let bestHead = 1 / n;
    let bestValue = -1;
    for (let step = 0, lo = 0.01, hi = 0.999; step < 3; step++) {
        const span = (hi - lo) / 40;
        for (let h = lo; h <= hi; h += span) {
            const v = valueOf(build(h));
            if (v > bestValue) { bestValue = v; bestHead = h; }
        }
        lo = Math.max(0.01, bestHead - span);
        hi = Math.min(0.999, bestHead + span);
    }

    const fractions = build(bestHead);
    let assigned = 0n;
    for (let k = 0; k < n - 1; k++) {
        const idx = order[k];
        const s = BigInt(Math.floor(fractions[k] * Number(burn)));
        split[idx] = s > 0n ? s : 0n;
        assigned += split[idx];
    }

    split[order[n - 1]] = burn - assigned;

    return split;
}

function priceSell({ mode, totalShares, rated }, burn) {
    if (!rated.length) {
        return { shares: burn.toString(), legs: [], lamportsTotal: 0, solTotal: 0, split: [] };
    }

    if (mode === 'redeem') {
        const legs = [];
        let lamportsTotal = 0;
        for (const r of rated) {
            const payout = (r.deposited * burn) / totalShares;
            if (payout === 0n) continue;
            const lamportsOut = Math.floor((Number(payout) / Number(r.deposited)) * r.lamportsPerWholeVault);
            lamportsTotal += lamportsOut;
            legs.push({
                mint: r.mint,
                shares: burn.toString(),
                tokensOut: payout.toString(),
                decimals: r.decimals,
                rate: r.rate,
                lamportsOut,
                solOut: lamportsOut / LAMPORTS_PER_SOL,
            });
        }
        return {
            shares: burn.toString(),
            legs,
            lamportsTotal,
            solTotal: lamportsTotal / LAMPORTS_PER_SOL,
            split: [],
        };
    }

    const order = rated
        .map((r, i) => i)
        .sort((a, b) => rated[b].lamportsPerWholeVault - rated[a].lamportsPerWholeVault);

    const split = allocateBurn(rated, order, burn, totalShares);

    const legs = [];
    let lamportsTotal = 0;
    let runningTotal = totalShares;

    for (const i of order) {
        const r = rated[i];
        const legShares = split[i];
        if (legShares <= 0n) continue;

        const payout = (r.deposited * legShares) / runningTotal;
        runningTotal -= legShares;
        if (payout === 0n) continue;

        const lamportsOut = Math.floor(
            (Number(payout) / Number(r.deposited)) * r.lamportsPerWholeVault
        );
        lamportsTotal += lamportsOut;

        legs.push({
            mint: r.mint,
            shares: legShares.toString(),
            tokensOut: payout.toString(),
            decimals: r.decimals,
            rate: r.rate,
            lamportsOut,
            solOut: lamportsOut / LAMPORTS_PER_SOL,
        });
    }

    return {
        shares: burn.toString(),
        legs,
        lamportsTotal,
        solTotal: lamportsTotal / LAMPORTS_PER_SOL,

        split: legs.map(l => ({ mint: l.mint, shares: l.shares })),
    };
}

async function sharesForSol({ mixerState, mints, solAmount, ownerShares, context }) {
    const owned = BigInt(ownerShares);
    if (owned === 0n) throw new Error('No shares held');

    const ctx = context || await loadSellContext({ mixerState, mints });

    const full = priceSell(ctx, owned);
    if (full.lamportsTotal <= 0) throw new Error('Position has no redeemable value');

    const wantLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    if (wantLamports >= full.lamportsTotal) {
        return { shares: owned.toString(), full: true, positionValue: full, context: ctx };
    }

    let lo = 1n;
    let hi = owned;
    let best = null;

    while (lo <= hi) {
        const mid = (lo + hi) / 2n;
        if (mid === 0n) break;

        const q = priceSell(ctx, mid);

        if (q.lamportsTotal <= wantLamports) {

            best = mid;
            lo = mid + 1n;
        } else {
            hi = mid - 1n;
        }
    }

    if (best === null) throw new Error('That SOL amount is too small to redeem any shares');

    return { shares: best.toString(), full: false, positionValue: full, context: ctx };
}

async function sellMixer({ mixerState, mints, shares, privyWallet, payerSecretKey, onProgress }) {
    const owner = privyWallet.publicKey.toBase58();
    const swapPayer = payerSecretKey || process.env.MIXER_CREATOR_SECRET_KEY;
    if (!swapPayer) throw new Error('No swap payer available (MIXER_CREATOR_SECRET_KEY)');

    const before = await getPosition({ mixerState, owner });
    const burnTotal = BigInt(shares);
    if (burnTotal === 0n) throw new Error('Nothing to sell');
    if (BigInt(before.shares) < burnTotal) throw new Error('Insufficient shares');

    const context = await loadSellContext({ mixerState, mints });
    const plan = await quoteSell({ mixerState, mints, shares: burnTotal.toString(), context });
    if (!plan.legs.length) throw new Error('Position has no redeemable value');

    if (context.mode === 'redeem') {
        return redeemAndSwap({ mixerState, mints, burnTotal, owner, privyWallet, swapPayer, onProgress, before });
    }

    const legs = [];
    let lamportsReturned = 0;

    for (const planned of plan.legs) {
        const mint = planned.mint;
        const burnHere = BigInt(planned.shares);
        if (burnHere <= 0n) continue;

        const leg = { mint, shares_burned: burnHere.toString() };

        try {
            if (onProgress) onProgress({ phase: 'redeem', mint });

            const tokenProgram = await tokenProgramForMint(new PublicKey(mint));
            const ata = getAssociatedTokenAddressSync(
                new PublicKey(mint), new PublicKey(owner), true, tokenProgram
            );

            let heldBefore = 0n;
            try {
                heldBefore = (await getAccount(connection, ata, 'confirmed', tokenProgram)).amount;
            } catch { }

            const w = await withdrawOnChain({
                mixerState, mint, shares: burnHere.toString(), privyWallet,
            });
            leg.redeem_signature = w.signature;
            await sleep(LEG_PACING_MS);

            const heldAfter = (await getAccount(connection, ata, 'confirmed', tokenProgram)).amount;
            const received = heldAfter - heldBefore;
            leg.tokens_received = received.toString();

            if (received > 0n) {
                if (onProgress) onProgress({ phase: 'swap', mint });

                const swap = await executeSwapToSol({
                    inputMint: mint,
                    tokenAmountRaw: received.toString(),
                    seller: owner,
                    payerSecretKey: swapPayer,
                    sellerPrivyWallet: privyWallet,
                });

                leg.burn_signature = swap.burnSignature;
                leg.sol_signature = swap.solSignature;
                leg.lamports_out = swap.lamportsOut;
                leg.sol_out = swap.lamportsOut / LAMPORTS_PER_SOL;
                lamportsReturned += swap.lamportsOut;
                await sleep(LEG_PACING_MS);
            } else {
                leg.note = 'redeemed zero tokens';
            }

        } catch (err) {

            console.error(`Sell leg failed (${mint}):`, err.message);
            leg.error = err.message;
            legs.push(leg);

            break;
        }

        legs.push(leg);
    }

    const after = await getPosition({ mixerState, owner });

    return {
        ok: legs.some(l => l.sol_signature),
        shares_burned: (BigInt(before.shares) - BigInt(after.shares)).toString(),
        shares_remaining: after.shares,
        lamports_returned: lamportsReturned,
        sol_returned: lamportsReturned / LAMPORTS_PER_SOL,
        legs,
    };
}

async function redeemAndSwap({ mixerState, mints, burnTotal, owner, privyWallet, swapPayer, onProgress, before }) {
    const vaultMints = [];
    const state = await getMixerOnChain({ mixerState, mints });
    for (const v of state.vaults) if (v.vault) vaultMints.push(v.mint);

    const held = async () => {
        const out = {};
        for (const mint of vaultMints) {
            const tokenProgram = await tokenProgramForMint(new PublicKey(mint));
            const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, tokenProgram);
            try { out[mint] = (await getAccount(connection, ata, 'confirmed', tokenProgram)).amount; }
            catch { out[mint] = 0n; }
        }
        return out;
    };

    if (onProgress) onProgress({ phase: 'redeem', mint: null });
    const heldBefore = await held();
    const redeemed = await redeemOnChain({
        mixerState, mints: vaultMints, shares: burnTotal.toString(), privyWallet,
    });
    const heldAfter = await held();

    const legs = [];
    let lamportsReturned = 0;
    for (const mint of vaultMints) {
        const received = heldAfter[mint] - heldBefore[mint];
        const leg = { mint, shares_burned: burnTotal.toString(), redeem_signature: redeemed.signature };
        leg.tokens_received = received.toString();

        if (received <= 0n) {
            leg.note = 'redeemed zero tokens';
            legs.push(leg);
            continue;
        }
        try {
            if (onProgress) onProgress({ phase: 'swap', mint });
            const swap = await executeSwapToSol({
                inputMint: mint,
                tokenAmountRaw: received.toString(),
                seller: owner,
                payerSecretKey: swapPayer,
                sellerPrivyWallet: privyWallet,
            });
            leg.burn_signature = swap.burnSignature;
            leg.sol_signature = swap.solSignature;
            leg.lamports_out = swap.lamportsOut;
            leg.sol_out = swap.lamportsOut / LAMPORTS_PER_SOL;
            lamportsReturned += swap.lamportsOut;
            await sleep(LEG_PACING_MS);
        } catch (err) {

            console.error(`Swap after redeem failed (${mint}):`, err.message);
            leg.error = err.message;
        }
        legs.push(leg);
    }

    const after = await getPosition({ mixerState, owner });
    return {
        ok: legs.some(l => l.sol_signature),
        shares_burned: (BigInt(before.shares) - BigInt(after.shares)).toString(),
        shares_remaining: after.shares,
        lamports_returned: lamportsReturned,
        sol_returned: lamportsReturned / LAMPORTS_PER_SOL,
        redeem_signature: redeemed.signature,
        legs,
    };
}

module.exports = { quoteSell, sharesForSol, sellMixer, loadSellContext, priceSell };
