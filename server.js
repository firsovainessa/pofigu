/* ═══════════════════════════════════════════════════════════════
   ПОФИГУ — сервер игровой комнаты.
   Состояние партии живёт здесь, поэтому рука каждого игрока
   действительно скрыта: браузеру соседа она просто не отправляется.
   Запуск:  node server.js            (порт 80)
   ═══════════════════════════════════════════════════════════════ */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 80;
const ROOT = __dirname;
/* секрет ведущего: генерируется один раз и лежит рядом в файле */
const KEYFILE = path.join(ROOT, 'host.key');
let HOST_KEY = fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE,'utf8').trim()
                                      : crypto.randomBytes(4).toString('hex');
fs.writeFileSync(KEYFILE, HOST_KEY);

/* ─────────── колода ─────────── */
const SUITS = { stress:'СТРЕСС', conf:'КОНФЛИКТ', time:'ТАЙМХАОС', res:'РЕСУРСЫ', abs:'НЕЛЕПЫЕ' };
const SK = Object.keys(SUITS);
const RANKS = ['6','7','8','9','10','В','Д','К','Т'];
const IDS = {
  stress:['1rmVhrmBb9tQmif18WxqRqsZcx89hfl7g','1-qjcdH3F4iDVOOdwu0MeuPjfwiwrUcee','1rOq5iE1_hCATgxn10coHtllZDO_HyxQG','1Tl9T0PysyEsNGS0ZITnEidc60ncB9rCk','1SpN86cyP_uZGaOMV2h5OVrF6PsNDnAh7','1dRGSMKOxOVwnNJeV05z6fFo2V9_O0cAO','1MWgsjCRDOlKWPs5XTa1jjg5wDvCCmsue','1GpApOQ7xteZJG6f_YUBeECVmpYc8ClpV','1-z8W8iUrmUyDKMUEK-S_4dchFjurFXM4'],
  conf:  ['1-rSji9Rn0PQF5bYAU7RdIv9F_lLefBrS','1lU9v2KTzp4JtXFy3k64e7sOFll_FLG3K','1txBBrnYNF9qbTefG0RBirXRdHKG9F-c3','1klS7vPldPJ5AQu0irYqAxYu5oGKoahrb','1VqDKY-A467kXU3QONwicRVSA-g82QfAo','1Crkp1Aws3mnsNa9UtKIDBnCgrYC4HWDj','1ChMQJh8cmyu15l-aL6WZaTQOnfEtpMMB','1Gguvq75PD5SF1dmdGHB_Dt6eTm54Jor-','1OP8438jL1vNil7V7CJqHjQ_tiX2ChV9D'],
  time:  ['1IYk3t5-SSzBgA6V_KgksvadKiY8ibjQx','1cNTZWb8LQHloo_-JteBm_pfO6hdLV18V','1NChP3x531H4PqIU53cgVAaj8SEKTHwtS','1su-bHRQ7KCYoCDDVX9uwzt1bSKJqYdSp','10IVP3I6o1Wsj9Ozy9jIPqc4hoywO0Mvy','1uESCSZtHrk_h22qHTPBKQikTJSe0NVYM','1PnOHfCYvGjEQF9VpxTeiM2eXN_VXQ_og','1Bl3EVyrOBptLABl-Xyw_lmIIOeawQZs4','19KvyfIeGmo2kbDFhRk1ePm8koVSwUb4o'],
  res:   ['1Ol8vAx7LoQoyqzgNWIOtEtG_DtecP3an','1ZxQ3D94dcwqcIFngRWVUN7r6YeD74q4R','1cl3QAk281xJ_teMiT-24GqzbLhvihEKt','13MU9dmJSJi3DEVrVCCiBDGGnuDyFQdyf','1nrDvi0z24cIL9QfzeZv7MDYmTmVPwC5I','1vGxha4K-9y2gk0ol_TvuK5ohfRjxDbU7','16O4mh7gyIIBktVm1V85Mw_NE154H6d7o','1pxYRBvQ8fYgH6HtrGZRwpI1l4letbNcG','1ih5pZjItyIYwGfNBPoqGuR4Cmf1iRoz0'],
  abs:   ['1wI0GBJzxNYFb7YVpMmCs7pCVqT387Y1N','10Mah8nwaxx30OxWYkzBoyThrTddJWPk9','1Ek5f3rsmd5YgmHlW0A7S57tVlmIcikFU','1pATYQ70GcFHU0HWmHi7Pw40Z8p6nmZXg','14bMo8JQfGBuLWOC4sMyy_rg9Qveu6Nyf','1BzqWkiRKohExOnUE5oGpOYkjKbyoXeGx','1uzNE5osrDoA4bAuHZROU-GhN1gMqLbJd','1TkxKEK19g2aphiajznd5gCTRmMSzwH8q','1TvolJGnviXqg_G72-kxTxk5RUenYUoQA']
};
const JOKERS = ['1oenLn8u3vJiyJg84BPEqIEwJXRZLpCph','1fCUKvYC7Px1HV-sN0ApfvBCREWeHW4Jf','1hr1G4cAGyT76vYf9on7uw7dlLK1QWZEC','1BMEUTyf8mDVTwsOa7w-uiHmec8UrK86H'];
const isProblem = r => ['6','7','8','9','10'].includes(r);
const label = c => c.joker ? 'ПОФИГ' : SUITS[c.s] + ' ' + c.r;

