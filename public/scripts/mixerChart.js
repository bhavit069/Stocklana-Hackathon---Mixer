const container = document.getElementById("chart-root");

const chart = LightweightCharts.createChart(container, {
  width: container.clientWidth,
  height: container.clientHeight,
  layout: {
    background: { color: "#0B0D10" },
    textColor: "#C9D1D9",
  },
  grid: {
    vertLines: { color: "#151515" },
    horzLines: { color: "#151515" },
  },
  rightPriceScale: {
    borderVisible: false,
    scaleMargins: { top: 0.1, bottom: 0.2 },
  },
  timeScale: {
    borderVisible: false,
    timeVisible: true,
    secondsVisible: true,
    barSpacing: 12,
    rightOffset: 12,
    fixLeftEdge: false,
    fixRightEdge: false,
    shiftVisibleRangeOnNewBar: true,
  },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
  },
  handleScroll: {
    mouseWheel: true,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: true,
  },
  handleScale: {
    axisPressedMouseMove: true,
    mouseWheel: true,
    pinch: true,
  },
});

const BAR_BY_TIME = new Map();

const PRICE_FORMAT = { type: "price", precision: 6, minMove: 0.000001 };
const UP = "#2ebd85";
const DOWN = "#f6465d";

let LAST_BARS = [];
let currentStyle = "candles";
let candleSeries = null;

function buildSeries(style) {
  if (style === "line") {
    return chart.addLineSeries({
      priceFormat: PRICE_FORMAT, color: "#7453E2", lineWidth: 2,
    });
  }
  if (style === "area") {
    return chart.addAreaSeries({
      priceFormat: PRICE_FORMAT,
      lineColor: "#7453E2", lineWidth: 2,
      topColor: "rgba(116,83,226,.38)", bottomColor: "rgba(116,83,226,0)",
    });
  }
  if (style === "bars") {
    return chart.addBarSeries({
      priceFormat: PRICE_FORMAT, upColor: UP, downColor: DOWN, thinBars: false,
    });
  }

  const hollow = style === "hollow";
  return chart.addCandlestickSeries({
    priceFormat: PRICE_FORMAT,
    upColor: hollow ? "rgba(0,0,0,0)" : UP,
    downColor: DOWN,
    borderUpColor: UP, borderDownColor: DOWN,
    wickUpColor: UP, wickDownColor: DOWN,
    borderVisible: true,
  });
}

function isValueStyle(style) { return style === "line" || style === "area"; }

function toSeriesPoint(bar, style) {
  if (!isValueStyle(style)) return bar;
  return { time: bar.time, value: bar.close };
}

function wrapSeries(series, style) {
  const rawSetData = series.setData.bind(series);
  const rawUpdate = series.update.bind(series);

  series.setData = function (bars) {
    BAR_BY_TIME.clear();
    LAST_BARS = Array.isArray(bars) ? bars : [];
    const out = [];
    for (const b of LAST_BARS) {
      if (!b || b.time == null) continue;
      BAR_BY_TIME.set(b.time, b);
      out.push(toSeriesPoint(b, style));
    }
    const r = rawSetData(out);

    if (typeof positionBadges === 'function') positionBadges();
    return r;
  };

  series.update = function (bar) {
    if (bar && bar.time != null) {
      BAR_BY_TIME.set(bar.time, bar);

      if (LAST_BARS.length && LAST_BARS[LAST_BARS.length - 1].time === bar.time) {
        LAST_BARS[LAST_BARS.length - 1] = bar;
      } else {
        LAST_BARS.push(bar);
      }
    }
    return rawUpdate(toSeriesPoint(bar, style));
  };

  return series;
}

candleSeries = wrapSeries(buildSeries(currentStyle), currentStyle);

