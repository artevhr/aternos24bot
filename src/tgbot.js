const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');
const mc = require('./mcManager');
const kb = require('./keyboards');
const pay = require('./payments');
const { isPremium, isEternal, isMonthly, ensureUser, getSettings, formatStats } = require('./helpers');

const bot = new Telegraf(config.BOT_TOKEN);
const states = new Map();
const getState  = id => states.get(id) || {};
const setState  = (id, p) => states.set(id, { ...getState(id), ...p });
const clearState = id => states.delete(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Channel subscription check ──────────────────────────────────────────────
async function checkSubscription(userId) {
  if (!config.REQUIRED_CHANNEL) return true;
  try {
    const member = await bot.telegram.getChatMember(config.REQUIRED_CHANNEL, userId);
    return ['member','administrator','creator'].includes(member.status);
  } catch { return false; }
}

const subKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.url('📢 Подписаться на канал', `https://t.me/${config.REQUIRED_CHANNEL.replace('@','')}`)] ,
    [Markup.button.callback('✅ Я подписался', 'check_sub')],
  ]);

// ─── MC event handler ─────────────────────────────────────────────────────────
function makeMcEventHandler(telegramId) {
  return async (event, data) => {
    try {
      switch (event) {
        case 'disconnected':
          await bot.telegram.sendMessage(telegramId, '🔌 Бот отключился от сервера.'); break;
        case 'reconnecting':
          await bot.telegram.sendMessage(telegramId, `🔄 Авто-реконнект через *${data} мин*...`, { parse_mode:'Markdown' }); break;
        case 'reconnected':
          await bot.telegram.sendMessage(telegramId, '✅ Бот снова подключён!'); break;
        case 'reconnect_failed':
          await bot.telegram.sendMessage(telegramId, `❌ Реконнект не удался:\n${data}`); break;
        case 'kicked':
          await bot.telegram.sendMessage(telegramId, `⛔ Бот кикнут: _${data}_`, { parse_mode:'Markdown' }); break;
        case 'death':
          await bot.telegram.sendMessage(telegramId, '💀 Бот умер и возрождается...'); break;
        case 'error':
          await bot.telegram.sendMessage(telegramId, `⚠️ ${data}`); break;
        case 'free_limit':
          await bot.telegram.sendMessage(telegramId, '⏰ *7 дней вышли!*\n\nБот отключён. Подключи снова или купи Premium.', { parse_mode:'Markdown' }); break;
        case 'op_granted':
          await bot.telegram.sendMessage(telegramId, '👑 Обнаружены права ОП! Открой панель бота и нажми «ОП выдан».'); break;
        case 'chat':
          await bot.telegram.sendMessage(telegramId, `💬 *[MC]* <${data.playerName}> ${data.message}`, { parse_mode:'Markdown' }); break;
      }
    } catch {}
  };
}

// ─── Middleware: ensure user + subscription check ─────────────────────────────
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  ensureUser(ctx);

  // Skip subscription check for admin
  if (ctx.from.id === config.ADMIN_ID) return next();

  // Only check for actual interactions (not just message reads)
  const isInteraction = ctx.callbackQuery || (ctx.message?.text && !ctx.message.text.startsWith('/start'));
  if (!isInteraction) return next();

  if (config.REQUIRED_CHANNEL) {
    const subscribed = await checkSubscription(ctx.from.id);
    if (!subscribed) {
      const text = `🔒 *Доступ закрыт*\n\nДля использования WHMineBot необходима подписка на наш канал.`;
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('❌ Подпишись на канал!', { show_alert: true });
        await ctx.reply(text, { parse_mode:'Markdown', ...subKeyboard() });
      } else {
        await ctx.reply(text, { parse_mode:'Markdown', ...subKeyboard() });
      }
      return;
    }
  }
  return next();
});

// ─── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  if (config.REQUIRED_CHANNEL) {
    const subscribed = await checkSubscription(ctx.from.id);
    if (!subscribed) {
      return ctx.reply('🔒 *Для использования бота нужна подписка на наш канал:*', { parse_mode:'Markdown', ...subKeyboard() });
    }
  }
  const bots = mc.getActiveBotsForUser(ctx.from.id);
  await ctx.reply(
    `👋 *Привет!*\n\nЯ *WHMineBot* — держу твой Minecraft-сервер живым 24/7.\n\n🆓 Бесплатно: 1 бот, до 7 дней\n💎 Premium: несколько ботов, всегда онлайн + WASD, чат-мост, свой ник`,
    { parse_mode:'Markdown', ...kb.mainMenu(bots.length) }
  );
});

bot.action('check_sub', async (ctx) => {
  await ctx.answerCbQuery();
  const ok = await checkSubscription(ctx.from.id);
  if (ok) {
    const bots = mc.getActiveBotsForUser(ctx.from.id);
    await ctx.editMessageText('✅ *Подписка подтверждена!* Добро пожаловать.', { parse_mode:'Markdown', ...kb.mainMenu(bots.length) });
  } else {
    await ctx.answerCbQuery('❌ Ты ещё не подписался!', { show_alert: true });
  }
});

// ─── /admin ────────────────────────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply('❌ Нет доступа.');
  await ctx.reply('🔧 *Панель администратора*', { parse_mode:'Markdown', ...kb.adminKeyboard() });
});

// ─── /mc command ──────────────────────────────────────────────────────────────
bot.command('mc', async (ctx) => {
  const text = ctx.message.text.replace('/mc', '').trim();
  if (!text) return ctx.reply('Использование: /mc (текст)\n\nОтправляет сообщение в чат Minecraft-сервера.');
  const inst = mc.getActiveBot(ctx.from.id);
  if (!inst) return ctx.reply('❌ Нет активного бота.');
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.reply('⚠️ Чат-мост — только для Premium.');
  const ok = mc.sendChatToMC(inst.botId, text);
  await ctx.reply(ok ? `✅ Отправлено: _${text}_` : '❌ Ошибка.', { parse_mode:'Markdown' });
});

