const express = require('express');
const router  = express.Router();
const db  = require('./db');
const mc  = require('./mcManager');

// ─── Auth helper ──────────────────────────────────────────────────────────────
function getUserId(str) {
  if (!str) return null;
  if (str.startsWith('dev_')) return parseInt(str.slice(4)) || null;
  try {
    const p = new URLSearchParams(str);
    const u = p.get('user');
    if (u) return JSON.parse(u).id;
  } catch {}
  return null;
}
function auth(req) {
  return getUserId(req.query.tgData || (req.body && req.body.tgData));
}
function getUser(telegramId) {
  return db.getUser(telegramId);
}
function isPremium(u) {
  if (!u) return false;
  if (u.premium_type === 'eternal') return true;
  if (u.premium_type === 'monthly' && u.premium_expires > Math.floor(Date.now()/1000)) return true;
  return false;
}
function isEternal(u) { return u?.premium_type === 'eternal'; }

// ─── /api/me & /api/status ───────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false, error: 'unauthorized' });
  const user = getUser(tid);
  if (!user) return res.json({ ok: false, error: 'user_not_found' });
  res.json({ ok: true, user });
});

router.get('/status', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false, error: 'unauthorized' });
  const user = getUser(tid);
  if (!user) return res.json({ ok: false, error: 'user_not_found' });

  const activeBots = db.getAllActiveBots().filter(b => b.telegram_id === tid);
  const bots = activeBots.map(b => {
    const inst = mc.getActiveBotByBotId(b.id);
    const stats = mc.getBotStats(b.id);
    return { ...b, players: stats?.onlineCount ?? 0, sessionId: inst?.sessionId ?? null };
  });
  const recentServers = db.getRecentServers(tid);
  const savedServers  = db.getSavedServers(tid);

  res.json({ ok: true, user, bots, recentServers, savedServers });
});

// ─── /api/bot/:id ────────────────────────────────────────────────────────────
router.get('/bot/:id', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false, error: 'unauthorized' });
  const botRec = db.getBotById(req.params.id);
  if (!botRec) return res.json({ ok: false, error: 'not_found' });
  const user = db.getUserByInternalId(botRec.user_id);
  if (!user || user.telegram_id !== tid) return res.json({ ok: false, error: 'forbidden' });

  const stats  = mc.getBotStats(botRec.id);
  const log    = mc.getActionLog(botRec.id);
  const inst   = mc.getActiveBotByBotId(botRec.id);
  const players = inst?.bot ? Object.values(inst.bot.players || {}).map(p => ({
    name: p.username, ping: p.ping,
  })) : [];

  res.json({
    ok: true,
    bot: botRec,
    stats,
    log: log.slice(0, 30),
    players,
    messages: inst?.chatLog?.slice(0, 40) || [],
    reconnect: inst?.autoReconnect ?? false,
  });
});

// ─── Toggle ───────────────────────────────────────────────────────────────────
router.post('/bot/:id/toggle', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const user = db.getUserByInternalId(botRec?.user_id);
  if (!user || user.telegram_id !== tid) return res.json({ ok: false });

  const { key } = req.body;
  let value, message;
  const botId = botRec.id;

  if (key === 'afk') {
    value = mc.toggleAntiAfk(botId);
    message = value ? '🟢 Анти-АФК включён' : '🔴 Анти-АФК выключен';
  } else if (key === 'chat') {
    value = mc.toggleChatBridge(botId);
    message = value ? '💬 Чат-мост включён' : '💬 Чат-мост выключен';
  } else if (key === 'reconnect') {
    value = mc.toggleAutoReconnect(botId);
    message = value ? '🔁 Авто-реконнект включён' : '🔁 Авто-реконнект выключен';
  }

  res.json({ ok: true, value, message });
});

// ─── OP / Creative ───────────────────────────────────────────────────────────
router.post('/bot/:id/op', async (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const ok = await mc.setCreative(botRec?.id);
  res.json({ ok });
});

// ─── Movement ─────────────────────────────────────────────────────────────────
router.post('/bot/:id/move', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const { dir } = req.body;
  const inst = mc.getActiveBotByBotId(botRec?.id);
  if (dir === 'stop') {
    if (inst?.bot) {
      for (const d of ['forward','back','left','right','jump','sneak']) {
        try { inst.bot.setControlState(d, false); } catch {}
      }
    }
  } else {
    mc.moveBot(botRec?.id, dir);
  }
  res.json({ ok: true });
});

// ─── Follow ───────────────────────────────────────────────────────────────────
router.post('/bot/:id/follow', async (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const ok = await mc.followPlayer(botRec?.id, req.body.player);
  res.json({ ok });
});

router.post('/bot/:id/follow/stop', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  mc.stopFollow(botRec?.id);
  res.json({ ok: true });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
router.get('/bot/:id/chat', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const inst = mc.getActiveBotByBotId(botRec?.id);
  const raw = inst?.chatLog || [];
  const messages = raw.slice(0, 50).map(m => ({
    name: m.playerName,
    text: m.message,
    time: new Date(m.ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }),
  }));
  res.json({ ok: true, messages });
});

