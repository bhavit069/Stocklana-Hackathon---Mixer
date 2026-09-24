const express = require('express');
const router = express.Router();
const { checkAuthenticated } = require('../middleware/auth');
const { findUserById } = require('../database/users.repo');
const { getCatalog, getByMint } = require('../functions/preIpoStocks');

router.get('/api/pre-ipo', async (req, res) => {
    try {
        const catalog = await getCatalog({ force: req.query.refresh === '1' });

        let tokens = catalog.tokens;

        const q = (req.query.q || '').trim().toLowerCase();
        if (q) {
            tokens = tokens.filter(t =>
                t.symbol.toLowerCase().includes(q) ||
                t.name.toLowerCase().includes(q) ||
                (t.sector || '').toLowerCase().includes(q));
        }

        res.json({
            ok: true,
            count: tokens.length,
            providers: catalog.providers,

            failed: catalog.failed,
            fetchedAt: catalog.fetchedAt,
            tokens,
        });
    } catch (err) {
        console.error('Pre-IPO catalog failed:', err.message);
        res.status(502).json({ error: 'Could not load pre-IPO catalog' });
    }
});

router.get('/api/pre-ipo/:mint', async (req, res) => {
    try {
        const token = await getByMint(req.params.mint);
        if (!token) return res.status(404).json({ error: 'Not a known pre-IPO token' });
        res.json({ ok: true, token });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

router.get('/api/pre-ipo/:mint/mixers', checkAuthenticated, async (req, res) => {
    try {
        const { fetchMixersUsingToken } = require('../database/mixer_allocations.repo');
        const { fetchMixersByIds } = require('../database/mixer.repo');

        const holdings = await fetchMixersUsingToken(req.params.mint);
        if (!holdings.length) return res.json({ ok: true, count: 0, mixers: [] });

        const weightByMixer = holdings.reduce((a, h) => {
            a[h.mixer_id] = Number(h.weight);
            return a;
        }, {});
        const ids = Object.keys(weightByMixer);

        const { marketDataFor } = require('../functions/marketData');
        const { investedFor } = require('../functions/investedFor');
        const [rows, md, invested] = await Promise.all([
            fetchMixersByIds(ids),
            marketDataFor(ids),
            investedFor(ids),
        ]);

        const mixers = rows.map((m) => {
            const d = md[m.mixer_id] || {};
            const cap = invested[m.mixer_id] || {};
            return {
                mixer_id: m.mixer_id,
                name: m.name,
                ticker: m.ticker,
                image: m.image,
                thesis_title: m.thesis_title,
                weight: weightByMixer[m.mixer_id],
                price: d.price ?? null,
                change24h: (d.changes && d.changes['24h'] !== undefined) ? d.changes['24h'] : null,
                netSol: cap.netSol || 0,
                investors: cap.investors || 0,
            };
        }).sort((a, b) => b.weight - a.weight);

        res.json({ ok: true, count: mixers.length, mixers });
    } catch (err) {
        console.error('Stock holders lookup failed:', err.message);
        res.status(502).json({ error: 'Could not look up mixers for this stock' });
    }
});

router.get('/stocks', checkAuthenticated, async (req, res) => {
    try {
        const [user, catalog] = await Promise.all([
            findUserById(req.user.userId),
            getCatalog(),
        ]);

        res.render('stocks', {
            user,
            tokens: catalog.tokens,
            providers: catalog.providers,
            failed: catalog.failed,
        });
    } catch (err) {
        console.error('Stocks page failed:', err);
        res.status(500).send('Could not load pre-IPO stocks');
    }
});

module.exports = router;
