/**
 * ╔══════════════════════════════════════════════════╗
 * ║   WAR ZONE — WebSocket Game Server (Node.js)    ║
 * ║   يدعم حتى 4 لاعبين + بوتات لتكملة العدد       ║
 * ╚══════════════════════════════════════════════════╝
 * 
 * التثبيت على Railway:
 *   1. ارفع مجلد server/ على GitHub
 *   2. أنشئ مشروع جديد على railway.app
 *   3. اربطه بالـ repo
 *   4. يشتغل تلقائياً!
 *
 * محلياً:
 *   npm install && node server.js
 */

const WebSocket = require('ws');
const crypto    = require('crypto');   // مدمج في Node.js
const PORT      = process.env.PORT || 3001;

// ⚠️ ضع توكن البوت هنا أو في متغيرات البيئة على Render
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

// ── التحقق من initData التيليجرام ──
function verifyTelegramData(initData, botToken) {
  if (!initData || !botToken || botToken === 'YOUR_BOT_TOKEN_HERE') return false;
  try {
    const params   = new URLSearchParams(initData);
    const hash     = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    // رتّب الأزواج أبجدياً وادمجها
    const dataStr  = Array.from(params.entries())
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('\n');
    const secret   = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
    return computed === hash;
  } catch { return false; }
}

// ══════════════════════════════════════
//  ثوابت اللعبة
// ══════════════════════════════════════
const TICK_RATE    = 20;          // 20 ticks/ثانية
const MAX_PLAYERS  = 4;
const MAP_W        = 1200;
const MAP_H        = 1200;
const PLAYER_R     = 16;
const BULLET_SPEED = 420;         // px/ثانية
const BULLET_R     = 5;
const BULLET_TTL   = 1.8;         // ثانية
const PLAYER_SPEED = 180;         // px/ثانية
const HP_MAX       = 100;
const DAMAGE       = 25;
const RESPAWN_TIME = 4000;        // ms
const BOT_THINK    = 800;         // ms بين قرارات البوت

// ══════════════════════════════════════
//  الماب — عناصر ثابتة
// ══════════════════════════════════════
const MAP_OBJECTS = generateMap();

function generateMap() {
  const objs = [];
  // بيوت (مستطيلات كبيرة)
  const houses = [
    {x:120,y:120,w:140,h:100,type:'house'},
    {x:500,y:80,w:120,h:120,type:'house'},
    {x:900,y:150,w:150,h:100,type:'house'},
    {x:100,y:500,w:130,h:110,type:'house'},
    {x:520,y:480,w:160,h:120,type:'house'},
    {x:950,y:520,w:140,h:110,type:'house'},
    {x:200,y:900,w:130,h:100,type:'house'},
    {x:600,y:880,w:150,h:120,type:'house'},
    {x:960,y:920,w:130,h:100,type:'house'},
  ];
  // أحجار (دوائر)
  const rocks = [
    {x:320,y:250,r:30,type:'rock'},
    {x:700,y:200,r:25,type:'rock'},
    {x:380,y:650,r:35,type:'rock'},
    {x:800,y:700,r:28,type:'rock'},
    {x:150,y:750,r:32,type:'rock'},
    {x:650,y:350,r:26,type:'rock'},
    {x:450,y:900,r:30,type:'rock'},
    {x:850,y:400,r:24,type:'rock'},
    {x:250,y:400,r:28,type:'rock'},
    {x:750,y:850,r:30,type:'rock'},
  ];
  // أشجار (دوائر صغيرة)
  const trees = [
    {x:420,y:300,r:18,type:'tree'},
    {x:600,y:550,r:20,type:'tree'},
    {x:300,y:600,r:18,type:'tree'},
    {x:780,y:300,r:22,type:'tree'},
    {x:480,y:750,r:18,type:'tree'},
    {x:850,y:650,r:20,type:'tree'},
    {x:200,y:200,r:18,type:'tree'},
    {x:950,y:750,r:20,type:'tree'},
    {x:350,y:950,r:18,type:'tree'},
    {x:700,y:950,r:20,type:'tree'},
    {x:150,y:350,r:16,type:'tree'},
    {x:1050,y:300,r:18,type:'tree'},
    {x:550,y:200,r:16,type:'tree'},
    {x:900,y:850,r:20,type:'tree'},
  ];
  return [...houses,...rocks,...trees];
}

