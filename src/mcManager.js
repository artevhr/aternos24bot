const mineflayer = require('mineflayer');
const db = require('./db');
const config = require('./config');

const activeBots = new Map();

const MC_VERSIONS = [
  '1.8.8','1.9.4','1.10.2','1.11.2','1.12.2',
  '1.13.2','1.14.4','1.15.2','1.16.5','1.17.1',
  '1.18.2','1.19.4','1.20.1','1.20.4','1.20.6',
  '1.21.1','1.21.4','1.21.9','1.21.11','26.1',
];

function getActiveBot(userId) { return activeBots.get(userId) || null; }

function friendlyError(msg) {
  if (!msg) return 'Неизвестная ошибка';
  if (msg.includes('ECONNRESET'))   return 'Сервер сбросил соединение.\n\n• Сервер offline или недоступен\n• Неверная версия Minecraft\n• Сервер требует лицензионный аккаунт (online-mode)';
  if (msg.includes('ECONNREFUSED')) return 'Сервер отклонил подключение.\n\nПроверь IP и порт.';
  if (msg.includes('ETIMEDOUT') || msg.includes('Таймаут')) return 'Сервер не ответил за 30 секунд.\n\nПроверь IP/порт или попробуй позже.';
  if (msg.includes('ENOTFOUND'))    return 'Адрес сервера не найден.\n\nПроверь правильность домена/IP.';
  if (msg.includes('This server is version')) return 'Несовпадение версий Minecraft.\n\nВыбери правильную версию при подключении.';
  if (msg.toLowerCase().includes('connection closed')) return 'Соединение закрыто сервером.\n\nСервер может не принимать offline-mode ботов.';
  return msg;
}

async function connectBot(userId, host, port, version, botId, onEvent) {
  await disconnectBot(userId);

  const botRecord = db.getBotById(botId);
  const username = botRecord.mc_username;

  return new Promise((resolve, reject) => {
    let settled = false;
    let spawned  = false;
    let bot;

    try {
      bot = mineflayer.createBot({ host, port: parseInt(port), username, version, auth: 'offline', hideErrors: true, checkTimeoutInterval: 30000 });
    } catch (e) { return reject(new Error(friendlyError(e.message))); }

    let pathfinderLoaded = false;
    try { const { pathfinder } = require('mineflayer-pathfinder'); bot.loadPlugin(pathfinder); pathfinderLoaded = true; } catch {}

    const instance = {
      bot, botId, userId, pathfinderLoaded,
      antiAfkInterval: null, antiAfkEnabled: true,
      chatBridgeEnabled: false, actionLog: [],
      followTarget: null, followInterval: null,
      opGranted: false, waitingForOp: false,
      freeLimitTimer: null, reconnectTimer: null,
      // stored for reconnect
      _host: host, _port: port, _version: version, _onEvent: onEvent,
    };
    activeBots.set(userId, instance);

    const addLog = (msg) => {
      const t = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      instance.actionLog.unshift(`[${t}] ${msg}`);
      if (instance.actionLog.length > 60) instance.actionLog.pop();
    };

    bot.once('spawn', () => {
      if (settled) return;
      settled = true; spawned = true;
      db.updateBotStatus(botId, 'connected');
      addLog('✅ Бот подключился к серверу');
      startAntiAfk(instance, addLog);
      startFreeTimer(userId, instance, onEvent, addLog);
      resolve(instance);
      onEvent('connected');
    });

    bot.on('death', () => { addLog('💀 Бот умер, возрождается...'); onEvent('death'); });

    bot.on('kicked', (reason) => {
      let r = ''; try { r = JSON.parse(reason)?.text || reason; } catch { r = String(reason); }
      addLog(`⛔ Бот кикнут: ${r}`);
      onEvent('kicked', r);
      _scheduleReconnect(userId, instance, addLog);
    });

    bot.on('error', (err) => {
      const friendly = friendlyError(err.message);
      addLog(`⚠️ Ошибка: ${err.message}`);
      if (!settled) {
        settled = true;
        activeBots.delete(userId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error(friendly));
      } else if (spawned) {
        onEvent('error', friendly);
        _scheduleReconnect(userId, instance, addLog);
      }
    });

    bot.on('end', (reason) => {
      if (!settled) {
        settled = true;
        activeBots.delete(userId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error(friendlyError(reason || 'Соединение закрыто сервером')));
      } else if (spawned) {
        addLog(`🔌 Соединение закрыто${reason ? ': ' + reason : ''}`);
        onEvent('disconnected');
        _scheduleReconnect(userId, instance, addLog);
      }
    });

    bot.on('chat', (playerName, message) => {
      addLog(`💬 <${playerName}> ${message}`);
      if (instance.chatBridgeEnabled) onEvent('chat', { playerName, message });
    });

    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString();
      if (!instance.opGranted && (
        (msg.toLowerCase().includes('made') && msg.toLowerCase().includes('operator')) ||
        msg.toLowerCase().includes('[op]') ||
        (msg.toLowerCase().includes(username.toLowerCase()) && msg.toLowerCase().includes('op'))
      )) {
        instance.opGranted = true;
        addLog('👑 Получены права оператора!');
        onEvent('op_granted');
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { bot.quit(); } catch {}
        activeBots.delete(userId);
        try { db.updateBotStatus(botId, 'disconnected'); } catch {}
        reject(new Error('Таймаут подключения (30 сек).\n\nСервер не ответил. Проверь IP/порт.'));
      }
    }, 30000);
  });
}

