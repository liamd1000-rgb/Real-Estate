require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const alpaca  = require('./alpaca');

const app  = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); }
  catch { return null; }
}

// ── Live status: Alpaca account + positions + local stop levels ───────────────
app.get('/api/status', async (req, res) => {
  try {
    const [account, positions, clock] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getClock(),
    ]);

    const stops = loadJSON('stops.json') ?? {};
    const log   = loadJSON('trade-log.json') ?? [];
    const first = log[0];
    const last  = log.at(-1);

    res.json({
      account: {
        value:       parseFloat(account.portfolio_value),
        buyingPower: parseFloat(account.buying_power),
        cash:        parseFloat(account.cash),
      },
      positions: positions.map(p => {
        const stop = stops[p.symbol] ?? null;
        const price = parseFloat(p.current_price);
        return {
          symbol:          p.symbol,
          qty:             parseInt(p.qty),
          avgEntry:        parseFloat(p.avg_entry_price),
          currentPrice:    price,
          marketValue:     parseFloat(p.market_value),
          unrealizedPL:    parseFloat(p.unrealized_pl),
          unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
          stop,
          stopDistPct: stop ? ((price - stop) / price * 100) : null,
        };
      }),
      regime:        last?.regime ?? 'UNKNOWN',
      lastRun:       last?.timestamp ?? null,
      marketOpen:    clock.is_open,
      startingValue: first?.accountValue ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Historical data: chart points, trade events, recent run feed ──────────────
app.get('/api/history', (req, res) => {
  const log = loadJSON('trade-log.json') ?? [];

  const chartData = log.map(e => ({ t: e.timestamp, v: e.accountValue, regime: e.regime }));

  const trades = [];
  for (const entry of log) {
    for (const d of entry.decisions ?? []) {
      if (d.action === 'buy' || d.action === 'stop_hit') {
        trades.push({ ...d, timestamp: entry.timestamp });
      }
    }
  }

  const recentRuns = log.slice(-40).reverse().map(e => ({
    timestamp:    e.timestamp,
    regime:       e.regime,
    accountValue: e.accountValue,
    decisions:    e.decisions ?? [],
  }));

  const totalBuys  = trades.filter(t => t.action === 'buy').length;
  const totalExits = trades.filter(t => t.action === 'stop_hit').length;

  res.json({ chartData, trades, recentRuns, totalBuys, totalExits });
});

app.listen(PORT, () => {
  console.log(`Dashboard → http://localhost:${PORT}`);
});