// تحقق التصادم مع الماب
function collidesWithMap(x, y, r=PLAYER_R) {
  for (const o of MAP_OBJECTS) {
    if (o.type === 'house') {
      if (x+r > o.x && x-r < o.x+o.w && y+r > o.y && y-r < o.y+o.h) return true;
    } else {
      const dx = x - o.x, dy = y - o.y;
      if (Math.sqrt(dx*dx+dy*dy) < r + o.r) return true;
    }
  }
  return false;
}

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

function safePosNear(cx, cy, spread=80) {
  for (let i = 0; i < 50; i++) {
    const x = clamp(cx + (Math.random()-0.5)*spread, PLAYER_R+5, MAP_W-PLAYER_R-5);
    const y = clamp(cy + (Math.random()-0.5)*spread, PLAYER_R+5, MAP_H-PLAYER_R-5);
    if (!collidesWithMap(x, y)) return {x, y};
  }
  return {x: cx, y: cy};
}

const SPAWN_POINTS = [
  {x:60, y:60}, {x:MAP_W-60, y:60},
  {x:60, y:MAP_H-60}, {x:MAP_W-60, y:MAP_H-60},
  {x:MAP_W/2, y:60}, {x:MAP_W/2, y:MAP_H-60},
];

// ══════════════════════════════════════
//  حالة اللعبة
// ══════════════════════════════════════
let players     = {};  // id → player
let bullets     = [];
let nextId      = 1;
let clients     = {};  // id → ws

const COLORS = ['#00f5ff','#ff006e','#39ff14','#ff8c00','#bf00ff','#ffd700'];

function createPlayer(id, name, photo, isBot=false) {
  const spawnIdx = (Object.keys(players).length) % SPAWN_POINTS.length;
  const sp = safePosNear(SPAWN_POINTS[spawnIdx].x, SPAWN_POINTS[spawnIdx].y, 40);
  return {
    id, name: name.slice(0,16), photo: photo||null,
    x: sp.x, y: sp.y, angle: 0,
    vx: 0, vy: 0,
    hp: HP_MAX, maxHp: HP_MAX,
    kills: 0, deaths: 0,
    alive: true,
    respawnAt: 0,
    color: COLORS[id % COLORS.length],
    isBot,
    // bot state
    botTarget: null, botMoveAngle: Math.random()*Math.PI*2, botThinkAt: 0, botFireAt: 0,
  };
}

// ══════════════════════════════════════
//  بوتات
// ══════════════════════════════════════
const BOT_NAMES = ['🤖 AlphaBot','🤖 Nexus','🤖 Cipher','🤖 Reaper'];

function fillBots() {
  const humanCount = Object.values(players).filter(p=>!p.isBot).length;
  const botCount   = Object.values(players).filter(p=>p.isBot).length;
  const need = Math.max(0, Math.min(MAX_PLAYERS-humanCount, 3) - botCount);
  for (let i = 0; i < need; i++) {
    const id = nextId++;
    players[id] = createPlayer(id, BOT_NAMES[botCount+i]||'🤖 Bot', null, true);
  }
}

function removeBots() {
  for (const [id, p] of Object.entries(players)) {
    if (p.isBot) delete players[id];
  }
}

