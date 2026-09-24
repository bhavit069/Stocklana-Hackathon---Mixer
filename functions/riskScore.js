
const redis = require('../redis');

const WHITELIST_RISK = 5;

const WHITELISTED = new Set([
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
]);

const LIQ_THIN = 100_000;
const LIQ_SMALL = 1_000_000;

const LIQ_PENALTY_THIN = 25;
const LIQ_PENALTY_SMALL = 12;

const VERIFIED_SCORE_DISCOUNT = 0.4;

const VERIFIED_FLAT_DISCOUNT = 10;

function clamp(n) {
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
}

function liquidityPenalty(liquidity) {
    const l = Number(liquidity);
    if (!Number.isFinite(l) || l <= 0) return 0;
    if (l < LIQ_THIN) return LIQ_PENALTY_THIN;
    if (l < LIQ_SMALL) return LIQ_PENALTY_SMALL;
    return 0;
}

function tokenRisk(token) {
    if (!token) return null;

    if (token.rugged === true) return 100;

    const verified = token.is_verified === true;
    const mint = token.mint_authority === true;
    const freeze = token.freeze_authority === true;
    const liqPenalty = liquidityPenalty(token.liquidity);

    const raw = token.score_normalised;
    let base = (raw === null || raw === undefined || raw === '')
        ? NaN
        : Number(raw);

    const whitelisted = !!(token.address && WHITELISTED.has(token.address));

    if (!Number.isFinite(base)) {
        if (whitelisted) {
            base = WHITELIST_RISK;
        } else if (!mint && !freeze && liqPenalty === 0) {

            return null;
        } else {

            base = 0;
        }
    }

    let risk = base;

    if (verified) {
        risk = risk * (1 - VERIFIED_SCORE_DISCOUNT) - VERIFIED_FLAT_DISCOUNT;
    }

    if (!verified) {
        if (mint) risk += 20;
        if (freeze) risk += 20;
    }

    risk += liqPenalty;

    risk = clamp(risk);

    if (whitelisted) risk = Math.max(risk, WHITELIST_RISK);

    if (!verified) {
        if (mint && freeze) risk = Math.max(risk, 60);
        else if (mint || freeze) risk = Math.max(risk, 40);
    }

    return clamp(risk);
}

function basketRisk(allocations) {
    const out = {
        score: null,
        coverage: 0,
        rugged: [],
        highRisk: [],
        thin: [],
        unverified: [],
        ruggedWeight: 0,
        thinWeight: 0,
        unrated: [],
    };
    if (!Array.isArray(allocations) || !allocations.length) return out;

    let weighted = 0;
    let ratedWeight = 0;
    let totalWeight = 0;
    let dangerWeight = 0;
    let thinWeight = 0;
    let unverifiedWeight = 0;

    for (const a of allocations) {
        const w = Number(a.weight);
        if (!Number.isFinite(w) || w <= 0) continue;
        totalWeight += w;

        const t = a.token || {};
        const token = { ...t, address: t.address || a.token_address };
        const symbol = t.symbol || (a.token_address ? a.token_address.slice(0, 6) : '?');
        const risk = tokenRisk(token);

        const liq = Number(token.liquidity);
        const isThin = Number.isFinite(liq) && liq > 0 && liq < LIQ_SMALL;
        const isVerified = token.is_verified === true;

        if (isThin) {
            thinWeight += w;
            out.thin.push(symbol);
        }
        if (!isVerified) {
            unverifiedWeight += w;
            out.unverified.push(symbol);
        }

        if (risk === null) {
            out.unrated.push(symbol);
            continue;
        }

        weighted += risk * w;
        ratedWeight += w;

        if (t.rugged === true) {

            out.rugged.push(symbol);
            out.ruggedWeight += w;
            dangerWeight += w;
        } else if (risk >= 70 && !isVerified) {

            out.highRisk.push(symbol);
            dangerWeight += w;
        }
    }

    if (ratedWeight <= 0) return out;

    out.coverage = totalWeight > 0
        ? Math.round((ratedWeight / totalWeight) * 100)
        : 0;

    const mean = weighted / ratedWeight;

    const exposure = ratedWeight > 0 ? dangerWeight / ratedWeight : 0;
    const penalty = exposure * 30;

    const thinShare = totalWeight > 0 ? thinWeight / totalWeight : 0;
    const unverifiedShare = totalWeight > 0 ? unverifiedWeight / totalWeight : 0;
    const thinUnverified = Math.min(thinShare, unverifiedShare) * 20;

    out.score = Math.round(clamp(mean + penalty + thinUnverified));
    out.ruggedWeight = totalWeight > 0
        ? Math.round((out.ruggedWeight / totalWeight) * 100)
        : 0;
    out.thinWeight = Math.round(thinShare * 100);

    return out;
}

async function withLiquidity(allocations) {
    if (!Array.isArray(allocations) || !allocations.length) return allocations;
    try {
        const addrs = allocations.map(a => (a.token && a.token.address) || a.token_address);
        const vals = await redis.hmGet('liquidity', addrs);
        return allocations.map((a, i) => {
            const l = Number(vals[i]);
            if (!Number.isFinite(l)) return a;
            return { ...a, token: { ...(a.token || {}), liquidity: l } };
        });
    } catch {
        return allocations;
    }
}

function riskBand(score) {
    if (score == null || !Number.isFinite(score)) {
        return { label: 'Unrated', colour: '#5a616b' };
    }
    if (score <= 35) return { label: 'Low risk', colour: '#22c55e' };
    if (score <= 60) return { label: 'Medium risk', colour: '#eab308' };
    return { label: 'High risk', colour: '#f6465d' };
}

module.exports = {
    tokenRisk,
    basketRisk,
    withLiquidity,
    riskBand,
    liquidityPenalty,
    WHITELISTED,
    WHITELIST_RISK,
    LIQ_THIN,
    LIQ_SMALL,
};
