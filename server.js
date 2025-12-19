import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import PDFDocument from 'pdfkit';
import bcrypt from 'bcryptjs';
import * as XLSX from 'xlsx';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const COOKIE_SECURE_ENV = process.env.COOKIE_SECURE === '1';
const USE_SECURE_COOKIES = COOKIE_SECURE_ENV && IS_PROD;

// Cuenta Supervisor protegida (no se puede eliminar ni cambiar contraseña)
const PROTECTED_SUPERVISOR_USERNAME = String(process.env.PROTECTED_SUPERVISOR_USERNAME || 'supervisor').toLowerCase();
const PROTECTED_SUPERVISOR_PASSWORD = String(process.env.PROTECTED_SUPERVISOR_PASSWORD || 'Admin');

// Si usamos cookies seguras detrás de un proxy (nginx, etc.), hay que confiar en el proxy
if (USE_SECURE_COOKIES) {
  app.set('trust proxy', 1);
}

// -----------------------------------------------------------------------------
// Directorio de datos (BD) – OWASP A05: evitar rutas débiles y asegurar permisos
// -----------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'Data');

// Compatibilidad: si existe carpeta antigua "data", migrar a "Data"
const LEGACY_DATA_DIR = path.join(__dirname, 'data');
try {
  if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
    fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
  }
} catch (e) {
  // Si falla el rename (permisos/FS), seguimos creando DATA_DIR
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'brumapp.db');

// -----------------------------------------------------------------------------
// Conexión SQLite – OWASP A03: siempre usar parámetros, nunca concatenar SQL
// -----------------------------------------------------------------------------
let db = await open({
  filename: DB_FILE,
  driver: sqlite3.Database
});

