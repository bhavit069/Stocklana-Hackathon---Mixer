const { PrivyClient } = require('@privy-io/server-auth');
const axios = require('axios');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmRawTransaction } = require('@solana/web3.js');

const privy = new PrivyClient(process.env.PIVY_APP_ID, process.env.PIVY_APP_SECRET);
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

async function createSolanaWallet() {

    const appId = process.env.PIVY_APP_ID;
    const appSecret = process.env.PIVY_APP_SECRET;
    const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');

    try {
        const response = await axios.post('https://api.privy.io/v1/wallets', {
            chain_type: 'solana'
        }, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'privy-app-id': appId,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error("Privy API Error:", error.response ? error.response.data : error.message);
        throw error;
    }
}

async function sendSol(privyWalletId, senderWalletAddress, recipientAddress, amountSol) {
    try {

        const senderPublicKey = new PublicKey(senderWalletAddress);
        const recipientPublicKey = new PublicKey(recipientAddress);

        const { blockhash } = await connection.getLatestBlockhash();

        const transaction = new Transaction({
            recentBlockhash: blockhash,
            feePayer: senderPublicKey
        }).add(
            SystemProgram.transfer({
                fromPubkey: senderPublicKey,
                toPubkey: recipientPublicKey,
                lamports: Math.floor(amountSol * 1000000000),
            })
        );

        const signResult = await privy.walletApi.solana.signTransaction({
            walletId: privyWalletId,
            transaction: transaction
        });
        console.log("Sign Result Keys:", Object.keys(signResult));

        let signedTransaction;
        if (signResult.signature) {
            console.log("Got signature string");
            transaction.addSignature(senderPublicKey, Buffer.from(signResult.signature, 'base64'));
            signedTransaction = transaction;
        } else if (signResult.serialize) {
            console.log("Got Transaction object");
            signedTransaction = signResult;
        } else if (signResult.transaction) {
            console.log("Got wrapped Transaction object");
            signedTransaction = signResult.transaction;
        } else if (signResult.signedTransaction) {
            console.log("Got wrapped Signed Transaction object");
            signedTransaction = signResult.signedTransaction;
        } else {
            throw new Error("Unknown signTransaction response format");
        }

        const rawTransaction = signedTransaction.serialize();
        const txId = await connection.sendRawTransaction(rawTransaction);

        return txId;
    } catch (error) {
        console.error("Send SOL Error:", error);
        throw error;
    }
}

module.exports = { createSolanaWallet, sendSol };
