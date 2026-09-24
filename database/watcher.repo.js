
const { query } = require('../database');

const fetchWatchlist = async () => {
    const rows = await query(
        'SELECT token_address FROM token_watchlist'
    );

    return rows.map(row => row.token_address);
};

const addToWatchlist = async (tokenAddress) => {
    const sql = `
        INSERT INTO token_watchlist (token_address)
        VALUES ($1)
        ON CONFLICT (token_address) DO NOTHING
    `;

    await query(sql, [tokenAddress]);
};

module.exports = {
    fetchWatchlist,
    addToWatchlist
};