window.setChartStyle = function (style) {
  const allowed = ["candles", "hollow", "bars", "line", "area"];
  if (allowed.indexOf(style) === -1 || style === currentStyle) return;

  const bars = LAST_BARS;
  let range = null;
  try { range = chart.timeScale().getVisibleRange(); } catch { }

  try { chart.removeSeries(candleSeries); } catch { }

  currentStyle = style;
  candleSeries = wrapSeries(buildSeries(style), style);
  window.candleSeries = candleSeries;

  if (bars.length) candleSeries.setData(bars);
  if (range) { try { chart.timeScale().setVisibleRange(range); } catch { } }

  window.dispatchEvent(new CustomEvent('mixerchart:serieschanged', { detail: { style: style } }));
};

const resizeObserver = new ResizeObserver(() => {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    chart.applyOptions({
      width: container.clientWidth,
      height: container.clientHeight
    });
  }
});
resizeObserver.observe(container);

window.addEventListener('resize', () => {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    chart.applyOptions({
      width: container.clientWidth,
      height: container.clientHeight
    });
  }
});

let allCandles = [];
let currentLiveCandle = null;
let lastUpdateTime = 0;
let currentTimeframe = 15;

function aggregateToTimeframe(baseCandles, targetSeconds) {
  if (!baseCandles.length) return [];
  if (targetSeconds === 15) return baseCandles;

  const buckets = new Map();

  for (const candle of baseCandles) {
    const bucketTime = Math.floor(candle.time / targetSeconds) * targetSeconds;

    if (!buckets.has(bucketTime)) {
      buckets.set(bucketTime, []);
    }
    buckets.get(bucketTime).push(candle);
  }

  const aggregatedCandles = [];

  for (const [bucketTime, candles] of buckets.entries()) {

    candles.sort((a, b) => a.time - b.time);

    const open = candles[0].open;
    const close = candles[candles.length - 1].close;
    const high = Math.max(...candles.map(c => c.high));
    const low = Math.min(...candles.map(c => c.low));

    const range = high - low;
    const bodySize = Math.abs(close - open);
    const averagePrice = (high + low) / 2;

    const rangePercent = (range / averagePrice) * 100;
    const bodyPercent = (bodySize / averagePrice) * 100;

    const MIN_RANGE_PERCENT = 0.01;
    const MIN_BODY_PERCENT = 0.005;

    if (rangePercent < MIN_RANGE_PERCENT && bodyPercent < MIN_BODY_PERCENT) {
      continue;
    }

    aggregatedCandles.push({
      time: bucketTime,
      open: open,
      high: high,
      low: low,
      close: close
    });
  }

  aggregatedCandles.sort((a, b) => a.time - b.time);
  return aggregatedCandles;
}

window.changeTimeframe = function(seconds) {
  currentTimeframe = seconds;

  console.log(`Switching to ${seconds}s timeframe...`);

  const aggregated = aggregateToTimeframe(allCandles, seconds);

  console.log(`Aggregated ${allCandles.length} base candles → ${aggregated.length} ${seconds}s candles`);

  candleSeries.setData(aggregated);

  setTimeout(() => {
    const numCandles = aggregated.length;
    let displayCount;

    if (numCandles > 150) {
      displayCount = 100;
    } else if (numCandles > 50) {
      displayCount = Math.floor(numCandles * 0.7);
    } else {
      displayCount = numCandles;
    }

    if (numCandles > displayCount) {
      const from = aggregated[numCandles - displayCount].time;
      const to = aggregated[numCandles - 1].time;
      chart.timeScale().setVisibleRange({
        from: from,
        to: to + (seconds * 2)
      });
    } else {
      chart.timeScale().fitContent();
    }
  }, 100);
};

