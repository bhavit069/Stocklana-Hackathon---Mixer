
const jwt = require('jsonwebtoken');

const TOKEN_TTL_MS = 3600000;

function signToken(user, res) {
    const payload = {
        userId: user.userId,
        walletAddress: user.walletAddress,
        privyWalletId: user.privyWalletId,
        username: user.username
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: TOKEN_TTL_MS
    });

    return token;
}

function generateUserId() {
    const part = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${part()}-${part()}-${part()}-${part()}-${part()}`;
}

module.exports = { signToken, generateUserId };
