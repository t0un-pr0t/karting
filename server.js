'use strict';
/*
 * Mini Kart 3D – serveur multijoueur et directeur de course
 *  - sert le jeu (public/index.html) et three.js r128 depuis node_modules
 *  - WebSocket /ws : positions relayées à 20 Hz, boudins, records des meilleurs tours (persistés)
 *  - sessions de 25 min : essais libres 5 min, qualifications 3 min, mise en grille, tour de formation derrière la safety car,
 *    feux, Grand Prix de 10 min, résultats ; météo tirée au sort à chaque session
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const sec = (min, s, d, lo, hi) => process.env[s] != null ? int(process.env[s], d, lo, hi) : process.env[min] != null ? int(Math.round(parseFloat(process.env[min]) * 60), d, lo, hi) : d;
const PORT = int(process.env.PORT, 9595, 1, 65535);
const MAX_PLAYERS = int(process.env.MAX_PLAYERS, 12, 1, 40);
const MIN_LAP_MS = int(process.env.MIN_LAP_MS, 20000, 1000, 600000);
const RESTORE_MS = int(process.env.RESTORE_MS, 40000, 5000, 3600000);   // délai avant que les commissaires remettent une pile en place
const GRID_MAX = 16;                                                     // cases peintes sur la grille
// durées (en minutes dans le compose ; les variables *_S en secondes servent aux essais)
const SESSION_MS = sec('SESSION_MIN', 'SESSION_S', 1500, 30, 7200) * 1000;
const FP_MS = sec('FP_MIN', 'FP_S', 300, 3, 3600) * 1000;
const QUALI_MS = sec('QUALI_MIN', 'QUALI_S', 180, 3, 3600) * 1000;
const GP_MS = sec('GP_MIN', 'GP_S', 600, 3, 3600) * 1000;
const QGRACE_MS = int(process.env.QGRACE_S, 60, 1, 600) * 1000;        // pour finir le tour en cours après les qualifs
const PREGRID_MS = int(process.env.PREGRID_S, 20, 1, 300) * 1000;
const FORM_MIN_MS = int(process.env.FORM_MIN_S, 46, 1, 600) * 1000;    // tour de la safety car (~44 s)
const FORM_MAX_MS = int(process.env.FORM_MAX_S, 90, 2, 900) * 1000;
const FINISH_MS = int(process.env.FINISH_S, 90, 2, 600) * 1000;       // pour franchir la ligne après le drapeau à damier
const RESULTS_MIN_MS = int(process.env.RESULTS_MIN_S, 30, 2, 600) * 1000;
const RAIN_CHANCE = Math.min(1, Math.max(0, parseFloat(process.env.RAIN_CHANCE ?? '0.4') || 0));
const WEATHER = (process.env.WEATHER || 'auto').toLowerCase();         // auto | sec | pluie
const DATA_DIR = process.env.DATA_DIR || '/data';
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const TICK_MS = 50;                      // 20 Hz
const MAX_RECORDS = 20;
const TIRE_LEVELS = 3, MAX_TIRE = 20000;     // pneus par pile (identique au client), borne des index

/* ---------- boudins : dernier état connu de chaque pneu déplacé ---------- */
const tires = new Map();                      // index du pneu -> [i, x, y, z, vx, vy, vz, état]
const stackTouch = new Map();                 // pile -> dernier contact (ms)
function onTires(p, list) {
  if (!Array.isArray(list)) return;
  const now = Date.now(), ok = [];
  for (const e of list.slice(0, 80)) {
    if (!Array.isArray(e) || e.length < 8) continue;
    const i = e[0] | 0; if (i < 0 || i >= MAX_TIRE) continue;
    const st = e[7] === 2 ? 2 : e[7] === 1 ? 1 : 0;
    const t = [i, r2(num(e[1], 1000)), r2(num(e[2], 1000)), r2(num(e[3], 20)), r2(num(e[4], 60)), r2(num(e[5], 60)), r2(num(e[6], 60)), st];
    tires.set(i, t); stackTouch.set(Math.floor(i / TIRE_LEVELS), now); ok.push(t);
  }
  if (ok.length) broadcast({ t: 'tires', u: ok }, p);
}
function restoreAllTires() { tires.clear(); stackTouch.clear(); broadcast({ t: 'tfix', all: 1 }); }
setInterval(() => {                           // les commissaires passent
  const now = Date.now(), due = [];
  const karts = [...players.values()].filter(p => p.joined && p.s && now - p.seen < 3000).map(p => p.s);
  for (const [s, t] of stackTouch) {
    if (now - t <= RESTORE_MS) continue;
    let busy = false;                         // un kart est encore sur ces pneus : les commissaires attendent
    for (let l = 0; l < TIRE_LEVELS && !busy; l++) { const r = tires.get(s * TIRE_LEVELS + l); if (r) busy = karts.some(k => Math.hypot(k[1] - r[1], k[2] - r[2]) < 3); }
    if (busy) continue;
    due.push(s); stackTouch.delete(s); for (let l = 0; l < TIRE_LEVELS; l++) tires.delete(s * TIRE_LEVELS + l);
  }
  if (due.length) broadcast({ t: 'tfix', s: due });
}, 2000);

