require('dotenv').config();
const express = require('express');
const config = require('./src/config');
const db = require('./src/db');

if (!config.BOT_TOKEN) { console.error('❌ BOT_TOKEN не задан!'); process.exit(1); }
if (!config.ADMIN_ID)  { console.error('❌ ADMIN_ID не задан!');  process.exit(1); }

// HTTP keep-alive (Railway требует открытый порт)
const app = express();
app.get('/', (_, res) => res.json({ service: 'WHMineBot', status: 'running', uptime: Math.floor(process.uptime()) }));
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(config.PORT, () => console.log(`🌐 HTTP слушает порт ${config.PORT}`));

// Ждём инициализации sql.js (WASM) и только потом запускаем бота
db.ready.then(() => {
  console.log('💾 База данных готова');
  const bot = require('./src/tgbot');

  bot.launch()
    .then(() => {
      console.log('🤖 WHMineBot запущен!');
      console.log(`👑 Admin ID: ${config.ADMIN_ID}`);
      console.log(`💳 CryptoBot: ${config.CRYPTOBOT_TOKEN ? '✅' : '❌ не настроен'}`);
      console.log(`💳 Карта BY: ${config.CARD_NUMBER ? '✅' : '❌ не настроена'}`);
    })
    .catch((err) => { console.error('❌ Ошибка запуска бота:', err.message); process.exit(1); });

  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

}).catch((err) => {
  console.error('❌ Ошибка инициализации БД:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled:', err?.message || err));
process.on('uncaughtException',  (err) => console.error('⚠️ Exception:',  err?.message || err));
