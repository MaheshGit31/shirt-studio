const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'studio.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  name TEXT,
  state TEXT NOT NULL,
  print_url TEXT,
  shirt_color TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  size TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
`);

const newId = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const app = express();
app.set('trust proxy', 1);

// tiny rate limiter (per IP) for write endpoints
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => hits.clear(), 3600e3).unref();

// ---------- uploads ----------
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
app.post('/api/upload',
  limit(60, 60e3),
  express.raw({ type: Object.keys(EXT), limit: '15mb' }),
  (req, res) => {
    const ext = EXT[req.headers['content-type']?.split(';')[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Upload a PNG, JPG, WebP or GIF.' });
    const file = `${newId(14)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
    res.json({ url: `/uploads/${file}` });
  });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// ---------- designs ----------
app.post('/api/designs', limit(40, 60e3), express.json({ limit: '2mb' }), (req, res) => {
  const { name, state, printUrl, shirtColor } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Missing design.' });
  const id = newId();
  db.prepare('INSERT INTO designs (id,name,state,print_url,shirt_color,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, String(name || 'Untitled').slice(0, 80), JSON.stringify(state),
      typeof printUrl === 'string' && printUrl.startsWith('/uploads/') ? printUrl : null,
      String(shirtColor || '#ffffff').slice(0, 9), Date.now());
  res.json({ id });
});
app.get('/api/designs/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM designs WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Design not found.' });
  res.json({ id: d.id, name: d.name, state: JSON.parse(d.state), printUrl: d.print_url, shirtColor: d.shirt_color });
});

// ---------- orders ----------
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
app.post('/api/orders', limit(10, 60e3), express.json({ limit: '50kb' }), (req, res) => {
  const { designId, name, email, size, qty, notes } = req.body || {};
  if (!db.prepare('SELECT 1 FROM designs WHERE id=?').get(designId)) return res.status(400).json({ error: 'Save the design first.' });
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter a name and a valid email.' });
  if (!SIZES.includes(size)) return res.status(400).json({ error: 'Pick a size.' });
  const q = Math.min(Math.max(parseInt(qty) || 1, 1), 100);
  const id = newId(6).toUpperCase();
  db.prepare('INSERT INTO orders (id,design_id,name,email,size,qty,notes,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, designId, name.trim().slice(0, 80), email.trim().slice(0, 120), size, q, String(notes || '').slice(0, 500), Date.now());
  res.json({ id });
});

// ---------- admin ----------
function admin(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  const ok = ADMIN_PASSWORD && key.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: ADMIN_PASSWORD ? 'Wrong password.' : 'Set ADMIN_PASSWORD on the server.' });
  next();
}
app.get('/api/admin/orders', limit(120, 60e3), admin, (req, res) => {
  res.json(db.prepare(`
    SELECT o.*, d.name AS design_name, d.print_url, d.shirt_color
    FROM orders o JOIN designs d ON d.id=o.design_id ORDER BY o.created_at DESC LIMIT 500`).all());
});
app.patch('/api/admin/orders/:id', admin, express.json(), (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'printing', 'shipped', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Bad status.' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Shirt Studio on :${PORT}`));
