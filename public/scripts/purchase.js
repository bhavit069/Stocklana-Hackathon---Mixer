
(function () {
  'use strict';

  var progress = { active: false, side: null, legs: 0 };

  function watchProgress() {
    if (typeof io !== 'function') return;
    try {
      var socket = io();
      socket.on('trade:progress', function (p) {
        if (!progress.active) return;
        if (!p || p.mixerId !== window.MIXER_ID) return;
        if (progress.side && p.side !== progress.side) return;
        if (!window.TradeModal) return;

        if (p.phase === 'debit') {
          TradeModal.progress(0);
          TradeModal.setNote('Taking payment from your wallet…');
          return;
        }
        if (p.phase === 'settling') {
          TradeModal.progress(progress.legs + 1);
          TradeModal.setNote('Finalising your position…');
          return;
        }

        var n = p.legIndex || 0;
        if (n < 1) return;

        var what = p.phase === 'trade' ? 'Depositing into vault'
                 : p.phase === 'redeem' ? 'Redeeming from vault'
                 : p.side === 'sell' ? 'Converting to SOL'
                 : 'Acquiring';

        TradeModal.progress(n, what + ' · ' + (p.symbol || shortMint(p.mint || '')));
        TradeModal.setNote(what + ' — token ' + n + ' of ' + (p.totalLegs || progress.legs) + '.');
      });
    } catch { }
  }

  function showBuyStatus(msg, isError) {
    if (isError && msg && window.Alerts) Alerts.error(msg);
  }

  function fmtUnits(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n);
    var dp = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: Math.min(dp, 2), maximumFractionDigits: dp });
  }

  function fmtTokens(raw, decimals) {
    var n = Number(raw) / Math.pow(10, decimals || 0);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function shortMint(m) {
    return m ? m.slice(0, 4) + '…' + m.slice(-4) : '';
  }

  function symbolFor(mint) {

    try {
      var found = (window.ALLOCATIONS || []).find(function (a) {
        return a.mirror_mint === mint || a.token_address === mint;
      });
      if (found && found.token && found.token.symbol) return found.token.symbol;
    } catch { }
    return shortMint(mint);
  }

  function explorer(sig) {
    return 'https://explorer.solana.com/tx/' + sig + '?cluster=devnet';
  }

  var minCache = null;
  function minTrade() {
    if (!minCache) {
      minCache = fetch('/mixer/min-trade', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return minCache;
  }
  window.mixerMinTrade = minTrade;

  function resetButton(btn, label) {
    progress.active = false;
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = label;
  }

  async function runPurchase(solAmount) {
    var btn = document.getElementById('marketButton');
    var label = btn ? btn.textContent : 'Buy Market';
    if (btn) { btn.disabled = true; btn.textContent = 'Quoting…'; }

    var plan;
    try {
      var qRes = await fetch('/mixer/' + window.MIXER_ID + '/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount: solAmount })
      });
      var qBody = await qRes.json();
      if (!qRes.ok) throw new Error(qBody.error || 'Quote failed');
      plan = qBody.plan;
      if (qBody.below_minimum) {
        resetButton(btn, label);
        Alerts.error(qBody.below_minimum.error, {
          detail: 'Smaller trades lose too much to network fees and account rent.'
        });
        return;
      }
    } catch (err) {
      console.error(err);
      resetButton(btn, label);
      Alerts.error('Could not price this trade', { detail: err.message });
      return;
    }

    if (btn) btn.textContent = label;

    var rows = plan.legs.map(function (l) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">' +
        '<span style="color:#9AA0A6">' + symbolFor(l.mint) +
        ' <span style="color:#6b7280">' + (l.weight_bps / 100).toFixed(0) + '%</span></span>' +
        '<span style="color:#fff;font-variant-numeric:tabular-nums">' +
        fmtTokens(l.expected_tokens, l.decimals) + '</span></div>';
    }).join('');

    var feeSol = (plan.lamports_total - plan.investable_lamports) / 1e9
      + (plan.investable_lamports / 1e9) * (plan.contract_trade_fee_bps / 10000);

    var steps = ['Authorise payment']
      .concat(plan.legs.map(function (l) { return 'Buy ' + symbolFor(l.mint); }))
      .concat(['Settle position']);

    TradeModal.open({
      title: 'Buy ' + solAmount + ' SOL',
      confirmLabel: 'Confirm buy',
      runningLabel: 'Buying…',
      summaryHtml:
        '<div style="margin-bottom:8px;color:#fff;font-size:12px">You receive</div>' + rows +
        '<div style="display:flex;justify-content:space-between;margin-top:8px;' +
        'padding-top:8px;border-top:1px solid #1e2228">' +
        '<span>Fee</span><span style="font-variant-numeric:tabular-nums">' +
        feeSol.toFixed(6) + ' SOL</span></div>',
      steps: steps,
      note: (plan.legs.length * 2) + ' transactions · roughly ' +
        Math.max(5, Math.round(plan.legs.length * 4)) + 's. This cannot be undone.',
      onCancel: function () { resetButton(btn, label); },
      onConfirm: function () { executeBuy(solAmount, plan, btn, label); },
    });
  }

  async function executeBuy(solAmount, plan, btn, label) {
    progress.active = true;
    progress.side = 'buy';
    progress.legs = plan.legs.length;

    TradeModal.setPhase('running');
    TradeModal.progress(0);
    TradeModal.setNote('Submitting transactions…');
    if (btn) btn.textContent = 'Buying…';

    try {
      var bRes = await fetch('/mixer/' + window.MIXER_ID + '/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solAmount: solAmount })
      });
      var b = await bRes.json();

      if (!bRes.ok) {
        if (bRes.status === 402) {
          throw new Error(b.error + '. Wallet ' + b.wallet + ' holds ' +
            Number(b.balance_sol).toFixed(4) + ' SOL.');
        }
        throw new Error(b.error || 'Purchase failed');
      }

      (b.legs || []).forEach(function (l, i) {
        if (l.trade_signature) TradeModal.link(i + 1, explorer(l.trade_signature));
      });

      TradeModal.allDone();
      TradeModal.setPhase('done');
      TradeModal.setTitle('Purchase complete');
      TradeModal.setNote('Shares held: ' + b.shares);

      Alerts.success('Bought ' + solAmount + ' SOL of this mixer', {
        detail: plan.legs.length + ' tokens acquired and deposited.'
      });

      resetButton(btn, label);
      if (window.refreshHoldings) window.refreshHoldings();
      if (window.refreshNavBalance) window.refreshNavBalance();
    } catch (err) {
      console.error(err);
      TradeModal.fail(0);
      TradeModal.setPhase('failed');
      TradeModal.setTitle('Purchase failed');
      TradeModal.setNote(err.message);
      Alerts.error('Purchase failed', { detail: err.message });
      resetButton(btn, label);
    }
  }

  async function runSell(order) {
    var btn = document.getElementById('marketButton');
    var label = btn ? btn.textContent : 'Sell Market';
    if (btn) { btn.disabled = true; btn.textContent = 'Quoting…'; }

    var q;
    try {
      var qRes = await fetch('/mixer/' + window.MIXER_ID + '/sell-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent: order.percent })
      });
      q = await qRes.json();
      if (!qRes.ok) throw new Error(q.error || 'Quote failed');
    } catch (err) {
      console.error(err);
      resetButton(btn, label);
      Alerts.error('Could not price this sale', { detail: err.message });
      return;
    }

    var min = await minTrade();
    if (min && !q.sellingWholePosition && q.solOut < min.sol * 0.999) {
      resetButton(btn, label);
      Alerts.error('The minimum sell is $' + min.usd + ' (about ' + min.sol.toFixed(4) + ' SOL)', {
        detail: 'Sell a larger amount, or sell your whole position.'
      });
      return;
    }

    if (btn) btn.textContent = label;

    var rows = q.legs.map(function (l) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">' +
        '<span style="color:#9AA0A6">' + symbolFor(l.mint) + '</span>' +
        '<span style="color:#fff;font-variant-numeric:tabular-nums">' +
        l.solOut.toFixed(6) + ' SOL</span></div>';
    }).join('');

    var steps = ['Authorise redemption']
      .concat(q.legs.map(function (l) { return 'Sell ' + symbolFor(l.mint); }))
      .concat(['Settle payout']);

    TradeModal.open({
      title: 'Sell ' + fmtUnits(order.units) + ' ' + order.ticker,
      confirmLabel: 'Confirm sell',
      runningLabel: 'Selling…',
      summaryHtml:
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">' +
          '<span style="color:#fff;font-size:12px">You receive' +
          (q.sellingWholePosition ? ' <span style="color:#6b7280">(entire position)</span>' : '') + '</span>' +
          '<span style="color:#fff;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">~' +
          q.solOut.toFixed(4) + ' SOL</span>' +
        '</div>' + rows +
        '<div style="display:flex;justify-content:space-between;margin-top:8px;' +
        'padding-top:8px;border-top:1px solid #1e2228">' +
        '<span>Position value</span><span style="font-variant-numeric:tabular-nums">' +
        q.positionSolValue.toFixed(6) + ' SOL</span></div>',
      steps: steps,
      note: 'Redeemed from each vault, then swapped to SOL. This cannot be undone.',
      onCancel: function () { resetButton(btn, label); },
      onConfirm: function () { executeSell(order, q, btn, label); },
    });
  }

  async function executeSell(order, q, btn, label) {
    progress.active = true;
    progress.side = 'sell';
    progress.legs = q.legs.length;

    TradeModal.setPhase('running');
    TradeModal.progress(0);
    TradeModal.setNote('Submitting transactions…');
    if (btn) btn.textContent = 'Selling…';

    try {
      var r = await fetch('/mixer/' + window.MIXER_ID + '/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent: order.percent })
      });
      var b = await r.json();
      if (!r.ok || !b.ok) throw new Error(b.error || 'Sell failed');

      (b.legs || []).forEach(function (l, i) {
        if (l.sol_signature) TradeModal.link(i + 1, explorer(l.sol_signature));
      });

      var returned = Number(b.sol_returned).toFixed(6);
      TradeModal.allDone();
      TradeModal.setPhase('done');
      TradeModal.setTitle('Sale complete');
      TradeModal.setNote('Received ' + returned + ' SOL.');

      Alerts.success('Sold ' + fmtUnits(order.units) + ' ' + order.ticker, {
        detail: 'Received ' + returned + ' SOL.'
      });

      resetButton(btn, label);
      if (window.refreshHoldings) window.refreshHoldings();
      if (window.refreshNavBalance) window.refreshNavBalance();
    } catch (err) {
      console.error(err);
      TradeModal.fail(0);
      TradeModal.setPhase('failed');
      TradeModal.setTitle('Sale failed');
      TradeModal.setNote(err.message);
      Alerts.error('Sale failed', { detail: err.message });
      resetButton(btn, label);
    }
  }

  window.showBuyStatus = showBuyStatus;
  window.runPurchase = runPurchase;
  window.runSell = runSell;

  function init() {
    watchProgress();

    if (typeof window.syncAmountUnit === 'function') window.syncAmountUnit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