/* ---------- fichiers statiques (mis en mémoire, gzip à l'avance) ---------- */
const STATIC = new Map();
function addStatic(url, file, type, cache) {
  const body = fs.readFileSync(file);
  STATIC.set(url, { body, gz: zlib.gzipSync(body, { level: 9 }), type, cache });
}
addStatic('/', path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8', 'no-cache');
addStatic('/three.min.js', require.resolve('three/build/three.min.js'), 'text/javascript; charset=utf-8', 'public, max-age=604800, immutable');
addStatic('/GLTFLoader.js', require.resolve('three/examples/js/loaders/GLTFLoader.js'), 'text/javascript; charset=utf-8', 'public, max-age=604800, immutable');
addStatic('/models/safety-car.glb', path.join(__dirname, 'public', 'models', 'safety-car.glb'), 'model/gltf-binary', 'public, max-age=86400');   // Kenney Car Kit, CC0

/* ---------- records (meilleur tour par pilote) ---------- */
let records = [];
let recordsWritable = true;
try {
  const raw = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
  if (Array.isArray(raw)) records = raw.filter(r => r && typeof r.name === 'string' && Number.isFinite(r.ms)).slice(0, MAX_RECORDS);
} catch (e) { if (e.code !== 'ENOENT') console.warn('records illisibles :', e.message); }
let saveTimer = null;
function saveRecords() {
  if (!recordsWritable || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(RECORDS_FILE + '.tmp', JSON.stringify(records, null, 1));
      fs.renameSync(RECORDS_FILE + '.tmp', RECORDS_FILE);
    } catch (e) { recordsWritable = false; console.warn(`records non sauvegardés (${DATA_DIR} non accessible en écriture) :`, e.message); }
  }, 1000);
}
/** Ajoute un tour au classement. Retourne le rang (1 = record absolu) si c'est un record personnel, sinon 0. */
function submitRecord(p, ms) {
  const key = p.name.toLowerCase();
  const prev = records.find(r => r.name.toLowerCase() === key);
  if (prev && prev.ms <= ms) return 0;
  if (prev) records.splice(records.indexOf(prev), 1);
  records.push({ name: p.name, color: p.color, ms, at: new Date().toISOString() });
  records.sort((a, b) => a.ms - b.ms);
  records = records.slice(0, MAX_RECORDS);
  saveRecords();
  return records.findIndex(r => r.name.toLowerCase() === key) + 1;
}