async function loadHistory() {
  try {
    console.log('Fetching candles...');
    const res = await fetch(
      `/api/mixers/${MIXER_ID}/candles?interval=15s&limit=800`
    );
    const candles = await res.json();

    if (!Array.isArray(candles) || !candles.length) {
      console.warn("No candle data received");
      return;
    }

    console.log(`✅ Fetched ${candles.length} candles from API`);

    const validCandles = [];
    let flatCandleCount = 0;
    let filteredOutCount = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];

      const time = Number(c.time);
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);

      if (isNaN(time) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
        continue;
      }
      if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0) {
        continue;
      }

      if (high < low || high < open || high < close || low > open || low > close) {
        continue;
      }

      const range = high - low;
      const bodySize = Math.abs(close - open);
      const averagePrice = (high + low) / 2;

      const rangePercent = (range / averagePrice) * 100;
      const bodyPercent = (bodySize / averagePrice) * 100;

      const MIN_RANGE_PERCENT = 0.01;
      const MIN_BODY_PERCENT = 0.005;

      if (rangePercent < MIN_RANGE_PERCENT && bodyPercent < MIN_BODY_PERCENT) {
        filteredOutCount++;
        continue;
      }

      if (open === high && high === low && low === close) {
        flatCandleCount++;
      }

      validCandles.push({
        time: time,
        open: open,
        high: high,
        low: low,
        close: close
      });
    }

    console.log(`📊 Processed ${validCandles.length} candles with meaningful movement`);
    console.log(`🚫 Filtered out ${filteredOutCount} candles with insignificant movement`);
    if (flatCandleCount > 0) {
      console.log(`📏 Completely flat candles: ${flatCandleCount}`);
    }

    validCandles.sort((a, b) => a.time - b.time);

    const uniqueCandles = [];
    const timeMap = new Map();
    for (const candle of validCandles) {
      timeMap.set(candle.time, candle);
    }
    for (const candle of timeMap.values()) {
      uniqueCandles.push(candle);
    }
    uniqueCandles.sort((a, b) => a.time - b.time);

    allCandles = uniqueCandles;

    if (allCandles.length === 0) {
      console.error('❌ No valid candles after processing!');
      return;
    }

    let gapCount = 0;
    let maxGap = 0;
    for (let i = 1; i < allCandles.length; i++) {
      const gap = allCandles[i].time - allCandles[i-1].time;
      if (gap > 15) {
        gapCount++;
        maxGap = Math.max(maxGap, gap);
      }
    }

    console.log(`⏰ Time range: ${new Date(allCandles[0].time * 1000).toLocaleString()} to ${new Date(allCandles[allCandles.length - 1].time * 1000).toLocaleString()}`);
    console.log(`⏱️  Duration: ${((allCandles[allCandles.length - 1].time - allCandles[0].time) / 60).toFixed(1)} minutes`);
    console.log(`📊 Gaps: ${gapCount} gaps found (max gap: ${maxGap}s = ${(maxGap/60).toFixed(1)} minutes)`);

    const displayCandles = aggregateToTimeframe(allCandles, currentTimeframe);

    console.log(`📈 Loading ${displayCandles.length} candles to chart (${currentTimeframe}s timeframe)...`);
    candleSeries.setData(displayCandles);

    setTimeout(() => {
      const numCandles = displayCandles.length;
      let displayCount;

      if (numCandles > 150) {
        displayCount = 100;
      } else if (numCandles > 50) {
        displayCount = Math.floor(numCandles * 0.7);
      } else {
        displayCount = numCandles;
      }

      if (numCandles > displayCount) {
        const from = displayCandles[numCandles - displayCount].time;
        const to = displayCandles[numCandles - 1].time;
        chart.timeScale().setVisibleRange({
          from: from,
          to: to + (currentTimeframe * 2)
        });
      } else {
        chart.timeScale().fitContent();
      }

      console.log(`👁️  Displaying last ${displayCount} of ${numCandles} candles`);
    }, 100);

    lastUpdateTime = allCandles[allCandles.length - 1].time;

    const prices = allCandles.map(c => c.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;

    console.log(`💰 Price stats:`);
    console.log(`   Min: $${minPrice.toFixed(6)}`);
    console.log(`   Max: $${maxPrice.toFixed(6)}`);
    console.log(`   Range: $${priceRange.toFixed(6)} (${(priceRange/minPrice*100).toFixed(2)}%)`);
    console.log(`✅ Chart loaded successfully!`);

  } catch (err) {
    console.error("❌ Failed to load history:", err);
  }
}

