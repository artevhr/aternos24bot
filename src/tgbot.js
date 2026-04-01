const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');
const mc = require('./mcManager');
const kb = require('./keyboards');
const pay = require('./payments');
const { isPremium, isEternal, ensureUser, formatStats } = require('./helpers');

const bot = new Telegraf(config.BOT_TOKEN);
const states = new Map();
const getState = (id) => states.get(id) || {};
const setState = (id, patch) => states.set(id, { ...getState(id), ...patch });
const clearState = (id) => states.delete(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── MC event handler ─────────────────────────────────────────────────────────
function makeMcEventHandler(telegramId) {
  return async (event, data) => {
    try {
      switch (event) {
        case 'disconnected':
          await bot.telegram.sendMessage(telegramId, '🔌 Бот отключился от сервера.', kb.mainMenu(false));
          break;
        case 'reconnecting':
          await bot.telegram.sendMessage(telegramId, `🔄 Бот отключился. Авто-реконнект через *${data} мин*...`, { parse_mode: 'Markdown' });
          break;
        case 'reconnected':
          await bot.telegram.sendMessage(telegramId, '✅ Бот снова подключён к серверу!', kb.mainMenu(true));
          break;
        case 'reconnect_failed':
          await bot.telegram.sendMessage(telegramId, `❌ Авто-реконнект не удался:\n${data}`, kb.mainMenu(false));
          break;
        case 'kicked':
          await bot.telegram.sendMessage(telegramId, `⛔ Бот был кикнут.\n_${data}_`, { parse_mode: 'Markdown', ...kb.mainMenu(false) });
          break;
        case 'death':
          await bot.telegram.sendMessage(telegramId, '💀 Бот умер и возрождается...');
          break;
        case 'error':
          await bot.telegram.sendMessage(telegramId, `⚠️ ${data}`);
          break;
        case 'free_limit':
          await bot.telegram.sendMessage(telegramId, '⏰ *7 дней вышли!*\n\nБот отключён. Подключи снова или оформи Premium.', { parse_mode: 'Markdown', ...kb.mainMenu(false) });
          break;
        case 'op_granted':
          await bot.telegram.sendMessage(telegramId, '👑 Обнаружены права оператора! Нажми «ОП выдан» в панели.', kb.mainMenu(true));
          break;
        case 'chat':
          await bot.telegram.sendMessage(telegramId, `💬 *[MC]* <${data.playerName}> ${data.message}`, { parse_mode: 'Markdown' });
          break;
      }
    } catch {}
  };
}

// ─── Middleware ────────────────────────────────────────────────────────────────
bot.use(async (ctx, next) => { if (ctx.from) ensureUser(ctx); return next(); });

// ─── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const hasBot = !!mc.getActiveBot(ctx.from.id);
  await ctx.reply(
    `👋 *Привет!*\n\nЯ *WHMineBot* — держу твой Minecraft-сервер живым 24/7.\n\n🆓 Бесплатный тариф: бот сидит *7 дней*.\n💎 Premium: бот сидит *всегда* + управление, чат-мост и многое другое.\n\nВыбери действие:`,
    { parse_mode: 'Markdown', ...kb.mainMenu(hasBot) }
  );
});

// ─── /admin ────────────────────────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply('❌ Нет доступа.');
  await ctx.reply('🔧 *Панель администратора*', { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

// ─── Navigation ────────────────────────────────────────────────────────────────
bot.action('main', async (ctx) => {
  await ctx.answerCbQuery(); clearState(ctx.from.id);
  await ctx.editMessageText('🏠 *Главное меню*', { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(ctx.from.id)) });
});
bot.action('noop', ctx => ctx.answerCbQuery());

// ═══════════════════════════════════════════════════════════════════════════════
//  CONNECT FLOW
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('connect', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'host' });
  await ctx.editMessageText('🌐 *Шаг 1/3 — IP сервера*\n\nВведи IP-адрес или домен сервера:', { parse_mode: 'Markdown', ...kb.cancelKeyboard('main') });
});

bot.action('port_default', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { ...getState(ctx.from.id), step: 'version', port: 25565 });
  await ctx.editMessageText('📦 *Шаг 3/3 — Версия*\n\nВыбери версию Minecraft:', { parse_mode: 'Markdown', ...kb.versionKeyboard(0) });
});
bot.action(/^vp_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageReplyMarkup(kb.versionKeyboard(parseInt(ctx.match[1])).reply_markup); });

