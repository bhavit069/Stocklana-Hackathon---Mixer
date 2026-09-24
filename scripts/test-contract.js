#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const {
    Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount,
    getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const { connection, keypairFromBase58, sleep, programFor, positionPda, vaultPda } =
    require('../functions/solanaConfig');
const { createMixerOnChain } = require('../functions/setupMixer');
const { tradeOnChain, withdrawOnChain, getMixerOnChain, getPosition } =
    require('../functions/tradeMixer');
const {
    ensureRoutingAccount, rebalanceWithdraw, rebalanceSettle, setVaultWeight, setFrozen,
} = require('../functions/rebalanceMixer');

const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;
const THROTTLE = Number(process.env.TEST_THROTTLE_MS || 900);
const STATE_FILE = path.join(__dirname, '.test-state.json');

let pass = 0, fail = 0;
const results = [];

function ok(cond, label, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
    results.push({ ok: !!cond, label, detail });
}

async function mustFail(label, fn, expect) {
    try {
        await fn();
        ok(false, label, '-> SUCCEEDED but should have been rejected');
    } catch (e) {
        const msg = (e.message || '') + ' ' + JSON.stringify(e.logs || []);
        const matched = !expect || new RegExp(expect, 'i').test(msg);
        ok(matched, label, matched ? `-> rejected (${expect || 'error'})` : `-> wrong error: ${e.message.slice(0, 90)}`);
    }
}

const line = (t) => console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));

