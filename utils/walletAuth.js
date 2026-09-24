
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const redis = require('../redis');

const NONCE_TTL_SECONDS = 300;
const APP_NAME = 'Mixer';

const nonceKey = (address) => `walletnonce:${address}`;

function buildMessage(address, nonce, issuedAt) {
    return [
        `${APP_NAME} wants you to sign in with your Solana account:`,
        address,
        '',
        'Sign this message to prove you own this wallet.',
        'This does not cost any SOL and grants no spending permission.',
        '',
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`
    ].join('\n');
}

function isValidAddress(address) {
    if (typeof address !== 'string' || address.length < 32 || address.length > 44) {
        return false;
    }
    try {
        return bs58.decode(address).length === 32;
    } catch {
        return false;
    }
}

async function createChallenge(address) {
    if (!isValidAddress(address)) {
        throw new Error('Invalid Solana address');
    }

    const nonce = crypto.randomBytes(24).toString('hex');
    const issuedAt = new Date().toISOString();
    const message = buildMessage(address, nonce, issuedAt);

    await redis.set(
        nonceKey(address),
        JSON.stringify({ nonce, issuedAt }),
        { EX: NONCE_TTL_SECONDS }
    );

    return { message, nonce, issuedAt };
}

async function verifyChallenge(address, signatureBase58) {
    if (!isValidAddress(address) || typeof signatureBase58 !== 'string') {
        return false;
    }

    const stored = await redis.get(nonceKey(address));
    if (!stored) return false;

    let nonce, issuedAt;
    try {
        ({ nonce, issuedAt } = JSON.parse(stored));
    } catch {
        return false;
    }

    let ok = false;
    try {
        const message = buildMessage(address, nonce, issuedAt);
        ok = nacl.sign.detached.verify(
            new TextEncoder().encode(message),
            bs58.decode(signatureBase58),
            bs58.decode(address)
        );
    } catch {
        ok = false;
    }

    if (ok) {
        await redis.del(nonceKey(address));
    }

    return ok;
}

module.exports = { createChallenge, verifyChallenge, isValidAddress, buildMessage };