// -----------------------------------------------------------------------------
// Esquema base (para instalaciones nuevas)
// -----------------------------------------------------------------------------
const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('operario','supervisor','administrador')),
  is_protected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_lock(
  username TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recepciones(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  etiqueta TEXT,
  cantidad INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  unidad TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_productos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT UNIQUE NOT NULL,
  etiqueta TEXT,
  cantidad INTEGER NOT NULL,
  unidad TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_retiros(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  cantidad INTEGER NOT NULL,
  unidad TEXT,
  fecha TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

	-- Ajustes absolutos de stock (resetea el conteo físico)
	CREATE TABLE IF NOT EXISTS stock_ajustes(
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  tipo TEXT NOT NULL,
	  cantidad INTEGER NOT NULL,
	  unidad TEXT,
	  created_at TEXT DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_stock_ajustes_tipo ON stock_ajustes(tipo);
CREATE TABLE IF NOT EXISTS produccion(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_ini TEXT NOT NULL,
  fecha_fin TEXT NOT NULL,
  tipo TEXT,
  cantidad INTEGER NOT NULL,
  unidad TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS defectuosos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  cantidad INTEGER NOT NULL,
  razon TEXT,
  fecha TEXT NOT NULL,
  unidad TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS envios(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cantidad INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  descripcion TEXT,
  cliente TEXT NOT NULL,
  fecha TEXT NOT NULL,
  unidad TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS event_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_logs_ts ON event_logs(ts);
CREATE INDEX IF NOT EXISTS idx_event_logs_user ON event_logs(username);

CREATE TABLE IF NOT EXISTS maquinaria_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maquina TEXT NOT NULL,
  servicio TEXT NOT NULL,
  fecha TEXT NOT NULL,
  descripcion TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repuestos_inventario(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repuesto TEXT NOT NULL,
  cantidad INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  observaciones TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recepciones_movimientos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  etiqueta TEXT,
  delta INTEGER NOT NULL,
  total INTEGER,
  fecha TEXT NOT NULL,
  unidad TEXT,
  action TEXT NOT NULL,
  ref_recepcion_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recepciones_mov_tipo ON recepciones_movimientos(tipo);

`;

await db.exec(BASE_SCHEMA_SQL);

// -----------------------------------------------------------------------------
// Migraciones simples: añadir columnas si faltan (para BD viejas)
// -----------------------------------------------------------------------------
async function ensureColumn(table, column, typeDef) {
  const info = await db.all(`PRAGMA table_info(${table})`);
  if (!info.some(c => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
  }
}

// Añadimos unidad y tipo donde toque (si no existen aún)
await ensureColumn('recepciones', 'unidad', 'TEXT');
await ensureColumn('recepciones', 'etiqueta', 'TEXT');
await ensureColumn('produccion',  'tipo',   'TEXT');
await ensureColumn('produccion',  'unidad', 'TEXT');
await ensureColumn('defectuosos', 'unidad', 'TEXT');
await ensureColumn('envios',      'unidad', 'TEXT');

// Users: columna de protección (evita borrado del Supervisor principal)
await ensureColumn('users', 'is_protected', 'INTEGER NOT NULL DEFAULT 0');

// Stock: compatibilidad con BD antiguas
await ensureColumn('stock_productos', 'unidad', 'TEXT');
await ensureColumn('stock_productos', 'etiqueta', 'TEXT');
await ensureColumn('stock_productos', 'updated_at', 'TEXT');
await ensureColumn('stock_retiros', 'unidad', 'TEXT');
await ensureColumn('stock_retiros', 'fecha', 'TEXT');

// Población inicial de stock (para BD existentes)
try {
  const tipos = await db.all("SELECT DISTINCT tipo FROM recepciones");
  for (const row of (tipos || [])) {
    if (row && row.tipo) {
      await rebuildStockForTipo(row.tipo);
    }
  }
  await db.run("DELETE FROM stock_productos WHERE LOWER(tipo) NOT IN (SELECT LOWER(tipo) FROM recepciones)");
} catch (e) {
  console.warn('No se pudo reconstruir stock inicial:', e?.message || e);
}

await seedRecepcionesMovimientosIfEmpty();

// -----------------------------------------------------------------------------
// Seed de usuarios – OWASP A07: credenciales hash con bcrypt, roles bien definidos
// -----------------------------------------------------------------------------
async function seedUsersIfEmpty() {
  const countUsers = await db.get(`SELECT COUNT(*) as c FROM users`);
  if (!countUsers || countUsers.c === 0) {
    const hpDefault = await bcrypt.hash('admin', 10);
    const hpSupervisor = await bcrypt.hash(PROTECTED_SUPERVISOR_PASSWORD, 10);

    await db.run(
      "INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,?)",
      ['operario', hpDefault, 'operario', 0]
    );
    await db.run(
      "INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,?)",
      [PROTECTED_SUPERVISOR_USERNAME, hpSupervisor, 'supervisor', 1]
    );
    await db.run(
      "INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,?)",
      ['administrador', hpDefault, 'administrador', 0]
    );
    console.log('Seeded users (bcrypt): operario/admin -> admin, supervisor protegido -> ' + PROTECTED_SUPERVISOR_PASSWORD);
  }
}

await seedUsersIfEmpty();

// Garantiza que el Supervisor protegido exista siempre (evita quedar sin acceso)
async function ensureProtectedSupervisor() {
  const row = await db.get(
    "SELECT id, username, password, role, is_protected FROM users WHERE LOWER(username)=LOWER(?) LIMIT 1",
    [PROTECTED_SUPERVISOR_USERNAME]
  );

  const hpSupervisor = await bcrypt.hash(PROTECTED_SUPERVISOR_PASSWORD, 10);

  if (!row) {
    await db.run(
      "INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,1)",
      [PROTECTED_SUPERVISOR_USERNAME, hpSupervisor, 'supervisor']
    );
    console.log('Created protected supervisor user:', PROTECTED_SUPERVISOR_USERNAME);
    return;
  }

  // Forzamos rol supervisor y protección
  const needsRole = String(row.role || '') !== 'supervisor';
  const needsProtected = Number(row.is_protected || 0) !== 1;
  const pwOk = await bcrypt.compare(PROTECTED_SUPERVISOR_PASSWORD, String(row.password || ''));

  if (needsRole || needsProtected || !pwOk) {
    await db.run(
      "UPDATE users SET role=?, is_protected=1, password=? WHERE id=?",
      ['supervisor', hpSupervisor, row.id]
    );
  }
}

await ensureProtectedSupervisor();

// -----------------------------------------------------------------------------
// Historial de entradas (Recepciones)
//  - Permite ver cuántas veces se actualizó un material y cuánto se agregó
// -----------------------------------------------------------------------------
async function seedRecepcionesMovimientosIfEmpty() {
  try {
    // Si la tabla existe pero está vacía, creamos una línea base por cada material existente
    const row = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='recepciones_movimientos'");
    if (!row) return;

    const c = await db.get('SELECT COUNT(*) as c FROM recepciones_movimientos');
    if ((c?.c || 0) > 0) return;

    const items = await db.all('SELECT id, tipo, etiqueta, cantidad, fecha, unidad, created_at FROM recepciones ORDER BY id ASC');
    for (const it of (items || [])) {
      const delta = Number(it?.cantidad || 0);
      if (!it?.tipo || !delta) continue;
      await db.run(
        "INSERT INTO recepciones_movimientos(tipo, etiqueta, delta, total, fecha, unidad, action, ref_recepcion_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [String(it.tipo), String(it.etiqueta || ''), delta, delta, String(it.fecha || ''), String(it.unidad || ''), 'baseline', it.id, String(it.created_at || new Date().toISOString())]
      );
    }
  } catch (_) {
    // silencioso
  }
}


// -----------------------------------------------------------------------------
// Auditoría de eventos (event_logs)
// -----------------------------------------------------------------------------
function escapeSqliteString(val) {
  return String(val || '').replace(/'/g, "''");
}

async function logEvent(req, { action, entity = null, entityId = null, detail = null } = {}) {
  try {
    const u = req?.session?.user || null;
    const username = u ? u.username : null;
    const role = u ? u.role : null;
    const ipRaw = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
    const ip = String(ipRaw).split(',')[0].trim();

    await db.run(
      "INSERT INTO event_logs(username,role,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)",
      [username, role, String(action || ''), entity ? String(entity) : null, entityId ? String(entityId) : null, detail ? String(detail) : null, ip]
    );
  } catch (e) {
    // No interrumpir el flujo por fallos de auditoría
  }
}

// -----------------------------------------------------------------------------
// Backups / Restore de la base de datos (solo supervisor)
// -----------------------------------------------------------------------------
let RESTORE_IN_PROGRESS = false;

async function ensureSchemaAfterRestore() {
  await db.exec(BASE_SCHEMA_SQL);
  // Migraciones para BD antiguas
  await ensureColumn('recepciones', 'unidad', 'TEXT');
  await ensureColumn('recepciones', 'etiqueta', 'TEXT');
  await ensureColumn('produccion',  'tipo',   'TEXT');
  await ensureColumn('produccion',  'unidad', 'TEXT');
  await ensureColumn('defectuosos', 'unidad', 'TEXT');
  await ensureColumn('envios',      'unidad', 'TEXT');

  // Users: protección del Supervisor principal
  await ensureColumn('users', 'is_protected', 'INTEGER NOT NULL DEFAULT 0');

  // Stock (instalaciones antiguas)
  await ensureColumn('stock_productos', 'tipo', 'TEXT');
  await ensureColumn('stock_productos', 'etiqueta', 'TEXT');
  await ensureColumn('stock_productos', 'cantidad', 'INTEGER');
  await ensureColumn('stock_productos', 'unidad', 'TEXT');
  await ensureColumn('stock_productos', 'updated_at', 'TEXT');
  await ensureColumn('stock_retiros', 'tipo', 'TEXT');
  await ensureColumn('stock_retiros', 'cantidad', 'INTEGER');
  await ensureColumn('stock_retiros', 'unidad', 'TEXT');
  await ensureColumn('stock_retiros', 'fecha', 'TEXT');
  await seedUsersIfEmpty();
  await ensureProtectedSupervisor();
  await seedRecepcionesMovimientosIfEmpty();
  await rebuildAllStock();
}


// -----------------------------------------------------------------------------
// Helpers de formato de fecha (string helpers)
// -----------------------------------------------------------------------------
function formatDateYmdToDmy(s) {
  if (!s) return '';
  const datePart = String(s).split(/[T ]/)[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return s;
  const [y, m, d] = parts;
  return `${d}-${m}-${y}`;
}

function formatDateTimeYmdToDmy(s) {
  if (!s) return '';
  const [datePartRaw, timeRaw] = String(s).split(/[T ]/);
  const parts = (datePartRaw || '').split('-');
  if (parts.length !== 3) return s;
  const [y, m, d] = parts;
  const date = `${d}-${m}-${y}`;
  if (!timeRaw) return date;
  const time = timeRaw.slice(0, 5); // HH:MM
  return `${date} ${time}`;
}

// -----------------------------------------------------------------------------
// Filtros por rango de fechas (YYYY-MM-DD) para listados y exportaciones
//  - from / to son inclusivos
//  - el campo puede ser DATE (YYYY-MM-DD) o DATETIME (YYYY-MM-DDTHH:MM)
// -----------------------------------------------------------------------------
function normalizeYmd(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

function buildDateWhere({ field, from, to }) {
  const f = normalizeYmd(from);
  const t = normalizeYmd(to);
  const dateExpr = `date(substr(${field},1,10))`;
  if (f && t) {
    return {
      where: `WHERE ${dateExpr} BETWEEN date(?) AND date(?)`,
      params: [f, t]
    };
  }
  if (f) {
    return {
      where: `WHERE ${dateExpr} >= date(?)`,
      params: [f]
    };
  }
  if (t) {
    return {
      where: `WHERE ${dateExpr} <= date(?)`,
      params: [t]
    };
  }
  return { where: '', params: [] };
}


function buildTextSearchWhere(q, fields) {
  const qq = String(q || '').trim().toLowerCase();
  if (!qq) return { clause: '', params: [] };
  const like = `%${qq}%`;
  const parts = (fields || []).map(f => `LOWER(COALESCE(${f},'')) LIKE ?`);
  if (!parts.length) return { clause: '', params: [] };
  return { clause: `(${parts.join(' OR ')})`, params: Array(parts.length).fill(like) };
}

function buildQtyWhere(minQty, maxQty, field = 'cantidad') {
  const min = minQty !== undefined && minQty !== null && String(minQty).trim() !== '' ? Number(minQty) : null;
  const max = maxQty !== undefined && maxQty !== null && String(maxQty).trim() !== '' ? Number(maxQty) : null;
  const expr = `CAST(${field} AS REAL)`;
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return { clause: `(${expr} BETWEEN ? AND ?)`, params: [min, max] };
  }
  if (Number.isFinite(min)) {
    return { clause: `(${expr} >= ?)`, params: [min] };
  }
  if (Number.isFinite(max)) {
    return { clause: `(${expr} <= ?)`, params: [max] };
  }
  return { clause: '', params: [] };
}

function mergeWhere(baseWhere, baseParams, extraClauses, extraParams) {
  const clauses = [];
  if (baseWhere && baseWhere.trim()) {
    // baseWhere can be 'WHERE ...' or ''
    clauses.push(baseWhere.trim().replace(/^WHERE\s+/i, ''));
  }
  (extraClauses || []).forEach(c => {
    if (c && String(c).trim()) clauses.push(String(c).trim());
  });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params: [...(baseParams || []), ...(extraParams || [])] };
}

// -----------------------------------------------------------------------------
// Seguridad global – OWASP A05 (Security Misconfiguration) y A06 (Vulnerable & Outdated)
// -----------------------------------------------------------------------------
app.disable('x-powered-by');

// -----------------------------------------------------------------------------
// Helmet y cabeceras de seguridad
//  - En producción: CSP sin "upgrade-insecure-requests"
//  - En desarrollo: CSP desactivada para no romper HTTP simple en el VPS
// -----------------------------------------------------------------------------
if (IS_PROD) {
  app.use(helmet({
    contentSecurityPolicy: {
      // NO usamos los defaults para evitar "upgrade-insecure-requests"
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"]
      }
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false
  }));
} else {
  // Desarrollo: sin CSP, solo referrerPolicy y demás protecciones ligeras
  app.use(helmet({
    contentSecurityPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false
  }));
}

// Compresión – mejora rendimiento
app.use(compression());

// Body parsers – OWASP A04: limitar tamaño de petición para evitar DOS
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.use(cookieParser());

// OWASP A07: configuración robusta de sesión
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && IS_PROD) {
  console.warn(
    '[WARN] SESSION_SECRET no está definido en producción. ' +
    'Define una variable de entorno segura para evitar secretos débiles.'
  );
}

app.use(session({
  name: 'brumapp.sid',
  secret: SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: USE_SECURE_COOKIES ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 8 // 8 horas
  }
}));

// -----------------------------------------------------------------------------
// Rate limits – OWASP A05/A10: protección básica frente a fuerza bruta y DOS
// -----------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(['/api/auth/login', '/login'], loginLimiter);

// -----------------------------------------------------------------------------
// CSRF simple con excepción login – OWASP A05/A01
// -----------------------------------------------------------------------------
function ensureCsrf(req, res, next) {
  if (!req.session.csrf) {
    req.session.csrf =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
  }
  next();
}

function csrfProtect(req, res, next) {
  const m = (req.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    if (req.path === '/api/auth/login' || req.path === '/login') return next();
    const token = req.get('x-csrf-token');
    if (!token || token !== req.session.csrf) {
      return res.status(403).json({ error: 'bad-csrf' });
    }
  }
  next();
}

app.get('/csrf', ensureCsrf, (req, res) =>
  res.json({ token: req.session.csrf || '' })
);

app.use(csrfProtect);

// -----------------------------------------------------------------------------
// Static – sirve todo lo de /public (HTML, CSS, JS, imágenes)
// -----------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOGO_PATH = path.join(PUBLIC_DIR, 'assets', 'img', 'logo.png');

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, p) {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// -----------------------------------------------------------------------------
// Auth helpers – OWASP A01: Broken Access Control (chequeos SIEMPRE en backend)
// -----------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// -----------------------------------------------------------------------------
// Lock helpers – OWASP A07: bloqueo escalonado ante intentos de login fallidos
// -----------------------------------------------------------------------------
async function getLock(u) {
  const r = await db.get(
    "SELECT username, attempts, locked_until FROM login_lock WHERE username = ?",
    [u]
  );
  return r || { username: u, attempts: 0, locked_until: 0 };
}

async function saveLock(rec) {
  await db.run(
    "INSERT INTO login_lock(username,attempts,locked_until) VALUES(?,?,?) " +
    "ON CONFLICT(username) DO UPDATE SET attempts=excluded.attempts, locked_until=excluded.locked_until",
    [rec.username, rec.attempts, rec.locked_until]
  );
}

function lockDuration(stage) {
  if (stage <= 1) return 60;
  if (stage === 2) return 180;
  if (stage === 3) return 900;
  if (stage === 4) return 1800;
  return 3600;
}

// -----------------------------------------------------------------------------
// Login handler – OWASP A07 (auth), A02 (bcrypt), A05 (errores genéricos)
// -----------------------------------------------------------------------------
async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();
  const isJson = !!req.is('application/json');

  const now = Math.floor(Date.now() / 1000);
  let lock = await getLock(uname);
  if (lock.locked_until && lock.locked_until > now) {
    const waitSec = lock.locked_until - now;
    if (isJson) {
      return res.status(429).json({ error: 'locked', waitSec });
    }
    return res.redirect('/?locked=1&waitSec=' + waitSec);
  }

  const user = await db.get("SELECT * FROM users WHERE username = ?", [uname]);
  let ok = false;
  if (user) {
    ok = await bcrypt.compare(String(password || ''), user.password);
  }

  if (!user || !ok) {
    lock.attempts = (lock.attempts || 0) + 1;
    if (lock.attempts % 3 === 0) {
      const stage = Math.floor(lock.attempts / 3);
      lock.locked_until = now + lockDuration(stage);
    }
    await saveLock(lock);
    if (isJson) {
      return res.status(401).json({
        error: 'bad-credentials',
        attempts: lock.attempts,
        lockedUntil: lock.locked_until
      });
    }
    return res.redirect(
      '/?error=1&attempts=' +
      lock.attempts +
      '&lockedUntil=' +
      (lock.locked_until || 0)
    );
  }

  lock.attempts = 0;
  lock.locked_until = 0;
  await saveLock(lock);

  req.session.user = { id: user.id, username: user.username, role: user.role };
  await logEvent(req, { action: 'login', entity: 'auth', entityId: user.id });
  if (isJson) {
    return res.json({ ok: true, user: req.session.user });
  }
  return res.redirect('/panel.html');
}

app.post('/api/auth/login', loginHandler);
app.post('/login', loginHandler);

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await logEvent(req, { action: 'logout', entity: 'auth', entityId: req.session.user?.id });
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// -----------------------------------------------------------------------------
// Backup / Restore (solo supervisor)
// -----------------------------------------------------------------------------
app.get('/api/backup/download', requireRole('supervisor'), async (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapFile = path.join(DATA_DIR, `brumapp_backup_${ts}.db`);

  try {
    await db.exec(`VACUUM INTO '${escapeSqliteString(snapFile)}'`);
  } catch (e) {
    // Fallback: copia directa (menos robusta que VACUUM INTO)
    try { await db.exec('PRAGMA wal_checkpoint(FULL)'); } catch (_) {}
    fs.copyFileSync(DB_FILE, snapFile);
  }

  await logEvent(req, { action: 'backup_download', entity: 'database', detail: `file=${path.basename(snapFile)}` });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="brumapp_backup_${ts}.db"`);

  const stream = fs.createReadStream(snapFile);
  stream.on('error', () => res.status(500).end());
  stream.pipe(res);

  res.on('finish', () => {
    fs.unlink(snapFile, () => {});
  });
});

app.post('/api/backup/restore', requireRole('supervisor'), async (req, res) => {
  if (RESTORE_IN_PROGRESS) return res.status(409).json({ error: 'restore_in_progress' });
  RESTORE_IN_PROGRESS = true;

  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return res.status(400).json({ error: 'invalid' });
    }

    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length < 100 || buf.length > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'size' });
    }

    const sig = buf.slice(0, 16).toString('utf8');
    if (!sig.startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'not_sqlite' });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpFile = path.join(DATA_DIR, `__restore_${ts}.db`);
    fs.writeFileSync(tmpFile, buf);

    const pre = path.join(DATA_DIR, `brumapp_pre_restore_${ts}.db`);
    try { fs.copyFileSync(DB_FILE, pre); } catch (_) {}

    // Cerrar y reemplazar
    try { await db.close(); } catch (_) {}
    try { fs.renameSync(tmpFile, DB_FILE); } catch (e) {
      // si rename falla (FS), intentamos copy + unlink
      fs.copyFileSync(tmpFile, DB_FILE);
      fs.unlinkSync(tmpFile);
    }

    // Reabrir y garantizar esquema
    db = await open({ filename: DB_FILE, driver: sqlite3.Database });
    await ensureSchemaAfterRestore();

    await logEvent(req, {
      action: 'backup_restore',
      entity: 'database',
      detail: `from=${String(filename || '').slice(0, 128)} pre=${path.basename(pre)}`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Restore error:', e);
    res.status(500).json({ error: 'restore_failed' });
  } finally {
    RESTORE_IN_PROGRESS = false;
  }
});

