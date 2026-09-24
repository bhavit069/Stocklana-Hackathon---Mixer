require('dotenv').config({ quiet: true });
const { PublicKey, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');

const {
    anchor,
    connection,
    keypairFromBase58,
    keypairFromEnv,
    programFor,
    programForWallet,
    mixerAuthorityPda,
    vaultPda,
    vaultEntryPda,
    positionPda,
    feeVaultPda,
    feeLedgerPda,
    tokenProgramForMint,
    sleep,
    freshBlockhash,
} = require('./solanaConfig');

async function tradeOnChain({ mixerState, mint, amount, traderSecretKey, privyWallet }) {

    let trader, program;
    if (privyWallet) {
        trader = { publicKey: privyWallet.publicKey };
        program = programForWallet(privyWallet);
    } else {
        trader = keypairFromBase58(traderSecretKey);
        program = programFor(trader);
    }

    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);

    const [vault] = vaultPda(mixerPk, mintPk);
    const [entry] = vaultEntryPda(mixerPk, mintPk);
    const [position] = positionPda(mixerPk, trader.publicKey);

    const traderAta = getAssociatedTokenAddressSync(mintPk, trader.publicKey, true, tokenProgram);

    const [mixerAuthority] = mixerAuthorityPda(mixerPk);
    const [feeVault] = feeVaultPda(mixerPk, mintPk);
    const [feeLedger] = feeLedgerPda(mixerPk, mintPk);
    const pre = [];

    freshBlockhash();

    const signature = await program.methods
        .trade(new anchor.BN(amount.toString()))
        .accounts({
            mixerState: mixerPk,
            vaultEntry: entry,
            vault,
            position,
            traderTokenAccount: traderAta,
            feeVault,
            feeLedger,
            mixerAuthority,
            mint: mintPk,
            trader: trader.publicKey,
            tokenProgram,
            systemProgram: SystemProgram.programId,
        })
        .preInstructions(pre)
        .signers(privyWallet ? [] : [trader])
        .rpc();

    const updated = await program.account.userPosition.fetch(position);

    return {
        signature,
        position: position.toBase58(),
        shares: updated.shares.toString(),
        vault: vault.toBase58(),
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
}

async function withdrawOnChain({ mixerState, mint, shares, userSecretKey, privyWallet }) {
    let user, program;
    if (privyWallet) {
        user = { publicKey: privyWallet.publicKey };
        program = programForWallet(privyWallet);
    } else {
        user = keypairFromBase58(userSecretKey);
        program = programFor(user);
    }

    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);

    const [mixerAuthority] = mixerAuthorityPda(mixerPk);
    const [vault] = vaultPda(mixerPk, mintPk);
    const [entry] = vaultEntryPda(mixerPk, mintPk);
    const [position] = positionPda(mixerPk, user.publicKey);

    const destination = getAssociatedTokenAddressSync(mintPk, user.publicKey, true, tokenProgram);

    const pre = [];
    if (!(await connection.getAccountInfo(destination))) {
        pre.push(
            createAssociatedTokenAccountIdempotentInstruction(
                user.publicKey, destination, user.publicKey, mintPk, tokenProgram
            )
        );
    }

    let signature;
    for (let attempt = 0; ; attempt++) {
        try {

            freshBlockhash();
            signature = await program.methods
                .withdrawFromVault(new anchor.BN(shares.toString()))
                .accounts({
                    mixerState: mixerPk,
                    mixerAuthority,
                    vaultEntry: entry,
                    vault,
                    position,
                    destination,
                    mint: mintPk,
                    user: user.publicKey,
                    tokenProgram,
                })
                .preInstructions(pre)
                .signers(privyWallet ? [] : [user])
                .rpc();
            break;
        } catch (err) {
            const msg = String(err && err.message);
            const stale = /Blockhash not found|block height exceeded|expired/i.test(msg);
            if (!stale || attempt >= 3) throw err;
            await sleep(900 * (attempt + 1));
        }
    }

    const updated = await program.account.userPosition.fetch(position);

    return {
        signature,
        shares_remaining: updated.shares.toString(),
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
}

async function getPosition({ mixerState, owner }) {
    const program = programFor(anchor.web3.Keypair.generate());
    const mixerPk = new PublicKey(mixerState);
    const [position] = positionPda(mixerPk, new PublicKey(owner));

    try {
        const p = await program.account.userPosition.fetch(position);
        return { exists: true, address: position.toBase58(), shares: p.shares.toString() };
    } catch {
        return { exists: false, address: position.toBase58(), shares: '0' };
    }
}

async function getMixerOnChain({ mixerState, mints = [] }) {
    const program = programFor(anchor.web3.Keypair.generate());
    const mixerPk = new PublicKey(mixerState);
    const state = await program.account.mixerState.fetch(mixerPk);

    const vaults = [];
    for (const m of mints) {
        const mintPk = new PublicKey(m);
        const [entry] = vaultEntryPda(mixerPk, mintPk);
        try {
            const e = await program.account.vaultEntry.fetch(entry);
            vaults.push({
                mint: m,
                vault: e.vault.toBase58(),
                weight_bps: e.weightBps,
                total_deposited: e.totalDeposited.toString(),
            });
        } catch {
            vaults.push({ mint: m, vault: null, weight_bps: null, total_deposited: null });
        }
    }

    return {
        creator_wallet: state.creatorWallet.toBase58(),
        treasury: state.treasury.toBase58(),
        name: state.name,
        ticker: state.ticker,
        token_count: state.tokenCount,
        vaults_created: state.vaultsCreated,
        total_shares: state.totalShares.toString(),
        trade_fee_bps: state.tradeFeeBps,
        creator_fee_share_bps: state.creatorFeeShareBps,
        is_finalized: state.isFinalized,
        is_frozen: state.isFrozen,
        vaults,
    };
}

async function getFeeLedger({ mixerState, mint }) {
    const program = programFor(anchor.web3.Keypair.generate());
    const mixerPk = new PublicKey(mixerState);
    const [ledger] = feeLedgerPda(mixerPk, new PublicKey(mint));

    try {
        const l = await program.account.feeLedger.fetch(ledger);
        return {
            exists: true,
            address: ledger.toBase58(),
            creatorAccrued: l.creatorAccrued.toString(),
            treasuryAccrued: l.treasuryAccrued.toString(),
            creatorClaimed: l.creatorClaimed.toString(),
            treasuryClaimed: l.treasuryClaimed.toString(),
        };
    } catch {
        return {
            exists: false, address: ledger.toBase58(),
            creatorAccrued: '0', treasuryAccrued: '0',
            creatorClaimed: '0', treasuryClaimed: '0',
        };
    }
}

let platformKp = null;
const platform = () => (platformKp = platformKp || keypairFromEnv('MIXER_CREATOR_SECRET_KEY'));

async function sendChunked(ixs, per) {
    const { Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
    for (let i = 0; i < ixs.length; i += per) {
        const tx = new Transaction();
        ixs.slice(i, i + per).forEach(ix => tx.add(ix));
        freshBlockhash();
        await sendAndConfirmTransaction(connection, tx, [platform()], { commitment: 'confirmed' });
    }
}

async function ensureAtas(owner, mints) {
    const ownerPk = new PublicKey(owner);
    const want = [];
    for (const m of mints) {
        const mintPk = new PublicKey(m);
        const tokenProgram = await tokenProgramForMint(mintPk);
        want.push({ mintPk, tokenProgram, ata: getAssociatedTokenAddressSync(mintPk, ownerPk, true, tokenProgram) });
    }
    const infos = await connection.getMultipleAccountsInfo(want.map(w => w.ata));
    const missing = want.filter((w, i) => !infos[i]);
    await sendChunked(missing.map(w => createAssociatedTokenAccountIdempotentInstruction(
        platform().publicKey, w.ata, ownerPk, w.mintPk, w.tokenProgram
    )), 4);
    return want.map(w => w.ata);
}

async function ensureFeeAccounts(mixerState, mints) {
    const program = programFor(platform());
    const mixerPk = new PublicKey(mixerState);
    const ledgers = mints.map(m => feeLedgerPda(mixerPk, new PublicKey(m))[0]);
    const infos = await connection.getMultipleAccountsInfo(ledgers);

    const ixs = [];
    for (let i = 0; i < mints.length; i++) {
        if (infos[i]) continue;
        const mintPk = new PublicKey(mints[i]);
        ixs.push(await program.methods
            .initFeeAccounts()
            .accounts({
                mixerState: mixerPk,
                vaultEntry: vaultEntryPda(mixerPk, mintPk)[0],
                feeVault: feeVaultPda(mixerPk, mintPk)[0],
                feeLedger: ledgers[i],
                mixerAuthority: mixerAuthorityPda(mixerPk)[0],
                mint: mintPk,
                payer: platform().publicKey,
                tokenProgram: await tokenProgramForMint(mintPk),
                systemProgram: SystemProgram.programId,
            })
            .instruction());
    }
    await sendChunked(ixs, 3);
    return ixs.length;
}

async function basketTokenProgram(mints) {
    const programs = await Promise.all(mints.map(m => tokenProgramForMint(new PublicKey(m))));
    const first = programs[0];
    if (programs.some(p => !p.equals(first))) {
        throw new Error('This basket mixes SPL Token and Token-2022 mints, which buy/redeem do not support');
    }
    return first;
}

const computeFor = (legs) => ComputeBudgetProgram.setComputeUnitLimit({
    units: Math.min(1_400_000, 150_000 + 80_000 * legs),
});

async function buyOnChain({ mixerState, amounts, traderSecretKey, privyWallet }) {
    const { lookupTableFor, sendV0 } = require('./lookupTables');

    let trader, keypair = null;
    if (privyWallet) trader = { publicKey: privyWallet.publicKey };
    else trader = keypair = keypairFromBase58(traderSecretKey);

    const mixerPk = new PublicKey(mixerState);
    const mints = amounts.map(a => a.mint);
    const tokenProgram = await basketTokenProgram(mints);

    const [sources] = await Promise.all([
        ensureAtas(trader.publicKey, mints),
        ensureFeeAccounts(mixerState, mints),
    ]);
    const table = await lookupTableFor(mixerState, mints);

    const [position] = positionPda(mixerPk, trader.publicKey);
    const program = programFor(anchor.web3.Keypair.generate());
    const before = await program.account.userPosition.fetchNullable(position);

    const groups = [];
    mints.forEach((m, i) => {
        const mintPk = new PublicKey(m);
        groups.push(
            { pubkey: vaultEntryPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
            { pubkey: vaultPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
            { pubkey: mintPk, isWritable: false, isSigner: false },
            { pubkey: sources[i], isWritable: true, isSigner: false },
            { pubkey: feeVaultPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
            { pubkey: feeLedgerPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
        );
    });

    const ix = await program.methods
        .buy(amounts.map(a => new anchor.BN(String(a.amount))))
        .accounts({
            mixerState: mixerPk,
            position,
            trader: trader.publicKey,
            tokenProgram,
            systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(groups)
        .instruction();

    const signature = await sendV0({
        instructions: [computeFor(mints.length), ix],
        lookupTables: [table],
        privyWallet,
        keypair,
    });

    const after = await program.account.userPosition.fetch(position);
    const prev = before ? BigInt(before.shares.toString()) : 0n;

    return {
        signature,
        position: position.toBase58(),
        shares: after.shares.toString(),
        minted: (BigInt(after.shares.toString()) - prev).toString(),
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
}

async function redeemOnChain({ mixerState, mints, shares, userSecretKey, privyWallet }) {
    const { lookupTableFor, sendV0 } = require('./lookupTables');

    let user, keypair = null;
    if (privyWallet) user = { publicKey: privyWallet.publicKey };
    else user = keypair = keypairFromBase58(userSecretKey);

    const mixerPk = new PublicKey(mixerState);
    const tokenProgram = await basketTokenProgram(mints);
    const destinations = await ensureAtas(user.publicKey, mints);
    const table = await lookupTableFor(mixerState, mints);
    const [position] = positionPda(mixerPk, user.publicKey);

    const groups = [];
    mints.forEach((m, i) => {
        const mintPk = new PublicKey(m);
        groups.push(
            { pubkey: vaultEntryPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
            { pubkey: vaultPda(mixerPk, mintPk)[0], isWritable: true, isSigner: false },
            { pubkey: mintPk, isWritable: false, isSigner: false },
            { pubkey: destinations[i], isWritable: true, isSigner: false },
        );
    });

    const program = programFor(anchor.web3.Keypair.generate());
    const ix = await program.methods
        .redeem(new anchor.BN(String(shares)))
        .accounts({
            mixerState: mixerPk,
            mixerAuthority: mixerAuthorityPda(mixerPk)[0],
            position,
            user: user.publicKey,
            tokenProgram,
        })
        .remainingAccounts(groups)
        .instruction();

    const signature = await sendV0({
        instructions: [computeFor(mints.length), ix],
        lookupTables: [table],
        privyWallet,
        keypair,
    });

    const after = await program.account.userPosition.fetch(position);
    return {
        signature,
        destinations: destinations.map(d => d.toBase58()),
        shares_remaining: after.shares.toString(),
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
}

module.exports = {
    tradeOnChain, withdrawOnChain, getPosition, getMixerOnChain, getFeeLedger,
    buyOnChain, redeemOnChain, ensureFeeAccounts,
};
