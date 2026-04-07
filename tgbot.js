const mineflayer = require('mineflayer');
const db = require('./db');
const config = require('./config');

// activeBots: Map<botId, instance>
const activeBots = new Map();

const MC_VERSIONS = [
  '1.8.8','1.9.4','1.10.2','1.11.2','1.12.2',
  '1.13.2','1.14.4','1.15.2','1.16.5','1.17.1',
  '1.18.2','1.19.4','1.20.1','1.20.4','1.20.6',
  '1.21.1','1.21.4','1.21.9','1.21.11','26.1',
];

function getActiveBot(userId) {
  for (const [, inst] of activeBots) { if (inst.userId === userId) return inst; }
  return null;
}
function getActiveBotsForUser(userId) {
  const result = [];
  for (const [, inst] of activeBots) { if (inst.userId === userId) result.push(inst); }
  return result;
}
function getActiveBotByBotId(botId) { return activeBots.get(botId) || null; }
function getAllActiveBots() { return [...activeBots.values()]; }

function friendlyError(msg) {
  if (!msg) return 'Неизвестная ошибка';
  if (msg.includes('ECONNRESET'))   return 'Сервер сбросил соединение.\n\n• Сервер offline / недоступен\n• Неверная версия Minecraft\n• Сервер требует лицензионный аккаунт';
  if (msg.includes('ECONNREFUSED')) return 'Сервер отклонил подключение.\n\nПроверь IP и порт.';
  if (msg.includes('ETIMEDOUT') || msg.includes('Таймаут')) return 'Сервер не ответил за 30 сек.\n\nПроверь IP/порт.';
  if (msg.includes('ENOTFOUND'))    return 'Адрес не найден. Проверь домен/IP.';
  if (msg.includes('This server is version')) return 'Несовпадение версий. Выбери правильную версию.';
  return msg;
}

async function connectBot(userId, host, port, version, botId, onEvent) {
  const botRecord = db.getBotById(botId);
  const username = botRecord.mc_username;

  return new Promise((resolve, reject) => {
    let settled = false, spawned = false, bot;
    try {
      bot = mineflayer.createBot({ host, port: parseInt(port), username, version, auth: 'offline', hideErrors: true, checkTimeoutInterval: 30000 });
    } catch (e) { return reject(new Error(friendlyError(e.message))); }

    let pathfinderLoaded = false;
    try { const { pathfinder } = require('mineflayer-pathfinder'); bot.loadPlugin(pathfinder); pathfinderLoaded = true; } catch {}

    const instance = {
      bot, botId, userId, pathfinderLoaded,
      antiAfkInterval: null, antiAfkEnabled: true,
      chatBridgeEnabled: false,
      chatLog: [],      // все сообщения для чат-моста
      actionLog: [],
      followTarget: null, followInterval: null,
      opGranted: false, waitingForOp: false,
      freeLimitTimer: null, reconnectTimer: null,
      gracePeriodTimer: null,
      autoReconnect: true,
      authDetected: false,
      noAds: false,
      _host: host, _port: port, _version: version, _onEvent: onEvent,
    };
    activeBots.set(botId, instance);

    const addLog = (msg) => {
      const t = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      instance.actionLog.unshift(`[${t}] ${msg}`);
      if (instance.actionLog.length > 100) instance.actionLog.pop();
    };

    bot.once('spawn', () => {
      if (settled) return;
      settled = true; spawned = true;
      db.updateBotStatus(botId, 'connected');
      db.upsertRecentServer(userId, host, port, version);
      addLog('✅ Бот подключился к серверу');
      startAntiAfk(instance, addLog);
      startFreeTimer(userId, instance, onEvent, addLog);
      resolve(instance);
      onEvent('connected');
    });

    bot.on('death', () => { addLog('💀 Бот умер, возрождается...'); onEvent('death'); });

    bot.on('kicked', (reason) => {
      let r = ''; try { r = JSON.parse(reason)?.text || reason; } catch { r = String(reason); }
      addLog(`⛔ Кикнут: ${r}`); onEvent('kicked', r);
      _scheduleReconnect(botId, instance, addLog);
    });

    bot.on('error', (err) => {
      addLog(`⚠️ ${err.message}`);
      if (!settled) {
        settled = true; activeBots.delete(botId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error(friendlyError(err.message)));
      } else if (spawned) {
        onEvent('error', friendlyError(err.message));
        _scheduleReconnect(botId, instance, addLog);
      }
    });

    bot.on('end', (reason) => {
      if (!settled) {
        settled = true; activeBots.delete(botId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error(friendlyError(reason || 'Соединение закрыто сервером')));
      } else if (spawned) {
        addLog(`🔌 Закрыто${reason ? ': '+reason : ''}`);
        onEvent('disconnected');
        _scheduleReconnect(botId, instance, addLog);
      }
    });

    bot.on('chat', (playerName, message) => {
      const entry = { playerName, message, ts: Date.now() };
      instance.actionLog.unshift(`[chat] <${playerName}> ${message}`);
      instance.chatLog.unshift(entry);
      if (instance.chatLog.length > 200) instance.chatLog.pop();
      if (instance.chatBridgeEnabled) onEvent('chat', entry);
    });

    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString();
      const msgLower = msg.toLowerCase();

      // OP detection
      if (!instance.opGranted && (
        (msgLower.includes('made') && msgLower.includes('operator')) ||
        msgLower.includes('[op]') ||
        (msgLower.includes(username.toLowerCase()) && msgLower.includes('op'))
      )) {
        instance.opGranted = true;
        addLog('👑 Права оператора!');
        onEvent('op_granted');
      }

      // Auth detection — /register and /login prompts from server
      if (!instance.authDetected) {
        const isRegisterPrompt =
          (msgLower.includes('/register') && (msgLower.includes('регистр') || msgLower.includes('register') || msgLower.includes('password') || msgLower.includes('пароль'))) ||
          (msgLower.includes('зарегистрир') ) ||
          (msgLower.includes('register') && msgLower.includes('password'));

        const isLoginPrompt =
          (msgLower.includes('/login') && (msgLower.includes('войди') || msgLower.includes('login') || msgLower.includes('password') || msgLower.includes('пароль'))) ||
          (msgLower.includes('авторизу') ) ||
          (msgLower.includes('login') && msgLower.includes('password'));

        if (isRegisterPrompt) {
          addLog('🔐 Сервер просит регистрацию!');
          onEvent('auth_needed', { type: 'register', message: msg, botId });
        } else if (isLoginPrompt) {
          addLog('🔑 Сервер просит логин!');
          onEvent('auth_needed', { type: 'login', message: msg, botId });
        }
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true; try { bot.quit(); } catch {}
        activeBots.delete(botId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error('Таймаут 30 сек. Проверь IP/порт.'));
      }
    }, 30000);
  });
}

