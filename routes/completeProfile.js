const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createSolanaWallet } = require('../utils/privy');
const { createUser, findUserByEmail, findUserByXId, findUserByUsername } = require('../database/users.repo');

const signToken = (user, res) => {
    const payload = {
        userId: user.userId,
        privyWalletId: user.privyWalletId
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 3600000
    };
    res.cookie('token', token, cookieOptions);
};

router.get('/complete-x-signup', (req, res) => {
    const pendingToken = req.cookies.pendingToken;

    if (!pendingToken) {
        return res.redirect('/login');
    }

    try {
        const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
        res.render('complete-profile', {
            username: decoded.xUsername,
            error: null
        });
    } catch (err) {
        res.clearCookie('pendingToken');
        return res.redirect('/login?error=Session Expired');
    }
});

router.post('/complete-x-signup', async (req, res) => {
    const pendingToken = req.cookies.pendingToken;
    const { username, email, password, referralCode } = req.body;

    if (!pendingToken) {
        return res.redirect('/login');
    }

    let xData;
    try {
        xData = jwt.verify(pendingToken, process.env.JWT_SECRET);
    } catch (err) {
        res.clearCookie('pendingToken');
        return res.redirect('/login?error=Session Expired');
    }

    if (await findUserByXId(xData.xID)) {
        res.clearCookie('pendingToken');
        return res.redirect('/login?error=Account already exists.');
    }

    if (await findUserByEmail(email)) {
        return res.render('complete-profile', { username, email, error: 'Email already registered.' });
    }

    if (await findUserByUsername(username)) {
        return res.render('complete-profile', { username, email, error: 'Username is already taken.' });
    }

    let wallet;
    try {
        wallet = await createSolanaWallet();
    } catch (privyError) {
        console.error("Privy Error:", privyError);
        return res.render('complete-profile', { username, email, error: 'Failed to provision wallet.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const generateId = () => {
        const part = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
        return `${part()}-${part()}-${part()}-${part()}-${part()}`;
    };

    const newUser = {
        userId: generateId(),
        username: username || xData.xUsername,
        email,
        xID: xData.xID,
        xUsername: xData.xUsername,
        xProfilePicture: xData.xProfilePicture,
        privyWalletId: wallet.id,
        walletAddress: wallet.address,
        passwordHash: hashedPassword,
        referred_by: referralCode || null
    };

    await createUser(newUser);

    res.clearCookie('pendingToken');
    signToken(newUser, res);
    res.redirect('/dashboard');
});

module.exports = router;
