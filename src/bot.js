const { Telegraf, session } = require('telegraf')
const config = require('./config')
const { userOps } = require('./db')
const mc = require('./minecraft')
const kb = require('./keyboards')

const bot = new Telegraf(config.BOT_TOKEN)

// ─── Middleware ────────────────────────────────────────────────────────────────
bot.use(session())
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {}
  return next()
})

// ─── Helpers ───────────────────────────────────────────────────────────────────
const isAdmin = id => config.ADMIN_IDS.includes(id)
const isPrem = id => userOps.isPremium(id)

function formatBotInfo(info, premium) {
  let t = `🤖 <b>Панель бота</b> — <code>${info.username}</code>\n`
  t += `📡 <b>${info.host}:${info.port}</b>\n\n`
  t += `❤️ Жизни: <b>${info.health}/20</b>\n`
  t += `🍖 Голод: <b>${info.food}/20</b>\n`
  t += `🕐 Время в мире: <b>${info.worldTime}</b>\n`
  t += `👥 Игроков онлайн: <b>${info.online}</b>\n`
  t += `🎮 Геймод: <b>${info.gamemode}</b>\n`
  t += `⏱ На сервере: <b>${info.uptime}</b>\n`
  t += `♻️ Анти-АФК: ${info.antiAfkEnabled ? '✅ Вкл' : '❌ Выкл'}\n`
  t += `👑 ОП: ${
    info.opStatus
      ? '✅ Есть'
      : info.opRequested
      ? '⏳ Ожидает выдачи'
      : '❌ Нет'
  }\n`
  if (!premium && info.freeTimeLeft) {
    t += `\n⏰ <i>Бесплатный лимит: осталось ${info.freeTimeLeft}</i>`
  }
  return t
}

async function editOrReply(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra)
  } catch (_) {
    await ctx.reply(text, extra)
  }
}

// ─── /start ────────────────────────────────────────────────────────────────────
bot.start(async ctx => {
  const user = userOps.getOrCreate(ctx.from.id, ctx.from.username)
  ctx.session.state = null

  await ctx.replyWithHTML(
    `👋 Привет, <b>${ctx.from.first_name}</b>!\n\n` +
    `🤖 <b>WHMineBot</b> — держит твой Aternos-сервер живым.\n` +
    `Бот заходит в Minecraft и не даёт серверу выключиться.\n\n` +
    `🎮 Ник в игре: <code>whminebot-${user.sequential_id}</code>`,
    { reply_markup: kb.mainMenu(ctx.from.id, mc.isConnected(ctx.from.id)) }
  )
})

// ─── Main menu ─────────────────────────────────────────────────────────────────
bot.action('main_menu', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = null
  const user = userOps.getOrCreate(ctx.from.id, ctx.from.username)
  const connected = mc.isConnected(ctx.from.id)
  await editOrReply(ctx,
    `🏠 <b>Главное меню</b>\n\n` +
    `🎮 Ник: <code>whminebot-${user.sequential_id}</code>\n` +
    `📡 Статус: ${connected ? '🟢 Подключён' : '🔴 Не подключён'}\n` +
    `⭐ Тариф: ${isPrem(ctx.from.id) ? (userOps.get(ctx.from.id).premium_type === 'lifetime' ? '💎 Вечный Premium' : '⭐ Premium') : '🆓 Бесплатный'}`,
    { parse_mode: 'HTML', reply_markup: kb.mainMenu(ctx.from.id, connected) }
  )
})

bot.action('cancel', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = null
  await editOrReply(ctx, '❌ Отменено.', { reply_markup: kb.mainMenu(ctx.from.id, mc.isConnected(ctx.from.id)) })
})

bot.action('noop', ctx => ctx.answerCbQuery())

// ─── Connect server ────────────────────────────────────────────────────────────
bot.action('connect_server', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = 'await_host'
  ctx.session.connectData = {}
  await editOrReply(ctx,
    '🌐 <b>Подключение к серверу</b>\n\nВведи <b>IP-адрес</b> сервера:\n<i>Пример: play.example.com или 123.45.67.89</i>',
    { parse_mode: 'HTML', reply_markup: kb.cancel() }
  )
})

