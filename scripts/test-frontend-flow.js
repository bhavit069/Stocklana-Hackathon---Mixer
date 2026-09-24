#!/usr/bin/env node

require('dotenv').config({ quiet: true });
const axios = require('axios');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:6900';
const EMAIL = process.env.TEST_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || '';

const MINTS = {
    dBONK: 'HDgN3dtzm2KvjGXhWeyuEuLs6vbSopvhMFphQYVGGF1d',
    dJUP: 'G8cY9Ue5CxqTviRoq7x9sEf3FZt4cRoFVnaRRJP8abt7',
    dJTO: 'DDeUCBF7CkNyFxxUQxWMUZ8B1GqPU5NWYNAhyA9YMFzt',
};

const jar = {};
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function capture(res) {
    (res.headers['set-cookie'] || []).forEach(c => {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        jar[kv.slice(0, i)] = kv.slice(i + 1);
    });
}

const client = axios.create({ baseURL: BASE, validateStatus: () => true, maxRedirects: 0 });

async function req(method, url, body, form) {
    const res = await client.request({
        method, url,
        data: form ? new URLSearchParams(body).toString() : body,
        headers: {
            Cookie: cookie(),
            'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
            Accept: 'application/json',
        },
        timeout: 300000,
    });
    capture(res);
    return res;
}

let pass = 0, fail = 0;
const ok = (c, label, detail = '') => {
    if (c) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const line = (t) => console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));

(async () => {
    line('FRONTEND FLOW TEST');
    console.log('base:', BASE);

    line('1. LOGIN');
    let r = await req('post', '/login', { email: EMAIL, password: PASSWORD }, true);
    ok(r.status === 302 && !!jar.token, 'logged in', `status ${r.status}`);
    if (!jar.token) {
        console.error('\nCannot continue without a session. Set TEST_EMAIL / TEST_PASSWORD.');
        process.exit(1);
    }

    line('2. CREATE MIXER (deploys to devnet)');
    const ticker = 'T' + Date.now().toString(36).slice(-4).toUpperCase();
    console.log('  deploying, this takes ~30s…');
    r = await req('post', '/mixer/create', {
        name: 'Frontend Test ' + ticker,
        ticker,
        logo: '',
        description: 'created by test-frontend-flow.js',
        tokens: [
            { address: MINTS.dBONK, weight: 0.5 },
            { address: MINTS.dJUP, weight: 0.3 },
            { address: MINTS.dJTO, weight: 0.2 },
        ],
    });
    ok(r.status === 200 && r.data.ok, 'mixer created on chain',
        r.status === 200 ? '' : JSON.stringify(r.data).slice(0, 160));
    if (!r.data.ok) { console.error('\nAborting.'); process.exit(1); }

    const mixerId = r.data.mixer_state;
    console.log('  mixer   :', mixerId);
    console.log('  explorer:', r.data.explorer);
    ok(r.data.vaults && r.data.vaults.length === 3, 'three vaults returned',
        `${r.data.vaults ? r.data.vaults.length : 0}`);

    line('3. CREATE VALIDATION');
    r = await req('post', '/mixer/create', {
        name: 'Bad', ticker: 'BAD',
        tokens: [{ address: MINTS.dBONK, weight: 0.5 }, { address: MINTS.dJUP, weight: 0.2 }],
    });
    ok(r.status === 400, 'weights that do not sum to 1 are rejected', `status ${r.status}`);

    r = await req('post', '/mixer/create', {
        name: 'Bad', ticker: 'BAD',
        tokens: [{ address: '11111111111111111111111111111111', weight: 1 }],
    });
    ok(r.status === 400 && /do not exist/i.test(r.data.error || ''),
        'non-existent mint is rejected', (r.data.error || '').slice(0, 60));

    line('4. QUOTE');
    r = await req('post', `/mixer/${mixerId}/quote`, { solAmount: 1 });
    ok(r.status === 200 && r.data.ok, 'quote returned', `status ${r.status}`);
    if (r.data.plan) {
        const plan = r.data.plan;
        plan.legs.forEach(l => console.log(
            `    ${l.mint.slice(0, 8)}…  ${(l.weight_bps / 100).toFixed(1)}%  ${l.sol_in} SOL -> ${Number(l.expected_tokens) / 10 ** l.decimals}`));
        ok(plan.legs_sum_lamports === plan.investable_lamports,
            'leg amounts sum exactly to the investable total',
            `${plan.legs_sum_lamports} == ${plan.investable_lamports}`);
        ok(plan.legs.length === 3, 'one leg per constituent', `${plan.legs.length}`);
    }

    r = await req('post', `/mixer/${mixerId}/quote`, { solAmount: 0 });
    ok(r.status === 400, 'zero amount rejected', `status ${r.status}`);

    line('5. POSITION (before buying)');
    r = await req('get', `/mixer/${mixerId}/position`);
    const before = r.data;
    ok(r.status === 200, 'position endpoint responds', `shares=${before.shares}`);

    line('6. BUY (real devnet transactions)');
    console.log('  submitting 6 transactions, this takes ~30s…');
    r = await req('post', `/mixer/${mixerId}/buy`, { solAmount: 0.5 });

    if (r.status === 402) {
        console.log('  SKIP  wallet underfunded:', JSON.stringify(r.data).slice(0, 180));
    } else {
        ok(r.status === 200 && r.data.ok, 'purchase executed',
            r.status === 200 ? '' : JSON.stringify(r.data).slice(0, 200));
        if (r.data.ok) {
            r.data.legs.forEach(l => console.log(
                `    ${l.mint.slice(0, 8)}…  ${l.sol_in} SOL  trade=${l.trade_signature.slice(0, 14)}…`));
            ok(r.data.legs.length === 3, 'all three legs executed', `${r.data.legs.length}`);
            ok(BigInt(r.data.shares) > 0n, 'shares credited', r.data.shares);

            line('7. POSITION (after buying)');
            const after = await req('get', `/mixer/${mixerId}/position`);
            ok(after.data.exists, 'position now exists on chain');
            ok(BigInt(after.data.shares) > BigInt(before.shares || '0'),
                'share balance increased', `${before.shares} -> ${after.data.shares}`);
        }
    }

    line(`RESULTS:  ${pass} passed, ${fail} failed`);
    console.log('Mixer:', mixerId);
    console.log('Page :', `${BASE}/mixer/${mixerId}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSUITE ERROR:', e.message); process.exit(1); });