const socket = io();

socket.on("mixer:price", ({ mixerId, price, ts }) => {
  if (mixerId !== MIXER_ID) return;

  const priceEl = document.getElementById("live-mixer-price");
  if (priceEl) priceEl.innerText = formatTokenPrice(price);

  if (typeof window.updateSirFromPrice === 'function') window.updateSirFromPrice(price);

  if (typeof window.refreshHoldings === 'function') {
    const now = Date.now();
    if (!window.__lastHoldingsRefresh || now - window.__lastHoldingsRefresh > 15000) {
      window.__lastHoldingsRefresh = now;
      window.refreshHoldings();
    }
  }

  const currentTime = Math.floor(ts / 1000);
  const bucketTime = Math.floor(currentTime / 15) * 15;

  if (!currentLiveCandle || currentLiveCandle.time !== bucketTime) {

    if (currentLiveCandle && currentLiveCandle.time > lastUpdateTime) {

      const range = currentLiveCandle.high - currentLiveCandle.low;
      const bodySize = Math.abs(currentLiveCandle.close - currentLiveCandle.open);
      const averagePrice = (currentLiveCandle.high + currentLiveCandle.low) / 2;

      const rangePercent = (range / averagePrice) * 100;
      const bodyPercent = (bodySize / averagePrice) * 100;

      const MIN_RANGE_PERCENT = 0.01;
      const MIN_BODY_PERCENT = 0.005;

      if (rangePercent >= MIN_RANGE_PERCENT || bodyPercent >= MIN_BODY_PERCENT) {

        allCandles.push(currentLiveCandle);
        lastUpdateTime = currentLiveCandle.time;

        const aggregated = aggregateToTimeframe(allCandles, currentTimeframe);
        candleSeries.setData(aggregated);

        console.log(`[Live] Added 15s candle, re-aggregated to ${currentTimeframe}s`);
      }
    }

    currentLiveCandle = {
      time: bucketTime,
      open: price,
      high: price,
      low: price,
      close: price
    };
  } else {

    if (price > currentLiveCandle.high) currentLiveCandle.high = price;
    if (price < currentLiveCandle.low) currentLiveCandle.low = price;
    currentLiveCandle.close = price;
  }
});

function formatTokenPrice(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.000001) return n.toFixed(8).replace(/0+$/, '');
  return n.toExponential(2);
}

socket.on("token:price", ({ tokenAddress, price }) => {
  if (typeof TOKENS !== 'undefined' && TOKENS.includes(tokenAddress)) {
    const el = document.getElementById(`token-price-${tokenAddress}`);
    if (!el) return;

    el.innerText = formatTokenPrice(price);
    el.classList.remove('text-gray-500', 'text-[11px]', 'font-normal');
    el.removeAttribute('title');

    const p = el.parentElement;
    if (p && p.classList.contains('token-price') && !p.textContent.includes('$')) {
      p.insertBefore(document.createTextNode('$'), el);
    }
  }
});

let TRADE_MARKERS = [];
let markerLayer = null;

