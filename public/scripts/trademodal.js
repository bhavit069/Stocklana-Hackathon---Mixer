
(function () {
  'use strict';

  var root = null;
  var els = {};
  var state = { open: false, phase: 'review', onConfirm: null, onCancel: null };

  function h(tag, css, html) {
    var el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  function build() {
    if (root) return;

    root = h('div', 'position:fixed;inset:0;z-index:9998;display:none');
    root.id = 'tradeModal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tradeModalTitle');

    var backdrop = h('div',
      'position:absolute;inset:0;background:rgba(0,0,0,.62);' +
      'opacity:0;transition:opacity .15s ease');
    els.backdrop = backdrop;

    var panel = h('div',
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-48%) scale(.98);' +
      'width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;' +
      'background:#0f1216;border:1px solid #2C2C2C;border-radius:10px;' +
      'box-shadow:0 24px 64px rgba(0,0,0,.6);opacity:0;' +
      'transition:opacity .15s ease,transform .15s ease');
    els.panel = panel;

    var head = h('div',
      'display:flex;align-items:center;gap:8px;padding:14px 16px;' +
      'border-bottom:1px solid #1e2228');

    els.title = h('div', 'flex:1;font-size:13px;font-weight:600;color:#fff');
    els.title.id = 'tradeModalTitle';

    els.close = h('button', 'background:none;border:0;color:#6b7280;cursor:pointer;' +
      'font-size:18px;line-height:1;padding:0 2px', '&times;');
    els.close.type = 'button';
    els.close.setAttribute('aria-label', 'Close');

    head.appendChild(els.title);
    head.appendChild(els.close);

    var body = h('div', 'padding:14px 16px');

    els.summary = h('div', 'font-size:12px;color:#9AA0A6;margin-bottom:12px');

    els.steps = h('div', 'display:flex;flex-direction:column;gap:2px');

    els.note = h('div',
      'margin-top:12px;font-size:11px;color:#7d8590;min-height:16px;line-height:1.45');

    body.appendChild(els.summary);
    body.appendChild(els.steps);
    body.appendChild(els.note);

    var foot = h('div',
      'display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;' +
      'border-top:1px solid #1e2228');

    els.cancel = h('button',
      'padding:7px 13px;border-radius:6px;border:1px solid #2C2C2C;background:none;' +
      'color:#9AA0A6;font-size:12px;cursor:pointer', 'Cancel');
    els.cancel.type = 'button';

    els.confirm = h('button',
      'padding:7px 15px;border-radius:6px;border:0;background:#673DFF;color:#fff;' +
      'font-size:12px;font-weight:600;cursor:pointer', 'Confirm');
    els.confirm.type = 'button';

    foot.appendChild(els.cancel);
    foot.appendChild(els.confirm);

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    root.appendChild(backdrop);
    root.appendChild(panel);
    document.body.appendChild(root);

    els.confirm.addEventListener('click', function () {
      if (state.phase === 'review' && state.onConfirm) {
        state.onConfirm();
      } else if (state.phase === 'done' || state.phase === 'failed') {
        close();
      }
    });
    els.cancel.addEventListener('click', function () { requestClose(); });
    els.close.addEventListener('click', function () { requestClose(); });
    backdrop.addEventListener('click', function () { requestClose(); });

    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); }
      else if (e.key === 'Enter' && state.phase === 'review') {
        e.preventDefault();
        if (state.onConfirm) state.onConfirm();
      }
    });
  }

  function requestClose() {
    if (state.phase === 'running') {
      flashNote('This trade is already executing — it cannot be cancelled.');
      return;
    }
    if (state.phase === 'review' && state.onCancel) state.onCancel();
    close();
  }

  var flashTimer = null;
  function flashNote(msg) {
    if (!els.note) return;
    var prev = els.note.dataset.base || '';
    els.note.textContent = msg;
    els.note.style.color = '#f59e0b';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      els.note.textContent = prev;
      els.note.style.color = '#7d8590';
    }, 2200);
  }

  function setNote(msg) {
    if (!els.note) return;
    els.note.dataset.base = msg || '';
    els.note.textContent = msg || '';
    els.note.style.color = '#7d8590';
  }

  function renderSteps(labels) {
    els.steps.innerHTML = '';
    els.rows = labels.map(function (label, i) {
      var row = h('div',
        'display:flex;align-items:center;gap:9px;padding:5px 0;' +
        'font-size:12px;color:#6b7280;transition:color .15s ease');

      var dot = h('span',
        'flex-shrink:0;width:7px;height:7px;border-radius:50%;background:#2C2C2C;' +
        'transition:background .15s ease,box-shadow .15s ease');

      var text = h('span', 'flex:1;min-width:0;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      text.textContent = label;

      var tail = h('span', 'flex-shrink:0;font-size:11px;color:#6b7280;min-width:14px;text-align:right');

      row.appendChild(dot);
      row.appendChild(text);
      row.appendChild(tail);
      els.steps.appendChild(row);
      return { row: row, dot: dot, text: text, tail: tail, index: i };
    });
  }

  function markProgress(index, activeLabel) {
    if (!els.rows) return;
    els.rows.forEach(function (r, i) {
      if (i < index) {
        r.dot.style.background = '#22c55e';
        r.dot.style.boxShadow = 'none';
        r.row.style.color = '#9AA0A6';
        if (!r.tail.dataset.link) r.tail.innerHTML = '&#10003;';
      } else if (i === index) {
        r.dot.style.background = '#673DFF';
        r.dot.style.boxShadow = '0 0 0 3px rgba(103,61,255,.18)';
        r.row.style.color = '#fff';
        if (activeLabel) r.text.textContent = activeLabel;
      } else {
        r.dot.style.background = '#2C2C2C';
        r.dot.style.boxShadow = 'none';
        r.row.style.color = '#6b7280';
      }
    });
  }

  function markAllDone() {
    if (!els.rows) return;
    els.rows.forEach(function (r) {
      r.dot.style.background = '#22c55e';
      r.dot.style.boxShadow = 'none';
      r.row.style.color = '#9AA0A6';
      if (!r.tail.dataset.link) r.tail.innerHTML = '&#10003;';
    });
  }

  function markFailed(index) {
    if (!els.rows) return;
    var r = els.rows[index];
    if (!r) return;
    r.dot.style.background = '#f87171';
    r.dot.style.boxShadow = 'none';
    r.row.style.color = '#f87171';
    r.tail.innerHTML = '&#33;';
  }

  function linkStep(index, href, label) {
    if (!els.rows || !els.rows[index]) return;
    var tail = els.rows[index].tail;
    tail.dataset.link = '1';
    tail.innerHTML = '<a href="' + href + '" target="_blank" rel="noopener" ' +
      'style="color:#673DFF;text-decoration:none">' + (label || 'tx &#8599;') + '</a>';
  }

  function setPhase(phase) {
    state.phase = phase;

    var running = phase === 'running';
    var finished = phase === 'done' || phase === 'failed';

    els.cancel.style.display = running || finished ? 'none' : '';
    els.confirm.disabled = running;
    els.confirm.style.opacity = running ? '.55' : '1';
    els.confirm.style.cursor = running ? 'default' : 'pointer';
    els.close.style.visibility = running ? 'hidden' : 'visible';

    if (phase === 'review')  els.confirm.textContent = state.confirmLabel || 'Confirm';
    if (running)             els.confirm.textContent = state.runningLabel || 'Executing…';
    if (phase === 'done')    els.confirm.textContent = 'Done';
    if (phase === 'failed')  els.confirm.textContent = 'Close';

    if (phase === 'done') {
      els.confirm.style.background = '#16a34a';
    } else if (phase === 'failed') {
      els.confirm.style.background = '#2C2C2C';
    } else {
      els.confirm.style.background = '#673DFF';
    }
  }

  function open(opts) {
    build();
    state.open = true;
    state.onConfirm = opts.onConfirm || null;
    state.onCancel = opts.onCancel || null;
    state.confirmLabel = opts.confirmLabel || 'Confirm';
    state.runningLabel = opts.runningLabel || 'Executing…';

    els.title.textContent = opts.title || 'Confirm trade';
    els.summary.innerHTML = opts.summaryHtml || '';
    renderSteps(opts.steps || []);
    markProgress(-1);
    setNote(opts.note || '');
    setPhase('review');

    root.style.display = 'block';
    requestAnimationFrame(function () {
      els.backdrop.style.opacity = '1';
      els.panel.style.opacity = '1';
      els.panel.style.transform = 'translate(-50%,-50%) scale(1)';
    });

    els.confirm.focus();
  }

  function close() {
    if (!root) return;
    state.open = false;
    els.backdrop.style.opacity = '0';
    els.panel.style.opacity = '0';
    els.panel.style.transform = 'translate(-50%,-48%) scale(.98)';
    setTimeout(function () {
      if (!state.open) root.style.display = 'none';
    }, 150);
  }

  window.TradeModal = {
    open: open,
    close: close,
    isOpen: function () { return state.open; },
    phase: function () { return state.phase; },
    setPhase: setPhase,
    setNote: setNote,
    setTitle: function (t) { if (els.title) els.title.textContent = t; },
    setSummary: function (html) { if (els.summary) els.summary.innerHTML = html; },
    steps: renderSteps,
    progress: markProgress,
    allDone: markAllDone,
    fail: markFailed,
    link: linkStep,
  };
})();