// ─── Bot panel ─────────────────────────────────────────────────────────────────
bot.action('bot_panel', async ctx => {
  await ctx.answerCbQuery()
  const info = mc.getInfo(ctx.from.id)
  if (!info) {
    return editOrReply(ctx, '❌ Бот не подключён.', {
      reply_markup: kb.mainMenu(ctx.from.id, false),
    })
  }
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx, formatBotInfo(info, premium), {
    parse_mode: 'HTML',
    reply_markup: kb.botPanel(info, premium),
  })
})

bot.action('refresh_panel', async ctx => {
  const info = mc.getInfo(ctx.from.id)
  if (!info) {
    await ctx.answerCbQuery('Бот отключился')
    return editOrReply(ctx, '❌ Бот отключился.', { reply_markup: kb.mainMenu(ctx.from.id, false) })
  }
  await ctx.answerCbQuery('🔄 Обновлено')
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx, formatBotInfo(info, premium), {
    parse_mode: 'HTML',
    reply_markup: kb.botPanel(info, premium),
  })
})

bot.action('toggle_antiafk', async ctx => {
  const enabled = mc.toggleAntiAfk(ctx.from.id)
  await ctx.answerCbQuery(enabled ? '✅ Анти-АФК включён' : '❌ Анти-АФК выключен')
  const info = mc.getInfo(ctx.from.id)
  if (!info) return
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx, formatBotInfo(info, premium), {
    parse_mode: 'HTML',
    reply_markup: kb.botPanel(info, premium),
  })
})

bot.action('request_op', async ctx => {
  await ctx.answerCbQuery()
  mc.requestOp(ctx.from.id)
  const info = mc.getInfo(ctx.from.id)
  if (!info) return
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx,
    formatBotInfo(info, premium) +
    `\n\n🔑 <b>Выдайте ОП на сервере командой:</b>\n<code>/op ${info.username}</code>`,
    { parse_mode: 'HTML', reply_markup: kb.botPanel(info, premium) }
  )
})

bot.action('confirm_op', async ctx => {
  await ctx.answerCbQuery('✅ ОП принят! Переключаю в Творческий...')
  mc.confirmOp(ctx.from.id)
  const info = mc.getInfo(ctx.from.id)
  if (!info) return
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx, formatBotInfo(info, premium), {
    parse_mode: 'HTML',
    reply_markup: kb.botPanel(info, premium),
  })
})

bot.action('cancel_op_req', async ctx => {
  await ctx.answerCbQuery('Запрос ОП отменён')
  mc.cancelOpRequest(ctx.from.id)
  const info = mc.getInfo(ctx.from.id)
  if (!info) return
  const premium = isPrem(ctx.from.id)
  await editOrReply(ctx, formatBotInfo(info, premium), {
    parse_mode: 'HTML',
    reply_markup: kb.botPanel(info, premium),
  })
})

bot.action('disconnect_bot', async ctx => {
  await ctx.answerCbQuery('🔌 Отключаю...')
  mc.disconnect(ctx.from.id)
  await editOrReply(ctx, '🔌 Бот отключён от сервера.', {
    reply_markup: kb.mainMenu(ctx.from.id, false),
  })
})

// Reconnect after kick/error
bot.action('reconnect', async ctx => {
  await ctx.answerCbQuery()
  const user = userOps.get(ctx.from.id)
  if (!user?.last_host) {
    return ctx.reply('❌ Нет сохранённого сервера.', { reply_markup: kb.mainMenu(ctx.from.id, false) })
  }
  await ctx.reply(
    `🔄 Переподключиться к <b>${user.last_host}:${user.last_port}</b>?`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да', callback_data: 'do_reconnect' },
            { text: '❌ Нет', callback_data: 'main_menu' },
          ],
        ],
      },
    }
  )
})

bot.action('do_reconnect', async ctx => {
  await ctx.answerCbQuery()
  const user = userOps.get(ctx.from.id)
  if (!user?.last_host) return ctx.reply('❌ Нет данных сервера.')

  const msg = await ctx.reply(`⏳ Подключаюсь к <b>${user.last_host}:${user.last_port}</b>...`, { parse_mode: 'HTML' })
  const premium = userOps.isPremium(ctx.from.id)

  try {
    await mc.connect(ctx.from.id, user.last_host, user.last_port, user.sequential_id, premium)
    const info = mc.getInfo(ctx.from.id)
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      `✅ <b>Переподключён!</b>\n\n${formatBotInfo(info, premium)}`,
      { parse_mode: 'HTML', reply_markup: kb.botPanel(info, premium) }
    )
  } catch (err) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      `❌ <b>Ошибка:</b> ${err.message}`,
      { reply_markup: kb.mainMenu(ctx.from.id, false) }
    )
  }
})