/* ---------- joueurs ---------- */
const players = new Map();               // id -> joueur
let nextId = 1;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const num = (v, lim) => { const n = +v; return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0; };
const r2 = v => Math.round(v * 100) / 100;
function cleanName(s, fallback) {
  const n = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || fallback;
}
function uniqueName(name, self) {
  const taken = n => [...players.values()].some(p => p !== self && p.joined && p.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let k = 2; k < 100; k++) { const c = `${name.slice(0, 13)} ${k}`; if (!taken(c)) return c; }
  return name;
}
function freeNumber() {
  const used = new Set([...players.values()].map(p => p.num));
  for (let n = 1; n < 100; n++) if (!used.has(n)) return n;
  return 99;
}
const meta = p => ({ id: p.id, name: p.name, color: p.color, num: p.num, best: p.best, last: p.last, laps: p.laps });
const joined = () => [...players.values()].filter(p => p.joined);
const active = p => p && p.joined && p.s && Date.now() - p.seen < 4000;

function send(ws, msg) { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) if (p.joined && p !== except) send(p.ws, s);
}

/* ---------- session : le directeur de course ---------- */
let sess = null, sessId = 0;
function rollWeather() {
  const mode = WEATHER === 'pluie' || WEATHER === 'rain' ? 'wet' : WEATHER === 'sec' || WEATHER === 'dry' ? 'dry' : Math.random() < RAIN_CHANCE ? 'rain' : 'dry';
  if (mode === 'dry') return [];
  if (mode === 'wet') return [[0, SESSION_MS * 4]];
  const r = Math.random(), m = 60000 * SESSION_MS / 1500000;                            // « minute » à l'échelle d'une session de 25 min
  if (r < .3) return [[0, SESSION_MS * 4]];                                             // pluie toute la session
  if (r < .7) { const a = (2 + Math.random() * 14) * m; return [[Math.round(a), Math.round(a + (4 + Math.random() * 7) * m)]]; }   // averse en cours de session
  return [[0, Math.round((5 + Math.random() * 11) * m)]];                                 // pluie au début, piste qui sèche
}
function newSession(now) {
  sess = { id: ++sessId, t0: now, end: now + SESSION_MS, phase: 'fp', ps: now, pe: now + FP_MS, wx: rollWeather(),
           grid: [], quali: new Map(), qEnd: 0, lights: null, race: null, res: null };
  for (const p of players.values()) { p.crossAt = 0; }
  console.log(`session ${sess.id} : essais libres · météo ${sess.wx.length ? JSON.stringify(sess.wx.map(([a, b]) => [Math.round(a / 1000) + ' s', Math.round(b / 1000) + ' s'])) : 'sèche'}`);
  broadcastSess();
}
function setPhase(ph, now, dur) {
  sess.phase = ph; sess.ps = now; sess.pe = dur ? now + dur : 0;
  console.log(`session ${sess.id} : ${ph}`);
}
function qList() {
  return [...sess.quali.values()].filter(q => q.best != null).sort((a, b) => a.best - b.best || a.at - b.at)
    .map(q => ({ id: q.id, name: q.name, color: q.color, num: q.num, best: q.best, laps: q.laps }));
}
function raceInfo() {
  const r = sess.race; if (!r) return null;
  return { go: r.go, end: r.go + GP_MS, cheq: r.cheq, fin: r.fin, parts: [...r.parts.values()].map(p => ({ id: p.id, name: p.name, color: p.color, num: p.num, n: p.n, best: p.best, pits: p.pits, pen: p.pen, cp: p.cp, left: p.left })) };
}
function sessInfo() {
  return { t: 'sess', now: Date.now(), id: sess.id, t0: sess.t0, end: sess.end, phase: sess.phase, ps: sess.ps, pe: sess.pe, wx: sess.wx,
           grid: sess.grid, q: qList(), qEnd: sess.qEnd, lights: sess.lights, race: raceInfo(), res: sess.res };
}
function broadcastSess() { broadcast(sessInfo()); }