// ─── Main navigation ─────────────────────────────────────────────────────────
bot.action('main', async (ctx) => {
  await ctx.answerCbQuery(); clearState(ctx.from.id);
  const bots = mc.getActiveBotsForUser(ctx.from.id);
  await ctx.editMessageText('🏠 *Главное меню*', { parse_mode:'Markdown', ...kb.mainMenu(bots.length) });
});
bot.action('noop', ctx => ctx.answerCbQuery());

// ─── My bots list ─────────────────────────────────────────────────────────────
bot.action('my_bots', async (ctx) => {
  await ctx.answerCbQuery();
  const bots = mc.getActiveBotsForUser(ctx.from.id);
  if (!bots.length) return ctx.editMessageText('❌ Нет активных ботов.', kb.mainMenu(0));
  if (bots.length === 1) {
    // Сразу в панель если один бот
    const stats = mc.getBotStats(bots[0].botId);
    const user = db.getUser(ctx.from.id);
    if (!stats) return ctx.editMessageText('❌ Нет данных.', kb.mainMenu(0));
    return ctx.editMessageText(formatStats(stats, user), { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), bots[0].botId) });
  }
  await ctx.editMessageText(`🤖 *Твои боты (${bots.length}):*\n\nВыбери бота для управления:`, { parse_mode:'Markdown', ...kb.botListKeyboard(bots) });
});

// ─── Bot panel (by botId) ─────────────────────────────────────────────────────
bot.action(/^bot_panel_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst || inst.userId !== ctx.from.id) return ctx.editMessageText('❌ Бот недоступен.', kb.mainMenu(0));
  const stats = mc.getBotStats(botId);
  const user = db.getUser(ctx.from.id);
  if (!stats) return ctx.editMessageText('❌ Нет данных.', kb.mainMenu(0));
  await ctx.editMessageText(formatStats(stats, user), { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) });
});

// ─── Toggle AFK ───────────────────────────────────────────────────────────────
bot.action(/^toggle_afk_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  const result = mc.toggleAntiAfk(botId);
  await ctx.answerCbQuery(result === null ? '❌' : result ? '🟢 Анти-АФК: ВКЛ' : '🔴 Анти-АФК: ВЫКЛ');
  if (result !== null) {
    const stats = mc.getBotStats(botId); const user = db.getUser(ctx.from.id);
    if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) });
  }
});

// ─── OP flow ──────────────────────────────────────────────────────────────────
bot.action(/^request_op_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst) return;
  const rec = db.getBotById(botId);
  inst.waitingForOp = true;
  await ctx.editMessageText(
    `🔑 *Запрос ОП*\n\nВведи на сервере:\n\`/op ${rec.mc_username}\`\n\nЗатем нажми:`,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ ОП выдан — Войти в Креатив', `op_granted_${botId}`)],[Markup.button.callback('◀️ Назад', `bot_panel_${botId}`)]])}
  );
});
bot.action(/^op_granted_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  await ctx.answerCbQuery('⏳...');
  const ok = await mc.setCreative(botId);
  await ctx.answerCbQuery(ok ? '✅ Креатив!' : '⚠️ Нет ОП?', { show_alert: !ok });
  const stats = mc.getBotStats(botId); const user = db.getUser(ctx.from.id);
  if (stats) await ctx.editMessageText(formatStats(stats, user), { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) });
});
bot.action(/^op_already_(\d+)$/, ctx => ctx.answerCbQuery('👑 ОП уже есть!'));

// ─── Disconnect ────────────────────────────────────────────────────────────────
bot.action(/^disconnect_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  await mc.disconnectBotById(botId);
  const bots = mc.getActiveBotsForUser(ctx.from.id);
  await ctx.editMessageText('✅ Бот отключён.', kb.mainMenu(bots.length));
});

// ─── Inventory ────────────────────────────────────────────────────────────────
bot.action(/^inventory_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  const items = mc.getInventory(botId);
  if (items === null) return ctx.answerCbQuery('❌ Недоступно', { show_alert: true });
  let text = '🎒 *Инвентарь бота:*\n\n';
  const entries = Object.entries(items);
  text += entries.length ? entries.map(([n,c]) => `• ${n} × ${c}`).join('\n') : '_Пусто_';
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить',`inventory_${botId}`), Markup.button.callback('◀️ Назад',`bot_panel_${botId}`)]])} );
});

// ─── Chat bridge with pagination ──────────────────────────────────────────────
bot.action(/^chatbridge_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  await showChatBridge(ctx, botId, 0, true);
});
bot.action(/^chat_page_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  await showChatBridge(ctx, botId, page, false);
});
bot.action(/^toggle_chat_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  const enabled = mc.toggleChatBridge(botId);
  await ctx.answerCbQuery(enabled ? '💬 Чат-мост ВКЛ' : '💬 Чат-мост ВЫКЛ');
  await showChatBridge(ctx, botId, 0, false);
});

async function showChatBridge(ctx, botId, page, edit) {
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst) return;
  const PER_PAGE = 10;
  const log = mc.getChatLog(botId);
  const totalPages = Math.max(1, Math.ceil(log.length / PER_PAGE));
  const slice = log.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  let text = `💬 *Чат сервера* (стр. ${page+1}/${totalPages})\n`;
  text += `Мост: ${inst.chatBridgeEnabled ? '🟢 ВКЛ' : '🔴 ВЫКЛ'}\n\n`;
  text += slice.length
    ? slice.map(e => `<${e.playerName}> ${e.message}`).join('\n')
    : '_Нет сообщений_\n\n💡 Отправить в MC: /mc (текст)';
  const method = edit ? ctx.editMessageText.bind(ctx) : ctx.editMessageText.bind(ctx);
  try {
    await method(text, { parse_mode:'Markdown', ...kb.chatBridgeKeyboard(botId, page, totalPages, inst.chatBridgeEnabled) });
  } catch {}
}