function updateBot(bot, dt) {
  if (!bot.alive) return;
  const now = Date.now();

  // فكر كل BOT_THINK ms
  if (now > bot.botThinkAt) {
    bot.botThinkAt = now + BOT_THINK + Math.random()*400;
    // اختر هدف
    const humans = Object.values(players).filter(p=>!p.isBot&&p.alive);
    const bots   = Object.values(players).filter(p=>p.isBot&&p.alive&&p.id!==bot.id);
    const targets = [...humans,...bots];
    if (targets.length) {
      bot.botTarget = targets[Math.floor(Math.random()*targets.length)];
    } else {
      bot.botTarget = null;
      bot.botMoveAngle = Math.random()*Math.PI*2;
    }
  }

  if (bot.botTarget && bot.botTarget.alive) {
    const t = bot.botTarget;
    const dx = t.x - bot.x, dy = t.y - bot.y;
    const dist = Math.sqrt(dx*dx+dy*dy);
    bot.angle = Math.atan2(dy, dx);

    if (dist > 160) {
      // اتجه نحو الهدف
      bot.botMoveAngle = bot.angle;
    } else {
      // قريب — تحرك بشكل عشوائي
      bot.botMoveAngle += (Math.random()-0.5)*0.5;
    }

    // طلق
    if (dist < 500 && now > bot.botFireAt) {
      bot.botFireAt = now + 600 + Math.random()*400;
      fireBullet(bot);
    }
  }

  // تحرك
  let nx = bot.x + Math.cos(bot.botMoveAngle)*PLAYER_SPEED*dt;
  let ny = bot.y + Math.sin(bot.botMoveAngle)*PLAYER_SPEED*dt;
  nx = clamp(nx, PLAYER_R, MAP_W-PLAYER_R);
  ny = clamp(ny, PLAYER_R, MAP_H-PLAYER_R);
  if (!collidesWithMap(nx, ny)) {
    bot.x = nx; bot.y = ny;
  } else {
    bot.botMoveAngle = Math.random()*Math.PI*2;
  }
}

// ══════════════════════════════════════
//  منطق الطلق
// ══════════════════════════════════════
function fireBullet(player) {
  bullets.push({
    id: nextId++,
    ownerId: player.id,
    x: player.x + Math.cos(player.angle)*(PLAYER_R+6),
    y: player.y + Math.sin(player.angle)*(PLAYER_R+6),
    vx: Math.cos(player.angle)*BULLET_SPEED,
    vy: Math.sin(player.angle)*BULLET_SPEED,
    ttl: BULLET_TTL,
  });
}

// ══════════════════════════════════════
//  Game Tick
// ══════════════════════════════════════
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  // respawn
  for (const p of Object.values(players)) {
    if (!p.alive && now >= p.respawnAt) {
      const spIdx = Math.floor(Math.random()*SPAWN_POINTS.length);
      const sp = safePosNear(SPAWN_POINTS[spIdx].x, SPAWN_POINTS[spIdx].y, 60);
      p.x=sp.x; p.y=sp.y; p.hp=HP_MAX; p.alive=true;
    }
  }

  // بوتات
  for (const p of Object.values(players)) {
    if (p.isBot) updateBot(p, dt);
  }

  // رصاصات
  for (let i = bullets.length-1; i >= 0; i--) {
    const b = bullets[i];
    b.x  += b.vx * dt;
    b.y  += b.vy * dt;
    b.ttl -= dt;

    if (b.ttl <= 0 || b.x<0||b.x>MAP_W||b.y<0||b.y>MAP_H) {
      bullets.splice(i,1); continue;
    }
    // تصادم مع ماب
    if (collidesWithMap(b.x, b.y, BULLET_R)) {
      bullets.splice(i,1); continue;
    }
    // تصادم مع لاعبين
    let hit = false;
    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId) continue;
      const dx=b.x-p.x, dy=b.y-p.y;
      if (Math.sqrt(dx*dx+dy*dy) < PLAYER_R+BULLET_R) {
        p.hp -= DAMAGE;
        hit = true;
        if (p.hp <= 0) {
          p.alive = false;
          p.hp = 0;
          p.deaths++;
          p.respawnAt = now + RESPAWN_TIME;
          const killer = players[b.ownerId];
          if (killer) killer.kills++;
          broadcast({type:'kill', killer: b.ownerId, victim: p.id,
            killerName: killer?.name||'?', victimName: p.name});
        }
        break;
      }
    }
    if (hit) { bullets.splice(i,1); }
  }

  // إرسال state لكل الكلاينتات
  const state = {
    type: 'state',
    players: Object.values(players).map(p=>({
      id:p.id, name:p.name, photo:p.photo,
      tgId:    p.tgId    || null,
      fname:   p.fname   || p.name,
      lname:   p.lname   || '',
      username:p.username|| '',
      x:p.x, y:p.y, angle:p.angle,
      hp:p.hp, maxHp:p.maxHp, alive:p.alive,
      kills:p.kills, deaths:p.deaths,
      color:p.color, isBot:p.isBot,
    })),
    bullets: bullets.map(b=>({id:b.id,x:b.x,y:b.y,ownerId:b.ownerId})),
  };
  broadcast(state);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of Object.values(clients)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ══════════════════════════════════════
