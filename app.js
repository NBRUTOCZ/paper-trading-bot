'use strict';

const STORAGE_KEY = 'norbi-paper-trading-bot-v1';
const MAX_CANDLES = 240;
const MAX_EQUITY_POINTS = 400;

const elements = Object.fromEntries([
  'startingBalance', 'symbol', 'positionPercent', 'fastEma', 'slowEma', 'stopLoss',
  'takeProfit', 'feeRate', 'startButton', 'pauseButton', 'closeButton', 'resetButton',
  'exportButton', 'connectionDot', 'connectionText', 'lastUpdate', 'livePrice',
  'priceChange', 'balance', 'equity', 'totalPnl', 'totalPnlPercent', 'unrealizedPnl',
  'positionSideLabel', 'maxDrawdown', 'maxDrawdownPercent', 'chartTitle', 'priceChart',
  'chartEmpty', 'positionStatus', 'positionBadge', 'entryPrice', 'quantity',
  'positionValue', 'stopPrice', 'targetPrice', 'openedAt', 'botStatus', 'signalReason',
  'tradeCount', 'wins', 'losses', 'winRate', 'grossProfit', 'grossLoss',
  'equityChart', 'tradeTableBody'
].map(id => [id, document.getElementById(id)]));

const state = {
  running: false,
  paused: false,
  balance: 25000,
  startingBalance: 25000,
  equity: 25000,
  peakEquity: 25000,
  maxDrawdown: 0,
  currentPrice: null,
  previousPrice: null,
  candles: [],
  position: null,
  trades: [],
  equityHistory: [],
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  symbol: 'BTCUSDT',
  settings: null,
  lastSignal: 'Várakozás a következő lezárt gyertyára.',
  lastProcessedCandleTime: null,
};

function readSettings() {
  const settings = {
    startingBalance: Number(elements.startingBalance.value),
    symbol: elements.symbol.value,
    positionPercent: Number(elements.positionPercent.value),
    fastEma: Math.round(Number(elements.fastEma.value)),
    slowEma: Math.round(Number(elements.slowEma.value)),
    stopLoss: Number(elements.stopLoss.value),
    takeProfit: Number(elements.takeProfit.value),
    feeRate: Number(elements.feeRate.value) / 100,
  };

  if (!Number.isFinite(settings.startingBalance) || settings.startingBalance < 100) {
    throw new Error('A kezdőtőke legalább 100 USDT legyen.');
  }
  if (settings.fastEma >= settings.slowEma) {
    throw new Error('A gyors EMA kisebb legyen a lassú EMA-nál.');
  }
  if (settings.positionPercent <= 0 || settings.positionPercent > 100) {
    throw new Error('A pozícióméret 1–100% között legyen.');
  }
  if (settings.stopLoss <= 0 || settings.takeProfit <= 0) {
    throw new Error('A stop-loss és take-profit legyen 0%-nál nagyobb.');
  }
  return settings;
}

function setControlsLocked(locked) {
  [
    elements.startingBalance, elements.symbol, elements.positionPercent,
    elements.fastEma, elements.slowEma, elements.stopLoss,
    elements.takeProfit, elements.feeRate
  ].forEach(el => { el.disabled = locked; });
}

function startSimulation() {
  try {
    const settings = readSettings();
    const changingAccount = !state.running;

    if (changingAccount) {
      state.settings = settings;
      state.symbol = settings.symbol;
      state.startingBalance = settings.startingBalance;
      state.balance = settings.startingBalance;
      state.equity = settings.startingBalance;
      state.peakEquity = settings.startingBalance;
      state.maxDrawdown = 0;
      state.position = null;
      state.trades = [];
      state.equityHistory = [{ time: Date.now(), value: settings.startingBalance }];
      state.lastProcessedCandleTime = null;
    }

    state.running = true;
    state.paused = false;
    state.lastSignal = 'A bot figyeli az EMA-kereszteződést.';
    setControlsLocked(true);
    elements.startButton.disabled = true;
    elements.pauseButton.disabled = false;
    elements.pauseButton.textContent = 'Szünet';
    elements.closeButton.disabled = !state.position;
    connectMarketData(true);
    saveState();
    updateUI();
  } catch (error) {
    alert(error.message);
  }
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  elements.pauseButton.textContent = state.paused ? 'Folytatás' : 'Szünet';
  state.lastSignal = state.paused
    ? 'A bot szünetel. Az élő ár továbbra is frissül.'
    : 'A bot ismét figyeli a jeleket.';
  saveState();
  updateUI();
}

