const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');
const mc = require('./mcManager');
const kb = require('./keyboards');
const pay = require('./payments');
const { isPremium, isEternal, ensureUser, formatStats } = require('./helpers');

const bot = new Telegraf(config.BOT_TOKEN);

// ─── User state for multi-step flows ─────────────────────────────────────────
const states = new Map();
const getState = (id) => states.get(id) || {};
const setState = (id, patch) => states.set(id, { ...getState(id), ...patch });
const clearState = (id) => states.delete(id);

// ─── MC event handler factory ─────────────────────────────────────────────────
function makeMcEventHandler(telegramId) {
  return async (event, data) => {
    try {
      switch (event) {
        case 'disconnected':
          await bot.telegram.sendMessage(telegramId,
            '🔌 Бот отключился от сервера.',
            kb.mainMenu(false));
          break;
        case 'kicked':
          await bot.telegram.sendMessage(telegramId,
            `⛔ Бот был кикнут с сервера.\n_Причина: ${data}_`,
            { parse_mode: 'Markdown', ...kb.mainMenu(false) });
          break;
        case 'death':
          await bot.telegram.sendMessage(telegramId, '💀 Бот умер и возрождается...');
          break;
        case 'error':
          await bot.telegram.sendMessage(telegramId, `⚠️ Ошибка подключения: ${data}`);
          break;
        case 'free_limit':
          await bot.telegram.sendMessage(telegramId,
            '⏰ *72 часа вышли!*\n\nБот отключён. Подключи снова или оформи Premium.',
            { parse_mode: 'Markdown', ...kb.mainMenu(false) });
          break;
        case 'op_granted':
          await bot.telegram.sendMessage(telegramId,
            '👑 Обнаружены права оператора! Нажми «ОП выдан» в панели управления, чтобы войти в креатив.',
            kb.mainMenu(true));
          break;
        case 'chat':
          await bot.telegram.sendMessage(telegramId,
            `💬 *[MC]* <${data.playerName}> ${data.message}`,
            { parse_mode: 'Markdown' });
          break;
      }
    } catch { /* user may have blocked bot */ }
  };
}

// ─── Middleware ───────────────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from) ensureUser(ctx);
  return next();
});

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const user = db.getUser(ctx.from.id);
  const hasBot = !!mc.getActiveBot(ctx.from.id);
  await ctx.reply(
    `👋 *Привет!*\n\nЯ *WHMineBot* — держу твой Minecraft-сервер живым 24/7.\n\nБесплатный тариф: бот сидит на сервере *72 часа*.\nPremium: бот сидит *всегда* + управление движением, чат-мост и многое другое.\n\nВыбери действие:`,
    { parse_mode: 'Markdown', ...kb.mainMenu(hasBot) }
  );
});

// ─── /admin ───────────────────────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply('❌ Нет доступа.');
  await ctx.reply('🔧 *Панель администратора*', { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

// ═════════════════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═════════════════════════════════════════════════════════════════════════════
bot.action('main', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  const hasBot = !!mc.getActiveBot(ctx.from.id);
  await ctx.editMessageText('🏠 *Главное меню*', { parse_mode: 'Markdown', ...kb.mainMenu(hasBot) });
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ═════════════════════════════════════════════════════════════════════════════
//  CONNECT FLOW
// ═════════════════════════════════════════════════════════════════════════════
bot.action('connect', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'host' });
  await ctx.editMessageText(
    '🌐 *Шаг 1/3 — IP сервера*\n\nВведи IP-адрес или домен сервера:\n_(например: `mc.hypixel.net` или `192.168.1.1`)_',
    { parse_mode: 'Markdown', ...kb.cancelKeyboard('main') }
  );
});

