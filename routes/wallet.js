const express = require('express');
const router = express.Router();
const axios = require('axios');
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { sendSol } = require('../utils/privy');

router.get('/', checkAuthenticated, async (req, res) => {
    const user = await findUserById(req.user.userId);
    let balance = 0;

    const { txId, error, xLinked, xUnlinked, xError, needsX } = req.query;

    if (user.walletAddress) {
        try {

            const { connection } = require('../functions/solanaConfig');
            const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
            const lamports = await connection.getBalance(new PublicKey(user.walletAddress));
            balance = lamports / LAMPORTS_PER_SOL;
        } catch (err) {
            console.error("Failed to fetch balance:", err.message);
        }
    }

    let solUsd = null;
    try {
        solUsd = await require('../functions/devnetPrices').getSolUsd();
    } catch { }

    const exportReady = !!user.privyWalletId;

    res.render('wallet', {
        user, balance, solUsd, txId, error,
        xLinked, xUnlinked, xError, needsX,
        exportReady,
        hasPassword: !!user.passwordHash,
    });
});

router.get('/balance-api', checkAuthenticated, async (req, res) => {
    const user = await findUserById(req.user.userId);
    let balance = 0;

    if (user.walletAddress) {
        try {
            const response = await axios.post(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
                jsonrpc: "2.0",
                id: 1,
                method: "getBalance",
                params: [user.walletAddress]
            });

            if (response.data && response.data.result) {
                balance = response.data.result.value / 1000000000;
            }
        } catch (err) {
            console.error("Failed to fetch balance API:", err.message);
        }
    }

    const usdValue = (balance * 150).toFixed(2);

    res.json({
        balance: balance.toFixed(4),
        usdValue: usdValue,
        address: user.walletAddress
    });
});

router.get('/devnet-balance', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user || !user.walletAddress) {
            return res.json({ balance: '0.0000', address: null });
        }

        const { connection } = require('../functions/solanaConfig');
        const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const lamports = await connection.getBalance(new PublicKey(user.walletAddress));

        res.json({
            balance: (lamports / LAMPORTS_PER_SOL).toFixed(4),
            lamports,
            address: user.walletAddress,
            cluster: 'devnet',
        });
    } catch (err) {
        console.error('Devnet balance failed:', err.message);
        res.status(502).json({ error: err.message, balance: null });
    }
});

router.post('/devnet-topup', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user || !user.walletAddress) {
            return res.status(409).json({ error: 'No wallet provisioned' });
        }

        const {
            connection, keypairFromBase58,
        } = require('../functions/solanaConfig');
        const {
            PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction,
        } = require('@solana/web3.js');

        const secret = process.env.MIXER_CREATOR_SECRET_KEY;
        if (!secret) return res.status(500).json({ error: 'Funding wallet not configured' });

        const amount = Math.min(Number(req.body.sol) || 0.5, 2);
        const funder = keypairFromBase58(secret);

        const funderBal = await connection.getBalance(funder.publicKey);
        if (funderBal < (amount + 0.01) * LAMPORTS_PER_SOL) {
            return res.status(503).json({ error: 'Funding wallet is out of devnet SOL' });
        }

        const tx = new Transaction().add(SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: new PublicKey(user.walletAddress),
            lamports: Math.floor(amount * LAMPORTS_PER_SOL),
        }));
        const signature = await sendAndConfirmTransaction(connection, tx, [funder], {
            commitment: 'confirmed',
        });

        const balance = await connection.getBalance(new PublicKey(user.walletAddress));

        res.json({
            ok: true,
            added: amount,
            balance: (balance / LAMPORTS_PER_SOL).toFixed(4),
            signature,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        });
    } catch (err) {
        console.error('Devnet top-up failed:', err.message);
        res.status(502).json({ error: err.message });
    }
});

router.post('/export-key', checkAuthenticated, async (req, res) => {
    try {
        const user = await findUserById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'Account not found' });
        if (!user.privyWalletId) {
            return res.status(409).json({ error: 'This account has no custodial wallet to export' });
        }

        if (user.passwordHash) {
            const bcrypt = require('bcrypt');
            const password = req.body.password || '';
            if (!password) {
                return res.status(400).json({ error: 'Enter your password to confirm' });
            }
            const ok = await bcrypt.compare(password, user.passwordHash);
            if (!ok) {

                return res.status(401).json({ error: 'Incorrect password' });
            }
        } else {
            return res.status(409).json({
                error: 'Set an account password before exporting your key',
            });
        }

        const { exportPrivateKey } = require('../functions/walletExport');
        const privateKey = await exportPrivateKey(user.privyWalletId);

        console.log(`Private key exported for user ${user.userId} (${user.walletAddress})`);

        res.json({
            ok: true,
            privateKey,
            address: user.walletAddress,
            format: 'base58',
        });
    } catch (err) {
        console.error('Key export failed:', err.message);

        const status = err.code === 'NO_WALLET_OWNER' ? 409 : 502;
        res.status(status).json({ error: err.message, code: err.code });
    }
});

router.post('/send', checkAuthenticated, async (req, res) => {
    const { destination, amount } = req.body;
    const user = await findUserById(req.user.userId);

    if (!destination || !amount) {
        return res.redirect('/wallet?error=Missing destination or amount');
    }

    try {
        const txId = await sendSol(user.privyWalletId, user.walletAddress, destination, parseFloat(amount));
        res.redirect(`/wallet?txId=${txId}`);
    } catch (err) {
        console.error("Transaction Error:", err);
        const msg = err.message || 'Transaction Failed';
        res.redirect(`/wallet?error=${encodeURIComponent(msg)}`);
    }
});

module.exports = router;
