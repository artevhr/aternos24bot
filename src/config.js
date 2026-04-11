require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: parseInt(process.env.ADMIN_ID || '0'),
  CRYPTOBOT_TOKEN: process.env.CRYPTOBOT_TOKEN || '',
  DB_PATH: process.env.DB_PATH || './data/bot.db',
  PORT: parseInt(process.env.PORT || '3000'),
  WEBAPP_URL: process.env.WEBAPP_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '',
  // Канал, на который нужна подписка (например @mychannel или -1001234567)
  // Оставь пустым чтобы отключить проверку
  REQUIRED_CHANNEL: process.env.REQUIRED_CHANNEL || '',
  AUTO_RECONNECT_MINUTES: parseInt(process.env.AUTO_RECONNECT_MINUTES || '3'),
  FREE_LIMIT_HOURS: 168,       // 7 дней
  // Дефолтные цены (перезаписываются из БД через админ-панель)
  DEFAULT_PRICE_MONTHLY_STARS: 29,
  DEFAULT_PRICE_ETERNAL_STARS: 49,
  DEFAULT_PRICE_UPGRADE_STARS: 25,
  DEFAULT_CRYPTO_MONTHLY_USD: '1.00',
  DEFAULT_CRYPTO_ETERNAL_USD: '1.70',
  DEFAULT_CARD_NUMBER: process.env.CARD_NUMBER || '',
  DEFAULT_CARD_HOLDER: process.env.CARD_HOLDER || '',
  DEFAULT_CARD_MONTHLY_PRICE: process.env.CARD_MONTHLY_PRICE || '2.50 BYN',
  DEFAULT_CARD_ETERNAL_PRICE: process.env.CARD_ETERNAL_PRICE || '4.50 BYN',
};
