
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const { createChallenge, verifyChallenge, isValidAddress } = require('../utils/walletAuth');
const { signToken, generateUserId } = require('../utils/session');
const { createSolanaWallet } = require('../utils/privy');
const {
    createUser,
    findUserByAuthWallet,
    findUserByEmail,
    findUserByUsername
} = require('../database/users.repo');

const PENDING_TTL = '15m';

router.post('/auth/wallet/nonce', async (req, res) => {
    const { address } = req.body;

    if (!isValidAddress(address)) {
        return res.status(400).json({ error: 'Invalid Solana address' });
    }

    try {
        const { message } = await createChallenge(address);
        res.json({ message });
    } catch (err) {
        console.error('Wallet nonce error:', err.message);
        res.status(500).json({ error: 'Could not start wallet sign-in' });
    }
});

router.post('/auth/wallet/verify', async (req, res) => {
    const { address, signature } = req.body;

    if (!isValidAddress(address) || !signature) {
        return res.status(400).json({ error: 'Missing address or signature' });
    }

    try {
        const ok = await verifyChallenge(address, signature);
        if (!ok) {
            return res.status(401).json({ error: 'Signature verification failed. Please try again.' });
        }

        const user = await findUserByAuthWallet(address);

        if (user) {
            signToken(user, res);
            return res.json({ redirect: '/mixers' });
        }

        const pendingToken = jwt.sign({ authWalletAddress: address }, process.env.JWT_SECRET, {
            expiresIn: PENDING_TTL
        });
        res.cookie('pendingWallet', pendingToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 15 * 60 * 1000
        });

        return res.json({ redirect: '/complete-wallet-signup' });
    } catch (err) {
        console.error('Wallet verify error:', err);
        res.status(500).json({ error: 'Sign-in failed' });
    }
});

router.get('/complete-wallet-signup', (req, res) => {
    const pending = req.cookies.pendingWallet;
    if (!pending) return res.redirect('/login');

    try {
        const { authWalletAddress } = jwt.verify(pending, process.env.JWT_SECRET);
        res.render('complete-wallet', { walletAddress: authWalletAddress, error: null });
    } catch (err) {
        res.clearCookie('pendingWallet');
        res.redirect('/login?error=Session Expired');
    }
});

router.post('/complete-wallet-signup', async (req, res) => {
    const pending = req.cookies.pendingWallet;
    if (!pending) return res.redirect('/login');

    let authWalletAddress;
    try {
        ({ authWalletAddress } = jwt.verify(pending, process.env.JWT_SECRET));
    } catch (err) {
        res.clearCookie('pendingWallet');
        return res.redirect('/login?error=Session Expired');
    }

    const { username, email, password } = req.body;
    const rerender = (error) =>
        res.render('complete-wallet', { walletAddress: authWalletAddress, error });

    if (!username || !email) {
        return rerender('Username and email are required.');
    }

    try {

        if (await findUserByAuthWallet(authWalletAddress)) {
            res.clearCookie('pendingWallet');
            return res.redirect('/login?error=Wallet already registered.');
        }
        if (await findUserByEmail(email)) {
            return rerender('Email already registered.');
        }
        if (await findUserByUsername(username)) {
            return rerender('Username is already taken.');
        }

        let privyWallet;
        try {
            privyWallet = await createSolanaWallet();
        } catch (privyError) {
            console.error('Privy Error:', privyError);
            return rerender('Failed to provision wallet. Please try again.');
        }

        const newUser = {
            userId: generateUserId(),
            username,
            email,

            passwordHash: password ? await bcrypt.hash(password, 10) : null,
            privyWalletId: privyWallet.id,
            walletAddress: privyWallet.address,
            authWalletAddress,
            referred_by: req.body.referralCode || null
        };

        await createUser(newUser);

        res.clearCookie('pendingWallet');
        signToken(newUser, res);
        res.redirect('/mixers');
    } catch (err) {
        console.error('Wallet signup error:', err);
        rerender('An error occurred during signup.');
    }
});

module.exports = router;
