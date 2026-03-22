/**
 * FPS Server — حتى 20 لاعب، ماب صغير، 30 tick/s
 * npm install ws && node fps_server.js
 */
const WebSocket = require('ws');
const PORT = process.env.PORT || 3002;

// ── ثوابت اللعبة ──
const TICK       = 1000 / 30;
const MAX_P      = 20;
const HP         = 100;
const DAMAGE     = 25;       // 4 رصاصات للموت
const RESPAWN    = 4000;
const MAP        = 24;       // نصف حجم الماب (ماب 48×48 وحدة)
const P_SPD      = 7;
const P_R        = 0.35;
const B_SPD      = 28;
const B_TTL      = 1.6;

// ── الماب: جدران + صناديق ──
// كل عنصر: {x,z,w,d,h} — بسيط وصغير
const WALLS = [
  // حدود خارجية
  {x:0,   z:-MAP, w:MAP*2+1, d:0.5,  h:3},
  {x:0,   z:MAP,  w:MAP*2+1, d:0.5,  h:3},
  {x:-MAP, z:0,   w:0.5, d:MAP*2,    h:3},
  {x:MAP,  z:0,   w:0.5, d:MAP*2,    h:3},
  // صناديق مركزية
  {x:0,   z:0,  w:3, d:3, h:1.5},
  {x:-8,  z:0,  w:2, d:6, h:2},
  {x:8,   z:0,  w:2, d:6, h:2},
  {x:0,   z:-8, w:6, d:2, h:2},
  {x:0,   z:8,  w:6, d:2, h:2},
  // حواجز زوايا
  {x:-15, z:-15, w:4, d:4, h:2.5},
  {x:15,  z:-15, w:4, d:4, h:2.5},
  {x:-15, z:15,  w:4, d:4, h:2.5},
  {x:15,  z:15,  w:4, d:4, h:2.5},
  // حواجز منتصف الجوانب
  {x:-MAP+4, z:0,  w:3, d:8, h:2},
  {x:MAP-4,  z:0,  w:3, d:8, h:2},
  {x:0, z:-MAP+4,  w:8, d:3, h:2},
  {x:0, z:MAP-4,   w:8, d:3, h:2},
];

const SPAWNS = [
  {x:-20,z:-20},{x:20,z:-20},{x:-20,z:20},{x:20,z:20},
  {x:0,z:-20},  {x:0,z:20},  {x:-20,z:0},{x:20,z:0},
  {x:-10,z:-20},{x:10,z:-20},{x:-10,z:20},{x:10,z:20},
  {x:-20,z:-10},{x:-20,z:10},{x:20,z:-10},{x:20,z:10},
  {x:-5,z:-18}, {x:5,z:-18}, {x:-5,z:18},{x:5,z:18},
];

const COLORS = [
  '#ff006e','#00f5ff','#39ff14','#ff8c00','#bf00ff',
  '#ffd700','#ff4444','#44ffff','#ff44ff','#44ff88',
  '#88ff44','#4488ff','#ff8844','#44ffff','#ffaa00',
  '#00ffaa','#aa00ff','#ff00aa','#00aaff','#aaff00',
];
const BOT_NAMES = ['سالم','خالد','محمد','يوسف','أحمد','عمر','علي','حسن','كريم','ماجد'];

let players={}, bullets=[], clients={}, nid=1;

function clamp(v,mn,mx){return Math.max(mn,Math.min(mx,v));}

function hitWall(x,z,r=P_R){
  if(Math.abs(x)>MAP-r||Math.abs(z)>MAP-r)return true;
  for(const w of WALLS){
    if(Math.abs(x-w.x)<w.w/2+r && Math.abs(z-w.z)<w.d/2+r)return true;
  }
  return false;
}

