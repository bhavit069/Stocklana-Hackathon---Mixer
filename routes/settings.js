
const express = require('express');
const router = express.Router();

const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');

function safeNext(next) {
    if (typeof next !== 'string' || next.length > 300) return null;
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
    return next;
}

router.get('/settings', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) {
            res.clearCookie('token');
            return res.redirect('/login');
        }

        const { xLinked, xUnlinked, xError, needsX } = req.query;
        res.render('settings', {
            user,
            xLinked: !!xLinked,
            xUnlinked: !!xUnlinked,
            xError: xError ? String(xError).slice(0, 300) : null,
            needsX: !!needsX,
            next: safeNext(req.query.next),
        });
    } catch (err) {
        console.error('Settings failed:', err);
        res.status(500).send('Could not load settings');
    }
});

module.exports = router;
