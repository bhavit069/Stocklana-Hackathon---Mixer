require('dotenv').config({ quiet: true });
const axios = require('axios');
const redis = require('../redis');

const TTL_OK = 6 * 60 * 60;
const TTL_MISS = 30 * 60;
const KEY = (h) => 'xprofile:' + h.toLowerCase();

let blockedUntil = 0;

const inFlight = new Map();

function validHandle(h) {
    return typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h);
}

function shape(u) {
    const m = u.public_metrics || {};
    return {
        id: u.id,
        username: u.username,
        name: u.name,
        description: u.description || null,
        avatar: u.profile_image_url

            ? String(u.profile_image_url).replace('_normal.', '_400x400.')
            : null,

        banner: u.profile_banner_url
            ? String(u.profile_banner_url).replace(/\/\d+x\d+$/, '') + '/1500x500'
            : null,
        verified: !!u.verified,
        verifiedType: u.verified_type || null,
        createdAt: u.created_at || null,
        followers: m.followers_count ?? null,
        following: m.following_count ?? null,

        posts: m.tweet_count ?? null,
        url: 'https://x.com/' + u.username,
    };
}

async function fetchFromX(handle) {
    const token = (process.env.X_BEARER_TOKEN || '').trim();
    if (!token) {
        const err = new Error('X_BEARER_TOKEN is not set');
        err.code = 'no_token';
        throw err;
    }

    const res = await axios.get(
        'https://api.x.com/2/users/by/username/' + encodeURIComponent(handle),
        {
            headers: { Authorization: 'Bearer ' + token },
            params: {
                'user.fields': [
                    'description', 'profile_image_url', 'profile_banner_url',
                    'public_metrics', 'verified', 'verified_type', 'created_at',
                ].join(','),
            },
            timeout: 6000,
        }
    );

    const u = res.data && res.data.data;
    if (!u) {
        const err = new Error('No such X user');
        err.code = 'not_found';
        throw err;
    }
    return shape(u);
}

async function getXProfile(handle) {
    if (!validHandle(handle)) return null;

    const key = KEY(handle);

    try {
        const hit = await redis.get(key);
        if (hit) return hit === 'null' ? null : JSON.parse(hit);
    } catch { }

    if (Date.now() < blockedUntil) return null;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
        try {
            const profile = await fetchFromX(handle);
            try { await redis.setEx(key, TTL_OK, JSON.stringify(profile)); } catch { }
            return profile;
        } catch (err) {
            const status = err.response && err.response.status;
            const reason = err.response && err.response.data && err.response.data.reason;

            if (status === 429) {

                const reset = Number(err.response.headers['x-rate-limit-reset']);
                blockedUntil = Number.isFinite(reset) && reset > 0
                    ? reset * 1000
                    : Date.now() + 15 * 60 * 1000;
                console.warn('X rate limit hit; profile lookups parked until',
                    new Date(blockedUntil).toISOString());
                return null;
            }

            if (status === 404) {

                try { await redis.setEx(key, TTL_MISS, 'null'); } catch {  }
                return null;
            }

            if (status === 402) {
                blockedUntil = Date.now() + 30 * 60 * 1000;
                console.warn(
                    'X profile lookups paused: the X API account is out of credits. ' +
                    'Add credit at developer.x.com to re-enable creator hover cards.'
                );
                return null;
            }

            if (status === 403 && reason === 'client-not-enrolled') {
                blockedUntil = Date.now() + 10 * 60 * 1000;
                console.warn(
                    'X profile lookup unavailable: this app is not attached to a Project. ' +
                    'Attach it at developer.x.com to enable creator hover cards.'
                );
                return null;
            }

            console.error('X profile lookup failed for @' + handle + ':',
                (err.response && err.response.data) || err.message);
            return null;
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, p);
    return p;
}

module.exports = { getXProfile, validHandle };
