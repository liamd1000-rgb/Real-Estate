require('dotenv').config();
const cron = require('node-cron');
const { runBot } = require('./bot');

console.log('Alpaca paper trading bot starting...');
console.log('Strategy: Mid-term swing | SMA50/200 + RSI + ATR trailing stop');
console.log('Symbols: AAPL, MSFT, TSLA, NVDA, SPY');
console.log('Schedule: every 5 minutes during market hours (Mon-Fri)\n');

// Run immediately on startup
runBot();

// Then run every 5 minutes Mon–Fri
cron.schedule('*/5 * * * 1-5', () => {
  runBot();
});