// ─── Premium ────────────────────────────────────────────────────────────────────
bot.action('premium_menu', async ctx => {
  await ctx.answerCbQuery()
  const user = userOps.get(ctx.from.id)
  const hasPrem = userOps.isPremium(ctx.from.id)
  let text = '⭐ <b>Тарифы WHMineBot</b>\n\n'

  if (hasPrem) {
    if (user.premium_type === 'lifetime') {
      text += '💎 У вас <b>Вечный Premium</b> — наслаждайтесь!\n\nВсе функции разблокированы навсегда.'
    } else {
      const exp = new Date(user.premium_expires_at * 1000).toLocaleDateString('ru-RU')
      text += `✅ У вас <b>Premium</b> до <b>${exp}</b>\n\nМожно апгрейднуться до Вечного.`
    }
  } else {
    text +=
      `<b>🆓 Бесплатный:</b>\n` +
      `• Бот на сервере до 72 часов\n` +
      `• Базовая панель (АФК, ОП, статы)\n\n` +
      `<b>⭐ Premium — ${config.PREMIUM_MONTHLY_STARS} ⭐/месяц:</b>\n` +
      `• Бот на сервере <b>бессрочно</b>\n` +
      `• 🕹️ Управление движением\n` +
      `• 💬 Чат-мост TG ↔ Minecraft\n` +
      `• 👤 Следование за игроком\n\n` +
      `<b>💎 Вечный Premium — ${config.PREMIUM_LIFETIME_STARS} ⭐:</b>\n` +
      `• Всё из Premium <b>навсегда</b>\n` +
      `• Можно апгрейднуть с месячного`
  }

  await editOrReply(ctx, text, { parse_mode: 'HTML', reply_markup: kb.premiumMenu(user) })
})

bot.action('buy_monthly', async ctx => {
  await ctx.answerCbQuery()
  await ctx.replyWithInvoice({
    title: '⭐ WHMineBot Premium',
    description: 'Безлимитное время + управление ботом + чат-мост на 30 дней',
    payload: `pm_${ctx.from.id}`,
    currency: 'XTR',
    prices: [{ label: 'Premium на 30 дней', amount: config.PREMIUM_MONTHLY_STARS }],
  })
})

bot.action('buy_lifetime', async ctx => {
  await ctx.answerCbQuery()
  await ctx.replyWithInvoice({
    title: '💎 WHMineBot Вечный Premium',
    description: 'Все функции навсегда — один платёж',
    payload: `pl_${ctx.from.id}`,
    currency: 'XTR',
    prices: [{ label: 'Вечный Premium', amount: config.PREMIUM_LIFETIME_STARS }],
  })
})

bot.action('buy_upgrade', async ctx => {
  await ctx.answerCbQuery()
  await ctx.replyWithInvoice({
    title: '⬆️ Апгрейд до Вечного Premium',
    description: 'Переход с месячного на вечный тариф',
    payload: `pu_${ctx.from.id}`,
    currency: 'XTR',
    prices: [{ label: 'Апгрейд до Вечного', amount: config.PREMIUM_UPGRADE_STARS }],
  })
})

bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true))

// ─── Movement (Premium) ────────────────────────────────────────────────────────
bot.action('movement_panel', async ctx => {
  if (!isPrem(ctx.from.id)) {
    return ctx.answerCbQuery('🔒 Только для Premium', { show_alert: true })
  }
  await ctx.answerCbQuery()
  const info = mc.getInfo(ctx.from.id)
  if (!info) return editOrReply(ctx, '❌ Бот не подключён.')
  await editOrReply(ctx,
    `🕹️ <b>Управление ботом</b>\n\n` +
    `📍 Позиция: <code>${info.position}</code>\n` +
    `🎮 Геймод: ${info.gamemode}\n` +
    `👤 Следую: ${info.followTarget || '—'}`,
    { parse_mode: 'HTML', reply_markup: kb.movementPanel(info) }
  )
})

