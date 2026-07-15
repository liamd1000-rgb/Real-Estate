require('dotenv').config();
const alpaca = require('./alpaca');
const { sma, atr, trailingStopPrice, positionSize, getBuySignal } = require('./strategy');

const SYMBOLS       = ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'SPY'];
const MAX_POSITIONS = 5;   // mirrors bot.js
const MIN_NOTIONAL  = 1;   // mirrors bot.js
const WARMUP_BARS   = 200; // SMA200 needs 200 prior daily bars before a signal is valid

const argCapital = process.argv.find(a => a.startsWith('--capital='));
const argDays     = process.argv.find(a => a.startsWith('--days='));
const CAPITAL_SCENARIOS = (argCapital ? argCapital.split('=')[1] : '1000,25000')
  .split(',').map(Number);
const LOOKBACK_DAYS = argDays ? parseInt(argDays.split('=')[1], 10) : 3650;

// ── Data fetch ────────────────────────────────────────────────────────────────

async function getDailyBars(symbol, days) {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const bars = [];
  const resp = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end:   end.toISOString(),
    timeframe: '1Day',
    limit: 10000,
    feed: 'iex',
    adjustment: 'split', // raw feed isn't split-adjusted — without this, stock splits (e.g. NVDA 10:1 in 2024) look like a 90% single-day crash
  });

  for await (const bar of resp) {
    bars.push({
      date:  (bar.Timestamp ?? bar.t).slice(0, 10),
      open:  bar.OpenPrice  ?? bar.o,
      high:  bar.HighPrice  ?? bar.h,
      low:   bar.LowPrice   ?? bar.l,
      close: bar.ClosePrice ?? bar.c,
    });
  }
  return bars;
}

// Align all symbols onto the same trading-day calendar (intersection of dates),
// since a symbol missing a date would desync the index-based lookback windows.
function alignByDate(barsMap) {
  const dateSets = SYMBOLS.map(s => new Set(barsMap[s].map(b => b.date)));
  const common = [...dateSets[0]]
    .filter(d => dateSets.every(set => set.has(d)))
    .sort();
  const commonSet = new Set(common);

  const aligned = {};
  for (const s of SYMBOLS) {
    aligned[s] = barsMap[s].filter(b => commonSet.has(b.date));
  }
  return { dates: common, aligned };
}

// ── Simulation ──────────────────────────────────────────────────────────────
//
// Mirrors bot.js's per-symbol logic (manage trailing stop, else evaluate entry)
// exactly, reusing strategy.js unchanged so the backtest reflects the live rules.
// Simplifications vs. live trading, noted here rather than modeled:
//   - No earnings-blackout filter (no free historical earnings calendar).
//   - Entry/exit both fill at the same day's close that generated the signal —
//     live trading would fill sometime after that, so this is mildly optimistic.
//   - Cash-account assumed (no margin) — a new position must be fully covered by cash.
function runBacktest(dates, aligned, startCapital, signalOpts = {}) {
  let cash = startCapital;
  const stops      = {};  // symbol -> current trailing stop
  const heldQty    = {};  // symbol -> qty held
  const openTrades = {};  // symbol -> { entryDate, entryPrice, qty }
  const trades     = [];  // closed round-trips
  const equityCurve = [];

  for (let i = WARMUP_BARS; i < dates.length; i++) {
    const date = dates[i];
    const spyBarsUpto = aligned['SPY'].slice(0, i + 1);
    const spyCloses   = spyBarsUpto.map(b => b.close);
    const spyMa200    = sma(spyCloses, 200);
    const regimeBullish = !spyMa200 || spyCloses.at(-1) >= spyMa200;

    let openCount = Object.keys(heldQty).length;

    for (const symbol of SYMBOLS) {
      const barsUpto = aligned[symbol].slice(0, i + 1);
      const price    = barsUpto.at(-1).close;
      const qtyHeld  = heldQty[symbol] || 0;

      // ── Manage existing position ────────────────────────────────────────
      if (qtyHeld > 0) {
        const atrValue = atr(barsUpto, 14);
        if (!atrValue) continue;

        const prevStop = stops[symbol] ?? (price - 3 * atrValue);
        const newStop  = trailingStopPrice(prevStop, price, atrValue);
        stops[symbol]  = newStop;

        if (price <= newStop) {
          cash += qtyHeld * price;
          const ot = openTrades[symbol];
          trades.push({
            symbol,
            entryDate: ot.entryDate, entryPrice: ot.entryPrice,
            exitDate: date, exitPrice: price, qty: qtyHeld,
            pnl: (price - ot.entryPrice) * qtyHeld,
            pnlPct: (price / ot.entryPrice - 1) * 100,
          });
          delete heldQty[symbol];
          delete stops[symbol];
          delete openTrades[symbol];
          openCount--;
        }
        continue;
      }

      // ── New entry ────────────────────────────────────────────────────────
      if (!regimeBullish || openCount >= MAX_POSITIONS) continue;

      const result = getBuySignal(barsUpto, signalOpts);
      if (result.signal !== 'buy') continue;

      const equity = cash + SYMBOLS.reduce((sum, s) => {
        const q = heldQty[s] || 0;
        return q ? sum + q * aligned[s][i].close : sum;
      }, 0);

      const qty  = positionSize(equity, price, result.stopPrice);
      const cost = qty * price;
      if (qty <= 0 || cost < MIN_NOTIONAL || cost > cash) continue;

      cash -= cost;
      heldQty[symbol]    = qty;
      stops[symbol]      = result.stopPrice;
      openTrades[symbol] = { entryDate: date, entryPrice: price, qty };
      openCount++;
    }

    const equity = cash + SYMBOLS.reduce((sum, s) => {
      const q = heldQty[s] || 0;
      return q ? sum + q * aligned[s][i].close : sum;
    }, 0);
    equityCurve.push({ date, equity });
  }

  return { equityCurve, trades, cash, heldQty, openTrades };
}

