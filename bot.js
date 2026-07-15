require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const alpaca = require('./alpaca');
const { sma, atr, trailingStopPrice, positionSize, getBuySignal } = require('./strategy');

const SYMBOLS        = ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'SPY'];
const MAX_POSITIONS  = 5;
const MIN_NOTIONAL   = 1;  // Alpaca's minimum fractional order value ($)
const STOPS_FILE     = path.join(__dirname, 'stops.json');
const TRADE_LOG_FILE = path.join(__dirname, 'trade-log.json');
const MAX_LOG_ENTRIES = 200;  // ~16 hours of 5-min runs

// ── Persistent trailing stop storage ─────────────────────────────────────────

function loadStops() {
  try { return JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveStops(stops) {
  fs.writeFileSync(STOPS_FILE, JSON.stringify(stops, null, 2));
}

// ── Trade log — persists decisions across runs for context ────────────────────

function loadTradeLog() {
  try { return JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8')); }
  catch { return []; }
}

function appendTradeLog(entry) {
  const log = loadTradeLog();
  log.push(entry);
  // Keep only the most recent entries so the file doesn't grow unbounded
  const trimmed = log.slice(-MAX_LOG_ENTRIES);
  fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trimmed, null, 2));
}

function printRecentHistory(log) {
  if (log.length === 0) return;
  console.log('── Recent run history ───────────────────────────────────────');
  const recent = log.slice(-5);
  for (const run of recent) {
    const actions = run.decisions
      .filter(d => d.action !== 'hold' && d.action !== 'skipped')
      .map(d => {
        if (d.action === 'buy')       return `BUY ${d.qty} ${d.symbol} @$${d.price}`;
        if (d.action === 'stop_hit')  return `STOP ${d.symbol} @$${d.price}`;
        if (d.action === 'hold_open') return `HOLD ${d.symbol} (stop $${d.stop?.toFixed(2)})`;
        return `${d.action} ${d.symbol}`;
      });
    const summary = actions.length ? actions.join(', ') : 'no actions';
    console.log(`  ${run.timestamp.slice(0, 16).replace('T', ' ')} UTC | ${run.regime} | $${run.accountValue?.toFixed(0)} | ${summary}`);
  }
  console.log('─────────────────────────────────────────────────────────────');
}

// ── Alpaca helpers ────────────────────────────────────────────────────────────

async function getBars(symbol, days = 365) {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const bars = [];
  const resp = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end:   end.toISOString(),
    timeframe: '1Day',
    limit: days,
    feed: 'iex',
  });

  for await (const bar of resp) {
    bars.push({
      open:  bar.OpenPrice  ?? bar.o,
      high:  bar.HighPrice  ?? bar.h,
      low:   bar.LowPrice   ?? bar.l,
      close: bar.ClosePrice ?? bar.c,
    });
  }
  return bars;
}

async function getAllPositions() {
  try { return await alpaca.getPositions(); }
  catch { return []; }
}

async function placeOrder(symbol, side, qty) {
  return alpaca.createOrder({ symbol, qty, side, type: 'market', time_in_force: 'day' });
}

// ── Earnings check (requires FMP_API_KEY in .env) ────────────────────────────

