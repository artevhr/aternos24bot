require('dotenv').config();
const path = require('path');
const express = require('express');
const config = require('./src/config');
const db = require('./src/db');

if (!config.BOT_TOKEN) { console.error('❌ BOT_TOKEN не задан!'); process.exit(1); }
if (!config.ADMIN_ID)  { console.error('❌ ADMIN_ID не задан!');  process.exit(1); }

const app = express();

// ─── Static files FIRST — index.html отдаётся на GET / ───────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check (не перекрывает /) ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/status', (_, res) => res.json({ service: 'WHMineBot', status: 'running', uptime: Math.floor(process.uptime()) }));

app.listen(config.PORT, () => console.log(`🌐 HTTP слушает порт ${config.PORT}`));

// ─── DB ready → mount API + start bot ────────────────────────────────────────
db.ready.then(() => {
  console.log('💾 База данных готова');

  const apiRouter = require('./src/api');
  app.use('/api', apiRouter);

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

      // Set Mini App menu button
      const webDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBAPP_URL || '';
      if (webDomain) {
        const webUrl = webDomain.startsWith('http') ? webDomain : `https://${webDomain}`;
        bot.telegram.setChatMenuButton({
          menu_button: { type: 'web_app', text: '🎮 Панель', web_app: { url: webUrl } }
        }).catch(e => console.error('Menu button error:', e.message));
        console.log('🌐 Mini App URL:', webUrl);
      } else {
        console.log('⚠️  RAILWAY_PUBLIC_DOMAIN не задан — добавь его в Variables на Railway');
      }

      console.log(`👑 Admin ID: ${config.ADMIN_ID}`);
      console.log(`🔄 Авто-реконнект: ${config.AUTO_RECONNECT_MINUTES} мин`);
      console.log(`💳 CryptoBot: ${config.CRYPTOBOT_TOKEN ? '✅' : '❌'}`);
      console.log(`💳 Карта BY:  ${config.CARD_NUMBER ? '✅' : '❌'}`);

      startScheduler(bot);
      console.log('⏰ Планировщик запущен');
    })
    .catch(err => { console.error('❌ Ошибка запуска:', err.message); process.exit(1); });

  process.once('SIGINT',  () => { bot.stop('SIGINT');  db.persist(); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.persist(); process.exit(0); });

}).catch(err => { console.error('❌ Ошибка БД:', err.message); process.exit(1); });

const IGNORE = ['ECONNRESET','ETIMEDOUT','ENOTFOUND','EPIPE','ECONNREFUSED'];
process.on('unhandledRejection', err => { const m = err?.message||String(err); if (!IGNORE.some(c=>m.includes(c))) console.error('⚠️ Rejection:', m); });
process.on('uncaughtException',  err => { const m = err?.message||String(err); if (!IGNORE.some(c=>m.includes(c))) console.error('⚠️ Exception:', m); });