function fmtMarkerSol(n) {
  n = Number(n);
  if (!isFinite(n)) return '0';
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function buildMarkerTooltip() {
  let el = document.getElementById('trade-marker-tooltip');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'trade-marker-tooltip';
  el.style.cssText = [
    'position:absolute', 'z-index:60', 'display:none', 'pointer-events:none',
    'background:#14161B', 'border:1px solid #2C2C2C', 'border-radius:10px',
    'padding:8px 10px', 'box-shadow:0 8px 24px rgba(0,0,0,.5)',
    'font-size:11px', 'color:#fff', 'white-space:nowrap',
  ].join(';');
  (container.parentElement || document.body).appendChild(el);
  return el;
}

function buildMarkerLayer() {
  if (markerLayer) return markerLayer;

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  markerLayer = document.createElement('div');
  markerLayer.id = 'trade-marker-layer';
  markerLayer.style.cssText = [
    'position:absolute', 'inset:0', 'overflow:hidden',
    'pointer-events:none', 'z-index:30',
  ].join(';');
  container.appendChild(markerLayer);
  return markerLayer;
}

function buildBadge(m) {
  const isBuy = m.side === 'buy';

  const label = (m.isCreator ? 'D' : '') + (isBuy ? 'B' : 'S');
  const bg = isBuy ? '#2ebd85' : '#f6465d';

  const el = document.createElement('div');
  el.className = 'trade-badge';
  el.dataset.markerId = m.id;
  el.style.cssText = [
    'position:absolute',
    'width:22px', 'height:22px',
    'margin-left:-11px', 'margin-top:-11px',
    'border-radius:999px',
    'background:' + bg,

    'border:1.5px solid rgba(255,255,255,.92)',
    'box-shadow:0 2px 6px rgba(0,0,0,.55)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-size:9px', 'font-weight:800', 'letter-spacing:.02em',
    'color:#fff', 'font-family:ui-sans-serif,system-ui,sans-serif',
    'pointer-events:auto', 'cursor:pointer',
    'transition:transform .1s ease',
    'will-change:transform',
  ].join(';');
  el.textContent = label;

  if (m.isCreator) {
    el.style.width = '24px';
    el.style.height = '24px';
    el.style.marginLeft = '-12px';
    el.style.marginTop = '-12px';
    el.style.boxShadow = '0 2px 8px rgba(0,0,0,.6), 0 0 0 3px ' +
      (isBuy ? 'rgba(46,189,133,.22)' : 'rgba(246,70,93,.22)');
  }

  return el;
}

function candleTimeFor(tradeTime) {
  if (BAR_BY_TIME.has(tradeTime)) return tradeTime;

  let bucket = null;
  for (const t of BAR_BY_TIME.keys()) {
    if (t <= tradeTime && (bucket === null || t > bucket)) bucket = t;
  }

  if (bucket === null) return null;

  let newest = null, second = null;
  for (const t of BAR_BY_TIME.keys()) {
    if (newest === null || t > newest) { second = newest; newest = t; }
    else if (second === null || t > second) second = t;
  }
  const interval = (newest !== null && second !== null) ? (newest - second) : 60;
  if (tradeTime - bucket > interval * 3) return null;

  return bucket;
}

function positionBadges() {
  if (!markerLayer) return;

  const ts = chart.timeScale();
  const width = container.clientWidth;

  for (const el of markerLayer.children) {
    const m = el.__marker;
    if (!m) continue;

    const snapped = candleTimeFor(m.time);
    if (snapped === null) { el.style.display = 'none'; continue; }

    const x = ts.timeToCoordinate(snapped);
    if (x === null || x < 0 || x > width) { el.style.display = 'none'; continue; }

    let y = null;
    if (m.priceUsd != null) y = candleSeries.priceToCoordinate(m.priceUsd);

    if (y === null || !isFinite(y)) {
      const bar = BAR_BY_TIME.get(snapped) || nearestBar(m.time);
      if (bar) {
        const anchor = m.side === 'buy' ? bar.low : bar.high;
        const c = candleSeries.priceToCoordinate(anchor);

        if (c !== null && isFinite(c)) y = c + (m.side === 'buy' ? 18 : -18);
      }
    }

    if (y === null || !isFinite(y)) { el.style.display = 'none'; continue; }

    el.style.display = 'flex';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
}

function bindBadgeReflow() {
  if (window.__badgeReflowBound) return;
  window.__badgeReflowBound = true;

  let queued = false;
  function reflow() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      positionBadges();
    });
  }

  chart.timeScale().subscribeVisibleTimeRangeChange(reflow);

  ['wheel', 'mousemove', 'mouseup', 'touchmove', 'touchend'].forEach(function (ev) {
    container.addEventListener(ev, reflow, { passive: true });
  });

  window.addEventListener('resize', reflow);

  setInterval(reflow, 1000);
}