function spawn(idx){
  const s=SPAWNS[idx%SPAWNS.length];
  for(let t=0;t<20;t++){
    const x=s.x+(Math.random()-.5)*3, z=s.z+(Math.random()-.5)*3;
    if(!hitWall(x,z,P_R+.5))return{x,z};
  }
  return{x:s.x,z:s.z};
}

function mkPlayer(id,name,photo,isBot=false){
  const pos=spawn(Object.keys(players).length);
  return{
    id, name:String(name||'?').slice(0,14), photo:photo||null,
    x:pos.x, z:pos.z, y:0,
    rotY:0, pitch:0,
    hp:HP, maxHp:HP, alive:true, respawnAt:0,
    kills:0, deaths:0,
    color:COLORS[id%COLORS.length], isBot,
    // bot
    bTarget:null, bThink:0, bFire:0, bAngle:Math.random()*Math.PI*2,
  };
}

// ── بوتات ──
function fillBots(){
  const hc=Object.values(players).filter(p=>!p.isBot).length;
  const bc=Object.values(players).filter(p=>p.isBot).length;
  const need=Math.min(Math.max(0,4-hc)-bc, BOT_NAMES.length-bc);
  for(let i=0;i<Math.max(0,need);i++){
    const id=nid++;
    players[id]=mkPlayer(id,BOT_NAMES[bc+i]||'🤖 Bot',null,true);
  }
}
function rmBots(){for(const[id,p]of Object.entries(players))if(p.isBot)delete players[id];}

function botTick(b,dt){
  if(!b.alive)return;
  const now=Date.now();
  if(now>b.bThink){
    b.bThink=now+1200+Math.random()*800;  // يفكر كل ~2 ثانية
    const targets=Object.values(players).filter(p=>p.alive&&p.id!==b.id);
    b.bTarget=targets.length?targets[Math.floor(Math.random()*targets.length)]:null;
    if(!b.bTarget)b.bAngle=Math.random()*Math.PI*2;
  }
  if(b.bTarget?.alive){
    const dx=b.bTarget.x-b.x,dz=b.bTarget.z-b.z;
    const dist=Math.sqrt(dx*dx+dz*dz);
    b.rotY=Math.atan2(dx,dz);
    if(dist>6)b.bAngle=b.rotY;
    else b.bAngle+=(.5-Math.random())*.4;
    if(dist<20&&now>b.bFire){b.bFire=now+800+Math.random()*600;fire(b);}
  }
  let nx=b.x+Math.sin(b.bAngle)*P_SPD*.35*dt;  // بوت بطيء طبيعي
  let nz=b.z+Math.cos(b.bAngle)*P_SPD*.35*dt;
  nx=clamp(nx,-MAP+P_R,MAP-P_R);nz=clamp(nz,-MAP+P_R,MAP-P_R);
  if(!hitWall(nx,b.z))b.x=nx;
  if(!hitWall(b.x,nz))b.z=nz;
  else b.bAngle=Math.random()*Math.PI*2;
}

function fire(p){
  const cy=Math.cos(p.pitch||0),sy=Math.sin(p.pitch||0);
  const cr=Math.cos(p.rotY),sr=Math.sin(p.rotY);
  bullets.push({
    id:nid++, ownerId:p.id,
    x:p.x+sr*.6, y:1.4, z:p.z+cr*.6,
    vx:sr*cy*B_SPD, vy:sy*B_SPD, vz:cr*cy*B_SPD,
    ttl:B_TTL,
  });
}