function resetSimulation() {
  if (state.position && !confirm('Van nyitott virtuális pozíció. Biztosan mindent nullázol?')) return;
  closeSocket();
  state.running = false;
  state.paused = false;
  state.position = null;
  state.trades = [];
  state.candles = [];
  state.currentPrice = null;
  state.previousPrice = null;
  state.lastProcessedCandleTime = null;
  state.startingBalance = Number(elements.startingBalance.value) || 25000;
  state.balance = state.startingBalance;
  state.equity = state.startingBalance;
  state.peakEquity = state.startingBalance;
  state.maxDrawdown = 0;
  state.equityHistory = [{ time: Date.now(), value: state.startingBalance }];
  state.lastSignal = 'Indítsd el a szimulációt.';
  setControlsLocked(false);
  elements.startButton.disabled = false;
  elements.pauseButton.disabled = true;
  elements.pauseButton.textContent = 'Szünet';
  elements.closeButton.disabled = true;
  localStorage.removeItem(STORAGE_KEY);
  setConnection('offline', 'Nincs kapcsolat');
  updateUI();
  drawCharts();
}

async function connectMarketData(reloadHistory = false) {
  closeSocket();
  setConnection('connecting', 'Kapcsolódás…');

  const symbol = (state.settings?.symbol || elements.symbol.value).toUpperCase();
  state.symbol = symbol;
  elements.chartTitle.textContent = `${symbol} • 1 perc`;

  if (reloadHistory || state.candles.length === 0) {
    await loadHistoricalCandles(symbol);
  }

  const stream = `${symbol.toLowerCase()}@kline_1m`;
  // A 2026-os Binance Futures /market végpont. Régi végpont csak tartalékként szerepel.
  const endpoints = [
    `wss://fstream.binance.com/market/ws/${stream}`,
    `wss://fstream.binance.com/ws/${stream}`
  ];

  openSocketWithFallback(endpoints, 0);
}

function openSocketWithFallback(endpoints, index) {
  if (index >= endpoints.length) {
    scheduleReconnect();
    return;
  }

  let opened = false;
  const socket = new WebSocket(endpoints[index]);
  state.socket = socket;

  socket.onopen = () => {
    opened = true;
    state.reconnectAttempts = 0;
    setConnection('online', 'Élő kapcsolat');
  };

  socket.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      const data = payload.data || payload;
      const kline = data.k;
      if (!kline) return;

      const candle = {
        time: Number(kline.t),
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        closed: Boolean(kline.x),
      };

      state.previousPrice = state.currentPrice;
      state.currentPrice = candle.close;
      elements.lastUpdate.textContent = new Date().toLocaleTimeString('hu-HU');

      upsertCandle(candle);
      updateOpenPosition(candle);

      if (candle.closed && state.lastProcessedCandleTime !== candle.time) {
        state.lastProcessedCandleTime = candle.time;
        processClosedCandle();
      }

      updateEquity();
      updateUI();
      drawCharts();
      saveStateThrottled();
    } catch (error) {
      console.error('Hibás piaci adat:', error);
    }
  };

  socket.onerror = () => {
    setConnection('offline', 'Kapcsolati hiba');
  };

  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (!opened && index + 1 < endpoints.length) {
      openSocketWithFallback(endpoints, index + 1);
      return;
    }
    if (state.running) scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempts += 1;
  const delay = Math.min(30000, 1500 * (2 ** Math.min(state.reconnectAttempts, 4)));
  setConnection('connecting', `Újracsatlakozás ${Math.round(delay / 1000)} mp múlva`);
  state.reconnectTimer = setTimeout(() => connectMarketData(false), delay);
}

function closeSocket() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.onclose = null;
    socket.close();
  }
}