// ─── Movement ─────────────────────────────────────────────────────────────────
bot.action(/^movement_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = parseInt(ctx.match[1]);
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  const stats = mc.getBotStats(botId);
  await ctx.editMessageText('🕹️ *Управление движением*', { parse_mode:'Markdown', ...kb.movementKeyboard(botId, stats?.followTarget||null) });
});
const DIRS = { forward:'⬆️', back:'⬇️', left:'⬅️', right:'➡️', jump:'⎵', sneak:'⇧' };
for (const dir of Object.keys(DIRS)) {
  bot.action(new RegExp(`^mv_${dir}_(\\d+)$`), async (ctx) => {
    if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium!', { show_alert: true });
    mc.moveBot(parseInt(ctx.match[1]), dir);
    await ctx.answerCbQuery(`${DIRS[dir]} Двигаюсь`);
  });
}
bot.action(/^mv_stop_(\d+)$/, async (ctx) => {
  const inst = mc.getActiveBotByBotId(parseInt(ctx.match[1]));
  if (inst?.bot) for (const d of ['forward','back','left','right']) try { inst.bot.setControlState(d, false); } catch {}
  await ctx.answerCbQuery('⏹ Остановлен');
});
bot.action(/^follow_player_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium!', { show_alert: true });
  setState(ctx.from.id, { step: 'follow', botId: parseInt(ctx.match[1]) });
  await ctx.reply('👤 Введи ник игрока:');
});
bot.action(/^stop_follow_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  mc.stopFollow(botId);
  await ctx.answerCbQuery('🛑 Слежка остановлена');
  await ctx.editMessageReplyMarkup(kb.movementKeyboard(botId, null).reply_markup);
});
bot.action(/^action_log_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium!', { show_alert: true });
  const botId = parseInt(ctx.match[1]);
  const log = mc.getActionLog(botId).slice(0,25);
  const text = log.length ? log.join('\n') : '(лог пуст)';
  await ctx.editMessageText(`📜 *Лог действий:*\n\n\`\`\`\n${text}\n\`\`\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад',`bot_panel_${botId}`)]])});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CONNECT FLOW
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('connect', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  // Free: max 1 bot, Premium: up to 3 bots
  const activeBots = mc.getActiveBotsForUser(ctx.from.id);
  if (!isPremium(user) && activeBots.length >= 1) return ctx.answerCbQuery('❌ Бесплатный тариф: только 1 бот. Купи Premium!', { show_alert: true });
  if (isPremium(user) && activeBots.length >= 3) return ctx.answerCbQuery('❌ Максимум 3 бота одновременно.', { show_alert: true });
  setState(ctx.from.id, { step: 'host' });
  await ctx.editMessageText('🌐 *Шаг 1/3 — IP сервера*\n\nВведи IP или домен:', { parse_mode:'Markdown', ...kb.cancelKeyboard('main') });
});

bot.action('recent_servers', async (ctx) => {
  await ctx.answerCbQuery();
  const servers = db.getRecentServers(ctx.from.id);
  if (!servers.length) return ctx.editMessageText('🕐 *Недавние серверы*\n\n_Пока пусто. Сначала подключись к серверу._', { parse_mode:'Markdown', ...kb.cancelKeyboard('main') });
  await ctx.editMessageText('🕐 *Недавние серверы:*\n\nВыбери для быстрого подключения:', { parse_mode:'Markdown', ...kb.recentServersKeyboard(servers) });
});

bot.action(/^recent_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const servers = db.getRecentServers(ctx.from.id);
  const server = servers.find(s => s.id == ctx.match[1]);
  if (!server) return ctx.editMessageText('❌ Сервер не найден.', kb.mainMenu(0));
  await doConnect(ctx, server.host, server.port, server.version);
});

bot.action('port_default', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { ...getState(ctx.from.id), step: 'version', port: 25565 });
  await ctx.editMessageText('📦 *Шаг 3/3 — Версия*', { parse_mode:'Markdown', ...kb.versionKeyboard(0) });
});
bot.action(/^vp_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageReplyMarkup(kb.versionKeyboard(parseInt(ctx.match[1])).reply_markup); });
bot.action(/^ver_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (state.step !== 'version') return;
  clearState(ctx.from.id);
  await doConnect(ctx, state.host, state.port, ctx.match[1]);
});

async function doConnect(ctx, host, port, version) {
  const userId = ctx.from.id;
  const user = db.getUser(userId);

  // Determine bot username
  let mcUsername;
  if (isPremium(user) && user.custom_bot_nick) {
    // use custom nick but append number if multiple bots
    const existing = mc.getActiveBotsForUser(userId);
    mcUsername = existing.length > 0 ? `${user.custom_bot_nick}${existing.length+1}` : user.custom_bot_nick;
  }
  // else will be set by createBot default

  await ctx.editMessageText(`⏳ Подключаюсь...\n\n🌐 \`${host}:${port}\`\n📦 Версия: ${version}`, { parse_mode:'Markdown' });

  const botNumber = db.getNextBotNumber();
  const botId = db.createBot(user.id, botNumber, host, port, version, mcUsername);

  try {
    await mc.connectBot(userId, host, port, version, botId, makeMcEventHandler(userId));
    const stats = mc.getBotStats(botId);
    if (stats) {
      await ctx.editMessageText(formatStats(stats, user), { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) });
    } else {
      await ctx.editMessageText('✅ Бот подключён!', kb.mainMenu(1));
    }
  } catch (e) {
    db.updateBotStatus(botId, 'disconnected');
    await ctx.editMessageText(`❌ *Ошибка подключения*\n\n${e.message}`, { parse_mode:'Markdown', ...kb.mainMenu(mc.getActiveBotsForUser(userId).length) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEXT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (state.step === 'host') { setState(userId, { step:'port', host:text }); return ctx.reply(`✅ \`${text}\`\n\n*Шаг 2/3 — Порт:*`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('25565 (стандартный)','port_default')],[Markup.button.callback('❌ Отмена','main')]])}); }
  if (state.step === 'port') {
    const port = parseInt(text);
    if (isNaN(port)||port<1||port>65535) return ctx.reply('❌ Неверный порт:');
    setState(userId, { ...state, step:'version', port });
    return ctx.reply('📦 *Шаг 3/3 — Версия:*', { parse_mode:'Markdown', ...kb.versionKeyboard(0) });
  }
  if (state.step === 'follow') {
    const botId = state.botId; clearState(userId);
    const ok = await mc.followPlayer(botId, text);
    return ctx.reply(ok ? `✅ Следую за \`${text}\`` : '❌ Не удалось.', { parse_mode:'Markdown', ...kb.movementKeyboard(botId, ok?text:null) });
  }
  if (state.step === 'use_promo') { clearState(userId); return handlePromoCode(ctx, text); }
  if (state.step === 'set_custom_nick') {
    clearState(userId);
    if (!isPremium(db.getUser(userId))) return ctx.reply('⚠️ Только для Premium.');
    const nick = text.replace(/[^a-zA-Z0-9_]/g,'').slice(0,16);
    if (nick.length < 3) return ctx.reply('❌ Ник должен быть от 3 символов (только a-z, 0-9, _).');
    db.updateCustomNick(userId, nick);
    return ctx.reply(`✅ Ник бота: \`${nick}\`\n\nПри следующем подключении бот войдёт с этим ником.`, { parse_mode:'Markdown', ...kb.mainMenu(mc.getActiveBotsForUser(userId).length) });
  }
  if (userId !== config.ADMIN_ID) return;
  // ADMIN flows
  if (state.step === 'adm_broadcast') {
    const users = db.getAllUsers();
    setState(userId, { step:'adm_broadcast_confirm', broadcastText: text });
    return ctx.reply(`📢 *Подтверждение*\n\nОтправится *${users.length}* пользователям:\n\n${text}\n\nУверен?`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Да','adm_broadcast_confirm'),Markup.button.callback('❌ Отмена','adm_cancel')]])});
  }
  if (state.step === 'adm_mc_ad') {
    const count = db.countActiveBots();
    setState(userId, { step:'adm_mc_ad_confirm', adText: text });
    return ctx.reply(`📢 *Реклама в Minecraft*\n\nОтправится в чат *${count}* серверов:\n\n_${text}_\n\nУверен?`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Отправить','adm_mc_ad_confirm'),Markup.button.callback('❌ Отмена','adm_cancel')]])});
  }
  if (state.step === 'adm_grant_id') {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply('❌ Неверный ID:');
    const target = db.getUser(targetId);
    if (!target) return ctx.reply(`❌ Пользователь ${targetId} не найден.`);
    clearState(userId);
    return ctx.reply(`👤 @${target.username||'—'} (${targetId})\nТариф: ${target.premium_type}\n\nВыдать:`, kb.adminPremiumMenu(targetId));
  }
  if (state.step === 'adm_promo_create') {
    const parts = text.split(' ');
    if (parts.length < 2) return ctx.reply('❌ Формат: `КОД ДНИ [МАКС_ИСПОЛЬ]`', { parse_mode:'Markdown' });
    const [code, daysStr, maxStr] = parts;
    const days = parseInt(daysStr), maxUses = parseInt(maxStr||'1');
    if (isNaN(days)||days<1) return ctx.reply('❌ Неверные дни.');
    clearState(userId);
    try { db.createPromocode(code.toUpperCase(), days, maxUses, null); return ctx.reply(`✅ Промокод \`${code.toUpperCase()}\`: ${days} дн, ${maxUses} раз.`, { parse_mode:'Markdown', ...kb.adminKeyboard() }); }
    catch (e) { return ctx.reply(`❌ ${e.message}`, kb.adminKeyboard()); }
  }
  if (state.step === 'adm_promo_delete') { clearState(userId); db.deletePromocode(text); return ctx.reply(`✅ \`${text.toUpperCase()}\` удалён.`, { parse_mode:'Markdown', ...kb.adminKeyboard() }); }

  // Settings editing
  const settingSteps = {
    adm_set_monthly_stars:  { key:'price_monthly_stars',  label:'Monthly Stars',  parse:'int' },
    adm_set_eternal_stars:  { key:'price_eternal_stars',  label:'Eternal Stars',  parse:'int' },
    adm_set_upgrade_stars:  { key:'price_upgrade_stars',  label:'Upgrade Stars',  parse:'int' },
    adm_set_crypto_monthly: { key:'crypto_monthly_usd',   label:'Monthly USD',    parse:'str' },
    adm_set_crypto_eternal: { key:'crypto_eternal_usd',   label:'Eternal USD',    parse:'str' },
    adm_set_card_number:    { key:'card_number',          label:'Номер карты',    parse:'str' },
    adm_set_card_holder:    { key:'card_holder',          label:'Имя на карте',   parse:'str' },
    adm_set_card_monthly:   { key:'card_monthly_price',   label:'Monthly BYN',    parse:'str' },
    adm_set_card_eternal:   { key:'card_eternal_price',   label:'Eternal BYN',    parse:'str' },
  };
  if (settingSteps[state.step]) {
    const def = settingSteps[state.step];
    const val = def.parse === 'int' ? parseInt(text) : text;
    if (def.parse === 'int' && isNaN(val)) return ctx.reply('❌ Введи число.');
    clearState(userId);
    db.setSetting(def.key, val);
    return ctx.reply(`✅ ${def.label} = \`${val}\``, { parse_mode:'Markdown', ...kb.adminSettingsKeyboard() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TARIFF
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('tariff', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  const s = getSettings();
  const eternal = isEternal(user), monthly = isMonthly(user);
  let text = '💎 *Тарифы WHMineBot*\n\n';
  text += `🆓 *Бесплатный*\n• 1 бот, до 7 дней\n• Анти-АФК, базовая панель\n\n`;
  text += `📅 *Premium Monthly — ${s.priceMonthlyStars} ⭐ / мес*\n• До 3 ботов одновременно\n• Постоянное подключение\n• Свой ник для бота\n• WASD, слежка, чат-мост, инвентарь\n\n`;
  text += `💎 *Premium Eternal — ${s.priceEternalStars} ⭐ навсегда*\n• Всё из Monthly навсегда\n• Апгрейд с Monthly за ${s.priceUpgradeStars} ⭐\n\n`;
  if (eternal) text += '✅ *У тебя вечный Premium!*';
  else if (monthly) { const exp = new Date(user.premium_expires*1000).toLocaleDateString('ru-RU'); text += `✅ *Monthly активен до ${exp}*`; }
  else text += '📌 Оплата: Stars / CryptoBot (USDT) / Карта BY';
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...kb.tariffKeyboard(user) });
});

// Custom nick
bot.action('set_custom_nick', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPremium(db.getUser(ctx.from.id))) return ctx.answerCbQuery('⚠️ Premium only!', { show_alert: true });
  setState(ctx.from.id, { step: 'set_custom_nick' });
  await ctx.editMessageText('✏️ *Свой ник для бота*\n\nВведи ник (3-16 символов, только a-z, 0-9, _):', { parse_mode:'Markdown', ...kb.cancelKeyboard('tariff') });
});

