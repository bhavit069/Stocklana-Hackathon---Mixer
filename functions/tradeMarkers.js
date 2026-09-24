require('dotenv').config({ quiet: true });
const { query } = require('../database');

const DEFAULT_LIMIT = 100;

async function tradeMarkers(mixerId, { limit = DEFAULT_LIMIT, creatorUserId = null } = {}) {
    let rows = [];
    try {
        rows = await query(
            `SELECT t.id, t.user_id, t.wallet, t.side, t.sol_amount,
                    t.shares_delta, t.price_usd, t.created_at,
                    u.username, u.x_username, u.x_profile_picture
             FROM mixer_trades t
             LEFT JOIN users u ON u.user_id = t.user_id
             WHERE t.mixer_id = $1
             ORDER BY t.created_at DESC
             LIMIT $2`,
            [mixerId, limit]
        );
    } catch (err) {
        console.error('Trade markers query failed:', err.message);
        return [];
    }

    return rows
        .map((r) => {
            const ts = new Date(r.created_at).getTime();
            if (!Number.isFinite(ts)) return null;

            const handle = r.x_username || r.username || null;

            return {
                id: String(r.id),

                time: Math.floor(ts / 1000),
                side: r.side === 'sell' ? 'sell' : 'buy',
                solAmount: Number(r.sol_amount) || 0,
                priceUsd: r.price_usd != null ? Number(r.price_usd) : null,
                wallet: r.wallet,
                handle,
                avatar: r.x_profile_picture || null,
                isCreator: creatorUserId != null && r.user_id === creatorUserId,
            };
        })
        .filter(Boolean)

        .sort((a, b) => a.time - b.time);
}

module.exports = { tradeMarkers, DEFAULT_LIMIT };