// ─── Text input handler ───────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return; // ignore commands

  // ── Connect: host ──
  if (state.step === 'host') {
    setState(userId, { step: 'port', host: text });
    return ctx.reply(
      `✅ Сервер: \`${text}\`\n\n*Шаг 2/3 — Порт*\n\nВведи порт или используй стандартный:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
        [Markup.button.callback('25565 (по умолчанию)', 'port_default')],
        [Markup.button.callback('❌ Отмена', 'main')],
      ]) }
    );
  }

  // ── Connect: port ──
  if (state.step === 'port') {
    const port = parseInt(text);
    if (isNaN(port) || port < 1 || port > 65535) {
      return ctx.reply('❌ Неверный порт (1–65535). Попробуй снова:');
    }
    setState(userId, { step: 'version', port });
    return ctx.reply('📦 *Шаг 3/3 — Версия*\n\nВыбери версию Minecraft:', { parse_mode: 'Markdown', ...kb.versionKeyboard(0) });
  }

  // ── Follow player ──
  if (state.step === 'follow') {
    clearState(userId);
    const ok = await mc.followPlayer(userId, text);
    const stats = mc.getBotStats(userId);
    return ctx.reply(
      ok ? `✅ Следую за игроком \`${text}\`` : '❌ Не удалось — pathfinder недоступен или игрок не найден.',
      { parse_mode: 'Markdown', ...kb.movementKeyboard(ok ? text : null) }
    );
  }

  // ── Chat to MC ──
  if (state.step === 'chat_mc') {
    clearState(userId);
    const ok = mc.sendChatToMC(userId, text);
    return ctx.reply(ok ? `✅ Отправлено в чат: _${text}_` : '❌ Бот не подключён.', { parse_mode: 'Markdown' });
  }

  // ── Admin: broadcast ──
  if (state.step === 'adm_broadcast' && userId === config.ADMIN_ID) {
    clearState(userId);
    const users = db.getAllUsers();
    let sent = 0;
    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.telegram_id,
          `📢 *Сообщение от администратора:*\n\n${text}`,
          { parse_mode: 'Markdown' });
        sent++;
      } catch {}
      await sleep(50);
    }
    return ctx.reply(`✅ Рассылка завершена: ${sent}/${users.length} доставлено.`, kb.adminKeyboard());
  }

  // ── Admin: grant user ID ──
  if (state.step === 'adm_grant_id' && userId === config.ADMIN_ID) {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply('❌ Неверный ID. Введи числовой Telegram ID:');
    const target = db.getUser(targetId);
    if (!target) return ctx.reply(`❌ Пользователь ${targetId} не найден в базе.`);
    clearState(userId);
    return ctx.reply(
      `👤 Пользователь: @${target.username || '—'} (${targetId})\n💎 Тариф: ${target.premium_type}\n\nВыдать:`,
      kb.adminPremiumMenu(targetId)
    );
  }
});

// ─── Port default button ──────────────────────────────────────────────────────
bot.action('port_default', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { ...getState(ctx.from.id), step: 'version', port: 25565 });
  await ctx.editMessageText('📦 *Шаг 3/3 — Версия*\n\nВыбери версию Minecraft:', { parse_mode: 'Markdown', ...kb.versionKeyboard(0) });
});

// ─── Version pagination ───────────────────────────────────────────────────────
bot.action(/^vp_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(kb.versionKeyboard(parseInt(ctx.match[1])).reply_markup);
});