async function hasEarningsSoon(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) return false;

  const from = new Date().toISOString().split('T')[0];
  const to   = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0];
  const url  = `https://financialmodelingprep.com/api/v3/earning_calendar?symbol=${symbol}&from=${from}&to=${to}&apikey=${key}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let botRunning = false;

async function runBot() {
  if (botRunning) {
    console.log('Previous run still in progress — skipping tick.');
    return;
  }
  botRunning = true;
  try {
    await _runBot();
  } finally {
    botRunning = false;
  }
}

async function _runBot() {
  const runTimestamp = new Date().toISOString();
  console.log(`\n[${runTimestamp}] Running bot...`);

  // Show recent history so each run has context of past decisions
  const tradeLog = loadTradeLog();
  printRecentHistory(tradeLog);

  let account;
  try {
    account = await alpaca.getAccount();
  } catch (err) {
    console.error('Failed to connect to Alpaca:', err.message);
    return;
  }

  const accountValue = parseFloat(account.portfolio_value);
  const buyingPower  = parseFloat(account.buying_power);
  console.log(`Portfolio: $${accountValue.toFixed(2)} | Buying power: $${buyingPower.toFixed(2)}`);

  const clock = await alpaca.getClock();
  if (!clock.is_open) {
    console.log('Market is closed — no orders placed.');
    return;
  }

  // Fetch all bars and positions in parallel
  const [allBarsArr, allPositions] = await Promise.all([
    Promise.all(SYMBOLS.map(s => getBars(s, 365))),
    getAllPositions(),
  ]);
  const barsMap = Object.fromEntries(SYMBOLS.map((s, i) => [s, allBarsArr[i]]));

  // Market regime filter — SPY must be above its 200-day MA
  const spyBars  = barsMap['SPY'];
  const spyClose = spyBars.at(-1)?.close;
  const spyMa200 = sma(spyBars.map(b => b.close), 200);
  const regimeBullish = !spyMa200 || spyClose >= spyMa200;

  console.log(`SPY: $${spyClose?.toFixed(2)} | 200-day MA: $${spyMa200?.toFixed(2)} | Regime: ${regimeBullish ? 'BULLISH' : 'BEARISH'}`);
  if (!regimeBullish) console.log('Bearish regime — existing stop-losses still managed, no new entries.');

  const positionMap  = Object.fromEntries(allPositions.map(p => [p.symbol, p]));
  let openCount      = allPositions.length;

  const stops    = loadStops();
  const decisions = [];  // collected for the trade log

  for (const symbol of SYMBOLS) {
    try {
      const position = positionMap[symbol];
      const held     = position ? Math.abs(parseFloat(position.qty)) : 0;
      const bars     = barsMap[symbol];
      const closes   = bars.map(b => b.close);
      const price    = closes.at(-1);
      const atrValue = atr(bars, 14);

      // ── Manage existing position with trailing stop ──────────────────────
      if (held > 0) {
        if (!atrValue) {
          console.log(`${symbol}: held=${held}, ATR unavailable — cannot update stop`);
          decisions.push({ symbol, action: 'hold_open', held, price, reason: 'ATR unavailable' });
          continue;
        }
        const prevStop = stops[symbol] ?? (price - 3 * atrValue);
        const newStop  = trailingStopPrice(prevStop, price, atrValue);
        stops[symbol]  = newStop;

        if (price <= newStop) {
          // Sell Alpaca's own reported qty (string) rather than our reparsed float,
          // so fractional positions close out exactly instead of hitting rounding mismatches.
          const order = await placeOrder(symbol, 'sell', position.qty);
          console.log(`${symbol}: STOP HIT — SELL ${held} shares | price=$${price?.toFixed(2)} | stop=$${newStop.toFixed(2)} | order=${order.id}`);
          decisions.push({ symbol, action: 'stop_hit', held, price, stop: newStop, orderId: order.id });
          delete stops[symbol];
          openCount--;
        } else {
          console.log(`${symbol}: HOLD | held=${held} | price=$${price?.toFixed(2)} | stop=$${newStop.toFixed(2)} | ATR=$${atrValue.toFixed(2)}`);
          decisions.push({ symbol, action: 'hold_open', held, price, stop: newStop, atr: atrValue });
        }
        continue;
      }

      // ── New entry checks ─────────────────────────────────────────────────
      if (!regimeBullish) {
        console.log(`${symbol}: skipped (bearish regime)`);
        decisions.push({ symbol, action: 'skipped', reason: 'bearish regime', price });
        continue;
      }
      if (openCount >= MAX_POSITIONS) {
        console.log(`${symbol}: skipped (max ${MAX_POSITIONS} positions open)`);
        decisions.push({ symbol, action: 'skipped', reason: 'max positions', price });
        continue;
      }
      if (await hasEarningsSoon(symbol)) {
        console.log(`${symbol}: skipped (earnings within 5 trading days)`);
        decisions.push({ symbol, action: 'skipped', reason: 'earnings soon', price });
        continue;
      }

      const result = getBuySignal(bars);
      console.log(`${symbol}: signal=${result.signal}${result.reason ? ` | ${result.reason}` : ` | RSI=${result.rsiVal?.toFixed(1)} | MA50=$${result.ma50?.toFixed(2)}`} | price=$${price?.toFixed(2)}`);

      if (result.signal !== 'buy') {
        decisions.push({ symbol, action: 'hold', price, reason: result.reason });
        continue;
      }

      const { stopPrice } = result;
      const qty  = positionSize(accountValue, price, stopPrice);
      const cost = qty * price;

      if (qty <= 0 || cost < MIN_NOTIONAL) {
        console.log(`  -> Skipped: position size too small ($${cost.toFixed(2)} < $${MIN_NOTIONAL} minimum)`);
        decisions.push({ symbol, action: 'skipped', reason: 'position size too small', price });
        continue;
      }
      if (cost > buyingPower) {
        console.log(`  -> Skipped: need $${cost.toFixed(2)}, have $${buyingPower.toFixed(2)}`);
        decisions.push({ symbol, action: 'skipped', reason: 'insufficient buying power', price });
        continue;
      }

      // Send as a decimal string — Alpaca expects fractional qty as a string, not a float.
      const order   = await placeOrder(symbol, 'buy', qty.toString());
      stops[symbol] = stopPrice;
      openCount++;
      const risk = (qty * (price - stopPrice)).toFixed(2);
      console.log(`  -> BUY ${qty} shares @ ~$${price?.toFixed(2)} | stop=$${stopPrice.toFixed(2)} | risking $${risk} | order=${order.id}`);
      decisions.push({ symbol, action: 'buy', qty, price, stop: stopPrice, risk: parseFloat(risk), orderId: order.id });

    } catch (err) {
      console.error(`  Error processing ${symbol}:`, err.message);
      decisions.push({ symbol, action: 'error', reason: err.message });
    }
  }

  saveStops(stops);

  appendTradeLog({
    timestamp:    runTimestamp,
    regime:       regimeBullish ? 'BULLISH' : 'BEARISH',
    spyPrice:     spyClose,
    spyMa200,
    accountValue,
    buyingPower,
    openPositions: openCount,
    decisions,
  });
}

module.exports = { runBot };