bot.action(/^ver_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const version = ctx.match[1];
  const userId = ctx.from.id;
  const state = getState(userId);
  if (state.step !== 'version') return;
  clearState(userId);
  const { host, port } = state;
  const user = db.getUser(userId);
  await ctx.editMessageText(`⏳ Подключаюсь...\n\n🌐 \`${host}:${port}\`\n📦 Версия: ${version}`, { parse_mode: 'Markdown' });
  const botNumber = db.getNextBotNumber();
  const botId = db.createBot(user.id, botNumber, host, port, version);
  try {
    await mc.connectBot(userId, host, port, version, botId, makeMcEventHandler(userId));
    const stats = mc.getBotStats(userId);
    if (stats) {
      await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
    } else {
      await ctx.editMessageText('✅ Бот подключён!', kb.mainMenu(true));
    }
  } catch (e) {
    db.updateBotStatus(botId, 'disconnected');
    await ctx.editMessageText(`❌ *Ошибка подключения*\n\n${e.message}`, { parse_mode: 'Markdown', ...kb.mainMenu(false) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TEXT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (state.step === 'host') {
    setState(userId, { step: 'port', host: text });
    return ctx.reply(`✅ Сервер: \`${text}\`\n\n*Шаг 2/3 — Порт*\n\nВведи порт:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('25565 (по умолчанию)', 'port_default')], [Markup.button.callback('❌ Отмена', 'main')]])
    });
  }
  if (state.step === 'port') {
    const port = parseInt(text);
    if (isNaN(port) || port < 1 || port > 65535) return ctx.reply('❌ Неверный порт (1–65535). Попробуй снова:');
    setState(userId, { ...state, step: 'version', port });
    return ctx.reply('📦 *Шаг 3/3 — Версия*\n\nВыбери версию Minecraft:', { parse_mode: 'Markdown', ...kb.versionKeyboard(0) });
  }
  if (state.step === 'follow') {
    clearState(userId);
    const ok = await mc.followPlayer(userId, text);
    return ctx.reply(ok ? `✅ Следую за \`${text}\`` : '❌ Не удалось.', { parse_mode: 'Markdown', ...kb.movementKeyboard(ok ? text : null) });
  }
  if (state.step === 'chat_mc') {
    clearState(userId);
    const ok = mc.sendChatToMC(userId, text);
    return ctx.reply(ok ? `✅ Отправлено: _${text}_` : '❌ Бот не подключён.', { parse_mode: 'Markdown' });
  }
  if (state.step === 'use_promo') {
    clearState(userId);
    return handlePromoCode(ctx, text);
  }
  // ── ADMIN flows ──
  if (userId !== config.ADMIN_ID) return;
  if (state.step === 'adm_broadcast') {
    const users = db.getAllUsers();
    setState(userId, { step: 'adm_broadcast_confirm', broadcastText: text });
    return ctx.reply(
      `📢 *Подтверждение рассылки*\n\nСообщение отправится *${users.length}* пользователям:\n\n${text}\n\n⚠️ Вы уверены?`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Да, отправить', 'adm_broadcast_confirm'), Markup.button.callback('❌ Отмена', 'adm_cancel')]]) }
    );
  }
  if (state.step === 'adm_grant_id') {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply('❌ Неверный ID:');
    const target = db.getUser(targetId);
    if (!target) return ctx.reply(`❌ Пользователь ${targetId} не найден.`);
    clearState(userId);
    return ctx.reply(`👤 @${target.username||'—'} (${targetId})\n💎 Тариф: ${target.premium_type}\n\nВыдать:`, kb.adminPremiumMenu(targetId));
  }
  if (state.step === 'adm_promo_create') {
    // format: CODE DAYS [MAX_USES]
    const parts = text.split(' ');
    if (parts.length < 2) return ctx.reply('❌ Формат: `КОД ДНИ [МАКС_ИСПОЛЬЗОВАНИЙ]`\nНапример: `SUMMER7 7 100`', { parse_mode: 'Markdown' });
    const [code, daysStr, maxStr] = parts;
    const days = parseInt(daysStr);
    const maxUses = parseInt(maxStr || '1');
    if (isNaN(days) || days < 1) return ctx.reply('❌ Неверное количество дней.');
    clearState(userId);
    try {
      db.createPromocode(code.toUpperCase(), days, maxUses, null);
      return ctx.reply(`✅ Промокод создан:\n\nКод: \`${code.toUpperCase()}\`\nДней: ${days}\nИспользований: ${maxUses}`, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
    } catch (e) {
      return ctx.reply(`❌ Ошибка: ${e.message}`, kb.adminKeyboard());
    }
  }
  if (state.step === 'adm_promo_delete') {
    clearState(userId);
    db.deletePromocode(text.toUpperCase());
    return ctx.reply(`✅ Промокод \`${text.toUpperCase()}\` удалён.`, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PANEL
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const user = db.getUser(userId);
  if (!mc.getActiveBot(userId)) return ctx.editMessageText('❌ Бот не подключён.', kb.mainMenu(false));
  const stats = mc.getBotStats(userId);
  if (!stats) return ctx.editMessageText('❌ Нет данных.', kb.mainMenu(false));
  await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
});

bot.action('toggle_afk', async (ctx) => {
  const result = mc.toggleAntiAfk(ctx.from.id);
  await ctx.answerCbQuery(result === null ? '❌ Бот не подключён' : result ? '🟢 Анти-АФК включён' : '🔴 Анти-АФК выключен');
  if (result !== null) {
    const user = db.getUser(ctx.from.id);
    const stats = mc.getBotStats(ctx.from.id);
    if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
  }
});

bot.action('request_op', async (ctx) => {
  await ctx.answerCbQuery();
  const inst = mc.getActiveBot(ctx.from.id);
  if (!inst) return ctx.answerCbQuery('❌ Бот не подключён', { show_alert: true });
  const botRecord = db.getBotById(inst.botId);
  inst.waitingForOp = true;
  await ctx.editMessageText(
    `🔑 *Запрос ОП*\n\nВыполни на сервере команду:\n\n\`/op ${botRecord.mc_username}\`\n\nЗатем нажми кнопку:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ ОП выдан — войти в Креатив', 'op_granted')], [Markup.button.callback('◀️ Назад', 'panel')]]) }
  );
});

bot.action('op_granted', async (ctx) => {
  await ctx.answerCbQuery('⏳ Применяю...');
  const ok = await mc.setCreative(ctx.from.id);
  await ctx.answerCbQuery(ok ? '✅ Вошёл в Креатив!' : '⚠️ Нет ОП?', { show_alert: !ok });
  const user = db.getUser(ctx.from.id);
  const stats = mc.getBotStats(ctx.from.id);
  if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
});
bot.action('op_already', ctx => ctx.answerCbQuery('👑 ОП уже есть!'));

bot.action('disconnect', async (ctx) => {
  await ctx.answerCbQuery();
  await mc.disconnectBot(ctx.from.id);
  await ctx.editMessageText('✅ Бот отключён от сервера.', kb.mainMenu(false));
});

// ─── Инвентарь ────────────────────────────────────────────────────────────────
bot.action('inventory', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Только для Premium!', { show_alert: true });
  const items = mc.getInventory(ctx.from.id);
  if (items === null) return ctx.answerCbQuery('❌ Бот не подключён', { show_alert: true });
  let text = '🎒 *Инвентарь бота:*\n\n';
  if (items.length === 0) {
    text += '_Инвентарь пуст_';
  } else {
    const grouped = {};
    for (const item of items) {
      const key = item.displayName;
      grouped[key] = (grouped[key] || 0) + item.count;
    }
    for (const [name, count] of Object.entries(grouped)) {
      text += `• ${name} × ${count}\n`;
    }
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить', 'inventory'), Markup.button.callback('◀️ Назад', 'panel')]]) });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PREMIUM MOVEMENT
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('movement', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Только для Premium!', { show_alert: true });
  if (!mc.getActiveBot(ctx.from.id)) return ctx.answerCbQuery('❌ Бот не подключён', { show_alert: true });
  const stats = mc.getBotStats(ctx.from.id);
  await ctx.editMessageText('🕹️ *Управление движением*\n\nКаждое нажатие двигает бота на 1 блок:', { parse_mode: 'Markdown', ...kb.movementKeyboard(stats?.followTarget||null) });
});

const dirMap = { mv_forward:'forward', mv_back:'back', mv_left:'left', mv_right:'right', mv_jump:'jump', mv_sneak:'sneak' };
const dirEmoji = { forward:'⬆️', back:'⬇️', left:'⬅️', right:'➡️', jump:'⎵', sneak:'⇧' };
for (const [action, dir] of Object.entries(dirMap)) {
  bot.action(action, async (ctx) => {
    const user = db.getUser(ctx.from.id);
    if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
    mc.moveBot(ctx.from.id, dir);
    await ctx.answerCbQuery(`${dirEmoji[dir]} Двигаюсь`);
  });
}
bot.action('mv_stop', async (ctx) => {
  const inst = mc.getActiveBot(ctx.from.id);
  if (inst?.bot) for (const d of ['forward','back','left','right']) try { inst.bot.setControlState(d, false); } catch {}
  await ctx.answerCbQuery('⏹ Остановлен');
});
bot.action('follow_player', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  setState(ctx.from.id, { step: 'follow' });
  await ctx.reply('👤 Введи ник игрока для слежки:');
});
bot.action('stop_follow', async (ctx) => {
  mc.stopFollow(ctx.from.id);
  await ctx.answerCbQuery('🛑 Слежка остановлена');
  await ctx.editMessageReplyMarkup(kb.movementKeyboard(null).reply_markup);
});
bot.action('action_log', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  const log = mc.getActionLog(ctx.from.id);
  const text = log.length ? log.slice(0,25).join('\n') : '(лог пуст)';
  await ctx.editMessageText(`📜 *Лог действий:*\n\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад в панель', 'panel')]]) });
});
bot.action('toggle_chat', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  const enabled = mc.toggleChatBridge(ctx.from.id);
  await ctx.answerCbQuery(enabled ? '💬 Чат-мост включён' : '💬 Чат-мост выключен');
  const user = db.getUser(ctx.from.id);
  const stats = mc.getBotStats(ctx.from.id);
  if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TARIFF
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('tariff', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  const prem = isPremium(user);
  const eternal = isEternal(user);
  const monthly = user?.premium_type === 'monthly' && prem;

  let text = '💎 *Тарифы WHMineBot*\n\n';
  text += `🆓 *Бесплатный*\n• Бот на сервере до 7 дней\n• Анти-АФК, базовая панель\n\n`;
  text += `📅 *Premium Monthly — 29 ⭐ / мес*\n• Постоянное подключение\n• Управление движением (WASD)\n• Слежка за игроком\n• Чат-мост TG ↔ Minecraft\n• Инвентарь бота\n• Лог действий\n\n`;
  text += `💎 *Premium Eternal — 49 ⭐ (навсегда)*\n• Всё из Monthly\n• Платишь один раз\n• Апгрейд с Monthly за 25 ⭐\n\n`;

  if (eternal) text += '✅ *У тебя вечный Premium!*';
  else if (monthly) {
    const exp = new Date(user.premium_expires*1000).toLocaleDateString('ru-RU');
    text += `✅ *Premium Monthly активен до ${exp}*\n💡 Апгрейд до Eternal — доплати 25 ⭐`;
  } else {
    text += '📌 Оплата: Telegram Stars, CryptoBot (USDT) или карта (BY)';
  }

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.tariffKeyboard(prem, eternal, monthly) });
});

// ── Stars ──────────────────────────────────────────────────────────────────────
bot.action('buy_monthly_stars', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title: '⭐ Premium Monthly — WHMineBot',
    description: 'Постоянное подключение + управление движением, чат-мост, инвентарь. 30 дней.',
    payload: `monthly_${ctx.from.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: 'Premium Monthly', amount: config.PREMIUM_MONTHLY_STARS }],
  });
});
bot.action('buy_eternal_stars', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title: '💎 Premium Eternal — WHMineBot',
    description: 'Все функции навсегда. Платишь один раз.',
    payload: `eternal_${ctx.from.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: 'Premium Eternal', amount: config.PREMIUM_ETERNAL_STARS }],
  });
});
bot.action('buy_upgrade_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (user?.premium_type !== 'monthly') return ctx.answerCbQuery('❌ Апгрейд только с Monthly', { show_alert: true });
  await ctx.replyWithInvoice({
    title: '⬆️ Апгрейд Monthly → Eternal',
    description: 'Доплата для перехода с Monthly на вечный Premium.',
    payload: `upgrade_${ctx.from.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: 'Апгрейд до Eternal', amount: config.PREMIUM_UPGRADE_STARS }],
  });
});

bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload;
  const userId = ctx.from.id;
  if (payload.startsWith('monthly_')) {
    db.updateUserPremium(userId, 'monthly', Math.floor(Date.now()/1000) + 30*24*3600);
    await ctx.reply('🎉 *Premium Monthly активирован!* Действует 30 дней.', { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) });
  } else if (payload.startsWith('eternal_') || payload.startsWith('upgrade_')) {
    db.updateUserPremium(userId, 'eternal', null);
    await ctx.reply('🎉 *Premium Eternal активирован!* Спасибо!', { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) });
  }
});

// ── CryptoBot ──────────────────────────────────────────────────────────────────
bot.action('pay_crypto', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.CRYPTOBOT_TOKEN) return ctx.answerCbQuery('❌ CryptoBot не настроен', { show_alert: true });
  await ctx.editMessageText(
    `🤖 *Оплата через CryptoBot (USDT)*\n\n• Monthly — $${config.CRYPTO_MONTHLY_USD}\n• Eternal — $${config.CRYPTO_ETERNAL_USD}`,
    { parse_mode: 'Markdown', ...kb.cryptoKeyboard() }
  );
});
bot.action('crypto_monthly', async (ctx) => {
  await ctx.answerCbQuery('⏳ Создаю счёт...');
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'monthly', 'crypto', config.CRYPTO_MONTHLY_USD);
  const invoice = await pay.createInvoice(config.CRYPTO_MONTHLY_USD, 'WHMineBot Premium Monthly', `m_${pid}`);
  if (!invoice) return ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
  await ctx.editMessageText(`💰 *Счёт: ${config.CRYPTO_MONTHLY_USD} USDT — Monthly*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.url('💳 Оплатить', invoice.pay_url)], [Markup.button.callback('✅ Я оплатил', `chk_${invoice.invoice_id}_${pid}_monthly`)], [Markup.button.callback('◀️ Назад', 'tariff')]])
  });
});
bot.action('crypto_eternal', async (ctx) => {
  await ctx.answerCbQuery('⏳ Создаю счёт...');
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'eternal', 'crypto', config.CRYPTO_ETERNAL_USD);
  const invoice = await pay.createInvoice(config.CRYPTO_ETERNAL_USD, 'WHMineBot Premium Eternal', `e_${pid}`);
  if (!invoice) return ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
  await ctx.editMessageText(`💰 *Счёт: ${config.CRYPTO_ETERNAL_USD} USDT — Eternal*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.url('💳 Оплатить', invoice.pay_url)], [Markup.button.callback('✅ Я оплатил', `chk_${invoice.invoice_id}_${pid}_eternal`)], [Markup.button.callback('◀️ Назад', 'tariff')]])
  });
});
bot.action(/^chk_(\d+)_(\d+)_(monthly|eternal)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Проверяю...');
  const [, invoiceId, pid, type] = ctx.match;
  const invoice = await pay.checkInvoice(invoiceId);
  if (invoice?.status === 'paid') {
    db.updatePayment(pid, 'completed');
    type === 'monthly'
      ? db.updateUserPremium(ctx.from.id, 'monthly', Math.floor(Date.now()/1000)+30*24*3600)
      : db.updateUserPremium(ctx.from.id, 'eternal', null);
    await ctx.editMessageText(`🎉 *Оплата подтверждена!* Premium ${type === 'eternal' ? 'Eternal' : 'Monthly'} активирован.`, { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(ctx.from.id)) });
  } else {
    await ctx.answerCbQuery('❌ Оплата не найдена. Подожди немного.', { show_alert: true });
  }
});

// ── Card ───────────────────────────────────────────────────────────────────────
bot.action('pay_card', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.CARD_NUMBER) return ctx.answerCbQuery('❌ Оплата картой не настроена', { show_alert: true });
  await ctx.editMessageText(
    `💳 *Оплата картой (Беларусь)*\n\nРеквизиты:\n\`${config.CARD_NUMBER}\`\nПолучатель: ${config.CARD_HOLDER||'—'}\n\nТарифы:\n• Monthly — ${config.CARD_MONTHLY_PRICE}\n• Eternal — ${config.CARD_ETERNAL_PRICE}\n\n📝 В комментарии укажи свой ID: \`${ctx.from.id}\`\n\nПосле оплаты нажми кнопку:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📅 Оплатил Monthly', `card_m_${ctx.from.id}`), Markup.button.callback('💎 Оплатил Eternal', `card_e_${ctx.from.id}`)], [Markup.button.callback('◀️ Назад', 'tariff')]]) }
  );
});
bot.action(/^card_(m|e)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal';
  const userId = parseInt(ctx.match[2]);
  const user = db.getUser(userId);
  const pid = db.createPayment(user.id, userId, type, 'card', type==='monthly'?config.CARD_MONTHLY_PRICE:config.CARD_ETERNAL_PRICE);
  try {
    await bot.telegram.sendMessage(config.ADMIN_ID,
      `💳 *Новая заявка на оплату картой!*\n\n👤 @${ctx.from.username||ctx.from.first_name} (${userId})\n📦 Тариф: ${type}\n🆔 Заявка #${pid}`,
      { parse_mode: 'Markdown', ...kb.cardApproveKeyboard(userId, pid) }
    );
  } catch {}
  await ctx.editMessageText('✅ *Заявка отправлена!* Администратор проверит и активирует Premium.', { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) });
});
bot.action(/^adm_card_(m|e)_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal';
  const targetId = parseInt(ctx.match[2]); const pid = ctx.match[3];
  type==='monthly' ? db.updateUserPremium(targetId,'monthly',Math.floor(Date.now()/1000)+30*24*3600) : db.updateUserPremium(targetId,'eternal',null);
  db.updatePayment(pid,'completed');
  try { await bot.telegram.sendMessage(targetId, `🎉 *Premium ${type==='eternal'?'Eternal':'Monthly'} активирован!* Оплата подтверждена.`, { parse_mode:'Markdown' }); } catch {}
  await ctx.editMessageText(`✅ Premium ${type} выдан ${targetId}.`);
});
bot.action(/^adm_card_rej_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  db.updatePayment(ctx.match[2],'rejected');
  try { await bot.telegram.sendMessage(parseInt(ctx.match[1]),'❌ Оплата картой не подтверждена. Напиши администратору.'); } catch {}
  await ctx.editMessageText(`❌ Заявка #${ctx.match[2]} отклонена.`);
});

