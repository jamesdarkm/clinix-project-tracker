// Clinix programme dashboard: serves public/index.html and saves its shared state.
//
//   GET /api/state  -> 200 {state} | 404 when nothing is saved yet
//   PUT /api/state  -> merges the body into the saved state, returns the result
//   GET /healthz    -> 200 ok (no auth, for Railway)
//
// Storage: Postgres when DATABASE_URL is set, otherwise data/state.json.
// Set DASHBOARD_PASSWORD to put the whole site behind a browser password prompt.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const KEY = 'clinix-darkmatter-board-v2';
const MAX_BODY = 5 * 1024 * 1024;

const PAGE = await readFile(path.join(ROOT, 'public', 'index.html'));

/* ---------- storage ---------- */
function fileStore(dir){
  const file = path.join(dir, 'state.json');
  return {
    name: 'file ' + file,
    async init(){ await mkdir(dir, {recursive: true}); },
    async get(){
      try { return JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async set(state){
      await writeFile(file + '.tmp', JSON.stringify(state));
      await rename(file + '.tmp', file);
    }
  };
}

async function pgStore(url){
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({connectionString: url});
  return {
    name: 'postgres',
    async init(){
      await pool.query(`CREATE TABLE IF NOT EXISTS dashboard_state (
        key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    },
    async get(){
      const r = await pool.query('SELECT value FROM dashboard_state WHERE key = $1', [KEY]);
      return r.rows.length ? r.rows[0].value : null;
    },
    async set(state){
      await pool.query(`INSERT INTO dashboard_state (key, value, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify(state)]);
    }
  };
}

const store = process.env.DATABASE_URL
  ? await pgStore(process.env.DATABASE_URL)
  : fileStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
await store.init();

/* ---------- merge ----------
   Same rules as merge() in the page: newest updatedAt wins per record, activity is
   unioned by id. Doing it here as well means two saves landing at the same moment
   cannot overwrite each other's changes. On a tie the incoming copy wins. */
function merge(incoming, saved){
  if (!saved) return incoming;
  const out = {items:{}, milestones:{}, deps:{}, activity:[], updatedAt:Math.max(incoming.updatedAt||0, saved.updatedAt||0)};
  for (const k of ['items', 'milestones', 'deps']){
    const a = incoming[k] || {}, b = saved[k] || {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])){
      out[k][id] = !a[id] ? b[id] : !b[id] ? a[id] : (b[id].updatedAt||0) > (a[id].updatedAt||0) ? b[id] : a[id];
    }
  }
  const seen = new Set();
  [...(incoming.activity||[]), ...(saved.activity||[])].sort((x, y) => y.at - x.at)
    .forEach(e => { if (!seen.has(e.id)){ seen.add(e.id); out.activity.push(e); } });
  out.activity = out.activity.slice(0, 60);
  const w = (saved.week1At||0) > (incoming.week1At||0) ? saved : incoming;
  if (w.week1){ out.week1 = w.week1; out.week1At = w.week1At || 0; }
  return out;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const valid = s => isObj(s) && isObj(s.items) && isObj(s.milestones) && isObj(s.deps) && Array.isArray(s.activity || []);

// One save at a time, so the read-merge-write below never interleaves.
let queue = Promise.resolve();
const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

/* ---------- http ---------- */
function authorised(req){
  if (!PASSWORD) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const given = Buffer.from(value, 'base64').toString('utf8').split(':').slice(1).join(':');
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(given), h(PASSWORD));
}

function send(res, code, body, type = 'application/json; charset=utf-8'){
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff'});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY){ reject(Object.assign(new Error('too large'), {status: 413})); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

    if (!authorised(req)){
      res.writeHead(401, {'WWW-Authenticate': 'Basic realm="Clinix dashboard", charset="UTF-8"'});
      return res.end('Password required');
    }

    if (url.pathname === '/api/state'){
      if (req.method === 'GET'){
        const state = await store.get();
        return state ? send(res, 200, state) : send(res, 404, {error: 'empty'});
      }
      if (req.method === 'PUT'){
        let incoming;
        try { incoming = JSON.parse(await readBody(req)); }
        catch (e) { return send(res, e.status || 400, {error: e.status ? 'too large' : 'invalid JSON'}); }
        if (!valid(incoming)) return send(res, 400, {error: 'not a dashboard state'});
        const merged = await serial(async () => {
          const m = merge(incoming, await store.get());
          await store.set(m);
          return m;
        });
        return send(res, 200, merged);
      }
      res.setHeader('Allow', 'GET, PUT');
      return send(res, 405, {error: 'method not allowed'});
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')){
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }

    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) send(res, 500, {error: 'server error'});
  }
});

server.listen(PORT, () => {
  console.log(`Clinix dashboard on :${PORT}, storage: ${store.name}${PASSWORD ? ', password on' : ''}`);
  if (!process.env.DATABASE_URL && process.env.RAILWAY_ENVIRONMENT)
    console.warn('WARNING: no DATABASE_URL. State is in a local file and will be lost on redeploy unless DATA_DIR is on a volume.');
});
