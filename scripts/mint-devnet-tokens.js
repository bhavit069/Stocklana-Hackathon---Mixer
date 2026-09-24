#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const { createMint } = require('@solana/spl-token');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { connection, keypairFromBase58, sleep } = require('../functions/solanaConfig');
const { createToken, tokenExists } = require('../database/token.repo');

const TOKENS = [
    { name: 'Devnet Bonk',   symbol: 'dBONK', decimals: 5, program: TOKEN_PROGRAM_ID,      rate: 250000 },
    { name: 'Devnet Jupiter',symbol: 'dJUP',  decimals: 6, program: TOKEN_PROGRAM_ID,      rate: 120 },
    { name: 'Devnet Pyth',   symbol: 'dPYTH', decimals: 6, program: TOKEN_PROGRAM_ID,      rate: 400 },
    { name: 'Devnet Jito',   symbol: 'dJTO',  decimals: 9, program: TOKEN_2022_PROGRAM_ID, rate: 60 },
];

(async () => {
    const secret = process.env.MIXER_CREATOR_SECRET_KEY;
    if (!secret) throw new Error('MIXER_CREATOR_SECRET_KEY not set in .env');
    const payer = keypairFromBase58(secret);

    console.log('creator:', payer.publicKey.toBase58());
    const bal = await connection.getBalance(payer.publicKey);
    console.log('balance:', (bal / 1e9).toFixed(3), 'SOL\n');
    if (bal < 0.2e9) throw new Error('Creator wallet needs at least ~0.2 SOL');

    const created = [];
    const rates = {};

    for (const t of TOKENS) {
        const mint = await createMint(
            connection, payer, payer.publicKey, null, t.decimals,
            undefined, { commitment: 'confirmed' }, t.program
        );
        const address = mint.toBase58();
        const is22 = t.program.equals(TOKEN_2022_PROGRAM_ID);

        console.log(`${t.symbol.padEnd(6)} ${is22 ? '[Token-2022]' : '[SPL]       '} ${address}`);

        if (!(await tokenExists(address))) {
            await createToken({
                address,
                name: t.name,
                symbol: t.symbol,
                logo: null,
                decimals: t.decimals,
                is_verified: true,
                created_at: new Date(),
            });
            console.log(`       registered in token_info`);
        }

        created.push({ ...t, address, program: t.program.toBase58() });
        rates[address] = t.rate;
        await sleep(800);
    }

    console.log('\nAdd this to .env so the dummy swap prices them:\n');
    console.log('SWAP_DUMMY_RATES=' + JSON.stringify(rates));
    console.log('\nToken addresses for the create form:');
    created.forEach(c => console.log(`  ${c.symbol.padEnd(6)} ${c.address}`));
    process.exit(0);
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
