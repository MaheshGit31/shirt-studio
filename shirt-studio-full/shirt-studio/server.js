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

function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('designs', 'product', "TEXT DEFAULT 'shirt'");
addColumn('designs', 'variant', 'TEXT');
addColumn('designs', 'color_name', 'TEXT');
addColumn('orders', 'phone', 'TEXT');
addColumn('orders', 'product', "TEXT DEFAULT 'shirt'");

const inch = cm => String(Math.round(cm / 2.54 * 10) / 10);
const PRODUCTS = {
  shirt: { label: 'Shirt', variants: { XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL', '2XL': '2XL' } },
  hoodie: { label: 'Hoodie', variants: { M: 'M', L: 'L', XL: 'XL', XXXL: 'XXXL' } },
  hat: { label: 'Hat', variants: { baseball: 'Baseball hat', bucket: 'Bucket hat' } },
  pillow: { label: 'Square pillow (beta)', variants: { square: 'Square' } },
  blanket: { label: 'Blanket', variants: {
    '75x100': `75 × 100 cm (${inch(75)} × ${inch(100)} in)`,
    '100x150': `100 × 150 cm (${inch(100)} × ${inch(150)} in)`,
    '130x150': `130 × 150 cm (${inch(130)} × ${inch(150)} in)` } }
};

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
  const { name, state, printUrl, shirtColor, colorName, product, variant } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Missing design.' });
  if (!PRODUCTS[product] || !PRODUCTS[product].variants[variant]) return res.status(400).json({ error: 'Pick a product and option.' });
  const id = newId();
  db.prepare('INSERT INTO designs (id,name,state,print_url,shirt_color,color_name,product,variant,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, String(name || 'Untitled').slice(0, 80), JSON.stringify(state),
      typeof printUrl === 'string' && printUrl.startsWith('/uploads/') ? printUrl : null,
      String(shirtColor || '#ffffff').slice(0, 9), String(colorName || '').slice(0, 30), product, variant, Date.now());
  res.json({ id });
});
app.get('/api/designs/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM designs WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Design not found.' });
  res.json({ id: d.id, name: d.name, state: JSON.parse(d.state), printUrl: d.print_url, shirtColor: d.shirt_color,
    product: d.product || 'shirt', variant: d.variant || 'M' });
});

// ---------- orders ----------
app.post('/api/orders', limit(10, 60e3), express.json({ limit: '50kb' }), (req, res) => {
  const { designId, name, email, phone, qty, notes } = req.body || {};
  const d = db.prepare('SELECT * FROM designs WHERE id=?').get(designId);
  if (!d) return res.status(400).json({ error: 'Save the design first.' });
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter a name and a valid email.' });
  const ph = String(phone || '').trim();
  if (ph && !/^[+()\d][\d\s().-]{5,24}$/.test(ph)) return res.status(400).json({ error: 'Enter a valid phone number, or leave it empty.' });
  const q = Math.min(Math.max(parseInt(qty) || 1, 1), 100);
  const prod = PRODUCTS[d.product] ? d.product : 'shirt';
  const option = PRODUCTS[prod].variants[d.variant] || d.variant || '';
  const id = newId(6).toUpperCase();
  db.prepare('INSERT INTO orders (id,design_id,name,email,phone,product,size,qty,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, designId, name.trim().slice(0, 80), email.trim().slice(0, 120), ph, prod, option, q, String(notes || '').slice(0, 500), Date.now());
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
    SELECT o.*, d.print_url, d.color_name
    FROM orders o JOIN designs d ON d.id=o.design_id ORDER BY o.created_at DESC LIMIT 500`).all().map(o => ({ ...o, product_label: PRODUCTS[o.product]?.label || o.product })));
});
app.patch('/api/admin/orders/:id', admin, express.json(), (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'printing', 'shipped', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Bad status.' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Shirt Studio on :${PORT}`));
