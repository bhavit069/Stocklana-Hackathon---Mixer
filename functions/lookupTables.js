const {
    PublicKey, Transaction, TransactionMessage, VersionedTransaction,
    AddressLookupTableProgram, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');

const {
    connection, keypairFromEnv, freshBlockhash, sleep,
    mixerAuthorityPda, vaultPda, vaultEntryPda, feeVaultPda, feeLedgerPda,
    tokenProgramForMint,
} = require('./solanaConfig');
const { query } = require('../database');

const EXTEND_CHUNK = 20;

let platformKp = null;
const platform = () => (platformKp = platformKp || keypairFromEnv('MIXER_CREATOR_SECRET_KEY'));

async function mixerAddresses(mixerState, mints) {
    const mixerPk = new PublicKey(mixerState);
    const out = [mixerPk, mixerAuthorityPda(mixerPk)[0], SystemProgram.programId];
    for (const m of mints) {
        const mintPk = new PublicKey(m);
        out.push(
            await tokenProgramForMint(mintPk),
            vaultEntryPda(mixerPk, mintPk)[0],
            vaultPda(mixerPk, mintPk)[0],
            mintPk,
            feeVaultPda(mixerPk, mintPk)[0],
            feeLedgerPda(mixerPk, mintPk)[0],
        );
    }
    const seen = new Set();
    return out.filter(k => !seen.has(k.toBase58()) && seen.add(k.toBase58()));
}

async function fetchTable(address) {
    const res = await connection.getAddressLookupTable(new PublicKey(address));
    return res.value;
}

async function waitUntilUsable(address, count) {
    for (let i = 0; i < 40; i++) {
        const t = await fetchTable(address).catch(() => null);
        if (t && t.state.addresses.length >= count) {
            const slot = await connection.getSlot('confirmed');
            if (slot > Number(t.state.lastExtendedSlot)) return t;
        }
        await sleep(400);
    }
    throw new Error('Lookup table did not become usable in time');
}

async function extend(address, addresses) {
    const kp = platform();
    for (let i = 0; i < addresses.length; i += EXTEND_CHUNK) {
        const tx = new Transaction().add(AddressLookupTableProgram.extendLookupTable({
            payer: kp.publicKey,
            authority: kp.publicKey,
            lookupTable: new PublicKey(address),
            addresses: addresses.slice(i, i + EXTEND_CHUNK),
        }));
        freshBlockhash();
        await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });
    }
}

const inflight = new Map();

function lookupTableFor(mixerState, mints) {
    const key = mixerState;
    if (inflight.has(key)) return inflight.get(key);

    const work = (async () => {
        const wanted = await mixerAddresses(mixerState, mints);
        const rows = await query('SELECT lookup_table FROM mixers WHERE mixer_id = $1', [mixerState]);
        let address = rows[0] && rows[0].lookup_table;

        if (address) {
            const table = await fetchTable(address).catch(() => null);
            if (table) {
                const have = new Set(table.state.addresses.map(a => a.toBase58()));
                const missing = wanted.filter(a => !have.has(a.toBase58()));
                if (!missing.length) return table;
                await extend(address, missing);
                return waitUntilUsable(address, have.size + missing.length);
            }
            address = null;
        }

        const kp = platform();
        const slot = await connection.getSlot('finalized');
        const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
            authority: kp.publicKey,
            payer: kp.publicKey,
            recentSlot: slot,
        });
        const tx = new Transaction().add(createIx);
        freshBlockhash();
        await sendAndConfirmTransaction(connection, tx, [kp], { commitment: 'confirmed' });

        await extend(tableAddress.toBase58(), wanted);
        await query('UPDATE mixers SET lookup_table = $1 WHERE mixer_id = $2', [tableAddress.toBase58(), mixerState]);
        return waitUntilUsable(tableAddress.toBase58(), wanted.length);
    })();

    inflight.set(key, work);
    work.finally(() => inflight.delete(key)).catch(() => {});
    return work;
}

async function sendV0({ instructions, lookupTables = [], privyWallet, keypair, attempts = 3 }) {
    const payerKey = privyWallet ? privyWallet.publicKey : keypair.publicKey;
    let lastErr;

    for (let attempt = 0; attempt < attempts; attempt++) {
        freshBlockhash();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const message = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions })
            .compileToV0Message(lookupTables);
        let tx = new VersionedTransaction(message);

        try {
            if (privyWallet) tx = await privyWallet.signTransaction(tx);
            else tx.sign([keypair]);

            const sig = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            const conf = await connection.confirmTransaction(
                { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'
            );
            if (conf.value && conf.value.err) {
                throw new Error('Transaction failed on chain: ' + JSON.stringify(conf.value.err));
            }
            return sig;
        } catch (err) {
            lastErr = err;
            const stale = /Blockhash not found|block height exceeded|expired/i.test(String(err && err.message));
            if (!stale || attempt === attempts - 1) throw err;
            await sleep(800 * (attempt + 1));
        }
    }
    throw lastErr;
}

module.exports = { lookupTableFor, sendV0, mixerAddresses };
