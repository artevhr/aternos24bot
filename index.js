require('dotenv').config();
const express = require('express');
const config = require('./src/config');
const db = require('./src/db');

if (!config.BOT_TOKEN) { console.error('❌ BOT_TOKEN не задан!'); process.exit(1); }
if (!config.ADMIN_ID)  { console.error('❌ ADMIN_ID не задан!');  process.exit(1); }

const app = express();
app.get('/', (_, res) => res.json({ service: 'WHMineBot', status: 'running', uptime: Math.floor(process.uptime()) }));
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(config.PORT, () => console.log(`🌐 HTTP слушает порт ${config.PORT}`));

db.ready.then(() => {
  console.log('💾 База данных готова');

  const bot = require('./src/tgbot');
  const { startScheduler } = require('./src/scheduler');

  bot.catch((err) => {
    const msg = err?.message || String(err);
    if (['ECONNRESET','ETIMEDOUT','ENOTFOUND','EPIPE'].some(c => msg.includes(c))) return;
    console.error('⚠️ Bot error:', msg);
  });

  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      console.log('🤖 WHMineBot запущен!');
      console.log(`👑 Admin ID: ${config.ADMIN_ID}`);
      console.log(`🔄 Авто-реконнект: ${config.AUTO_RECONNECT_MINUTES} мин`);
      console.log(`💳 CryptoBot: ${config.CRYPTOBOT_TOKEN ? '✅' : '❌'}`);
      console.log(`💳 Карта BY:  ${config.CARD_NUMBER ? '✅' : '❌'}`);

      // Запускаем планировщик после старта бота
      startScheduler(bot);
      console.log('⏰ Планировщик уведомлений запущен');
    })
    .catch(err => { console.error('❌ Ошибка запуска:', err.message); process.exit(1); });

  process.once('SIGINT',  () => { bot.stop('SIGINT');  db.persist(); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.persist(); process.exit(0); });

}).catch(err => { console.error('❌ Ошибка БД:', err.message); process.exit(1); });

const IGNORE = ['ECONNRESET','ETIMEDOUT','ENOTFOUND','EPIPE','ECONNREFUSED'];
process.on('unhandledRejection', err => { const m = err?.message||String(err); if (!IGNORE.some(c=>m.includes(c))) console.error('⚠️ Rejection:', m); });
process.on('uncaughtException',  err => { const m = err?.message||String(err); if (!IGNORE.some(c=>m.includes(c))) console.error('⚠️ Exception:', m); });
