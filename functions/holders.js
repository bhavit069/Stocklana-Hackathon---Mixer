require('dotenv').config({ quiet: true });
const { PublicKey } = require('@solana/web3.js');
const { anchor, programFor } = require('./solanaConfig');

const MIXER_OFFSET = 8 + 32;

let cache = new Map();

const CACHE_MS = 120_000;

async function getHolders(mixerId, { force = false } = {}) {
    const hit = cache.get(mixerId);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.holders;

    const program = programFor(anchor.web3.Keypair.generate());

    const accounts = await program.account.userPosition.all([
        { memcmp: { offset: MIXER_OFFSET, bytes: mixerId } },
    ]);

    const holders = accounts
        .map(a => ({
            owner: a.account.owner.toBase58(),
            position: a.publicKey.toBase58(),
            shares: a.account.shares.toString(),
        }))
        .filter(h => BigInt(h.shares) > 0n)
        .sort((a, b) => (BigInt(b.shares) > BigInt(a.shares) ? 1 : -1));

    const total = holders.reduce((s, h) => s + BigInt(h.shares), 0n);

    const withPct = holders.map((h, i) => ({
        ...h,
        rank: i + 1,

        percent: total > 0n
            ? Number((BigInt(h.shares) * 10000n) / total) / 100
            : 0,
    }));

    cache.set(mixerId, { at: Date.now(), holders: withPct });
    return withPct;
}

function invalidate(mixerId) {
    cache.delete(mixerId);
}

async function getHoldersEnriched(mixerId, { solPerShare = null, valueShares = null, withBalances = false } = {}) {
    const { query } = require('../database');
    const { connection } = require('./solanaConfig');
    const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

    const current = await getHolders(mixerId);

    let rows = [];
    try {
        rows = await query(
            `SELECT wallet,
                    sum(CASE WHEN side = 'buy'  THEN sol_amount ELSE 0 END)   AS bought_sol,
                    sum(CASE WHEN side = 'buy'  THEN shares_delta ELSE 0 END) AS bought_shares,
                    sum(CASE WHEN side = 'sell' THEN sol_amount ELSE 0 END)   AS sold_sol,
                    sum(CASE WHEN side = 'sell' THEN shares_delta ELSE 0 END) AS sold_shares,
                    min(created_at) AS first_trade,
                    max(created_at) AS last_trade,
                    count(*) AS trade_count
             FROM mixer_trades
             WHERE mixer_id = $1 AND wallet IS NOT NULL
             GROUP BY wallet`,
            [mixerId]
        );
    } catch (err) {
        console.error('Holder history query failed:', err.message);
    }

    const byWallet = rows.reduce((a, r) => { a[r.wallet] = r; return a; }, {});

    const seen = new Set(current.map(h => h.owner));
    const holders = current.concat(
        rows
            .filter(r => !seen.has(r.wallet))
            .map(r => ({ owner: r.wallet, shares: '0', closed: true }))
    );

    if (!holders.length) return [];

    const out = [];
    for (const h of holders) {
        const r = byWallet[h.owner] || {};

        const boughtSol = Number(r.bought_sol || 0);
        const boughtShares = Number(r.bought_shares || 0);
        const soldSol = Number(r.sold_sol || 0);
        const soldShares = Number(r.sold_shares || 0);

        const avgBuy = boughtShares > 0 ? boughtSol / boughtShares : null;
        const avgSell = soldShares > 0 ? soldSol / soldShares : null;

        const remainingShares = Number(h.shares);
        let remainingSol = null;
        if (typeof valueShares === 'function') {
            try {
                remainingSol = valueShares(h.shares);
            } catch (err) {
                console.error('Share valuation failed for', h.owner + ':', err.message);
            }
        } else if (solPerShare != null) {
            remainingSol = remainingShares * solPerShare;
        }

        let unrealisedPnl = null;
        let unrealisedPct = null;

        let costOfRemaining = null;
        if (remainingSol != null && boughtShares > 0 && boughtSol > 0) {
            const heldFraction = Math.min(1, remainingShares / boughtShares);
            costOfRemaining = boughtSol * heldFraction;
            if (costOfRemaining > 0) {
                unrealisedPnl = remainingSol - costOfRemaining;
                unrealisedPct = (unrealisedPnl / costOfRemaining) * 100;
            }
        }

        let solBalance = null;
        if (withBalances) {
            try {
                solBalance = (await connection.getBalance(new PublicKey(h.owner))) / LAMPORTS_PER_SOL;
            } catch { }
        }

        let realisedPnl = null;
        let realisedPct = null;
        if (soldShares > 0 && boughtShares > 0 && boughtSol > 0) {
            const soldFraction = Math.min(1, soldShares / boughtShares);
            const costOfSold = boughtSol * soldFraction;
            if (costOfSold > 0) {
                realisedPnl = soldSol - costOfSold;
                realisedPct = (realisedPnl / costOfSold) * 100;
            }
        }

        out.push({
            ...h,
            solBalance,
            boughtSol, boughtShares, avgBuy,
            soldSol, soldShares, avgSell,
            remainingShares: h.shares,
            remainingSol,
            costOfRemaining,
            unrealisedPnl,
            unrealisedPct,
            realisedPnl,
            realisedPct,

            closed: !!h.closed || BigInt(h.shares || '0') === 0n,
            firstTrade: r.first_trade || null,
            lastTrade: r.last_trade || null,
            tradeCount: Number(r.trade_count || 0),
            heldMs: r.first_trade ? Date.now() - new Date(r.first_trade).getTime() : null,
        });
    }

    return out;
}

module.exports = { getHolders, getHoldersEnriched, invalidate };