// ── Tick ──
let last=Date.now();
function tick(){
  const now=Date.now(), dt=(now-last)/1000; last=now;
  // respawn
  for(const p of Object.values(players))
    if(!p.alive&&now>=p.respawnAt){const s=spawn(Math.random()*20|0);p.x=s.x;p.z=s.z;p.hp=HP;p.alive=true;}
  // bots
  for(const p of Object.values(players))if(p.isBot)botTick(p,dt);
  // bullets
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];
    b.x+=b.vx*dt;b.y+=b.vy*dt;b.z+=b.vz*dt;b.ttl-=dt;
    if(b.ttl<=0||Math.abs(b.x)>MAP+1||Math.abs(b.z)>MAP+1||hitWall(b.x,b.z,.08)){bullets.splice(i,1);continue;}
    let hit=false;
    for(const p of Object.values(players)){
      if(!p.alive||p.id===b.ownerId)continue;
      const dx=b.x-p.x,dz=b.z-p.z;
      if(Math.sqrt(dx*dx+dz*dz)<P_R*2.2&&b.y<2.1&&b.y>-.1){
        p.hp-=DAMAGE;hit=true;
        if(p.hp<=0){
          p.alive=false;p.hp=0;p.deaths++;p.respawnAt=now+RESPAWN;
          const k=players[b.ownerId];if(k)k.kills++;
          bcast({type:'kill',killer:b.ownerId,victim:p.id,kn:k?.name||'?',vn:p.name});
        }
        break;
      }
    }
    if(hit)bullets.splice(i,1);
  }
  // state
  bcast({
    type:'s',
    p:Object.values(players).map(p=>
      [p.id,p.x,p.z,p.rotY,p.hp,p.alive?1:0,p.kills,p.deaths,p.isBot?1:0]),
    b:bullets.map(b=>[b.id,b.x,b.y,b.z]),
  });
}

function bcast(msg){
  const d=JSON.stringify(msg);
  for(const ws of Object.values(clients))if(ws.readyState===1)ws.send(d);
}

// ── WS ──
const wss=new WebSocket.Server({port:PORT});
console.log(`🎮 FPS Server :${PORT}`);

wss.on('connection',ws=>{
  const id=nid++;
  let p=null;

  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw);}catch{return;}

    if(m.type==='join'){
      if(Object.values(players).filter(x=>!x.isBot).length>=MAX_P){ws.send(JSON.stringify({type:'full'}));return;}
      p=mkPlayer(id,m.name,m.photo,false);
      p.tgId=String(m.tg_id||id);p.username=m.username||'';
      players[id]=p;clients[id]=ws;
      // أرسل بيانات الماب + اللاعبين الحاليين مع أسمائهم وألوانهم
      const pinfo={};
      for(const[pid,pl]of Object.entries(players))
        pinfo[pid]={name:pl.name,color:pl.color,photo:pl.photo,isBot:pl.isBot};
      ws.send(JSON.stringify({type:'welcome',id,map:MAP,walls:WALLS,spawns:SPAWNS,pinfo}));
      rmBots();fillBots();
      bcast({type:'pjoin',id,name:p.name,color:p.color,photo:p.photo,isBot:0});
      bcast({type:'chat',name:'🎮',text:`${p.name} دخل!`});
      return;
    }
    if(!p)return;

    if(m.type==='m'){  // move
      if(!p.alive)return;
      const vx=+(m.vx||0),vz=+(m.vz||0);
      let nx=p.x+vx*P_SPD*(1/30),nz=p.z+vz*P_SPD*(1/30);
      nx=clamp(nx,-MAP+P_R,MAP-P_R);nz=clamp(nz,-MAP+P_R,MAP-P_R);
      if(!hitWall(nx,p.z))p.x=nx;
      if(!hitWall(p.x,nz))p.z=nz;
      if(m.r!==undefined)p.rotY=+m.r;
      if(m.pit!==undefined)p.pitch=+m.pit;
    }
    if(m.type==='f'){  // fire
      if(!p.alive)return;
      if(m.r!==undefined)p.rotY=+m.r;
      if(m.pit!==undefined)p.pitch=+m.pit;
      fire(p);
    }
    if(m.type==='chat'){bcast({type:'chat',name:p.name,text:String(m.text||'').slice(0,60)});}
  });

  ws.on('close',()=>{
    if(p){bcast({type:'pleave',id});delete players[id];delete clients[id];rmBots();fillBots();}
  });
});

setInterval(tick,TICK);
