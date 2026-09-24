require('dotenv').config({ quiet: true });
const { PublicKey } = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');

const {
    anchor,
    connection,
    keypairFromBase58,
    programFor,
    mixerAuthorityPda,
    vaultPda,
    vaultEntryPda,
    tokenProgramForMint,
} = require('./solanaConfig');

function routingAccountFor(mixerAuthority, mint, tokenProgram) {
    return getAssociatedTokenAddressSync(
        new PublicKey(mint), new PublicKey(mixerAuthority), true, tokenProgram
    );
}

async function ensureRoutingAccount({ mixerState, mint, payerSecretKey }) {
    const payer = keypairFromBase58(payerSecretKey);
    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);
    const [mixerAuthority] = mixerAuthorityPda(mixerPk);

    const routing = routingAccountFor(mixerAuthority, mintPk, tokenProgram);

    if (!(await connection.getAccountInfo(routing))) {
        const tx = new anchor.web3.Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
                payer.publicKey, routing, mixerAuthority, mintPk, tokenProgram
            )
        );
        await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
            commitment: 'confirmed',
        });
    }

    return { routing: routing.toBase58(), mixerAuthority: mixerAuthority.toBase58() };
}

async function rebalanceWithdraw({ mixerState, mint, amount, creatorSecretKey }) {
    const creator = keypairFromBase58(creatorSecretKey);
    const program = programFor(creator);

    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);

    const [mixerAuthority] = mixerAuthorityPda(mixerPk);
    const [vault] = vaultPda(mixerPk, mintPk);
    const [entry] = vaultEntryPda(mixerPk, mintPk);
    const routing = routingAccountFor(mixerAuthority, mintPk, tokenProgram);

    const signature = await program.methods
        .rebalanceWithdraw(new anchor.BN(amount.toString()))
        .accounts({
            mixerState: mixerPk,
            mixerAuthority,
            vaultEntry: entry,
            vault,
            routingAccount: routing,
            mint: mintPk,
            creator: creator.publicKey,
            tokenProgram,
        })
        .signers([creator])
        .rpc();

    return { signature, routing: routing.toBase58(), explorer: explorer(signature) };
}

async function rebalanceSettle({ mixerState, mint, amount, creatorSecretKey }) {
    const creator = keypairFromBase58(creatorSecretKey);
    const program = programFor(creator);

    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);

    const [mixerAuthority] = mixerAuthorityPda(mixerPk);
    const [vault] = vaultPda(mixerPk, mintPk);
    const [entry] = vaultEntryPda(mixerPk, mintPk);
    const routing = routingAccountFor(mixerAuthority, mintPk, tokenProgram);

    const signature = await program.methods
        .rebalanceSettle(new anchor.BN(amount.toString()))
        .accounts({
            mixerState: mixerPk,
            mixerAuthority,
            vaultEntry: entry,
            vault,
            routingAccount: routing,
            mint: mintPk,
            creator: creator.publicKey,
            tokenProgram,
        })
        .signers([creator])
        .rpc();

    return { signature, explorer: explorer(signature) };
}

async function setVaultWeight({ mixerState, mint, weightBps, creatorSecretKey }) {
    const creator = keypairFromBase58(creatorSecretKey);
    const program = programFor(creator);
    const mixerPk = new PublicKey(mixerState);
    const [entry] = vaultEntryPda(mixerPk, new PublicKey(mint));

    const signature = await program.methods
        .setVaultWeight(weightBps)
        .accounts({ mixerState: mixerPk, vaultEntry: entry, creator: creator.publicKey })
        .signers([creator])
        .rpc();

    return { signature, explorer: explorer(signature) };
}

async function closeVault({ mixerState, mint, creatorSecretKey }) {
    const creator = keypairFromBase58(creatorSecretKey);
    const program = programFor(creator);

    const mixerPk = new PublicKey(mixerState);
    const mintPk = new PublicKey(mint);
    const tokenProgram = await tokenProgramForMint(mintPk);
    const [mixerAuthority] = mixerAuthorityPda(mixerPk);
    const [vault] = vaultPda(mixerPk, mintPk);
    const [entry] = vaultEntryPda(mixerPk, mintPk);

    const signature = await program.methods
        .closeVault()
        .accounts({
            mixerState: mixerPk,
            mixerAuthority,
            vaultEntry: entry,
            vault,
            mint: mintPk,
            creator: creator.publicKey,
            tokenProgram,
        })
        .signers([creator])
        .rpc();

    return { signature, explorer: explorer(signature) };
}

async function setFrozen({ mixerState, frozen, creatorSecretKey }) {
    const creator = keypairFromBase58(creatorSecretKey);
    const program = programFor(creator);
    const signature = await program.methods
        .setFrozen(frozen)
        .accounts({ mixerState: new PublicKey(mixerState), creator: creator.publicKey })
        .signers([creator])
        .rpc();
    return { signature, explorer: explorer(signature) };
}

const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

module.exports = {
    ensureRoutingAccount,
    rebalanceWithdraw,
    rebalanceSettle,
    setVaultWeight,
    closeVault,
    setFrozen,
    routingAccountFor,
};
