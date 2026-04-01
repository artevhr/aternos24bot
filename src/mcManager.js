const mineflayer = require('mineflayer');
const db = require('./db');
const config = require('./config');

// Active bot instances: Map<userId (telegram_id), instance>
const activeBots = new Map();

// Supported Minecraft versions
const MC_VERSIONS = [
  '1.8.8',
  '1.9.4',
  '1.10.2',
  '1.11.2',
  '1.12.2',
  '1.13.2',
  '1.14.4',
  '1.15.2',
  '1.16.5',
  '1.17.1',
  '1.18.2',
  '1.19.4',
  '1.20.1',
  '1.20.4',
  '1.20.6',
  '1.21.1',
  '1.21.4',
  '1.21.9',
  '1.21.11',
  '26.1',
];

function getActiveBot(userId) {
  return activeBots.get(userId) || null;
}

/**
 * Connect a Minecraft bot for a user.
 * @param {number} userId - Telegram user ID
 * @param {string} host
 * @param {number} port
 * @param {string} version
 * @param {number} botId - DB bot record ID
 * @param {Function} onEvent - callback(event, data)
 */
async function connectBot(userId, host, port, version, botId, onEvent) {
  // Disconnect any existing bot for this user
  await disconnectBot(userId);

  const botRecord = db.getBotById(botId);
  const username = botRecord.mc_username;

  return new Promise((resolve, reject) => {
    let settled = false;
    let bot;

    try {
      bot = mineflayer.createBot({
        host: host,
        port: parseInt(port),
        username: username,
        version: version,
        auth: 'offline',
        hideErrors: false,
        checkTimeoutInterval: 30000,
      });
    } catch (e) {
      return reject(e);
    }

    // Try to load pathfinder plugin for follow feature
    let pathfinderLoaded = false;
    try {
      const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
      bot.loadPlugin(pathfinder);
      pathfinderLoaded = true;
    } catch (e) {
      // pathfinder optional
    }

    const instance = {
      bot,
      botId,
      userId,
      pathfinderLoaded,
      antiAfkInterval: null,
      antiAfkEnabled: true,
      chatBridgeEnabled: false,
      actionLog: [],
      followTarget: null,
      followInterval: null,
      opGranted: false,
      waitingForOp: false,
      freeLimitTimer: null,
    };

    activeBots.set(userId, instance);

    const addLog = (msg) => {
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      instance.actionLog.unshift(`[${time}] ${msg}`);
      if (instance.actionLog.length > 60) instance.actionLog.pop();
    };

    // ---- SPAWN ----
    bot.once('spawn', () => {
      if (settled) return;
      settled = true;

      db.updateBotStatus(botId, 'connected');
      addLog('✅ Бот подключился к серверу');
      startAntiAfk(instance, addLog);
      startFreeTimer(userId, instance, onEvent, addLog);
      resolve(instance);
      onEvent('connected');
    });

    // ---- DEATH ----
    bot.on('death', () => {
      addLog('💀 Бот умер, возрождается...');
      onEvent('death');
    });

    // ---- KICKED ----
    bot.on('kicked', (reason) => {
      let reasonStr = '';
      try { reasonStr = JSON.parse(reason)?.text || reason; } catch { reasonStr = String(reason); }
      addLog(`⛔ Бот кикнут: ${reasonStr}`);
      onEvent('kicked', reasonStr);
      _cleanup(userId);
    });

    // ---- ERROR ----
    bot.on('error', (err) => {
      addLog(`⚠️ Ошибка: ${err.message}`);
      if (!settled) {
        settled = true;
        reject(err);
        activeBots.delete(userId);
      } else {
        onEvent('error', err.message);
        _cleanup(userId);
      }
    });

    // ---- END ----
    bot.on('end', (reason) => {
      addLog(`🔌 Соединение закрыто${reason ? ': ' + reason : ''}`);
      if (!settled) {
        settled = true;
        reject(new Error(reason || 'Connection closed'));
        activeBots.delete(userId);
      } else {
        onEvent('disconnected');
        _cleanup(userId);
      }
    });

    // ---- CHAT ----
    bot.on('chat', (playerName, message) => {
      addLog(`💬 <${playerName}> ${message}`);
      if (instance.chatBridgeEnabled) {
        onEvent('chat', { playerName, message });
      }
    });

    // ---- MESSAGES (detect OP) ----
    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString();
      // Detect OP grant messages
      if (
        (msg.toLowerCase().includes('made') && msg.toLowerCase().includes('operator')) ||
        msg.toLowerCase().includes('[op]') ||
        (msg.toLowerCase().includes(username.toLowerCase()) && msg.toLowerCase().includes('op'))
      ) {
        if (!instance.opGranted) {
          instance.opGranted = true;
          addLog('👑 Получены права оператора!');
          onEvent('op_granted');
        }
      }
    });

    // Connection timeout (30 sec)
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { bot.quit(); } catch {}
        activeBots.delete(userId);
        reject(new Error('Таймаут подключения (30 сек)'));
      }
    }, 30000);
  });
}

