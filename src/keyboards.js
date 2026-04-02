const { Markup } = require('telegraf');
const { MC_VERSIONS } = require('./mcManager');

const mainMenu = (activeBotCount = 0) =>
  Markup.inlineKeyboard([
    activeBotCount > 0
      ? [Markup.button.callback(`📊 Мои боты (${activeBotCount})`, 'my_bots')]
      : [Markup.button.callback('🎮 Подключить бота', 'connect')],
    [Markup.button.callback('🎮 Подключить ещё бота', 'connect')],
    [Markup.button.callback('💎 Тарифы и оплата', 'tariff')],
    [Markup.button.callback('🕐 Недавние серверы', 'recent_servers')],
    [Markup.button.callback('ℹ️ Помощь', 'help')],
  ].filter((_, i) => activeBotCount > 0 || i !== 1));

const botListKeyboard = (bots) => {
  const rows = bots.map((inst, i) => {
    const rec = require('./db').getBotById(inst.botId);
    const label = `🤖 ${inst.bot?.username || '?'} — ${rec?.server_host}:${rec?.server_port}`;
    return [Markup.button.callback(label, `bot_panel_${inst.botId}`)];
  });
  rows.push([Markup.button.callback('🎮 Подключить ещё', 'connect')]);
  rows.push([Markup.button.callback('🏠 Главное меню', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const panelKeyboard = (stats, isPremium, botId) => {
  const afkLabel = stats.antiAfkEnabled ? '🟢 Анти-АФК: ВКЛ' : '🔴 Анти-АФК: ВЫКЛ';
  let opLabel, opAction;
  if (stats.opGranted) { opLabel = '👑 ОП: есть'; opAction = `op_already_${botId}`; }
  else if (stats.waitingForOp) { opLabel = '✅ ОП выдан — Креатив'; opAction = `op_granted_${botId}`; }
  else { opLabel = '🔑 Запросить ОП'; opAction = `request_op_${botId}`; }

  const rows = [
    [Markup.button.callback('🔄 Обновить', `bot_panel_${botId}`)],
    [Markup.button.callback(afkLabel, `toggle_afk_${botId}`)],
    [Markup.button.callback(opLabel, opAction)],
  ];
  if (isPremium) {
    rows.push([Markup.button.callback('🕹️ Движение', `movement_${botId}`), Markup.button.callback('🎒 Инвентарь', `inventory_${botId}`)]);
    rows.push([Markup.button.callback('💬 Чат-мост', `chatbridge_${botId}`), Markup.button.callback('📜 Лог', `action_log_${botId}`)]);
  }
  rows.push([Markup.button.callback('🔴 Отключить', `disconnect_${botId}`)]);
  rows.push([Markup.button.callback('◀️ Мои боты', 'my_bots')]);
  return Markup.inlineKeyboard(rows);
};

const chatBridgeKeyboard = (botId, page, totalPages, bridgeEnabled) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(bridgeEnabled ? '🟢 Мост: ВКЛ' : '🔴 Мост: ВЫКЛ', `toggle_chat_${botId}`)],
    [
      page > 0 ? Markup.button.callback('◀️', `chat_page_${botId}_${page-1}`) : Markup.button.callback('·', 'noop'),
      Markup.button.callback(`${page+1}/${totalPages||1}`, 'noop'),
      page+1 < totalPages ? Markup.button.callback('▶️', `chat_page_${botId}_${page+1}`) : Markup.button.callback('·', 'noop'),
    ],
    [Markup.button.callback('◀️ Назад в панель', `bot_panel_${botId}`)],
  ]);

const movementKeyboard = (botId, followTarget) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('↖','noop'), Markup.button.callback('⬆️',`mv_forward_${botId}`), Markup.button.callback('↗','noop')],
    [Markup.button.callback('⬅️',`mv_left_${botId}`), Markup.button.callback('⏹',`mv_stop_${botId}`), Markup.button.callback('➡️',`mv_right_${botId}`)],
    [Markup.button.callback('↙','noop'), Markup.button.callback('⬇️',`mv_back_${botId}`), Markup.button.callback('↘','noop')],
    [Markup.button.callback('⇧ Шифт',`mv_sneak_${botId}`), Markup.button.callback('⎵ Прыжок',`mv_jump_${botId}`)],
    followTarget
      ? [Markup.button.callback(`🛑 Стоп слежка (${followTarget})`, `stop_follow_${botId}`)]
      : [Markup.button.callback('👤 Следовать за игроком', `follow_player_${botId}`)],
    [Markup.button.callback('◀️ Назад', `bot_panel_${botId}`)],
  ]);