(async () => {
    const secret = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!secret) throw new Error('MIXER_CREATOR_SECRET_KEY not set');
    const creator = keypairFromBase58(secret);

    line('MIXER CONTRACT TEST SUITE (devnet)');
    console.log('creator :', creator.publicKey.toBase58());
    console.log('balance :', (await connection.getBalance(creator.publicKey)) / LAMPORTS_PER_SOL, 'SOL');
    console.log('throttle:', THROTTLE + 'ms between calls');

    let state = null;
    let freshMixer = false;
    const reuse = process.argv[2];
    if (fs.existsSync(STATE_FILE) && !reuse) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        console.log('\nreusing cached setup from', STATE_FILE);
        console.log('mixer   :', state.contract.mixer_state);
    }

    if (!state) {
        line('SETUP: mint tokens + create mixer');

        const trader = Keypair.generate();
        const attacker = Keypair.generate();
        console.log('trader  :', trader.publicKey.toBase58());
        console.log('attacker:', attacker.publicKey.toBase58());

        const fundTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: creator.publicKey, toPubkey: trader.publicKey,
                lamports: 0.35 * LAMPORTS_PER_SOL,
            }),
            SystemProgram.transfer({
                fromPubkey: creator.publicKey, toPubkey: attacker.publicKey,
                lamports: 0.35 * LAMPORTS_PER_SOL,
            })
        );
        await sendAndConfirmTransaction(connection, fundTx, [creator], { commitment: 'confirmed' });
        console.log('funded trader + attacker');
        await sleep(THROTTLE);

        const programs = [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID];
        const mints = [];
        for (let i = 0; i < programs.length; i++) {
            const mint = await createMint(connection, creator, creator.publicKey, null,
                DECIMALS, undefined, { commitment: 'confirmed' }, programs[i]);
            await sleep(THROTTLE);
            for (const who of [trader, attacker]) {
                const ata = await getOrCreateAssociatedTokenAccount(connection, creator, mint,
                    who.publicKey, true, 'confirmed', undefined, programs[i]);
                await sleep(THROTTLE);
                await mintTo(connection, creator, mint, ata.address, creator, 1000 * UNIT, [],
                    { commitment: 'confirmed' }, programs[i]);
                await sleep(THROTTLE);
            }
            mints.push({ mint: mint.toBase58(), program: programs[i].toBase58() });
            console.log(`  minted ${programs[i].equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL'} ${mint.toBase58()}`);
        }

        const contract = await createMixerOnChain({
            tokens: [
                { address: mints[0].mint, weight: 0.6 },
                { address: mints[1].mint, weight: 0.4 },
            ],
            creator: 'test-uuid-0001',
            mixer_name: 'Test Mixer',
            mixer_ticker: 'TEST',
            creatorWalletKey: secret,
            trade_fee_bps: 100,
            creator_fee_share_bps: 6000,
        });

        state = {
            contract, mints,
            trader: bs58.encode(trader.secretKey),
            attacker: bs58.encode(attacker.secretKey),
        };
        freshMixer = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        console.log('\ncached setup ->', STATE_FILE);
    }

    const { contract, mints } = state;
    const trader = keypairFromBase58(state.trader);
    const attacker = keypairFromBase58(state.attacker);
    const mintA = mints[0].mint;
    const mintB = mints[1].mint;
    const progA = new PublicKey(mints[0].program);

    line('1. MIXER CREATION');
    await sleep(THROTTLE);
    const st = await getMixerOnChain({ mixerState: contract.mixer_state, mints: [mintA, mintB] });
    ok(st.is_finalized, 'mixer is finalized');
    ok(st.token_count === 2 && st.vaults_created === 2, 'both vaults created',
        `count=${st.token_count} created=${st.vaults_created}`);
    ok(st.trade_fee_bps === 100, 'trade fee stored', `${st.trade_fee_bps} bps`);
    ok(st.creator_fee_share_bps === 6000, 'fee split stored', `${st.creator_fee_share_bps} bps to creator`);

    const weightSum = st.vaults[0].weight_bps + st.vaults[1].weight_bps;
    if (freshMixer) {
        ok(weightSum === 10000, 'weights sum to 10000 bps at creation',
            `${st.vaults[0].weight_bps} + ${st.vaults[1].weight_bps}`);
    } else {
        console.log(`  SKIP  weight-sum check (reused mixer, sum=${weightSum} after phase 5 reweight)`);
    }

    const program = programFor(creator);
    await sleep(THROTTLE);
    const raw = await program.account.mixerState.fetch(new PublicKey(contract.mixer_state));
    const [, realBump] = PublicKey.findProgramAddressSync(
        [Buffer.from('mixer-authority'), new PublicKey(contract.mixer_state).toBuffer()],
        program.programId
    );
    ok(raw.authorityBump === realBump, 'authority_bump stored correctly (the old fatal bug)',
        `stored=${raw.authorityBump} real=${realBump}`);

    line('2. TRADE — on-chain fee split');
    const amount = 100 * UNIT;

    const creatorAta = getAssociatedTokenAddressSync(new PublicKey(mintA), creator.publicKey, true, progA);
    const treasuryAta = getAssociatedTokenAddressSync(new PublicKey(mintA), new PublicKey(contract.treasury), true, progA);
    const bal = async (a) => { try { return Number((await getAccount(connection, a, 'confirmed', progA)).amount); } catch { return 0; } };

    const creatorBefore = await bal(creatorAta); await sleep(THROTTLE);
    const treasuryBefore = await bal(treasuryAta); await sleep(THROTTLE);

    const t = await tradeOnChain({
        mixerState: contract.mixer_state, mint: mintA, amount,
        traderSecretKey: state.trader,
    });
    console.log('  tx:', t.explorer);
    await sleep(THROTTLE);

    const creatorAfter = await bal(creatorAta); await sleep(THROTTLE);
    const treasuryAfter = await bal(treasuryAta); await sleep(THROTTLE);

    const feeTotal = amount * 100 / 10000;
    const expCreator = feeTotal * 6000 / 10000;
    const expTreasury = feeTotal - expCreator;

    ok(creatorAfter - creatorBefore === expCreator, 'creator received its fee cut',
        `${(creatorAfter - creatorBefore) / UNIT} (expected ${expCreator / UNIT})`);
    ok(treasuryAfter - treasuryBefore === expTreasury, 'treasury received its fee cut',
        `${(treasuryAfter - treasuryBefore) / UNIT} (expected ${expTreasury / UNIT})`);

    const [vaultA] = vaultPda(new PublicKey(contract.mixer_state), new PublicKey(mintA));
    const vaultBal = await bal(vaultA); await sleep(THROTTLE);
    ok(vaultBal >= amount - feeTotal, 'net deposited into vault', `${vaultBal / UNIT}`);
    ok(BigInt(t.shares) > 0n, 'shares credited to trader', t.shares);

    line('3. ON-CHAIN OWNERSHIP LEDGER');
    const pos = await getPosition({ mixerState: contract.mixer_state, owner: trader.publicKey.toBase58() });
    await sleep(THROTTLE);
    ok(pos.exists, 'trader has an on-chain position account', pos.address);
    ok(BigInt(pos.shares) > 0n, 'position records share balance', pos.shares);

    const attackerPos = await getPosition({ mixerState: contract.mixer_state, owner: attacker.publicKey.toBase58() });
    await sleep(THROTTLE);
    ok(!attackerPos.exists, 'non-depositor has no position');

    line('4. SECURITY — attacks the old contract allowed');

    await mustFail('attacker cannot drain a vault they never deposited into', async () => {
        await withdrawOnChain({
            mixerState: contract.mixer_state, mint: mintA, shares: '1',
            userSecretKey: state.attacker,
        });
    }, 'AccountNotInitialized|ConstraintSeeds|Unauthorized|InsufficientShares|does not exist');
    await sleep(THROTTLE);

    await mustFail('trader cannot withdraw more shares than they hold', async () => {
        await withdrawOnChain({
            mixerState: contract.mixer_state, mint: mintA,
            shares: (BigInt(pos.shares) * 1000n).toString(),
            userSecretKey: state.trader,
        });
    }, 'InsufficientShares');
    await sleep(THROTTLE);

    await mustFail('non-creator cannot freeze the mixer', async () => {
        await setFrozen({ mixerState: contract.mixer_state, frozen: true, creatorSecretKey: state.attacker });
    }, 'Unauthorized|ConstraintRaw');
    await sleep(THROTTLE);

    line('5. REBALANCING — authority moves its own tokens');
    await ensureRoutingAccount({ mixerState: contract.mixer_state, mint: mintA, payerSecretKey: secret });
    await sleep(THROTTLE);

    await mustFail('non-creator cannot rebalance', async () => {
        await rebalanceWithdraw({
            mixerState: contract.mixer_state, mint: mintA, amount: 1 * UNIT,
            creatorSecretKey: state.attacker,
        });
    }, 'Unauthorized|ConstraintRaw|has one');
    await sleep(THROTTLE);

    await mustFail('creator cannot rebalance funds to their own wallet', async () => {
        const mixerPk = new PublicKey(contract.mixer_state);
        const mintPk = new PublicKey(mintA);
        const evilAta = getAssociatedTokenAddressSync(mintPk, creator.publicKey, true, progA);
        const [mixerAuthority] = require('../functions/solanaConfig')
            .mixerAuthorityPda(mixerPk);
        const [entry] = require('../functions/solanaConfig').vaultEntryPda(mixerPk, mintPk);
        const [vlt] = vaultPda(mixerPk, mintPk);
        const prog = programFor(creator);
        await prog.methods
            .rebalanceWithdraw(new (require('@coral-xyz/anchor').BN)((1 * UNIT).toString()))
            .accounts({
                mixerState: mixerPk, mixerAuthority, vaultEntry: entry, vault: vlt,
                routingAccount: evilAta,
                mint: mintPk, creator: creator.publicKey, tokenProgram: progA,
            })
            .signers([creator])
            .rpc();
    }, 'RoutingAccountNotOwned|ConstraintRaw');
    await sleep(THROTTLE);

    const move = 5 * UNIT;
    const vaultBeforeRb = await bal(vaultA); await sleep(THROTTLE);

    const rw = await rebalanceWithdraw({
        mixerState: contract.mixer_state, mint: mintA, amount: move, creatorSecretKey: secret,
    });
    console.log('  withdraw leg:', rw.explorer);
    await sleep(THROTTLE);
    const vaultMid = await bal(vaultA); await sleep(THROTTLE);
    ok(vaultBeforeRb - vaultMid === move, 'tokens left the vault', `${(vaultBeforeRb - vaultMid) / UNIT}`);

    const rs = await rebalanceSettle({
        mixerState: contract.mixer_state, mint: mintA, amount: move, creatorSecretKey: secret,
    });
    console.log('  settle leg  :', rs.explorer);
    await sleep(THROTTLE);
    const vaultAfterRb = await bal(vaultA); await sleep(THROTTLE);
    ok(vaultAfterRb === vaultBeforeRb, 'tokens returned to the vault', `${vaultAfterRb / UNIT}`);

    const posAfterRb = await getPosition({ mixerState: contract.mixer_state, owner: trader.publicKey.toBase58() });
    await sleep(THROTTLE);
    ok(posAfterRb.shares === pos.shares, 'rebalancing did not change ownership', posAfterRb.shares);

    const sw = await setVaultWeight({
        mixerState: contract.mixer_state, mint: mintA, weightBps: 5000, creatorSecretKey: secret,
    });
    await sleep(THROTTLE);
    const stW = await getMixerOnChain({ mixerState: contract.mixer_state, mints: [mintA] });
    await sleep(THROTTLE);
    ok(stW.vaults[0].weight_bps === 5000, 'weight updated on chain', `${stW.vaults[0].weight_bps} bps`);

    line('6. WITHDRAW — burn shares, redeem underlying');
    const traderAta = getAssociatedTokenAddressSync(new PublicKey(mintA), trader.publicKey, true, progA);
    const traderBefore = await bal(traderAta); await sleep(THROTTLE);

    const half = (BigInt(pos.shares) / 2n).toString();
    const w = await withdrawOnChain({
        mixerState: contract.mixer_state, mint: mintA, shares: half, userSecretKey: state.trader,
    });
    console.log('  tx:', w.explorer);
    await sleep(THROTTLE);

    const traderAfter = await bal(traderAta); await sleep(THROTTLE);
    ok(traderAfter > traderBefore, 'trader received tokens back', `+${(traderAfter - traderBefore) / UNIT}`);
    ok(BigInt(w.shares_remaining) === BigInt(pos.shares) - BigInt(half), 'shares burned correctly',
        `${w.shares_remaining} remaining`);
    ok(traderAfter - traderBefore <= amount, 'payout never exceeds what was put in',
        `${(traderAfter - traderBefore) / UNIT} <= ${amount / UNIT}`);

    line('7. FREEZE — emergency halt');
    await setFrozen({ mixerState: contract.mixer_state, frozen: true, creatorSecretKey: secret });
    await sleep(THROTTLE);
    await mustFail('trading is blocked while frozen', async () => {
        await tradeOnChain({
            mixerState: contract.mixer_state, mint: mintA, amount: 1 * UNIT,
            traderSecretKey: state.trader,
        });
    }, 'MixerFrozen');
    await sleep(THROTTLE);
    await setFrozen({ mixerState: contract.mixer_state, frozen: false, creatorSecretKey: secret });
    await sleep(THROTTLE);
    ok(true, 'mixer unfrozen for further use');

    line(`RESULTS:  ${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\nFailures:');
        results.filter(r => !r.ok).forEach(r => console.log('  -', r.label, r.detail));
    }
    console.log('\nMixer :', contract.mixer_state);
    console.log('Explorer:', `https://explorer.solana.com/address/${contract.mixer_state}?cluster=devnet`);
    process.exit(fail ? 1 : 0);
})().catch((err) => {
    console.error('\nSUITE ERROR:', err.message);
    if (err.logs) console.error(err.logs.slice(0, 15).join('\n'));
    process.exit(1);
});