async function loadHistoricalCandles(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=240`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    state.candles = rows.map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      closed: true,
    })).slice(-MAX_CANDLES);
    const latest = state.candles.at(-1);
    if (latest) {
      state.currentPrice = latest.close;
      state.previousPrice = state.candles.at(-2)?.close ?? latest.close;
    }
    elements.chartEmpty.hidden = state.candles.length > 0;
    drawCharts();
  } catch (error) {
    console.warn('A történelmi adatok nem érhetők el, élő adatokkal indulunk:', error);
    elements.chartEmpty.textContent = 'A múltbeli gyertyák nem töltődtek be. Várakozás élő adatra…';
  }
}

function upsertCandle(candle) {
  const last = state.candles.at(-1);
  if (last?.time === candle.time) {
    state.candles[state.candles.length - 1] = candle;
  } else {
    state.candles.push(candle);
    if (state.candles.length > MAX_CANDLES) state.candles.shift();
  }
  elements.chartEmpty.hidden = state.candles.length > 0;
}

function processClosedCandle() {
  if (!state.running || state.paused || !state.settings) return;
  const minimumBars = state.settings.slowEma + 2;
  if (state.candles.length < minimumBars) {
    state.lastSignal = `Legalább ${minimumBars} gyertya szükséges az EMA-khoz.`;
    return;
  }

  const closes = state.candles.map(c => c.close);
  const fast = calculateEmaSeries(closes, state.settings.fastEma);
  const slow = calculateEmaSeries(closes, state.settings.slowEma);
  const i = closes.length - 1;
  const previous = i - 1;

  const crossUp = fast[previous] <= slow[previous] && fast[i] > slow[i];
  const crossDown = fast[previous] >= slow[previous] && fast[i] < slow[i];

  if (state.position) {
    if (state.position.side === 'LONG' && crossDown) {
      closePosition(state.currentPrice, 'Ellentétes EMA-jel');
      openPosition('SHORT');
    } else if (state.position.side === 'SHORT' && crossUp) {
      closePosition(state.currentPrice, 'Ellentétes EMA-jel');
      openPosition('LONG');
    } else {
      state.lastSignal = `${state.position.side} pozíció tartása; nincs ellentétes kereszteződés.`;
    }
    return;
  }

  if (crossUp) openPosition('LONG');
  else if (crossDown) openPosition('SHORT');
  else state.lastSignal = 'Nincs új EMA-kereszteződés.';
}

function openPosition(side) {
  if (!state.currentPrice || state.position || !state.settings) return;
  const allocated = state.balance * (state.settings.positionPercent / 100);
  const quantity = allocated / state.currentPrice;
  const entryFee = allocated * state.settings.feeRate;

  if (entryFee >= state.balance) {
    state.lastSignal = 'Nincs elegendő virtuális egyenleg a díjhoz.';
    return;
  }

  state.balance -= entryFee;
  const stopMultiplier = state.settings.stopLoss / 100;
  const targetMultiplier = state.settings.takeProfit / 100;

  state.position = {
    side,
    entryPrice: state.currentPrice,
    quantity,
    positionValue: allocated,
    entryFee,
    openedAt: Date.now(),
    stopPrice: side === 'LONG'
      ? state.currentPrice * (1 - stopMultiplier)
      : state.currentPrice * (1 + stopMultiplier),
    targetPrice: side === 'LONG'
      ? state.currentPrice * (1 + targetMultiplier)
      : state.currentPrice * (1 - targetMultiplier),
  };

  state.lastSignal = `${side} nyitva EMA-kereszteződés alapján.`;
  elements.closeButton.disabled = false;
  updateEquity();
  saveState();
}

function updateOpenPosition(candle) {
  if (!state.position || !state.running || state.paused) return;
  const position = state.position;

  if (position.side === 'LONG') {
    if (candle.low <= position.stopPrice) {
      closePosition(position.stopPrice, 'Stop-loss');
    } else if (candle.high >= position.targetPrice) {
      closePosition(position.targetPrice, 'Take-profit');
    }
  } else {
    if (candle.high >= position.stopPrice) {
      closePosition(position.stopPrice, 'Stop-loss');
    } else if (candle.low <= position.targetPrice) {
      closePosition(position.targetPrice, 'Take-profit');
    }
  }
}

function closePosition(exitPrice = state.currentPrice, reason = 'Kézi zárás') {
  if (!state.position || !exitPrice || !state.settings) return;
  const position = state.position;
  const direction = position.side === 'LONG' ? 1 : -1;
  const grossPnl = (exitPrice - position.entryPrice) * position.quantity * direction;
  const exitValue = exitPrice * position.quantity;
  const exitFee = exitValue * state.settings.feeRate;
  const netPnlAfterExit = grossPnl - exitFee;

  state.balance += netPnlAfterExit;
  const fullTradeNet = grossPnl - position.entryFee - exitFee;
  state.trades.unshift({
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    symbol: state.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    grossPnl,
    fees: position.entryFee + exitFee,
    pnl: fullTradeNet,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    reason,
  });

  state.position = null;
  state.lastSignal = `Pozíció lezárva: ${reason}.`;
  elements.closeButton.disabled = true;
  updateEquity();
  appendEquityPoint(true);
  saveState();
  updateUI();
}

function getUnrealizedPnl() {
  if (!state.position || !state.currentPrice) return 0;
  const direction = state.position.side === 'LONG' ? 1 : -1;
  return (state.currentPrice - state.position.entryPrice) * state.position.quantity * direction;
}

function updateEquity() {
  state.equity = state.balance + getUnrealizedPnl();
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  state.maxDrawdown = Math.max(state.maxDrawdown, state.peakEquity - state.equity);
  appendEquityPoint(false);
}

function appendEquityPoint(force) {
  const now = Date.now();
  const last = state.equityHistory.at(-1);
  if (!force && last && now - last.time < 5000) {
    last.value = state.equity;
    last.time = now;
  } else {
    state.equityHistory.push({ time: now, value: state.equity });
    if (state.equityHistory.length > MAX_EQUITY_POINTS) state.equityHistory.shift();
  }
}

function calculateEmaSeries(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
  }
  return result;
}

function updateUI() {
  const currency = value => formatNumber(value, 2, ' USDT');
  const price = value => value == null ? '—' : formatNumber(value, value >= 1000 ? 2 : 4);
  const unrealized = getUnrealizedPnl();
  const totalPnl = state.equity - state.startingBalance;
  const totalPercent = state.startingBalance ? (totalPnl / state.startingBalance) * 100 : 0;
  const drawdownPercent = state.peakEquity ? (state.maxDrawdown / state.peakEquity) * 100 : 0;

  elements.livePrice.textContent = price(state.currentPrice);
  elements.balance.textContent = currency(state.balance);
  elements.equity.textContent = currency(state.equity);
  elements.totalPnl.textContent = signedCurrency(totalPnl);
  elements.totalPnlPercent.textContent = `${signedNumber(totalPercent, 2)}% a kezdőtőkéhez képest`;
  elements.unrealizedPnl.textContent = signedCurrency(unrealized);
  elements.maxDrawdown.textContent = currency(state.maxDrawdown);
  elements.maxDrawdownPercent.textContent = `${drawdownPercent.toFixed(2)}% a csúcstőkéhez képest`;

  setPnlClass(elements.totalPnl, totalPnl);
  setPnlClass(elements.totalPnlPercent, totalPnl);
  setPnlClass(elements.unrealizedPnl, unrealized);

  if (state.currentPrice && state.previousPrice) {
    const change = ((state.currentPrice - state.previousPrice) / state.previousPrice) * 100;
    elements.priceChange.textContent = `${signedNumber(change, 3)}% az előző frissítéshez képest`;
    setPnlClass(elements.priceChange, change);
  } else {
    elements.priceChange.textContent = '1 perces gyertyák';
    elements.priceChange.classList.remove('positive', 'negative');
  }

  updatePositionUI();
  updatePerformanceUI();
  updateTradeTable();

  elements.botStatus.textContent = !state.running
    ? 'Leállítva'
    : state.paused ? 'Szünetel' : 'Aktív';
  elements.signalReason.textContent = state.lastSignal;
  elements.startButton.disabled = state.running;
  elements.pauseButton.disabled = !state.running;
  elements.closeButton.disabled = !state.position;
}

function updatePositionUI() {
  const p = state.position;
  if (!p) {
    elements.positionStatus.textContent = 'Nincs nyitott pozíció';
    elements.positionBadge.textContent = 'FLAT';
    elements.positionBadge.className = 'position-badge neutral';
    elements.positionSideLabel.textContent = 'Nincs pozíció';
    ['entryPrice', 'quantity', 'positionValue', 'stopPrice', 'targetPrice', 'openedAt']
      .forEach(id => { elements[id].textContent = '—'; });
    return;
  }

  elements.positionStatus.textContent = `${p.side} • ${state.symbol}`;
  elements.positionBadge.textContent = p.side;
  elements.positionBadge.className = `position-badge ${p.side.toLowerCase()}`;
  elements.positionSideLabel.textContent = `${p.side} • belépő ${formatNumber(p.entryPrice, 2)}`;
  elements.entryPrice.textContent = formatNumber(p.entryPrice, 2);
  elements.quantity.textContent = formatNumber(p.quantity, 6);
  elements.positionValue.textContent = formatNumber(p.positionValue, 2, ' USDT');
  elements.stopPrice.textContent = formatNumber(p.stopPrice, 2);
  elements.targetPrice.textContent = formatNumber(p.targetPrice, 2);
  elements.openedAt.textContent = formatDateTime(p.openedAt);
}

function updatePerformanceUI() {
  const wins = state.trades.filter(t => t.pnl > 0);
  const losses = state.trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = state.trades.length ? (wins.length / state.trades.length) * 100 : 0;

  elements.tradeCount.textContent = String(state.trades.length);
  elements.wins.textContent = String(wins.length);
  elements.losses.textContent = String(losses.length);
  elements.winRate.textContent = `${winRate.toFixed(1)}%`;
  elements.grossProfit.textContent = formatNumber(grossProfit, 2, ' USDT');
  elements.grossLoss.textContent = formatNumber(grossLoss, 2, ' USDT');
  setPnlClass(elements.grossProfit, grossProfit);
  setPnlClass(elements.grossLoss, grossLoss);
}

function updateTradeTable() {
  if (!state.trades.length) {
    elements.tradeTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">Még nincs lezárt kötés.</td></tr>';
    return;
  }

  elements.tradeTableBody.innerHTML = state.trades.map(trade => `
    <tr>
      <td>${escapeHtml(formatDateTime(trade.closedAt))}</td>
      <td class="${trade.side === 'LONG' ? 'positive' : 'negative'}">${trade.side}</td>
      <td>${formatNumber(trade.entryPrice, 2)}</td>
      <td>${formatNumber(trade.exitPrice, 2)}</td>
      <td class="${trade.pnl >= 0 ? 'positive' : 'negative'}">${signedCurrency(trade.pnl)}</td>
      <td>${escapeHtml(trade.reason)}</td>
    </tr>
  `).join('');
}

function setConnection(status, text) {
  elements.connectionDot.className = `dot ${status}`;
  elements.connectionText.textContent = text;
  if (status === 'offline') elements.lastUpdate.textContent = 'Még nincs adat';
}

function drawCharts() {
  drawPriceChart();
  drawEquityChart();
}

function drawPriceChart() {
  const canvas = elements.priceChart;
  const ctx = setupCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  if (state.candles.length < 2) return;
  const candles = state.candles.slice(-180);
  const closes = candles.map(c => c.close);
  const fastPeriod = state.settings?.fastEma || Number(elements.fastEma.value) || 9;
  const slowPeriod = state.settings?.slowEma || Number(elements.slowEma.value) || 21;
  const fast = calculateEmaSeries(closes, fastPeriod);
  const slow = calculateEmaSeries(closes, slowPeriod);
  const all = [...closes, ...fast, ...slow];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = Math.max((max - min) * 0.12, max * 0.0005);

  drawGrid(ctx, width, height);
  drawLine(ctx, closes, min - pad, max + pad, width, height, '#f5f8ff', 2.1);
  drawLine(ctx, fast, min - pad, max + pad, width, height, '#73e7c3', 1.6);
  drawLine(ctx, slow, min - pad, max + pad, width, height, '#74a8ff', 1.6);

  ctx.fillStyle = '#8fa0ba';
  ctx.font = '12px system-ui';
  ctx.fillText(formatNumber(max, max >= 1000 ? 2 : 4), 12, 20);
  ctx.fillText(formatNumber(min, min >= 1000 ? 2 : 4), 12, height - 12);
}

function drawEquityChart() {
  const canvas = elements.equityChart;
  const ctx = setupCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  const values = state.equityHistory.map(p => p.value);
  if (values.length < 2) {
    ctx.fillStyle = '#8fa0ba';
    ctx.font = '13px system-ui';
    ctx.fillText('A tőkegörbe a szimuláció közben jelenik meg.', 16, 28);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.18, state.startingBalance * 0.001);
  drawGrid(ctx, width, height);
  drawLine(ctx, values, min - pad, max + pad, width, height, '#73e7c3', 2.2, true);
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawGrid(ctx, width, height) {
  ctx.strokeStyle = 'rgba(143, 160, 186, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let i = 1; i < 7; i += 1) {
    const x = (width / 7) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawLine(ctx, values, min, max, width, height, color, lineWidth, fill = false) {
  if (values.length < 2 || max === min) return;
  const xFor = index => (index / (values.length - 1)) * width;
  const yFor = value => height - ((value - min) / (max - min)) * height;

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = xFor(index);
    const y = yFor(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  if (fill) {
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(115, 231, 195, 0.18)');
    gradient.addColorStop(1, 'rgba(115, 231, 195, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

function exportCsv() {
  if (!state.trades.length) {
    alert('Még nincs exportálható lezárt kötés.');
    return;
  }
  const headers = ['symbol', 'side', 'opened_at', 'closed_at', 'entry_price', 'exit_price', 'quantity', 'gross_pnl', 'fees', 'net_pnl', 'reason'];
  const rows = state.trades.slice().reverse().map(t => [
    t.symbol, t.side, new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(),
    t.entryPrice, t.exitPrice, t.quantity, t.grossPnl, t.fees, t.pnl, t.reason
  ]);
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `paper-trades-${state.symbol}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function saveState() {
  const serializable = {
    running: state.running,
    paused: state.paused,
    balance: state.balance,
    startingBalance: state.startingBalance,
    equity: state.equity,
    peakEquity: state.peakEquity,
    maxDrawdown: state.maxDrawdown,
    currentPrice: state.currentPrice,
    previousPrice: state.previousPrice,
    candles: state.candles,
    position: state.position,
    trades: state.trades,
    equityHistory: state.equityHistory,
    symbol: state.symbol,
    settings: state.settings,
    lastSignal: state.lastSignal,
    lastProcessedCandleTime: state.lastProcessedCandleTime,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

let saveTimer = null;
function saveStateThrottled() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveState();
    saveTimer = null;
  }, 2000);
}

