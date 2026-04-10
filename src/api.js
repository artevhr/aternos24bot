const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const mc = require('./mcManager');
const config = require('./config');

const router = express.Router();

// ─── Telegram initData validation ────────────────────────────────────────────
function validateTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (hash !== expectedHash) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch { return null; }
}

// Middleware — extract user from initData or dev fallback
router.use((req, res, next) => {
  const initData = req.headers['x-telegram-init-data'] || req.query.initData || '';

  if (initData) {
    const user = validateTelegramData(initData);
    if (!user?.id) return res.status(401).json({ error: 'Invalid auth' });
    req.tgUser = user;
  } else if (process.env.NODE_ENV !== 'production' && req.query.dev_id) {
    // Dev mode: pass ?dev_id=YOUR_TG_ID
    req.tgUser = { id: parseInt(req.query.dev_id) };
  } else {
    return res.status(401).json({ error: 'No auth' });
  }
  next();
});

// ─── GET /api/me — user info + bots ─────────────────────────────────────────
router.get('/me', (req, res) => {
  const userId = req.tgUser.id;
  const user = db.getUser(userId);
  if (!user) return res.json({ user: null, bots: [] });

  const activeBots = mc.getActiveBotsForUser(userId);
  const bots = activeBots.map(inst => {
    const stats = mc.getBotStats(inst.botId);
    const rec = db.getBotById(inst.botId);
    return {
      botId: inst.botId,
      username: inst.bot?.username || rec?.mc_username || '?',
      server: rec ? `${rec.server_host}:${rec.server_port}` : '?',
      version: rec?.mc_version || '?',
      status: 'online',
      health: stats?.health ?? 0,
      food: stats?.food ?? 0,
      gamemode: stats?.gamemode ?? '?',
      uptimeH: stats?.uptimeH ?? 0,
      uptimeM: stats?.uptimeM ?? 0,
      totalH: stats?.totalH ?? 0,
      totalM: stats?.totalM ?? 0,
      worldTime: stats?.worldTime ?? '?',
      onlineCount: stats?.onlineCount ?? 0,
      opGranted: stats?.opGranted ?? false,
      antiAfkEnabled: stats?.antiAfkEnabled ?? true,
      autoReconnect: stats?.autoReconnect ?? true,
      noAds: stats?.noAds ?? false,
      chatBridgeEnabled: stats?.chatBridgeEnabled ?? false,
      avatarUrl: `https://crafatar.com/avatars/${encodeURIComponent(inst.bot?.username || '?')}?size=64&overlay=true`,
    };
  });

  const { isPremium, isEternal } = require('./helpers');
  res.json({
    user: {
      id: user.telegram_id,
      username: user.username,
      premiumType: user.premium_type,
      premiumExpires: user.premium_expires,
      isPremium: isPremium(user),
      isEternal: isEternal(user),
    },
    bots,
  });
});

// ─── GET /api/bot/:botId/players ─────────────────────────────────────────────
router.get('/bot/:botId/players', (req, res) => {
  const botId = parseInt(req.params.botId);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst || inst.userId !== req.tgUser.id) return res.status(403).json({ error: 'Access denied' });

  const players = mc.getOnlinePlayers(botId) || [];
  res.json({
    players: players.map(nick => ({
      nick,
      avatarUrl: `https://crafatar.com/avatars/${encodeURIComponent(nick)}?size=64&overlay=true`,
    })),
  });
});

// ─── GET /api/bot/:botId/log ──────────────────────────────────────────────────
router.get('/bot/:botId/log', (req, res) => {
  const botId = parseInt(req.params.botId);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst || inst.userId !== req.tgUser.id) return res.status(403).json({ error: 'Access denied' });

  res.json({ log: mc.getActionLog(botId).slice(0, 50) });
});

// ─── GET /api/bot/:botId/chat ─────────────────────────────────────────────────
router.get('/bot/:botId/chat', (req, res) => {
  const botId = parseInt(req.params.botId);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst || inst.userId !== req.tgUser.id) return res.status(403).json({ error: 'Access denied' });

  res.json({ messages: mc.getChatLog(botId).slice(0, 30) });
});

// ─── POST /api/bot/:botId/action ──────────────────────────────────────────────
router.post('/bot/:botId/action', express.json(), async (req, res) => {
  const botId = parseInt(req.params.botId);
  const inst = mc.getActiveBotByBotId(botId);
  if (!inst || inst.userId !== req.tgUser.id) return res.status(403).json({ error: 'Access denied' });

  const { action, value } = req.body;

  switch (action) {
    case 'toggle_afk': {
      const result = mc.toggleAntiAfk(botId);
      return res.json({ ok: true, value: result });
    }
    case 'toggle_reconnect': {
      const result = mc.toggleAutoReconnect(botId);
      return res.json({ ok: true, value: result });
    }
    case 'toggle_ads': {
      const result = mc.toggleNoAds(botId);
      return res.json({ ok: true, value: result });
    }
    case 'toggle_chat': {
      const result = mc.toggleChatBridge(botId);
      return res.json({ ok: true, value: result });
    }
    case 'set_creative': {
      const ok = await mc.setCreative(botId);
      return res.json({ ok });
    }
    case 'send_chat': {
      if (!value) return res.status(400).json({ error: 'No message' });
      const ok = mc.sendChatToMC(botId, String(value).slice(0, 256));
      return res.json({ ok });
    }
    case 'move': {
      const dirs = ['forward', 'back', 'left', 'right', 'jump', 'sneak'];
      if (!dirs.includes(value)) return res.status(400).json({ error: 'Bad direction' });
      const ok = mc.moveBot(botId, value);
      return res.json({ ok });
    }
    case 'disconnect': {
      await mc.disconnectBotById(botId);
      return res.json({ ok: true });
    }
    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
});

module.exports = router;