function enterQuali(now) { setPhase('quali', now, QUALI_MS); sess.qStart = now; sess.qEnd = 0; sess.quali.clear(); restoreAllTires(); broadcastSess(); }
function enterQend(now) { sess.qEnd = now; setPhase('qend', now, 0); broadcastSess(); }
function enterPregrid(now) {
  const q = sess.quali;
  sess.grid = joined().sort((a, b) => ((q.get(a.id) || {}).best ?? Infinity) - ((q.get(b.id) || {}).best ?? Infinity) || a.joinedAt - b.joinedAt)
    .slice(0, GRID_MAX).map(p => p.id);
  setPhase('pregrid', now, PREGRID_MS); restoreAllTires(); broadcastSess();
}
function enterFormation(now) { setPhase('formation', now, 0); broadcastSess(); }
function enterLights(now) {
  const at = now + 1200, hold = 800 + Math.round(Math.random() * 1800);
  sess.lights = { at, out: at + 4000 + hold };                          // 5 feux en 4 s, puis extinction après 0,8 à 2,6 s
  const parts = new Map();
  for (const id of sess.grid) { const p = players.get(id); if (p) parts.set(id, { id, name: p.name, color: p.color, num: p.num, n: 0, best: null, pits: 0, pen: false, cp: 0, rp: 0, fin: null, left: false }); }
  sess.race = { go: sess.lights.out, cheq: 0, fin: [], parts };
  setPhase('lights', now, 0); broadcastSess();
}
function enterRace(now) { setPhase('race', now, 0); broadcastSess(); }
function enterResults(now) {
  const r = sess.race, list = r ? [...r.parts.values()] : [];
  list.sort((a, b) => (!!b.fin - !!a.fin) || b.n - a.n || (a.fin && b.fin ? a.fin.total - b.fin.total : b.rp - a.rp));
  sess.res = list.map(p => ({ id: p.id, name: p.name, color: p.color, num: p.num, laps: p.n, total: p.fin ? p.fin.total : null, fin: !!p.fin, best: p.best, pits: p.pits, pen: p.pen, left: p.left }));
  sess.end = Math.max(sess.end, now + RESULTS_MIN_MS);
  setPhase('results', now, sess.end - now); broadcastSess();
  if (sess.res.length) console.log('résultats : ' + sess.res.map((r, i) => `${i + 1}. ${r.name} (${r.laps} t.)`).join(', '));
}
function gridAlive() { return sess.grid.map(id => players.get(id)).filter(active); }
function tickSession() {
  const now = Date.now(), s = sess; if (!s) return;
  switch (s.phase) {
    case 'fp': if (now >= s.pe) enterQuali(now); break;
    case 'quali': if (now >= s.pe) enterQend(now); break;
    case 'qend': {
      const waiting = joined().filter(p => active(p) && !(p.crossAt > s.qEnd));
      if (!waiting.length || now >= s.qEnd + QGRACE_MS) enterPregrid(now);
      break;
    }
    case 'pregrid': if (now >= s.pe) { if (!gridAlive().length) enterResults(now); else enterFormation(now); } break;
    case 'formation': {
      const alive = gridAlive();
      if (!alive.length) { enterResults(now); break; }
      if ((now >= s.ps + FORM_MIN_MS && alive.every(p => p.s[9] & 1)) || now >= s.ps + FORM_MAX_MS) enterLights(now);
      break;
    }
    case 'lights': if (now >= s.lights.out) enterRace(now); break;
    case 'race': {
      const r = s.race, racing = [...r.parts.values()].filter(p => !p.left && !p.fin);
      for (const pt of r.parts.values()) { const p = players.get(pt.id); if (p && p.s) { pt.rp = p.s[7]; pt.cp = p.s[10]; if (p.s[9] & 2) pt.pen = true; } }
      if (!racing.length || (r.cheq && now >= r.cheq + FINISH_MS) || now >= r.go + GP_MS + 6 * 60000) enterResults(now);
      break;
    }
    case 'results': if (now >= s.end) newSession(now); break;
  }
}
setInterval(tickSession, 250);
setInterval(() => { if (sess && joined().length) broadcastSess(); }, 5000);   // filet de sécurité

