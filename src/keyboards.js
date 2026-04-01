const { Markup } = require('telegraf');
const { MC_VERSIONS } = require('./mcManager');

const mainMenu = (hasBot = false) =>
  Markup.inlineKeyboard([
    hasBot
      ? [Markup.button.callback('📊 Панель управления', 'panel')]
      : [Markup.button.callback('🎮 Подключить бота', 'connect')],
    [Markup.button.callback('💎 Тарифы и оплата', 'tariff')],
    [Markup.button.callback('ℹ️ Помощь', 'help')],
  ]);

const panelKeyboard = (stats, isPremium) => {
  const afkLabel = stats.antiAfkEnabled ? '🟢 Анти-АФК: ВКЛ' : '🔴 Анти-АФК: ВЫКЛ';
  let opLabel, opAction;
  if (stats.opGranted) { opLabel = '👑 ОП: получен'; opAction = 'op_already'; }
  else if (stats.waitingForOp) { opLabel = '✅ ОП выдан → Войти в креатив'; opAction = 'op_granted'; }
  else { opLabel = '🔑 Запросить ОП'; opAction = 'request_op'; }

  const rows = [
    [Markup.button.callback('🔄 Обновить', 'panel')],
    [Markup.button.callback(afkLabel, 'toggle_afk')],
    [Markup.button.callback(opLabel, opAction)],
  ];
  if (isPremium) {
    rows.push([Markup.button.callback('🕹️ Управление движением', 'movement')]);
    rows.push([
      Markup.button.callback('🎒 Инвентарь', 'inventory'),
      Markup.button.callback('📜 Лог', 'action_log'),
    ]);
    rows.push([Markup.button.callback(stats.chatBridgeEnabled ? '💬 Чат-мост: ВКЛ' : '💬 Чат-мост: ВЫКЛ', 'toggle_chat')]);
  }
  rows.push([Markup.button.callback('🔴 Отключить бота', 'disconnect')]);
  rows.push([Markup.button.callback('🏠 Главное меню', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const movementKeyboard = (followTarget) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('↖','noop'), Markup.button.callback('⬆️','mv_forward'), Markup.button.callback('↗','noop')],
    [Markup.button.callback('⬅️','mv_left'), Markup.button.callback('⏹','mv_stop'), Markup.button.callback('➡️','mv_right')],
    [Markup.button.callback('↙','noop'), Markup.button.callback('⬇️','mv_back'), Markup.button.callback('↘','noop')],
    [Markup.button.callback('⇧ Шифт','mv_sneak'), Markup.button.callback('⎵ Прыжок','mv_jump')],
    followTarget
      ? [Markup.button.callback(`🛑 Стоп слежка (${followTarget})`, 'stop_follow')]
      : [Markup.button.callback('👤 Следовать за игроком', 'follow_player')],
    [Markup.button.callback('◀️ Назад в панель', 'panel')],
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

const tariffKeyboard = (isPremium, isEternal, isMonthly) => {
  const rows = [];
  if (!isEternal) {
    if (!isMonthly) {
      rows.push([Markup.button.callback('⭐ Месяц — 29 Stars', 'buy_monthly_stars')]);
    }
    rows.push([Markup.button.callback('💎 Навсегда — 49 Stars', 'buy_eternal_stars')]);
    if (isMonthly) {
      rows.push([Markup.button.callback('⬆️ Апгрейд Monthly → Eternal (+25 Stars)', 'buy_upgrade_stars')]);
    }
    rows.push([Markup.button.callback('🤖 CryptoBot (USDT)', 'pay_crypto')]);
    rows.push([Markup.button.callback('💳 Карта (BY)', 'pay_card')]);
    rows.push([Markup.button.callback('🎁 Ввести промокод', 'use_promo')]);
  } else {
    rows.push([Markup.button.callback('💎 У вас вечный Premium', 'noop')]);
  }
  rows.push([Markup.button.callback('🏠 Главное меню', 'main')]);
  return Markup.inlineKeyboard(rows);
};

const adminKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🤖 Активные боты', 'adm_bots'), Markup.button.callback('📈 Дашборд', 'adm_dashboard')],
    [Markup.button.callback('👥 Пользователи', 'adm_users')],
    [Markup.button.callback('💎 Управление Premium', 'adm_premium')],
    [Markup.button.callback('💰 Заявки на оплату', 'adm_payments')],
    [Markup.button.callback('🎁 Промокоды', 'adm_promos')],
    [Markup.button.callback('📢 Рассылка', 'adm_broadcast')],
    [Markup.button.callback('🏠 Главное меню', 'main')],
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
    [Markup.button.callback('📅 Месяц (USDT)', 'crypto_monthly')],
    [Markup.button.callback('💎 Навсегда (USDT)', 'crypto_eternal')],
    [Markup.button.callback('◀️ Назад', 'tariff')],
  ]);

const cancelKeyboard = (backAction = 'main') =>
  Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', backAction)]]);

module.exports = {
  mainMenu, panelKeyboard, movementKeyboard, versionKeyboard,
  tariffKeyboard, adminKeyboard, adminPremiumMenu, cardApproveKeyboard,
  cryptoKeyboard, cancelKeyboard,
};