function nearestBar(time) {
  let best = null, bestD = Infinity;
  for (const [t, bar] of BAR_BY_TIME) {
    const d = Math.abs(t - time);
    if (d < bestD) { bestD = d; best = bar; }
  }
  return best;
}

async function loadTradeMarkers() {
  try {
    const res = await fetch(`/api/mixers/${MIXER_ID}/trade-markers?limit=100`);
    if (!res.ok) return;
    const body = await res.json();
    const markers = (body && body.markers) || [];

    TRADE_MARKERS = markers;

    const layer = buildMarkerLayer();
    layer.innerHTML = '';
    if (!markers.length) return;

    for (const m of markers) {
      const el = buildBadge(m);
      el.__marker = m;
      layer.appendChild(el);
    }

    positionBadges();
    bindMarkerHover();

    bindBadgeReflow();
  } catch (err) {

    console.warn('Trade markers unavailable:', err.message);
  }
}

function bindMarkerHover() {
  if (window.__markerHoverBound) return;
  window.__markerHoverBound = true;

  const tooltip = buildMarkerTooltip();

  markerLayer.addEventListener('mouseover', function (ev) {
    const el = ev.target.closest('.trade-badge');
    if (!el || !el.__marker) return;
    el.style.transform = 'scale(1.15)';
    showMarkerTooltip(tooltip, el.__marker, el);
  });

  markerLayer.addEventListener('mouseout', function (ev) {
    const el = ev.target.closest('.trade-badge');
    if (el) el.style.transform = '';
    tooltip.style.display = 'none';
  });
}

function showMarkerTooltip(tooltip, hit, el) {
  {
    const isBuy = hit.side === 'buy';
    const who = hit.handle ? ('@' + hit.handle)
      : (hit.wallet ? hit.wallet.slice(0, 4) + '…' + hit.wallet.slice(-4) : 'Unknown');

    const avatar = hit.avatar
      ? '<img src="' + hit.avatar + '" alt="" style="width:22px;height:22px;border-radius:999px;object-fit:cover;border:1px solid #2C2C2C">'
      : '<div style="width:22px;height:22px;border-radius:999px;background:#7453E2;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">'
        + who.replace('@', '').charAt(0).toUpperCase() + '</div>';

    tooltip.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
        avatar +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span style="font-weight:600">' + who + '</span>' +
            (hit.isCreator
              ? '<span style="font-size:9px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#7453E2;border:1px solid rgba(116,83,226,.4);background:rgba(116,83,226,.15);border-radius:4px;padding:1px 4px">Creator</span>'
              : '') +
          '</div>' +
          '<div style="color:' + (isBuy ? '#22c55e' : '#f6465d') + ';font-weight:600;margin-top:2px">' +
            (isBuy ? 'Bought' : 'Sold') + ' ' + fmtMarkerSol(hit.solAmount) + ' SOL' +
          '</div>' +
          '<div style="color:#71717a;margin-top:1px">' +
            new Date(hit.time * 1000).toLocaleString() +
          '</div>' +
        '</div>' +
      '</div>';

    tooltip.style.display = 'block';

    const bx = parseFloat(el.style.left) || 0;
    const by = parseFloat(el.style.top) || 0;

    const w = tooltip.offsetWidth || 200;
    const h = tooltip.offsetHeight || 60;

    let left = bx + 18;
    let top = by - h - 12;
    if (left + w > container.clientWidth) left = bx - w - 18;
    if (left < 0) left = 4;
    if (top < 0) top = by + 18;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
}

window.refreshTradeMarkers = loadTradeMarkers;

loadHistory();
loadTradeMarkers();

window.tradingChart = chart;
window.candleSeries = candleSeries;
window.getAllCandles = () => allCandles;

window.dispatchEvent(new CustomEvent('mixerchart:ready'));

console.log("Chart initialized - showing 15s OHLC candlesticks");
console.log("Debug commands:");
console.log("  getAllCandles() - View all loaded candles");
console.log("  chart.timeScale().fitContent() - Reset zoom");
console.log("  chart.timeScale().scrollToRealTime() - Jump to latest");