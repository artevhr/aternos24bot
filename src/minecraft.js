const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const config = require('./config')

class BotManager {
  constructor() {
    this.bots = new Map()       // telegramId → session
    this.freeTimers = new Map() // telegramId → setTimeout handle
    this.telegram = null        // set after Telegraf bot is created
  }

  setTelegram(telegram) {
    this.telegram = telegram
  }

  // ─────────────────────────────────────────────
  //  Connect
  // ─────────────────────────────────────────────
  connect(telegramId, host, port, sequentialId, isPremium) {
    return new Promise((resolve, reject) => {
      if (this.bots.has(telegramId)) this.disconnect(telegramId)

      const username = `whminebot-${sequentialId}`
      let spawned = false

      let bot
      try {
        bot = mineflayer.createBot({
          host: host.trim(),
          port: parseInt(port),
          username,
          auth: 'offline',
          version: false,
          hideErrors: false,
          checkTimeoutInterval: 30000,
        })
        bot.loadPlugin(pathfinder)
      } catch (err) {
        return reject(err)
      }

      const session = {
        bot,
        host: host.trim(),
        port: parseInt(port),
        username,
        telegramId,
        connectedAt: Date.now(),
        antiAfkEnabled: true,
        antiAfkInterval: null,
        opRequested: false,
        opStatus: false,
        chatBridgeGroup: null,
        followTarget: null,
        disconnecting: false,
        actionLog: [],
        isPremium,
      }

      // 30-second connect timeout
      const connectTimeout = setTimeout(() => {
        if (!spawned) {
          try { bot.end() } catch (_) {}
          reject(new Error('Таймаут подключения (30с). Проверьте IP и порт.'))
        }
      }, 30000)

      bot.once('spawn', () => {
        spawned = true
        clearTimeout(connectTimeout)
        this.bots.set(telegramId, session)
        this._startAntiAfk(telegramId)
        this._log(telegramId, `✅ Подключён к ${host}:${port}`)

        // 72-hour free limit
        if (!isPremium) {
          const handle = setTimeout(() => {
            this.disconnect(telegramId)
            this._notify(telegramId,
              `⏰ <b>Бесплатный лимит 72 часа истёк.</b>\n` +
              `Бот отключён от сервера.\n\n` +
              `Подключите снова или перейдите на ⭐ Premium — бот будет работать бесконечно.`
            )
          }, config.FREE_LIMIT_HOURS * 3600 * 1000)
          this.freeTimers.set(telegramId, handle)
        }

        resolve({ username })
      })

      bot.once('error', err => {
        clearTimeout(connectTimeout)
        if (!spawned) reject(err)
        else this._handleDisconnect(telegramId, `Ошибка: ${err.message}`)
      })

      bot.once('kicked', reason => {
        let msg = reason
        try { const p = JSON.parse(reason); msg = p.text || p.translate || reason } catch (_) {}
        this._handleDisconnect(telegramId, `Кик: ${msg}`)
      })

      bot.on('end', reason => {
        if (!session.disconnecting) {
          this._handleDisconnect(telegramId, reason || 'Соединение закрыто')
        }
      })

      // Chat bridge: MC → TG
      bot.on('chat', (playerName, message) => {
        if (playerName === bot.username) return
        this._log(telegramId, `💬 ${playerName}: ${message}`)
        const s = this.bots.get(telegramId)
        if (s?.chatBridgeGroup) {
          this._notify(s.chatBridgeGroup,
            `🎮 <b>${playerName}</b>: ${message}`
          )
        }
      })
    })
  }

  // ─────────────────────────────────────────────
  //  Disconnect
  // ─────────────────────────────────────────────
  disconnect(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return
    s.disconnecting = true
    this._clearFreeTimer(telegramId)
    if (s.antiAfkInterval) clearInterval(s.antiAfkInterval)
    try { s.bot.quit('Disconnected by user') } catch (_) {}
    this.bots.delete(telegramId)
  }

