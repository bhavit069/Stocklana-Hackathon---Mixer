const { query } = require('../database');

const toTrade = (row) => {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        mixerId: row.mixer_id,
        wallet: row.wallet,
        side: row.side,
        solAmount: Number(row.sol_amount),
        sharesDelta: row.shares_delta,
        sharesAfter: row.shares_after,
        priceUsd: row.price_usd != null ? Number(row.price_usd) : null,
        signatures: row.signatures,
        createdAt: row.created_at,
    };
};

const recordTrade = async (t) => {
    const rows = await query(
        `INSERT INTO mixer_trades
            (user_id, mixer_id, wallet, side, sol_amount, shares_delta, shares_after, price_usd, signatures)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
            t.userId, t.mixerId, t.wallet, t.side || 'buy',
            t.solAmount, t.sharesDelta, t.sharesAfter,
            t.priceUsd != null ? t.priceUsd : null,
            JSON.stringify(t.signatures || {}),
        ]
    );
    return toTrade(rows[0]);
};

const fetchTradesByUser = async (userId, limit = 50) => {
    const rows = await query(
        `SELECT * FROM mixer_trades WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return rows.map(toTrade);
};

const fetchTradesByMixer = async (mixerId, limit = 50) => {
    const rows = await query(
        `SELECT * FROM mixer_trades WHERE mixer_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [mixerId, limit]
    );
    return rows.map(toTrade);
};

const fetchUserCostBasis = async (userId) => {
    const rows = await query(
        `SELECT mixer_id,
                sum(CASE WHEN side = 'buy' THEN sol_amount ELSE -sol_amount END) AS net_sol,
                coalesce(sum(sol_amount) FILTER (WHERE side = 'buy'), 0) AS bought_sol,
                coalesce(sum(sol_amount) FILTER (WHERE side = 'sell'), 0) AS sold_sol,
                coalesce(sum(abs(shares_delta)) FILTER (WHERE side = 'buy'), 0) AS bought_shares,
                count(*) AS trade_count,
                min(created_at) AS first_trade,
                max(created_at) AS last_trade
         FROM mixer_trades
         WHERE user_id = $1
         GROUP BY mixer_id`,
        [userId]
    );
    return rows.map(r => ({
        mixerId: r.mixer_id,
        netSol: Number(r.net_sol),
        boughtSol: Number(r.bought_sol),
        soldSol: Number(r.sold_sol),
        boughtShares: Number(r.bought_shares),
        tradeCount: Number(r.trade_count),
        firstTrade: r.first_trade,
        lastTrade: r.last_trade,
    }));
};

const fetchAvgBuyPriceUsd = async (userId, mixerId) => {
    const rows = await query(
        `SELECT coalesce(sum(sol_amount * price_usd), 0) AS weighted,
                coalesce(sum(sol_amount), 0) AS total_sol
         FROM mixer_trades
         WHERE user_id = $1 AND mixer_id = $2 AND side = 'buy' AND price_usd IS NOT NULL`,
        [userId, mixerId]
    );
    const totalSol = Number(rows[0] && rows[0].total_sol) || 0;
    if (totalSol <= 0) return null;
    return Number(rows[0].weighted) / totalSol;
};

module.exports = {
    recordTrade,
    fetchTradesByUser,
    fetchTradesByMixer,
    fetchUserCostBasis,
    fetchAvgBuyPriceUsd,
};