router.post('/bot/:id/chat', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  const ok = mc.sendChatToMC(botRec?.id, req.body.message);
  res.json({ ok });
});

// ─── Disconnect ───────────────────────────────────────────────────────────────
router.post('/bot/:id/disconnect', async (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  if (botRec) await mc.disconnectBotById(botRec.id);
  res.json({ ok: true });
});

// ─── Screenshot ───────────────────────────────────────────────────────────────
router.post('/bot/:id/screenshot', async (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  if (!botRec) return res.json({ ok: false, error: 'not_found' });
  const user = db.getUserByInternalId(botRec.user_id);
  if (!user || user.telegram_id !== tid) return res.json({ ok: false, error: 'forbidden' });

  try {
    const buf = await mc.takeScreenshot(botRec.id);
    if (!buf) return res.json({ ok: false, error: 'canvas_unavailable' });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Inventory ────────────────────────────────────────────────────────────────
router.get('/bot/:id/inventory', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const botRec = db.getBotById(req.params.id);
  if (!botRec) return res.json({ ok: false });

  const inst = mc.getActiveBotByBotId(botRec.id);
  if (!inst?.bot) return res.json({ ok: true, items: [] });

  try {
    const slots = [];
    // Hotbar + inventory (slots 36-44 = hotbar, 9-35 = inventory, 5-8 = armor)
    const bot = inst.bot;

    // Armor
    const armorSlots = [
      { slot: 5, label: 'Шлем' }, { slot: 6, label: 'Нагрудник' },
      { slot: 7, label: 'Поножи' }, { slot: 8, label: 'Ботинки' },
    ];
    for (const { slot, label } of armorSlots) {
      const item = bot.inventory.slots[slot];
      slots.push({ slot, label, item: item ? { name: item.displayName || item.name, count: item.count } : null });
    }

    // Hotbar (9 slots visible first)
    for (let i = 36; i <= 44; i++) {
      const item = bot.inventory.slots[i];
      slots.push({ slot: i, label: `Хотбар ${i-35}`, item: item ? { name: item.displayName || item.name, count: item.count } : null });
    }

    // Main inventory
    for (let i = 9; i <= 35; i++) {
      const item = bot.inventory.slots[i];
      if (item) slots.push({ slot: i, label: `Слот ${i}`, item: { name: item.displayName || item.name, count: item.count } });
    }

    // Hand
    const hand = bot.inventory.slots[bot.quickBarSlot + 36];
    const equippedName = hand ? (hand.displayName || hand.name) : null;

    res.json({ ok: true, items: slots, equippedSlot: bot.quickBarSlot, equippedName });
  } catch (e) {
    res.json({ ok: true, items: [], error: e.message });
  }
});

// ─── Server ping ──────────────────────────────────────────────────────────────
router.get('/server-ping', async (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const { host, port } = req.query;
  if (!host) return res.json({ ok: false, error: 'no_host' });

  try {
    const result = await mc.pingServer(host, parseInt(port) || 25565);
    if (!result) return res.json({ ok: false, error: 'offline' });

    // Parse MOTD (can be string or chat object)
    let motd = '';
    if (typeof result.description === 'string') motd = result.description;
    else if (result.description?.text) motd = result.description.text;
    else if (result.description?.extra) {
      motd = result.description.extra.map(e => e.text || '').join('');
    }
    motd = motd.replace(/§[0-9a-fk-or]/gi, '').trim();

    res.json({
      ok: true,
      motd,
      version: result.version?.name || '?',
      protocol: result.version?.protocol,
      online: result.players?.online ?? 0,
      max: result.players?.max ?? 0,
      players: (result.players?.sample || []).map(p => p.name),
      favicon: result.favicon || null,
      ping: result.latency || null,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Saved servers ────────────────────────────────────────────────────────────
router.get('/saved-servers', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const servers = db.getSavedServers(tid);
  res.json({ ok: true, servers });
});

router.post('/saved-servers', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const { label, host, port, version } = req.body;
  if (!host || !version) return res.json({ ok: false, error: 'missing fields' });
  try {
    db.addSavedServer(tid, label || host, host, parseInt(port) || 25565, version);
    res.json({ ok: true, servers: db.getSavedServers(tid) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.delete('/saved-servers/:id', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  db.deleteSavedServer(req.params.id, tid);
  res.json({ ok: true, servers: db.getSavedServers(tid) });
});

// ─── Sessions history ─────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  const tid = auth(req);
  if (!tid) return res.json({ ok: false });
  const sessions = db.getSessions(tid, 30).map(s => ({
    ...s,
    durationFmt: fmtDuration(s.duration_seconds),
    connectedFmt: fmtDate(s.connected_at),
  }));
  res.json({ ok: true, sessions });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDuration(secs) {
  if (!secs) return '< 1м';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `${h}ч ${m}м` : `${m}м`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

module.exports = router;
