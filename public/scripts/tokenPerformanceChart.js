
function fmtPerfPrice(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '0.00';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.000001) return n.toFixed(8).replace(/0+$/, '');
  return n.toExponential(2);
}

let performanceChart = null;
let performanceSeries = {};
let isFullscreen = false;

const CHART_COLORS = [
  '#7453E2',
  '#22c55e',
  '#3b82f6',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899'
];

function initPerformanceChart(performanceData) {
  const container = document.getElementById('performance-chart-container');
  if (!container) {
    console.error('Performance chart container not found');
    return;
  }

  performanceChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 500,
    layout: {
      background: { color: '#0B0D10' },
      textColor: '#71717a',
    },
    grid: {
      vertLines: { color: '#1f1f23' },
      horzLines: { color: '#1f1f23' },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.15, bottom: 0.15 },
    },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
    },
    localization: {
      priceFormatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        color: '#7453E2',
        width: 1,
        style: LightweightCharts.LineStyle.Dashed,
      },
      horzLine: {
        color: '#7453E2',
        width: 1,
        style: LightweightCharts.LineStyle.Dashed,
      },
    },
  });

  let colorIndex = 0;
  const legendContainer = document.getElementById('performance-legend');
  legendContainer.innerHTML = '';

  const drawable = Object.values(performanceData.tokens || {})
    .filter(function (t) { return t.data && t.data.length >= 2; }).length;

  if (!drawable) {
    container.innerHTML =
      '<div class="h-full flex flex-col items-center justify-center text-center px-6">' +
      '<div class="w-9 h-9 rounded-lg bg-[#7453E2]/10 flex items-center justify-center mb-3">' +
      '<span class="relative flex h-2 w-2">' +
      '<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#7453E2] opacity-70"></span>' +
      '<span class="relative inline-flex rounded-full h-2 w-2 bg-[#7453E2]"></span></span></div>' +
      '<p class="text-sm font-medium text-white">Collecting price history</p>' +
      '<p class="text-xs text-gray-500 mt-1 max-w-xs leading-relaxed">' +
      'Performance is plotted once there are enough price samples. ' +
      'This usually takes a minute or two after a mixer is created.</p></div>';
    return;
  }

  for (const [address, token] of Object.entries(performanceData.tokens)) {
    if (!token.data || token.data.length < 2) continue;

    const seen = new Set();
    const cleaned = [];

    for (const p of token.data) {
      const t = Math.floor(p.ts / 1000);
      if (seen.has(t)) continue;
      seen.add(t);
      cleaned.push({ time: t, price: p.price });
    }

    if (cleaned.length < 2) continue;

    const basePrice = cleaned[0].price;
    const lineData = cleaned.map(p => ({
      time: p.time,
      value: ((p.price / basePrice) - 1) * 100
    }));

    const color = CHART_COLORS[colorIndex % CHART_COLORS.length];
    colorIndex++;

    const series = performanceChart.addLineSeries({
      color: color,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });

    series.setData(lineData);

    performanceSeries[address] = {
      series,
      visible: true,
      color,
      basePrice,
      lastTime: lineData[lineData.length - 1].time,
      lastValue: lineData[lineData.length - 1].value,
    };

    const tokenSymbol = token.meta.symbol || token.meta.name || 'Unknown';
    const legendItem = document.createElement('div');
    legendItem.className = 'performance-legend-item';

    const last = lineData[lineData.length - 1].value;
    const lastPrice = cleaned[cleaned.length - 1].price;

    legendItem.innerHTML = `
      <div class="flex items-center space-x-2 cursor-pointer hover:opacity-80 transition">
        <div class="w-2.5 h-2.5 rounded-full" style="background-color: ${color}"></div>
        <span class="text-xs font-medium text-white">${tokenSymbol}</span>
        <span class="text-xs tabular-nums text-gray-300" data-perf-price="${address}">$${fmtPerfPrice(lastPrice)}</span>
        <span class="text-xs text-gray-500">${(token.weight * 100).toFixed(1)}%</span>
        <span class="text-xs font-semibold tabular-nums" data-perf-pct="${address}"
              style="color:${last >= 0 ? '#22c55e' : '#f6465d'}">
          ${last >= 0 ? '+' : ''}${last.toFixed(2)}%
        </span>
      </div>
    `;

    performanceSeries[address].pctEl = legendItem.querySelector('[data-perf-pct]');
    performanceSeries[address].priceEl = legendItem.querySelector('[data-perf-price]');

    legendItem.onclick = () => {
      const seriesData = performanceSeries[address];
      seriesData.visible = !seriesData.visible;
      series.applyOptions({ visible: seriesData.visible });
      legendItem.style.opacity = seriesData.visible ? '1' : '0.3';
    };

    legendContainer.appendChild(legendItem);
  }

  performanceChart.timeScale().fitContent();

  const resizeObserver = new ResizeObserver(entries => {
    if (performanceChart) {
      performanceChart.applyOptions({
        width: container.clientWidth,
        height: isFullscreen ? window.innerHeight - 60 : 500,
      });
    }
  });

  resizeObserver.observe(container);

  subscribePerformanceLive();
}

function subscribePerformanceLive() {
  if (typeof io === 'undefined') return;
  if (window.__perfLiveBound) return;
  window.__perfLiveBound = true;

  const socket = io();

  socket.on('token:price', function (msg) {
    if (!msg || !msg.tokenAddress) return;

    const entry = performanceSeries[msg.tokenAddress];
    if (!entry || !entry.basePrice) return;

    const price = Number(msg.price);
    if (!isFinite(price) || price <= 0) return;

    const value = ((price / entry.basePrice) - 1) * 100;

    const time = Math.max(entry.lastTime, Math.floor((msg.ts || Date.now()) / 1000));

    try {
      entry.series.update({ time: time, value: value });
      entry.lastTime = time;
      entry.lastValue = value;
    } catch (e) {

      return;
    }

    if (entry.pctEl) {
      entry.pctEl.textContent = (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
      entry.pctEl.style.color = value >= 0 ? '#22c55e' : '#f6465d';
    }
    if (entry.priceEl) {
      entry.priceEl.textContent = '$' + fmtPerfPrice(price);
    }
  });
}

function togglePerformanceFullscreen() {
  const modal = document.getElementById('performance-fullscreen-modal');
  const container = document.getElementById('performance-chart-container');

  isFullscreen = !isFullscreen;

  if (isFullscreen) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      if (performanceChart) {
        performanceChart.applyOptions({
          width: container.clientWidth,
          height: window.innerHeight - 120,
        });
        performanceChart.timeScale().fitContent();
      }
    }, 100);
  } else {
    modal.classList.add('hidden');
    document.body.style.overflow = 'auto';

    setTimeout(() => {
      if (performanceChart) {
        performanceChart.applyOptions({
          width: container.clientWidth,
          height: 500,
        });
      }
    }, 100);
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFullscreen) {
    togglePerformanceFullscreen();
  }
});

window.initPerformanceChart = initPerformanceChart;
window.togglePerformanceFullscreen = togglePerformanceFullscreen;