function restoreState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    Object.assign(state, saved, { socket: null, reconnectTimer: null, reconnectAttempts: 0 });

    if (state.settings) {
      elements.startingBalance.value = state.settings.startingBalance;
      elements.symbol.value = state.settings.symbol;
      elements.positionPercent.value = state.settings.positionPercent;
      elements.fastEma.value = state.settings.fastEma;
      elements.slowEma.value = state.settings.slowEma;
      elements.stopLoss.value = state.settings.stopLoss;
      elements.takeProfit.value = state.settings.takeProfit;
      elements.feeRate.value = state.settings.feeRate * 100;
    }

    setControlsLocked(Boolean(state.running));
    elements.pauseButton.textContent = state.paused ? 'Folytatás' : 'Szünet';
    if (state.running) connectMarketData(false);
    return true;
  } catch (error) {
    console.warn('Nem sikerült visszaállítani a mentést:', error);
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
}

function formatNumber(value, decimals = 2, suffix = '') {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('hu-HU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + suffix;
}

function signedNumber(value, decimals = 2) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(decimals)}`;
}

function signedCurrency(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${formatNumber(n, 2, ' USDT')}`;
}

function setPnlClass(element, value) {
  element.classList.remove('positive', 'negative');
  if (value > 0) element.classList.add('positive');
  if (value < 0) element.classList.add('negative');
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('hu-HU', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

elements.startButton.addEventListener('click', startSimulation);
elements.pauseButton.addEventListener('click', togglePause);
elements.closeButton.addEventListener('click', () => closePosition(state.currentPrice, 'Kézi zárás'));
elements.resetButton.addEventListener('click', resetSimulation);
elements.exportButton.addEventListener('click', exportCsv);
window.addEventListener('resize', drawCharts);
window.addEventListener('beforeunload', saveState);

elements.symbol.addEventListener('change', () => {
  state.symbol = elements.symbol.value;
  elements.chartTitle.textContent = `${state.symbol} • 1 perc`;
});

restoreState();
updateUI();
drawCharts();
