const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { getXProfile, validHandle } = require('../functions/xProfile');
const { findUserByXUsername } = require('../database/users.repo');

router.get('/api/x-profile/:handle', checkAuthenticated, async (req, res) => {
    const handle = String(req.params.handle || '').replace(/^@/, '');

    if (!validHandle(handle)) {
        return res.json({ ok: false, reason: 'invalid_handle' });
    }

    try {
        const profile = await getXProfile(handle);
        if (profile) {

            res.set('Cache-Control', 'private, max-age=600');
            return res.json({ ok: true, profile });
        }

        const u = await findUserByXUsername(handle);
        if (u && u.xUsername) {
            res.set('Cache-Control', 'private, max-age=300');
            return res.json({
                ok: true,
                partial: true,
                profile: {
                    id: u.xID,
                    username: u.xUsername,

                    name: u.xUsername,
                    description: null,

                    avatar: u.xProfilePicture
                        ? String(u.xProfilePicture).replace('_normal.', '_400x400.')
                        : null,
                    banner: null,
                    verified: false,
                    createdAt: null,
                    followers: null,
                    following: null,
                    url: 'https://x.com/' + u.xUsername,
                },
            });
        }

        return res.json({ ok: false, reason: 'unavailable' });
    } catch (err) {
        console.error('X profile route failed:', err.message);
        res.json({ ok: false, reason: 'error' });
    }
});

module.exports = router;
