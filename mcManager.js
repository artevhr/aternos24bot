const { esc, code } = require('./escape');
const db = require('./db');

function isPremium(user) {
  if (!user) return false;
  if (user.premium_type === 'eternal') return true;
  if (user.premium_type === 'monthly' && user.premium_expires > Math.floor(Date.now()/1000)) return true;
  return false;
}
function isEternal(user) { return user?.premium_type === 'eternal'; }
function isMonthly(user) { return user?.premium_type === 'monthly' && user?.premium_expires > Math.floor(Date.now()/1000); }

function ensureUser(ctx) {
  return db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name || '');
}

function getSetting(key, fallback) {
  const val = db.getSetting(key);
  return val !== null ? val : String(fallback);
}

function getSettings() {
  const s = db.getAllSettings();
  return {
    priceMonthlyStars: parseInt(s.price_monthly_stars || '29'),
    priceEternalStars: parseInt(s.price_eternal_stars || '49'),
    priceUpgradeStars: parseInt(s.price_upgrade_stars || '25'),
    cryptoMonthlyUsd: s.crypto_monthly_usd || '1.00',
    cryptoEternalUsd: s.crypto_eternal_usd || '1.70',
    cardNumber: s.card_number || '',
    cardHolder: s.card_holder || '',
    cardMonthlyPrice: s.card_monthly_price || '2.50 BYN',
    cardEternalPrice: s.card_eternal_price || '4.50 BYN',
    starsEnabled: s.payment_stars_enabled !== '0',
    cryptoEnabled: s.payment_crypto_enabled !== '0',
    cardEnabled: s.payment_card_enabled !== '0',
  };
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
  const freeNote = !isPremium(user) ? '\n⚠️ _Бесплатный: бот выйдет через 7 дней_' : '';
  return (
    `🤖 *` + esc(stats.username) + `* — ` + code(stats.server) + `\n📦 ` + esc(stats.version) + `\n\n` +
    `❤️ ${stats.health}/20  🍗 ${stats.food}/20  🎮 ${stats.gamemode}\n` +
    `👑 ОП: ${stats.opGranted?'✅':'❌'}  🌍 ${stats.worldTime}  👥 ${stats.onlineCount} онлайн\n\n` +
    `⏱ Сессия: ${stats.uptimeH}ч ${stats.uptimeM}м\n` +
    `📊 Всего: ${stats.totalH}ч ${stats.totalM}м\n\n` +
    `💎 Тариф: ${plan}` + freeNote
  );
}

module.exports = { isPremium, isEternal, isMonthly, ensureUser, getSetting, getSettings, formatPlanName, formatStats };
