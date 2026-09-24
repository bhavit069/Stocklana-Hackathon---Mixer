require('dotenv').config({ quiet: true });
const { createMint, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { connection, keypairFromBase58 } = require('./solanaConfig');
const { query } = require('../database');

async function getMirror(realMint) {
    const rows = await query(
        'SELECT real_mint, mirror_mint, decimals, token_program, rate FROM mirror_mints WHERE real_mint = $1',
        [realMint]
    );
    return rows[0] || null;
}

async function getRealForMirror(mirrorMint) {
    const rows = await query(
        'SELECT real_mint, mirror_mint, decimals, token_program, rate FROM mirror_mints WHERE mirror_mint = $1',
        [mirrorMint]
    );
    return rows[0] || null;
}

async function allMirrors() {
    const rows = await query('SELECT real_mint, mirror_mint FROM mirror_mints');
    return rows.reduce((a, r) => { a[r.real_mint] = r.mirror_mint; return a; }, {});
}

async function ensureMirror(token, rate = null) {
    const realMint = token.address;

    const existing = await getMirror(realMint);
    if (existing) return { ...existing, created: false };

    const secret = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!secret) throw new Error('MIXER_CREATOR_SECRET_KEY is not configured');
    const payer = keypairFromBase58(secret);

    const decimals = Number(token.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error(`Token ${token.symbol || realMint} has unusable decimals: ${token.decimals}`);
    }

    const mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        decimals,
        undefined,
        { commitment: 'confirmed' },
        TOKEN_PROGRAM_ID
    );

    const mirrorMint = mint.toBase58();

    try {
        await query(
            `INSERT INTO mirror_mints (real_mint, mirror_mint, decimals, token_program, rate)
             VALUES ($1, $2, $3, $4, $5)`,
            [realMint, mirrorMint, decimals, TOKEN_PROGRAM_ID.toBase58(), rate]
        );
    } catch (err) {

        const winner = await getMirror(realMint);
        if (winner) return { ...winner, created: false };
        throw err;
    }

    try {
        require('./swap').invalidateRates();
    } catch { }

    return {
        real_mint: realMint,
        mirror_mint: mirrorMint,
        decimals,
        token_program: TOKEN_PROGRAM_ID.toBase58(),
        rate,
        created: true,
    };
}

async function ensureMirrors(tokens, { onProgress } = {}) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (onProgress) {
            onProgress({ index: i, total: tokens.length, symbol: t.symbol || t.address, phase: 'minting' });
        }
        const m = await ensureMirror(t, t.rate ?? null);
        if (onProgress) {
            onProgress({
                index: i, total: tokens.length, symbol: t.symbol || t.address,
                phase: m.created ? 'minted' : 'reused', mirror: m.mirror_mint,
            });
        }
        out.push({ ...m, symbol: t.symbol, name: t.name });
    }
    return out;
}

module.exports = { ensureMirror, ensureMirrors, getMirror, getRealForMirror, allMirrors };