  _handleDisconnect(telegramId, reason) {
    const s = this.bots.get(telegramId)
    if (!s || s.disconnecting) return
    s.disconnecting = true
    this._clearFreeTimer(telegramId)
    if (s.antiAfkInterval) clearInterval(s.antiAfkInterval)
    this.bots.delete(telegramId)

    this._notify(telegramId,
      `⚠️ <b>Бот отключился от сервера</b>\nПричина: ${reason}`,
      { inline_keyboard: [
        [{ text: '🔄 Переподключить', callback_data: 'reconnect' }, { text: '🏠 Меню', callback_data: 'main_menu' }]
      ]}
    )
  }

  // ─────────────────────────────────────────────
  //  Anti-AFK
  // ─────────────────────────────────────────────
  _startAntiAfk(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return
    if (s.antiAfkInterval) clearInterval(s.antiAfkInterval)

    s.antiAfkInterval = setInterval(() => {
      const sess = this.bots.get(telegramId)
      if (!sess || !sess.antiAfkEnabled || sess.disconnecting) return
      const dirs = ['forward', 'back', 'left', 'right']
      const dir = dirs[Math.floor(Math.random() * dirs.length)]
      try {
        sess.bot.setControlState(dir, true)
        setTimeout(() => {
          try {
            if (this.bots.has(telegramId)) sess.bot.setControlState(dir, false)
          } catch (_) {}
        }, 300 + Math.random() * 400)
        this._log(telegramId, `🚶 АФК-шаг: ${dir}`)
      } catch (_) {}
    }, 3 * 60 * 1000) // every 3 min
  }

  toggleAntiAfk(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return null
    s.antiAfkEnabled = !s.antiAfkEnabled
    return s.antiAfkEnabled
  }

  // ─────────────────────────────────────────────
  //  OP
  // ─────────────────────────────────────────────
  requestOp(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    s.opRequested = true
    return true
  }

  confirmOp(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    s.opStatus = true
    s.opRequested = false
    try {
      s.bot.chat('/gamemode creative')
      setTimeout(() => {
        try { s.bot.chat('/effect give @s minecraft:saturation 1000000 255 true') } catch (_) {}
      }, 600)
      this._log(telegramId, '👑 OP получен — включён творческий режим')
    } catch (_) {}
    return true
  }

  cancelOpRequest(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return
    s.opRequested = false
  }