// ─── Version selected → Connect ───────────────────────────────────────────────
bot.action(/^ver_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const version = ctx.match[1];
  const userId = ctx.from.id;
  const state = getState(userId);
  if (state.step !== 'version') return;
  clearState(userId);

  const { host, port } = state;
  const user = db.getUser(userId);

  await ctx.editMessageText(
    `⏳ Подключаюсь...\n\n🌐 \`${host}:${port}\`\n📦 Версия: ${version}`,
    { parse_mode: 'Markdown' }
  );

  const botNumber = db.getNextBotNumber();
  const botId = db.createBot(user.id, botNumber, host, port, version);

  try {
    await mc.connectBot(userId, host, port, version, botId, makeMcEventHandler(userId));
    const stats = mc.getBotStats(userId);
    if (stats) {
      await ctx.editMessageText(formatStats(stats, user), {
        parse_mode: 'Markdown',
        ...kb.panelKeyboard(stats, isPremium(user)),
      });
    } else {
      await ctx.editMessageText('✅ Бот подключён!', kb.mainMenu(true));
    }
  } catch (e) {
    db.updateBotStatus(botId, 'disconnected');
    await ctx.editMessageText(
      `❌ *Ошибка подключения*\n\n\`${e.message}\`\n\nПроверь IP/порт/версию.`,
      { parse_mode: 'Markdown', ...kb.mainMenu(false) }
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  PANEL
// ═════════════════════════════════════════════════════════════════════════════
bot.action('panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const user = db.getUser(userId);

  if (!mc.getActiveBot(userId)) {
    return ctx.editMessageText('❌ Бот не подключён.', kb.mainMenu(false));
  }

  const stats = mc.getBotStats(userId);
  if (!stats) return ctx.editMessageText('❌ Нет данных.', kb.mainMenu(false));

  await ctx.editMessageText(formatStats(stats, user), {
    parse_mode: 'Markdown',
    ...kb.panelKeyboard(stats, isPremium(user)),
  });
});

// ─── Anti-AFK toggle ─────────────────────────────────────────────────────────
bot.action('toggle_afk', async (ctx) => {
  const result = mc.toggleAntiAfk(ctx.from.id);
  await ctx.answerCbQuery(result === null ? '❌ Бот не подключён' : result ? '🟢 Анти-АФК включён' : '🔴 Анти-АФК выключен');
  if (result !== null) {
    const user = db.getUser(ctx.from.id);
    const stats = mc.getBotStats(ctx.from.id);
    if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
  }
});

// ─── OP flow ──────────────────────────────────────────────────────────────────
bot.action('request_op', async (ctx) => {
  await ctx.answerCbQuery();
  const inst = mc.getActiveBot(ctx.from.id);
  if (!inst) return ctx.answerCbQuery('❌ Бот не подключён', { show_alert: true });

  const botRecord = db.getBotById(inst.botId);
  inst.waitingForOp = true;

  await ctx.editMessageText(
    `🔑 *Запрос прав оператора*\n\nЗайди на сервер с правами администратора и выполни команду:\n\n\`/op ${botRecord.mc_username}\`\n\nЗатем нажми кнопку ниже:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ ОП выдан — войти в Креатив', 'op_granted')],
        [Markup.button.callback('◀️ Назад', 'panel')],
      ]),
    }
  );
});

bot.action('op_granted', async (ctx) => {
  await ctx.answerCbQuery('⏳ Применяю...');
  const ok = await mc.setCreative(ctx.from.id);
  await ctx.answerCbQuery(ok ? '✅ Вошёл в Креатив!' : '⚠️ Не удалось — нет ОП?', { show_alert: !ok });
  const user = db.getUser(ctx.from.id);
  const stats = mc.getBotStats(ctx.from.id);
  if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
});

bot.action('op_already', (ctx) => ctx.answerCbQuery('👑 ОП уже есть!'));

// ─── Disconnect ───────────────────────────────────────────────────────────────
bot.action('disconnect', async (ctx) => {
  await ctx.answerCbQuery();
  await mc.disconnectBot(ctx.from.id);
  await ctx.editMessageText('✅ Бот отключён от сервера.', kb.mainMenu(false));
});

// ═════════════════════════════════════════════════════════════════════════════
//  PREMIUM — MOVEMENT
// ═════════════════════════════════════════════════════════════════════════════
bot.action('movement', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Только для Premium!', { show_alert: true });
  if (!mc.getActiveBot(ctx.from.id)) return ctx.answerCbQuery('❌ Бот не подключён', { show_alert: true });

  const stats = mc.getBotStats(ctx.from.id);
  await ctx.editMessageText('🕹️ *Управление движением*\n\nНажимай стрелки — каждое нажатие двигает бота на 1 блок:', {
    parse_mode: 'Markdown',
    ...kb.movementKeyboard(stats?.followTarget || null),
  });
});

const dirMap = { mv_forward: 'forward', mv_back: 'back', mv_left: 'left', mv_right: 'right', mv_jump: 'jump', mv_sneak: 'sneak' };
const dirEmoji = { forward: '⬆️', back: '⬇️', left: '⬅️', right: '➡️', jump: '⎵', sneak: '⇧' };

for (const [action, dir] of Object.entries(dirMap)) {
  bot.action(action, async (ctx) => {
    const user = db.getUser(ctx.from.id);
    if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
    mc.moveBot(ctx.from.id, dir);
    await ctx.answerCbQuery(`${dirEmoji[dir]} Двигаюсь: ${dir}`);
  });
}

bot.action('mv_stop', async (ctx) => {
  const inst = mc.getActiveBot(ctx.from.id);
  if (inst?.bot) {
    for (const d of ['forward', 'back', 'left', 'right']) {
      try { inst.bot.setControlState(d, false); } catch {}
    }
  }
  await ctx.answerCbQuery('⏹ Остановлен');
});

bot.action('follow_player', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  setState(ctx.from.id, { step: 'follow' });
  await ctx.reply('👤 Введи ник игрока для слежки:');
});

bot.action('stop_follow', async (ctx) => {
  mc.stopFollow(ctx.from.id);
  await ctx.answerCbQuery('🛑 Слежка остановлена');
  const stats = mc.getBotStats(ctx.from.id);
  await ctx.editMessageReplyMarkup(kb.movementKeyboard(null).reply_markup);
});

// ─── Action log ───────────────────────────────────────────────────────────────
bot.action('action_log', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });

  const log = mc.getActionLog(ctx.from.id);
  const text = log.length ? log.slice(0, 25).join('\n') : '(лог пуст)';

  await ctx.editMessageText(
    `📜 *Лог действий бота:*\n\n\`\`\`\n${text}\n\`\`\``,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад в панель', 'panel')]]) }
  );
});

// ─── Chat bridge toggle ───────────────────────────────────────────────────────
bot.action('toggle_chat', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });

  const enabled = mc.toggleChatBridge(ctx.from.id);
  await ctx.answerCbQuery(enabled ? '💬 Чат-мост включён' : '💬 Чат-мост выключен');
  const stats = mc.getBotStats(ctx.from.id);
  if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode: 'Markdown', ...kb.panelKeyboard(stats, isPremium(user)) });
});

