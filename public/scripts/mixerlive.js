
function fmtLivePrice(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.000001) return n.toFixed(8).replace(/0+$/, '');
  return n.toExponential(2);
}

(function () {
  'use strict';

  var POLL_MS = 20000;

  function el(id) { return document.getElementById(id); }
  function short(s, a, b) {
    if (!s) return '—';
    a = a || 4; b = b || 4;
    return s.length <= a + b ? s : s.slice(0, a) + '…' + s.slice(-b);
  }
  function ago(iso) {
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return Math.max(0, Math.floor(d)) + 's';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    return Math.floor(d / 86400) + 'd';
  }
  function fmtShares(raw) {

    var n = Number(raw);
    if (!isFinite(n)) return raw;
    if (n >= 1e15) return (n / 1e15).toFixed(2) + 'P';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    return n.toLocaleString();
  }

  function refreshChartMarkers() {
    if (typeof window.refreshTradeMarkers !== 'function') return;
    [0, 1500, 4000].forEach(function (delay) {
      setTimeout(function () {
        try { window.refreshTradeMarkers(); } catch (e) { }
      }, delay);
    });
  }

  function refreshOwnPosition() {
    if (typeof window.refreshPosition !== 'function') return;

    setTimeout(function () {
      try { window.refreshPosition(); } catch (e) { }
    }, 1200);
  }

  async function loadTrades() {
    var box = el('liveTradeLog');
    if (!box) return;

    try {
      var r = await fetch('/mixer/' + window.MIXER_ID + '/tradelog');
      if (!r.ok) return;
      var b = await r.json();
      renderTrades(b.trades || []);
    } catch (e) { }
  }

  function renderTrades(trades) {
    var box = el('liveTradeLog');
    if (!box) return;

    if (!trades.length) {
      box.innerHTML = '<div class="px-4 py-8 text-center text-xs text-gray-500">' +
        'No trades yet. Be the first to buy this mixer.</div>';
      return;
    }

    box.innerHTML = trades.map(function (t) {
      var isBuy = t.side === 'buy';
      var colour = isBuy ? '#22c55e' : '#f6465d';

      var sol = Number(t.solAmount);
      var hasSol = isFinite(sol) && sol > 0;
      var amount = hasSol ? sol.toFixed(4) : fmtShares(t.shares);
      var amountUnit = hasSol ? ' SOL' : ' sh';

      var rate = Number(window.SOL_USD);
      var totalUsd = (hasSol && isFinite(rate) && rate > 0) ? sol * rate : null;
      var totalText = totalUsd === null
        ? '—'
        : '$' + (totalUsd >= 1 ? totalUsd.toFixed(2) : totalUsd.toFixed(4));

      var px = fmtLivePrice(t.priceUsd);
      var priceText = px ? '$' + px : '<span class="text-gray-600">—</span>';

      var age = ago(t.createdAt);

      var trader = t.wallet || '—';
      var traderCell = t.walletFull
        ? '<a href="https://explorer.solana.com/address/' + t.walletFull + '?cluster=devnet"'
          + ' target="_blank" rel="noopener"'
          + ' class="text-[11.5px] font-mono text-gray-400 hover:text-white transition-colors"'
          + ' title="' + t.walletFull + '">' + trader + '</a>'
        : '<span class="text-[11.5px] font-mono text-gray-500">' + trader + '</span>';

      var txCell = t.signature
        ? '<a href="https://explorer.solana.com/tx/' + t.signature + '?cluster=devnet"'
          + ' target="_blank" rel="noopener" title="View transaction"'
          + ' class="inline-flex items-center justify-center text-gray-600 hover:text-white transition-colors">'
          + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
          + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
          + '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
          + '</a>'
        : '';

      return '<div class="relative flex w-full flex-row px-4 h-9 items-center hover:bg-[#21262d]/40">'

        + '<div class="absolute right-0 top-0 h-9 pointer-events-none" style="width:42%;'
        +   'background:linear-gradient(to left, ' + colour + '1f, ' + colour + '00)"></div>'
        + '<div class="relative z-[1] flex w-full flex-row items-center">'
        +   '<div class="w-[60px] shrink-0"><span class="text-[11.5px] text-gray-500">' + age + '</span></div>'
        +   '<div class="w-[44px] shrink-0"><span class="text-[11.5px] font-semibold" style="color:' + colour + '">'
        +     (isBuy ? 'Buy' : 'Sell') + '</span></div>'
        +   '<div class="flex-1 text-right"><span class="text-[11.5px] text-gray-400 tabular-nums">'
        +     priceText + '</span></div>'
        +   '<div class="flex-1 text-right"><span class="text-[11.5px] text-gray-300 tabular-nums">'
        +     amount + '<span class="text-gray-600">' + amountUnit + '</span></span></div>'
        +   '<div class="flex-1 text-right"><span class="text-[11.5px] font-semibold tabular-nums" style="color:' + colour + '">'
        +     totalText + '</span></div>'
        +   '<div class="w-[104px] shrink-0 text-right">' + traderCell + '</div>'
        +   '<div class="w-[22px] shrink-0 text-right">' + txCell + '</div>'
        + '</div></div>';
    }).join('');
  }

  function fmtSol(n, dp) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(dp === undefined ? 4 : dp);
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '—';
    var m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    var d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }

  async function loadHolders() {
    var box = el('holdersList');
    if (!box) return;

    box.innerHTML = '<p class="text-xs text-gray-500">Loading holders…</p>';
    try {
      var r = await fetch('/mixer/' + window.MIXER_ID + '/holders');
      var b = await r.json();
      if (!r.ok) throw new Error(b.error || 'Failed');

      var hs = b.holders || [];

      var countEl = el('holdersCount');
      if (countEl) {
        countEl.textContent = hs.filter(function (h) { return !h.closed; }).length;
      }

      if (!hs.length) {
        box.innerHTML = '<p class="text-xs text-gray-500">No holders yet.</p>';
        return;
      }

      var head = '<thead class="bg-black/30 text-gray-500 sticky top-0">' +
        '<tr>' +
        '<th class="text-left font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">#</th>' +
        '<th class="text-left font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">Wallet</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">SOL Bal</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">Bought</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">Sold</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">PnL</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">Remaining</th>' +
        '<th class="text-right font-semibold px-3 py-2 text-[10px] uppercase tracking-wider">Held</th>' +
        '</tr></thead>';

      var rows = hs.map(function (h) {

        var pnl = h.closed ? h.realisedPnl : h.unrealisedPnl;
        var pct = h.closed ? h.realisedPct : h.unrealisedPct;

        var pnlColour = (pnl === null || pnl === undefined) ? '#9AA0A6'
          : (pnl >= 0 ? '#22c55e' : '#ef4444');
        var pnlText = (pnl === null || pnl === undefined) ? '—'
          : (pnl >= 0 ? '+' : '') + fmtSol(pnl, 6) +
            ((pct !== null && pct !== undefined) ? ' <span style="opacity:.7">(' +
              (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)</span>' : '') +
            (h.closed ? '<span class="block text-[10px] text-gray-600">realised</span>' : '');

        var bought = h.boughtSol > 0
          ? fmtSol(h.boughtSol) +
            '<span class="block text-[10px] text-gray-600">' +
            (h.tradeCount || 0) + (h.tradeCount === 1 ? ' trade' : ' trades') + '</span>'
          : '—';
        var sold = h.soldSol > 0
          ? fmtSol(h.soldSol)
          : '<span class="text-gray-600">—</span>';

        var rankCell = h.closed
          ? '<span class="text-gray-700">–</span>'
          : (h.rank == null ? '' : h.rank);

        var supplyLine = h.closed
          ? '<span class="block text-[10px] text-gray-600">exited</span>'
          : (h.percent == null ? ''
             : '<span class="block text-[10px] text-gray-600">' + h.percent.toFixed(2) + '% of supply</span>');

        var remaining = h.closed
          ? '<span class="text-gray-600">—</span>'
          : (h.remainingSol !== null && h.remainingSol !== undefined
             ? fmtSol(h.remainingSol, 6) + ' <span class="text-[10px] text-gray-600">SOL</span>'
             : fmtShares(h.shares));

        return '<tr class="border-t border-[#21262d] hover:bg-[#21262d]/40' +
            (h.closed ? ' opacity-70' : '') + '">' +
          '<td class="px-3 py-2 text-gray-600 text-xs">' + rankCell + '</td>' +
          '<td class="px-3 py-2"><a href="https://explorer.solana.com/address/' + h.owner +
            '?cluster=devnet" target="_blank" rel="noopener" class="text-xs font-mono text-gray-300 hover:text-white hover:underline">' +
            short(h.owner, 4, 4) + '</a>' + supplyLine + '</td>' +
          '<td class="px-3 py-2 text-right text-xs tabular-nums text-gray-400">' + fmtSol(h.solBalance) + '</td>' +
          '<td class="px-3 py-2 text-right text-xs tabular-nums text-gray-300">' + bought + '</td>' +
          '<td class="px-3 py-2 text-right text-xs tabular-nums text-gray-300">' + sold + '</td>' +
          '<td class="px-3 py-2 text-right text-xs tabular-nums" style="color:' + pnlColour + '">' + pnlText + '</td>' +
          '<td class="px-3 py-2 text-right text-xs tabular-nums text-white">' + remaining + '</td>' +
          '<td class="px-3 py-2 text-right text-xs text-gray-400">' + fmtDuration(h.heldMs) + '</td>' +
          '</tr>';
      }).join('');

      box.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-sm">' +
        head + '<tbody>' + rows + '</tbody></table></div>';
    } catch (err) {
      box.innerHTML = '<p class="text-xs text-red-400">' + err.message + '</p>';
    }
  }

  function say(kind, msg, detail) {
    if (window.Alerts) window.Alerts[kind](msg, detail ? { detail: detail } : undefined);
  }

  async function loadLimitOrders() {
    var box = el('limitOrdersList');
    if (!box) return;

    try {
      var r = await fetch('/mixer/' + window.MIXER_ID + '/limit');
      var b = await r.json();
      if (!r.ok) return;

      var orders = (b.orders || []).slice(0, 8);
      var html;
      if (!orders.length) {
        html = '<p class="text-[12px] text-gray-500 py-1">No limit orders. Place one from the Limit tab in the trade panel.</p>';
      } else {
        var statusColour = {
          open: '#9AA0A6', filling: '#eab308', filled: '#22c55e',
          cancelled: '#6b7280', failed: '#f6465d'
        };
        html = '<table class="w-full pos-table"><thead><tr>' +
          '<th class="text-left" style="padding-left:0">Side</th>' +
          '<th class="text-right">Amount</th>' +
          '<th class="text-right">Trigger</th>' +
          '<th class="text-right">Status</th>' +
          '<th style="padding-right:0"></th>' +
          '</tr></thead><tbody>' + orders.map(function (o) {
            var buy = o.side === 'buy';
            var amount = buy ? o.amount + ' SOL' : o.amount + '% of position';
            var cancel = o.status === 'open'
              ? '<button data-cancel="' + o.id + '" class="limit-cancel text-[11px] text-gray-500 hover:text-[#f6465d] transition-colors">Cancel</button>'
              : '';
            return '<tr>' +
              '<td style="padding-left:0"><span class="font-semibold" style="color:' + (buy ? '#22c55e' : '#f6465d') + '">' +
                (buy ? 'Buy' : 'Sell') + '</span></td>' +
              '<td class="text-right text-gray-300">' + amount + '</td>' +
              '<td class="text-right text-white">$' + (fmtLivePrice(o.triggerPrice) || '—') + '</td>' +
              '<td class="text-right capitalize" style="color:' + (statusColour[o.status] || '#9AA0A6') + '">' + o.status + '</td>' +
              '<td class="text-right" style="padding-right:0">' + cancel + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table>';
      }

      if (box.dataset.html === html) return;
      box.dataset.html = html;
      box.innerHTML = html;

      box.querySelectorAll('.limit-cancel').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          btn.textContent = 'Cancelling…';
          try {
            var res = await fetch('/mixer/' + window.MIXER_ID + '/limit/' + btn.dataset.cancel, { method: 'DELETE' });
            var body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Cancel failed');
            say('success', 'Limit order cancelled');
            loadLimitOrders();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Cancel';
            say('error', 'Could not cancel the order', e.message);
          }
        });
      });
    } catch (e) { }
  }

  async function placeLimitOrder(side, amount, triggerPrice) {
    if (!amount || amount <= 0) return say('error', 'Enter an amount');
    if (!triggerPrice || triggerPrice <= 0) return say('error', 'Enter a trigger price');
    if (side === 'sell' && amount > 100) return say('error', 'That is more than you hold');

    var btn = el('limitButton');
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }

    try {
      var r = await fetch('/mixer/' + window.MIXER_ID + '/limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: side, amount: amount, triggerPrice: triggerPrice })
      });
      var b = await r.json();
      if (!r.ok) throw new Error(b.error || 'Failed');

      say('success', 'Limit order placed',
        'Fills when the price ' + (side === 'buy' ? 'falls to' : 'rises to') +
        ' $' + (fmtLivePrice(triggerPrice) || '—') + '. See it under Your Position.');
      loadLimitOrders();
    } catch (err) {
      say('error', 'Could not place the order', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  window.MixerLive = {
    loadTrades: loadTrades,
    loadHolders: loadHolders,
    loadLimitOrders: loadLimitOrders,
    placeLimitOrder: placeLimitOrder
  };

  function init() {
    loadTrades();
    loadLimitOrders();

    try {
      if (window.io) {
        var socket = window.io();
        socket.on('mixer:trade', function (t) {
          if (t.mixerId === window.MIXER_ID) {
            loadTrades();
            loadHolders();
            refreshChartMarkers();
            refreshOwnPosition();
          }
        });
        socket.on('limit:filled', function (o) {
          if (o.mixerId === window.MIXER_ID) {
            loadTrades();
            loadLimitOrders();
            refreshChartMarkers();
            refreshOwnPosition();
          }
        });
      }
    } catch (e) { }

    setInterval(loadTrades, POLL_MS);
    setInterval(loadLimitOrders, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
