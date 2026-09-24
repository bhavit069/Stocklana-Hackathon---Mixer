require('dotenv').config({ quiet: true });

const EMPTY = { investedSol: 0, redeemedSol: 0, netSol: 0, investors: 0, firstTrade: null };

async function investedFor(mixerIds) {
    const ids = [...new Set(mixerIds || [])].filter(Boolean);
    const out = {};
    if (!ids.length) return out;

    try {
        const { query } = require('../database');
        const rows = await query(
            `SELECT mixer_id,
                    coalesce(sum(sol_amount) FILTER (WHERE side = 'buy'),  0) AS invested_sol,
                    coalesce(sum(sol_amount) FILTER (WHERE side = 'sell'), 0) AS redeemed_sol,
                    count(DISTINCT wallet) FILTER (WHERE side = 'buy')        AS investors,
                    min(created_at) AS first_trade
             FROM mixer_trades
             WHERE mixer_id = ANY($1)
             GROUP BY mixer_id`,
            [ids]
        );

        for (const r of rows) {
            const invested = Number(r.invested_sol) || 0;
            const redeemed = Number(r.redeemed_sol) || 0;
            out[r.mixer_id] = {
                investedSol: invested,
                redeemedSol: redeemed,
                netSol: invested - redeemed,
                investors: Number(r.investors) || 0,
                firstTrade: r.first_trade || null,
            };
        }
    } catch (err) {
        console.error('Invested lookup failed:', err.message);
    }

    for (const id of ids) if (!out[id]) out[id] = { ...EMPTY };

    return out;
}

module.exports = { investedFor };