//  WebSocket Server
// ══════════════════════════════════════
const wss = new WebSocket.Server({ port: PORT });
console.log(`🎮 War Zone Server running on :${PORT}`);

wss.on('connection', (ws) => {
  const id = nextId++;
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const humanCount = Object.values(players).filter(p=>!p.isBot).length;
      if (humanCount >= MAX_PLAYERS) { ws.send(JSON.stringify({type:'full'})); return; }

      // ── بيانات تيليجرام الكاملة ──
      const tgId    = String(msg.tg_id   || id);
      const name    = String(msg.name    || msg.fname || 'WARRIOR').slice(0,14);
      const fname   = String(msg.fname   || name);
      const lname   = String(msg.lname   || '');
      const username= String(msg.username|| '');
      const photo   = msg.photo || null;

      // التحقق من initData (اختياري في dev، ضروري في production)
      const initData = msg.init_data || '';
      const verified = verifyTelegramData(initData, BOT_TOKEN);
      // لو ما تحقق، نسمح بالدخول لكن نسجّل تحذير
      if (!verified && initData) {
        console.warn(`⚠️ Unverified initData for ${name} (tg_id: ${tgId})`);
      }

      // أنشئ اللاعب مع بيانات TG الكاملة
      player = createPlayer(id, name, photo, false);
      player.tgId    = tgId;     // معرف تيليجرام الحقيقي
      player.fname   = fname;
      player.lname   = lname;
      player.username= username; // @يوزرنيم
      players[id] = player;
      clients[id] = ws;

      // رد الترحيب مع id الداخلي
      ws.send(JSON.stringify({
        type: 'welcome',
        id,
        tgId,
        name,
        fname,
        lname,
        username,
        photo,
        map:  MAP_OBJECTS,
        mapW: MAP_W,
        mapH: MAP_H,
      }));

      removeBots(); fillBots();
      const displayName = username ? `${name} (@${username})` : name;
      broadcast({type:'chat', name:'🎮 SERVER', text:`⚔️ ${displayName} دخل المعركة!`});
      return;
    }

    if (!player) return;

    if (msg.type === 'move') {
      if (!player.alive) return;
      const spd = PLAYER_SPEED * (1/TICK_RATE);
      let nx = player.x + (msg.vx||0)*spd;
      let ny = player.y + (msg.vy||0)*spd;
      nx = clamp(nx, PLAYER_R, MAP_W-PLAYER_R);
      ny = clamp(ny, PLAYER_R, MAP_H-PLAYER_R);
      if (!collidesWithMap(nx, ny)) { player.x=nx; player.y=ny; }
      if (msg.angle !== undefined) player.angle = msg.angle;
    }

    if (msg.type === 'fire') {
      if (!player.alive) return;
      if (msg.angle !== undefined) player.angle = msg.angle;
      fireBullet(player);
    }

    if (msg.type === 'chat') {
      broadcast({type:'chat', name:player.name, text:(msg.text||'').slice(0,80)});
    }
  });

  ws.on('close', () => {
    if (player) {
      broadcast({type:'chat', name:'🎮 SERVER', text:`${player.name} غادر المعركة`});
      delete players[id];
      delete clients[id];
      removeBots(); fillBots();
    }
  });

  ws.on('error', () => {
    delete clients[id];
    if (player) { delete players[id]; removeBots(); fillBots(); }
  });
});

// ── Tick loop ──
setInterval(tick, 1000/TICK_RATE);