function _scheduleReconnect(botId, instance, addLog) {
  if (!instance.autoReconnect) {
    _cleanupTimers(instance);
    activeBots.delete(botId);
    try { db.updateBotStatus(botId, 'disconnected'); } catch {}
    return;
  }
  _cleanupTimers(instance);
  activeBots.delete(botId);
  try { db.updateBotStatus(botId, 'disconnected'); } catch {}

  const delayMin = config.AUTO_RECONNECT_MINUTES;
  addLog(`🔄 Реконнект через ${delayMin} мин...`);
  instance._onEvent('reconnecting', delayMin);

  instance.reconnectTimer = setTimeout(async () => {
    if (activeBots.has(botId)) return;
    const botRecord = db.getBotById(botId);
    if (!botRecord) return;
    const newBotId = db.createBot(botRecord.user_id, db.getNextBotNumber(), instance._host, instance._port, instance._version, botRecord.mc_username);
    addLog(`🔄 Переподключаюсь...`);
    try {
      await connectBot(instance.userId, instance._host, instance._port, instance._version, newBotId, instance._onEvent);
      instance._onEvent('reconnected');
    } catch (e) {
      instance._onEvent('reconnect_failed', e.message);
    }
  }, delayMin * 60000);
}

function startAntiAfk(instance, addLog) {
  if (instance.antiAfkInterval) clearInterval(instance.antiAfkInterval);
  instance.antiAfkInterval = setInterval(() => {
    if (!instance.bot?.entity || !instance.antiAfkEnabled || instance.followTarget) return;
    try {
      const roll = Math.random();
      if (roll < 0.4) {
        const dir = ['forward','back','left','right'][Math.floor(Math.random()*4)];
        instance.bot.setControlState(dir, true);
        setTimeout(() => { if (instance.bot) instance.bot.setControlState(dir, false); }, 400+Math.random()*600);
      } else if (roll < 0.65) {
        instance.bot.setControlState('jump', true);
        setTimeout(() => { if (instance.bot) instance.bot.setControlState('jump', false); }, 250);
      } else {
        instance.bot.look((Math.random()*2-1)*Math.PI, (Math.random()*2-1)*0.4, false).catch(()=>{});
      }
    } catch {}
  }, 12000+Math.random()*8000);
}

