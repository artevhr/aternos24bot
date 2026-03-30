// версия v1.0.0
require('dotenv').config()

const bot = require('./bot')
const mc = require('./minecraft')

// Link MC manager to Telegram so it can send notifications
mc.setTelegram(bot.telegram)

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Shutting down...')
  bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
  console.log('Shutting down...')
  bot.stop('SIGTERM')
})

console.log('🤖 WHMineBot starting...')

bot.launch({
  dropPendingUpdates: true,
})
  .then(() => console.log('✅ Bot is running'))
  .catch(err => {
    console.error('❌ Failed to start bot:', err)
    process.exit(1)
  })
