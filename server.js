// Clinix programme dashboard: serves public/index.html and saves its shared state.
//
//   GET /api/state  -> 200 {state} | 404 when nothing is saved yet
//   PUT /api/state  -> merges the body into the saved state, returns the result
//   GET /healthz    -> 200 ok (no auth, for Railway)
//
// Storage: Postgres when DATABASE_URL is set, otherwise data/state.json.
// Set DASHBOARD_PASSWORD to put the whole site behind the /login page.

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
const SESSION_DAYS = 30;

const pub = f => readFile(path.join(ROOT, 'public', f));
const PAGE = (await pub('index.html')).toString('utf8')
  .replace('<!--LOGOUT-->', PASSWORD ? '<a class="btn" href="/logout">Log out</a>' : '');
const LOGIN = (await pub('login.html')).toString('utf8');
const LOGO = await pub('logo.png');

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

/* ---------- login ----------
   The session cookie is "<expiry>.<hmac>", signed with a key derived from the
   password: it survives redeploys, and changing DASHBOARD_PASSWORD signs everyone out. */
const COOKIE = 'clinix_session';
const SIGN_KEY = crypto.createHash('sha256').update('clinix-session:' + PASSWORD).digest();
const sign = v => crypto.createHmac('sha256', SIGN_KEY).update(v).digest('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest();

function newSession(){
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + '.' + sign(exp);
}
function validSession(token){
  const [exp, sig] = (token || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name){
  for (const part of (req.headers.cookie || '').split(';')){
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const signedIn = req => !PASSWORD || validSession(getCookie(req, COOKIE));
const sessionCookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
  (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

// Failed sign-ins: 10 per IP per 15 minutes. The last X-Forwarded-For entry is the
// one Railway's proxy adds, so a client cannot dodge the limit by sending its own.
const LIMIT = 10, WINDOW = 15 * 60e3, fails = new Map();
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
const lockedOut = ip => { const f = fails.get(ip); return !!f && f.n >= LIMIT && f.until > Date.now(); };
function noteFail(ip){
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return void f.n++;
  if (fails.size > 5000) for (const [k, v] of fails) if (v.until <= Date.now()) fails.delete(k);
  fails.set(ip, {n: 1, until: Date.now() + WINDOW});
}

/* ---------- http ---------- */
function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}){
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', ...headers});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, to, headers = {}){
  res.writeHead(303, {Location: to, 'Cache-Control': 'no-store', ...headers});
  res.end();
}
const loginPage = (res, code, err) => send(res, code,
  LOGIN.replace('<!--ERROR-->', err ? `<p class="err" role="alert">${err}</p>` : ''), 'text/html; charset=utf-8');

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
    if (url.pathname === '/logo.png') return send(res, 200, LOGO, 'image/png', {'Cache-Control': 'public, max-age=86400'});

    if (url.pathname === '/login'){
      if (!PASSWORD || (req.method === 'GET' && signedIn(req))) return redirect(res, '/');
      if (req.method === 'GET') return loginPage(res, 200);
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain', {Allow: 'GET, POST'});
      const ip = ipOf(req);
      if (lockedOut(ip)) return loginPage(res, 429, 'Too many attempts. Try again in 15 minutes.');
      const given = new URLSearchParams(await readBody(req)).get('password') || '';
      if (!crypto.timingSafeEqual(sha(given), sha(PASSWORD))){
        noteFail(ip);
        return loginPage(res, 401, 'That password is not right.');
      }
      fails.delete(ip);
      return redirect(res, '/', {'Set-Cookie': sessionCookie(req, newSession(), SESSION_DAYS * 86400)});
    }
    if (url.pathname === '/logout') return redirect(res, PASSWORD ? '/login' : '/', {'Set-Cookie': sessionCookie(req, '', 0)});

    if (!signedIn(req)){
      return url.pathname.startsWith('/api/') ? send(res, 401, {error: 'signed out'}) : redirect(res, '/login');
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
  console.log(`Clinix dashboard on :${PORT}, storage: ${store.name}, login ${PASSWORD ? 'on' : 'OFF (set DASHBOARD_PASSWORD)'}`);
  if (!process.env.DATABASE_URL && process.env.RAILWAY_ENVIRONMENT)
    console.warn('WARNING: no DATABASE_URL. State is in a local file and will be lost on redeploy unless DATA_DIR is on a volume.');
});