// ─── Авто-реконнект ───────────────────────────────────────────────────────────
function _scheduleReconnect(userId, instance, addLog) {
  _cleanupTimers(instance);
  db.updateBotStatus(instance.botId, 'disconnected');
  activeBots.delete(userId);

  const delayMin = config.AUTO_RECONNECT_MINUTES;
  addLog(`🔄 Авто-реконнект через ${delayMin} мин...`);
  instance._onEvent('reconnecting', delayMin);

  instance.reconnectTimer = setTimeout(async () => {
    // Проверяем что пользователь не подключил бота вручную
    if (activeBots.has(userId)) return;

    // Создаём новую запись бота в БД
    const user = db.getUserByInternalId(db.getBotById(instance.botId)?.user_id || 0) || {};
    const botRecord = db.getBotById(instance.botId);
    if (!botRecord) return;

    const newBotId = db.createBot(
      botRecord.user_id,
      db.getNextBotNumber(),
      instance._host,
      instance._port,
      instance._version
    );

    addLog(`🔄 Переподключаюсь к ${instance._host}:${instance._port}...`);
    try {
      await connectBot(userId, instance._host, instance._port, instance._version, newBotId, instance._onEvent);
      instance._onEvent('reconnected');
    } catch (e) {
      instance._onEvent('reconnect_failed', e.message);
    }
  }, delayMin * 60 * 1000);
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────
function startAntiAfk(instance, addLog) {
  if (instance.antiAfkInterval) clearInterval(instance.antiAfkInterval);
  instance.antiAfkInterval = setInterval(() => {
    if (!instance.bot?.entity || !instance.antiAfkEnabled || instance.followTarget) return;
    try {
      const roll = Math.random();
      if (roll < 0.4) {
        const dir = ['forward','back','left','right'][Math.floor(Math.random()*4)];
        instance.bot.setControlState(dir, true);
        setTimeout(() => { if (instance.bot) instance.bot.setControlState(dir, false); }, 400 + Math.random()*600);
      } else if (roll < 0.65) {
        instance.bot.setControlState('jump', true);
        setTimeout(() => { if (instance.bot) instance.bot.setControlState('jump', false); }, 250);
      } else {
        instance.bot.look((Math.random()*2-1)*Math.PI, (Math.random()*2-1)*0.4, false).catch(()=>{});
      }
    } catch {}
  }, 12000 + Math.random()*8000);
}

// ─── Free 7-day timer ─────────────────────────────────────────────────────────
function startFreeTimer(userId, instance, onEvent, addLog) {
  if (instance.freeLimitTimer) clearInterval(instance.freeLimitTimer);
  instance.freeLimitTimer = setInterval(() => {
    const inst = activeBots.get(userId);
    if (!inst) return clearInterval(instance.freeLimitTimer);
    const rec = db.getBotById(inst.botId);
    if (!rec) return;
    const user = db.getUserByInternalId(rec.user_id);
    if (isPremiumUser(user)) { clearInterval(instance.freeLimitTimer); return; }
    const hoursOnline = (Math.floor(Date.now()/1000) - rec.connected_at) / 3600;
    if (hoursOnline >= config.FREE_LIMIT_HOURS) {
      clearInterval(instance.freeLimitTimer);
      addLog('⏰ Лимит 7 дней истёк, отключаюсь...');
      onEvent('free_limit');
      disconnectBot(userId).catch(()=>{});
    }
  }, 60000);
}

function isPremiumUser(user) {
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
}

async function disconnectBot(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;
  // Cancel pending reconnect
  if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
  try { inst.bot.quit(); } catch {}
  _cleanup(userId);
}

function _cleanup(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;
  _cleanupTimers(inst);
  try { db.updateBotStatus(inst.botId, 'disconnected'); } catch {}
  activeBots.delete(userId);
}

function getBotStats(userId) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return null;
  const bot = inst.bot;
  const rec = db.getBotById(inst.botId);
  try {
    const gamemodeMap = {0:'Выживание',1:'Креатив',2:'Приключение',3:'Наблюдатель'};
    const tod = bot.time?.timeOfDay ?? 0;
    const connectedAt = rec?.connected_at || Math.floor(Date.now()/1000);
    const upSec = Math.max(0, Math.floor(Date.now()/1000) - connectedAt);
    // Total historical + current session
    const historicalSec = rec?.total_online_seconds || 0;
    const totalSec = historicalSec + upSec;
    return {
      username:    bot.username,
      server:      `${rec?.server_host}:${rec?.server_port}`,
      version:     bot.version || rec?.mc_version,
      health:      Math.round((bot.health||0)*10)/10,
      food:        Math.round(bot.food||0),
      gamemode:    gamemodeMap[bot.game?.gameMode] || 'Неизвестно',
      worldTime:   (tod >= 0 && tod < 13000) ? '☀️ День' : '🌙 Ночь',
      onlineCount: Object.keys(bot.players||{}).length,
      uptimeH:     Math.floor(upSec/3600),
      uptimeM:     Math.floor((upSec%3600)/60),
      totalH:      Math.floor(totalSec/3600),
      totalM:      Math.floor((totalSec%3600)/60),
      opGranted:   inst.opGranted,
      waitingForOp: inst.waitingForOp,
      antiAfkEnabled: inst.antiAfkEnabled,
      followTarget: inst.followTarget,
      chatBridgeEnabled: inst.chatBridgeEnabled,
    };
  } catch { return null; }
}