// Stars payments
bot.action('buy_monthly_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const { priceMonthlyStars } = getSettings();
  await ctx.replyWithInvoice({ title:'⭐ Premium Monthly — WHMineBot', description:'До 3 ботов, постоянно. 30 дней.', payload:`monthly_${ctx.from.id}_${Date.now()}`, currency:'XTR', prices:[{ label:'Premium Monthly', amount: priceMonthlyStars }] });
});
bot.action('buy_eternal_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const { priceEternalStars } = getSettings();
  await ctx.replyWithInvoice({ title:'💎 Premium Eternal — WHMineBot', description:'Все функции навсегда.', payload:`eternal_${ctx.from.id}_${Date.now()}`, currency:'XTR', prices:[{ label:'Premium Eternal', amount: priceEternalStars }] });
});
bot.action('buy_upgrade_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (user?.premium_type !== 'monthly') return ctx.answerCbQuery('❌ Апгрейд только с Monthly', { show_alert: true });
  const { priceUpgradeStars } = getSettings();
  await ctx.replyWithInvoice({ title:'⬆️ Апгрейд Monthly → Eternal', description:'Доплата для перехода на вечный Premium.', payload:`upgrade_${ctx.from.id}_${Date.now()}`, currency:'XTR', prices:[{ label:'Апгрейд', amount: priceUpgradeStars }] });
});
bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true));
bot.on('successful_payment', async (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload;
  const userId = ctx.from.id;
  if (payload.startsWith('monthly_')) { db.updateUserPremium(userId,'monthly',Math.floor(Date.now()/1000)+30*24*3600); await ctx.reply('🎉 *Premium Monthly активирован!*', { parse_mode:'Markdown' }); }
  else if (payload.startsWith('eternal_') || payload.startsWith('upgrade_')) { db.updateUserPremium(userId,'eternal',null); await ctx.reply('🎉 *Premium Eternal активирован!*', { parse_mode:'Markdown' }); }
});

