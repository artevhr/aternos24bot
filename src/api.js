const express = require('express');
const router = express.Router();
const db = require('./db');
const mc = require('./mcManager');

function getUserId(tgDataStr) {
  if (!tgDataStr) return null;
  if (tgDataStr.startsWith('dev_')) return parseInt(tgDataStr.slice(4)) || null;
  try {
    const params = new URLSearchParams(tgDataStr);
    const userStr = params.get('user');
    if (userStr) return JSON.parse(userStr).id;
  } catch {}
  return null;
}

// GET /api/me — alias used by older frontend
router.get('/me', (req, res) => {
  const telegramId = getUserId(req.query.tgData);
  if (!telegramId) return res.json({ ok: false, error: 'unauthorized' });
  const user = db.getUser(telegramId);
  if (!user) return res.json({ ok: false, error: 'user_not_found' });
  res.json({ ok: true, user });
});

router.get('/status', (req, res) => {
  const telegramId = getUserId(req.query.tgData);
  if (!telegramId) return res.json({ ok: false, error: 'unauthorized' });

  const user = db.getUser(telegramId);
  if (!user) return res.json({ ok: false, error: 'user_not_found' });

  const activeBots = db.getAllActiveBots().filter(b => b.telegram_id === telegramId);
  const botsWithStats = activeBots.map(b => {
    const stats = mc.getBotStats(telegramId);
    return { ...b, players: stats?.onlineCount ?? 0 };
  });

  res.json({ ok: true, user, bots: botsWithStats });
});

router.get('/bot/:id', (req, res) => {
  const telegramId = getUserId(req.query.tgData);
  if (!telegramId) return res.json({ ok: false, error: 'unauthorized' });

  const botRecord = db.getBotById(req.params.id);
  if (!botRecord) return res.json({ ok: false, error: 'not_found' });

  const user = db.getUserByInternalId(botRecord.user_id);
  if (!user || user.telegram_id !== telegramId) return res.json({ ok: false, error: 'forbidden' });

  const stats = mc.getBotStats(telegramId);
  const log = mc.getActionLog(telegramId);
  const inst = mc.getActiveBot(telegramId);

  const players = inst?.bot ? Object.values(inst.bot.players || {}).map(p => ({
    name: p.username, ping: p.ping,
  })) : [];

  res.json({
    ok: true,
    bot: botRecord,
    stats,
    log: log.slice(0, 30),
    players,
    messages: inst?.chatLog || [],
    reconnect: inst?.autoReconnect || false,
  });
});

router.post('/bot/:id/toggle', (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });

  const botRecord = db.getBotById(req.params.id);
  const user = db.getUserByInternalId(botRecord?.user_id);
  if (!user || user.telegram_id !== telegramId) return res.json({ ok: false });

  const { key } = req.body;
  let value, message;

  if (key === 'afk') {
    value = mc.toggleAntiAfk(telegramId);
    message = value ? '🟢 Анти-АФК включён' : '🔴 Анти-АФК выключен';
  } else if (key === 'chat') {
    value = mc.toggleChatBridge(telegramId);
    message = value ? '💬 Чат-мост включён' : '💬 Чат-мост выключен';
  } else if (key === 'reconnect') {
    const inst = mc.getActiveBot(telegramId);
    if (inst) { inst.autoReconnect = !inst.autoReconnect; value = inst.autoReconnect; }
    message = value ? '🔁 Авто-реконнект включён' : '🔁 Авто-реконнект выключен';
  }

  res.json({ ok: true, value, message });
});

router.post('/bot/:id/op', async (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  const ok = await mc.setCreative(telegramId);
  res.json({ ok });
});

router.post('/bot/:id/move', (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  const { dir } = req.body;
  if (dir === 'stop') {
    const inst = mc.getActiveBot(telegramId);
    if (inst?.bot) {
      for (const d of ['forward','back','left','right','jump','sneak']) {
        try { inst.bot.setControlState(d, false); } catch {}
      }
    }
  } else {
    mc.moveBot(telegramId, dir);
  }
  res.json({ ok: true });
});

router.post('/bot/:id/follow', async (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  const ok = await mc.followPlayer(telegramId, req.body.player);
  res.json({ ok });
});

router.post('/bot/:id/follow/stop', (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  mc.stopFollow(telegramId);
  res.json({ ok: true });
});

router.get('/bot/:id/chat', (req, res) => {
  const telegramId = getUserId(req.query.tgData);
  if (!telegramId) return res.json({ ok: false });
  const inst = mc.getActiveBot(telegramId);
  res.json({ ok: true, messages: inst?.chatLog || [] });
});

router.post('/bot/:id/chat', (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  const ok = mc.sendChatToMC(telegramId, req.body.message);
  res.json({ ok });
});

router.post('/bot/:id/disconnect', async (req, res) => {
  const telegramId = getUserId(req.body.tgData);
  if (!telegramId) return res.json({ ok: false });
  await mc.disconnectBot(telegramId);
  res.json({ ok: true });
});

module.exports = router;
