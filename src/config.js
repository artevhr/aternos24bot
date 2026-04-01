require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: parseInt(process.env.ADMIN_ID || '0'),
  CRYPTOBOT_TOKEN: process.env.CRYPTOBOT_TOKEN || '',
  CARD_NUMBER: process.env.CARD_NUMBER || '',
  CARD_HOLDER: process.env.CARD_HOLDER || '',
  CARD_MONTHLY_PRICE: process.env.CARD_MONTHLY_PRICE || '2.50 BYN',
  CARD_ETERNAL_PRICE: process.env.CARD_ETERNAL_PRICE || '4.50 BYN',
  DB_PATH: process.env.DB_PATH || './data/bot.db',
  PORT: parseInt(process.env.PORT || '3000'),
  FREE_LIMIT_HOURS: 168,          // 7 дней
  PREMIUM_MONTHLY_STARS: 29,
  PREMIUM_ETERNAL_STARS: 49,
  PREMIUM_UPGRADE_STARS: 25,      // доплата Monthly→Eternal
  CRYPTO_MONTHLY_USD: '1.00',
  CRYPTO_ETERNAL_USD: '1.70',
  AUTO_RECONNECT_MINUTES: 3,      // авто-реконнект через N минут
};