// -----------------------------------------------------------------------------
// Auditoría / Historial de eventos (solo supervisor)
// -----------------------------------------------------------------------------
app.get('/api/event-logs', requireRole('supervisor'), async (req, res) => {
  const { from, to, q, limit, offset } = req.query || {};
  const lim = Math.min(parseInt(limit || '50', 10) || 50, 200);
  const off = Math.max(parseInt(offset || '0', 10) || 0, 0);

  const f = buildDateWhere({ field: 'ts', from, to });
  const sQ = buildTextSearchWhere(q, ['username','role','action','entity','entity_id','detail','ip']);
  const mw = mergeWhere(f.where, f.params, [sQ.clause], [...sQ.params]);

  const totalRow = await db.get(`SELECT COUNT(*) as c FROM event_logs ${mw.where}`, mw.params);
  const items = await db.all(
    `SELECT * FROM event_logs ${mw.where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    [...mw.params, lim, off]
  );
  res.json({ items, total: totalRow?.c || 0 });

// Exportación del historial (event_logs) a Excel (XLSX)
app.get('/api/event-logs.xlsx', requireRole('supervisor'), async (req, res) => {
  const { from, to, q } = req.query || {};

  const f = buildDateWhere({ field: 'ts', from, to });
  const sQ = buildTextSearchWhere(q, ['username','role','action','entity','entity_id','detail','ip']);
  const mw = mergeWhere(f.where, f.params, [sQ.clause], [...sQ.params]);

  const items = await db.all(
    `SELECT * FROM event_logs ${mw.where} ORDER BY ts DESC, id DESC`,
    mw.params
  );

  const aoa = [
    ['ID', 'Fecha/Hora', 'Usuario', 'Rol', 'Acción', 'Entidad', 'Entidad ID', 'Detalle', 'IP'],
    ...(items || []).map(ev => [
      ev.id ?? '',
      formatTsLima(ev.ts ?? ''),
      ev.username ?? '',
      ev.role ?? '',
      ev.action ?? '',
      ev.entity ?? '',
      ev.entity_id ?? '',
      ev.detail ?? '',
      ev.ip ?? ''
    ])
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  sendXlsx(res, `historial_eventos_${stamp}.xlsx`, [
    { name: 'Historial', aoa }
  ]);
});

});

// -----------------------------------------------------------------------------
// Recepciones
// -----------------------------------------------------------------------------

// Reconstruye stock completo (útil post-restore o migraciones)
async function rebuildAllStock() {
  try {
    const tipos = await db.all('SELECT DISTINCT tipo FROM recepciones');
    for (const row of (tipos || [])) {
      if (row?.tipo) await rebuildStockForTipo(row.tipo);
    }
    await db.run("DELETE FROM stock_productos WHERE LOWER(tipo) NOT IN (SELECT LOWER(tipo) FROM recepciones)");
  } catch (_) {}
}

// Stock derivado: stock = SUM(recepciones) - SUM(retiros)
async function rebuildStockForTipo(tipo) {
  const t = String(tipo || '').trim();
  if (!t) return;

  const lastRec = await db.get(
    "SELECT tipo, unidad, etiqueta FROM recepciones WHERE LOWER(tipo)=LOWER(?) ORDER BY created_at DESC, id DESC LIMIT 1",
    [t]
  );

  // Si ya no existe recepción para ese tipo, eliminar stock (retiros se mantienen como auditoría)
  if (!lastRec) {
    await db.run("DELETE FROM stock_productos WHERE LOWER(tipo)=LOWER(?)", [t]);
    return;
  }

  // Si existe un ajuste de stock, se toma como base y se ignora el historial previo.
  // A partir del ajuste, se acumulan nuevos ingresos (movimientos) y retiros posteriores.
  const lastAdj = await db.get(
    "SELECT cantidad, created_at FROM stock_ajustes WHERE LOWER(tipo)=LOWER(?) ORDER BY created_at DESC, id DESC LIMIT 1",
    [t]
  );

  let qty = 0;

  if (lastAdj && lastAdj.created_at) {
    const base = Number(lastAdj.cantidad || 0);
    const ts = String(lastAdj.created_at);

    const addMov = await db.get(
      "SELECT COALESCE(SUM(delta),0) AS total FROM recepciones_movimientos WHERE LOWER(tipo)=LOWER(?) AND delta > 0 AND (action='add' OR action='create') AND created_at >= ?",
      [t, ts]
    );
    const sumRetAfter = await db.get(
      "SELECT COALESCE(SUM(cantidad),0) AS total FROM stock_retiros WHERE LOWER(tipo)=LOWER(?) AND created_at >= ?",
      [t, ts]
    );

    const added = Number(addMov?.total || 0);
    const withdrawn = Number(sumRetAfter?.total || 0);
    qty = Math.max(0, base + added - withdrawn);
  } else {
    const sumRec = await db.get(
      "SELECT COALESCE(SUM(cantidad),0) AS total FROM recepciones WHERE LOWER(tipo)=LOWER(?)",
      [t]
    );
    const sumRet = await db.get(
      "SELECT COALESCE(SUM(cantidad),0) AS total FROM stock_retiros WHERE LOWER(tipo)=LOWER(?)",
      [t]
    );

    const received = Number(sumRec?.total || 0);
    const withdrawn = Number(sumRet?.total || 0);
    qty = Math.max(0, received - withdrawn);
  }

  const existing = await db.get(
    "SELECT id FROM stock_productos WHERE LOWER(tipo)=LOWER(?) LIMIT 1",
    [t]
  );

  if (existing) {
    await db.run(
      "UPDATE stock_productos SET tipo=?, etiqueta=?, cantidad=?, unidad=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [String(lastRec.tipo || t), String(lastRec.etiqueta || ''), qty, String(lastRec.unidad || ''), existing.id]
    );
  } else {
    await db.run(
      "INSERT INTO stock_productos(tipo, etiqueta, cantidad, unidad) VALUES(?,?,?,?)",
      [String(lastRec.tipo || t), String(lastRec.etiqueta || ''), qty, String(lastRec.unidad || '')]
    );
  }
}

app.get('/api/recepciones', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM recepciones ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

// Historial de entradas por material (Recepciones)
app.get('/api/recepciones/historial', requireAuth, async (req, res) => {
  const tipo = String((req.query || {}).tipo || '').trim().slice(0, 64);
  if (!tipo) return res.status(400).json({ error: 'tipo_required' });

  const { limit, offset } = req.query || {};
  const lim = Math.min(parseInt(limit || '50', 10) || 50, 200);
  const off = Math.max(parseInt(offset || '0', 10) || 0, 0);

  const items = await db.all(
    "SELECT * FROM recepciones_movimientos WHERE LOWER(tipo)=LOWER(?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    [tipo, lim, off]
  );

  const summary = await db.get(
    "SELECT COUNT(*) as veces, COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) as total_agregado, COALESCE(MAX(total),0) as ultimo_total FROM recepciones_movimientos WHERE LOWER(tipo)=LOWER(?)",
    [tipo]
  );

  res.json({
    items: items || [],
    summary: {
      tipo,
      veces: summary?.veces || 0,
      total_agregado: summary?.total_agregado || 0,
      ultimo_total: summary?.ultimo_total || 0
    }
  });
});

app.post('/api/recepciones', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { tipo, etiqueta, cantidad, fecha, unidad, confirm_update } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').trim().slice(0, 64);
  const et = String(etiqueta || '').trim().slice(0, 64);
  const f = String(fecha || '').trim().slice(0, 32);
  const u = String(unidad || '').trim().slice(0, 16);

  if (!t || !Number.isFinite(c) || c <= 0 || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  // Si ya existe el producto (mismo nombre), validar coherencia de etiqueta y unidad.
  // Si coincide, pedir confirmación antes de registrar la nueva recepción (se agregará al stock).
  const existingStock = await db.get(
    "SELECT tipo, etiqueta, unidad, cantidad FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1",
    [t]
  );
  const existingRef = existingStock || await db.get(
    "SELECT tipo, etiqueta, unidad FROM recepciones WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1",
    [t]
  );

  if (existingRef) {
    const expectedUnit = String(existingRef.unidad || '').trim();
    const expectedLabel = String(existingRef.etiqueta || '').trim();

    // Etiqueta: irrelevante para el cálculo/validación de stock.
    // Única validación: el mismo material (nombre) debe mantener la misma unidad.
    if (!u) {
      if (expectedUnit) {
        return res.status(400).json({ error: 'unit_mismatch', expected: expectedUnit });
      }
      return res.status(400).json({ error: 'unidad_required' });
    }
    if (expectedUnit && u !== expectedUnit) {
      return res.status(400).json({ error: 'unit_mismatch', expected: expectedUnit });
    }
if (!String(confirm_update || '').trim()) {
      return res.status(409).json({
        error: 'exists',
        current: {
          tipo: String(existingRef.tipo || t),
          etiqueta: expectedLabel,
          unidad: expectedUnit,
          stock_actual: Number(existingStock?.cantidad || 0)
        }
      });
    }
  }

  const r = await db.run(
    "INSERT INTO recepciones(tipo,etiqueta,cantidad,fecha,unidad) VALUES(?,?,?,?,?)",
    [t, et, c, f, u]
  );

  // Recalcular stock y obtener total resultante
  await rebuildStockForTipo(t);
  const st = await db.get("SELECT cantidad FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1", [t]);
  const totalNow = Number(st?.cantidad || 0);

  // Guardar movimiento de entrada
  await db.run(
    "INSERT INTO recepciones_movimientos(tipo, etiqueta, delta, total, fecha, unidad, action, ref_recepcion_id) VALUES(?,?,?,?,?,?,?,?)",
    [t, et, c, totalNow, f, u, existingRef ? 'add' : 'create', r?.lastID]
  );

  await logEvent(req, {
    action: existingRef ? 'add' : 'create',
    entity: 'recepciones',
    entityId: r?.lastID,
    detail: JSON.stringify({ tipo: t, etiqueta: et, cantidad: c, fecha: f, unidad: u, total: totalNow })
  });

  res.json({ ok: true });
});

// Ajuste de stock desde Recepción (establece una nueva base; movimientos previos quedan como historial y dejan de influir en el stock actual)
app.post('/api/recepciones/ajuste', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { tipo, cantidad, unidad, fecha, confirm_adjust } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').trim().slice(0, 64);
  const u = String(unidad || '').trim().slice(0, 16);
  const f = String(fecha || '').trim().slice(0, 32);

  if (!t || !Number.isFinite(c) || c < 0) {
    return res.status(400).json({ error: 'invalid' });
  }

  const stock = await db.get(
    "SELECT * FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1",
    [t]
  );
  const lastRec = await db.get(
    "SELECT etiqueta, unidad FROM recepciones WHERE LOWER(tipo)=LOWER(?) ORDER BY created_at DESC, id DESC LIMIT 1",
    [t]
  );

  if (!stock && !lastRec) return res.status(404).json({ error: 'not_found' });

  const expectedUnit = String(stock?.unidad || lastRec?.unidad || '').trim();
  const expectedLabel = String(stock?.etiqueta || lastRec?.etiqueta || '').trim();

  if (u && expectedUnit && u !== expectedUnit) {
    return res.status(400).json({ error: 'unit_mismatch', expected: expectedUnit });
  }

  // Confirmación explícita para evitar ajustes accidentales
  if (!String(confirm_adjust || '').trim()) {
    return res.status(409).json({
      error: 'confirm_adjust_required',
      current: {
        tipo: t,
        etiqueta: expectedLabel,
        unidad: expectedUnit,
        stock_actual: Number(stock?.cantidad || 0)
      }
    });
  }

  const prevQty = Number(stock?.cantidad || 0);

  await db.run(
    "INSERT INTO stock_ajustes(tipo, cantidad, unidad) VALUES(?,?,?)",
    [t, c, expectedUnit || u]
  );

  // Recalcular stock (a partir del ajuste en adelante)
  await rebuildStockForTipo(t);
  const st = await db.get("SELECT cantidad FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1", [t]);
  const totalNow = Number(st?.cantidad || c);

  // Registrar movimiento de ajuste (delta puede ser +/-)
  const delta = totalNow - prevQty;
  await db.run(
    "INSERT INTO recepciones_movimientos(tipo, etiqueta, delta, total, fecha, unidad, action, ref_recepcion_id) VALUES(?,?,?,?,?,?,?,?)",
    [t, expectedLabel, delta, totalNow, (f || new Date().toISOString()), expectedUnit || u, 'adjust', null]
  );

  await logEvent(req, {
    action: 'adjust',
    entity: 'stock_ajustes',
    detail: JSON.stringify({ tipo: t, from: prevQty, to: totalNow, unidad: expectedUnit || u })
  });

  res.json({ ok: true });
});

// Historial global de movimientos de recepciones (entradas/ajustes/eliminaciones)
app.get('/api/recepciones/movimientos', requireAuth, async (req, res) => {
  const { from, to, q, action, limit, offset } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo', 'unidad', 'etiqueta', 'action']);
  const a = String(action || '').trim().slice(0, 32);
  const aClause = a ? "LOWER(action)=LOWER(?)" : "";
  const aParams = a ? [a] : [];
  const mw = mergeWhere(f.where, f.params, [s.clause, aClause], [...s.params, ...aParams]);

  const lim = Math.min(parseInt(limit || '200', 10) || 200, 500);
  const off = Math.max(parseInt(offset || '0', 10) || 0, 0);

  const items = await db.all(
    `SELECT * FROM recepciones_movimientos ${mw.where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...mw.params, lim, off]
  );

  res.json({ items: items || [] });
});