// ===== ANTI-AFK =====
function startAntiAfk(instance, addLog) {
  if (instance.antiAfkInterval) clearInterval(instance.antiAfkInterval);

  instance.antiAfkInterval = setInterval(() => {
    if (!instance.bot || !instance.bot.entity || !instance.antiAfkEnabled) return;
    if (instance.followTarget) return; // don't interfere with follow

    try {
      const roll = Math.random();
      if (roll < 0.4) {
        // Walk randomly
        const dir = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)];
        instance.bot.setControlState(dir, true);
        setTimeout(() => {
          if (instance.bot) instance.bot.setControlState(dir, false);
        }, 400 + Math.random() * 600);
      } else if (roll < 0.65) {
        // Jump
        instance.bot.setControlState('jump', true);
        setTimeout(() => {
          if (instance.bot) instance.bot.setControlState('jump', false);
        }, 250);
      } else {
        // Look around
        const yaw = (Math.random() * 2 - 1) * Math.PI;
        const pitch = (Math.random() * 2 - 1) * 0.4;
        instance.bot.look(yaw, pitch, false).catch(() => {});
      }
    } catch {}
  }, 12000 + Math.random() * 8000);
}

// ===== 72H FREE TIMER =====
function startFreeTimer(userId, instance, onEvent, addLog) {
  if (instance.freeLimitTimer) clearInterval(instance.freeLimitTimer);

  instance.freeLimitTimer = setInterval(() => {
    const inst = activeBots.get(userId);
    if (!inst) return clearInterval(instance.freeLimitTimer);

    const botRecord = db.getBotById(inst.botId);
    if (!botRecord) return;

    const user = db.getUserByInternalId(botRecord.user_id);
    if (!user) return;

    const premium = isPremiumUser(user);
    if (premium) {
      // Premium user — no limit, stop checking
      clearInterval(instance.freeLimitTimer);
      return;
    }

    const hoursOnline = (Math.floor(Date.now() / 1000) - botRecord.connected_at) / 3600;
    if (hoursOnline >= config.FREE_LIMIT_HOURS) {
      clearInterval(instance.freeLimitTimer);
      addLog('⏰ Лимит 72 часов истёк, отключаюсь...');
      onEvent('free_limit');
      disconnectBot(userId).catch(() => {});
    }
  }, 60 * 1000); // check every minute
}

function isPremiumUser(user) {
  if (!user) return false;
  if (user.premium_type === 'eternal') return true;
  if (user.premium_type === 'monthly' && user.premium_expires > Math.floor(Date.now() / 1000)) return true;
  return false;
}

// ===== DISCONNECT =====
async function disconnectBot(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;

  try { inst.bot.quit(); } catch {}
  _cleanup(userId);
}

function _cleanup(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;

  if (inst.antiAfkInterval) clearInterval(inst.antiAfkInterval);
  if (inst.followInterval) clearInterval(inst.followInterval);
  if (inst.freeLimitTimer) clearInterval(inst.freeLimitTimer);

  try { db.updateBotStatus(inst.botId, 'disconnected'); } catch {}
  activeBots.delete(userId);
}

