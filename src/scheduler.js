const db = require('./db');
let botInstance = null;

function startScheduler(bot) {
  botInstance = bot;
  setInterval(runAllChecks, 60 * 60 * 1000); // каждый час
  setTimeout(runAllChecks, 15000);            // через 15 сек после старта
}

async function runAllChecks() {
  if (!botInstance) return;
  await checkExpiring24h();
  await checkExpiring3Days();
  await checkExpiredGracePeriod();
}

// Уведомление за 24 часа
async function checkExpiring24h() {
  const users = db.getUsersExpiringIn24h();
  for (const u of users) {
    const exp = new Date(u.premium_expires * 1000).toLocaleDateString('ru-RU');
    try {
      await botInstance.telegram.sendMessage(u.telegram_id,
        `⏰ *Premium истекает через 24 часа!*\n\nДата окончания: ${exp}\n\nПродли подписку, чтобы боты продолжали работать.`,
        { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{ text:'💎 Продлить', callback_data:'tariff' }]] } }
      );
    } catch {}
    await sleep(100);
  }
}

// Уведомление за 3 дня — предупреждение + выбор бота для мультибота
async function checkExpiring3Days() {
  const mc = require('./mcManager');
  const users = db.getUsersExpiringIn3Days();
  for (const u of users) {
    const exp = new Date(u.premium_expires * 1000).toLocaleDateString('ru-RU');
    const activeBots = mc.getActiveBotsForUser(u.telegram_id);
    try {
      if (activeBots.length > 1) {
        // Есть несколько ботов — предупредить о выборе
        let text = `⚠️ *Premium заканчивается ${exp}*\n\nУ тебя ${activeBots.length} активных бота.\n\nПосле окончания подписки:\n• Все боты получат 3 дня на дораболоть\n• Затем все отключатся кроме одного\n\nЧтобы выбрать какой бот останется — нажми кнопку или продли Premium:`;
        const rows = activeBots.map(inst => {
          const rec = db.getBotById(inst.botId);
          return [{ text: `🤖 Оставить ${inst.bot?.username} (${rec?.server_host})`, callback_data: `keep_bot_${inst.botId}` }];
        });
        rows.push([{ text: '💎 Продлить Premium', callback_data: 'tariff' }]);
        await botInstance.telegram.sendMessage(u.telegram_id, text, { parse_mode:'Markdown', reply_markup: { inline_keyboard: rows } });
      } else {
        await botInstance.telegram.sendMessage(u.telegram_id,
          `⚠️ *Premium заканчивается ${exp}*\n\nЧерез 3 дня бот предупредит об окончании и выйдет с сервера ещё через 3 дня.\n\nПродли подписку, чтобы не прерываться!`,
          { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{ text:'💎 Продлить', callback_data:'tariff' }]] } }
        );
      }
    } catch {}
    await sleep(100);
  }
}

// Проверка истёкших пользователей — бот даёт 3 дня grace period
async function checkExpiredGracePeriod() {
  const mc = require('./mcManager');
  const now = Math.floor(Date.now() / 1000);
  const users = db.getAllUsers();
  for (const u of users) {
    if (u.premium_type !== 'monthly') continue;
    if (!u.premium_expires || u.premium_expires > now) continue;
    // Premium истёк — проверяем активных ботов
    const activeBots = mc.getActiveBotsForUser(u.telegram_id);
    if (!activeBots.length) continue;
    const expiredSec = now - u.premium_expires;
    if (expiredSec < 0) continue;
    // Первые 3 дня — шлём предупреждение (только один раз, определяем по часам)
    if (expiredSec < 3 * 86400) {
      const hoursExpired = Math.floor(expiredSec / 3600);
      if (hoursExpired === 0 || hoursExpired === 24 || hoursExpired === 48) {
        const daysLeft = 3 - Math.floor(expiredSec / 86400);
        try {
          await botInstance.telegram.sendMessage(u.telegram_id,
            `⚠️ *Подписка закончилась!*\n\n${activeBots.length > 1 ? `Твои боты` : 'Твой бот'} ${activeBots.length > 1 ? 'работают' : 'работает'} ещё *${daysLeft} дн*. Потом ${activeBots.length > 1 ? 'все отключатся' : 'отключится'}.\n\nПродли Premium или бот выйдет с сервера.`,
            { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{ text:'💎 Продлить Premium', callback_data:'tariff' }]] } }
          );
        } catch {}
      }
    } else {
      // Прошло 3 дня — отключаем всех ботов
      for (const inst of activeBots) {
        try {
          await botInstance.telegram.sendMessage(u.telegram_id,
            `🔴 *Premium истёк 3 дня назад.*\n\nБот \`${inst.bot?.username}\` отключается с сервера.`,
            { parse_mode:'Markdown' }
          );
        } catch {}
        await mc.disconnectBotById(inst.botId);
        await sleep(200);
      }
      // Даунгрейд до free
      db.updateUserPremium(u.telegram_id, 'free', null);
    }
    await sleep(100);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { startScheduler };