// Crypto
bot.action('pay_crypto', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.CRYPTOBOT_TOKEN) return ctx.answerCbQuery('❌ CryptoBot не настроен', { show_alert: true });
  const { cryptoMonthlyUsd, cryptoEternalUsd } = getSettings();
  await ctx.editMessageText(`🤖 *CryptoBot (USDT)*\n\n• Monthly — $${cryptoMonthlyUsd}\n• Eternal — $${cryptoEternalUsd}`, { parse_mode:'Markdown', ...kb.cryptoKeyboard() });
});
bot.action('crypto_monthly', async (ctx) => {
  await ctx.answerCbQuery('⏳...');
  const { cryptoMonthlyUsd } = getSettings();
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'monthly', 'crypto', cryptoMonthlyUsd);
  const invoice = await pay.createInvoice(cryptoMonthlyUsd, 'WHMineBot Monthly', `m_${pid}`);
  if (!invoice) return ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
  await ctx.editMessageText(`💰 *${cryptoMonthlyUsd} USDT — Monthly*`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('💳 Оплатить', invoice.pay_url)],[Markup.button.callback('✅ Проверить оплату', `chk_${invoice.invoice_id}_${pid}_monthly`)],[Markup.button.callback('◀️ Назад','tariff')]])});
});
bot.action('crypto_eternal', async (ctx) => {
  await ctx.answerCbQuery('⏳...');
  const { cryptoEternalUsd } = getSettings();
  const user = db.getUser(ctx.from.id);
  const pid = db.createPayment(user.id, ctx.from.id, 'eternal', 'crypto', cryptoEternalUsd);
  const invoice = await pay.createInvoice(cryptoEternalUsd, 'WHMineBot Eternal', `e_${pid}`);
  if (!invoice) return ctx.answerCbQuery('❌ Ошибка', { show_alert: true });
  await ctx.editMessageText(`💰 *${cryptoEternalUsd} USDT — Eternal*`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('💳 Оплатить', invoice.pay_url)],[Markup.button.callback('✅ Проверить оплату', `chk_${invoice.invoice_id}_${pid}_eternal`)],[Markup.button.callback('◀️ Назад','tariff')]])});
});
bot.action(/^chk_(\d+)_(\d+)_(monthly|eternal)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳...');
  const [, invoiceId, pid, type] = ctx.match;
  const invoice = await pay.checkInvoice(invoiceId);
  if (invoice?.status === 'paid') {
    db.updatePayment(pid,'completed');
    type==='monthly' ? db.updateUserPremium(ctx.from.id,'monthly',Math.floor(Date.now()/1000)+30*24*3600) : db.updateUserPremium(ctx.from.id,'eternal',null);
    await ctx.editMessageText(`🎉 *Premium ${type==='eternal'?'Eternal':'Monthly'} активирован!*`, { parse_mode:'Markdown', ...kb.mainMenu(mc.getActiveBotsForUser(ctx.from.id).length) });
  } else { await ctx.answerCbQuery('❌ Не найдено. Подожди.', { show_alert: true }); }
});