// ── Stats ───────────────────────────────────────────────────────────────────

function computeStats(startCapital, { equityCurve, trades }) {
  const final = equityCurve.at(-1)?.equity ?? startCapital;
  const totalReturnPct = (final / startCapital - 1) * 100;

  const years = equityCurve.length
    ? (new Date(equityCurve.at(-1).date) - new Date(equityCurve[0].date)) / (365.25 * 86400000)
    : 0;
  const cagr = years > 0 ? (Math.pow(final / startCapital, 1 / years) - 1) * 100 : 0;

  let peak = -Infinity, maxDrawdownPct = 0;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, (pt.equity - peak) / peak * 100);
  }

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    final, totalReturnPct, cagr, maxDrawdownPct, years,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    avgWin:  wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
  };
}

function printReport(startCapital, result, stats) {
  console.log(`\n══ Backtest: $${startCapital.toLocaleString()} starting capital ══════════════════`);
  console.log(`Period: ${result.equityCurve[0]?.date} → ${result.equityCurve.at(-1)?.date} (${stats.years.toFixed(1)} yrs)`);
  console.log(`Final equity: $${stats.final.toFixed(2)}  (${stats.totalReturnPct >= 0 ? '+' : ''}${stats.totalReturnPct.toFixed(2)}%)`);
  console.log(`CAGR: ${stats.cagr.toFixed(2)}%  |  Max drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Closed trades: ${stats.tradeCount}  |  Win rate: ${stats.winRate.toFixed(1)}%  |  Profit factor: ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}`);
  console.log(`Avg win: $${stats.avgWin.toFixed(2)}  |  Avg loss: $${stats.avgLoss.toFixed(2)}`);

  const openSymbols = Object.keys(result.heldQty);
  if (openSymbols.length) {
    console.log(`Still open at end: ${openSymbols.map(s => `${s} (${result.heldQty[s].toFixed(4)} sh)`).join(', ')}`);
  }

  if (result.trades.length) {
    console.log('\n  Trade log:');
    for (const t of result.trades) {
      const sign = t.pnl >= 0 ? '+' : '';
      console.log(`  ${t.entryDate} → ${t.exitDate} | ${t.symbol.padEnd(4)} | qty=${t.qty.toFixed(4).padStart(9)} | $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${sign}$${t.pnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(2)}%)`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${LOOKBACK_DAYS} days of daily bars for ${SYMBOLS.join(', ')}...`);
  const barsMap = {};
  for (const symbol of SYMBOLS) {
    barsMap[symbol] = await getDailyBars(symbol, LOOKBACK_DAYS);
    console.log(`  ${symbol}: ${barsMap[symbol].length} bars (${barsMap[symbol][0]?.date} → ${barsMap[symbol].at(-1)?.date})`);
  }

  const { dates, aligned } = alignByDate(barsMap);
  console.log(`Aligned calendar: ${dates.length} common trading days`);
  if (dates.length <= WARMUP_BARS) {
    console.error(`Not enough history for a ${WARMUP_BARS}-day SMA200 warmup — got ${dates.length} days.`);
    return;
  }

  for (const capital of CAPITAL_SCENARIOS) {
    const result = runBacktest(dates, aligned, capital);
    const stats  = computeStats(capital, result);
    printReport(capital, result, stats);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}

module.exports = { SYMBOLS, getDailyBars, alignByDate, runBacktest, computeStats };