function startFreeTimer(userId, instance, onEvent, addLog) {
  if (instance.freeLimitTimer) clearInterval(instance.freeLimitTimer);
  instance.freeLimitTimer = setInterval(() => {
    const inst = activeBots.get(instance.botId);
    if (!inst) return clearInterval(instance.freeLimitTimer);
    const rec = db.getBotById(inst.botId);
    if (!rec) return;
    const user = db.getUserByInternalId(rec.user_id);
    if (_isPremiumUser(user)) { clearInterval(instance.freeLimitTimer); return; }
    const hoursOnline = (Math.floor(Date.now()/1000) - rec.connected_at) / 3600;
    if (hoursOnline >= config.FREE_LIMIT_HOURS) {
      clearInterval(instance.freeLimitTimer);
      addLog('⏰ Лимит 7 дней истёк');
      onEvent('free_limit');
      disconnectBotById(instance.botId).catch(()=>{});
    }
  }, 60000);
}

function _isPremiumUser(user) {
  if (!user) return false;
  if (user.premium_type === 'eternal') return true;
  if (user.premium_type === 'monthly' && user.premium_expires > Math.floor(Date.now()/1000)) return true;
  return false;
}

function _cleanupTimers(instance) {
  if (instance.antiAfkInterval) clearInterval(instance.antiAfkInterval);
  if (instance.followInterval)  clearInterval(instance.followInterval);
  if (instance.freeLimitTimer)  clearInterval(instance.freeLimitTimer);
  if (instance.reconnectTimer)  clearTimeout(instance.reconnectTimer);
  if (instance.gracePeriodTimer) clearTimeout(instance.gracePeriodTimer);
}

async function disconnectBot(userId) {
  const bots = getActiveBotsForUser(userId);
  for (const inst of bots) await disconnectBotById(inst.botId);
}

async function disconnectBotById(botId) {
  // Mark as manual so end/error events don't trigger reconnect
  const inst = activeBots.get(botId);
  if (inst) inst.autoReconnect = false;
  if (!inst) return;
  if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
  try { inst.bot.quit(); } catch {}
  _cleanupTimers(inst);
  try { db.updateBotStatus(botId, 'disconnected'); } catch {}
  activeBots.delete(botId);
}

function getBotStats(botId) {
  const inst = activeBots.get(botId);
  if (!inst?.bot) return null;
  const bot = inst.bot;
  const rec = db.getBotById(botId);
  try {
    const gm = {0:'Выживание',1:'Креатив',2:'Приключение',3:'Наблюдатель'};
    const tod = bot.time?.timeOfDay ?? 0;
    const connectedAt = rec?.connected_at || Math.floor(Date.now()/1000);
    const upSec = Math.max(0, Math.floor(Date.now()/1000) - connectedAt);
    const totalSec = (rec?.total_online_seconds||0) + upSec;
    return {
      botId, username: bot.username,
      server: `${rec?.server_host}:${rec?.server_port}`,
      version: bot.version || rec?.mc_version,
      health: Math.round((bot.health||0)*10)/10,
      food: Math.round(bot.food||0),
      gamemode: gm[bot.game?.gameMode]||'Неизвестно',
      worldTime: (tod>=0&&tod<13000)?'☀️ День':'🌙 Ночь',
      onlineCount: Object.keys(bot.players||{}).length,
      uptimeH: Math.floor(upSec/3600), uptimeM: Math.floor((upSec%3600)/60),
      totalH: Math.floor(totalSec/3600), totalM: Math.floor((totalSec%3600)/60),
      opGranted: inst.opGranted, waitingForOp: inst.waitingForOp,
      antiAfkEnabled: inst.antiAfkEnabled,
      followTarget: inst.followTarget,
      chatBridgeEnabled: inst.chatBridgeEnabled,
      autoReconnect: inst.autoReconnect,
      noAds: inst.noAds,
    };
  } catch { return null; }
}

function getFirstBotStats(userId) {
  const inst = getActiveBot(userId);
  if (!inst) return null;
  return getBotStats(inst.botId);
}