function onLap(p, ms) {
  p.last = ms; p.laps++;
  const pb = p.best == null || ms < p.best;
  if (pb) p.best = ms;
  broadcast({ t: 'meta', p: meta(p) });
  if (pb) { const rank = submitRecord(p, ms); if (rank) broadcast({ t: 'records', list: records, rec: { name: p.name, color: p.color, ms, rank } }); }
  // qualifications : le tour doit avoir commencé pendant la séance
  const now = Date.now(), start = now - ms;
  if ((sess.phase === 'quali' || sess.phase === 'qend') && start >= sess.qStart - 500 && (!sess.qEnd || start < sess.qEnd)) {
    const q = sess.quali.get(p.id) || { id: p.id, name: p.name, color: p.color, num: p.num, best: null, laps: 0, at: now };
    q.laps++;
    if (q.best == null || ms < q.best) { q.best = ms; q.at = now; sess.quali.set(p.id, q); broadcastSess(); }
    else sess.quali.set(p.id, q);
  }
}
function onRaceLap(p, m) {
  const r = sess.race; if (sess.phase !== 'race' || !r) return;
  const pt = r.parts.get(p.id); if (!pt || pt.fin) return;
  const n = m.n | 0; if (n !== pt.n + 1) return;                     // tours dans l'ordre, sans doublon
  const now = Date.now(), ms = num(m.ms, 3600000);
  pt.n = n;
  if (n > 1 && !m.bad && ms >= MIN_LAP_MS * 0.85) pt.best = pt.best == null ? ms : Math.min(pt.best, ms);
  if (!r.cheq && now >= r.go + GP_MS) {                               // temps écoulé : drapeau à damier au passage du leader
    const others = [...r.parts.values()].filter(q => q !== pt && !q.left).map(q => q.n);
    if (!others.length || pt.n > Math.max(...others)) r.cheq = now;    // strictement : un ex æquo a franchi la ligne avant lui, il est devant
  }
  if (r.cheq) {
    const srvT = now - r.go, cli = num(m.total, 36000000);
    pt.fin = { total: Math.round(Math.abs(cli - srvT) < 3000 ? cli : srvT) };
    r.fin.push(p.id);
  }
  broadcastSess();
}

/* ---------- messages ---------- */
function onMessage(p, raw) {
  // limitation de débit : 80 messages / seconde
  const now = Date.now();
  if (now - p.rateT > 1000) { p.rateT = now; p.rateN = 0; }
  if (++p.rateN > 80) return;
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'hello') {
    if (p.joined) return;
    if (joined().length >= MAX_PLAYERS) { send(p.ws, { t: 'full', max: MAX_PLAYERS }); p.ws.close(1013, 'full'); return; }
    const alone = !joined().length;
    p.num = freeNumber();
    p.name = uniqueName(cleanName(m.name, `Pilote ${p.num}`), p);
    p.color = COLOR_RE.test(m.color) ? m.color.toLowerCase() : '#d01f1f';
    p.joined = true; p.joinedAt = now;
    if (alone || !sess) newSession(now);                               // premier pilote : la session repart des essais libres
    send(p.ws, {
      t: 'welcome', now: Date.now(), id: p.id, num: p.num, name: p.name, minLap: MIN_LAP_MS, max: MAX_PLAYERS,
      players: joined().filter(q => q !== p).map(meta), records, tires: [...tires.values()], sess: sessInfo(),
    });
    broadcast({ t: 'join', p: meta(p) }, p);
    console.log(`+ ${p.name} (#${p.num}) — ${players.size} connecté(s)`);
    return;
  }
  if (!p.joined) return;

  switch (m.t) {
    case 's': // état du kart : [id, x, y, cap, vitesse, drift, braquage, progression, aileron cassé, drapeaux, gomme, usure %]
      p.s = [p.id, r2(num(m.x, 1000)), r2(num(m.y, 1000)), r2(num(m.th, 1e6)), r2(num(m.v, 60)), num(m.dr, 1) | 0, r2(num(m.sv, 1)),
             Math.round(num(m.rp, 2000) * 1000) / 1000, m.dm ? 1 : 0, num(m.fl, 255) & 255, Math.max(0, Math.min(2, num(m.cp, 2) | 0)), Math.max(0, Math.min(100, Math.round(num(m.wr, 100)))), 0];
      {                                        // horodatage à l'émission (horloge serveur estimée par le client), sinon à la réception
        const ts = Number(m.ts), last = p.sTs || 0;
        p.sTs = Number.isFinite(ts) && Math.abs(ts - now) < 1500 && ts > last ? Math.round(ts) : Math.max(now, last + 1);
        p.s[12] = p.sTs;
      }
      p.seen = now;
      break;
    case 'lap': { const ms = Math.round(num(m.ms, 3600000)); if (ms >= MIN_LAP_MS) onLap(p, ms); break; }
    case 'rlap': onRaceLap(p, m); break;
    case 'cross': p.crossAt = now; break;
    case 'pit': {
      const pt = sess && sess.race && sess.phase === 'race' && sess.race.parts.get(p.id);
      if (pt) { pt.pits++; broadcastSess(); }
      break;
    }
    case 'tires': onTires(p, m.u); break;
    case 'mess': {                                   // flaque (0 = chiasse, 1 = vomi) relayée aux autres pilotes
      if (now - (p.messAt || 0) < 1500) break; p.messAt = now;
      broadcast({ t: 'mess', k: m.k ? 1 : 0, x: r2(num(m.x, 1000)), y: r2(num(m.y, 1000)), id: p.id }, p);
      break;
    }
    case 'ping': send(p.ws, { t: 'pong', c: num(m.c, 1e12) }); break;
  }
}

