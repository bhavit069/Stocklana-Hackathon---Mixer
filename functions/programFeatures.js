const crypto = require('crypto');
const {
    TransactionInstruction, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const { connection, PROGRAM_ID, keypairFromEnv } = require('./solanaConfig');

const FALLBACK_NOT_FOUND = 101;

const RECHECK_MS = 60_000;

const known = new Map();

const discriminator = (snake) =>
    crypto.createHash('sha256').update('global:' + snake).digest().subarray(0, 8);

async function probe(snake) {
    const payer = keypairFromEnv('MIXER_CREATOR_SECRET_KEY').publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: discriminator(snake) });
    const message = new TransactionMessage({
        payerKey: payer, recentBlockhash: blockhash, instructions: [ix],
    }).compileToV0Message();

    const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
        sigVerify: false, replaceRecentBlockhash: true,
    });
    const err = sim.value.err;
    const code = err && err.InstructionError && err.InstructionError[1] && err.InstructionError[1].Custom;
    return code !== FALLBACK_NOT_FOUND;
}

const inflight = new Map();

async function supports(snake, opts = {}) {
    const hit = known.get(snake);
    if (hit && (hit.yes || (!opts.fresh && Date.now() - hit.at < RECHECK_MS))) return hit.yes;

    if (inflight.has(snake)) return inflight.get(snake);

    const run = (async () => {
        try {
            const yes = await probe(snake);
            known.set(snake, { yes, at: Date.now() });
            return yes;
        } catch (err) {

            console.error(`Feature probe for ${snake} failed:`, err.message);
            const yes = hit ? hit.yes : false;
            known.set(snake, { yes, at: Date.now() });
            return yes;
        } finally {
            inflight.delete(snake);
        }
    })();
    inflight.set(snake, run);
    return run;
}

module.exports = { supports };
