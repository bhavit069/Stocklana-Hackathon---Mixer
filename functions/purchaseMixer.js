require('dotenv').config({ quiet: true });
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { keypairFromBase58, sleep, positionPda } = require('./solanaConfig');
const { quote, quoteToSol, executeSwap } = require('./swap');
const { tradeOnChain, buyOnChain, getMixerOnChain } = require('./tradeMixer');
const { supports } = require('./programFeatures');

const SOL_FEE_BPS = Number(process.env.PURCHASE_SOL_FEE_BPS || 0);
const BPS = 10_000;

const LEG_PACING_MS = Number(process.env.BUY_LEG_PACING_MS ?? 200);

async function planPurchase({ mixerState, solAmount, mints }) {
    const lamportsTotal = Math.floor(solAmount * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamportsTotal) || lamportsTotal <= 0) {
        throw new Error('Amount must be greater than zero');
    }

    const state = await getMixerOnChain({ mixerState, mints });

    const live = state.vaults.filter(v => v.vault);
    if (!live.length) throw new Error('Mixer has no vaults on chain');

    const totalWeight = live.reduce((s, v) => s + v.weight_bps, 0);
    if (totalWeight <= 0) throw new Error('Mixer weights are all zero');

    const solFee = Math.floor(lamportsTotal * SOL_FEE_BPS / BPS);
    const investable = lamportsTotal - solFee;

    const useBuy = await supports('buy', { fresh: true });
    let basis = live.map(v => v.weight_bps / totalWeight);
    if (useBuy && BigInt(state.total_shares) > 0n) {
        const values = [];
        for (const v of live) {
            const held = BigInt(v.total_deposited || '0');
            values.push(held > 0n ? (await quoteToSol(v.mint, held.toString())).lamportsOut : 0);
        }
        const totalValue = values.reduce((a, b) => a + b, 0);
        if (totalValue > 0) basis = values.map(x => x / totalValue);
    }

    const raw = live.map((v, i) => ({ v, share: basis[i], exact: investable * basis[i] }));
    const legs = raw.map(r => ({ ...r, floor: Math.floor(r.exact) }));
    let assigned = legs.reduce((s, l) => s + l.floor, 0);
    let remainder = investable - assigned;
    legs.sort((a, b) => (b.exact - b.floor) - (a.exact - a.floor));
    for (let i = 0; i < legs.length && remainder > 0; i++, remainder--) legs[i].floor++;

    const plan = [];
    for (const leg of legs) {
        if (leg.floor <= 0) {

            plan.push({
                mint: leg.v.mint, vault: leg.v.vault, weight_bps: leg.v.weight_bps, share: leg.share,
                lamports_in: 0, sol_in: 0, expected_tokens: '0', rate: null, decimals: null,
            });
            continue;
        }
        const q = await quote(leg.v.mint, leg.floor);
        plan.push({
            mint: leg.v.mint,
            vault: leg.v.vault,
            weight_bps: leg.v.weight_bps,
            share: leg.share,
            lamports_in: leg.floor,
            sol_in: leg.floor / LAMPORTS_PER_SOL,
            expected_tokens: q.outAmount.toString(),
            rate: q.rate,
            decimals: q.decimals,
        });
    }

    if (useBuy) {
        const starved = plan.find(l => l.expected_tokens === '0' && l.share > 0);
        if (starved) throw new Error('Amount too small to buy every token in this basket');
    }

    return {
        mode: useBuy ? 'buy' : 'trade',
        sol_total: solAmount,
        lamports_total: lamportsTotal,
        sol_fee_bps: SOL_FEE_BPS,
        sol_fee_lamports: solFee,
        investable_lamports: investable,
        contract_trade_fee_bps: state.trade_fee_bps,
        creator_fee_share_bps: state.creator_fee_share_bps,
        legs: plan,

        legs_sum_lamports: plan.reduce((s, l) => s + l.lamports_in, 0),
    };
}

