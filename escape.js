const fetch = require('node-fetch');
const config = require('./config');

const API_URL = 'https://pay.crypt.bot/api';

async function createInvoice(amountUSD, description, payload) {
  if (!config.CRYPTOBOT_TOKEN) return null;
  try {
    const res = await fetch(`${API_URL}/createInvoice`, {
      method: 'POST',
      headers: {
        'Crypto-Pay-API-Token': config.CRYPTOBOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        asset: 'USDT',
        amount: amountUSD,
        description,
        payload,
        paid_btn_name: 'callback',
      }),
    });
    const data = await res.json();
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

async function checkInvoice(invoiceId) {
  if (!config.CRYPTOBOT_TOKEN) return null;
  try {
    const res = await fetch(`${API_URL}/getInvoices?invoice_ids=${invoiceId}`, {
      headers: { 'Crypto-Pay-API-Token': config.CRYPTOBOT_TOKEN },
    });
    const data = await res.json();
    return data.ok && data.result.items.length ? data.result.items[0] : null;
  } catch {
    return null;
  }
}

module.exports = { createInvoice, checkInvoice };
