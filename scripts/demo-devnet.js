#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const {
    Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');

const { connection, keypairFromBase58 } = require('../functions/solanaConfig');
const { createMixerOnChain } = require('../functions/setupMixer');
const { tradeOnChain, withdrawOnChain, getMixerOnChain, getPosition } = require('../functions/tradeMixer');
const {
    ensureRoutingAccount, rebalanceWithdraw, rebalanceSettle, setVaultWeight,
} = require('../functions/rebalanceMixer');

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const line = (t) => console.log('\n' + '='.repeat(62) + '\n' + t + '\n' + '='.repeat(62));

async function ensureFunded(kp, minSol = 2) {
    const bal = await connection.getBalance(kp.publicKey);
    console.log(`   balance: ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    if (bal < minSol * LAMPORTS_PER_SOL) {
        console.log('   requesting airdrop…');
        try {
            const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig, 'confirmed');
        } catch (e) {
            console.log('   airdrop failed (devnet faucet is often rate-limited):', e.message);
            if (bal === 0) throw new Error('Wallet has no SOL and airdrop failed.');
        }
    }
}

(async () => {
    line('MIXER DEVNET DEMO');

    const secret = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!secret) {
        console.error('MIXER_CREATOR_SECRET_KEY is not set in .env');
        console.error('Generate one with:  node scripts/demo-devnet.js --new-keypair');
        process.exit(1);
    }

    const creator = keypairFromBase58(secret);
    console.log('creator :', creator.publicKey.toBase58());
    await ensureFunded(creator);

    const trader = Keypair.generate();
    console.log('trader  :', trader.publicKey.toBase58());
    {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: creator.publicKey,
                toPubkey: trader.publicKey,
                lamports: 0.5 * LAMPORTS_PER_SOL,
            })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [creator], {
            commitment: 'confirmed',
        });
        console.log('   funded trader with 0.5 SOL:', sig.slice(0, 20) + '…');
    }

    line('1. MINTING TEST TOKENS (mixed SPL + Token-2022)');
    const programs = [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID];
    const mints = [];
    for (let i = 0; i < 3; i++) {
        const mint = await createMint(
            connection, creator, creator.publicKey, null, DECIMALS,
            undefined, { commitment: 'confirmed' }, programs[i]
        );
        mints.push({ mint, program: programs[i] });
        const label = programs[i].equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL';
        console.log(`   token ${i + 1} [${label.padEnd(10)}] ${mint.toBase58()}`);

        const ata = await getOrCreateAssociatedTokenAccount(
            connection, trader, mint, trader.publicKey, true, 'confirmed', undefined, programs[i]
        );
        await mintTo(
            connection, creator, mint, ata.address, creator, 1000 * UNIT,
            [], { commitment: 'confirmed' }, programs[i]
        );
        console.log(`            trader funded with 1000`);
    }

    line('2. CREATING MIXER ON CHAIN');
    const contract = await createMixerOnChain({
        tokens: [
            { address: mints[0].mint.toBase58(), weight: 0.5 },
            { address: mints[1].mint.toBase58(), weight: 0.3 },
            { address: mints[2].mint.toBase58(), weight: 0.2 },
        ],
        creator: 'demo-uuid-0001',
        mixer_name: 'Demo Mixer',
        mixer_ticker: 'DEMO',
        creatorWalletKey: secret,
        trade_fee_bps: 100,
        creator_fee_share_bps: 6000,
    });
    console.log('   mixer   :', contract.mixer_state);
    console.log('   explorer:', `https://explorer.solana.com/address/${contract.mixer_state}?cluster=devnet`);

    line('3. TRADE  (fee split happens on chain)');
    const tradeMint = mints[0].mint.toBase58();
    const amount = 100 * UNIT;
    console.log(`   trading 100 tokens into ${tradeMint.slice(0, 8)}…`);
    console.log(`   expected: 1.00 fee -> 0.60 creator / 0.40 treasury, 99.00 into vault`);

    const t = await tradeOnChain({
        mixerState: contract.mixer_state,
        mint: tradeMint,
        amount,
        traderSecretKey: bs58.encode(trader.secretKey),
    });
    console.log('   signature:', t.signature);
    console.log('   explorer :', t.explorer);
    console.log('   shares   :', t.shares);

    const prog = mints[0].program;
    const creatorAta = await getOrCreateAssociatedTokenAccount(
        connection, creator, mints[0].mint, creator.publicKey, true, 'confirmed', undefined, prog);
    const treasuryPk = new PublicKey(contract.treasury);
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
        connection, creator, mints[0].mint, treasuryPk, true, 'confirmed', undefined, prog);
    const vaultAcc = await getAccount(connection, new PublicKey(
        contract.vaults.find(v => v.address === tradeMint).vault), 'confirmed', prog);

    console.log('\n   VERIFIED ON CHAIN:');
    console.log('     creator fee acct :', Number((await getAccount(connection, creatorAta.address, 'confirmed', prog)).amount) / UNIT);
    console.log('     treasury fee acct:', Number((await getAccount(connection, treasuryAta.address, 'confirmed', prog)).amount) / UNIT);
    console.log('     vault balance    :', Number(vaultAcc.amount) / UNIT);

    line('4. ON-CHAIN OWNERSHIP LEDGER');
    const pos = await getPosition({ mixerState: contract.mixer_state, owner: trader.publicKey.toBase58() });
    console.log('   position account:', pos.address);
    console.log('   shares held     :', pos.shares);
    const state = await getMixerOnChain({
        mixerState: contract.mixer_state,
        mints: contract.vaults.map(v => v.address),
    });
    console.log('   total shares    :', state.total_shares);
    console.log('   vaults:');
    for (const v of state.vaults) {
        console.log(`     ${v.mint.slice(0, 8)}…  weight=${v.weight_bps}bps  deposited=${Number(v.total_deposited) / UNIT}`);
    }

    line('5. REBALANCE  (mixer authority moves its own tokens)');
    await ensureRoutingAccount({ mixerState: contract.mixer_state, mint: tradeMint, payerSecretKey: secret });
    const move = 10 * UNIT;
    const rw = await rebalanceWithdraw({
        mixerState: contract.mixer_state, mint: tradeMint, amount: move, creatorSecretKey: secret,
    });
    console.log('   withdraw leg:', rw.explorer);
    const rs = await rebalanceSettle({
        mixerState: contract.mixer_state, mint: tradeMint, amount: move, creatorSecretKey: secret,
    });
    console.log('   settle leg  :', rs.explorer);
    const sw = await setVaultWeight({
        mixerState: contract.mixer_state, mint: tradeMint, weightBps: 4000, creatorSecretKey: secret,
    });
    console.log('   weight 50%->40%:', sw.explorer);

    line('6. WITHDRAW  (burn shares, redeem underlying)');
    const half = (BigInt(pos.shares) / 2n).toString();
    const w = await withdrawOnChain({
        mixerState: contract.mixer_state, mint: tradeMint, shares: half,
        userSecretKey: bs58.encode(trader.secretKey),
    });
    console.log('   burned          :', half, 'shares');
    console.log('   signature       :', w.signature);
    console.log('   explorer        :', w.explorer);
    console.log('   shares remaining:', w.shares_remaining);

    line('DEMO COMPLETE');
    console.log('Mixer   :', contract.mixer_state);
    console.log('Explorer:', `https://explorer.solana.com/address/${contract.mixer_state}?cluster=devnet`);
    console.log('\nSave this for the DB seed:');
    console.log(JSON.stringify({
        mixer_state: contract.mixer_state,
        mixer_authority: contract.mixer_authority,
        vaults: contract.vaults,
    }, null, 2));
})().catch((err) => {
    console.error('\nDEMO FAILED:', err.message);
    if (err.logs) console.error(err.logs.join('\n'));
    process.exit(1);
});