// ── Промокоды ──────────────────────────────────────────────────────────────────
bot.action('use_promo', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'use_promo' });
  await ctx.editMessageText('🎁 *Промокод*\n\nВведи промокод:', { parse_mode: 'Markdown', ...kb.cancelKeyboard('tariff') });
});

async function handlePromoCode(ctx, code) {
  const userId = ctx.from.id;
  const promo = db.getPromocode(code);
  if (!promo) return ctx.reply('❌ Промокод не найден.');
  const now = Math.floor(Date.now()/1000);
  if (promo.expires_at && promo.expires_at < now) return ctx.reply('❌ Промокод истёк.');
  if (promo.used_count >= promo.max_uses) return ctx.reply('❌ Промокод уже использован максимальное число раз.');
  if (db.hasUsedPromo(code, userId)) return ctx.reply('❌ Ты уже использовал этот промокод.');

  db.usePromocode(code, userId);
  const user = db.getUser(userId);

  // Extend or grant premium
  const isPrem = isPremium(user);
  const currentExpires = (user?.premium_type === 'monthly' && isPrem) ? user.premium_expires : now;
  const newExpires = currentExpires + promo.days * 24 * 3600;

  if (!isEternal(user)) {
    db.updateUserPremium(userId, 'monthly', newExpires);
  }

  const exp = new Date(newExpires*1000).toLocaleDateString('ru-RU');
  await ctx.reply(
    `🎉 *Промокод активирован!*\n\nПолучено: +${promo.days} дней Premium\nPremium активен до: ${exp}`,
    { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN PANEL
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('adm_bots', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const bots = mc.getAllActiveBots();
  if (!bots.length) return ctx.editMessageText('🤖 Нет активных ботов.', kb.adminKeyboard());
  let text = `🤖 *Активные боты (${bots.length}):*\n\n`;
  for (const inst of bots) {
    const s = mc.getBotStats(inst.userId);
    if (s) text += `• \`${s.username}\` → \`${s.server}\` | ❤️${s.health} 🍗${s.food} ⏱${s.uptimeH}ч${s.uptimeM}м\n`;
  }
  // Add kick buttons
  const kickRows = bots.map(inst => [Markup.button.callback(`🛑 Кик ${inst.bot?.username||'?'}`, `adm_kick_${inst.userId}`)]);
  kickRows.push([Markup.button.callback('◀️ Назад', 'adm_back')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kickRows) });
});

bot.action(/^adm_kick_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery('⏳ Кикаю...');
  const targetUserId = parseInt(ctx.match[1]);
  const inst = mc.getActiveBot(targetUserId);
  if (!inst) return ctx.answerCbQuery('❌ Бот уже не подключён', { show_alert: true });
  const username = inst.bot?.username || '?';
  await mc.disconnectBot(targetUserId);
  try { await bot.telegram.sendMessage(targetUserId, '⚠️ Администратор отключил твоего бота от сервера.'); } catch {}
  await ctx.editMessageText(`✅ Бот \`${username}\` отключён администратором.`, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_dashboard', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const totalUsers = db.countUsers();
  const premiumUsers = db.countPremiumUsers();
  const activeBots = db.countActiveBots();
  const completedPayments = db.countCompletedPayments();
  const allUsers = db.getAllUsers();
  const eternalCount = allUsers.filter(u => u.premium_type === 'eternal').length;
  const monthlyCount = allUsers.filter(u => u.premium_type === 'monthly' && u.premium_expires > Math.floor(Date.now()/1000)).length;

  const text =
    `📈 *Дашборд WHMineBot*\n\n` +
    `👥 Всего пользователей: *${totalUsers}*\n` +
    `💎 Premium: *${premiumUsers}* (Monthly: ${monthlyCount}, Eternal: ${eternalCount})\n` +
    `🆓 Бесплатных: *${totalUsers - premiumUsers}*\n` +
    `🤖 Ботов онлайн прямо сейчас: *${activeBots}*\n` +
    `💰 Завершённых оплат: *${completedPayments}*\n\n` +
    `⭐ Теоретическая выручка (Stars):\n` +
    `• Monthly (29×${monthlyCount}): *${29*monthlyCount} Stars*\n` +
    `• Eternal (49×${eternalCount}): *${49*eternalCount} Stars*\n` +
    `• Итого: *${29*monthlyCount + 49*eternalCount} Stars*`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'adm_back')]]) });
});

