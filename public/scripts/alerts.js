
(function () {
  'use strict';

  var HOST_ID = 'alertHost';

  var STYLES = {
    success: { bar: '#22c55e', icon: '&#10003;' },
    error:   { bar: '#f87171', icon: '&#33;' },
    info:    { bar: '#673DFF', icon: '&#105;' },
  };

  function host() {
    var el = document.getElementById(HOST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = HOST_ID;
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Notifications');
      el.style.cssText =
        'position:fixed;top:64px;right:16px;z-index:9999;display:flex;' +
        'flex-direction:column;gap:8px;max-width:340px;pointer-events:none';
      document.body.appendChild(el);
    }
    return el;
  }

  function show(kind, message, opts) {
    opts = opts || {};
    var style = STYLES[kind] || STYLES.info;

    var timeout = opts.timeout !== undefined
      ? opts.timeout
      : (kind === 'error' ? 0 : 5000);

    var el = document.createElement('div');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.style.cssText =
      'pointer-events:auto;position:relative;display:flex;gap:9px;align-items:flex-start;' +
      'padding:10px 11px 10px 12px;border-radius:7px;background:#15181e;' +
      'border:1px solid #2C2C2C;border-left:3px solid ' + style.bar + ';' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);' +
      'font-size:12px;line-height:1.45;color:#E6E6E6;' +
      'opacity:0;transform:translateX(12px);transition:opacity .16s ease,transform .16s ease';

    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';

    var title = document.createElement('div');
    title.style.cssText = 'color:#fff;font-weight:600';
    title.textContent = message;
    body.appendChild(title);

    if (opts.detail) {
      var detail = document.createElement('div');
      detail.style.cssText = 'color:#9AA0A6;margin-top:2px;font-size:11px;word-break:break-word';
      detail.textContent = opts.detail;
      body.appendChild(detail);
    }

    if (opts.html) {
      var extra = document.createElement('div');
      extra.style.cssText = 'margin-top:5px;font-size:11px';
      extra.innerHTML = opts.html;
      body.appendChild(extra);
    }

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&times;';
    close.style.cssText =
      'flex-shrink:0;background:none;border:0;color:#6b7280;cursor:pointer;' +
      'font-size:15px;line-height:1;padding:0 2px';

    el.appendChild(body);
    el.appendChild(close);
    host().prepend(el);

    requestAnimationFrame(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateX(0)';
    });

    var timer = null;
    var closed = false;

    function dismiss() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      el.style.opacity = '0';
      el.style.transform = 'translateX(12px)';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 160);
    }

    close.addEventListener('click', dismiss);
    if (timeout > 0) timer = setTimeout(dismiss, timeout);

    return { close: dismiss, element: el };
  }

  window.Alerts = {
    show: show,
    success: function (m, o) { return show('success', m, o); },
    error:   function (m, o) { return show('error', m, o); },
    info:    function (m, o) { return show('info', m, o); },
    clear: function () {
      var h = document.getElementById(HOST_ID);
      if (h) h.innerHTML = '';
    },
  };
})();