// Card
bot.action('pay_card', async (ctx) => {
  await ctx.answerCbQuery();
  const { cardNumber, cardHolder, cardMonthlyPrice, cardEternalPrice } = getSettings();
  if (!cardNumber) return ctx.answerCbQuery('❌ Оплата картой не настроена', { show_alert: true });
  await ctx.editMessageText(
    `💳 *Карта (Беларусь)*\n\nРеквизиты:\n\`${cardNumber}\`\nПолучатель: ${cardHolder||'—'}\n\n• Monthly — ${cardMonthlyPrice}\n• Eternal — ${cardEternalPrice}\n\n📝 Укажи в комментарии: \`${ctx.from.id}\``,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📅 Оплатил Monthly',`card_m_${ctx.from.id}`),Markup.button.callback('💎 Оплатил Eternal',`card_e_${ctx.from.id}`)],[Markup.button.callback('◀️ Назад','tariff')]])}
  );
});
bot.action(/^card_(m|e)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal'; const userId = parseInt(ctx.match[2]);
  const user = db.getUser(userId); const s = getSettings();
  const pid = db.createPayment(user.id, userId, type, 'card', type==='monthly'?s.cardMonthlyPrice:s.cardEternalPrice);
  try { await bot.telegram.sendMessage(config.ADMIN_ID, `💳 *Заявка #${pid}*\n\n👤 @${ctx.from.username||ctx.from.first_name} (${userId})\nТариф: ${type}`, { parse_mode:'Markdown', ...kb.cardApproveKeyboard(userId, pid) }); } catch {}
  await ctx.editMessageText('✅ *Заявка отправлена.* Ожидай подтверждения администратора.', { parse_mode:'Markdown', ...kb.mainMenu(mc.getActiveBotsForUser(userId).length) });
});
bot.action(/^adm_card_(m|e)_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal'; const targetId = parseInt(ctx.match[2]); const pid = ctx.match[3];
  type==='monthly' ? db.updateUserPremium(targetId,'monthly',Math.floor(Date.now()/1000)+30*24*3600) : db.updateUserPremium(targetId,'eternal',null);
  db.updatePayment(pid,'completed');
  try { await bot.telegram.sendMessage(targetId, `🎉 *Premium ${type==='eternal'?'Eternal':'Monthly'} активирован!*`, { parse_mode:'Markdown' }); } catch {}
  await ctx.editMessageText(`✅ Premium ${type} → ${targetId}`);
});
bot.action(/^adm_card_rej_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery(); db.updatePayment(ctx.match[2],'rejected');
  try { await bot.telegram.sendMessage(parseInt(ctx.match[1]),'❌ Оплата не подтверждена.'); } catch {}
  await ctx.editMessageText(`❌ Заявка #${ctx.match[2]} отклонена.`);
});

// Promo
bot.action('use_promo', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step:'use_promo' });
  await ctx.editMessageText('🎁 Введи промокод:', kb.cancelKeyboard('tariff'));
});
async function handlePromoCode(ctx, code) {
  const userId = ctx.from.id;
  const promo = db.getPromocode(code);
  if (!promo) return ctx.reply('❌ Промокод не найден.');
  const now = Math.floor(Date.now()/1000);
  if (promo.expires_at && promo.expires_at < now) return ctx.reply('❌ Промокод истёк.');
  if (promo.used_count >= promo.max_uses) return ctx.reply('❌ Лимит использований исчерпан.');
  if (db.hasUsedPromo(code, userId)) return ctx.reply('❌ Ты уже использовал этот промокод.');
  db.usePromocode(code, userId);
  const user = db.getUser(userId);
  const currentExpires = (user?.premium_type==='monthly' && isPremium(user)) ? user.premium_expires : now;
  const newExpires = currentExpires + promo.days*24*3600;
  if (!isEternal(user)) db.updateUserPremium(userId,'monthly',newExpires);
  const exp = new Date(newExpires*1000).toLocaleDateString('ru-RU');
  await ctx.reply(`🎉 *+${promo.days} дней Premium!*\nАктивен до: ${exp}`, { parse_mode:'Markdown', ...kb.mainMenu(mc.getActiveBotsForUser(userId).length) });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════════════════════════════
bot.action('adm_bots', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const bots = mc.getAllActiveBots();
  if (!bots.length) return ctx.editMessageText('🤖 Нет активных ботов.', kb.adminKeyboard());
  let text = `🤖 *Активные боты (${bots.length}):*\n\n`;
  const kickRows = [];
  for (const inst of bots) {
    const s = mc.getBotStats(inst.botId);
    if (s) { text += `• \`${s.username}\` → \`${s.server}\` | ❤️${s.health} ⏱${s.uptimeH}ч${s.uptimeM}м\n`; kickRows.push([Markup.button.callback(`🛑 Кик ${s.username}`, `adm_kick_${inst.userId}_${inst.botId}`)]); }
  }
  kickRows.push([Markup.button.callback('◀️ Назад', 'adm_back')]);
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...Markup.inlineKeyboard(kickRows) });
});
bot.action(/^adm_kick_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const targetUserId = parseInt(ctx.match[1]), botId = parseInt(ctx.match[2]);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst) return ctx.answerCbQuery('❌ Уже не подключён', { show_alert: true });
  const username = inst.bot?.username || '?';
  await mc.disconnectBotById(botId);
  try { await bot.telegram.sendMessage(targetUserId, '⚠️ Администратор отключил твоего бота.'); } catch {}
  await ctx.editMessageText(`✅ \`${username}\` отключён.`, { parse_mode:'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_dashboard', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const total = db.countUsers(), prem = db.countPremiumUsers(), active = db.countActiveBots(), payments = db.countCompletedPayments();
  const users = db.getAllUsers();
  const eternal = users.filter(u=>u.premium_type==='eternal').length;
  const monthly = users.filter(u=>u.premium_type==='monthly'&&u.premium_expires>Math.floor(Date.now()/1000)).length;
  const { priceMonthlyStars, priceEternalStars } = getSettings();
  await ctx.editMessageText(
    `📈 *Дашборд*\n\n👥 Пользователей: *${total}*\n💎 Premium: *${prem}* (Monthly: ${monthly}, Eternal: ${eternal})\n🆓 Бесплатных: *${total-prem}*\n🤖 Ботов онлайн: *${active}*\n💰 Оплат завершено: *${payments}*\n\n⭐ Выручка (Stars):\n• Monthly ${priceMonthlyStars}×${monthly} = *${priceMonthlyStars*monthly}*\n• Eternal ${priceEternalStars}×${eternal} = *${priceEternalStars*eternal}*\n• Итого: *${priceMonthlyStars*monthly+priceEternalStars*eternal}*`,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад','adm_back')]]) }
  );
});