bot.action('adm_users', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const users = db.getAllUsers();
  const planIcon = u => u.premium_type==='eternal'?'💎':u.premium_type==='monthly'?'📅':'🆓';
  let text = `👥 *Пользователи (${users.length}):*\n\n`;
  for (const u of users.slice(0,30)) text += `${planIcon(u)} ${u.telegram_id} @${u.username||'—'}\n`;
  if (users.length > 30) text += `\n...и ещё ${users.length-30}`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_premium', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_grant_id' });
  await ctx.editMessageText('💎 *Управление Premium*\n\nВведи Telegram ID пользователя:', { parse_mode: 'Markdown', ...kb.cancelKeyboard('adm_cancel') });
});

bot.action(/^adm_grant_(m|e)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal'; const targetId = parseInt(ctx.match[2]);
  type==='monthly' ? db.updateUserPremium(targetId,'monthly',Math.floor(Date.now()/1000)+30*24*3600) : db.updateUserPremium(targetId,'eternal',null);
  try { await bot.telegram.sendMessage(targetId, `🎉 Администратор выдал тебе *Premium ${type==='eternal'?'Eternal':'Monthly'}*!`, { parse_mode:'Markdown' }); } catch {}
  await ctx.editMessageText(`✅ Premium ${type} выдан ${targetId}.`, kb.adminKeyboard());
});