const moveMap = {
  mv_forward: 'forward', mv_back: 'back',
  mv_left: 'left', mv_right: 'right',
  mv_jump: 'jump', mv_sneak: 'sneak',
}
const moveIcons = { forward: '⬆️', back: '⬇️', left: '⬅️', right: '➡️', jump: '⎵', sneak: '⇧' }

for (const [action, control] of Object.entries(moveMap)) {
  bot.action(action, async ctx => {
    if (!isPrem(ctx.from.id)) return ctx.answerCbQuery('🔒 Только Premium', { show_alert: true })
    mc.move(ctx.from.id, control)
    await ctx.answerCbQuery(`${moveIcons[control]} шаг`)
    const info = mc.getInfo(ctx.from.id)
    if (info) {
      await editOrReply(ctx,
        `🕹️ <b>Управление ботом</b>\n\n📍 Позиция: <code>${info.position}</code>\n🎮 Геймод: ${info.gamemode}\n👤 Следую: ${info.followTarget || '—'}`,
        { parse_mode: 'HTML', reply_markup: kb.movementPanel(info) }
      )
    }
  })
}

bot.action('follow_player', async ctx => {
  if (!isPrem(ctx.from.id)) return ctx.answerCbQuery('🔒 Только Premium', { show_alert: true })
  await ctx.answerCbQuery()
  const players = mc.getPlayers(ctx.from.id)
  if (players.length === 0) {
    ctx.session.state = 'await_follow_name'
    return editOrReply(ctx,
      '👤 На сервере нет других игроков онлайн.\nВведи ник игрока вручную:',
      { reply_markup: kb.cancel() }
    )
  }
  const btns = players.slice(0, 9).map(p => [{ text: `👤 ${p}`, callback_data: `flw_${p}` }])
  btns.push([{ text: '✏️ Ввести вручную', callback_data: 'follow_manual' }])
  btns.push([{ text: '🔙 Назад', callback_data: 'movement_panel' }])
  await editOrReply(ctx, '👥 Выбери игрока для следования:', { reply_markup: { inline_keyboard: btns } })
})

bot.action('follow_manual', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = 'await_follow_name'
  await editOrReply(ctx, '✏️ Введи ник игрока:', { reply_markup: kb.cancel() })
})

bot.action(/^flw_(.+)$/, async ctx => {
  if (!isPrem(ctx.from.id)) return ctx.answerCbQuery('🔒 Только Premium', { show_alert: true })
  const name = ctx.match[1]
  const ok = mc.followPlayer(ctx.from.id, name)
  await ctx.answerCbQuery(ok ? `✅ Слежу за ${name}` : '❌ Игрок не найден')
  const info = mc.getInfo(ctx.from.id)
  if (info) await editOrReply(ctx,
    `🕹️ <b>Управление ботом</b>\n\n📍 Позиция: <code>${info.position}</code>\n👤 Следую: ${info.followTarget || name}`,
    { parse_mode: 'HTML', reply_markup: kb.movementPanel(info) }
  )
})

bot.action('stop_follow', async ctx => {
  mc.stopFollow(ctx.from.id)
  await ctx.answerCbQuery('🛑 Следование остановлено')
  const info = mc.getInfo(ctx.from.id)
  if (info) await editOrReply(ctx,
    `🕹️ <b>Управление ботом</b>\n\n📍 Позиция: <code>${info.position}</code>\n🎮 Геймод: ${info.gamemode}\n👤 Следую: —`,
    { parse_mode: 'HTML', reply_markup: kb.movementPanel(info) }
  )
})

bot.action('action_log', async ctx => {
  if (!isPrem(ctx.from.id)) return ctx.answerCbQuery('🔒 Только Premium', { show_alert: true })
  await ctx.answerCbQuery()
  const log = mc.getActionLog(ctx.from.id)
  const text = log.length
    ? log.slice(-20).reverse().join('\n')
    : 'Лог пуст'
  await editOrReply(ctx,
    `📋 <b>Лог действий</b>\n\n<code>${text}</code>`,
    { parse_mode: 'HTML', reply_markup: kb.back('movement_panel') }
  )
})