app.put('/api/recepciones/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { tipo, etiqueta, cantidad, fecha, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').trim().slice(0, 64);
  const et = String(etiqueta || '').trim().slice(0, 64);
  const f = String(fecha || '').trim().slice(0, 32);
  const u = String(unidad || '').trim().slice(0, 16);

  if (!id || !t || !Number.isFinite(c) || c <= 0 || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  const old = await db.get("SELECT * FROM recepciones WHERE id=?", [id]);
  if (!old) return res.status(404).json({ error: 'not_found' });

  await db.run(
    "UPDATE recepciones SET tipo=?, etiqueta=?, cantidad=?, fecha=?, unidad=? WHERE id=?",
    [t, et, c, f, u, id]
  );
  // Registrar ajuste manual (edición)
  const delta = c - Number(old.cantidad || 0);
  await db.run("INSERT INTO recepciones_movimientos(tipo, etiqueta, delta, total, fecha, unidad, action, ref_recepcion_id) VALUES(?,?,?,?,?,?,?,?)",
    [t, et, delta, c, f, u, 'adjust', id]
  );

	  // Ajuste absoluto de stock: a partir de este punto el stock pasa a ser el valor indicado.
	  // Se ignora el historial previo (entradas/retiros anteriores) y desde aquí se aplican nuevos movimientos.
	  try {
	    await db.run("INSERT INTO stock_ajustes(tipo, cantidad, unidad) VALUES(?,?,?)", [t, c, u]);
	  } catch (_) {}

  await logEvent(req, { action: 'update', entity: 'recepciones', entityId: id, detail: JSON.stringify({ tipo: t, etiqueta: et, cantidad: c, fecha: f, unidad: u }) });

  // Mantener stock consistente (si cambió el tipo, recalcular ambos)
  await rebuildStockForTipo(old.tipo);
  if (String(old.tipo || '').toLowerCase() !== String(t || '').toLowerCase()) {
    await rebuildStockForTipo(t);
  }

  res.json({ ok: true });
});