// ===== STATS =====
function getBotStats(userId) {
  const inst = activeBots.get(userId);
  if (!inst || !inst.bot) return null;

  const bot = inst.bot;
  const botRecord = db.getBotById(inst.botId);

  try {
    const health = Math.round((bot.health || 0) * 10) / 10;
    const food = Math.round(bot.food || 0);
    const gamemodeMap = { 0: 'Выживание', 1: 'Креатив', 2: 'Приключение', 3: 'Наблюдатель' };
    const gamemode = gamemodeMap[bot.game?.gameMode] || 'Неизвестно';

    const timeOfDay = bot.time?.timeOfDay ?? 0;
    const isDay = timeOfDay >= 0 && timeOfDay < 13000;
    const worldTime = isDay ? '☀️ День' : '🌙 Ночь';

    const onlineCount = Object.keys(bot.players || {}).length;

    const connectedAt = botRecord?.connected_at || Math.floor(Date.now() / 1000);
    const uptimeSec = Math.max(0, Math.floor(Date.now() / 1000) - connectedAt);
    const uptimeH = Math.floor(uptimeSec / 3600);
    const uptimeM = Math.floor((uptimeSec % 3600) / 60);

    return {
      username: bot.username,
      server: `${botRecord?.server_host}:${botRecord?.server_port}`,
      version: bot.version || botRecord?.mc_version,
      health,
      food,
      gamemode,
      worldTime,
      onlineCount,
      uptimeH,
      uptimeM,
      opGranted: inst.opGranted,
      waitingForOp: inst.waitingForOp,
      antiAfkEnabled: inst.antiAfkEnabled,
      followTarget: inst.followTarget,
      chatBridgeEnabled: inst.chatBridgeEnabled,
    };
  } catch {
    return null;
  }
}

// ===== CONTROLS =====
function toggleAntiAfk(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return null;

  inst.antiAfkEnabled = !inst.antiAfkEnabled;
  return inst.antiAfkEnabled;
}

function moveBot(userId, direction) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;

  const validDirs = { forward: true, back: true, left: true, right: true, jump: true, sneak: true };
  if (!validDirs[direction]) return false;

  try {
    inst.bot.setControlState(direction, true);
    setTimeout(() => {
      if (inst.bot) inst.bot.setControlState(direction, false);
    }, 500);
    return true;
  } catch {
    return false;
  }
}

async function followPlayer(userId, playerName) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  if (!inst.pathfinderLoaded) return false;

  try {
    const { Movements, goals } = require('mineflayer-pathfinder');
    const mcData = require('minecraft-data')(inst.bot.version);
    const movements = new Movements(inst.bot, mcData);
    inst.bot.pathfinder.setMovements(movements);

    // Stop previous follow
    if (inst.followInterval) {
      clearInterval(inst.followInterval);
      inst.followInterval = null;
    }

    inst.followTarget = playerName;
    inst.followInterval = setInterval(() => {
      if (!inst.bot?.entity) return;
      const target = inst.bot.players[playerName]?.entity;
      if (target) {
        const { GoalFollow } = goals;
        inst.bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
      }
    }, 1000);

    return true;
  } catch {
    return false;
  }
}

function stopFollow(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return;

  if (inst.followInterval) {
    clearInterval(inst.followInterval);
    inst.followInterval = null;
  }
  inst.followTarget = null;

  try {
    if (inst.pathfinderLoaded) inst.bot.pathfinder.setGoal(null);
  } catch {}
}

async function setCreative(userId) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  try {
    inst.bot.chat('/gamemode creative');
    return true;
  } catch {
    return false;
  }
}

function sendChatToMC(userId, message) {
  const inst = activeBots.get(userId);
  if (!inst?.bot) return false;
  try {
    inst.bot.chat(message);
    return true;
  } catch {
    return false;
  }
}

function toggleChatBridge(userId) {
  const inst = activeBots.get(userId);
  if (!inst) return null;
  inst.chatBridgeEnabled = !inst.chatBridgeEnabled;
  return inst.chatBridgeEnabled;
}

function getActionLog(userId) {
  return activeBots.get(userId)?.actionLog || [];
}

module.exports = {
  MC_VERSIONS,
  getActiveBot,
  connectBot,
  disconnectBot,
  getBotStats,
  toggleAntiAfk,
  moveBot,
  followPlayer,
  stopFollow,
  setCreative,
  sendChatToMC,
  toggleChatBridge,
  getActionLog,
  getAllActiveBots: () => [...activeBots.values()],
};