// ─── Chat bridge (Premium) ─────────────────────────────────────────────────────
bot.action('chat_bridge', async ctx => {
  if (!isPrem(ctx.from.id)) return ctx.answerCbQuery('🔒 Только Premium', { show_alert: true })
  await ctx.answerCbQuery()
  const info = mc.getInfo(ctx.from.id)
  if (!info) return editOrReply(ctx, '❌ Бот не подключён.')
  await editOrReply(ctx,
    `💬 <b>Чат-мост TG ↔ Minecraft</b>\n\n` +
    `Статус: ${info.chatBridgeEnabled ? '🟢 Включён' : '🔴 Выключен'}\n` +
    (info.chatBridgeEnabled ? `Группа ID: <code>${info.chatBridgeGroup}</code>\n` : '') +
    `\n<i>Добавь бота в TG-группу и укажи её ID, чтобы сообщения из MC появлялись там и наоборот.</i>`,
    { parse_mode: 'HTML', reply_markup: kb.chatBridgePanel(info) }
  )
})

bot.action('enable_bridge', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = 'await_group_id'
  await editOrReply(ctx,
    '💬 Добавь бота в Telegram-группу, затем введи <b>ID группы</b>.\n\n' +
    '<i>ID начинается с минуса, например: -1001234567890\n' +
    'Узнать ID: добавь @userinfobot в группу</i>',
    { parse_mode: 'HTML', reply_markup: kb.cancel() }
  )
})

bot.action('disable_bridge', async ctx => {
  mc.disableChatBridge(ctx.from.id)
  await ctx.answerCbQuery('🔴 Чат-мост выключен')
  const info = mc.getInfo(ctx.from.id)
  await editOrReply(ctx,
    '💬 <b>Чат-мост TG ↔ Minecraft</b>\n\nСтатус: 🔴 Выключен',
    { parse_mode: 'HTML', reply_markup: kb.chatBridgePanel(info) }
  )
})

bot.action('send_mc_chat', async ctx => {
  await ctx.answerCbQuery()
  ctx.session.state = 'await_chat_msg'
  await editOrReply(ctx, '💬 Введи сообщение для отправки в Minecraft-чат:', { reply_markup: kb.cancel() })
})

// ─── Admin panel ───────────────────────────────────────────────────────────────
bot.action('admin_panel', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  await editOrReply(ctx, '👑 <b>Панель администратора</b>', {
    parse_mode: 'HTML',
    reply_markup: kb.adminPanel(),
  })
})

bot.action('adm_bots', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  const bots = mc.getAllBots()
  let text = `🤖 <b>Активные боты</b>: ${bots.length}\n\n`
  for (const b of bots) {
    const s = Math.floor((Date.now() - b.connectedAt) / 1000)
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    text += `• <code>${b.username}</code>\n  └ ${b.host}:${b.port} | ⏱ ${h}ч ${m}м | ${b.isPremium ? '⭐' : '🆓'} | TG: <code>${b.telegramId}</code>\n\n`
  }
  if (!bots.length) text += '<i>Нет активных ботов</i>'
  await editOrReply(ctx, text, { parse_mode: 'HTML', reply_markup: kb.back('admin_panel') })
})

bot.action('adm_users', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  const users = userOps.getAll()
  let text = `👥 <b>Пользователи</b>: ${users.length}\n\n`
  for (const u of users.slice(0, 25)) {
    const prem =
      u.premium_type === 'lifetime' ? '💎 Вечный'
      : u.premium_type === 'monthly' ? `⭐ до ${new Date(u.premium_expires_at * 1000).toLocaleDateString('ru-RU')}`
      : '🆓 Free'
    text += `• <b>${u.username || 'Unknown'}</b> (<code>${u.telegram_id}</code>)\n  └ ${prem} | whminebot-${u.sequential_id}\n\n`
  }
  if (users.length > 25) text += `<i>... и ещё ${users.length - 25}</i>`
  await editOrReply(ctx, text, { parse_mode: 'HTML', reply_markup: kb.back('admin_panel') })
})

bot.action('adm_give_prem', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  ctx.session.state = 'await_give_prem'
  await editOrReply(ctx,
    '👑 <b>Выдать Premium</b>\n\nФормат:\n' +
    '<code>ID тип [дней]</code>\n\n' +
    'Примеры:\n' +
    '<code>123456789 monthly 30</code>\n' +
    '<code>123456789 lifetime</code>',
    { parse_mode: 'HTML', reply_markup: kb.cancel() }
  )
})