bot.action('adm_users', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const users = db.getAllUsers();
  const pi = u => u.premium_type==='eternal'?'💎':u.premium_type==='monthly'?'📅':'🆓';
  let text = `👥 *Пользователи (${users.length}):*\n\n`;
  for (const u of users.slice(0,30)) text += `${pi(u)} \`${u.telegram_id}\` @${u.username||'—'}\n`;
  if (users.length>30) text += `\n...и ещё ${users.length-30}`;
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...kb.adminKeyboard() });
});

bot.action('adm_premium', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step:'adm_grant_id' });
  await ctx.editMessageText('💎 Введи Telegram ID:', kb.cancelKeyboard('adm_cancel'));
});
bot.action(/^adm_grant_(m|e)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const type = ctx.match[1]==='m'?'monthly':'eternal', targetId = parseInt(ctx.match[2]);
  type==='monthly' ? db.updateUserPremium(targetId,'monthly',Math.floor(Date.now()/1000)+30*24*3600) : db.updateUserPremium(targetId,'eternal',null);
  try { await bot.telegram.sendMessage(targetId, `🎉 *Premium ${type==='eternal'?'Eternal':'Monthly'} выдан администратором!*`, { parse_mode:'Markdown' }); } catch {}
  await ctx.editMessageText(`✅ Premium ${type} → ${targetId}`, kb.adminKeyboard());
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
  if (!pending.length) return ctx.editMessageText('💰 Нет ожидающих.', kb.adminKeyboard());
  let text = `💰 *Ожидают (${pending.length}):*\n\n`;
  for (const p of pending) text += `#${p.id} | ${p.telegram_id} @${p.username||'—'} | ${p.payment_type} | ${p.method} | ${p.amount||'?'}\n`;
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...kb.adminKeyboard() });
});

// Promos admin
bot.action('adm_promos', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const promos = db.getAllPromocodes();
  let text = '🎁 *Промокоды:*\n\n';
  for (const p of promos) { const exp = p.expires_at ? new Date(p.expires_at*1000).toLocaleDateString('ru-RU'):'∞'; text += `\`${p.code}\` — ${p.days}дн, ${p.used_count}/${p.max_uses}, до ${exp}\n`; }
  if (!promos.length) text += '_Нет_';
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('➕ Создать','adm_promo_create')],[Markup.button.callback('🗑 Удалить','adm_promo_delete')],[Markup.button.callback('◀️ Назад','adm_back')]])});
});
bot.action('adm_promo_create', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery(); setState(ctx.from.id, { step:'adm_promo_create' });
  await ctx.editMessageText('➕ Формат: `КОД ДНИ [МАКС]`\nПример: `WINTER7 7 100`', { parse_mode:'Markdown', ...kb.cancelKeyboard('adm_promos') });
});
bot.action('adm_promo_delete', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery(); setState(ctx.from.id, { step:'adm_promo_delete' });
  await ctx.editMessageText('🗑 Введи код для удаления:', kb.cancelKeyboard('adm_promos'));
});

// MC Ad
bot.action('adm_mc_ad', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const count = db.countActiveBots();
  setState(ctx.from.id, { step:'adm_mc_ad' });
  await ctx.editMessageText(`💬 *Реклама в Minecraft*\n\nСообщение уйдёт в чат *${count}* серверов.\n\nВведи текст сообщения:`, { parse_mode:'Markdown', ...kb.cancelKeyboard('adm_cancel') });
});
bot.action('adm_mc_ad_confirm', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery('⏳ Отправляю...');
  const { adText } = getState(ctx.from.id); clearState(ctx.from.id);
  if (!adText) return ctx.editMessageText('❌ Текст не найден.', kb.adminKeyboard());
  const sent = await mc.sendToAllBots(adText);
  await ctx.editMessageText(`✅ Отправлено в чат *${sent}* серверов.`, { parse_mode:'Markdown', ...kb.adminKeyboard() });
});

// Settings
bot.action('adm_settings', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const s = getSettings();
  const text =
    `⚙️ *Текущие настройки:*\n\n` +
    `⭐ Monthly Stars: *${s.priceMonthlyStars}*\n` +
    `💎 Eternal Stars: *${s.priceEternalStars}*\n` +
    `⬆️ Upgrade Stars: *${s.priceUpgradeStars}*\n` +
    `🤖 Monthly USD: *${s.cryptoMonthlyUsd}*\n` +
    `🤖 Eternal USD: *${s.cryptoEternalUsd}*\n` +
    `💳 Карта: \`${s.cardNumber||'не задана'}\`\n` +
    `💳 Держатель: ${s.cardHolder||'—'}\n` +
    `💳 Monthly BYN: ${s.cardMonthlyPrice}\n` +
    `💳 Eternal BYN: ${s.cardEternalPrice}`;
  await ctx.editMessageText(text, { parse_mode:'Markdown', ...kb.adminSettingsKeyboard() });
});