// ═════════════════════════════════════════════════════════════════════════════
//  TARIFF
// ═════════════════════════════════════════════════════════════════════════════
bot.action('tariff', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  const prem = isPremium(user);
  const eternal = isEternal(user);

  let text = '💎 *Тарифы WHMineBot*\n\n';
  text += `🆓 *Бесплатный*\n• Бот на сервере до 72 часов\n• Анти-АФК\n• Базовая панель\n\n`;
  text += `📅 *Premium Monthly — 29 ⭐ / мес*\n• Постоянное подключение\n• Управление движением (WASD+прыжок+шифт)\n• Слежка за игроком\n• Чат-мост TG ↔ Minecraft\n• Лог действий\n\n`;
  text += `💎 *Premium Eternal — 89 ⭐ (навсегда)*\n• Всё из Monthly\n• Оплата один раз\n• Апгрейд с Monthly доступен\n\n`;

  if (eternal) {
    text += '✅ *У тебя вечный Premium!*';
  } else if (prem) {
    const exp = new Date(user.premium_expires * 1000).toLocaleDateString('ru-RU');
    text += `✅ *Твой Premium активен до ${exp}*`;
  } else {
    text += '📌 Оплата: Telegram Stars, CryptoBot (USDT) или карта (BY)';
  }

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.tariffKeyboard(prem, eternal) });
});