bot.action('adm_remove_prem', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  ctx.session.state = 'await_remove_prem'
  await editOrReply(ctx, '❌ <b>Забрать Premium</b>\n\nВведи Telegram ID пользователя:', {
    parse_mode: 'HTML',
    reply_markup: kb.cancel(),
  })
})

bot.action('adm_broadcast', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true })
  await ctx.answerCbQuery()
  ctx.session.state = 'await_broadcast'
  await editOrReply(ctx, '📢 <b>Рассылка</b>\n\nВведи текст сообщения для всех пользователей:', {
    parse_mode: 'HTML',
    reply_markup: kb.cancel(),
  })
})

// ─── Message handler (text input states + payments) ────────────────────────────
bot.on('message', async (ctx, next) => {
  // ── Payments
  if (ctx.message?.successful_payment) {
    const payload = ctx.message.successful_payment.invoice_payload
    const uid = ctx.from.id

    if (payload.startsWith('pm_')) {
      const expires = Math.floor(Date.now() / 1000) + 30 * 86400
      userOps.setPremium(uid, 'monthly', expires)
      mc.clearFreeTimerOnUpgrade(uid)
      await ctx.reply(
        '✅ <b>Premium активирован на 30 дней!</b>\n\nТеперь бот работает бессрочно и доступны все функции управления.',
        { parse_mode: 'HTML', reply_markup: kb.mainMenu(uid, mc.isConnected(uid)) }
      )
    } else if (payload.startsWith('pl_') || payload.startsWith('pu_')) {
      userOps.setPremium(uid, 'lifetime', null)
      mc.clearFreeTimerOnUpgrade(uid)
      await ctx.reply(
        '💎 <b>Вечный Premium активирован!</b>\n\nСпасибо! Все функции доступны навсегда.',
        { parse_mode: 'HTML', reply_markup: kb.mainMenu(uid, mc.isConnected(uid)) }
      )
    }
    return
  }

  // ── Chat bridge: group message → MC
  if (ctx.chat?.type !== 'private' && ctx.message?.text) {
    const uid = ctx.from.id
    const info = mc.getInfo(uid)
    if (info?.chatBridgeGroup == ctx.chat.id) {
      const sender = ctx.from.username || ctx.from.first_name
      mc.sendChat(uid, `[TG] ${sender}: ${ctx.message.text}`)
    }
    return next()
  }

  if (!ctx.message?.text) return next()

  const state = ctx.session?.state
  if (!state) return next()

  const text = ctx.message.text.trim()

  // ── Server host
  if (state === 'await_host') {
    ctx.session.connectData = { host: text }
    ctx.session.state = 'await_port'
    return ctx.replyWithHTML(
      `✅ Хост: <code>${text}</code>\n\nТеперь введи <b>порт</b> (по умолчанию 25565):`,
      { reply_markup: kb.cancel() }
    )
  }

  // ── Server port
  if (state === 'await_port') {
    const port = parseInt(text)
    if (isNaN(port) || port < 1 || port > 65535) {
      return ctx.reply('❌ Неверный порт. Введи число от 1 до 65535:')
    }

    const { host } = ctx.session.connectData
    ctx.session.state = null

    const user = userOps.getOrCreate(ctx.from.id, ctx.from.username)
    userOps.saveLastServer(ctx.from.id, host, port)

    const msg = await ctx.replyWithHTML(
      `⏳ Подключаюсь к <b>${host}:${port}</b>...\n<i>Это займёт до 30 секунд</i>`
    )
    const premium = userOps.isPremium(ctx.from.id)

    try {
      await mc.connect(ctx.from.id, host, port, user.sequential_id, premium)
      const info = mc.getInfo(ctx.from.id)
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `✅ <b>Бот подключён!</b>\n\n${formatBotInfo(info, premium)}`,
        { parse_mode: 'HTML', reply_markup: kb.botPanel(info, premium) }
      )
    } catch (err) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `❌ <b>Ошибка подключения</b>\n\n<code>${err.message}</code>\n\n<i>Проверь IP и порт сервера.</i>`,
        { parse_mode: 'HTML', reply_markup: kb.mainMenu(ctx.from.id, false) }
      )
    }
    return
  }

  // ── Follow player name
  if (state === 'await_follow_name') {
    ctx.session.state = null
    const ok = mc.followPlayer(ctx.from.id, text)
    const info = mc.getInfo(ctx.from.id)
    if (!ok) {
      await ctx.replyWithHTML(`❌ Игрок <b>${text}</b> не найден на сервере.`)
    } else {
      await ctx.replyWithHTML(`✅ Следую за <b>${text}</b>`)
    }
    if (info) {
      await ctx.reply('🕹️ Управление:', { reply_markup: kb.movementPanel(info) })
    }
    return
  }

  // ── Group ID for chat bridge
  if (state === 'await_group_id') {
    ctx.session.state = null
    const groupId = parseInt(text)
    if (isNaN(groupId)) return ctx.reply('❌ Неверный ID группы.')
    const ok = mc.setChatBridge(ctx.from.id, groupId)
    if (!ok) return ctx.reply('❌ Бот не подключён.')
    await ctx.replyWithHTML(
      `✅ Чат-мост включён!\nСообщения из MC будут дублироваться в группу <code>${groupId}</code>.\n\nУбедись, что бот добавлен в эту группу.`,
      { reply_markup: kb.chatBridgePanel(mc.getInfo(ctx.from.id)) }
    )
    return
  }

  // ── MC chat message
  if (state === 'await_chat_msg') {
    ctx.session.state = null
    const ok = mc.sendChat(ctx.from.id, text)
    await ctx.replyWithHTML(
      ok ? `✅ Отправлено в MC: <code>${text}</code>` : '❌ Бот не подключён.',
      { reply_markup: kb.chatBridgePanel(mc.getInfo(ctx.from.id)) }
    )
    return
  }

  // ── Admin: give premium
  if (state === 'await_give_prem') {
    if (!isAdmin(ctx.from.id)) { ctx.session.state = null; return }
    ctx.session.state = null
    const parts = text.split(/\s+/)
    const targetId = parseInt(parts[0])
    const type = parts[1]
    const days = parseInt(parts[2]) || 30

    if (isNaN(targetId) || !['monthly', 'lifetime'].includes(type)) {
      return ctx.reply('❌ Неверный формат. Пример: 123456789 monthly 30')
    }

    const expires = type === 'lifetime' ? null : Math.floor(Date.now() / 1000) + days * 86400
    userOps.setPremium(targetId, type, expires)
    if (mc.isConnected(targetId)) mc.clearFreeTimerOnUpgrade(targetId)

    try {
      await ctx.telegram.sendMessage(
        targetId,
        `🎉 Вам выдан <b>${type === 'lifetime' ? 'Вечный' : `${days}-дневный`} Premium WHMineBot!</b>`,
        { parse_mode: 'HTML' }
      )
    } catch (_) {}

    await ctx.reply(`✅ Premium выдан пользователю ${targetId}`, { reply_markup: kb.adminPanel() })
    return
  }

  // ── Admin: remove premium
  if (state === 'await_remove_prem') {
    if (!isAdmin(ctx.from.id)) { ctx.session.state = null; return }
    ctx.session.state = null
    const targetId = parseInt(text)
    if (isNaN(targetId)) return ctx.reply('❌ Неверный ID')

    userOps.removePremium(targetId)

    try {
      await ctx.telegram.sendMessage(targetId, '⚠️ Ваш Premium WHMineBot был деактивирован.')
    } catch (_) {}

    await ctx.reply(`✅ Premium снят с ${targetId}`, { reply_markup: kb.adminPanel() })
    return
  }

  // ── Admin: broadcast
  if (state === 'await_broadcast') {
    if (!isAdmin(ctx.from.id)) { ctx.session.state = null; return }
    ctx.session.state = null

    const users = userOps.getAll()
    const statusMsg = await ctx.reply(`📢 Рассылаю ${users.length} пользователям...`)
    let sent = 0, failed = 0

    for (const u of users) {
      try {
        await ctx.telegram.sendMessage(
          u.telegram_id,
          `📢 <b>Сообщение от администратора WHMineBot</b>\n\n${text}`,
          { parse_mode: 'HTML' }
        )
        sent++
      } catch (_) {
        failed++
      }
      await new Promise(r => setTimeout(r, 50)) // avoid flood
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      `✅ <b>Рассылка завершена</b>\n📤 Отправлено: ${sent}\n❌ Не доставлено: ${failed}`,
      { parse_mode: 'HTML', reply_markup: kb.adminPanel() }
    )
    return
  }

  return next()
})

module.exports = bot
