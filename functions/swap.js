require('dotenv').config({ quiet: true });
const {
    PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    mintTo, getOrCreateAssociatedTokenAccount, getMint,
    getAssociatedTokenAddressSync, createBurnInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');

const { connection, keypairFromBase58, tokenProgramForMint, sleep, freshBlockhash } = require('./solanaConfig');
const { sendWithPrivy } = require('./privySigner');

const PROVIDER = process.env.SWAP_PROVIDER || 'dummy';

const DEFAULT_RATE = Number(process.env.SWAP_DUMMY_RATE || 100);

function rateFor(mint) {
    const overrides = process.env.SWAP_DUMMY_RATES;
    if (overrides) {
        try {
            const map = JSON.parse(overrides);
            if (map[mint]) return Number(map[mint]);
        } catch {

        }
    }
    return DEFAULT_RATE;
}

let mirrorRateCache = null;

async function loadMirrorRates() {
    if (mirrorRateCache) return mirrorRateCache;
    try {
        const { query } = require('../database');
        const rows = await query('SELECT mirror_mint, real_mint, rate FROM mirror_mints');
        mirrorRateCache = rows.reduce((a, r) => {
            a[r.mirror_mint] = { rate: r.rate == null ? null : Number(r.rate), real: r.real_mint };
            return a;
        }, {});
    } catch (err) {

        console.error('Mirror rate lookup failed:', err.message);
        mirrorRateCache = {};
    }
    return mirrorRateCache;
}

function invalidateRates() {
    mirrorRateCache = null;
}

const SOL_PRICE_KEY = 'So11111111111111111111111111111111111111112';
const LIVE_RATE_TTL_MS = 15000;
const liveRateMemo = new Map();

async function liveMirrorRate(realMint) {
    if (!realMint) return null;

    const hit = liveRateMemo.get(realMint);
    if (hit && Date.now() - hit.at < LIVE_RATE_TTL_MS) return hit.rate;

    let rate = null;
    try {
        const redis = require('../redis');
        const [solUsd, tokenUsd] = (await redis.hmGet('prices', [SOL_PRICE_KEY, realMint])).map(Number);
        if (realMint === SOL_PRICE_KEY) rate = 1;
        else if (solUsd > 0 && tokenUsd > 0) rate = solUsd / tokenUsd;
    } catch { }

    liveRateMemo.set(realMint, { rate, at: Date.now() });
    return rate;
}

async function rateForAsync(mint) {
    const overrides = process.env.SWAP_DUMMY_RATES;
    if (overrides) {
        try {
            const map = JSON.parse(overrides);
            if (map[mint]) return Number(map[mint]);
        } catch { }
    }

    const mirrors = await loadMirrorRates();
    const m = mirrors[mint];
    if (m) {
        const live = await liveMirrorRate(m.real);
        if (live) return live;
        if (Number.isFinite(m.rate) && m.rate > 0) return m.rate;
    }

    return DEFAULT_RATE;
}

async function quote(outputMint, lamportsIn) {
    const mintPk = new PublicKey(outputMint);
    const tokenProgram = await tokenProgramForMint(mintPk);
    const mintInfo = await getMint(connection, mintPk, 'confirmed', tokenProgram);

    const rate = await rateForAsync(outputMint);
    const solIn = lamportsIn / LAMPORTS_PER_SOL;

    const outAmount = BigInt(Math.floor(solIn * rate * 10 ** mintInfo.decimals));

    return {
        inAmount: lamportsIn,
        outAmount,
        rate,
        decimals: mintInfo.decimals,
        provider: PROVIDER,
    };
}

async function executeSwap({ outputMint, lamportsIn, recipient, payerSecretKey }) {
    if (PROVIDER === 'jupiter') {
        throw new Error(
            'SWAP_PROVIDER=jupiter is not wired yet. Jupiter has no devnet liquidity; ' +
            'implement the /quote + /swap calls here when moving to mainnet.'
        );
    }

    const payer = keypairFromBase58(payerSecretKey);
    const mintPk = new PublicKey(outputMint);
    const tokenProgram = await tokenProgramForMint(mintPk);
    const mintInfo = await getMint(connection, mintPk, 'confirmed', tokenProgram);

    if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(payer.publicKey)) {
        throw new Error(
            `Dummy swap cannot mint ${outputMint}: mint authority is ` +
            `${mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : 'null'}, ` +
            `not ${payer.publicKey.toBase58()}. Use tokens created by scripts/mint-devnet-tokens.js.`
        );
    }

    const q = await quote(outputMint, lamportsIn);
    if (q.outAmount <= 0n) {
        throw new Error(`Swap output rounds to zero for ${lamportsIn} lamports into ${outputMint}`);
    }

    const ataAddress = await ensureAta(mintPk, new PublicKey(recipient), tokenProgram, payer);

    freshBlockhash();
    const signature = await mintTo(
        connection, payer, mintPk, ataAddress, payer, q.outAmount, [],
        { commitment: 'confirmed' }, tokenProgram
    );

    return {
        signature,
        outAmount: q.outAmount.toString(),
        destination: ataAddress.toBase58(),
        provider: PROVIDER,
        rate: q.rate,
    };
}