bot.action(/^adm_revoke_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  db.updateUserPremium(parseInt(ctx.match[1]),'free',null);
  try { await bot.telegram.sendMessage(parseInt(ctx.match[1]),'❌ Администратор отозвал твой Premium.'); } catch {}
  await ctx.editMessageText(`✅ Premium отозван.`, kb.adminKeyboard());
});

bot.action('adm_payments', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const pending = db.getPendingPayments();
  if (!pending.length) return ctx.editMessageText('💰 Нет ожидающих заявок.', kb.adminKeyboard());
  let text = `💰 *Ожидают подтверждения (${pending.length}):*\n\n`;
  for (const p of pending) text += `• #${p.id} | ${p.telegram_id} @${p.username||'—'} | ${p.payment_type} | ${p.method} | ${p.amount||'?'}\n`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

// ── Промокоды (админ) ─────────────────────────────────────────────────────────
bot.action('adm_promos', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const promos = db.getAllPromocodes();
  let text = '🎁 *Промокоды:*\n\n';
  if (!promos.length) {
    text += '_Нет промокодов_';
  } else {
    for (const p of promos) {
      const exp = p.expires_at ? new Date(p.expires_at*1000).toLocaleDateString('ru-RU') : '∞';
      text += `\`${p.code}\` — ${p.days} дн, ${p.used_count}/${p.max_uses} исп., до ${exp}\n`;
    }
  }
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Создать промокод', 'adm_promo_create')],
      [Markup.button.callback('🗑 Удалить промокод', 'adm_promo_delete')],
      [Markup.button.callback('◀️ Назад', 'adm_back')],
    ])
  });
});

