
(function () {
  'use strict';

  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b58encode(bytes) {
    if (!bytes || bytes.length === 0) return '';

    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

    var digits = [];
    for (var i = zeros; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }

    var out = '';
    for (var z = 0; z < zeros; z++) out += B58[0];
    for (var k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
    return out;
  }

  var standardWallets = [];

  function supportsSolanaSignIn(w) {
    if (!w || !w.features) return false;
    var chains = w.chains || [];
    var onSolana = chains.some(function (c) { return String(c).indexOf('solana:') === 0; });
    return onSolana && !!w.features['standard:connect'] && !!w.features['solana:signMessage'];
  }

  function registerStandard() {
    for (var i = 0; i < arguments.length; i++) {
      var w = arguments[i];
      if (supportsSolanaSignIn(w) && standardWallets.indexOf(w) === -1) standardWallets.push(w);
    }
    if (picker && picker.open) renderList();
    return function unregister() {};
  }

  try {
    window.addEventListener('wallet-standard:register-wallet', function (e) {
      if (typeof e.detail === 'function') e.detail({ register: registerStandard });
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
      detail: { register: registerStandard },
    }));
  } catch (e) { }

  function standardAdapter(w) {
    var account = null;
    return {
      id: 'std:' + w.name,
      name: w.name,
      icon: w.icon || null,
      installed: true,
      connect: function () {
        return Promise.resolve(w.features['standard:connect'].connect()).then(function (r) {
          account = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]);
          if (!account) throw new Error(w.name + ' did not share an account');
          return { address: account.address };
        });
      },
      signMessage: function (bytes) {
        return Promise.resolve(
          w.features['solana:signMessage'].signMessage({ account: account, message: bytes })
        ).then(function (out) {
          var first = Array.isArray(out) ? out[0] : out;
          return first && first.signature ? first.signature : first;
        });
      },
    };
  }

  function injectedAdapter(name, provider) {
    return {
      id: 'inj:' + name,
      name: name,
      icon: null,
      installed: true,
      connect: function () {
        return Promise.resolve(provider.connect()).then(function (resp) {
          var pk = (resp && resp.publicKey) || provider.publicKey;
          if (!pk) throw new Error(name + ' did not return a public key');
          return { address: pk.toString() };
        });
      },
      signMessage: function (bytes) {
        return Promise.resolve(provider.signMessage(bytes, 'utf8')).then(function (signed) {

          return signed && signed.signature ? signed.signature : signed;
        });
      },
    };
  }

  function legacyProviders() {
    var out = [];
    if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) {
      out.push(injectedAdapter('Phantom', window.phantom.solana));
    }
    if (window.solflare && window.solflare.isSolflare) {
      out.push(injectedAdapter('Solflare', window.solflare));
    }
    if (window.backpack && window.backpack.isBackpack) {
      out.push(injectedAdapter('Backpack', window.backpack));
    }
    if (window.solana && !out.length) {
      out.push(injectedAdapter('Browser wallet', window.solana));
    }
    return out;
  }

  var IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  var KNOWN = [
    {
      name: 'Phantom', colour: '#AB9FF2', text: '#1b1440',
      install: 'https://phantom.app/download',
      mobile: function (u) {
        return 'https://phantom.app/ul/browse/' + encodeURIComponent(u) +
          '?ref=' + encodeURIComponent(location.origin);
      },
    },
    {
      name: 'Solflare', colour: '#FC7227', text: '#1a0d02',
      install: 'https://solflare.com/download',
      mobile: function (u) {
        return 'https://solflare.com/ul/v1/browse/' + encodeURIComponent(u) +
          '?ref=' + encodeURIComponent(location.origin);
      },
    },
    {
      name: 'Backpack', colour: '#E33E3F', text: '#ffffff',
      install: 'https://backpack.app/download',
      mobile: null,
    },
  ];

  function listWallets() {
    var seen = {};
    var installed = [];

    standardWallets.forEach(function (w) {
      var key = w.name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      installed.push(standardAdapter(w));
    });

    legacyProviders().forEach(function (a) {
      var key = a.name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      installed.push(a);
    });

    var absent = KNOWN.filter(function (k) { return !seen[k.name.toLowerCase()]; })
      .map(function (k) {
        return {
          id: 'known:' + k.name, name: k.name, icon: null, installed: false,
          colour: k.colour, text: k.text,
          href: IS_MOBILE && k.mobile ? k.mobile(location.href) : k.install,
          mobileOpen: IS_MOBILE && !!k.mobile,
        };
      });

    var last = null;
    try { last = localStorage.getItem('mixer.lastWallet'); } catch (e) {  }
    if (last) {
      installed.sort(function (a, b) {
        return (b.name === last) - (a.name === last);
      });
    }

    return { installed: installed, absent: absent, last: last };
  }

  function getProvider() {
    var list = listWallets().installed;
    return list.length ? { name: list[0].name, provider: list[0] } : null;
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  function signInWith(adapter, say) {
    var address = null;
    say('Waiting for ' + adapter.name + '…', 'info');

    return adapter.connect()
      .then(function (acc) {
        address = acc.address;
        return postJSON('/auth/wallet/nonce', { address: address });
      })
      .then(function (data) {
        say('Approve the sign-in message in ' + adapter.name + '…', 'info');
        return adapter.signMessage(new TextEncoder().encode(data.message));
      })
      .then(function (sigBytes) {
        if (!sigBytes || !sigBytes.length) throw new Error(adapter.name + ' returned no signature');
        return postJSON('/auth/wallet/verify', { address: address, signature: b58encode(sigBytes) });
      })
      .then(function (result) {
        try { localStorage.setItem('mixer.lastWallet', adapter.name); } catch (e) {  }
        say('Signed in, redirecting…', 'ok');
        window.location.href = result.redirect;
        return result;
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : 'Wallet sign-in failed';

        if (/user rejected|user denied|declin|cancel/i.test(msg)) msg = 'Request cancelled.';
        say(msg, 'error');
        throw err;
      });
  }

  var picker = null;

  var CSS = [
    '.mw-root{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:16px}',
    '.mw-root.mw-open{display:flex}',
    '.mw-back{position:absolute;inset:0;background:rgba(5,6,8,.72);backdrop-filter:blur(3px);opacity:0;transition:opacity .15s ease}',
    '.mw-open .mw-back{opacity:1}',
    '.mw-panel{position:relative;width:100%;max-width:380px;background:#111317;border:1px solid rgba(255,255,255,.08);',
    'border-radius:16px;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 30px 80px -20px rgba(0,0,0,.8);',
    'opacity:0;transform:translateY(8px) scale(.98);transition:opacity .15s ease,transform .15s ease;overflow:hidden}',
    '.mw-open .mw-panel{opacity:1;transform:none}',
    '.mw-head{display:flex;align-items:center;justify-content:space-between;padding:18px 18px 6px}',
    '.mw-title{font-size:16px;font-weight:600;color:#fff}',
    '.mw-sub{padding:0 18px 12px;font-size:12px;color:#8b919a;line-height:1.5}',
    '.mw-x{background:none;border:0;color:#6b7280;font-size:22px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.mw-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
    '.mw-list{padding:4px 10px 10px;max-height:min(60vh,420px);overflow-y:auto}',
    '.mw-label{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;padding:10px 8px 6px}',
    '.mw-row{display:flex;align-items:center;gap:12px;width:100%;padding:10px 10px;border-radius:10px;border:1px solid transparent;',
    'background:none;color:#e5e7eb;font-size:14px;font-weight:500;cursor:pointer;text-align:left;text-decoration:none;transition:background .12s,border-color .12s}',
    '.mw-row:hover{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06)}',
    '.mw-row:focus-visible{outline:2px solid #7453E2;outline-offset:1px}',
    '.mw-row[disabled]{cursor:default;opacity:.45}',
    '.mw-row.mw-busy{opacity:1;background:rgba(116,83,226,.10);border-color:rgba(116,83,226,.35)}',
    '.mw-icon{width:32px;height:32px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;',
    'font-weight:700;font-size:14px;overflow:hidden;background:#1b1e24}',
    '.mw-icon img{width:100%;height:100%;object-fit:cover}',
    '.mw-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mw-tag{font-size:11px;font-weight:500;color:#8b919a;flex-shrink:0}',
    '.mw-tag.mw-det{color:#4ade80}',
    '.mw-tag.mw-last{color:#a78bfa}',
    '.mw-spin{width:14px;height:14px;border:2px solid rgba(167,139,250,.3);border-top-color:#a78bfa;border-radius:50%;animation:mw-spin .7s linear infinite;flex-shrink:0}',
    '@keyframes mw-spin{to{transform:rotate(360deg)}}',
    '.mw-status{margin:0 18px 14px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.45;display:none}',
    '.mw-status.mw-info{display:block;background:rgba(255,255,255,.04);color:#c4c8cf}',
    '.mw-status.mw-error{display:block;background:rgba(248,113,113,.08);color:#fca5a5}',
    '.mw-status.mw-ok{display:block;background:rgba(74,222,128,.08);color:#86efac}',
    '.mw-foot{padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,.06);font-size:11px;color:#6b7280;line-height:1.5}',
    '.mw-empty{padding:6px 8px 4px;font-size:12px;color:#8b919a;line-height:1.5}',
  ].join('');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildPicker() {
    if (picker) return picker;

    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = el('div', 'mw-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'mwTitle');

    var back = el('div', 'mw-back');
    var panel = el('div', 'mw-panel');

    var head = el('div', 'mw-head');
    var title = el('div', 'mw-title', 'Connect a wallet');
    title.id = 'mwTitle';
    var close = el('button', 'mw-x');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    head.appendChild(title);
    head.appendChild(close);

    var sub = el('div', 'mw-sub',
      'Choose the wallet to sign in with. You’ll be asked to sign a message — it costs nothing and moves no funds.');

    var list = el('div', 'mw-list');
    var status = el('div', 'mw-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    var foot = el('div', 'mw-foot',
      'New to Solana wallets? Phantom and Solflare are free browser extensions and take about a minute to set up.');

    panel.appendChild(head);
    panel.appendChild(sub);
    panel.appendChild(list);
    panel.appendChild(status);
    panel.appendChild(foot);
    root.appendChild(back);
    root.appendChild(panel);
    document.body.appendChild(root);

    picker = { root: root, list: list, status: status, open: false, busy: false, onDone: null };

    function requestClose() { if (!picker.busy) closePicker(); }
    close.addEventListener('click', requestClose);
    back.addEventListener('click', requestClose);
    document.addEventListener('keydown', function (e) {
      if (picker.open && e.key === 'Escape') requestClose();
    });

    return picker;
  }

  function setStatus(msg, kind) {
    if (!picker) return;
    picker.status.textContent = msg || '';
    picker.status.className = 'mw-status' + (msg ? ' mw-' + (kind || 'info') : '');
  }

  function iconFor(w) {
    var box = el('span', 'mw-icon');
    if (w.icon) {
      var img = el('img');
      img.alt = '';
      img.src = w.icon;
      box.appendChild(img);
    } else {
      box.textContent = w.name.charAt(0).toUpperCase();
      box.style.background = w.colour || '#2a2e36';
      box.style.color = w.text || '#fff';
    }
    return box;
  }

  function renderList() {
    if (!picker) return;
    var data = listWallets();
    var list = picker.list;
    list.innerHTML = '';

    if (data.installed.length) {
      list.appendChild(el('div', 'mw-label', 'Installed'));
      data.installed.forEach(function (w) {
        var row = el('button', 'mw-row');
        row.type = 'button';
        row.dataset.id = w.id;
        row.appendChild(iconFor(w));
        row.appendChild(el('span', 'mw-name', w.name));
        var isLast = data.last === w.name;
        row.appendChild(el('span', 'mw-tag ' + (isLast ? 'mw-last' : 'mw-det'),
          isLast ? 'Last used' : 'Detected'));
        row.addEventListener('click', function () { choose(w, row); });
        list.appendChild(row);
      });
    } else {
      list.appendChild(el('div', 'mw-label', 'Installed'));
      list.appendChild(el('div', 'mw-empty', IS_MOBILE
        ? 'Mobile browsers can’t run wallet extensions. Open this page inside your wallet app instead.'
        : 'No Solana wallet found in this browser. Install one below, then reload this page.'));
    }

    if (data.absent.length) {
      list.appendChild(el('div', 'mw-label', data.installed.length ? 'Other wallets' : 'Get a wallet'));
      data.absent.forEach(function (w) {
        var row = el('a', 'mw-row');
        row.href = w.href;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        row.appendChild(iconFor(w));
        row.appendChild(el('span', 'mw-name', w.name));
        row.appendChild(el('span', 'mw-tag', w.mobileOpen ? 'Open in app ↗' : 'Install ↗'));
        list.appendChild(row);
      });
    }
  }

  function setRowsBusy(activeRow) {
    picker.list.querySelectorAll('button.mw-row').forEach(function (r) {
      r.disabled = !!activeRow && r !== activeRow;
      r.classList.toggle('mw-busy', r === activeRow);
      var tag = r.querySelector('.mw-tag, .mw-spin');
      if (r === activeRow && tag && !tag.classList.contains('mw-spin')) {
        tag.replaceWith(el('span', 'mw-spin'));
      }
    });
  }

  function choose(adapter, row) {
    if (picker.busy) return;
    picker.busy = true;
    setRowsBusy(row);

    signInWith(adapter, setStatus)
      .then(function () {
        if (picker.onDone) picker.onDone(true);
      })
      .catch(function () {

        picker.busy = false;
        renderList();
      });
  }

  function openPicker(opts) {
    buildPicker();
    picker.onDone = (opts && opts.onDone) || null;
    picker.busy = false;
    setStatus('', null);
    renderList();

    picker.root.classList.add('mw-open');
    picker.open = true;
    requestAnimationFrame(function () {
      var first = picker.list.querySelector('.mw-row');
      if (first) first.focus();
    });
  }

  function closePicker() {
    if (!picker) return;
    picker.root.classList.remove('mw-open');
    picker.open = false;
  }

  function connectWallet() {
    openPicker();
  }

  window.MixerWallet = {
    connectWallet: connectWallet,
    openPicker: openPicker,
    closePicker: closePicker,
    listWallets: listWallets,
    getProvider: getProvider,
    b58encode: b58encode,
  };
})();
