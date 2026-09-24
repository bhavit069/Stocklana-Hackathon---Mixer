
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const querystring = require('querystring');

const { checkAuthenticated } = require('../middleware/auth');
const { findUserByXId, findUserById, updateUser } = require('../database/users.repo');

const OAUTH_COOKIE = 'xOAuth';

function safeNext(next) {
    if (typeof next !== 'string' || next.length > 300) return null;
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
    return next;
}

function withFlag(path, flag) {
    return path + (path.includes('?') ? '&' : '?') + flag;
}

const SETTINGS = '/settings';
const base64url = (buf) => buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const CLIENT_ID = process.env.X_OAUTH_TWO_CLIENT_ID || process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_OAUTH_TWO_CLIENT_SECRET || process.env.X_CLIENT_SECRET;

router.get('/link/x', checkAuthenticated, (req, res) => {
    const state = base64url(crypto.randomBytes(24));
    const codeVerifier = base64url(crypto.randomBytes(48));
    const codeChallenge = base64url(
        crypto.createHash('sha256').update(codeVerifier).digest()
    );

    const stash = jwt.sign(
        { state, codeVerifier, userId: req.user.userId, next: safeNext(req.query.next) },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    );
    res.cookie(OAUTH_COOKIE, stash, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000
    });

    const params = {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: process.env.X_CALLBACK_URL,
        scope: 'users.read tweet.read',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    };

    res.redirect(`https://x.com/i/oauth2/authorize?${querystring.stringify(params)}`);
});

router.get('/auth/x/callback', checkAuthenticated, async (req, res) => {
    const { code, state, error } = req.query;
    const stash = req.cookies[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE);

    if (error || !code) {
        return res.redirect(SETTINGS + '?xError=' + encodeURIComponent('X authorization was cancelled'));
    }
    if (!stash) {
        return res.redirect(SETTINGS + '?xError=' + encodeURIComponent('Link session expired, please try again'));
    }

    let saved;
    try {
        saved = jwt.verify(stash, process.env.JWT_SECRET);
    } catch {
        return res.redirect(SETTINGS + '?xError=' + encodeURIComponent('Link session expired, please try again'));
    }

    if (saved.state !== state || saved.userId !== req.user.userId) {
        return res.redirect(SETTINGS + '?xError=' + encodeURIComponent('Invalid link request'));
    }

    try {
        const tokenParams = new URLSearchParams();
        tokenParams.append('code', code);
        tokenParams.append('grant_type', 'authorization_code');
        tokenParams.append('client_id', CLIENT_ID);
        tokenParams.append('redirect_uri', process.env.X_CALLBACK_URL);
        tokenParams.append('code_verifier', saved.codeVerifier);

        const tokenRes = await axios.post('https://api.x.com/2/oauth2/token', tokenParams, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(
                    `${CLIENT_ID}:${CLIENT_SECRET}`
                ).toString('base64')
            }
        });

        const userRes = await axios.get('https://api.x.com/2/users/me', {
            headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}` },
            params: { 'user.fields': 'profile_image_url' }
        });

        const xData = userRes.data.data;

        const existing = await findUserByXId(xData.id);
        if (existing && existing.userId !== req.user.userId) {
            return res.redirect(SETTINGS + '?xError=' +
                encodeURIComponent('That X account is already linked to another Mixer account'));
        }

        await updateUser(req.user.userId, {
            xID: xData.id,
            xUsername: xData.username,
            xProfilePicture: xData.profile_image_url || null
        });

        res.redirect(withFlag(safeNext(saved.next) || SETTINGS, 'xLinked=1'));
    } catch (err) {
        const status = err.response && err.response.status;
        const detail = err.response ? err.response.data : err.message;

        console.error('X link error:', status, JSON.stringify(detail));

        let reason = 'Could not link X account';
        const apiReason = detail && detail.reason;
        const oauthError = detail && detail.error;

        if (apiReason === 'client-not-enrolled') {
            reason = 'This X app is not attached to a Project yet — add it at developer.x.com';
        } else if (oauthError === 'unauthorized_client') {

            reason = 'This X app is not set up for OAuth 2.0 — enable User authentication ' +
                     'and set the app type to "Web App" at developer.x.com';
        } else if (status === 402) {
            reason = 'The X API account is out of credits — add credit at developer.x.com';
        } else if (status === 401) {
            reason = 'X rejected the app credentials — check X_OAUTH_TWO_CLIENT_ID and X_OAUTH_TWO_CLIENT_SECRET';
        } else if (status === 403) {
            reason = 'X refused the request — the app may be missing the users.read scope';
        } else if (detail && detail.error_description) {

            reason = 'X said: ' + detail.error_description;
        }

        res.redirect(SETTINGS + '?xError=' + encodeURIComponent(reason));
    }
});

router.post('/link/x/disconnect', checkAuthenticated, async (req, res) => {
    try {
        await updateUser(req.user.userId, {
            xID: null,
            xUsername: null,
            xProfilePicture: null
        });
        res.redirect(SETTINGS + '?xUnlinked=1');
    } catch (err) {
        console.error('X unlink error:', err);
        res.redirect(SETTINGS + '?xError=' + encodeURIComponent('Could not unlink X account'));
    }
});

module.exports = router;
