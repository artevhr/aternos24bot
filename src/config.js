require('dotenv').config()

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean),
  DB_PATH: process.env.DB_PATH || './data/whminebot.db',
  FREE_LIMIT_HOURS: 72,
  PREMIUM_MONTHLY_STARS: 29,
  PREMIUM_LIFETIME_STARS: 89,
  PREMIUM_UPGRADE_STARS: 60, // 89 - 29
}
