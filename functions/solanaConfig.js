
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const idl = require('../contract/idl.json');

const PROGRAM_ID = new PublicKey(
    process.env.MIXER_PROGRAM_ID || '6qtpr7cCfCy2jmtFyAUcGWpZYLji2UWk8sAWXGbfM5My'
);

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const MAX_RPC_RETRIES = 4;

const MAX_BACKOFF_PER_CALL_MS = 4000;

async function retryingFetch(input, init) {
    let delay = 300;
    let spent = 0;

    const waitFor = async (ms) => {
        const capped = Math.min(ms, MAX_BACKOFF_PER_CALL_MS - spent);
        if (capped <= 0) return false;
        await new Promise(r => setTimeout(r, capped));
        spent += capped;
        return true;
    };

    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(input, init);
        } catch (err) {

            if (attempt >= MAX_RPC_RETRIES || !(await waitFor(delay))) throw err;
            delay = Math.min(delay * 2, 2000);
            continue;
        }

        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!retryable || attempt >= MAX_RPC_RETRIES) return res;

        const header = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(header) && header > 0
            ? Math.min(header * 1000, MAX_BACKOFF_PER_CALL_MS)
            : delay;

        if (!(await waitFor(wait))) return res;
        delay = Math.min(delay * 2, 2000);
    }
}

const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 120_000,
    fetch: retryingFetch,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshBlockhash() {
    if (connection._blockhashInfo) {
        connection._blockhashInfo.latestBlockhash = null;
        connection._blockhashInfo.lastFetch = 0;
    }
}

function keypairFromEnv(varName) {
    const raw = process.env[varName];
    if (!raw) throw new Error(`${varName} is not set`);
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}

function keypairFromBase58(secret) {
    return Keypair.fromSecretKey(bs58.decode(String(secret).trim()));
}

const PROVIDER_OPTS = {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    maxRetries: 5,
};

function programFor(signerKeypair) {
    const provider = new anchor.AnchorProvider(
        connection,
        new anchor.Wallet(signerKeypair),
        PROVIDER_OPTS
    );
    return new anchor.Program(idl, PROGRAM_ID, provider);
}

function programForWallet(wallet) {
    const provider = new anchor.AnchorProvider(connection, wallet, PROVIDER_OPTS);
    return new anchor.Program(idl, PROGRAM_ID, provider);
}

const mixerStatePda = (creator, mixerSeed) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('mixer'), creator.toBuffer(), Buffer.from(mixerSeed)],
        PROGRAM_ID
    );

const mixerAuthorityPda = (mixerState) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('mixer-authority'), mixerState.toBuffer()],
        PROGRAM_ID
    );

const vaultPda = (mixerState, mint) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), mixerState.toBuffer(), mint.toBuffer()],
        PROGRAM_ID
    );

const vaultEntryPda = (mixerState, mint) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('vault-entry'), mixerState.toBuffer(), mint.toBuffer()],
        PROGRAM_ID
    );

const feeVaultPda = (mixerState, mint) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('fee-vault'), mixerState.toBuffer(), mint.toBuffer()],
        PROGRAM_ID
    );

const feeLedgerPda = (mixerState, mint) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('fee-ledger'), mixerState.toBuffer(), mint.toBuffer()],
        PROGRAM_ID
    );

const positionPda = (mixerState, owner) =>
    PublicKey.findProgramAddressSync(
        [Buffer.from('position'), mixerState.toBuffer(), owner.toBuffer()],
        PROGRAM_ID
    );

const tokenProgramCache = new Map();

async function tokenProgramForMint(mint) {
    const key = String(mint);
    const hit = tokenProgramCache.get(key);
    if (hit) return hit;

    const info = await connection.getAccountInfo(new PublicKey(mint));
    if (!info) throw new Error(`Mint not found on chain: ${mint}`);

    let program;
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) program = TOKEN_2022_PROGRAM_ID;
    else if (info.owner.equals(TOKEN_PROGRAM_ID)) program = TOKEN_PROGRAM_ID;
    else throw new Error(`Mint ${mint} is not owned by a known token program`);

    tokenProgramCache.set(key, program);
    return program;
}

const mintDecimalsCache = new Map();

async function decimalsForMint(mint) {
    const key = String(mint);
    if (mintDecimalsCache.has(key)) return mintDecimalsCache.get(key);

    const { getMint } = require('@solana/spl-token');
    const program = await tokenProgramForMint(mint);
    const info = await getMint(connection, new PublicKey(mint), 'confirmed', program);

    mintDecimalsCache.set(key, info.decimals);
    return info.decimals;
}

module.exports = {
    anchor,
    sleep,
    freshBlockhash,
    connection,
    PROGRAM_ID,
    RPC_URL,
    keypairFromEnv,
    keypairFromBase58,
    programFor,
    programForWallet,
    mixerStatePda,
    mixerAuthorityPda,
    vaultPda,
    vaultEntryPda,
    positionPda,
    feeVaultPda,
    feeLedgerPda,
    tokenProgramForMint,
    decimalsForMint,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
};
