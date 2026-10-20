// 地球破壊ゲーム 中継サーバー
// Secretキーはここ(サーバー側)だけで使います。HTMLには絶対に書かないでください。
//
// 使い方:
//   SERBANK_SECRET=sk_あなたのSecretキー node server.js
//   → http://localhost:3000 を開く (index.html もここから配信されます)
//
// Node.js 18 以上が必要です (fetch を使うため)。

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'https://serbank.onrender.com/p/35b826d43eb5';
const SK = process.env.SERBANK_SECRET;
const PORT = process.env.PORT || 3000;
if (!SK) { console.error('環境変数 SERBANK_SECRET に Secret キーを設定してください'); process.exit(1); }

const ROOM_HP = 300000;
const MAX_PLAYERS = 8;
// クライアントと同じ武器表 (ダメージはサーバーが決める)
const WEAPONS = { meteor: 6000, volcano: 4000, typhoon: 3000, quake: 3500, flare: 8000, ice: 5000 };

async function sb(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'X-API-Key': SK, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

let queue = Promise.resolve(); // 書き込みを1つずつ順番に処理(ダメージの取りこぼし防止)
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function roomKey(code) {
  code = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(code)) throw Object.assign(new Error('ルーム名は英数字3〜12文字です'), { code: 400 });
  return 'room_' + code;
}
async function getRoom(key) {
  const r = await sb('GET', '/data/' + encodeURIComponent(key));
  return r.status === 200 ? r.json.value : null;
}
async function putRoom(key, room) {
  const r = await sb('PUT', '/data/' + encodeURIComponent(key), { value: room });
  if (r.status >= 300) throw Object.assign(new Error(r.json.error || 'SerBANK保存エラー'), { code: 502 });
}
const cleanName = (n) => String(n || 'ななし').replace(/[<>]/g, '').slice(0, 12) || 'ななし';
const cleanId = (i) => String(i || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);

const actions = {
  async join({ room, id, name }) {
    const key = roomKey(room); id = cleanId(id);
    if (!id) throw Object.assign(new Error('idがありません'), { code: 400 });
    let r = await getRoom(key);
    if (!r) r = { hp: ROOM_HP, max: ROOM_HP, over: false, players: {}, round: 1, created: Date.now() };
    if (!r.players[id]) {
      if (Object.keys(r.players).length >= MAX_PLAYERS) throw Object.assign(new Error('このルームは満員です'), { code: 409 });
      r.players[id] = { name: cleanName(name), dmg: 0, hits: 0 };
    } else r.players[id].name = cleanName(name);
    await putRoom(key, r);
    return { room: r };
  },
  async hit({ room, id, weapon, combo }) {
    const key = roomKey(room); id = cleanId(id);
    const r = await getRoom(key);
    if (!r) throw Object.assign(new Error('ルームがありません'), { code: 404 });
    if (!r.players[id]) throw Object.assign(new Error('先に参加してください'), { code: 400 });
    if (r.over) return { room: r, dmg: 0 };
    const base = WEAPONS[weapon];
    if (!base) throw Object.assign(new Error('武器が不明です'), { code: 400 });
    const c = Math.max(0, Math.min(5, parseInt(combo) || 0));
    const dmg = Math.round(base * (1 + c * 0.2));
    const p = r.players[id];
    p.dmg += dmg; p.hits += 1;
    r.hp = Math.max(0, r.hp - dmg);
    r.last = { id, name: p.name, weapon, dmg, t: Date.now() };
    if (r.hp <= 0) { r.over = true; r.finisher = p.name; }
    await putRoom(key, r);
    return { room: r, dmg };
  },
  async reset({ room }) {
    const key = roomKey(room);
    const r = await getRoom(key);
    if (!r) throw Object.assign(new Error('ルームがありません'), { code: 404 });
    if (!r.over) return { room: r };
    r.hp = r.max; r.over = false; r.round = (r.round || 1) + 1; delete r.finisher; delete r.last;
    for (const p of Object.values(r.players)) { p.dmg = 0; p.hits = 0; }
    await putRoom(key, r);
    return { room: r };
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8' };
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const f = path.join(__dirname, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    return fs.createReadStream(f).pipe(res);
  }
  const m = url.pathname.match(/^\/api\/(join|hit|reset)$/);
  if (req.method === 'POST' && m) {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 5000) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await serial(() => actions[m[1]](body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.code || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log('地球破壊ゲーム: http://localhost:' + PORT));
