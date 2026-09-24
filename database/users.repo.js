const { query } = require('../database');

const toUser = (row) => {
    if (!row) return null;
    return {
        userId: row.user_id,
        username: row.username,
        email: row.email,
        passwordHash: row.password_hash,
        privyWalletId: row.privy_wallet_id,
        walletAddress: row.wallet_address,

        authWalletAddress: row.auth_wallet_address,
        referred_by: row.referred_by,
        xID: row.x_id,
        xUsername: row.x_username,
        xProfilePicture: row.x_profile_picture,
        createdAt: row.created_at
    };
};

const findUserById = async (id) => {
    const rows = await query('SELECT * FROM users WHERE user_id = $1', [id]);
    return toUser(rows[0]);
};

const findUserByEmail = async (email) => {
    const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
    return toUser(rows[0]);
};

const findUserByUsername = async (username) => {
    const rows = await query('SELECT * FROM users WHERE username = $1', [username]);
    return toUser(rows[0]);
};

const findUserByXId = async (xId) => {
    const rows = await query('SELECT * FROM users WHERE x_id = $1', [xId]);
    return toUser(rows[0]);
};

const findUserByXUsername = async (handle) => {
    if (!handle) return null;
    const rows = await query(
        'SELECT * FROM users WHERE lower(x_username) = lower($1)', [handle]
    );
    return toUser(rows[0]);
};

const findUserByAuthWallet = async (address) => {
    const rows = await query('SELECT * FROM users WHERE auth_wallet_address = $1', [address]);
    return toUser(rows[0]);
};

const createUser = async (user) => {
    const sql = `
        INSERT INTO users (
            user_id, username, email, password_hash,
            privy_wallet_id, wallet_address, auth_wallet_address, referred_by,
            x_id, x_username, x_profile_picture
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
    `;
    const params = [
        user.userId,
        user.username,
        user.email,
        user.passwordHash || null,
        user.privyWalletId,
        user.walletAddress,
        user.authWalletAddress || null,
        user.referred_by || null,
        user.xID || null,
        user.xUsername || null,
        user.xProfilePicture || null
    ];

    const rows = await query(sql, params);
    return toUser(rows[0]);
};

const updateUser = async (userId, updates) => {

    const map = {
        passwordHash: 'password_hash',
        authWalletAddress: 'auth_wallet_address',
        xID: 'x_id',
        xUsername: 'x_username',
        xProfilePicture: 'x_profile_picture'
    };

    const keys = Object.keys(updates);
    if (keys.length === 0) return findUserById(userId);

    const setClauses = [];
    const params = [userId];
    let idx = 2;

    keys.forEach(key => {
        if (map[key]) {
            setClauses.push(`${map[key]} = $${idx}`);
            params.push(updates[key]);
            idx++;
        }
    });

    if (setClauses.length === 0) return findUserById(userId);

    const sql = `
        UPDATE users
        SET ${setClauses.join(', ')}
        WHERE user_id = $1
        RETURNING *
    `;

    const rows = await query(sql, params);
    return toUser(rows[0]);
};

module.exports = {
    findUserById,
    findUserByEmail,
    findUserByUsername,
    findUserByXId,
    findUserByXUsername,
    findUserByAuthWallet,
    createUser,
    updateUser
};
