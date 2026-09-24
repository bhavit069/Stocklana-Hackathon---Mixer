require('dotenv').config({ quiet: true });
const {
    PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createBurnInstruction,
} = require('@solana/spl-token');

const {
    anchor, connection, keypairFromEnv, programFor, mixerAuthorityPda,
    feeVaultPda, feeLedgerPda, tokenProgramForMint, freshBlockhash, sleep,
} = require('./solanaConfig');
const { quoteToSol } = require('./swap');
const { query } = require('../database');

const SOL = LAMPORTS_PER_SOL;

let platformKp = null;
function platform() {
    if (!platformKp) platformKp = keypairFromEnv('MIXER_CREATOR_SECRET_KEY');
    return platformKp;
}

let claimChain = Promise.resolve();
function serialised(fn) {
    const run = claimChain.then(fn, fn);
    claimChain = run.catch(() => {});
    return run;
}

async function mixersFor(userId, mixerId) {
    const rows = await query(
        `SELECT m.mixer_id, m.name, m.ticker, m.image
           FROM mixers m
          WHERE m.created_by = $1 ${mixerId ? 'AND m.mixer_id = $2' : ''}
          ORDER BY m.created_at DESC`,
        mixerId ? [userId, mixerId] : [userId]
    );
    if (!rows.length) return [];

    const allocs = await query(
        `SELECT mixer_id, token_address, mirror_mint
           FROM mixer_allocations WHERE mixer_id = ANY($1)`,
        [rows.map(r => r.mixer_id)]
    );
    const mintsFor = {};
    for (const a of allocs) {
        (mintsFor[a.mixer_id] = mintsFor[a.mixer_id] || []).push(a.mirror_mint || a.token_address);
    }
    return rows.map(r => ({ ...r, mints: [...new Set(mintsFor[r.mixer_id] || [])] }));
}

async function readLedgers(mixers) {
    const program = programFor(anchor.web3.Keypair.generate());

    const states = await program.account.mixerState.fetchMultiple(
        mixers.map(m => new PublicKey(m.mixer_id))
    );

    const slots = [];
    mixers.forEach((m, i) => {
        for (const mint of m.mints) {
            slots.push({ mixer: m, mint, state: states[i] });
        }
    });

    const ledgers = slots.length
        ? await program.account.feeLedger.fetchMultiple(
            slots.map(s => feeLedgerPda(new PublicKey(s.mixer.mixer_id), new PublicKey(s.mint))[0])
        )
        : [];

    return slots.map((s, i) => ({
        ...s,
        accrued: ledgers[i] ? BigInt(ledgers[i].creatorAccrued.toString()) : 0n,
    }));
}

async function claimRows(userId) {
    return query(
        `SELECT mixer_id, status, sum(lamports) AS lamports, max(paid_at) AS last_paid
           FROM fee_claims WHERE user_id = $1 GROUP BY mixer_id, status`,
        [userId]
    );
}

async function creatorFeesFor(userId) {
    const mixers = await mixersFor(userId);
    const platformKey = platform().publicKey.toBase58();

    const byMixer = new Map(mixers.map(m => [m.mixer_id, {
        mixerId: m.mixer_id,
        name: m.name,
        ticker: m.ticker,
        image: m.image,
        claimableLamports: 0,
        claimedLamports: 0,
        unpaidLamports: 0,
        claimable: false,
        note: null,
    }]));

    if (mixers.length) {
        const slots = await readLedgers(mixers);
        for (const s of slots) {
            const row = byMixer.get(s.mixer.mixer_id);
            if (!s.state) { row.note = 'Not found on chain'; continue; }
            if (s.state.creatorWallet.toBase58() !== platformKey) {

                row.note = 'Deployed outside the app; fees cannot be claimed here';
                continue;
            }
            if (s.accrued === 0n) continue;
            try {
                const q = await quoteToSol(s.mint, s.accrued.toString());
                row.claimableLamports += q.lamportsOut;
            } catch (err) {
                console.error(`Fee valuation failed for ${s.mint}:`, err.message);
                row.note = 'Some fees could not be priced right now';
            }
        }
    }

    for (const r of await claimRows(userId)) {
        const row = byMixer.get(r.mixer_id);
        if (!row) continue;
        const n = Number(r.lamports) || 0;
        if (r.status === 'paid') row.claimedLamports += n;
        else { row.unpaidLamports += n; row.claimableLamports += n; }
    }

    const list = [...byMixer.values()];
    list.forEach(r => { r.claimable = r.claimableLamports > 0; });

    const totalClaimable = list.reduce((s, r) => s + r.claimableLamports, 0);
    const totalClaimed = list.reduce((s, r) => s + r.claimedLamports, 0);

    return {
        mixers: list,
        claimableLamports: totalClaimable,
        claimableSol: totalClaimable / SOL,
        claimedLamports: totalClaimed,
        claimedSol: totalClaimed / SOL,
    };
}

async function receivedBy(signature, owner) {
    let tx = null;
    for (let i = 0; i < 6 && !tx; i++) {
        tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        }).catch(() => null);
        if (!tx) await sleep(700);
    }
    if (!tx || !tx.meta) throw new Error(`Could not read back claim ${signature}`);

    const amount = (list) => {
        const out = {};
        for (const b of list || []) {
            if (b.owner !== owner) continue;
            out[b.mint] = (out[b.mint] || 0n) + BigInt(b.uiTokenAmount.amount);
        }
        return out;
    };
    const pre = amount(tx.meta.preTokenBalances);
    const post = amount(tx.meta.postTokenBalances);

    const delta = {};
    for (const mint of Object.keys(post)) {
        const d = post[mint] - (pre[mint] || 0n);
        if (d > 0n) delta[mint] = d;
    }
    return delta;
}