app.delete('/api/recepciones/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid' });
  const old = await db.get("SELECT * FROM recepciones WHERE id=?", [id]);
  
  // Registrar eliminación como movimiento (para trazabilidad)
  try {
    await db.run("INSERT INTO recepciones_movimientos(tipo, etiqueta, delta, total, fecha, unidad, action, ref_recepcion_id) VALUES(?,?,?,?,?,?,?,?)",
      [String(old.tipo || ''), String(old.etiqueta || ''), -Number(old.cantidad || 0), 0, String(old.fecha || ''), String(old.unidad || ''), 'delete', id]
    );
  } catch (_) {}
await db.run("DELETE FROM recepciones WHERE id=?", [id]);
  await logEvent(req, { action: 'delete', entity: 'recepciones', entityId: id });
  if (old && old.tipo) {
    await rebuildStockForTipo(old.tipo);
  }
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Stock de productos (derivado de Recepción + Retiros)
// -----------------------------------------------------------------------------
app.get('/api/stock', requireAuth, async (req, res) => {
  const items = await db.all("SELECT * FROM stock_productos ORDER BY tipo ASC");
  res.json({ items });
});

app.get('/api/stock/retiros', requireRole('supervisor', 'administrador'), async (req, res) => {
  const items = await db.all(
    "SELECT * FROM stock_retiros ORDER BY created_at DESC LIMIT 500"
  );
  res.json({ items });
});

app.post('/api/stock/retiro', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { tipo, cantidad, unidad } = req.body || {};
  const t = String(tipo || '').trim().slice(0, 64);
  const c = parseInt(cantidad, 10);
  const u = String(unidad || '').trim().slice(0, 16);

  if (!t || !Number.isFinite(c) || c <= 0) {
    return res.status(400).json({ error: 'invalid' });
  }

  const stock = await db.get(
    "SELECT * FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1",
    [t]
  );
  if (!stock) return res.status(404).json({ error: 'not_found' });

  const su = String(stock.unidad || '').trim();
  if (u && su && u !== su) {
    return res.status(400).json({ error: 'unit_mismatch' });
  }

  const currentQty = Number(stock.cantidad || 0);
  if (c > currentQty) {
    return res.status(400).json({ error: 'insufficient_stock' });
  }

  await db.run(
    "UPDATE stock_productos SET cantidad = CAST(cantidad AS INTEGER) - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [c, stock.id]
  );
  const nowIso = new Date().toISOString();
  await db.run(
    "INSERT INTO stock_retiros(tipo,cantidad,unidad,fecha) VALUES(?,?,?,?)",
    [String(stock.tipo || t), c, su || u, nowIso]
  );

  await logEvent(req, {
    action: 'stock_withdraw',
    entity: 'stock_productos',
    entityId: String(stock.id),
    detail: JSON.stringify({ tipo: stock.tipo, cantidad: c, unidad: su || u })
  });

  // Recalcular por si hay inconsistencias
  await rebuildStockForTipo(stock.tipo || t);
  res.json({ ok: true });
});