const versionKeyboard = (page = 0) => {
  const perPage = 6;
  const slice = MC_VERSIONS.slice(page*perPage, page*perPage+perPage);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [Markup.button.callback(slice[i], `ver_${slice[i]}`)];
    if (slice[i+1]) row.push(Markup.button.callback(slice[i+1], `ver_${slice[i+1]}`));
    rows.push(row);
  }
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀ Назад', `vp_${page-1}`));
  if ((page+1)*perPage < MC_VERSIONS.length) nav.push(Markup.button.callback('Вперёд ▶', `vp_${page+1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('❌ Отмена', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const tariffKeyboard = (user) => {
  const now = Math.floor(Date.now()/1000);
  const eternal = user?.premium_type === 'eternal';
  const monthly = user?.premium_type === 'monthly' && user?.premium_expires > now;
  const rows = [];
  if (!eternal) {
    if (!monthly) rows.push([Markup.button.callback('⭐ Месяц — 29 Stars', 'buy_monthly_stars')]);
    rows.push([Markup.button.callback('💎 Навсегда — 49 Stars', 'buy_eternal_stars')]);
    if (monthly) rows.push([Markup.button.callback('⬆️ Апгрейд Monthly → Eternal (+25 Stars)', 'buy_upgrade_stars')]);
    rows.push([Markup.button.callback('🤖 CryptoBot (USDT)', 'pay_crypto')]);
    rows.push([Markup.button.callback('💳 Карта (BY)', 'pay_card')]);
    rows.push([Markup.button.callback('🎁 Промокод', 'use_promo')]);
  } else {
    rows.push([Markup.button.callback('💎 Вечный Premium активен', 'noop')]);
  }
  rows.push([Markup.button.callback('🏠 Главное меню', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const recentServersKeyboard = (servers) => {
  const rows = servers.map(s => [Markup.button.callback(`🌐 ${s.host}:${s.port} (${s.version})`, `recent_${s.id}`)]);
  rows.push([Markup.button.callback('🎮 Новый сервер', 'connect')]);
  rows.push([Markup.button.callback('◀️ Назад', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const adminKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🤖 Активные боты', 'adm_bots'), Markup.button.callback('📈 Дашборд', 'adm_dashboard')],
    [Markup.button.callback('👥 Пользователи', 'adm_users')],
    [Markup.button.callback('💎 Premium', 'adm_premium'), Markup.button.callback('💰 Заявки', 'adm_payments')],
    [Markup.button.callback('🎁 Промокоды', 'adm_promos')],
    [Markup.button.callback('💬 Реклама в MC', 'adm_mc_ad')],
    [Markup.button.callback('⚙️ Цены и оплата', 'adm_settings')],
    [Markup.button.callback('📢 Рассылка в TG', 'adm_broadcast')],
    [Markup.button.callback('🏠 Главное меню', 'main')],
  ]);

const adminSettingsKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Цена Monthly (Stars)', 'adm_set_monthly_stars')],
    [Markup.button.callback('💎 Цена Eternal (Stars)', 'adm_set_eternal_stars')],
    [Markup.button.callback('⬆️ Цена апгрейда (Stars)', 'adm_set_upgrade_stars')],
    [Markup.button.callback('🤖 Цена Monthly (USDT)', 'adm_set_crypto_monthly')],
    [Markup.button.callback('🤖 Цена Eternal (USDT)', 'adm_set_crypto_eternal')],
    [Markup.button.callback('💳 Номер карты', 'adm_set_card_number')],
    [Markup.button.callback('💳 Имя на карте', 'adm_set_card_holder')],
    [Markup.button.callback('💳 Цена Monthly (BYN)', 'adm_set_card_monthly')],
    [Markup.button.callback('💳 Цена Eternal (BYN)', 'adm_set_card_eternal')],
    [Markup.button.callback('◀️ Назад', 'adm_back')],
  ]);

const adminPremiumMenu = (targetId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📅 Monthly', `adm_grant_m_${targetId}`), Markup.button.callback('💎 Eternal', `adm_grant_e_${targetId}`)],
    [Markup.button.callback('🗑 Убрать Premium', `adm_revoke_${targetId}`)],
    [Markup.button.callback('◀️ Назад', 'adm_premium')],
  ]);

const cardApproveKeyboard = (targetTgId, paymentId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📅 Monthly', `adm_card_m_${targetTgId}_${paymentId}`), Markup.button.callback('💎 Eternal', `adm_card_e_${targetTgId}_${paymentId}`)],
    [Markup.button.callback('❌ Отклонить', `adm_card_rej_${targetTgId}_${paymentId}`)],
  ]);

const cryptoKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📅 Monthly (USDT)', 'crypto_monthly')],
    [Markup.button.callback('💎 Eternal (USDT)', 'crypto_eternal')],
    [Markup.button.callback('◀️ Назад', 'tariff')],
  ]);

const cancelKeyboard = (back = 'main') =>
  Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', back)]]);

module.exports = {
  mainMenu, botListKeyboard, panelKeyboard, chatBridgeKeyboard,
  movementKeyboard, versionKeyboard, tariffKeyboard,
  recentServersKeyboard, adminKeyboard, adminSettingsKeyboard,
  adminPremiumMenu, cardApproveKeyboard, cryptoKeyboard, cancelKeyboard,
};
