const config = require('./config')

const isAdmin = id => config.ADMIN_IDS.includes(id)

module.exports = {
  mainMenu(userId, isConnected) {
    const rows = []

    if (isConnected) {
      rows.push([{ text: '📊 Панель бота', callback_data: 'bot_panel' }])
    } else {
      rows.push([{ text: '🎮 Подключить сервер', callback_data: 'connect_server' }])
    }

    rows.push([{ text: '⭐ Премиум', callback_data: 'premium_menu' }])

    if (isAdmin(userId)) {
      rows.push([{ text: '👑 Админ-панель', callback_data: 'admin_panel' }])
    }

    return { inline_keyboard: rows }
  },

  botPanel(info, premium) {
    const rows = [
      [{ text: `♻️ Анти-АФК: ${info.antiAfkEnabled ? '✅ Вкл' : '❌ Выкл'}`, callback_data: 'toggle_antiafk' }],
      [{ text: '🔄 Обновить данные', callback_data: 'refresh_panel' }],
    ]

    // OP block
    if (!info.opStatus && !info.opRequested) {
      rows.push([{ text: '🔑 Запросить ОП', callback_data: 'request_op' }])
    } else if (info.opRequested) {
      rows.push([
        { text: '✅ ОП выдан', callback_data: 'confirm_op' },
        { text: '❌ Отмена', callback_data: 'cancel_op_req' },
      ])
    } else {
      rows.push([{ text: '👑 ОП активен ✅', callback_data: 'noop' }])
    }

    if (premium) {
      rows.push([{ text: '🕹️ Управление ботом', callback_data: 'movement_panel' }])
      rows.push([{ text: '💬 Чат-мост TG↔MC', callback_data: 'chat_bridge' }])
    } else {
      rows.push([{ text: '🔒 Управление (только Premium)', callback_data: 'premium_menu' }])
    }

    rows.push([{ text: '🚪 Отключить бота', callback_data: 'disconnect_bot' }])
    rows.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }])

    return { inline_keyboard: rows }
  },

  premiumMenu(user) {
    const isLifetime = user?.premium_type === 'lifetime'
    const isMonthly =
      user?.premium_type === 'monthly' &&
      user?.premium_expires_at > Math.floor(Date.now() / 1000)
    const rows = []

    if (!isMonthly && !isLifetime) {
      rows.push([{ text: `⭐ Premium — ${config.PREMIUM_MONTHLY_STARS} ⭐ / месяц`, callback_data: 'buy_monthly' }])
      rows.push([{ text: `💎 Вечный Premium — ${config.PREMIUM_LIFETIME_STARS} ⭐`, callback_data: 'buy_lifetime' }])
    } else if (isMonthly) {
      rows.push([{ text: `⬆️ Апгрейд до Вечного — ${config.PREMIUM_UPGRADE_STARS} ⭐`, callback_data: 'buy_upgrade' }])
    }

    rows.push([{ text: '🔙 Назад', callback_data: 'main_menu' }])
    return { inline_keyboard: rows }
  },

  movementPanel(info) {
    return {
      inline_keyboard: [
        [{ text: '⬆️', callback_data: 'mv_forward' }],
        [
          { text: '⬅️', callback_data: 'mv_left' },
          { text: '⬇️', callback_data: 'mv_back' },
          { text: '➡️', callback_data: 'mv_right' },
        ],
        [
          { text: '⇧ Присесть', callback_data: 'mv_sneak' },
          { text: '⎵ Прыжок', callback_data: 'mv_jump' },
        ],
        [
          info?.followTarget
            ? { text: `🛑 Стоп-следование (${info.followTarget})`, callback_data: 'stop_follow' }
            : { text: '👤 Следовать за игроком', callback_data: 'follow_player' },
        ],
        [{ text: '📋 Лог действий', callback_data: 'action_log' }],
        [{ text: '🔙 К панели бота', callback_data: 'bot_panel' }],
      ],
    }
  },

  chatBridgePanel(info) {
    const rows = []
    if (info?.chatBridgeEnabled) {
      rows.push([{ text: '💬 Отправить в MC-чат', callback_data: 'send_mc_chat' }])
      rows.push([{ text: '🔴 Отключить чат-мост', callback_data: 'disable_bridge' }])
    } else {
      rows.push([{ text: '🟢 Включить чат-мост', callback_data: 'enable_bridge' }])
    }
    rows.push([{ text: '🔙 К панели бота', callback_data: 'bot_panel' }])
    return { inline_keyboard: rows }
  },

  adminPanel() {
    return {
      inline_keyboard: [
        [{ text: '🤖 Активные боты', callback_data: 'adm_bots' }],
        [{ text: '👥 Все пользователи', callback_data: 'adm_users' }],
        [{ text: '👑 Выдать Premium', callback_data: 'adm_give_prem' }],
        [{ text: '❌ Забрать Premium', callback_data: 'adm_remove_prem' }],
        [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
        [{ text: '🔙 Главное меню', callback_data: 'main_menu' }],
      ],
    }
  },

  back(target) {
    return { inline_keyboard: [[{ text: '🔙 Назад', callback_data: target }]] }
  },

  cancel() {
    return { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'cancel' }]] }
  },
}