// Eliminar un producto del stock por completo (incluye recepciones, movimientos, retiros y ajustes)
app.post('/api/stock/delete-product', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { tipo } = req.body || {};
  const t = String(tipo || '').trim().slice(0, 64);
  if (!t) return res.status(400).json({ error: 'invalid' });

  try {
    // El orden evita registros huérfanos en historiales.
    await db.run("DELETE FROM stock_productos WHERE LOWER(tipo)=LOWER(?)", [t]);
    await db.run("DELETE FROM stock_retiros WHERE LOWER(tipo)=LOWER(?)", [t]);
    await db.run("DELETE FROM recepciones_movimientos WHERE LOWER(tipo)=LOWER(?)", [t]);
    await db.run("DELETE FROM recepciones WHERE LOWER(tipo)=LOWER(?)", [t]);
    await db.run("DELETE FROM stock_ajustes WHERE LOWER(tipo)=LOWER(?)", [t]);

    await logEvent(req, {
      action: 'stock_delete_product',
      entity: 'stock_productos',
      detail: JSON.stringify({ tipo: t })
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('Error eliminando producto de stock:', e?.message || e);
    return res.status(500).json({ error: 'internal' });
  }
});

// -----------------------------------------------------------------------------
// Maquinaria (solo supervisor/administrador)
// -----------------------------------------------------------------------------
app.get('/api/maquinaria', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['maquina','servicio','descripcion']);
  const mw = mergeWhere(f.where, f.params, [s.clause], s.params);
  const list = await db.all(
    `SELECT * FROM maquinaria_logs ${mw.where} ORDER BY fecha DESC, created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

app.post('/api/maquinaria', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { maquina, servicio, fecha, descripcion } = req.body || {};
  const m = String(maquina || '').trim().slice(0, 48);
  const s = String(servicio || '').trim().slice(0, 64);
  const f = String(fecha || '').trim().slice(0, 32);
  const d = String(descripcion || '').trim().slice(0, 400);
  if (!m || !s || !f) return res.status(400).json({ error: 'invalid' });
  const r = await db.run(
    "INSERT INTO maquinaria_logs(maquina,servicio,fecha,descripcion) VALUES(?,?,?,?)",
    [m, s, f, d]
  );
  await logEvent(req, { action: 'create', entity: 'maquinaria', entityId: String(r.lastID), detail: JSON.stringify({ maquina: m, servicio: s, fecha: f }) });
  res.json({ ok: true, id: r.lastID });
});

app.put('/api/maquinaria/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const { maquina, servicio, fecha, descripcion } = req.body || {};
  const m = String(maquina || '').trim().slice(0, 48);
  const s = String(servicio || '').trim().slice(0, 64);
  const f = String(fecha || '').trim().slice(0, 32);
  const d = String(descripcion || '').trim().slice(0, 400);
  if (!m || !s || !f) return res.status(400).json({ error: 'invalid' });

  const exists = await db.get("SELECT id FROM maquinaria_logs WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  await db.run(
    "UPDATE maquinaria_logs SET maquina = ?, servicio = ?, fecha = ?, descripcion = ? WHERE id = ?",
    [m, s, f, d, id]
  );
  await logEvent(req, { action: 'update', entity: 'maquinaria', entityId: String(id), detail: JSON.stringify({ maquina: m, servicio: s, fecha: f }) });
  res.json({ ok: true });
});

app.delete('/api/maquinaria/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const exists = await db.get("SELECT id FROM maquinaria_logs WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  await db.run("DELETE FROM maquinaria_logs WHERE id = ?", [id]);
  await logEvent(req, { action: 'delete', entity: 'maquinaria', entityId: String(id), detail: '' });
  res.json({ ok: true });
});


// -----------------------------------------------------------------------------
// Repuestos e inventario (solo supervisor/administrador)
// -----------------------------------------------------------------------------
app.get('/api/repuestos', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['repuesto','observaciones']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM repuestos_inventario ${mw.where} ORDER BY fecha DESC, created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

app.post('/api/repuestos', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { repuesto, cantidad, fecha, observaciones } = req.body || {};
  const r = String(repuesto || '').trim().slice(0, 80);
  const c = parseInt(cantidad, 10);
  const f = String(fecha || '').trim().slice(0, 32);
  const o = String(observaciones || '').trim().slice(0, 400);
  if (!r || !Number.isFinite(c) || c < 0 || !f) return res.status(400).json({ error: 'invalid' });
  const rr = await db.run(
    "INSERT INTO repuestos_inventario(repuesto,cantidad,fecha,observaciones) VALUES(?,?,?,?)",
    [r, c, f, o]
  );
  await logEvent(req, { action: 'create', entity: 'repuestos', entityId: String(rr.lastID), detail: JSON.stringify({ repuesto: r, cantidad: c, fecha: f }) });
  res.json({ ok: true, id: rr.lastID });
});

app.put('/api/repuestos/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const { repuesto, cantidad, fecha, observaciones } = req.body || {};
  const r = String(repuesto || '').trim().slice(0, 80);
  const c = parseInt(cantidad, 10);
  const f = String(fecha || '').trim().slice(0, 32);
  const o = String(observaciones || '').trim().slice(0, 400);
  if (!r || !Number.isFinite(c) || c < 0 || !f) return res.status(400).json({ error: 'invalid' });

  const exists = await db.get("SELECT id FROM repuestos_inventario WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  await db.run(
    "UPDATE repuestos_inventario SET repuesto = ?, cantidad = ?, fecha = ?, observaciones = ? WHERE id = ?",
    [r, c, f, o, id]
  );
  await logEvent(req, { action: 'update', entity: 'repuestos', entityId: String(id), detail: JSON.stringify({ repuesto: r, cantidad: c, fecha: f }) });
  res.json({ ok: true });
});

app.delete('/api/repuestos/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const exists = await db.get("SELECT id FROM repuestos_inventario WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  await db.run("DELETE FROM repuestos_inventario WHERE id = ?", [id]);
  await logEvent(req, { action: 'delete', entity: 'repuestos', entityId: String(id), detail: '' });
  res.json({ ok: true });
});


// -----------------------------------------------------------------------------
// Producción
// -----------------------------------------------------------------------------
app.get('/api/produccion', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha_ini', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM produccion ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

app.post('/api/produccion', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { fecha_ini, fecha_fin, cantidad, tipo, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const fi = String(fecha_ini || '').slice(0, 32);
  const ff = String(fecha_fin || fecha_ini || '').slice(0, 32);
  const tp = String(tipo || '').slice(0, 64);
  const u = String(unidad || '').slice(0, 16);

  if (!Number.isFinite(c) || c <= 0 || !fi || !ff || !tp) {
    return res.status(400).json({ error: 'invalid' });
  }

  const r = await db.run(
    "INSERT INTO produccion(fecha_ini,fecha_fin,tipo,cantidad,unidad) VALUES(?,?,?,?,?)",
    [fi, ff, tp, c, u]
  );
  await logEvent(req, { action: 'create', entity: 'produccion', entityId: String(r.lastID), detail: JSON.stringify({ tipo: tp, cantidad: c, fecha_ini: fi, fecha_fin: ff, unidad: u }) });
  res.json({ ok: true });
});

app.put('/api/produccion/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { fecha_ini, fecha_fin, cantidad, tipo, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const fi = String(fecha_ini || '').slice(0, 32);
  const ff = String(fecha_fin || fecha_ini || '').slice(0, 32);
  const tp = String(tipo || '').slice(0, 64);
  const u = String(unidad || '').slice(0, 16);

  if (!id || !Number.isFinite(c) || c <= 0 || !fi || !ff || !tp) {
    return res.status(400).json({ error: 'invalid' });
  }

  await db.run(
    "UPDATE produccion SET fecha_ini=?, fecha_fin=?, tipo=?, cantidad=?, unidad=? WHERE id=?",
    [fi, ff, tp, c, u, id]
  );
  res.json({ ok: true });
});

app.delete('/api/produccion/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid' });
  await db.run("DELETE FROM produccion WHERE id=?", [id]);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Defectuosos
// -----------------------------------------------------------------------------
app.get('/api/defectuosos', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','razon','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM defectuosos ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

app.post('/api/defectuosos', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { tipo, cantidad, razon, fecha, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').slice(0, 64);
  const r = String(razon || '').slice(0, 256);
  const f = String(fecha || '').slice(0, 32);
  const u = String(unidad || '').slice(0, 16);

  if (!Number.isFinite(c) || c <= 0 || !t || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  const rr = await db.run(
    "INSERT INTO defectuosos(tipo,cantidad,razon,fecha,unidad) VALUES(?,?,?,?,?)",
    [t, c, r, f, u]
  );
  await logEvent(req, { action: 'create', entity: 'defectuosos', entityId: String(rr.lastID), detail: JSON.stringify({ tipo: t, cantidad: c, razon: r, fecha: f, unidad: u }) });
  res.json({ ok: true });
});

app.put('/api/defectuosos/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { tipo, cantidad, razon, fecha, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').slice(0, 64);
  const r = String(razon || '').slice(0, 256);
  const f = String(fecha || '').slice(0, 32);
  const u = String(unidad || '').slice(0, 16);

  if (!id || !Number.isFinite(c) || c <= 0 || !t || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  await db.run(
    "UPDATE defectuosos SET tipo=?, cantidad=?, razon=?, fecha=?, unidad=? WHERE id=?",
    [t, c, r, f, u, id]
  );
  res.json({ ok: true });
});

app.delete('/api/defectuosos/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid' });
  await db.run("DELETE FROM defectuosos WHERE id=?", [id]);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Envíos
// -----------------------------------------------------------------------------
app.get('/api/envios', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['cliente','tipo','descripcion','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM envios ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  res.json({ items: list });
});

app.post('/api/envios', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { cantidad, tipo, descripcion = '', cliente, fecha, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').slice(0, 64);
  const d = String(descripcion || '').slice(0, 256);
  const cl = String(cliente || '').slice(0, 128);
  const f = String(fecha || '').slice(0, 32);
  const u = String(unidad || '').slice(0, 16);

  if (!Number.isFinite(c) || c <= 0 || !t || !cl || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  const r = await db.run(
    "INSERT INTO envios(cantidad,tipo,descripcion,cliente,fecha,unidad) VALUES(?,?,?,?,?,?)",
    [c, t, d, cl, f, u]
  );
  await logEvent(req, { action: 'create', entity: 'envios', entityId: String(r.lastID), detail: JSON.stringify({ tipo: t, cantidad: c, descripcion: d, cliente: cl, fecha: f, unidad: u }) });
  res.json({ ok: true });
});

app.put('/api/envios/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { cantidad, tipo, descripcion = '', cliente, fecha, unidad } = req.body || {};
  const c = parseInt(cantidad, 10);
  const t = String(tipo || '').slice(0, 64);
  const d = String(descripcion || '').slice(0, 256);
  const cl = String(cliente || '').slice(0, 128);
  const f = String(fecha || '').slice(0, 32);
  const u = String(unidad || '').slice(0, 16);

  if (!id || !Number.isFinite(c) || c <= 0 || !t || !cl || !f) {
    return res.status(400).json({ error: 'invalid' });
  }

  await db.run(
    "UPDATE envios SET cantidad=?, tipo=?, descripcion=?, cliente=?, fecha=?, unidad=? WHERE id=?",
    [c, t, d, cl, f, u, id]
  );
  res.json({ ok: true });
});

app.delete('/api/envios/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid' });
  await db.run("DELETE FROM envios WHERE id=?", [id]);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// PDFs BONITOS
// -----------------------------------------------------------------------------
function formatPdfDateOnly(s) {
  if (!s) return '';
  return formatDateYmdToDmy(s);
}

function formatPdfDateTime(s) {
  if (!s) return '';
  return formatDateTimeYmdToDmy(s);
}

function startPdf(res, filename, title) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(res);

  try {
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 36, 24, { fit: [60, 60] });
    }
  } catch (e) {
    // Si falla el logo, seguimos igual
  }

  doc
    .fillColor('#ff8c1a')
    .fontSize(22)
    .text('BRUMAP', 110, 32);

  doc
    .moveDown()
    .fillColor('#000000')
    .fontSize(14)
    .text(title, { align: 'center' });

  const now = new Date();
  const nowStr = now.toLocaleString('es-PE', {
    timeZone: 'America/Lima'
  });

  doc
    .moveDown(0.5)
    .fontSize(9)
    .fillColor('#555555')
    .text(`Generado: ${nowStr}`, { align: 'right' });

  doc.moveDown(1);
  return doc;
}

function drawTable(doc, headers, widths, rowValues) {
  const marginX = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const tableWidth = doc.page.width - marginX - marginRight;

  // Asegura que widths sume aproximadamente el ancho disponible
  // (si no coincide, PDFKit igual respeta los widths declarados)
  const headerH = 20;
  const minRowH = 18;

  let y = doc.y;

  function drawHeader() {
    doc
      .save()
      .fillColor('#ff8c1a')
      .rect(marginX, y, tableWidth, headerH)
      .fill();

    doc.fillColor('#181818').fontSize(10).font('Helvetica-Bold');
    let x = marginX + 4;
    headers.forEach((h, i) => {
      doc.text(String(h), x, y + 5, { width: widths[i] - 8 });
      x += widths[i];
    });
    doc.restore();
    doc.font('Helvetica');
    y += headerH;
  }

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

  drawHeader();
  doc.fontSize(10).fillColor('#000000');

  for (const cols of rowValues) {
    // Calcula altura dinámica por contenido (wrap)
    let maxH = 0;
    for (let i = 0; i < cols.length; i++) {
      const txt = cols[i] === null || cols[i] === undefined ? '' : String(cols[i]);
      const w = Math.max(20, (widths[i] || 0) - 8);
      const h = doc.heightOfString(txt, { width: w, lineBreak: true });
      if (h > maxH) maxH = h;
    }
    const rowH = Math.max(minRowH, Math.ceil(maxH) + 8);

    // Salto de página si no entra
    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
      doc.fontSize(10).fillColor('#000000');
    }

    // Dibuja celdas (texto con wrap)
    let x = marginX + 4;
    for (let i = 0; i < cols.length; i++) {
      const txt = cols[i] === null || cols[i] === undefined ? '' : String(cols[i]);
      doc.text(txt, x, y + 4, {
        width: widths[i] - 8,
        lineBreak: true
      });
      x += widths[i];
    }

    // Línea inferior de la fila
    doc
      .moveTo(marginX, y + rowH - 1)
      .lineTo(marginX + tableWidth, y + rowH - 1)
      .strokeColor('#3a3d44')
      .lineWidth(0.5)
      .stroke();

    y += rowH;
  }

  doc.moveDown();
  doc.y = y + 4;
}


// -----------------------------------------------------------------------------
// Exportación XLSX (Excel)
// -----------------------------------------------------------------------------
function sendXlsx(res, filename, sheets) {
  // sheets: Array<{ name: string, aoa: any[][] }>
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(buf);
}

// Formateo de timestamps (SQLite UTC) a hora local de Lima (Perú)
function formatTsLima(ts) {
  if (!ts) return '';
  let d;

  if (typeof ts === 'string') {
    const s = ts.trim();
    // SQLite CURRENT_TIMESTAMP devuelve UTC como 'YYYY-MM-DD HH:MM:SS'
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
      d = new Date(s.replace(' ', 'T') + 'Z'); // interpretar como UTC
    } else {
      d = new Date(s);
    }
  } else {
    d = new Date(ts);
  }

  if (isNaN(d.getTime())) return String(ts);

  const fmt = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = fmt.formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

function safeSheetName(name) {
  const s = String(name || 'Sheet').replace(/[\\/\?\*\[\]]/g, '-');
  return s.length > 31 ? s.slice(0, 31) : s;
}

// PDFs por módulo
app.get('/api/recepciones.pdf', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM recepciones ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'recepciones.pdf', 'Recepción de Materiales');

  const headers = ['Fecha', 'Tipo', 'Etiqueta', 'Cantidad', 'Unidad'];
  const widths = [90, 210, 150, 60, 55];

  const rows = list.map(r => [
    formatPdfDateTime(r.fecha),
    r.tipo,
    r.etiqueta || '',
    r.cantidad,
    r.unidad || ''
  ]);

  drawTable(doc, headers, widths, rows);
  doc.end();
});

// Stock actual (export PDF)
app.get('/api/stock.pdf', requireAuth, async (req, res) => {
  const { q, min, max } = req.query || {};
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere('', [], [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM stock_productos ${mw.where} ORDER BY tipo ASC`,
    mw.params
  );
  const doc = startPdf(res, 'stock_materiales.pdf', 'Stock de Materiales');
  const headers = ['Material', 'Etiqueta', 'Cantidad', 'Unidad', 'Estado', 'Actualizado'];
  const widths = [170, 125, 55, 55, 70, 90];
  const rows = list.map(r => [
    r.tipo,
    r.etiqueta || '',
    r.cantidad,
    r.unidad || '',
    (Number(r.cantidad ?? 0) > 0 ? 'Disponible' : 'Agotado'),
    formatPdfDateTime(r.updated_at)
  ]);
  drawTable(doc, headers, widths, rows);
  doc.end();
});

