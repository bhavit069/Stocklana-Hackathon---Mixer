require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require("fs");
const fsp = require("fs").promises;

const { initSocket } = require('./socket');
const priceFetcher = require('./services/scraper');
const candleWorker = require('./services/candles');
const http = require("http");

function isTransientRpc(err) {
    const msg = String((err && err.message) || err || '');
    return /429|Too Many Requests|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
}

process.on('unhandledRejection', (err) => {
    if (isTransientRpc(err)) {
        console.warn('⚠️  Transient RPC/network rejection (ignored):', (err && err.message) || err);
        return;
    }
    console.error('❌ Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    if (isTransientRpc(err)) {
        console.warn('⚠️  Transient RPC/network error (ignored):', err.message);
        return;
    }

    console.error('❌ Uncaught exception:', err);
});

const app = express();
const server = http.createServer(app);
initSocket(server);
const PORT = 6900;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/js', express.static(path.join(__dirname, 'public', 'scripts')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const walletAuthRoutes = require('./routes/walletAuth');
const linkRoutes = require('./routes/link');
const mixerRoutes = require('./routes/mixer');
const purchaseRoutes = require('./routes/purchase');
const portfolioRoutes = require('./routes/portfolio');
const creatorRoutes = require('./routes/creator');
const mixerCandleAPIRoutes = require('./routes/mixerCandles');
const stocksRoutes = require('./routes/stocks');
const memeRoutes = require('./routes/meme');
const searchRoutes = require('./routes/search');
const mixersRoutes = require('./routes/mixers')

const timeframesRoutes = require('./routes/timeframes');
app.use('/api/timeframes', timeframesRoutes);

const timeframesWorker = require('./services/timeframes');
const limitEngine = require('./services/limitEngine');
const settlement = require('./services/settlement');

(async () => {
  await timeframesWorker.start();
  limitEngine.start();

  settlement.start();

  process.on('SIGINT', () => {
    timeframesWorker.stop();
    limitEngine.stop();
    settlement.stop();
    process.exit(0);
  });
})();

app.use('/', authRoutes);
app.use('/', walletAuthRoutes);
app.use('/', linkRoutes);

app.get('/dashboard', (req, res) => res.redirect('/wallet'));
app.use('/wallet', walletRoutes);

app.get('/api/sol-price', async (req, res) => {
  try {
    const { getSolUsd } = require('./functions/devnetPrices');
    res.json({ usd: await getSolUsd() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use('/portfolio', portfolioRoutes);
app.use('/creator', creatorRoutes);
app.use('/mixer', purchaseRoutes);
app.use('/mixer', mixerRoutes);
app.use('/mixers', mixersRoutes);
app.use('/api/mixers', mixerCandleAPIRoutes);

app.use('/', stocksRoutes);

app.use('/', memeRoutes);

app.use('/', searchRoutes);

app.use('/', require('./routes/competition'));

app.use('/', require('./routes/xprofile'));

app.use('/', require('./routes/settings'));

app.get('/api/ticker', async (req, res) => {
    try {
        const { getTicker } = require('./functions/marketTicker');
        res.json(await getTicker());
    } catch (err) {

        res.json({ sol: null, btc: null, fetchedAt: Date.now() });
    }
});

app.get('/', (req, res) => {
    res.redirect('/login');
});

const TOKENS_DIR = path.join(__dirname, "public", "tokens");

app.get("/images/tokens/:name", async (req, res) => {
  const baseName = req.params.name;

  const sendPlaceholder = (symbol) => {
    const label = String(symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";

    let hash = 0;
    for (let i = 0; i < baseName.length; i++) hash = (hash * 31 + baseName.charCodeAt(i)) >>> 0;
    const hue = hash % 360;

    res
      .type("image/svg+xml")
      .set("Cache-Control", "public, max-age=3600")
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">' +
        '<circle cx="20" cy="20" r="20" fill="hsl(' + hue + ',42%,26%)"/>' +
        '<text x="20" y="20" font-family="system-ui,-apple-system,sans-serif" ' +
        'font-size="' + (label.length > 2 ? 12 : 15) + '" font-weight="600" ' +
        'fill="hsl(' + hue + ',75%,82%)" text-anchor="middle" dominant-baseline="central">' +
        label + '</text></svg>'
      );
  };

  try {
    const files = await fsp.readdir(TOKENS_DIR).catch(() => []);
    const match = files.find(file => path.parse(file).name === baseName);
    if (match) return res.sendFile(path.join(TOKENS_DIR, match));

    const { getTokenByAddress } = require("./database/token.repo");
    const { downloadImage } = require("./functions/newToken");

    const token = await getTokenByAddress(baseName);

    const logo = (token && token.logo) || require("./functions/iconRegistry").lookup(baseName);
    if (logo) {
      const file = await downloadImage(logo, baseName);
      if (file) return res.sendFile(path.join(TOKENS_DIR, file));
    }
    return sendPlaceholder(token && token.symbol);
  } catch (err) {
    console.error("Token image fetch failed for", baseName + ":", err.message);
  }

  sendPlaceholder();
});

async function optionalUser(req) {
    try {
        const token = req.cookies && req.cookies.token;
        if (!token) return null;
        const jwt = require('jsonwebtoken');
        const { userId } = jwt.verify(token, process.env.JWT_SECRET);
        const { findUserById } = require('./database/users.repo');
        return await findUserById(userId);
    } catch {
        return null;
    }
}

function wantsJson(req) {
    return (req.headers.accept || '').includes('application/json')
        || req.path.startsWith('/api/');
}

app.use(async (req, res) => {
    if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error', {
        status: 404,
        title: 'This page does not exist',
        message: 'The link may be wrong, or whatever was here has since been removed.',
        detail: null,
        user: await optionalUser(req),
    });
});

app.use(async (err, req, res, next) => {
    console.error('❌ Request failed:', req.method, req.originalUrl, '-', err && err.message);
    if (res.headersSent) return next(err);

    if (wantsJson(req)) {
        return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(500).render('error', {
        status: 500,
        title: 'Something went wrong',
        message: 'This one is on us. Try again, or head back to the mixers list.',

        detail: (err && err.message) ? String(err.message).slice(0, 200) : null,
        user: await optionalUser(req),
    });
});

(async () => {
    await priceFetcher.refreshWatchlist();

    setInterval(priceFetcher.refreshWatchlist, 60_000);

    const PRICE_TICK_MS = Number(process.env.PRICE_TICK_MS || 3_000);
    setInterval(priceFetcher.priceTick, PRICE_TICK_MS);
})();

candleWorker.runWorker();

setInterval(candleWorker.runWorker, 1000);

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);

    const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    if (/api\.devnet\.solana\.com/.test(rpc)) {
        console.warn(
            '\n⚠️  Using the PUBLIC devnet RPC, which rate-limits aggressively.\n' +
            '   Trades may be slow and prices may gap under load.\n' +
            '   Before demoing, set SOLANA_RPC_URL to a Helius/QuickNode devnet endpoint.\n'
        );
    }
});