  // ─────────────────────────────────────────────
  //  Movement (Premium)
  // ─────────────────────────────────────────────
  move(telegramId, control) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    try {
      s.bot.setControlState(control, true)
      setTimeout(() => {
        try { if (this.bots.has(telegramId)) s.bot.setControlState(control, false) } catch (_) {}
      }, 500)
      const icons = { forward: '↑', back: '↓', left: '←', right: '→', jump: '⎵', sneak: '⇧' }
      this._log(telegramId, `🕹️ Движение: ${icons[control] || control}`)
      return true
    } catch (_) { return false }
  }

  followPlayer(telegramId, playerName) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    try {
      const target = s.bot.players[playerName]?.entity
      if (!target) return false
      const movements = new Movements(s.bot)
      s.bot.pathfinder.setMovements(movements)
      s.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      s.followTarget = playerName
      this._log(telegramId, `👤 Следую за ${playerName}`)
      return true
    } catch (_) { return false }
  }

  stopFollow(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return
    try { s.bot.pathfinder.stop() } catch (_) {}
    s.followTarget = null
    this._log(telegramId, '🛑 Следование остановлено')
  }

  getPlayers(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return []
    try {
      return Object.keys(s.bot.players).filter(p => p !== s.bot.username)
    } catch (_) { return [] }
  }

  // ─────────────────────────────────────────────
  //  Chat bridge (Premium)
  // ─────────────────────────────────────────────
  sendChat(telegramId, message) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    try {
      s.bot.chat(message)
      this._log(telegramId, `📤 [TG→MC]: ${message}`)
      return true
    } catch (_) { return false }
  }

  setChatBridge(telegramId, groupId) {
    const s = this.bots.get(telegramId)
    if (!s) return false
    s.chatBridgeGroup = groupId
    return true
  }

  disableChatBridge(telegramId) {
    const s = this.bots.get(telegramId)
    if (s) s.chatBridgeGroup = null
  }

  // ─────────────────────────────────────────────
  //  Info & utils
  // ─────────────────────────────────────────────
  getInfo(telegramId) {
    const s = this.bots.get(telegramId)
    if (!s) return null
    const bot = s.bot
    const uptimeSec = Math.floor((Date.now() - s.connectedAt) / 1000)
    const h = Math.floor(uptimeSec / 3600)
    const m = Math.floor((uptimeSec % 3600) / 60)
    const sec = uptimeSec % 60

    let health = '?', food = '?', gamemode = '?', position = '?', worldTime = '?', online = '?'

    try { health = Math.floor(bot.health) } catch (_) {}
    try { food = Math.floor(bot.food) } catch (_) {}
    try {
      const modes = ['Выживание', 'Творческий', 'Приключение', 'Наблюдатель']
      gamemode = modes[bot.game.gameMode] ?? `Режим ${bot.game.gameMode}`
    } catch (_) {}
    try {
      const p = bot.entity.position
      position = `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`
    } catch (_) {}
    try {
      const ticks = bot.time.timeOfDay
      const hrs = Math.floor(ticks / 1000 + 6) % 24
      const mins = Math.floor(((ticks % 1000) / 1000) * 60)
      worldTime = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
    } catch (_) {}
    try { online = Object.keys(bot.players).length } catch (_) {}

    let freeTimeLeft = null
    if (!s.isPremium) {
      const elapsed = Date.now() - s.connectedAt
      const remaining = Math.max(0, config.FREE_LIMIT_HOURS * 3600 * 1000 - elapsed)
      const rh = Math.floor(remaining / 3600000)
      const rm = Math.floor((remaining % 3600000) / 60000)
      freeTimeLeft = `${rh}ч ${rm}м`
    }

    return {
      uptime: `${h}ч ${m}м ${sec}с`,
      health, food, gamemode, position, worldTime, online,
      opStatus: s.opStatus,
      opRequested: s.opRequested,
      antiAfkEnabled: s.antiAfkEnabled,
      host: s.host,
      port: s.port,
      username: s.username,
      chatBridgeEnabled: !!s.chatBridgeGroup,
      chatBridgeGroup: s.chatBridgeGroup,
      followTarget: s.followTarget,
      freeTimeLeft,
      isPremium: s.isPremium,
    }
  }

  isConnected(telegramId) {
    return this.bots.has(telegramId)
  }

  getActionLog(telegramId) {
    return this.bots.get(telegramId)?.actionLog || []
  }

  getAllBots() {
    return Array.from(this.bots.entries()).map(([uid, s]) => ({
      telegramId: uid,
      username: s.username,
      host: s.host,
      port: s.port,
      connectedAt: s.connectedAt,
      isPremium: s.isPremium,
    }))
  }

  clearFreeTimerOnUpgrade(telegramId) {
    this._clearFreeTimer(telegramId)
    const s = this.bots.get(telegramId)
    if (s) s.isPremium = true
  }

  // ─────────────────────────────────────────────
  //  Internal helpers
  // ─────────────────────────────────────────────
  _log(telegramId, msg) {
    const s = this.bots.get(telegramId)
    if (!s) return
    s.actionLog.push(msg)
    if (s.actionLog.length > 50) s.actionLog.shift()
  }

  _clearFreeTimer(telegramId) {
    const h = this.freeTimers.get(telegramId)
    if (h) { clearTimeout(h); this.freeTimers.delete(telegramId) }
  }

  _notify(chatId, text, reply_markup) {
    if (!this.telegram) return
    const opts = { parse_mode: 'HTML' }
    if (reply_markup) opts.reply_markup = reply_markup
    this.telegram.sendMessage(chatId, text, opts).catch(() => {})
  }
}

module.exports = new BotManager()