function freshDeck(){
  const d = [];
  SK.forEach(s => RANKS.forEach((r,i) => d.push({ s, r, v:i, id:IDS[s][i] })));
  JOKERS.forEach(id => d.push({ s:null, r:'ПОФИГ', v:99, id, joker:true }));
  for (let i=d.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}

/* ─────────── комната ─────────── */
const SEATS = 6;
const R = {
  players: Array.from({length:SEATS}, () => null),   /* {name, sock, hand} */
  deck:[], trumpCard:null, trump:'time',
  table:[], discard:0, attacker:0, defender:1,
  out:Array(SEATS).fill(true), started:false, over:false,
  frozen:false, reveal:false, log:[], gestures:{}
};
const say = t => { R.log.push({ t:new Date().toTimeString().slice(0,5), x:t });
                   if (R.log.length>200) R.log.shift(); };
const alive = () => R.players.map((p,i)=>p && !R.out[i] ? i : -1).filter(i=>i>=0);
const nextAlive = p => { for (let k=1;k<=SEATS;k++){ const i=(p+k)%SEATS;
                          if (R.players[i] && !R.out[i]) return i; } return p; };

function startGame(){
  const seated = R.players.map((p,i)=>p?i:-1).filter(i=>i>=0);
  if (seated.length < 2) return say('Нужно хотя бы двое за столом');
  R.deck = freshDeck();
  R.trumpCard = R.deck[R.deck.length-1];
  R.trump = R.trumpCard.joker ? SK[(Math.random()*5)|0] : R.trumpCard.s;
  R.table=[]; R.discard=0; R.over=false; R.started=true; R.gestures={};
  R.out = R.players.map(p => !p);
  seated.forEach(i => R.players[i].hand = []);
  for (let k=0;k<6;k++) seated.forEach(i => R.players[i].hand.push(R.deck.shift()));
  let best=null;
  seated.forEach(i => R.players[i].hand.forEach(c => {
    if (!c.joker && c.s===R.trump && (best===null || c.v<best.v)) best={ i, v:c.v };
  }));
  R.attacker = best ? best.i : seated[0];
  R.defender = nextAlive(R.attacker);
  say('Новая партия. Козырь — '+SUITS[R.trump]+'. Первым ходит '+R.players[R.attacker].name);
}

/* ─────────── правила ─────────── */
const beats = (a,d) => d.joker ? true : a.joker ? false
  : (d.s===a.s ? d.v>a.v : d.s===R.trump);
const unbeaten = () => R.table.filter(p=>!p.d);
const ranksOnTable = () => [...new Set(R.table.flatMap(p=>p.d?[p.a.r,p.d.r]:[p.a.r]))];
const maxAttacks = () => Math.min(6,
  (R.players[R.defender]?.hand.length||0) + R.table.filter(p=>p.d).length);
function canAttack(c){
  if (!R.table.length) return !c.joker;
  if (R.table.length >= maxAttacks()) return false;
  if (unbeaten().length) return false;
  return !c.joker && ranksOnTable().includes(c.r);
}
const canDefend = c => unbeaten().length>0 && beats(unbeaten()[0].a, c);

function endTurn(newAttacker){
  const order=[]; let p=R.attacker;
  for (let i=0;i<SEATS;i++){ if (p!==R.defender && R.players[p] && !R.out[p]) order.push(p); p=(p+1)%SEATS; }
  if (R.players[R.defender] && !R.out[R.defender]) order.push(R.defender);
  order.forEach(i => { while (R.players[i].hand.length<6 && R.deck.length)
                         R.players[i].hand.push(R.deck.shift()); });
  R.players.forEach((pl,i) => {
    if (pl && !R.out[i] && pl.hand.length===0 && R.deck.length===0){
      R.out[i]=true; say(pl.name+' — нет проблем, выходит из партии');
    }
  });
  if (alive().length<=1){
    R.over=true;
    const w=alive()[0];
    say('Партия окончена. Застрявший — ' + (w!==undefined ? R.players[w].name : 'никто'));
    return;
  }
  R.attacker = R.out[newAttacker] || !R.players[newAttacker] ? nextAlive(newAttacker) : newAttacker;
  R.defender = nextAlive(R.attacker);
}

/* ─────────── действия ─────────── */
function act(seat, m){
  if (R.frozen && m.t!=='gesture') return;
  const me = R.players[seat]; if (!me) return;

  if (m.t==='attack' && R.started && !R.over){
    if (seat===R.defender) return;
    const c = me.hand[m.i]; if (!c || !canAttack(c)) return;
    if (R.table.length===0 && seat!==R.attacker) return;   /* заходит только атакующий */
    me.hand.splice(m.i,1);
    R.table.push({ a:c, d:null, by:seat });
    say((R.table.length===1?'Ходит ':'Подкинул ')+me.name+': '+label(c));
  }
  if (m.t==='defend' && R.started && !R.over){
    if (seat!==R.defender) return;
    const c = me.hand[m.i]; if (!c || !canDefend(c)) return;
    const slot = unbeaten()[0];
    me.hand.splice(m.i,1); slot.d = c;
    say(me.name+' отбил '+label(slot.a)+' → '+label(c));
  }
  if (m.t==='take' && R.started && !R.over){
    if (seat!==R.defender || !unbeaten().length) return;
    R.table.forEach(p => { me.hand.push(p.a); if (p.d) me.hand.push(p.d); });
    say(me.name+' забирает '+R.table.length+' ситуац.');
    R.table=[]; endTurn(nextAlive(seat));
  }
  if (m.t==='beat' && R.started && !R.over){
    if (seat===R.defender || !R.table.length || unbeaten().length) return;
    R.discard += R.table.reduce((n,p)=>n+(p.d?2:1),0);
    say('Отбой: '+R.table.length+' закрыто');
    const d=R.defender; R.table=[]; endTurn(d);
  }
  if (m.t==='gesture'){
    const g=String(m.g||'').slice(0,20);
    R.gestures[g]=(R.gestures[g]||0)+1;
    const target = R.table.length ? R.table[R.table.length-1].by : R.attacker;
    say('Жест «'+g+'» → '+(R.players[target]?.name||'столу'));
    broadcast({ type:'gesture', g, from:seat, to:target });
  }
}
function hostAct(m){
  if (m.t==='new')     { startGame(); }
  if (m.t==='freeze')  { R.frozen=!R.frozen; say(R.frozen?'Стоп-кадр — разбираем ситуацию':'Стоп-кадр снят, играем дальше'); }
  if (m.t==='reveal')  { R.reveal=!R.reveal; say(R.reveal?'Ведущий открыл руки':'Руки снова закрыты'); }
  if (m.t==='kick' && R.players[m.i]) {
    say(R.players[m.i].name+' удалён со стола');
    if (R.players[m.i].sock) try{ R.players[m.i].sock.close(); }catch(e){}
    R.players[m.i]=null; R.out[m.i]=true;
  }
}

/* ─────────── что видит каждый ─────────── */
function publicState(){
  return {
    seats: R.players.map((p,i)=> p ? {
      name:p.name, cards:p.hand.length,
      probl:p.hand.filter(c=>!c.joker && isProblem(c.r)).length,
      out:R.out[i], on:!!p.sock,
      peek: R.reveal ? p.hand.map(c=>({ s:c.s, r:c.r })) : null
    } : null),
    deck:R.deck.length, discard:R.discard, trump:R.trump,
    trumpCard:R.started ? { id:R.trumpCard.id } : null,
    table:R.table.map(p=>({ a:{ s:p.a.s, r:p.a.r, id:p.a.id, joker:!!p.a.joker },
                            d:p.d?{ s:p.d.s, r:p.d.r, id:p.d.id, joker:!!p.d.joker }:null, by:p.by })),
    attacker:R.attacker, defender:R.defender,
    started:R.started, over:R.over, frozen:R.frozen, reveal:R.reveal,
    log:R.log.slice(-60), gestures:R.gestures, hostKey:null
  };
}
function sendTo(sock, seat, isHost){
  if (!sock || sock.readyState!==1) return;
  const st = publicState();
  st.me = seat;
  st.host = isHost;
  st.hand = seat!=null && R.players[seat] ? R.players[seat].hand.map(c=>({
    s:c.s, r:c.r, id:c.id, joker:!!c.joker,
    can: R.started && !R.over && !R.frozen &&
         (seat===R.defender ? canDefend(c) : canAttack(c) &&
          (R.table.length>0 || seat===R.attacker))
  })) : [];
  sock.send(JSON.stringify({ type:'state', st }));
}
const clients = new Set();
function broadcast(msg){ clients.forEach(c=>{ if(c.sock.readyState===1) c.sock.send(JSON.stringify(msg)); }); }
function pushAll(){ clients.forEach(c => sendTo(c.sock, c.seat, c.host)); }

/* ─────────── HTTP ─────────── */
const page = () => fs.readFileSync(path.join(ROOT,'index.html'));
const srv = http.createServer((req,res)=>{
  const u = req.url.split('?')[0];
  if (u==='/' || u.startsWith('/v/')){
    res.writeHead(200,{ 'Content-Type':'text/html; charset=utf-8' });
    return res.end(page());
  }
  if (u==='/kluch'){                       /* ссылка ведущего — показать себе */
    res.writeHead(200,{ 'Content-Type':'text/plain; charset=utf-8' });
    return res.end('Ссылка ведущего: /v/'+HOST_KEY+'\n');
  }
  res.writeHead(404); res.end('нет такой страницы');
});

/* ─────────── WebSocket ─────────── */
const wss = new WebSocketServer({ server:srv });
wss.on('connection', (sock, req) => {
  const isHost = /^\/v\/(.+)$/.test(req.url) && req.url.split('/v/')[1]===HOST_KEY;
  const c = { sock, seat:null, host:isHost };
  clients.add(c);
  sock.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch(e){ return; }
    if (m.t==='join'){
      const name = String(m.name||'Игрок').slice(0,18).trim() || 'Игрок';
      let seat = R.players.findIndex(p => p && p.name===name);      /* возврат после обрыва */
      if (seat<0) seat = R.players.findIndex(p => !p);
      if (seat<0){ sock.send(JSON.stringify({ type:'full' })); return; }
      if (!R.players[seat]) { R.players[seat] = { name, hand:[], sock }; R.out[seat]=true;
                              say(name+' сел на место '+(seat+1)); }
      else { R.players[seat].sock = sock; say(name+' вернулся за стол'); }
      c.seat = seat;
    }
    else if (c.host && m.h) hostAct(m);
    else if (c.seat!=null) act(c.seat, m);
    pushAll();
  });
  sock.on('close', () => {
    clients.delete(c);
    if (c.seat!=null && R.players[c.seat]) R.players[c.seat].sock = null;
    pushAll();
  });
  sendTo(sock, null, isHost);
});

srv.listen(PORT, () => {
  console.log('ПОФИГУ слушает порт '+PORT);
  console.log('Ссылка игроков:  http://<адрес>/');
  console.log('Ссылка ведущего: http://<адрес>/v/'+HOST_KEY);
});
