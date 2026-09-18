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
const os   = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;   /* App Platform сама задаёт порт; 3000 — запасной */
const ROOT = __dirname;
/* Секрет ведущего. Папка приложения на платформе доступна только для чтения,
   поэтому ключ храним во временной папке, а если и туда нельзя — просто в памяти.
   Чтобы ссылка ведущего не менялась при перезапусках, задайте переменную HOST_KEY. */
const KEYFILE = path.join(os.tmpdir(), 'pofigu-host.key');
let HOST_KEY = (process.env.HOST_KEY || '').trim();
if (!HOST_KEY) { try { HOST_KEY = fs.readFileSync(KEYFILE, 'utf8').trim(); } catch (e) {} }
if (!HOST_KEY) HOST_KEY = crypto.randomBytes(4).toString('hex');
try { fs.writeFileSync(KEYFILE, HOST_KEY); } catch (e) { /* только чтение — работаем из памяти */ }

/* ─────────── колода ─────────── */
const SUITS = { stress:'СТРЕСС', conf:'КОНФЛИКТ', time:'ТАЙМХАОС', res:'РЕСУРС', abs:'НЕЛЕПЫЕ СИТУАЦИИ' };
const SK = Object.keys(SUITS);
const RANKS = ['6','7','8','9','10','В','Д','К','Т'];
const IDS = {
  stress: ['stress-6','stress-7','stress-8','stress-9','stress-10','stress-v','stress-d','stress-k','stress-t'],
  conf:  ['conf-6','conf-7','conf-8','conf-9','conf-10','conf-v','conf-d','conf-k','conf-t'],
  time:  ['time-6','time-7','time-8','time-9','time-10','time-v','time-d','time-k','time-t'],
  res:   ['res-6','res-7','res-8','res-9','res-10','res-v','res-d','res-k','res-t'],
  abs:   ['abs-6','abs-7','abs-8','abs-9','abs-10','abs-v','abs-d','abs-k','abs-t']
};
const JOKERS = ['joker-pofig','joker-nubyvaet','joker-uehat','joker-uvolitsya'];
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
  frozen:false, reveal:false, log:[], gestures:{}, word:null,
  /* часы: начало текущего подхода и начало партии */
  tStart:0, gStart:0
};
const say = t => { R.log.push({ t:new Date().toTimeString().slice(0,5), x:t });
                   if (R.log.length>200) R.log.shift(); };

/* ─── шаг назад ───
   Живой стол прощает ошибку: положил не ту карту — забрал обратно.
   Онлайн так не умеет, поэтому перед каждым необратимым действием
   состояние комнаты откладывается в стопку. Ведущий может вернуться
   на двадцать шагов — этого хватает на любую «ой, не туда нажал». */
const UNDO = [];
function snap(what){
  UNDO.push({ what,
    hands: R.players.map(p => p ? { name:p.name, hand:p.hand.slice() } : null),
    deck: R.deck.slice(),
    table: R.table.map(x => ({ a:x.a, d:x.d, by:x.by, word:x.word, wordBy:x.wordBy })),
    discard: R.discard, attacker: R.attacker, defender: R.defender,
    out: R.out.slice(), started: R.started, over: R.over,
    trump: R.trump, trumpCard: R.trumpCard,
    tStart: R.tStart, gStart: R.gStart,
    word: R.word ? Object.assign({}, R.word) : null,
    log: R.log.slice() });
  if (UNDO.length > 20) UNDO.shift();
}
function stepBack(){
  const s = UNDO.pop();
  if (!s) return say('Шагов назад больше нет');
  /* руки возвращаем по местам, соединения не трогаем */
  s.hands.forEach((h,i) => { if (h && R.players[i]) R.players[i].hand = h.hand.slice(); });
  R.deck = s.deck.slice();
  R.table = s.table.map(x => Object.assign({}, x));
  R.discard = s.discard; R.attacker = s.attacker; R.defender = s.defender;
  R.out = s.out.slice(); R.started = s.started; R.over = s.over;
  R.trump = s.trump; R.trumpCard = s.trumpCard;
  R.tStart = s.tStart; R.gStart = s.gStart;
  R.word = s.word ? Object.assign({}, s.word) : null;
  R.log = s.log.slice();
  say('Ведущий вернул ход назад — отменено: ' + s.what);
}
const alive = () => R.players.map((p,i)=>p && !R.out[i] ? i : -1).filter(i=>i>=0);
const nextAlive = p => { for (let k=1;k<=SEATS;k++){ const i=(p+k)%SEATS;
                          if (R.players[i] && !R.out[i]) return i; } return p; };

