const db = require('./db');

function isPremium(user) {
  if (!user) return false;
  if (user.premium_type === 'eternal') return true;
  if (user.premium_type === 'monthly' && user.premium_expires > Math.floor(Date.now()/1000)) return true;
  return false;
}
function isEternal(user) { return user?.premium_type === 'eternal'; }
function ensureUser(ctx) {
  return db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name || '');
}
function formatPlanName(user) {
  if (!user) return '🆓 Бесплатный';
  if (user.premium_type === 'eternal') return '💎 Вечный Premium';
  if (user.premium_type === 'monthly' && user.premium_expires > Math.floor(Date.now()/1000)) {
    const exp = new Date(user.premium_expires*1000).toLocaleDateString('ru-RU');
    return `📅 Premium Monthly (до ${exp})`;
  }
  return '🆓 Бесплатный (7 дн)';
}
function formatStats(stats, user) {
  const plan = formatPlanName(user);
  const freeLimitNote = !isPremium(user) ? '\n⚠️ _Бесплатный тариф: бот выйдет через 7 дней_' : '';
  return (
    `🤖 *Панель управления*\n\n` +
    `👤 Ник бота: \`${stats.username}\`\n` +
    `🌐 Сервер: \`${stats.server}\`\n` +
    `📦 Версия: ${stats.version}\n\n` +
    `❤️ Здоровье: ${stats.health}/20\n` +
    `🍗 Голод: ${stats.food}/20\n` +
    `🎮 Режим: ${stats.gamemode}\n` +
    `👑 ОП: ${stats.opGranted ? '✅ Есть' : '❌ Нет'}\n\n` +
    `🌍 Время суток: ${stats.worldTime}\n` +
    `👥 Игроков онлайн: ${stats.onlineCount}\n` +
    `⏱ Сессия: ${stats.uptimeH}ч ${stats.uptimeM}м\n` +
    `📊 Всего онлайн: ${stats.totalH}ч ${stats.totalM}м\n\n` +
    `💎 Тариф: ${plan}` +
    freeLimitNote
  );
}
module.exports = { isPremium, isEternal, ensureUser, formatPlanName, formatStats };
