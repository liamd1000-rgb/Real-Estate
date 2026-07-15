function sma(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = bars.slice(1).map((bar, i) => {
    const prev = bars[i].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
  });
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

function trailingStopPrice(currentStop, currentPrice, atrValue) {
  return Math.max(currentStop, currentPrice - 3 * atrValue);
}

// Risk 1% of account per trade: shares = (account * 0.01) / (entry - stop)
// Fractional shares (rounded down to 4 decimal places, Alpaca's fractional precision)
// so small accounts still get correctly risk-sized positions instead of rounding to 0.
function positionSize(accountValue, entryPrice, stopPrice) {
  const riskPerShare = entryPrice - stopPrice;
  if (riskPerShare <= 0) return 0;
  const rawQty = (accountValue * 0.01) / riskPerShare;
  return Math.floor(rawQty * 10000) / 10000;
}

// Returns { signal: 'buy'|'hold', reason?, stopPrice?, ma50?, ma200?, rsiVal?, atrValue? }
function getBuySignal(bars) {
  if (bars.length < 201) return { signal: 'hold', reason: 'insufficient data' };

  const closes = bars.map(b => b.close);
  const ma50   = sma(closes, 50);
  const ma200  = sma(closes, 200);
  const last   = bars.at(-1);
  const prev   = bars.at(-2);
  const close  = last.close;

  // Rule 1: price must be above both moving averages
  if (close < ma50 || close < ma200) {
    return { signal: 'hold', reason: `price below MA50=$${ma50?.toFixed(2)} or MA200=$${ma200?.toFixed(2)}` };
  }

  // Rule 2a: prior bar's low touched the 50-day MA (within -2% to +3%)
  const pctFromMa50 = (prev.low - ma50) / ma50;
  if (pctFromMa50 < -0.02 || pctFromMa50 > 0.03) {
    return { signal: 'hold', reason: `no MA50 pullback (prev low ${(pctFromMa50 * 100).toFixed(1)}% from MA50)` };
  }

  // Rule 2b: strong bounce candle — close in upper 60% of day's range
  const range    = last.high - last.low;
  const closePos = range > 0 ? (close - last.low) / range : 0;
  if (closePos < 0.6) {
    return { signal: 'hold', reason: `weak candle (close at ${(closePos * 100).toFixed(0)}% of range)` };
  }

  // Rule 2c: RSI between 40–60 (not overbought, not oversold — mid-range bounce)
  const rsiVal = rsi(closes, 14);
  if (rsiVal === null || rsiVal < 40 || rsiVal > 60) {
    return { signal: 'hold', reason: `RSI out of range (${rsiVal?.toFixed(1)})` };
  }

  const atrValue = atr(bars, 14);
  if (!atrValue) return { signal: 'hold', reason: 'ATR unavailable' };

  return {
    signal: 'buy',
    stopPrice: close - 3 * atrValue,
    ma50, ma200, rsiVal, atrValue,
  };
}

module.exports = { sma, rsi, atr, trailingStopPrice, positionSize, getBuySignal };