// ── Telegram Stars ────────────────────────────────────────────────────────────
bot.action('buy_monthly_stars', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title: '⭐ Premium Monthly — WHMineBot',
    description: 'Бот на сервере всегда + управление движением, чат-мост, лог. На 30 дней.',
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

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload;
  const userId = ctx.from.id;

  if (payload.startsWith('monthly_')) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    db.updateUserPremium(userId, 'monthly', exp);
    await ctx.reply('🎉 *Premium Monthly активирован!*\nДействует 30 дней. Приятного использования!',
      { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) });
  } else if (payload.startsWith('eternal_')) {
    db.updateUserPremium(userId, 'eternal', null);
    await ctx.reply('🎉 *Premium Eternal активирован!*\nТеперь бот твой навсегда. Спасибо!',
      { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) });
  }
});

// ── CryptoBot ────────────────────────────────────────────────────────────────
bot.action('pay_crypto', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.CRYPTOBOT_TOKEN) {
    return ctx.answerCbQuery('❌ CryptoBot не настроен администратором', { show_alert: true });
  }
  await ctx.editMessageText(
    `🤖 *Оплата через CryptoBot*\n\nPayment in USDT:\n• Monthly — $${config.CRYPTO_MONTHLY_USD}\n• Eternal — $${config.CRYPTO_ETERNAL_USD}`,
    { parse_mode: 'Markdown', ...kb.cryptoKeyboard() }
  );
});

bot.action('crypto_monthly', async (ctx) => {
  await ctx.answerCbQuery('⏳ Создаю счёт...');
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'monthly', 'crypto', config.CRYPTO_MONTHLY_USD);
  const invoice = await pay.createInvoice(config.CRYPTO_MONTHLY_USD, 'WHMineBot Premium Monthly', `m_${pid}`);

  if (!invoice) return ctx.answerCbQuery('❌ Ошибка создания счёта', { show_alert: true });

  await ctx.editMessageText(
    `💰 *Счёт создан*\n\nСумма: ${config.CRYPTO_MONTHLY_USD} USDT\nТариф: Premium Monthly`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💳 Оплатить в CryptoBot', invoice.pay_url)],
        [Markup.button.callback('✅ Я оплатил — проверить', `chk_${invoice.invoice_id}_${pid}_monthly`)],
        [Markup.button.callback('◀️ Назад', 'tariff')],
      ]),
    }
  );
});

bot.action('crypto_eternal', async (ctx) => {
  await ctx.answerCbQuery('⏳ Создаю счёт...');
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'eternal', 'crypto', config.CRYPTO_ETERNAL_USD);
  const invoice = await pay.createInvoice(config.CRYPTO_ETERNAL_USD, 'WHMineBot Premium Eternal', `e_${pid}`);

  if (!invoice) return ctx.answerCbQuery('❌ Ошибка создания счёта', { show_alert: true });

  await ctx.editMessageText(
    `💰 *Счёт создан*\n\nСумма: ${config.CRYPTO_ETERNAL_USD} USDT\nТариф: Premium Eternal`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💳 Оплатить в CryptoBot', invoice.pay_url)],
        [Markup.button.callback('✅ Я оплатил — проверить', `chk_${invoice.invoice_id}_${pid}_eternal`)],
        [Markup.button.callback('◀️ Назад', 'tariff')],
      ]),
    }
  );
});

bot.action(/^chk_(\d+)_(\d+)_(monthly|eternal)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Проверяю...');
  const [, invoiceId, pid, type] = ctx.match;
  const invoice = await pay.checkInvoice(invoiceId);

  if (invoice?.status === 'paid') {
    db.updatePayment(pid, 'completed');
    if (type === 'monthly') {
      db.updateUserPremium(ctx.from.id, 'monthly', Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
    } else {
      db.updateUserPremium(ctx.from.id, 'eternal', null);
    }
    await ctx.editMessageText(
      `🎉 *Оплата подтверждена!*\n\nPremium ${type === 'eternal' ? 'Eternal' : 'Monthly'} активирован.`,
      { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(ctx.from.id)) }
    );
  } else {
    await ctx.answerCbQuery('❌ Оплата не найдена. Попробуй чуть позже.', { show_alert: true });
  }
});

