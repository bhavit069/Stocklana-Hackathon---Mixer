require('dotenv').config({ quiet: true });
const { PrivyClient } = require('@privy-io/server-auth');
const { PublicKey, Transaction } = require('@solana/web3.js');
const { connection, freshBlockhash } = require('./solanaConfig');

const privy = new PrivyClient(process.env.PIVY_APP_ID, process.env.PIVY_APP_SECRET);

class PrivyWallet {
    constructor(walletId, address) {
        this.walletId = walletId;
        this.publicKey = new PublicKey(address);
    }

    async signTransaction(tx) {
        const res = await privy.walletApi.solana.signTransaction({
            walletId: this.walletId,
            transaction: tx,
        });

        const signed = res.signedTransaction || res.transaction || res;
        if (signed && typeof signed.serialize === 'function') return signed;

        if (res.signature) {
            tx.addSignature(this.publicKey, Buffer.from(res.signature, 'base64'));
            return tx;
        }

        throw new Error('Unrecognised Privy signTransaction response: ' + Object.keys(res).join(','));
    }

    async signAllTransactions(txs) {
        const out = [];
        for (const tx of txs) out.push(await this.signTransaction(tx));
        return out;
    }
}

async function sendWithPrivy({ walletId, address, instructions, extraSigners = [], attempts = 3 }) {
    const payer = new PublicKey(address);
    const wallet = new PrivyWallet(walletId, address);

    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {

        freshBlockhash();
        const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash('confirmed');

        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer });
        instructions.forEach((ix) => tx.add(ix));

        if (extraSigners.length) tx.partialSign(...extraSigners);

        try {
            const signed = await wallet.signTransaction(tx);

            const sig = await connection.sendRawTransaction(signed.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });
            await connection.confirmTransaction(
                { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'
            );
            return sig;
        } catch (err) {
            lastErr = err;

            const msg = String(err && err.message);
            const stale = /Blockhash not found|block height exceeded|expired/i.test(msg);
            if (!stale || attempt === attempts - 1) throw err;

            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }

    throw lastErr;
}

module.exports = { PrivyWallet, sendWithPrivy, privy };