function startGame(){
  const seated = R.players.map((p,i)=>p?i:-1).filter(i=>i>=0);
  if (seated.length < 2) return say('Нужно хотя бы двое за столом');
  R.deck = freshDeck();
  R.trumpCard = R.deck[R.deck.length-1];
  R.trump = R.trumpCard.joker ? SK[(Math.random()*5)|0] : R.trumpCard.s;
  R.table=[]; R.discard=0; R.over=false; R.started=true; R.gestures={}; R.word=null;
  R.gStart = R.tStart = Date.now();
  R.out = R.players.map(p => !p);
  seated.forEach(i => R.players[i].hand = []);
  for (let k=0;k<6;k++) seated.forEach(i => R.players[i].hand.push(R.deck.shift()));
  let best=null;
  seated.forEach(i => R.players[i].hand.forEach(c => {
    if (!c.joker && isProblem(c.r) && c.s===R.trump && (best===null || c.v<best.v)) best={ i, v:c.v };
  }));
  R.attacker = best ? best.i : seated[0];
  R.defender = nextAlive(R.attacker);
  say('Новая партия. Козырь — '+SUITS[R.trump]+'. Первым ходит '+R.players[R.attacker].name);
}

/* ─────────── правила ─────────── */
/* Проблему (6–10) кроет только решение (В, Д, К, Т) — своей масти или козырное.
   Проблема проблемой не кроется, даже более старшая: это принципиальное
   отличие ПОФИГУ от «дурака». Джокер «ПОФИГ» кроет что угодно. */
const isSolution = c => !c.joker && !isProblem(c.r);
const beats = (a,d) => {
  if (d.joker) return true;          /* ПОФИГ бьёт всё */
  if (a.joker) return false;         /* ПОФИГ не бьётся ничем */
  if (!isSolution(d)) return false;  /* проблемой крыть нельзя */
  return d.s === a.s || d.s === R.trump;
};
const unbeaten = () => R.table.filter(p => !p.d && !p.word);
const ranksOnTable = () => [...new Set(R.table.flatMap(p=>p.d?[p.a.r,p.d.r]:[p.a.r]))];
const maxAttacks = () => Math.min(6,
  (R.players[R.defender]?.hand.length||0) + R.table.filter(p=>p.d).length);
function canAttack(c){
  if (c.joker || !isProblem(c.r)) return false;   /* заходят и подкидывают только проблемой */
  if (!R.table.length) return true;
  if (R.table.length >= maxAttacks()) return false;
  if (unbeaten().length) return false;
  return ranksOnTable().includes(c.r);            /* тот же номинал, любая масть */
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
  let a = R.out[newAttacker] || !R.players[newAttacker] ? nextAlive(newAttacker) : newAttacker;
  /* ходить можно только проблемой: ищем того, у кого она есть */
  const hasProblem = i => R.players[i] && !R.out[i] &&
                          R.players[i].hand.some(c => !c.joker && isProblem(c.r));
  let guard = 0;
  while (!hasProblem(a) && guard++ < SEATS) a = nextAlive(a);
  if (!hasProblem(a)){
    R.over = true;
    say('Проблем не осталось ни у кого — партия окончена');
    return;
  }
  R.attacker = a;
  R.defender = nextAlive(R.attacker);
}