bot.action('adm_promo_create', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_promo_create' });
  await ctx.editMessageText(
    '➕ *Создать промокод*\n\nВведи в формате:\n`КОД ДНИ [МАКС_ИСПОЛЬЗОВАНИЙ]`\n\nПример:\n`SUMMER7 7 100` — код SUMMER7, 7 дней, до 100 раз',
    { parse_mode: 'Markdown', ...kb.cancelKeyboard('adm_promos') }
  );
});

bot.action('adm_promo_delete', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_promo_delete' });
  await ctx.editMessageText('🗑 Введи код промокода для удаления:', { ...kb.cancelKeyboard('adm_promos') });
});

// ── Рассылка ───────────────────────────────────────────────────────────────────
bot.action('adm_broadcast', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_broadcast' });
  await ctx.editMessageText('📢 *Рассылка*\n\nВведи текст сообщения:', { parse_mode: 'Markdown', ...kb.cancelKeyboard('adm_cancel') });
});

bot.action('adm_broadcast_confirm', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery('⏳ Отправляю...');
  const { broadcastText } = getState(ctx.from.id);
  clearState(ctx.from.id);
  if (!broadcastText) return ctx.editMessageText('❌ Текст не найден.', kb.adminKeyboard());
  const users = db.getAllUsers();
  let sent = 0;
  await ctx.editMessageText(`⏳ Отправляю ${users.length} пользователям...`);
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.telegram_id, broadcastText, { parse_mode: 'Markdown' }); sent++; } catch {}
    await sleep(50);
  }
  await ctx.editMessageText(`✅ Рассылка завершена: ${sent}/${users.length} доставлено.`, kb.adminKeyboard());
});

bot.action('adm_back', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  await ctx.editMessageText('🔧 *Панель администратора*', { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_cancel', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  await ctx.editMessageText('🔧 *Панель администратора*', { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

// ── Help ───────────────────────────────────────────────────────────────────────
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `ℹ️ *Помощь WHMineBot*\n\nБот подключается к Minecraft-серверу и не даёт ему уйти в сон.\n\n🆓 *Бесплатно:* 7 дней, анти-АФК.\n💎 *Premium:* постоянно + WASD, слежка, чат-мост, инвентарь.\n\n🔑 *ОП и Креатив:* выдай боту ОП командой \`/op ник\`, нажми «ОП выдан» — бот войдёт в Creative.\n\n🔄 *Авто-реконнект:* если бот вылетит, он сам переподключится через ${config.AUTO_RECONNECT_MINUTES} мин.\n\n🎁 *Промокод:* введи в разделе «Тарифы».\n\n❓ Вопросы — напиши администратору.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'main')]]) }
  );
});

module.exports = bot;