function getInventory(botId) {
  const inst = activeBots.get(botId) || getActiveBot(botId);
  if (!inst?.bot) return null;
  try {
    const items = inst.bot.inventory.items();
    const grouped = {};
    for (const item of items) {
      const k = item.displayName || item.name;
      grouped[k] = (grouped[k]||0) + item.count;
    }
    return grouped;
  } catch { return null; }
}

function getChatLog(botId) {
  const inst = activeBots.get(botId);
  return inst ? inst.chatLog : [];
}

function toggleAntiAfk(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return null;
  inst.antiAfkEnabled = !inst.antiAfkEnabled;
  return inst.antiAfkEnabled;
}

function moveBot(botId, direction) {
  const inst = activeBots.get(botId);
  if (!inst?.bot) return false;
  if (!['forward','back','left','right','jump','sneak'].includes(direction)) return false;
  try {
    inst.bot.setControlState(direction, true);
    setTimeout(() => { if (inst.bot) inst.bot.setControlState(direction, false); }, 500);
    return true;
  } catch { return false; }
}

async function followPlayer(botId, playerName) {
  const inst = activeBots.get(botId);
  if (!inst?.bot || !inst.pathfinderLoaded) return false;
  try {
    const { Movements, goals } = require('mineflayer-pathfinder');
    const mcData = require('minecraft-data')(inst.bot.version);
    inst.bot.pathfinder.setMovements(new Movements(inst.bot, mcData));
    if (inst.followInterval) { clearInterval(inst.followInterval); inst.followInterval = null; }
    inst.followTarget = playerName;
    inst.followInterval = setInterval(() => {
      const target = inst.bot?.players?.[playerName]?.entity;
      if (target) inst.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    }, 1000);
    return true;
  } catch { return false; }
}

function stopFollow(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return;
  if (inst.followInterval) { clearInterval(inst.followInterval); inst.followInterval = null; }
  inst.followTarget = null;
  try { if (inst.pathfinderLoaded) inst.bot.pathfinder.setGoal(null); } catch {}
}

async function setCreative(botId) {
  const inst = activeBots.get(botId);
  if (!inst?.bot) return false;
  try { inst.bot.chat('/gamemode creative'); return true; } catch { return false; }
}

function sendChatToMC(botId, message) {
  const inst = activeBots.get(botId);
  if (!inst?.bot) return false;
  try { inst.bot.chat(message); return true; } catch { return false; }
}

function toggleChatBridge(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return null;
  inst.chatBridgeEnabled = !inst.chatBridgeEnabled;
  return inst.chatBridgeEnabled;
}

function getActionLog(botId) { return activeBots.get(botId)?.actionLog || []; }

// Send MC chat message from all active bots (admin broadcast)
async function sendToAllBots(message) {
  // skip bots where noAds is enabled
  let count = 0;
  for (const [, inst] of activeBots) {
    if (inst.noAds) continue;
    try { inst.bot.chat(message); count++; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return count;
}

module.exports = {
  MC_VERSIONS,
  getActiveBot, getActiveBotsForUser, getActiveBotByBotId, getAllActiveBots,
  connectBot, disconnectBot, disconnectBotById,
  getBotStats, getFirstBotStats, getInventory, getChatLog,
  toggleAntiAfk, moveBot, followPlayer, stopFollow,
  setCreative, sendChatToMC, toggleChatBridge,
  getActionLog, sendToAllBots,
  toggleAutoReconnect, toggleNoAds, sendAuth,
};

// toggle auto-reconnect for a bot
function toggleAutoReconnect(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return null;
  inst.autoReconnect = !inst.autoReconnect;
  return inst.autoReconnect;
}

// toggle no-ads for a bot
function toggleNoAds(botId) {
  const inst = activeBots.get(botId);
  if (!inst) return null;
  inst.noAds = !inst.noAds;
  return inst.noAds;
}


// Send auth command to MC (/register pass pass or /login pass)
function sendAuth(botId, type, password) {
  const inst = activeBots.get(botId);
  if (!inst?.bot) return false;
  try {
    if (type === 'register') {
      inst.bot.chat(`/register ${password} ${password}`);
    } else {
      inst.bot.chat(`/login ${password}`);
    }
    inst.authDetected = true; // mark so we don't spam prompts
    inst.actionLog.unshift(`[auth] ${type === 'register' ? '📝 /register ****' : '🔑 /login ****'}`);
    return true;
  } catch { return false; }
}
