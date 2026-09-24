require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { PublicKey, SystemProgram } = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');

const {
    anchor,
    connection,
    keypairFromBase58,
    programFor,
    mixerStatePda,
    mixerAuthorityPda,
    vaultPda,
    vaultEntryPda,
    tokenProgramForMint,
} = require('./solanaConfig');

const BPS = 10_000;

const weightToBps = (w) => Math.round(Number(w) * BPS);

async function createMixerOnChain(config) {
    const required = ['tokens', 'creator', 'mixer_name', 'mixer_ticker', 'creatorWalletKey'];
    for (const k of required) {
        if (!config[k]) throw new Error(`createMixerOnChain: missing "${k}"`);
    }

    const creator = keypairFromBase58(config.creatorWalletKey);
    const program = programFor(creator);

    const treasury = new PublicKey(
        config.treasury || process.env.MIXER_TREASURY_WALLET || creator.publicKey.toBase58()
    );

    const tokens = config.tokens;
    const tokenCount = tokens.length;

    const bpsWeights = tokens.map((t) => weightToBps(t.weight));
    const totalBps = bpsWeights.reduce((a, b) => a + b, 0);
    if (totalBps !== BPS) {
        throw new Error(`Weights must sum to 1.0 (got ${totalBps} bps across ${tokenCount} tokens)`);
    }

    const tradeFeeBps = config.trade_fee_bps ?? Number(process.env.MIXER_TRADE_FEE_BPS ?? 100);
    const creatorFeeShareBps =
        config.creator_fee_share_bps ?? Number(process.env.MIXER_CREATOR_FEE_SHARE_BPS ?? 5000);

    const mixerSeed = crypto.randomBytes(32);
    const [mixerState] = mixerStatePda(creator.publicKey, mixerSeed);
    const [mixerAuthority] = mixerAuthorityPda(mixerState);

    console.log('🔗 RPC        :', connection.rpcEndpoint);
    console.log('👤 Creator    :', creator.publicKey.toBase58());
    console.log('🏛  Treasury   :', treasury.toBase58());
    console.log('🔑 MixerState :', mixerState.toBase58());
    console.log('🔑 Authority  :', mixerAuthority.toBase58());

    const output = {
        mixer_state: mixerState.toBase58(),
        mixer_authority: mixerAuthority.toBase58(),
        treasury: treasury.toBase58(),
        mixer_seed: mixerSeed.toString('hex'),
        trade_fee_bps: tradeFeeBps,
        creator_fee_share_bps: creatorFeeShareBps,
        vaults: [],
        signatures: {},
    };

    output.signatures.initialize = await program.methods
        .initializeMixer(
            Array.from(mixerSeed),
            config.creator,
            config.mixer_name,
            config.mixer_ticker,
            tokenCount,
            tradeFeeBps,
            creatorFeeShareBps
        )
        .accounts({
            mixerState,
            mixerAuthority,
            treasury,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

    console.log('✅ Mixer initialized:', output.signatures.initialize);

    output.signatures.vaults = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const mint = new PublicKey(t.address);
        const tokenProgram = await tokenProgramForMint(mint);

        const [vault] = vaultPda(mixerState, mint);
        const [entry] = vaultEntryPda(mixerState, mint);

        const sig = await program.methods
            .createVault(bpsWeights[i])
            .accounts({
                mixerState,
                mixerAuthority,
                vault,
                vaultEntry: entry,
                mint,
                creator: creator.publicKey,
                creatorWallet: creator.publicKey,
                tokenProgram,
                systemProgram: SystemProgram.programId,
            })
            .signers([creator])
            .rpc();

        output.signatures.vaults.push(sig);
        output.vaults.push({
            address: mint.toBase58(),
            weight: t.weight,
            weight_bps: bpsWeights[i],
            vault: vault.toBase58(),
            vault_entry: entry.toBase58(),
            token_program: tokenProgram.toBase58(),
        });

        console.log(`✅ Vault ${i + 1}/${tokenCount} ${mint.toBase58().slice(0, 8)}… -> ${vault.toBase58().slice(0, 8)}…`);
    }

    output.signatures.finalize = await program.methods
        .finalizeMixer(BPS)
        .accounts({ mixerState, creator: creator.publicKey })
        .signers([creator])
        .rpc();

    console.log('🎯 Mixer finalized:', output.signatures.finalize);

    try {
        const { supports } = require('./programFeatures');
        if (await supports('buy')) {
            const { ensureFeeAccounts } = require('./tradeMixer');
            await ensureFeeAccounts(mixerState.toBase58(), tokens.map(t => t.address));
        }
    } catch (err) {
        console.error('Post-deploy buy setup failed (the first buy will retry):', err.message);
    }

    return output;
}

async function ensureFeeAccounts(payerKeypair, mint, creatorWallet, treasuryWallet) {
    const tokenProgram = await tokenProgramForMint(mint);
    const mintPk = new PublicKey(mint);

    const creatorAta = getAssociatedTokenAddressSync(mintPk, new PublicKey(creatorWallet), true, tokenProgram);
    const treasuryAta = getAssociatedTokenAddressSync(mintPk, new PublicKey(treasuryWallet), true, tokenProgram);

    const ixs = [];
    for (const [ata, owner] of [[creatorAta, creatorWallet], [treasuryAta, treasuryWallet]]) {
        const info = await connection.getAccountInfo(ata);
        if (!info) {
            ixs.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    payerKeypair.publicKey, ata, new PublicKey(owner), mintPk, tokenProgram
                )
            );
        }
    }

    if (ixs.length) {
        const tx = new anchor.web3.Transaction().add(...ixs);
        await anchor.web3.sendAndConfirmTransaction(connection, tx, [payerKeypair], {
            commitment: 'confirmed',
        });
    }

    return { creatorAta, treasuryAta, tokenProgram };
}

module.exports = { createMixerOnChain, ensureFeeAccounts, weightToBps };
