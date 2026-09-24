
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const MEME_DURATIONS = [
    { ms: 15 * MINUTE, label: '15 minutes', short: '15m', unit: 'minutes' },
    { ms: 30 * MINUTE, label: '30 minutes', short: '30m', unit: 'minutes' },
    { ms: 45 * MINUTE, label: '45 minutes', short: '45m', unit: 'minutes' },
    { ms: 1 * HOUR,    label: '1 hour',     short: '1h',  unit: 'hours' },
    { ms: 4 * HOUR,    label: '4 hours',    short: '4h',  unit: 'hours' },
    { ms: 12 * HOUR,   label: '12 hours',   short: '12h', unit: 'hours' },
    { ms: 24 * HOUR,   label: '1 day',      short: '1d',  unit: 'days' },
    { ms: 72 * HOUR,   label: '3 days',     short: '3d',  unit: 'days' },
    { ms: 168 * HOUR,  label: '7 days',     short: '7d',  unit: 'days' },
];

const MIN_MEME_MS = MEME_DURATIONS[0].ms;

const BY_MS = MEME_DURATIONS.reduce((a, d) => { a[d.ms] = d; return a; }, {});

function isMemeDuration(ms) {
    const n = Number(ms);
    return Number.isFinite(n) && Object.prototype.hasOwnProperty.call(BY_MS, n);
}

function describeDuration(ms) {
    return BY_MS[Number(ms)] || null;
}

function lifecycle(mixer, now = Date.now()) {
    if (!mixer || !mixer.expires_at) return null;

    const expiresAt = new Date(mixer.expires_at).getTime();
    const settledAt = mixer.settled_at ? new Date(mixer.settled_at).getTime() : null;

    if (settledAt) {
        return { state: 'settled', expiresAt, settledAt, remainingMs: 0 };
    }
    if (now >= expiresAt) {

        return { state: 'expired', expiresAt, settledAt: null, remainingMs: 0 };
    }
    return { state: 'live', expiresAt, settledAt: null, remainingMs: expiresAt - now };
}

function formatRemaining(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '0s';

    const s = Math.floor(n / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

module.exports = {
    MEME_DURATIONS,
    MIN_MEME_MS,
    isMemeDuration,
    describeDuration,
    lifecycle,
    formatRemaining,
};
