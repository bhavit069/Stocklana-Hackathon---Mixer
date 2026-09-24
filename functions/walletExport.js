require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const axios = require('axios');

const PRIVY_API = 'https://api.privy.io/v1';

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;

const HASH_LEN = 32;
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

const SUITE_ID = Buffer.concat([
    Buffer.from('HPKE'),
    u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID),
]);
const KEM_SUITE_ID = Buffer.concat([Buffer.from('KEM'), u16(KEM_ID)]);

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
}

function labeledExtract(salt, label, ikm, suiteId) {
    const labeled = Buffer.concat([Buffer.from('HPKE-v1'), suiteId, Buffer.from(label), ikm]);
    return Buffer.from(crypto.createHmac('sha256', salt).update(labeled).digest());
}

function labeledExpand(prk, label, info, length, suiteId) {
    const labeledInfo = Buffer.concat([
        u16(length), Buffer.from('HPKE-v1'), suiteId, Buffer.from(label), info,
    ]);

    const out = [];
    let t = Buffer.alloc(0);
    for (let i = 1; out.reduce((s, b) => s + b.length, 0) < length; i++) {
        t = Buffer.from(
            crypto.createHmac('sha256', prk)
                .update(Buffer.concat([t, labeledInfo, Buffer.from([i])]))
                .digest()
        );
        out.push(t);
    }
    return Buffer.concat(out).subarray(0, length);
}

function decap(enc, recipientPrivateKey, recipientPublicRaw) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(recipientPrivateKey);
    const dh = ecdh.computeSecret(enc);

    const kemContext = Buffer.concat([enc, recipientPublicRaw]);
    const eaePrk = labeledExtract(Buffer.alloc(0), 'eae_prk', dh, KEM_SUITE_ID);
    return labeledExpand(eaePrk, 'shared_secret', kemContext, HASH_LEN, KEM_SUITE_ID);
}

function keySchedule(sharedSecret, info = Buffer.alloc(0)) {
    const MODE_BASE = 0x00;

    const pskIdHash = labeledExtract(Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0), SUITE_ID);
    const infoHash = labeledExtract(Buffer.alloc(0), 'info_hash', info, SUITE_ID);
    const keyScheduleContext = Buffer.concat([Buffer.from([MODE_BASE]), pskIdHash, infoHash]);

    const secret = labeledExtract(sharedSecret, 'secret', Buffer.alloc(0), SUITE_ID);

    return {
        key: labeledExpand(secret, 'key', keyScheduleContext, KEY_LEN, SUITE_ID),
        baseNonce: labeledExpand(secret, 'base_nonce', keyScheduleContext, NONCE_LEN, SUITE_ID),
    };
}

function hpkeOpen({ enc, ciphertext, privateKey, publicKeyRaw, info = Buffer.alloc(0), aad = Buffer.alloc(0) }) {
    const sharedSecret = decap(enc, privateKey, publicKeyRaw);
    const { key, baseNonce } = keySchedule(sharedSecret, info);

    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);

    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, baseNonce, {
        authTagLength: TAG_LEN,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(body), decipher.final()]);
}

function generateRecipientKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });

    const jwk = publicKey.export({ format: 'jwk' });
    const publicKeyRaw = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
    ]);

    const privJwk = privateKey.export({ format: 'jwk' });

    return {
        privateKey: Buffer.from(privJwk.d, 'base64url'),
        publicKeyRaw,
        publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }),
    };
}

async function exportPrivateKey(privyWalletId) {
    const appId = process.env.PIVY_APP_ID;
    const appSecret = process.env.PIVY_APP_SECRET;
    if (!appId || !appSecret) throw new Error('Privy credentials are not configured');
    if (!privyWalletId) throw new Error('No Privy wallet id for this account');

    const { privateKey, publicKeyRaw, publicKeySpki } = generateRecipientKeypair();

    let data;
    try {
        const res = await axios.post(
            `${PRIVY_API}/wallets/${privyWalletId}/export`,
            {
                encryption_type: 'HPKE',
                recipient_public_key: publicKeySpki.toString('base64'),
            },
            {
                headers: {
                    Authorization: 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64'),
                    'privy-app-id': appId,
                    'Content-Type': 'application/json',
                },
                timeout: 20000,
            }
        );
        data = res.data;
    } catch (err) {
        const body = err.response && err.response.data;
        const detail = body && (body.error || body.message) ? (body.error || body.message) : err.message;

        if (/must have an owner/i.test(detail)) {
            const e = new Error(
                'This wallet cannot be exported yet: it was created without an owner key. ' +
                'Configure a server authorization key as the wallet owner in Privy (see ' +
                'docs/WALLET_EXPORT.md) to enable export.'
            );
            e.code = 'NO_WALLET_OWNER';
            throw e;
        }

        throw new Error(`Privy export failed: ${detail}`);
    }

    if (!data || !data.ciphertext || !data.encapsulated_key) {
        throw new Error('Privy returned no encrypted key material');
    }

    const plaintext = hpkeOpen({
        enc: Buffer.from(data.encapsulated_key, 'base64'),
        ciphertext: Buffer.from(data.ciphertext, 'base64'),
        privateKey,
        publicKeyRaw,
    });

    return plaintext.toString('utf8');
}

module.exports = {
    exportPrivateKey,

    _internal: { hpkeOpen, generateRecipientKeypair, labeledExtract, labeledExpand, keySchedule },
};