// ── Card payment (BY) ─────────────────────────────────────────────────────────
bot.action('pay_card', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.CARD_NUMBER) {
    return ctx.answerCbQuery('❌ Оплата картой не настроена', { show_alert: true });
  }

  await ctx.editMessageText(
    `💳 *Оплата картой (Беларусь)*\n\n` +
    `Реквизиты для перевода:\n\`${config.CARD_NUMBER}\`\n` +
    `Получатель: ${config.CARD_HOLDER || '—'}\n\n` +
    `Тарифы:\n• Monthly — ${config.CARD_MONTHLY_PRICE}\n• Eternal — ${config.CARD_ETERNAL_PRICE}\n\n` +
    `📝 *В комментарии к переводу обязательно укажи свой ID:* \`${ctx.from.id}\`\n\n` +
    `После оплаты нажми кнопку — администратор проверит и активирует Premium:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Оплатил Monthly', `card_m_${ctx.from.id}`), Markup.button.callback('💎 Оплатил Eternal', `card_e_${ctx.from.id}`)],
        [Markup.button.callback('◀️ Назад', 'tariff')],
      ]),
    }
  );
});

bot.action(/^card_(m|e)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const type = ctx.match[1] === 'm' ? 'monthly' : 'eternal';
  const userId = parseInt(ctx.match[2]);
  const user = db.getUser(userId);
  const pid = db.createPayment(user.id, userId, type, 'card', type === 'monthly' ? config.CARD_MONTHLY_PRICE : config.CARD_ETERNAL_PRICE);

  // Notify admin
  try {
    await bot.telegram.sendMessage(config.ADMIN_ID,
      `💳 *Новая заявка на оплату картой!*\n\n` +
      `👤 @${ctx.from.username || ctx.from.first_name} (${userId})\n` +
      `📦 Тариф: ${type === 'monthly' ? 'Monthly' : 'Eternal'}\n` +
      `🆔 Заявка #${pid}`,
      { parse_mode: 'Markdown', ...kb.cardApproveKeyboard(userId, pid) }
    );
  } catch {}

  await ctx.editMessageText(
    '✅ *Заявка отправлена!*\n\nАдминистратор проверит перевод и активирует Premium. Обычно это занимает до нескольких часов.',
    { parse_mode: 'Markdown', ...kb.mainMenu(!!mc.getActiveBot(userId)) }
  );
});

// Admin: approve/reject card payments
bot.action(/^adm_card_(m|e)_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌ Нет доступа');
  await ctx.answerCbQuery();
  const type = ctx.match[1] === 'm' ? 'monthly' : 'eternal';
  const targetId = parseInt(ctx.match[2]);
  const pid = ctx.match[3];

  if (type === 'monthly') {
    db.updateUserPremium(targetId, 'monthly', Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  } else {
    db.updateUserPremium(targetId, 'eternal', null);
  }
  db.updatePayment(pid, 'completed');

  try {
    await bot.telegram.sendMessage(targetId,
      `🎉 *Premium ${type === 'eternal' ? 'Eternal' : 'Monthly'} активирован!*\nОплата подтверждена администратором.`,
      { parse_mode: 'Markdown' });
  } catch {}

  await ctx.editMessageText(`✅ Premium ${type} выдан пользователю ${targetId}.`);
});

