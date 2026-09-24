const { query } = require('../database');

const toOrder = (row) => {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        mixerId: row.mixer_id,
        wallet: row.wallet,
        side: row.side,
        amount: Number(row.amount),
        triggerPrice: Number(row.trigger_price),
        status: row.status,
        lastError: row.last_error,
        fillPrice: row.fill_price != null ? Number(row.fill_price) : null,
        signatures: row.signatures,
        createdAt: row.created_at,
        filledAt: row.filled_at,
    };
};

const createOrder = async (o) => {
    const rows = await query(
        `INSERT INTO limit_orders (user_id, mixer_id, wallet, side, amount, trigger_price)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [o.userId, o.mixerId, o.wallet, o.side, o.amount, o.triggerPrice]
    );
    return toOrder(rows[0]);
};

const fetchOpenOrders = async (mixerId) => {
    const rows = mixerId
        ? await query(`SELECT * FROM limit_orders WHERE status = 'open' AND mixer_id = $1`, [mixerId])
        : await query(`SELECT * FROM limit_orders WHERE status = 'open'`);
    return rows.map(toOrder);
};

const fetchOrdersByUser = async (userId, limit = 50) => {
    const rows = await query(
        `SELECT * FROM limit_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return rows.map(toOrder);
};

const fetchOrdersByMixer = async (mixerId, limit = 50) => {
    const rows = await query(
        `SELECT * FROM limit_orders WHERE mixer_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [mixerId, limit]
    );
    return rows.map(toOrder);
};

const claimOrder = async (id) => {
    const rows = await query(
        `UPDATE limit_orders SET status = 'filling'
         WHERE id = $1 AND status = 'open' RETURNING *`,
        [id]
    );
    return rows.length ? toOrder(rows[0]) : null;
};

const markFilled = async (id, fillPrice, signatures) => {
    const rows = await query(
        `UPDATE limit_orders
         SET status = 'filled', fill_price = $2, signatures = $3, filled_at = now()
         WHERE id = $1 RETURNING *`,
        [id, fillPrice, JSON.stringify(signatures || {})]
    );
    return toOrder(rows[0]);
};

const markFailed = async (id, error) => {
    const rows = await query(
        `UPDATE limit_orders SET status = 'failed', last_error = $2 WHERE id = $1 RETURNING *`,
        [id, String(error).slice(0, 500)]
    );
    return toOrder(rows[0]);
};

const cancelOrder = async (id, userId) => {
    const rows = await query(
        `UPDATE limit_orders SET status = 'cancelled'
         WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING *`,
        [id, userId]
    );
    return rows.length ? toOrder(rows[0]) : null;
};

module.exports = {
    createOrder, fetchOpenOrders, fetchOrdersByUser, fetchOrdersByMixer,
    claimOrder, markFilled, markFailed, cancelOrder,
};
