// Фоновые задачи: уведомления об истечении Premium
const db = require('./db');

let botInstance = null;

function startScheduler(bot) {
  botInstance = bot;

  // Проверяем каждый час
  setInterval(checkExpiringPremium, 60 * 60 * 1000);

  // И сразу при запуске через 10 сек
  setTimeout(checkExpiringPremium, 10000);
}

async function checkExpiringPremium() {
  if (!botInstance) return;
  try {
    const users = db.getUsersExpiringIn24h();
    for (const user of users) {
      const exp = new Date(user.premium_expires * 1000).toLocaleDateString('ru-RU');
      try {
        await botInstance.telegram.sendMessage(user.telegram_id,
          `⏰ *Напоминание о Premium*\n\nТвой Premium Monthly истекает *${exp}* — меньше 24 часов!\n\nПродли подписку, чтобы бот продолжал работать без ограничений.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '💎 Продлить Premium', callback_data: 'tariff' }]]
            }
          }
        );
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (e) {
    console.error('Scheduler error:', e.message);
  }
}

module.exports = { startScheduler };