/* ─────────── действия ─────────── */
function act(seat, m){
  if (R.frozen && m.t!=='gesture') return;
  if (R.word && m.t!=='gesture' && m.t!=='word') return;
  const me = R.players[seat]; if (!me) return;

  if (m.t==='attack' && R.started && !R.over){
    if (seat===R.defender) return;
    /* Карты одного номинала выкладываются одним движением: m.is — список индексов.
       Старый формат с одной картой (m.i) продолжает работать. */
    let idx = Array.isArray(m.is) ? m.is : [m.i];
    idx = [...new Set(idx.filter(i => Number.isInteger(i) && me.hand[i]))];
    if (!idx.length) return;
    const cards = idx.map(i => me.hand[i]);
    if (new Set(cards.map(c=>c.r)).size > 1) return;        /* только один номинал */
    if (!canAttack(cards[0])) return;
    if (R.table.length===0 && seat!==R.attacker) return;    /* заходит только атакующий */
    const room = maxAttacks() - R.table.length;             /* сколько мест на столе */
    if (room <= 0) return;
    const play = idx.slice(0, room).map(i => ({ i, c: me.hand[i] }));
    const first = R.table.length===0;
    snap(first ? 'ход' : 'подкидывание');
    play.map(x=>x.i).sort((a,b)=>b-a).forEach(i => me.hand.splice(i,1));
    if (first) R.tStart = Date.now();          /* пошёл новый подход */
    play.forEach(x => R.table.push({ a:x.c, d:null, by:seat }));
    say((first?'Ходит ':'Подкинул ')+me.name+': '
        + play.map(x=>label(x.c)).join(', '));
  }
  if (m.t==='defend' && R.started && !R.over){
    if (seat!==R.defender) return;
    const c = me.hand[m.i]; if (!c || !canDefend(c)) return;
    const slot = unbeaten()[0];
    snap('карта в защите');
    me.hand.splice(m.i,1); slot.d = c;
    say(me.name+' отбил '+label(slot.a)+' → '+label(c));
  }
  if (m.t==='take' && R.started && !R.over){
    if (seat!==R.defender || !unbeaten().length) return;
    snap('«беру»');
    const takes = R.table.filter(p => !p.d && !p.word);
    const closed = R.table.filter(p => p.d || p.word);
    takes.forEach(p => me.hand.push(p.a));
    R.discard += closed.reduce((n,p)=>n+(p.d?2:1),0);
    say(me.name+' забирает '+takes.length+' ситуац.'
        + (closed.length ? ' (закрытые уходят в отбой)' : ''));
    R.table=[]; R.tStart = Date.now(); endTurn(nextAlive(seat));
  }
  /* защищающийся не бьёт картой, а рассказывает своё решение */
  if (m.t==='word' && R.started && !R.over){
    if (seat!==R.defender || !unbeaten().length || R.word) return;
    snap('заявку «свой пример»');
    R.word = { by:seat, card: label(unbeaten()[0].a) };
    say(me.name+' приводит свой пример на «'+R.word.card+'» — слово ведущему');
  }
  if (m.t==='beat' && R.started && !R.over){
    if (seat===R.defender || !R.table.length || unbeaten().length) return;
    snap('«бито»');
    R.discard += R.table.reduce((n,p)=>n+(p.d?2:1),0);
    say('Отбой: '+R.table.length+' закрыто');
    const d=R.defender; R.table=[]; R.tStart = Date.now(); endTurn(d);
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
  if (m.t==='new')     { if (R.started) snap('раздачу новой партии'); startGame(); }
  if (m.t==='undo')    { stepBack(); }
  /* Новый стол: следующая группа садится на чистые места.
     Прежние участники отключаются, партия и журнал обнуляются. */
  if (m.t==='reset'){
    /* Сначала говорим игрокам, что стол новый: иначе их вкладки переподключатся
       и молча сядут обратно под теми же именами. */
    clients.forEach(c => { if (!c.host && c.sock.readyState===1)
      try { c.sock.send(JSON.stringify({ type:'reset' })); } catch(e){} });
    R.players.forEach(p => { if (p && p.sock) try { p.sock.close(); } catch(e){} });
    R.players = Array.from({length:SEATS}, () => null);
    clients.forEach(c => { if (!c.host) c.seat = null; });
    R.deck=[]; R.trumpCard=null; R.trump='time';
    R.table=[]; R.discard=0; R.attacker=0; R.defender=1;
    R.out = Array(SEATS).fill(true);
    R.started=false; R.over=false; R.frozen=false; R.reveal=false;
    R.tStart=0; R.gStart=0;
    R.gestures={}; R.word=null;
    R.log.length = 0;
    UNDO.length = 0;                 /* чужие ходы новой команде не отменять */
    say('Новый стол — места свободны, ждём новую команду');
  }
  if (m.t==='freeze')  { R.frozen=!R.frozen; say(R.frozen?'Стоп-кадр — разбираем ситуацию':'Стоп-кадр снят, играем дальше'); }
  /* Ведущий останавливает партию по времени — это штатный ход методички,
     а заодно выход из редкой ситуации, когда крыть не может уже никто. */
  if (m.t==='stopgame'){
    if (!R.started || R.over) return;
    snap('остановку партии');
    R.over = true; R.word = null;
    const left = alive().filter(i => R.players[i].hand.length);
    say(left.length
      ? 'Ведущий остановил партию. Открытые вопросы остались у: '
        + left.map(i => R.players[i].name).join(', ')
      : 'Ведущий остановил партию. Открытых вопросов не осталось');
  }
  /* Ведущий смотрит расклад — видит только он. Строку в журнале оставляем:
     участники должны знать, что такая возможность у ведущего есть. */
  if (m.t==='reveal')  { R.reveal=!R.reveal;
    say(R.reveal ? 'Ведущий смотрит расклад стола' : 'Ведущий закрыл расклад'); }
  if (m.t==='wordyes'){                    /* ведущий засчитал устный ответ */
    if (!R.word) return;
    snap('«пример засчитан»');
    const slot = unbeaten()[0];
    if (slot){ slot.word = true; slot.wordBy = R.word.by; }
    say('Ведущий засчитал пример: «'+R.word.card+'» закрыта');
    R.word = null;
  }
  if (m.t==='wordno'){                     /* не засчитал */
    if (!R.word) return;
    snap('«пример не засчитан»');
    say('Ведущий не засчитал пример — нужно закрыть картой или забрать');
    R.word = null;
  }
  if (m.t==='beat'){                       /* ведущий закрывает подход */
    if (!R.started || R.over || !R.table.length) return;
    if (unbeaten().length) return say('Сначала нужно отбиться или забрать');
    snap('«всё в отбой»');
    R.discard += R.table.reduce((n,p)=>n+(p.d?2:1),0);
    say('Ведущий закрыл подход: ' + R.table.length + ' в отбой');
    const d=R.defender; R.table=[]; R.tStart = Date.now(); endTurn(d);
  }
  if (m.t==='kick' && R.players[m.i]) {
    say(R.players[m.i].name+' удалён со стола');
    if (R.players[m.i].sock) try{ R.players[m.i].sock.close(); }catch(e){}
    R.players[m.i]=null; R.out[m.i]=true;
  }
}

/* ─────────── что видит каждый ─────────── */
function publicState(){
  return {
    /* Чужие карты в общее состояние не попадают НИКОГДА — ни при каком
       положении переключателей. Расклад видит только ведущий, и подмешивается
       он персонально в sendTo(), в сообщение для его сокета. */
    seats: R.players.map((p,i)=> p ? {
      name:p.name, cards:p.hand.length,
      probl:p.hand.filter(c=>!c.joker && isProblem(c.r)).length,
      out:R.out[i], on:!!p.sock, peek:null
    } : null),
    deck:R.deck.length, discard:R.discard, trump:R.trump,
    trumpCard:R.started ? { id:R.trumpCard.id } : null,
    table:R.table.map(p=>({ a:{ s:p.a.s, r:p.a.r, id:p.a.id, joker:!!p.a.joker },
                            d:p.d?{ s:p.d.s, r:p.d.r, id:p.d.id, joker:!!p.d.joker }:null,
                            w:!!p.word, by:p.by })),
    word: R.word ? { by:R.word.by, card:R.word.card } : null,
    attacker:R.attacker, defender:R.defender,
    started:R.started, over:R.over, frozen:R.frozen, reveal:R.reveal,
    /* секунды считает сервер — у всех за столом одно и то же время */
    turnSec: R.started && R.tStart ? Math.floor((Date.now()-R.tStart)/1000) : 0,
    gameSec: R.started && R.gStart ? Math.floor((Date.now()-R.gStart)/1000) : 0,
    running: R.started && !R.over && !R.frozen,
    log:R.log.slice(-60), gestures:R.gestures, hostKey:null
  };
}
function sendTo(sock, seat, isHost){
  if (!sock || sock.readyState!==1) return;
  const st = publicState();
  st.me = seat;
  st.host = isHost;
  /* Расклад стола — только в сообщение ведущего. Участнику эти данные
     не отправляются, поэтому их нельзя достать ни из кода страницы, ни из
     консоли: в его браузере их просто нет. */
  if (isHost && R.reveal)
    st.seats.forEach((s,i) => { if (s && R.players[i])
      s.peek = R.players[i].hand.map(c => ({ s:c.s, r:c.r })); });
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
  /* Картинки карт: /cards/<имя>.jpg из папки рядом с приложением.
     Имя жёстко фильтруется — наружу отдаётся только то, что лежит в cards/. */
  if (u.startsWith('/cards/')){
    const name = u.slice(7);
    if (!/^[a-z0-9\-]+\.jpg$/.test(name)){ res.writeHead(404); return res.end('нет'); }
    try {
      const buf = fs.readFileSync(path.join(ROOT,'cards',name));
      res.writeHead(200,{ 'Content-Type':'image/jpeg',
                          'Cache-Control':'public, max-age=604800' });
      return res.end(buf);
    } catch(e){ res.writeHead(404); return res.end('нет такой карты'); }
  }

  /* Страница — только сам корень и ссылка ведущего целиком.
     Раньше здесь стоял startsWith('/v/'), и запрос /v/cards/back.jpg
     получал в ответ HTML с кодом 200: у ведущего вместо карт была
     штриховка, а тест по кодам ответа этого не видел. */
  if (u==='/' || /^\/v\/[^/]+\/?$/.test(u)){
    res.writeHead(200,{ 'Content-Type':'text/html; charset=utf-8' });
    return res.end(page());
  }
  /* Служебная страница со ссылкой ведущего. Нужна только пока ключ случайный.
     Как только в панели задана переменная HOST_KEY — ссылка постоянная,
     и страница закрывается сама: посторонний уже не подсмотрит ключ. */
  if (u==='/kluch'){
    if (process.env.HOST_KEY){ res.writeHead(404); return res.end('нет такой страницы'); }
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
                              say(name+' — место '+(seat+1)); }
      else { R.players[seat].sock = sock; say(name+' снова за столом'); }
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

srv.listen(PORT, '0.0.0.0', () => {
  console.log('ПОФИГУ слушает порт '+PORT);
  console.log('Ссылка игроков:  http://<адрес>/');
  console.log('Ссылка ведущего: http://<адрес>/v/'+HOST_KEY);
});