const LEGS_PER_TX = 4;

async function claimLegsOnChain(slots) {
    const kp = platform();
    const program = programFor(kp);
    const owner = kp.publicKey;
    const results = [];

    const atas = {};
    for (const mint of [...new Set(slots.map(s => s.mint))]) {
        const mintPk = new PublicKey(mint);
        const tokenProgram = await tokenProgramForMint(mintPk);
        const ata = getAssociatedTokenAddressSync(mintPk, owner, true, tokenProgram);
        atas[mint] = { ata, tokenProgram };
        if (!(await connection.getAccountInfo(ata))) {
            const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
                owner, ata, owner, mintPk, tokenProgram
            ));
            freshBlockhash();
            await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
        }
    }

    const batches = [];
    for (const s of slots) {
        let b = batches.find(x => x.length < LEGS_PER_TX && !x.some(y => y.mint === s.mint));
        if (!b) { b = []; batches.push(b); }
        b.push(s);
    }

    for (const batch of batches) {
        const tx = new Transaction();
        for (const s of batch) {
            const mixerPk = new PublicKey(s.mixer.mixer_id);
            const mintPk = new PublicKey(s.mint);
            tx.add(await program.methods
                .claimFees()
                .accounts({
                    mixerState: mixerPk,
                    mixerAuthority: mixerAuthorityPda(mixerPk)[0],
                    feeLedger: feeLedgerPda(mixerPk, mintPk)[0],
                    feeVault: feeVaultPda(mixerPk, mintPk)[0],
                    destination: atas[s.mint].ata,
                    mint: mintPk,
                    claimant: owner,
                    tokenProgram: atas[s.mint].tokenProgram,
                })
                .instruction());
        }

        let signature;
        try {
            freshBlockhash();
            signature = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
        } catch (err) {

            console.error('Fee claim batch failed:', err.message);
            results.push(...batch.map(s => ({ slot: s, error: err.message })));
            continue;
        }

        const got = await receivedBy(signature, owner.toBase58());
        for (const s of batch) {
            results.push({ slot: s, signature, raw: got[s.mint] || 0n });
        }
    }

    return { results, atas };
}

function claimCreatorFees({ userId, wallet, mixerId }) {
    return serialised(async () => {
        if (!wallet) throw new Error('No wallet to pay the fees into');
        const kp = platform();
        const platformKey = kp.publicKey.toBase58();

        const mixers = await mixersFor(userId, mixerId);
        if (mixerId && !mixers.length) {
            const e = new Error('You can only claim fees on mixers you created');
            e.status = 403;
            throw e;
        }

        const slots = mixers.length
            ? (await readLedgers(mixers)).filter(s =>
                s.accrued > 0n && s.state && s.state.creatorWallet.toBase58() === platformKey)
            : [];

        const { results, atas } = slots.length
            ? await claimLegsOnChain(slots)
            : { results: [], atas: {} };

        const failed = results.filter(r => r.error);
        const burns = {};
        for (const r of results) {
            if (r.error || r.raw <= 0n) continue;
            const q = await quoteToSol(r.slot.mint, r.raw.toString());
            await query(
                `INSERT INTO fee_claims (user_id, mixer_id, mint, token_amount, lamports, claim_signature)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [userId, r.slot.mixer.mixer_id, r.slot.mint, r.raw.toString(), q.lamportsOut, r.signature]
            );
            burns[r.slot.mint] = (burns[r.slot.mint] || 0n) + r.raw;
        }

        const owed = await query(
            `SELECT id, mixer_id, lamports, claim_signature FROM fee_claims
              WHERE user_id = $1 AND status = 'unpaid' ${mixerId ? 'AND mixer_id = $2' : ''}`,
            mixerId ? [userId, mixerId] : [userId]
        );
        const lamports = owed.reduce((s, r) => s + Number(r.lamports), 0);

        if (lamports <= 0) {
            if (failed.length) throw new Error('The claim did not go through: ' + failed[0].error);
            const e = new Error('Nothing to claim yet');
            e.status = 409;
            throw e;
        }

        let payoutSignature;
        try {
            const tx = new Transaction().add(SystemProgram.transfer({
                fromPubkey: kp.publicKey,
                toPubkey: new PublicKey(wallet),
                lamports,
            }));
            freshBlockhash();
            payoutSignature = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
        } catch (err) {

            console.error('Fee payout failed:', err.message);
            throw new Error('Your fees were collected but the SOL payout failed. Try again to receive it.');
        }

        await query(
            `UPDATE fee_claims SET status = 'paid', payout_signature = $1, paid_at = now()
              WHERE id = ANY($2)`,
            [payoutSignature, owed.map(r => r.id)]
        );

        for (const [mint, raw] of Object.entries(burns)) {
            try {
                const tx = new Transaction().add(createBurnInstruction(
                    atas[mint].ata, new PublicKey(mint), kp.publicKey, raw, [], atas[mint].tokenProgram
                ));
                freshBlockhash();
                await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
            } catch (err) {
                console.error(`Burn of claimed fees failed for ${mint}:`, err.message);
            }
        }

        return {
            lamports,
            sol: lamports / SOL,
            mixers: [...new Set(owed.map(r => r.mixer_id))],
            signature: payoutSignature,
            explorer: `https://explorer.solana.com/tx/${payoutSignature}?cluster=devnet`,
            partial: failed.length > 0,
        };
    });
}

module.exports = { creatorFeesFor, claimCreatorFees };
