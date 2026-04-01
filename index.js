require('dotenv').config();
const express = require('express');
const bot = require('./src/tgbot');
const config = require('./src/config');

if (!config.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан! Укажи его в .env');
  process.exit(1);
}
if (!config.ADMIN_ID) {
  console.error('❌ ADMIN_ID не задан! Укажи Telegram ID администратора в .env');
  process.exit(1);
}

// ─── Keep-alive HTTP server (Railway требует открытый порт) ───────────────────
const app = express();

app.get('/', (req, res) => {
  res.json({
    service: 'WHMineBot',
    status: 'running',
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.PORT, () => {
  console.log(`🌐 HTTP keep-alive слушает порт ${config.PORT}`);
});

// ─── Start Telegram bot ───────────────────────────────────────────────────────
bot.launch()
  .then(() => {
    console.log('🤖 WHMineBot запущен!');
    console.log(`👑 Admin ID: ${config.ADMIN_ID}`);
    console.log(`💾 База данных: ${config.DB_PATH}`);
    console.log(`💎 CryptoBot: ${config.CRYPTOBOT_TOKEN ? '✅ настроен' : '❌ не настроен'}`);
    console.log(`💳 Оплата картой: ${config.CARD_NUMBER ? '✅ настроена' : '❌ не настроена'}`);
  })
  .catch((err) => {
    console.error('❌ Ошибка запуска бота:', err.message);
    process.exit(1);
  });

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.once('SIGINT', () => {
  console.log('👋 Получен SIGINT, завершаю...');
  bot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('👋 Получен SIGTERM, завершаю...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Unhandled errors — log but don't crash
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err?.message || err);
});