// Historial de retiros (export PDF)
app.get('/api/stock_retiros.pdf', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM stock_retiros ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'stock_retiros.pdf', 'Historial de Retiros de Materiales');
  const headers = ['Fecha', 'Material', 'Cantidad', 'Unidad'];
  const widths = [100, 230, 70, 60];
  const rows = list.map(r => [
    formatPdfDateTime(r.fecha),
    r.tipo,
    r.cantidad,
    r.unidad || ''
  ]);
  drawTable(doc, headers, widths, rows);
  doc.end();
});

// Maquinaria (export PDF)
app.get('/api/maquinaria.pdf', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['maquina','servicio','descripcion']);
  const mw = mergeWhere(f.where, f.params, [s.clause], s.params);
  const list = await db.all(
    `SELECT * FROM maquinaria_logs ${mw.where} ORDER BY fecha DESC, created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'maquinaria.pdf', 'Maquinaria – Servicios');
  const headers = ['Fecha', 'Máquina', 'Servicio', 'Descripción'];
  const widths = [95, 85, 90, 180];
  const rows = list.map(r => [
    formatPdfDateTime(r.fecha),
    r.maquina,
    r.servicio,
    r.descripcion || ''
  ]);
  drawTable(doc, headers, widths, rows);
  doc.end();
});

// Repuestos e inventario (export PDF)
app.get('/api/repuestos.pdf', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['repuesto','observaciones']);
  const mw = mergeWhere(f.where, f.params, [s.clause], s.params);
  const list = await db.all(
    `SELECT * FROM repuestos_inventario ${mw.where} ORDER BY fecha DESC, created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'repuestos_inventario.pdf', 'Repuestos e Inventario');
	  const headers = ['Fecha', 'Repuesto', 'Cantidad', 'Estado', 'Descripción'];
  const widths = [90, 140, 60, 70, 120];
  const rows = list.map(r => [
    formatPdfDateTime(r.fecha),
    r.repuesto,
    r.cantidad,
    (Number(r.cantidad || 0) > 0 ? 'Disponible' : 'No disponible'),
    r.observaciones || ''
  ]);
  drawTable(doc, headers, widths, rows);
  doc.end();
});

app.get('/api/produccion.pdf', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha_ini', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM produccion ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'produccion.pdf', 'Producción');

  const headers = ['Fecha', 'Tipo de producto', 'Cantidad', 'Unidad'];
  const widths = [90, 270, 70, 60];

  const rows = list.map(r => [
    formatPdfDateTime(r.fecha_ini),
    r.tipo || '',
    r.cantidad,
    r.unidad || ''
  ]);

  drawTable(doc, headers, widths, rows);
  doc.end();
});
app.get('/api/defectuosos.pdf', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','razon','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM defectuosos ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'defectuosos.pdf', 'Manejo de Material Defectuoso');

  const headers = ['Fecha', 'Tipo', 'Cantidad', 'Unidad', 'Razón'];
  const widths = [80, 200, 60, 60, 120];

  const rows = list.map(r => [
    formatPdfDateOnly(r.fecha),
    r.tipo,
    r.cantidad,
    r.unidad || '',
    r.razon || ''
  ]);

  drawTable(doc, headers, widths, rows);
  doc.end();
});
app.get('/api/envios.pdf', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['cliente','tipo','descripcion','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM envios ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const doc = startPdf(res, 'envios.pdf', 'Envío de Productos Terminados');

  const headers = ['Fecha', 'Cliente', 'Tipo', 'Detalle', 'Cantidad', 'Unidad'];
  const widths = [80, 120, 140, 160, 60, 60];

  const rows = list.map(r => [
    formatPdfDateOnly(r.fecha),
    r.cliente,
    r.tipo,
    r.descripcion || '',
    r.cantidad,
    r.unidad || ''
  ]);

  drawTable(doc, headers, widths, rows);
  doc.end();
});
// XLSX por módulo (respeta filtros from/to)
app.get('/api/recepciones.xlsx', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM recepciones ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const aoa = [
    ['Fecha', 'Tipo', 'Etiqueta', 'Cantidad', 'Unidad'],
    ...list.map(r => [formatPdfDateTime(r.fecha), r.tipo, r.etiqueta || '', r.cantidad, r.unidad || ''])
  ];
  sendXlsx(res, 'recepciones.xlsx', [{ name: safeSheetName('Recepciones'), aoa }]);
});
app.get('/api/produccion.xlsx', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha_ini', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM produccion ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const aoa = [
    ['Fecha', 'Tipo de producto', 'Cantidad', 'Unidad'],
    ...list.map(r => [formatPdfDateTime(r.fecha_ini), r.tipo || '', r.cantidad, r.unidad || ''])
  ];
  sendXlsx(res, 'produccion.xlsx', [{ name: safeSheetName('Produccion'), aoa }]);
});
app.get('/api/defectuosos.xlsx', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','razon','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM defectuosos ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const aoa = [
    ['Fecha', 'Tipo', 'Cantidad', 'Unidad', 'Razón'],
    ...list.map(r => [formatPdfDateOnly(r.fecha), r.tipo, r.cantidad, r.unidad || '', r.razon || ''])
  ];
  sendXlsx(res, 'defectuosos.xlsx', [{ name: safeSheetName('Defectuosos'), aoa }]);
});
app.get('/api/envios.xlsx', requireAuth, async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['cliente','tipo','descripcion','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(
    `SELECT * FROM envios ${mw.where} ORDER BY created_at DESC`,
    mw.params
  );
  const aoa = [
    ['Fecha', 'Cliente', 'Tipo', 'Detalle', 'Cantidad', 'Unidad'],
    ...list.map(r => [
      formatPdfDateOnly(r.fecha),
      r.cliente,
      r.tipo,
      r.descripcion || '',
      r.cantidad,
      r.unidad || ''
    ])
  ];
  sendXlsx(res, 'envios.xlsx', [{ name: safeSheetName('Envios'), aoa }]);
});

// Stock actual (export XLSX)
app.get('/api/stock.xlsx', requireAuth, async (req, res) => {
  const { q, min, max } = req.query || {};
  const s = buildTextSearchWhere(q, ['tipo','unidad','etiqueta']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere('', [], [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(`SELECT * FROM stock_productos ${mw.where} ORDER BY tipo ASC`, mw.params);
  const aoa = [
    ['Material', 'Etiqueta', 'Cantidad', 'Unidad', 'Estado', 'Actualizado'],
    ...list.map(r => [r.tipo, r.etiqueta || '', r.cantidad, r.unidad || '', (Number(r.cantidad ?? 0) > 0 ? 'Disponible' : 'Agotado'), formatPdfDateTime(r.updated_at)])
  ];
  sendXlsx(res, 'stock_materiales.xlsx', [{ name: safeSheetName('Stock'), aoa }]);
});

// Historial de retiros (export XLSX)
app.get('/api/stock_retiros.xlsx', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q, min, max } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['tipo','unidad']);
  const qty = buildQtyWhere(min, max, 'cantidad');
  const mw = mergeWhere(f.where, f.params, [s.clause, qty.clause], [...s.params, ...qty.params]);
  const list = await db.all(`SELECT * FROM stock_retiros ${mw.where} ORDER BY created_at DESC`, mw.params);
  const aoa = [
    ['Fecha', 'Material', 'Cantidad', 'Unidad'],
    ...list.map(r => [formatPdfDateTime(r.fecha), r.tipo, r.cantidad, r.unidad || ''])
  ];
  sendXlsx(res, 'stock_retiros.xlsx', [{ name: safeSheetName('Retiros'), aoa }]);
});

// Maquinaria (export XLSX)
app.get('/api/maquinaria.xlsx', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['maquina','servicio','descripcion']);
  const mw = mergeWhere(f.where, f.params, [s.clause], s.params);
  const list = await db.all(`SELECT * FROM maquinaria_logs ${mw.where} ORDER BY fecha DESC, created_at DESC`, mw.params);
  const aoa = [
    ['Fecha', 'Máquina', 'Servicio', 'Descripción'],
    ...list.map(r => [formatPdfDateTime(r.fecha), r.maquina, r.servicio, r.descripcion || ''])
  ];
  sendXlsx(res, 'maquinaria.xlsx', [{ name: safeSheetName('Maquinaria'), aoa }]);
});

