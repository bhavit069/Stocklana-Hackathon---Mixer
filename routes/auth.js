const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createUser, findUserByEmail, updateUser, findUserById } = require('../database/users.repo');
const { createSolanaWallet } = require('../utils/privy');
const { checkNotAuthenticated } = require('../middleware/auth');
const { signToken, generateUserId } = require('../utils/session');

router.get('/login', checkNotAuthenticated, (req, res) => {
    res.render('login', { error: null });
});

router.get('/register', checkNotAuthenticated, (req, res) => {
    res.render('register', { error: null });
});

router.post('/register', checkNotAuthenticated, async (req, res) => {
    const { username, email, password, referralCode } = req.body;

    if (await findUserByEmail(email)) {
        return res.render('register', { error: 'Email already registered.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        let wallet;
        try {
            wallet = await createSolanaWallet();
        } catch (privyError) {
            console.error(privyError);
            return res.render('register', { error: 'Failed to provision wallet. Registration aborted.' });
        }

        const newUser = {
            userId: generateUserId(),
            username,
            email,
            passwordHash: hashedPassword,
            privyWalletId: wallet.id,
            walletAddress: wallet.address,
            referred_by: referralCode || null
        };

        await createUser(newUser);
        signToken(newUser, res);
        res.redirect('/mixers');

    } catch (err) {
        console.error(err);
        res.render('register', { error: 'An error occurred during registration.' });
    }
});

router.post('/login', checkNotAuthenticated, async (req, res) => {
    const { email, password } = req.body;

    const user = await findUserByEmail(email);

    if (!user || !user.passwordHash) {

        return res.render('login', { error: 'Invalid email or password.' });
    }

    try {
        const match = await bcrypt.compare(password, user.passwordHash);
        if (match) {
            signToken(user, res);
            res.redirect('/mixers');
        } else {
            res.render('login', { error: 'Invalid email or password.' });
        }
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Login failed.' });
    }
});

router.get('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/login');
});

router.get('/forgot-password', checkNotAuthenticated, (req, res) => {
    res.render('forgot-password', { error: null, message: null });
});

router.post('/forgot-password', checkNotAuthenticated, async (req, res) => {
    const { email } = req.body;

    const user = await findUserByEmail(email);

    if (!user) {
        return res.render('forgot-password', { error: null, message: 'If an account exists with this email, a reset link has been sent.' });
    }

    const payload = { userId: user.userId, email: user.email };
    const secret = process.env.JWT_SECRET + user.passwordHash;
    const token = jwt.sign(payload, secret, { expiresIn: '15m' });

    const link = `http://localhost:${process.env.PORT}/reset-password?token=${token}&id=${user.userId}`;
    console.log('------------------------------------------------');
    console.log(`PASSWORD RESET LINK FOR ${user.email}:`);
    console.log(link);
    console.log('------------------------------------------------');

    res.render('forgot-password', { error: null, message: 'If an account exists with this email, a reset link has been sent. Check your console.' });
});

router.get('/reset-password', checkNotAuthenticated, async (req, res) => {
    const { token, id } = req.query;

    if (!token || !id) {
        return res.redirect('/login?error=Invalid reset link');
    }

    const user = await findUserById(id);
    if (!user) {
        return res.redirect('/login?error=Invalid user');
    }

    const secret = process.env.JWT_SECRET + user.passwordHash;
    try {
        jwt.verify(token, secret);
        res.render('reset-password', { token, id, error: null });
    } catch (err) {
        res.redirect('/login?error=Invalid or expired reset link');
    }
});

router.post('/reset-password', checkNotAuthenticated, async (req, res) => {
    const { token, password, confirmPassword } = req.body;

    try {
        const decodedUnverified = jwt.decode(token);
        if (!decodedUnverified || !decodedUnverified.userId) {
            return res.render('reset-password', { token, error: 'Invalid token format.' });
        }

        const user = await findUserById(decodedUnverified.userId);
        if (!user) {
            return res.render('reset-password', { token, error: 'User not found.' });
        }

        const secret = process.env.JWT_SECRET + user.passwordHash;
        jwt.verify(token, secret);

        if (password !== confirmPassword) {
            return res.render('reset-password', { token, error: 'Passwords do not match.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await updateUser(user.userId, { passwordHash: hashedPassword });

        res.redirect('/login?message=Password reset successful. Please login.');

    } catch (err) {
        console.error(err);
        res.render('reset-password', { token, error: 'Invalid or expired token.' });
    }
});

module.exports = router;
