
(function () {
  if (window.__navTickerBound) return;
  window.__navTickerBound = true;

  function fmtUsd(n) {
    if (!isFinite(n) || n <= 0) return '—';
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toFixed(4);
  }

  function paint(priceId, changeId, entry) {
    var p = document.getElementById(priceId);
    var c = document.getElementById(changeId);
    if (!p) return;

    if (!entry || !isFinite(entry.price)) {
      p.textContent = '—';
      if (c) c.textContent = '';
      return;
    }

    var next = fmtUsd(entry.price);
    if (p.textContent !== next) {
      p.textContent = next;

      p.style.transition = 'none';
      p.style.color = '#7453E2';
      setTimeout(function () {
        p.style.transition = 'color .6s ease';
        p.style.color = '#fff';
      }, 60);
    }

    if (!c) return;

    if (entry.change24h == null || !isFinite(entry.change24h)) {

      c.textContent = '—';
      c.style.color = '#6b7280';
    } else {
      var up = entry.change24h >= 0;
      c.textContent = (up ? '+' : '') + entry.change24h.toFixed(2) + '%';
      c.style.color = up ? '#22c55e' : '#f6465d';
    }
  }

  function tick() {

    if (document.visibilityState !== 'visible') return;

    fetch('/api/ticker', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        paint('tickSolPrice', 'tickSolChange', d.sol);
        paint('tickBtcPrice', 'tickBtcChange', d.btc);

        if (d.sol && isFinite(d.sol.price)) window.SOL_USD = d.sol.price;
      })
      .catch(function () { });
  }

  if (document.getElementById('priceStrip') || document.getElementById('navTicker')) {
    tick();
    setInterval(tick, 30000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') tick();
    });
  }
})();