// Repuestos e inventario (export XLSX)
app.get('/api/repuestos.xlsx', requireRole('supervisor', 'administrador'), async (req, res) => {
  const { from, to, q } = req.query || {};
  const f = buildDateWhere({ field: 'fecha', from, to });
  const s = buildTextSearchWhere(q, ['repuesto','observaciones']);
  const mw = mergeWhere(f.where, f.params, [s.clause], s.params);
  const list = await db.all(`SELECT * FROM repuestos_inventario ${mw.where} ORDER BY fecha DESC, created_at DESC`, mw.params);
  const aoa = [
	    ['Fecha', 'Repuesto', 'Cantidad', 'Estado', 'Descripción'],
    ...list.map(r => [
      formatPdfDateTime(r.fecha),
      r.repuesto,
      r.cantidad,
      (Number(r.cantidad || 0) > 0 ? 'Disponible' : 'No disponible'),
      r.observaciones || ''
    ])
  ];
  sendXlsx(res, 'repuestos_inventario.xlsx', [{ name: safeSheetName('Repuestos'), aoa }]);
});
app.get('/api/registros.pdf', requireAuth, async (req, res) => {
  const doc = startPdf(res, 'registros_completos.pdf', 'Registro Completo de Operaciones');

  const { from, to } = req.query || {};

  const sections = [
    {
      titulo: 'Recepción de Materiales',
      table: 'recepciones',
      field: 'fecha',
      headers: ['Fecha', 'Tipo', 'Etiqueta', 'Cantidad', 'Unidad'],
      widths: [90, 170, 150, 80, 60],
      map: r => [
        formatPdfDateTime(r.fecha),
        r.tipo,
        r.etiqueta || '',
        r.cantidad,
        r.unidad || ''
      ]
    },
    {
      titulo: 'Producción',
      table: 'produccion',
      field: 'fecha_ini',
      headers: ['Fecha', 'Tipo de producto', 'Cantidad', 'Unidad'],
      widths: [100, 210, 80, 60],
      map: r => [
        formatPdfDateTime(r.fecha_ini),
        r.tipo || '',
        r.cantidad,
        r.unidad || ''
      ]
    },
    {
      titulo: 'Manejo de Material Defectuoso',
      table: 'defectuosos',
      field: 'fecha',
      headers: ['Fecha', 'Tipo', 'Cantidad', 'Unidad', 'Razón'],
      widths: [80, 130, 60, 60, 140],
      map: r => [
        formatPdfDateOnly(r.fecha),
        r.tipo,
        r.cantidad,
        r.unidad || '',
        r.razon || ''
      ]
    },
    {
      titulo: 'Envío de Productos Terminados',
      table: 'envios',
      field: 'fecha',
      headers: ['Fecha', 'Cliente', 'Tipo', 'Detalle', 'Cantidad', 'Unidad'],
      widths: [80, 120, 80, 120, 60, 60],
      map: r => [
        formatPdfDateOnly(r.fecha),
        r.cliente,
        r.tipo,
        r.descripcion || '',
        r.cantidad,
        r.unidad || ''
      ]
    }
  ];

  let first = true;
  for (const s of sections) {
    const f = buildDateWhere({ field: s.field, from, to });
    const list = await db.all(
      `SELECT * FROM ${s.table} ${f.where} ORDER BY created_at DESC`,
      f.params
    );
    if (!first) {
      doc.addPage();
    } else {
      first = false;
    }

    doc
      .fontSize(13)
      .fillColor('#000000')
      .text(s.titulo, { align: 'left' })
      .moveDown(0.5);

    const rows = list.map(s.map);
    drawTable(doc, s.headers, s.widths, rows);
  }

  doc.end();
});

app.get('/api/registros.xlsx', requireAuth, async (req, res) => {
  const { from, to } = req.query || {};

  const def = [
    {
      sheet: 'Recepciones',
      table: 'recepciones',
      field: 'fecha',
      headers: ['Fecha', 'Tipo', 'Etiqueta', 'Cantidad', 'Unidad'],
      map: r => [formatPdfDateTime(r.fecha), r.tipo, r.etiqueta || '', r.cantidad, r.unidad || '']
    },
    {
      sheet: 'Produccion',
      table: 'produccion',
      field: 'fecha_ini',
      headers: ['Fecha', 'Tipo de producto', 'Cantidad', 'Unidad'],
      map: r => [formatPdfDateTime(r.fecha_ini), r.tipo || '', r.cantidad, r.unidad || '']
    },
    {
      sheet: 'Defectuosos',
      table: 'defectuosos',
      field: 'fecha',
      headers: ['Fecha', 'Tipo', 'Cantidad', 'Unidad', 'Razón'],
      map: r => [formatPdfDateOnly(r.fecha), r.tipo, r.cantidad, r.unidad || '', r.razon || '']
    },
    {
      sheet: 'Envios',
      table: 'envios',
      field: 'fecha',
      headers: ['Fecha', 'Cliente', 'Tipo', 'Detalle', 'Cantidad', 'Unidad'],
      map: r => [
        formatPdfDateOnly(r.fecha),
        r.cliente,
        r.tipo,
        r.descripcion || '',
        r.cantidad,
        r.unidad || ''
      ]
    }
  ];

  const sheets = [];
  for (const s of def) {
    const f = buildDateWhere({ field: s.field, from, to });
    const list = await db.all(
      `SELECT * FROM ${s.table} ${f.where} ORDER BY created_at DESC`,
      f.params
    );
    const aoa = [s.headers, ...list.map(s.map)];
    sheets.push({ name: safeSheetName(s.sheet), aoa });
  }

  sendXlsx(res, 'registros_completos.xlsx', sheets);
});

// -----------------------------------------------------------------------------
// Users – gestión de roles y contraseñas
// -----------------------------------------------------------------------------
app.get('/api/users', requireRole('supervisor'), async (req, res) => {
  const u = await db.all("SELECT id,username,role,is_protected FROM users ORDER BY username");
  res.json({ items: u });
});

app.post('/api/users', requireRole('supervisor'), async (req, res) => {
  const { username, password, role } = req.body || {};
  const uname = String(username || '').toLowerCase();

  // No permitir clonar el usuario protegido
  if (uname === PROTECTED_SUPERVISOR_USERNAME) {
    return res.status(409).json({ error: 'protected-username' });
  }

  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
    return res.status(400).json({ error: 'invalid-username' });
  }
  if (!['operario', 'supervisor', 'administrador'].includes(role)) {
    return res.status(400).json({ error: 'invalid-role' });
  }
  const hp = await bcrypt.hash(String(password || 'admin'), 10);
  const rr = await db.run(
    "INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,0)",
    [uname, hp, role]
  );
  await logEvent(req, { action: 'create', entity: 'users', entityId: rr?.lastID, detail: JSON.stringify({ username: uname, role }) });
  res.json({ ok: true });
});

app.put('/api/users/:id', requireRole('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  if (!['operario', 'supervisor', 'administrador'].includes(role)) {
    return res.status(400).json({ error: 'invalid-role' });
  }

  const target = await db.get("SELECT id, username, role, is_protected FROM users WHERE id=?", [id]);
  if (!target) return res.status(404).json({ error: 'not-found' });
  if (Number(target.is_protected || 0) === 1) {
    return res.status(403).json({ error: 'protected-user' });
  }

  await db.run("UPDATE users SET role=? WHERE id=?", [role, id]);
  await logEvent(req, { action: 'update', entity: 'users', entityId: id, detail: JSON.stringify({ role }) });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireRole('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const target = await db.get("SELECT id, username, role, is_protected FROM users WHERE id=?", [id]);
  if (!target) return res.status(404).json({ error: 'not-found' });
  if (Number(target.is_protected || 0) === 1) {
    return res.status(403).json({ error: 'protected-user' });
  }

  // Evitar quedarse sin usuarios o sin supervisor
  const remainingUsers = await db.get("SELECT COUNT(*) as c FROM users WHERE id != ?", [id]);
  if ((remainingUsers?.c || 0) <= 0) {
    return res.status(409).json({ error: 'cannot-delete-last-user' });
  }
  if (String(target.role || '') === 'supervisor') {
    const remainingSup = await db.get("SELECT COUNT(*) as c FROM users WHERE role='supervisor' AND id != ?", [id]);
    if ((remainingSup?.c || 0) <= 0) {
      return res.status(409).json({ error: 'must-keep-supervisor' });
    }
  }

  await db.run("DELETE FROM users WHERE id=?", [id]);
  await logEvent(req, { action: 'delete', entity: 'users', entityId: id, detail: JSON.stringify({ username: target.username, role: target.role }) });
  res.json({ ok: true });
});

app.patch('/api/users/:id/password', requireRole('supervisor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { password } = req.body || {};

  const target = await db.get("SELECT id, username, is_protected FROM users WHERE id=?", [id]);
  if (!target) return res.status(404).json({ error: 'not-found' });
  if (Number(target.is_protected || 0) === 1) {
    return res.status(403).json({ error: 'protected-user' });
  }

  const hp = await bcrypt.hash(String(password || 'admin'), 10);
  await db.run("UPDATE users SET password=? WHERE id=?", [hp, id]);
  await logEvent(req, { action: 'update_password', entity: 'users', entityId: id });
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Healthcheck simple
// -----------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// -----------------------------------------------------------------------------
// Manejador global de errores
// -----------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'internal-error' });
});

// -----------------------------------------------------------------------------
// Inicio del servidor
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Brumap running at http://localhost:${PORT} (NODE_ENV=${NODE_ENV})`);
});