function getInventory(userId) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return null;
  try {
    const items = inst.bot.inventory.items();
    return items.map(item => ({
      name: item.name,
      displayName: item.displayName || item.name,
      count: item.count,
      slot: item.slot,
    }));
  } catch { return null; }
}

function toggleAntiAfk(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return null;
  inst.antiAfkEnabled = !inst.antiAfkEnabled;
  return inst.antiAfkEnabled;
}

function moveBot(userId, direction) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  if (!['forward','back','left','right','jump','sneak'].includes(direction)) return false;
  try {
    inst.bot.setControlState(direction, true);
    setTimeout(() => { if (inst.bot) inst.bot.setControlState(direction, false); }, 500);
    return true;
  } catch { return false; }
}

async function followPlayer(userId, playerName) {
  const inst = activeBots.get(userId);
  if (!inst?.bot || !inst.pathfinderLoaded) return false;
  try {
    const { Movements, goals } = require('mineflayer-pathfinder');
    const mcData = require('minecraft-data')(inst.bot.version);
    inst.bot.pathfinder.setMovements(new Movements(inst.bot, mcData));
    if (inst.followInterval) { clearInterval(inst.followInterval); inst.followInterval = null; }
    inst.followTarget = playerName;
    inst.followInterval = setInterval(() => {
      if (!inst.bot?.entity) return;
      const target = inst.bot.players[playerName]?.entity;
      if (target) inst.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    }, 1000);
    return true;
  } catch { return false; }
}

function stopFollow(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;
  if (inst.followInterval) { clearInterval(inst.followInterval); inst.followInterval = null; }
  inst.followTarget = null;
  try { if (inst.pathfinderLoaded) inst.bot.pathfinder.setGoal(null); } catch {}
}

async function setCreative(userId) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  try { inst.bot.chat('/gamemode creative'); return true; } catch { return false; }
}

function sendChatToMC(userId, message) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  try { inst.bot.chat(message); return true; } catch { return false; }
}

function toggleChatBridge(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return null;
  inst.chatBridgeEnabled = !inst.chatBridgeEnabled;
  return inst.chatBridgeEnabled;
}

function getActionLog(userId) { return activeBots.get(userId)?.actionLog || []; }

module.exports = {
  MC_VERSIONS, getActiveBot, connectBot, disconnectBot,
  getBotStats, getInventory, toggleAntiAfk, moveBot,
  followPlayer, stopFollow, setCreative, sendChatToMC,
  toggleChatBridge, getActionLog,
  getAllActiveBots: () => [...activeBots.values()],
};