/* ---------- serveur HTTP + WebSocket ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, players: joined().length, phase: sess ? sess.phase : 'attente', session: sess ? sess.id : 0 }));
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); res.end(); return; }
  const f = STATIC.get(url === '/index.html' ? '/' : url);
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? f.gz : f.body;
  res.writeHead(200, {
    'Content-Type': f.type, 'Content-Length': body.length, 'Cache-Control': f.cache, 'Vary': 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
wss.on('connection', ws => {
  const p = { id: nextId++, ws, joined: false, name: '', color: '#d01f1f', num: 0, best: null, last: null, laps: 0, s: null, alive: true, rateT: 0, rateN: 0, seen: Date.now(), joinedAt: 0, crossAt: 0 };
  players.set(p.id, p);
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', (data, isBinary) => { if (!isBinary) onMessage(p, data.toString()); });
  ws.on('close', () => {
    players.delete(p.id);
    if (p.joined) {
      broadcast({ t: 'leave', id: p.id });
      console.log(`- ${p.name} — ${players.size} connecté(s)`);
      const pt = sess && sess.race && sess.race.parts.get(p.id);
      if (pt && !pt.fin) pt.left = true;
    }
  });
  ws.on('error', () => {});
});

// diffusion des positions à 20 Hz
setInterval(() => {
  const list = [];
  const now = Date.now();
  for (const p of players.values()) if (p.joined && p.s && now - p.seen < 3000) list.push(p.s);   // onglet en veille : kart masqué
  if (list.length) broadcast({ t: 'snap', ts: Date.now(), p: list });
}, TICK_MS);

// battement de cœur : déconnecte les clients muets
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false; try { p.ws.ping(); } catch {}
  }
}, 10000);

newSession(Date.now());
const dur = ms => ms % 60000 ? (ms / 1000) + ' s' : (ms / 60000) + ' min';
server.listen(PORT, () => console.log(`Mini Kart Grand Prix sur http://0.0.0.0:${PORT}  (max ${MAX_PLAYERS} pilotes · sessions de ${dur(SESSION_MS)} : essais ${dur(FP_MS)}, qualifs ${dur(QUALI_MS)}, GP ${dur(GP_MS)} · pluie ${WEATHER === 'auto' ? Math.round(RAIN_CHANCE * 100) + ' %' : WEATHER} · records : ${RECORDS_FILE})`));

function shutdown() {
  console.log('arrêt…');
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (recordsWritable) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 1)); } catch {} }
  for (const p of players.values()) try { p.ws.close(1001, 'server shutdown'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