async function purchaseMixer({
    mixerState, solAmount, mints, buyerSecretKey, privyWallet, payerSecretKey, onProgress,
}) {
    const plan = await planPurchase({ mixerState, solAmount, mints });

    if (!privyWallet && !buyerSecretKey) {
        throw new Error('purchaseMixer needs either privyWallet or buyerSecretKey');
    }
    const buyer = privyWallet
        ? { publicKey: privyWallet.publicKey }
        : keypairFromBase58(buyerSecretKey);

    const swapPayer = payerSecretKey || process.env.MIXER_CREATOR_SECRET_KEY;
    if (!swapPayer) throw new Error('No swap payer available (MIXER_CREATOR_SECRET_KEY)');

    const { debitBuyer } = require('./swap');
    let debitSignature = null;
    try {
        debitSignature = await debitBuyer({
            lamports: plan.lamports_total,
            privyWallet,
            buyerSecretKey,
        });
    } catch (err) {

        throw new Error('Could not debit the purchase amount: ' + err.message);
    }

    if (plan.mode === 'buy') {
        return buyAllLegs({ mixerState, plan, buyer, buyerSecretKey, privyWallet, swapPayer, onProgress, debitSignature });
    }

    const legs = [];
    for (const leg of plan.legs) {
        const step = { mint: leg.mint, weight_bps: leg.weight_bps, sol_in: leg.sol_in };

        if (onProgress) onProgress({ phase: 'swap', mint: leg.mint });

        const swap = await executeSwap({
            outputMint: leg.mint,
            lamportsIn: leg.lamports_in,
            recipient: buyer.publicKey.toBase58(),
            payerSecretKey: swapPayer,
        });
        step.swap_signature = swap.signature;
        step.tokens_received = swap.outAmount;
        await sleep(LEG_PACING_MS);

        if (onProgress) onProgress({ phase: 'trade', mint: leg.mint });

        const trade = await tradeOnChain({
            mixerState,
            mint: leg.mint,
            amount: swap.outAmount,
            traderSecretKey: buyerSecretKey,
            privyWallet,
        });
        step.trade_signature = trade.signature;
        step.shares_after = trade.shares;
        step.explorer = trade.explorer;
        await sleep(LEG_PACING_MS);

        legs.push(step);
    }

    const [position] = positionPda(new PublicKey(mixerState), buyer.publicKey);

    return {
        ok: true,
        debit_signature: debitSignature,
        mixer: mixerState,
        buyer: buyer.publicKey.toBase58(),
        sol_spent: plan.sol_total,
        position: position.toBase58(),
        shares: legs.length ? legs[legs.length - 1].shares_after : '0',
        legs,
        plan,
    };
}

async function buyAllLegs({ mixerState, plan, buyer, buyerSecretKey, privyWallet, swapPayer, onProgress, debitSignature }) {
    const legs = [];
    const amounts = [];

    for (const leg of plan.legs) {
        const step = { mint: leg.mint, weight_bps: leg.weight_bps, sol_in: leg.sol_in };
        if (leg.lamports_in > 0) {
            if (onProgress) onProgress({ phase: 'swap', mint: leg.mint });
            const swap = await executeSwap({
                outputMint: leg.mint,
                lamportsIn: leg.lamports_in,
                recipient: buyer.publicKey.toBase58(),
                payerSecretKey: swapPayer,
            });
            step.swap_signature = swap.signature;
            step.tokens_received = swap.outAmount;
            amounts.push({ mint: leg.mint, amount: swap.outAmount });
            await sleep(LEG_PACING_MS);
        } else {
            amounts.push({ mint: leg.mint, amount: '0' });
        }
        legs.push(step);
    }

    if (onProgress) onProgress({ phase: 'trade', mint: null });
    const bought = await buyOnChain({
        mixerState,
        amounts,
        traderSecretKey: buyerSecretKey,
        privyWallet,
    });

    for (const step of legs) {
        step.trade_signature = bought.signature;
        step.shares_after = bought.shares;
        step.explorer = bought.explorer;
    }

    const [position] = positionPda(new PublicKey(mixerState), buyer.publicKey);

    return {
        ok: true,
        debit_signature: debitSignature,
        mixer: mixerState,
        buyer: buyer.publicKey.toBase58(),
        sol_spent: plan.sol_total,
        position: position.toBase58(),
        shares: bought.shares,
        shares_minted: bought.minted,
        legs,
        plan,
    };
}

module.exports = { planPurchase, purchaseMixer, SOL_FEE_BPS };
