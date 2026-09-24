
(function () {
  'use strict';

  var POLL_MS = 30000;
  var el;

  async function refresh() {
    el = el || document.getElementById('navSolBalance');
    if (!el) return;

    try {
      var r = await fetch('/wallet/devnet-balance', { headers: { Accept: 'application/json' } });
      if (!r.ok) {
        el.textContent = '—';
        return;
      }
      var d = await r.json();
      var bal = d.balance === null || d.balance === undefined ? null : d.balance;
      el.textContent = bal === null ? '—' : bal;

      var big = document.getElementById('nav-balance-dropdown');
      if (big) big.textContent = (bal === null ? '—' : bal) + ' SOL';

      var fiat = document.getElementById('nav-fiat-dropdown');
      if (fiat && bal !== null) {
        try {
          var pr = await fetch('/api/sol-price');
          if (pr.ok) {
            var pd = await pr.json();
            if (pd.usd) fiat.textContent = '$' + (Number(bal) * pd.usd).toFixed(2);
          }
        } catch (e) { }
      }
    } catch (e) {

    }
  }

  window.refreshNavBalance = refresh;

  window.requestDevnetAirdrop = async function () {
    var btn = document.getElementById('navAirdropBtn');
    var status = document.getElementById('navAirdropStatus');
    function say(m, bad) {
      if (!status) return;
      status.textContent = m || '';
      status.style.color = bad ? '#f87171' : '#9AA0A6';
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    say('Sending devnet SOL…', false);

    try {
      var r = await fetch('/wallet/devnet-topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sol: 0.5 })
      });
      var b = await r.json();
      if (!r.ok) throw new Error(b.error || 'Top-up failed');

      say('Added ' + b.added + ' SOL', false);
      refresh();
    } catch (err) {
      say(err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Cash'; }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  setInterval(refresh, POLL_MS);
})();