bot.action(/^adm_card_rej_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌ Нет доступа');
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  const pid = ctx.match[2];
  db.updatePayment(pid, 'rejected');

  try {
    await bot.telegram.sendMessage(targetId, '❌ Оплата картой не подтверждена. Напиши администратору для уточнения.');
  } catch {}

  await ctx.editMessageText(`❌ Заявка #${pid} отклонена.`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN PANEL
// ═════════════════════════════════════════════════════════════════════════════
bot.action('adm_bots', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();

  const bots = mc.getAllActiveBots();
  if (!bots.length) {
    return ctx.editMessageText('🤖 Нет активных ботов.', kb.adminKeyboard());
  }

  let text = `🤖 *Активные боты (${bots.length}):*\n\n`;
  for (const inst of bots) {
    const s = mc.getBotStats(inst.userId);
    if (s) {
      text += `• \`${s.username}\` → \`${s.server}\` | ❤️${s.health} 🍗${s.food} ⏱${s.uptimeH}ч${s.uptimeM}м\n`;
    }
  }

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_users', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();

  const users = db.getAllUsers();
  const planIcon = (u) => u.premium_type === 'eternal' ? '💎' : u.premium_type === 'monthly' ? '📅' : '🆓';

  let text = `👥 *Пользователи (${users.length}):*\n\n`;
  for (const u of users.slice(0, 30)) {
    text += `${planIcon(u)} ${u.telegram_id} @${u.username || '—'}\n`;
  }
  if (users.length > 30) text += `\n...и ещё ${users.length - 30}`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_premium', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_grant_id' });
  await ctx.editMessageText(
    '💎 *Управление Premium*\n\nВведи Telegram ID пользователя:',
    { parse_mode: 'Markdown', ...kb.cancelKeyboard('adm_cancel') }
  );
});

bot.action(/^adm_grant_(m|e)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const type = ctx.match[1] === 'm' ? 'monthly' : 'eternal';
  const targetId = parseInt(ctx.match[2]);

  if (type === 'monthly') {
    db.updateUserPremium(targetId, 'monthly', Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  } else {
    db.updateUserPremium(targetId, 'eternal', null);
  }
  try { await bot.telegram.sendMessage(targetId, `🎉 Администратор выдал тебе *Premium ${type === 'eternal' ? 'Eternal' : 'Monthly'}*!`, { parse_mode: 'Markdown' }); } catch {}
  await ctx.editMessageText(`✅ Premium ${type} выдан пользователю ${targetId}.`, kb.adminKeyboard());
});

bot.action(/^adm_revoke_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  db.updateUserPremium(targetId, 'free', null);
  try { await bot.telegram.sendMessage(targetId, '❌ Администратор отозвал твой Premium.'); } catch {}
  await ctx.editMessageText(`✅ Premium отозван у пользователя ${targetId}.`, kb.adminKeyboard());
});

bot.action('adm_payments', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();

  const pending = db.getPendingPayments();
  if (!pending.length) return ctx.editMessageText('💰 Нет ожидающих заявок.', kb.adminKeyboard());

  let text = `💰 *Ожидают подтверждения (${pending.length}):*\n\n`;
  for (const p of pending) {
    text += `• #${p.id} | ${p.telegram_id} @${p.username || '—'} | ${p.payment_type} | ${p.method} | ${p.amount || '?'}\n`;
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_broadcast', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'adm_broadcast' });
  await ctx.editMessageText('📢 *Рассылка*\n\nВведи текст сообщения:', { parse_mode: 'Markdown', ...kb.cancelKeyboard('adm_cancel') });
});

bot.action('adm_cancel', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  await ctx.editMessageText('🔧 *Панель администратора*', { parse_mode: 'Markdown', ...kb.adminKeyboard() });
});

// ═════════════════════════════════════════════════════════════════════════════
//  HELP
// ═════════════════════════════════════════════════════════════════════════════
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `ℹ️ *Помощь WHMineBot*\n\n` +
    `Бот подключается к твоему Minecraft-серверу и находится там, не давая серверу уйти в сон.\n\n` +
    `🆓 *Бесплатно:* 72 часа, анти-АФК, базовая панель.\n\n` +
    `💎 *Premium:* бот сидит постоянно, плюс:\n• Управление движением (WASD)\n• Слежка за игроком\n• Чат-мост Telegram ↔ Minecraft\n• Лог всех действий\n\n` +
    `🔑 *ОП и Креатив:* попроси выдать ОП боту, затем нажми «ОП выдан» — бот войдёт в Creative и не будет голодать.\n\n` +
    `❓ Вопросы — напиши администратору.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'main')]]) }
  );
});

// ─── Helper ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = bot;
