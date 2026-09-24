require('dotenv').config({ quiet: true });
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { getFeeLedger } = require('./tradeMixer');
const { rateForAsync } = require('./swap');
const { decimalsForMint } = require('./solanaConfig');
const { realUsdPrices } = require('./mirrorRates');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function solUsd() {
    try {
        const prices = await realUsdPrices([SOL_MINT]);
        const p = prices && prices[SOL_MINT];
        const n = Number(p && (p.usdPrice ?? p));
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

async function getFeesSol(mixerId, mints) {
    const perToken = [];
    let creatorSol = 0, treasurySol = 0;
    let creatorUnclaimedSol = 0, treasuryUnclaimedSol = 0;
    let complete = true;

    for (const mint of mints) {
        let ledger;
        try {
            ledger = await getFeeLedger({ mixerState: mixerId, mint });
        } catch (err) {

            perToken.push({ mint, creatorSol: 0, treasurySol: 0, unread: true });
            continue;
        }

        const cRaw = Number(ledger.creatorAccrued) + Number(ledger.creatorClaimed);
        const tRaw = Number(ledger.treasuryAccrued) + Number(ledger.treasuryClaimed);
        const cUnclaimedRaw = Number(ledger.creatorAccrued);
        const tUnclaimedRaw = Number(ledger.treasuryAccrued);

        if (cRaw === 0 && tRaw === 0) {
            perToken.push({ mint, creatorSol: 0, treasurySol: 0 });
            continue;
        }

        let lamportsPerRaw = null;
        try {
            const decimals = await decimalsForMint(mint);
            const rate = await rateForAsync(mint);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error('no rate');

            lamportsPerRaw = (LAMPORTS_PER_SOL / rate) / 10 ** decimals;
        } catch (err) {
            console.error(`Fee conversion failed for ${mint}:`, err.message);
            complete = false;
            perToken.push({ mint, error: 'rate unavailable' });
            continue;
        }

        const toSol = (raw) => (raw * lamportsPerRaw) / LAMPORTS_PER_SOL;

        const c = toSol(cRaw), t = toSol(tRaw);
        const cU = toSol(cUnclaimedRaw), tU = toSol(tUnclaimedRaw);

        creatorSol += c;
        treasurySol += t;
        creatorUnclaimedSol += cU;
        treasuryUnclaimedSol += tU;

        perToken.push({
            mint,
            creatorSol: c,
            treasurySol: t,
            creatorUnclaimedSol: cU,
            treasuryUnclaimedSol: tU,
        });
    }

    const usd = await solUsd();
    const totalSol = creatorSol + treasurySol;

    return {
        perToken,
        creatorSol,
        treasurySol,
        totalSol,
        creatorUnclaimedSol,
        treasuryUnclaimedSol,
        totalUnclaimedSol: creatorUnclaimedSol + treasuryUnclaimedSol,
        solUsd: usd,
        creatorUsd: usd != null ? creatorSol * usd : null,
        treasuryUsd: usd != null ? treasurySol * usd : null,
        totalUsd: usd != null ? totalSol * usd : null,
        complete,
    };
}

module.exports = { getFeesSol };