async function debitBuyer({ lamports, privyWallet, buyerSecretKey }) {
    const amount = Math.floor(Number(lamports));
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid debit amount');
    }

    const payerSecret = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!payerSecret) throw new Error('MIXER_CREATOR_SECRET_KEY is not configured');
    const counterparty = keypairFromBase58(payerSecret).publicKey;

    if (!privyWallet) {
        const buyer = keypairFromBase58(buyerSecretKey);
        const tx = new Transaction().add(SystemProgram.transfer({
            fromPubkey: buyer.publicKey,
            toPubkey: counterparty,
            lamports: amount,
        }));
        freshBlockhash();
        return sendAndConfirmTransaction(connection, tx, [buyer], { commitment: 'confirmed' });
    }

    return sendWithPrivy({
        walletId: privyWallet.walletId,
        address: privyWallet.publicKey.toBase58(),
        instructions: [SystemProgram.transfer({
            fromPubkey: privyWallet.publicKey,
            toPubkey: counterparty,
            lamports: amount,
        })],
    });
}

async function ensureAta(mintPk, ownerPk, tokenProgram, payer) {
    const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true, tokenProgram);

    const exists = await connection.getAccountInfo(ata).catch(() => null);
    if (exists) return ata;

    const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey, ata, ownerPk, mintPk, tokenProgram
        )
    );

    try {
        await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    } catch (err) {

        const now = await connection.getAccountInfo(ata).catch(() => null);
        if (!now) throw err;
    }

    return ata;
}

async function quoteToSol(inputMint, tokenAmountRaw) {

    const { decimalsForMint } = require('./solanaConfig');
    const decimals = await decimalsForMint(inputMint);

    const rate = await rateForAsync(inputMint);
    const tokens = Number(tokenAmountRaw) / 10 ** decimals;

    return {
        lamportsOut: Math.floor((tokens / rate) * LAMPORTS_PER_SOL),
        rate,
        decimals,
    };
}

async function executeSwapToSol({ inputMint, tokenAmountRaw, seller, payerSecretKey, sellerPrivyWallet }) {
    if (PROVIDER === 'jupiter') {
        throw new Error('SWAP_PROVIDER=jupiter is not wired yet for token->SOL.');
    }

    const payer = keypairFromBase58(payerSecretKey);
    const mintPk = new PublicKey(inputMint);
    const tokenProgram = await tokenProgramForMint(mintPk);
    const mintInfo = await getMint(connection, mintPk, 'confirmed', tokenProgram);

    if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(payer.publicKey)) {
        throw new Error(
            `Dummy swap cannot burn ${inputMint}: mint authority is not ${payer.publicKey.toBase58()}.`
        );
    }

    const q = await quoteToSol(inputMint, tokenAmountRaw);
    if (q.lamportsOut <= 0) {
        throw new Error(`Swap output rounds to zero SOL for ${tokenAmountRaw} of ${inputMint}`);
    }

    const sellerPk = new PublicKey(seller);
    const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, true, tokenProgram);

    if (!sellerPrivyWallet) {
        throw new Error('executeSwapToSol needs sellerPrivyWallet to authorise the burn');
    }

    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: sellerPk,
            lamports: q.lamportsOut,
        })
    );
    freshBlockhash();
    const solSignature = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: 'confirmed',
    });

    let burnSignature = null;
    try {
        burnSignature = await sendWithPrivy({
            walletId: sellerPrivyWallet.walletId,
            address: sellerPrivyWallet.publicKey.toBase58(),
            instructions: [createBurnInstruction(
                sellerAta, mintPk, sellerPk, BigInt(tokenAmountRaw), [], tokenProgram
            )],
        });
    } catch (err) {

        console.error(`Burn after payout failed for ${inputMint}:`, err.message);
    }

    return { burnSignature, solSignature, lamportsOut: q.lamportsOut, rate: q.rate };
}

module.exports = { quote, quoteToSol, executeSwap, executeSwapToSol, debitBuyer, rateFor, rateForAsync, invalidateRates, PROVIDER };