// Setting edit actions
const settingActions = {
  adm_set_monthly_stars: 'Введи новую цену Monthly (Stars, число):',
  adm_set_eternal_stars: 'Введи новую цену Eternal (Stars, число):',
  adm_set_upgrade_stars: 'Введи новую цену апгрейда (Stars, число):',
  adm_set_crypto_monthly: 'Введи новую цену Monthly (USD, например 1.00):',
  adm_set_crypto_eternal: 'Введи новую цену Eternal (USD, например 1.70):',
  adm_set_card_number: 'Введи номер карты (с пробелами):',
  adm_set_card_holder: 'Введи имя держателя карты:',
  adm_set_card_monthly: 'Введи цену Monthly (BYN, например 2.50 BYN):',
  adm_set_card_eternal: 'Введи цену Eternal (BYN, например 4.50 BYN):',
};
for (const [action, prompt] of Object.entries(settingActions)) {
  bot.action(action, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: action });
    await ctx.editMessageText(prompt, kb.cancelKeyboard('adm_settings'));
  });
}

// Broadcast
bot.action('adm_broadcast', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery(); setState(ctx.from.id, { step:'adm_broadcast' });
  await ctx.editMessageText('📢 Введи текст рассылки:', kb.cancelKeyboard('adm_cancel'));
});
bot.action('adm_broadcast_confirm', async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery('⏳...');
  const { broadcastText } = getState(ctx.from.id); clearState(ctx.from.id);
  if (!broadcastText) return ctx.editMessageText('❌', kb.adminKeyboard());
  const users = db.getAllUsers(); let sent = 0;
  await ctx.editMessageText(`⏳ Отправляю ${users.length} пользователям...`);
  for (const u of users) { try { await bot.telegram.sendMessage(u.telegram_id, broadcastText, { parse_mode:'Markdown' }); sent++; } catch {} await sleep(50); }
  await ctx.editMessageText(`✅ ${sent}/${users.length} доставлено.`, kb.adminKeyboard());
});

bot.action('adm_back', async (ctx) => { if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); await ctx.editMessageText('🔧 *Панель администратора*', { parse_mode:'Markdown', ...kb.adminKeyboard() }); });
bot.action('adm_cancel', async (ctx) => { if (ctx.from.id !== config.ADMIN_ID) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); clearState(ctx.from.id); await ctx.editMessageText('🔧 *Панель администратора*', { parse_mode:'Markdown', ...kb.adminKeyboard() }); });

// Help
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  await ctx.editMessageText(
    `ℹ️ *WHMineBot — помощь*\n\n` +
    `Бот подключается к серверу и не даёт ему уйти в сон.\n\n` +
    `🆓 *Бесплатно:* 1 бот, 7 дней\n` +
    `💎 *Premium:* до 3 ботов, постоянно + свой ник, WASD, слежка, чат-мост, инвентарь\n\n` +
    `💬 *Чат-мост:* включается в панели бота. Команда /mc (текст) — отправить в MC из TG.\n` +
    `🔄 *Авто-реконнект:* бот сам переподключится через ${config.AUTO_RECONNECT_MINUTES} мин после вылета.\n` +
    `✏️ *Свой ник:* в разделе Тарифы (только Premium).\n` +
    `🎁 *Промокод:* в разделе Тарифы.`,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад','main')]]) }
  );
});

module.exports = bot;

// ─── Keep bot selection (multi-bot grace period) ──────────────────────────────
bot.action(/^keep_bot_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const keepBotId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const allBots = mc.getActiveBotsForUser(userId);
  // Disconnect all except chosen
  for (const inst of allBots) {
    if (inst.botId !== keepBotId) {
      await mc.disconnectBotById(inst.botId);
    }
  }
  const kept = mc.getActiveBotByBotId(keepBotId);
  const rec = kept ? db.getBotById(keepBotId) : null;
  await ctx.editMessageText(
    `✅ *Выбран бот \`${kept?.bot?.username || '?'}\`*\n\nОн останется на сервере \`${rec?.server_host || '?'}\`.\n\nОстальные боты отключены.\n\n💡 Продли Premium, чтобы восстановить все боты.`,
    { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{ text:'💎 Продлить Premium', callback_data:'tariff' }]] } }
  );
});

// ─── Toggle auto-reconnect ────────────────────────────────────────────────────
bot.action(/^toggle_reconnect_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  const result = mc.toggleAutoReconnect(botId);
  await ctx.answerCbQuery(
    result === null ? '❌ Бот не подключён' :
    result ? '🔄 Авто-реконнект включён' : '⏸ Авто-реконнект выключен'
  );
  if (result !== null) {
    const stats = mc.getBotStats(botId);
    const user = db.getUser(ctx.from.id);
    if (stats) await ctx.editMessageText(
      formatStats(stats, user),
      { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) }
    );
  }
});

// ─── Toggle no-ads (Premium only) ────────────────────────────────────────────
bot.action(/^toggle_ads_(\d+)$/, async (ctx) => {
  const botId = parseInt(ctx.match[1]);
  const user = db.getUser(ctx.from.id);
  if (!isPremium(user)) return ctx.answerCbQuery('⚠️ Только для Premium!', { show_alert: true });
  const result = mc.toggleNoAds(botId);
  await ctx.answerCbQuery(
    result === null ? '❌' :
    result ? '🔇 Реклама отключена для этого бота' : '📢 Реклама включена'
  );
  if (result !== null) {
    const stats = mc.getBotStats(botId);
    if (stats) await ctx.editMessageText(
      formatStats(stats, user),
      { parse_mode:'Markdown', ...kb.panelKeyboard(stats, isPremium(user), botId) }
    );
  }
});
