require('dotenv').config({ quiet: true });
const { PublicKey } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');

const { connection, tokenProgramForMint } = require('./solanaConfig');
const { getMixerOnChain, getFeeLedger } = require('./tradeMixer');
const { getHolders } = require('./holders');
const { query } = require('../database');
const { getDevnetPrices } = require('./devnetPrices');
const { getFeesSol } = require('./feesSol');
const { getHoldersEnriched } = require('./holders');

async function getVolume(mixerId) {
    const rows = await query(
        `SELECT
            coalesce(sum(CASE WHEN side = 'buy' THEN sol_amount ELSE 0 END), 0) AS buy_volume,
            count(*) FILTER (WHERE side = 'buy')  AS buy_count,
            count(*) FILTER (WHERE side = 'sell') AS sell_count,
            count(DISTINCT user_id) AS unique_traders,
            min(created_at) AS first_trade,
            max(created_at) AS last_trade
         FROM mixer_trades WHERE mixer_id = $1`,
        [mixerId]
    );
    const r = rows[0] || {};
    return {
        buyVolumeSol: Number(r.buy_volume || 0),
        buyCount: Number(r.buy_count || 0),
        sellCount: Number(r.sell_count || 0),
        tradeCount: Number(r.buy_count || 0) + Number(r.sell_count || 0),
        uniqueTraders: Number(r.unique_traders || 0),
        firstTrade: r.first_trade || null,
        lastTrade: r.last_trade || null,
    };
}

async function getFees(state, mints) {
    let prices = {};
    try {
        prices = await getDevnetPrices(mints);
    } catch (err) {
        console.error('Fee pricing failed:', err.message);
    }

    const perToken = [];
    let creatorUsd = 0, treasuryUsd = 0;
    let creatorUnclaimedUsd = 0, treasuryUnclaimedUsd = 0;
    let priced = true;

    for (const mint of mints) {
        let decimals = 0;
        try {
            const tokenProgram = await tokenProgramForMint(new PublicKey(mint));
            decimals = (await getMint(connection, new PublicKey(mint), 'confirmed', tokenProgram)).decimals;
        } catch {
            perToken.push({ mint, error: 'mint unreadable' });
            priced = false;
            continue;
        }

        let ledger;
        try {
            ledger = await getFeeLedger({ mixerState: state.mixerId, mint });
        } catch (err) {
            perToken.push({ mint, error: 'ledger unreadable' });
            priced = false;
            continue;
        }

        const unit = 10 ** decimals;

        const cTotal = (Number(ledger.creatorAccrued) + Number(ledger.creatorClaimed)) / unit;
        const tTotal = (Number(ledger.treasuryAccrued) + Number(ledger.treasuryClaimed)) / unit;
        const cUnclaimed = Number(ledger.creatorAccrued) / unit;
        const tUnclaimed = Number(ledger.treasuryAccrued) / unit;

        const usd = prices[mint] ? prices[mint].usdPrice : null;
        if (usd === null) priced = false;

        if (usd !== null) {
            creatorUsd += cTotal * usd;
            treasuryUsd += tTotal * usd;
            creatorUnclaimedUsd += cUnclaimed * usd;
            treasuryUnclaimedUsd += tUnclaimed * usd;
        }

        perToken.push({
            mint,
            decimals,
            creatorTokens: cTotal,
            treasuryTokens: tTotal,
            creatorUnclaimed: cUnclaimed,
            treasuryUnclaimed: tUnclaimed,
            usdPrice: usd,
            creatorUsd: usd !== null ? cTotal * usd : null,
            treasuryUsd: usd !== null ? tTotal * usd : null,
        });
    }

    return {
        perToken,
        creatorUsd,
        treasuryUsd,
        totalUsd: creatorUsd + treasuryUsd,
        creatorUnclaimedUsd,
        treasuryUnclaimedUsd,

        complete: priced,
    };
}

async function getMixerStats({ mixerId, mixer, mints }) {
    const state = await getMixerOnChain({ mixerState: mixerId, mints });

    let valueShares = null;
    try {
        const { loadSellContext, priceSell } = require('./sellMixer');
        const ctx = await loadSellContext({ mixerState: mixerId, mints });
        valueShares = (shares) => priceSell(ctx, BigInt(shares)).solTotal;
    } catch (err) {
        console.error('Share valuation unavailable:', err.message);
    }

    const [volume, holders, feesSol, fees] = await Promise.all([
        getVolume(mixerId),

        getHoldersEnriched(mixerId, { valueShares }).catch((e) => {
            console.error('Holders failed:', e.message);
            return [];
        }),

        getFeesSol(mixerId, mints).catch((e) => {
            console.error('SOL fees failed:', e.message);
            return null;
        }),
        getFees({ ...state, mixerId }, mints).catch((e) => {
            console.error('Fees failed:', e.message);
            return { perToken: [], creatorUsd: 0, treasuryUsd: 0, totalUsd: 0,
                     creatorUnclaimedUsd: 0, treasuryUnclaimedUsd: 0, complete: false };
        }),
    ]);

    return {
        mixer,
        onChain: state,
        volume,
        holders,

        holderCount: holders.filter(h => !h.closed).length,
        fees,
        feesSol,
        explorer: `https://explorer.solana.com/address/${mixerId}?cluster=devnet`,
    };
}

module.exports = { getMixerStats, getVolume, getFees };
