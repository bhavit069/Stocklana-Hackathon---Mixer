
const SIZE = {
    mixerState: 273,
    tokenAccount: 165,
    vaultEntry: 115,
    feeLedger: 105,
    position: 81,
    mint: 82,
};
const SIGNATURE = 5000;

const ACCOUNT_OVERHEAD = 128;
const REDIS_KEY = 'rent:empty_account_lamports';

const MEASURED_EMPTY_RENT = 650240;
const RPC_BUDGET_MS = 3000;
let rentCache = { at: 0, rent: null };

const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timed out')), ms)),
]);

function rentTable(emptyLamports) {
    const perByte = emptyLamports / ACCOUNT_OVERHEAD;
    const out = {};
    for (const [k, bytes] of Object.entries(SIZE)) out[k] = Math.round((ACCOUNT_OVERHEAD + bytes) * perByte);
    return out;
}

async function rents() {
    if (rentCache.rent && Date.now() - rentCache.at < 60 * 60 * 1000) return rentCache.rent;
    const redis = require('../redis');
    try {
        const { connection } = require('./solanaConfig');
        const empty = await withTimeout(connection.getMinimumBalanceForRentExemption(0), RPC_BUDGET_MS);
        rentCache = { at: Date.now(), rent: rentTable(empty) };
        redis.set(REDIS_KEY, String(empty), { EX: 7 * 24 * 3600 }).catch(() => {});
        return rentCache.rent;
    } catch (err) {
        if (rentCache.rent) return rentCache.rent;
        const saved = Number(await redis.get(REDIS_KEY).catch(() => null));

        rentCache = { at: Date.now() - 55 * 60 * 1000, rent: rentTable(saved > 0 ? saved : MEASURED_EMPTY_RENT) };
        return rentCache.rent;
    }
}

async function creationCost(tokenCount, realMints = []) {
    const { supports } = require('./programFeatures');

    const [r, feeAccountsAtDeploy] = await Promise.all([
        rents(),
        withTimeout(supports('buy'), RPC_BUDGET_MS).catch(() => false),
    ]);

    let newMirrors = 0;
    if (realMints.length) {
        const { getMirror } = require('./mirrorMint');
        for (const m of realMints) {
            if (!(await getMirror(m).catch(() => null))) newMirrors++;
        }
    }

    const feeAccounts = r.tokenAccount + r.feeLedger;

    const deployTxs = tokenCount + 2 + newMirrors + (feeAccountsAtDeploy ? Math.ceil(tokenCount / 3) : 0);
    const deploy = r.mixerState
        + tokenCount * (r.tokenAccount + r.vaultEntry)
        + (feeAccountsAtDeploy ? tokenCount * feeAccounts : 0)
        + newMirrors * r.mint
        + deployTxs * SIGNATURE;

    const ownTxs = 2 + (feeAccountsAtDeploy ? 1 : tokenCount);
    const firstBuy = r.position
        + (feeAccountsAtDeploy ? 0 : tokenCount * feeAccounts)
        + ownTxs * SIGNATURE;

    return {
        tokenCount,
        newMirrors,
        deployLamports: deploy,
        firstBuyLamports: firstBuy,
        deploy_sol: deploy / 1e9,
        first_buy_sol: firstBuy / 1e9,
        total_sol: (deploy + firstBuy) / 1e9,
    };
}

module.exports = { creationCost };
