require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_KEY,
  secretKey: process.env.ALPACA_SECRET,
  baseUrl: 'https://paper-api.alpaca.markets',
  paper: true,
});

module.exports = alpaca;
