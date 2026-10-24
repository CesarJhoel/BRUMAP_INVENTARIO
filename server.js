import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { openDatabase } from './lib/database.js';
import { rebuildMaterialStock, saveStockAdjustment, nonNegativeInteger, localISO } from './lib/inventory.js';
import { createSessionStore } from './lib/session-store.js';
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import bcrypt from 'bcryptjs';
import { createWorkbook } from './lib/workbook.js';
import { completeOrder, shipProduct, OperationError } from './lib/production.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Express 4 no recoge automáticamente rechazos de controladores async.
const wrap = handler => typeof handler === 'function' && handler.length < 4
  ? (req,res,next) => Promise.resolve().then(() => handler(req,res,next)).catch(next) : handler;
for (const method of ['get','post','put','patch','delete','use']) {
  const original = app[method].bind(app);
  app[method] = (...args) => original(...args.map(wrap));
}
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const COOKIE_SECURE_ENV = process.env.COOKIE_SECURE === '1';
const USE_SECURE_COOKIES = COOKIE_SECURE_ENV && IS_PROD;

// Cuenta principal: protegida contra eliminación; su contraseña sí puede cambiarse.
const PROTECTED_SUPERVISOR_USERNAME = String(process.env.PROTECTED_SUPERVISOR_USERNAME || 'supervisor').toLowerCase();
const BOOTSTRAP_PASSWORD = process.env.BOOTSTRAP_PASSWORD || process.env.PROTECTED_SUPERVISOR_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? '' : crypto.randomBytes(32).toString('hex'));
if (IS_PROD && SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres. Ejecuta node scripts/setup.mjs.');
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 72; }

// Auditoría optimizada para VPS:
// - normal: guarda eventos administrativos y cambios relevantes, pero evita duplicar escaneos de stock que ya viven en Kardex.
// - verbose: guarda todo.
// - minimal: solo seguridad, usuarios, backups y eliminaciones.
// - AUDIT_ENABLED=0 desactiva event_logs sin afectar Kardex ni movimientos operativos.
const AUDIT_ENABLED = process.env.AUDIT_ENABLED !== '0';
const AUDIT_LEVEL = String(process.env.AUDIT_LEVEL || 'normal').toLowerCase();
const AUDIT_RETENTION_DAYS = Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS || '120', 10) || 120);
const AUDIT_MAX_ROWS = Math.max(500, parseInt(process.env.AUDIT_MAX_ROWS || '15000', 10) || 15000);
const AUDIT_DETAIL_MAX_CHARS = Math.max(80, parseInt(process.env.AUDIT_DETAIL_MAX_CHARS || '350', 10) || 350);
const AUDIT_CLEANUP_INTERVAL_MS = Math.max(60_000, parseInt(process.env.AUDIT_CLEANUP_INTERVAL_MS || '3600000', 10) || 3600000);
let lastAuditCleanupAt = 0;

// Si usamos cookies seguras detrás de un proxy (nginx, etc.), hay que confiar en el proxy
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// Directorio de datos (BD) – OWASP A05: evitar rutas débiles y asegurar permisos
// -----------------------------------------------------------------------------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'Data'));

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
let db = await openDatabase(DB_FILE);

// Ajustes SQLite para VPS: mejor concurrencia de lecturas/escrituras y menor bloqueo.
await db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
`);

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
CREATE INDEX IF NOT EXISTS idx_event_logs_action_entity ON event_logs(action, entity);

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
await cleanupAuditLogs(true);

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
await ensureColumn('defectuosos', 'stock_descontado', 'INTEGER NOT NULL DEFAULT 0');
await ensureColumn('envios',      'unidad', 'TEXT');

// Users: columna de protección (evita borrado del Supervisor principal)
await ensureColumn('users', 'is_protected', 'INTEGER NOT NULL DEFAULT 0');

// Stock: compatibilidad con BD antiguas
await ensureColumn('stock_productos', 'unidad', 'TEXT');
await ensureColumn('stock_productos', 'etiqueta', 'TEXT');
await ensureColumn('stock_productos', 'updated_at', 'TEXT');
await ensureColumn('stock_retiros', 'unidad', 'TEXT');
await ensureColumn('stock_retiros', 'fecha', 'TEXT');

await ensureColumn('stock_ajustes', 'recepcion_cursor', 'INTEGER');
await ensureColumn('stock_ajustes', 'retiro_cursor', 'INTEGER');

async function seedUsersIfEmpty() {
  const count = await db.get('SELECT COUNT(*) AS c FROM users');
  if (count.c) return;
  if (!validPassword(BOOTSTRAP_PASSWORD)) throw new Error('BOOTSTRAP_PASSWORD debe tener entre 12 y 72 bytes. Ejecuta node scripts/setup.mjs.');
  if (!/^[a-z0-9._-]{3,32}$/.test(PROTECTED_SUPERVISOR_USERNAME)) throw new Error('Nombre de supervisor inválido.');
  const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 12);
  await db.run('INSERT INTO users(username,password,role,is_protected) VALUES(?,?,?,1)', [PROTECTED_SUPERVISOR_USERNAME, hash, 'supervisor']);
  console.log('Cuenta principal creada:', PROTECTED_SUPERVISOR_USERNAME);
}
async function ensureProtectedSupervisor() {
  await db.run("UPDATE users SET is_protected=1 WHERE LOWER(username)=? AND role='supervisor'", [PROTECTED_SUPERVISOR_USERNAME]);
}
await seedUsersIfEmpty();
await ensureProtectedSupervisor();
await seedRecepcionesMovimientosIfEmpty();

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
// Auditoría de eventos (event_logs) optimizada
// -----------------------------------------------------------------------------
function escapeSqliteString(val) {
  return String(val || '').replace(/'/g, "''");
}

function compactAuditDetail(detail) {
  if (detail == null) return null;
  let text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > AUDIT_DETAIL_MAX_CHARS) text = text.slice(0, AUDIT_DETAIL_MAX_CHARS) + '…';
  return text || null;
}

function shouldLogEvent({ action = '', entity = '' } = {}) {
  if (!AUDIT_ENABLED) return false;
  const a = String(action || '').toLowerCase();
  const e = String(entity || '').toLowerCase();

  if (AUDIT_LEVEL === 'verbose') return true;

  const securityOrAdmin =
    e === 'auth' || e === 'database' || e === 'users' ||
    a.includes('login') || a.includes('logout') || a.includes('backup') ||
    a.includes('restore') || a.includes('password') || a === 'delete';

  if (AUDIT_LEVEL === 'minimal') return securityOrAdmin;

  // En modo normal evitamos duplicar movimientos de alta frecuencia.
  // Entradas/salidas/conteos por escáner ya quedan en pro_kardex/pro_conteos_inventario.
  const highVolumeOperationalEvent =
    e === 'stock' || e === 'pro_conteo' ||
    a === 'pro_entrada' || a === 'pro_salida' || a === 'conteo';

  return !highVolumeOperationalEvent;
}

async function cleanupAuditLogs(force = false) {
  if (!force && Date.now() - lastAuditCleanupAt < AUDIT_CLEANUP_INTERVAL_MS) return;
  lastAuditCleanupAt = Date.now();

  try {
    await db.run(
      "DELETE FROM event_logs WHERE datetime(ts) < datetime('now', ?)",
      [`-${AUDIT_RETENTION_DAYS} days`]
    );

    const row = await db.get('SELECT COUNT(*) AS c FROM event_logs');
    const excess = Math.max(0, (row?.c || 0) - AUDIT_MAX_ROWS);
    if (excess > 0) {
      await db.run(
        `DELETE FROM event_logs
         WHERE id IN (SELECT id FROM event_logs ORDER BY ts ASC, id ASC LIMIT ?)`,
        [excess]
      );
    }
  } catch (_) {
    // La limpieza de auditoría no debe bloquear la operación del sistema.
  }
}

async function logEvent(req, { action, entity = null, entityId = null, detail = null } = {}) {
  try {
    if (!shouldLogEvent({ action, entity })) return;

    const u = req?.session?.user || null;
    const username = u ? u.username : null;
    const role = u ? u.role : null;
    const ipRaw = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
    const ip = String(ipRaw).split(',')[0].trim().slice(0, 80);

    await db.run(
      "INSERT INTO event_logs(username,role,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)",
      [
        username,
        role,
        String(action || '').slice(0, 80),
        entity ? String(entity).slice(0, 80) : null,
        entityId ? String(entityId).slice(0, 120) : null,
        compactAuditDetail(detail),
        ip
      ]
    );

    cleanupAuditLogs(false);
  } catch (_) {
    // No interrumpir el flujo por fallos de auditoría.
  }
}

const auditCleanupTimer = setInterval(() => cleanupAuditLogs(false), AUDIT_CLEANUP_INTERVAL_MS);
if (typeof auditCleanupTimer.unref === 'function') auditCleanupTimer.unref();

// -----------------------------------------------------------------------------
// Backups / Restore de la base de datos (solo supervisor)
// -----------------------------------------------------------------------------
let RESTORE_IN_PROGRESS = false;

async function ensureSchemaAfterRestore() {
  await db.exec(BASE_SCHEMA_SQL);
  await db.exec(PRO_SCHEMA_SQL);
  await ensureColumn('stock_ajustes', 'recepcion_cursor', 'INTEGER');
  await ensureColumn('stock_ajustes', 'retiro_cursor', 'INTEGER');
  await ensureColumn('pro_ordenes_produccion', 'fecha_inicio', 'TEXT');
  await ensureColumn('pro_ordenes_produccion', 'fecha_final', 'TEXT');
  await ensureColumn('pro_productos_terminados', 'activo', 'INTEGER NOT NULL DEFAULT 1');
  // Migraciones para BD antiguas
  await ensureColumn('recepciones', 'unidad', 'TEXT');
  await ensureColumn('recepciones', 'etiqueta', 'TEXT');
  await ensureColumn('produccion',  'tipo',   'TEXT');
  await ensureColumn('produccion',  'unidad', 'TEXT');
  await ensureColumn('defectuosos', 'unidad', 'TEXT');
  await ensureColumn('defectuosos', 'stock_descontado', 'INTEGER NOT NULL DEFAULT 0');
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

function formatDateTimeYmdToDmy(value) {
  if(!value)return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return formatDateYmdToDmy(value);
  return formatTsLima(value);
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
  const dateExpr = /(?:created_at|updated_at|ts)$/.test(field) ? `date(${field},'-5 hours')` : `date(substr(${field},1,10))`;
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
        "form-action": ["'self'"],
        "connect-src": ["'self'"]
      }
    },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: USE_SECURE_COOKIES ? undefined : false,
    crossOriginEmbedderPolicy: false
  }));
} else {
  // Desarrollo: sin CSP, solo referrerPolicy y demás protecciones ligeras
  app.use(helmet({
    contentSecurityPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: USE_SECURE_COOKIES ? undefined : false,
    crossOriginEmbedderPolicy: false
  }));
}

// Compresión – mejora rendimiento
app.use(compression());

// Body parsers – OWASP A04: limitar tamaño de petición para evitar DOS
const normalJson = express.json({limit:"256kb"});
const restoreJson = express.json({limit:"70mb"});
app.use((req,res,next)=>(req.path==="/api/backup/restore"?restoreJson:normalJson)(req,res,next));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));


// Una conexión SQLite compartida requiere serializar los controladores para aislar transacciones.
let apiQueue = Promise.resolve();
app.use((req, res, next) => {
  if (req.path.startsWith('/assets/')) return next();
  res.set('Cache-Control', 'no-store');
  const previous = apiQueue;
  let release;
  apiQueue = new Promise(resolve => { release = resolve; });
  res.once('finish', release);
  res.once('close', release);
  previous.then(() => { if (!res.destroyed) next(); else release(); }).catch(next);
});

const sessionStore = createSessionStore(session.Store, path.join(DATA_DIR, 'sessions.db'));
const sessionMiddleware = session({
  name: 'brumapp.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: USE_SECURE_COOKIES,
    maxAge: 1000 * 60 * 60 * 8 // 8 horas
  }
});
app.use((req,res,next)=>req.path.startsWith('/assets/')?next():sessionMiddleware(req,res,next));

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
    req.session.csrf = crypto.randomBytes(32).toString('hex');
  }
  next();
}

function csrfProtect(req, res, next) {
  const m = (req.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    const origin=req.get('origin');
    if(origin){try{if(new URL(origin).host!==req.get('host')) return res.status(403).json({error:'forbidden'});}catch{return res.status(403).json({error:'forbidden'});}}
    if (req.path === '/api/auth/login' || req.path === '/login') return next();
    const token = req.get('x-csrf-token');
    if (!token || token !== req.session?.csrf) {
      return res.status(403).json({ error: 'bad-csrf' });
    }
  }
  next();
}

app.get('/csrf', ensureCsrf, (req, res) =>
  res.set('Cache-Control', 'no-store').json({ token: req.session.csrf || '' })
);

app.use(csrfProtect);
app.use(async (req, res, next) => {
  if (req.session?.user && (req.path.startsWith('/api') || ['/me','/panel','/panel.html'].includes(req.path))) {
    const user = await db.get('SELECT id,username,role FROM users WHERE id=?', [req.session.user.id]);
    req.session.user = user || null;
  }
  next();
});
app.get(['/panel.html','/panel'], (req, res, next) => req.session.user ? next() : res.redirect('/'));


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
      res.setHeader('Cache-Control', /\.(js|css)$/.test(p) ? 'public, max-age=0, must-revalidate' : 'public, max-age=86400');
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
  if(!/^[a-z0-9._-]{3,32}$/.test(uname) || typeof password!=='string' || Buffer.byteLength(password)>72) return isJson?res.status(401).json({error:'bad-credentials'}):res.redirect('/?error=1');

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

  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
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
  req.session.destroy(() => { res.clearCookie('brumapp.sid'); res.json({ ok: true }); });
});

app.get('/me', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ user: req.session.user || null });
});

// -----------------------------------------------------------------------------
// Backup / Restore (solo supervisor)
// -----------------------------------------------------------------------------
app.get('/api/backup/download', requireRole('supervisor'), async (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapFile = path.join(DATA_DIR, `brumapp_backup_${ts}.db`);

  await db.exec(`VACUUM INTO '${escapeSqliteString(snapFile)}'`);

  await logEvent(req, { action: 'backup_download', entity: 'database', detail: `file=${path.basename(snapFile)}` });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="brumapp_backup_${ts}.db"`);

  const stream = fs.createReadStream(snapFile);
  stream.on('error', () => res.status(500).end());
  stream.pipe(res);

  res.on('close', () => { fs.unlink(snapFile, () => {}); });
});

app.post('/api/backup/restore', requireRole('supervisor'), async (req, res) => {
  RESTORE_IN_PROGRESS = true;
  let candidate;
  let pre;
  let replaced = false;
  let closed = false;
  let temporary;
  try {
    const { fileBase64, filename } = req.body || {};
    if (typeof fileBase64 !== 'string' || !fileBase64) return res.status(400).json({ error: 'invalid' });
    const buffer = Buffer.from(fileBase64, 'base64');
    if (buffer.length < 100 || buffer.length > 50 * 1024 * 1024) return res.status(400).json({ error: 'size' });
    if (buffer.subarray(0, 16).toString() !== 'SQLite format 3\0') return res.status(400).json({ error: 'not_sqlite' });
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    temporary = path.join(DATA_DIR, `__restore_${stamp}.db`);
    fs.writeFileSync(temporary, buffer);
    candidate = await openDatabase(temporary, { readOnly: true });
    const integrity = await candidate.get('PRAGMA quick_check');
    const tables = await candidate.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map(row => row.name));
    if (Object.values(integrity)[0] !== 'ok' || !['users','recepciones','stock_productos'].every(name => names.has(name))) {
      return res.status(400).json({ error: 'invalid-backup' });
    }
    const supervisor = await candidate.get("SELECT id FROM users WHERE role='supervisor' LIMIT 1");
    if (!supervisor) return res.status(400).json({ error: 'invalid-backup' });
    await candidate.close(); candidate = null;
    pre = path.join(DATA_DIR, `brumapp_pre_restore_${stamp}.db`);
    await db.exec(`VACUUM INTO '${escapeSqliteString(pre)}'`);
    await db.close(); closed = true;
    for (const suffix of ['-wal','-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
    fs.renameSync(temporary, DB_FILE); replaced = true;
    db = await openDatabase(DB_FILE);
    await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    await ensureSchemaAfterRestore();
    await logEvent(req, { action: 'backup_restore', entity: 'database', detail: `from=${safeText(filename,128)} pre=${path.basename(pre)}` });
    await new Promise((resolve, reject) => sessionStore.clear(error => error ? reject(error) : resolve()));
    await new Promise(resolve => req.session.destroy(resolve));
    res.clearCookie('brumapp.sid').json({ ok: true, reauthenticate: true });
  } catch (error) {
    if (closed && pre) {
      try { await db.close(); } catch {}
      for (const suffix of ['-wal','-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
      if (replaced) fs.copyFileSync(pre, DB_FILE);
      db = await openDatabase(DB_FILE);
      await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    }
    console.error('Restore error:', error.message);
    res.status(replaced ? 500 : 400).json({ error: 'restore_failed' });
  } finally {
    if (candidate) await candidate.close().catch(() => {});
    if (temporary) fs.rmSync(temporary, { force: true });
    RESTORE_IN_PROGRESS = false;
  }
});

// -----------------------------------------------------------------------------
// Auditoría / Historial de eventos (solo supervisor)
// -----------------------------------------------------------------------------
app.get('/api/event-logs', requireRole('supervisor'), async (req, res) => {
  const { from, to, q, limit, offset } = req.query || {};
  const lim = Math.min(parseInt(limit || '50', 10) || 50, 100);
  const off = Math.max(parseInt(offset || '0', 10) || 0, 0);

  const f = buildDateWhere({ field: 'ts', from, to });
  const sQ = buildTextSearchWhere(q, ['username','role','action','entity','entity_id','detail','ip']);
  const mw = mergeWhere(f.where, f.params, [sQ.clause], [...sQ.params]);

  const totalRow = await db.get(`SELECT COUNT(*) as c FROM event_logs ${mw.where}`, mw.params);
  const items = await db.all(
    `SELECT * FROM event_logs ${mw.where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    [...mw.params, lim, off]
  );
  res.json({ items, total: totalRow?.c || 0, retention_days: AUDIT_RETENTION_DAYS, max_rows: AUDIT_MAX_ROWS, audit_level: AUDIT_LEVEL });
});

// Exportación del historial (event_logs) a Excel (XLSX)
app.post('/api/event-logs/cleanup', requireRole('supervisor'), async (req, res) => {
  await cleanupAuditLogs(true);
  const row = await db.get('SELECT COUNT(*) AS c FROM event_logs');
  await logEvent(req, { action: 'audit_cleanup', entity: 'event_logs', detail: `rows=${row?.c || 0}` });
  res.json({ ok: true, rows: row?.c || 0, retention_days: AUDIT_RETENTION_DAYS, max_rows: AUDIT_MAX_ROWS });
});

app.get('/api/event-logs.xlsx', requireRole('supervisor'), async (req, res) => {
  const { from, to, q } = req.query || {};

  const f = buildDateWhere({ field: 'ts', from, to });
  const sQ = buildTextSearchWhere(q, ['username','role','action','entity','entity_id','detail','ip']);
  const mw = mergeWhere(f.where, f.params, [sQ.clause], [...sQ.params]);

  const items = await db.all(
    `SELECT * FROM event_logs ${mw.where} ORDER BY ts DESC, id DESC LIMIT 5000`,
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

// -----------------------------------------------------------------------------
// Recepciones
// -----------------------------------------------------------------------------

// Reconstruye stock completo (útil post-restore o migraciones)
async function rebuildAllStock() {
  const types = await db.all('SELECT tipo FROM recepciones UNION SELECT tipo FROM pro_materiales');
  for (const row of types) await rebuildStockForTipo(row.tipo);
}
async function rebuildStockForTipo(tipo) { return rebuildMaterialStock(db, tipo); }

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

  await db.run("INSERT INTO recepciones_movimientos(tipo,etiqueta,delta,fecha,unidad,action,ref_recepcion_id) VALUES(?,?,?,?,?,?,?)", [t,et,c,f,u,existingRef ? 'add' : 'create',r.lastID]);
  // Recalcular stock y obtener total resultante
  await rebuildStockForTipo(t);
  const st = await db.get("SELECT cantidad FROM stock_productos WHERE LOWER(tipo)=LOWER(?) ORDER BY id ASC LIMIT 1", [t]);
  const totalNow = Number(st?.cantidad || 0);

  await db.run('UPDATE recepciones_movimientos SET total=? WHERE ref_recepcion_id=?', [totalNow,r.lastID]);

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
    "INSERT INTO stock_ajustes(tipo,cantidad,unidad,recepcion_cursor,retiro_cursor) VALUES(?,?,?,(SELECT COALESCE(MAX(id),0) FROM recepciones_movimientos),(SELECT COALESCE(MAX(id),0) FROM stock_retiros))",
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
	    await saveStockAdjustment(db,t,c,u);
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

app.post('/api/defectuosos', requireRole('supervisor','administrador'), async (req,res)=>{
  const b=req.body||{};
  if(!nonNegativeInteger(b.cantidad) || Number(b.cantidad)<=0 || !safeText(b.tipo) || !safeText(b.fecha)) return res.status(400).json({error:'invalid'});
  const discount=String(b.descontar_stock||'')==='1';
  const material=discount?await findMaterialByCodeOrName(b.tipo):null;
  if(discount&&!material) return res.status(404).json({error:'material-not-found'});
  if(material&&b.unidad!==material.unidad) return res.status(409).json({error:'unit_mismatch'});
  const tipo=material?.tipo||safeText(b.tipo,180);
  const quantity=Number(b.cantidad);
  if(discount&&(await getStockForTipo(tipo))<quantity) return res.status(409).json({error:'stock-insuficiente',stock:await getStockForTipo(tipo)});
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result=await db.run('INSERT INTO defectuosos(tipo,cantidad,razon,fecha,unidad,stock_descontado) VALUES(?,?,?,?,?,?)',[tipo,quantity,safeText(b.razon,256),safeText(b.fecha,32),safeText(b.unidad,40),discount?1:0]);
    if(discount) {
      await db.run('INSERT INTO stock_retiros(tipo,cantidad,unidad,fecha) VALUES(?,?,?,?)',[tipo,quantity,material.unidad,b.fecha]);
      await rebuildStockForTipo(tipo);
      await recordKardex(req,{codigo_barra:material.codigo_barra||'',tipo,movimiento:'descarte',salida:quantity,unidad:material.unidad,referencia:`DESC-${result.lastID}`,observacion:safeText(b.razon,256),fecha:b.fecha});
    }
    await logEvent(req,{action:'create',entity:'defectuosos',entityId:result.lastID});
    await db.exec('COMMIT');res.json({ok:true,id:result.lastID});
  } catch(error){await db.exec('ROLLBACK');throw error;}
});

app.put('/api/defectuosos/:id', requireRole('supervisor', 'administrador'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = await db.get('SELECT stock_descontado FROM defectuosos WHERE id=?',[id]);
  if(!item) return res.status(404).json({error:'not-found'});
  if(item.stock_descontado) return res.status(409).json({error:'discounted-record'});
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
  const item = await db.get('SELECT stock_descontado FROM defectuosos WHERE id=?',[id]);
  if(!item) return res.status(404).json({error:'not-found'});
  if(item.stock_descontado) return res.status(409).json({error:'discounted-record'});
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

function startPdf(res, filename, title, options = {}) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', layout: options.layout || 'portrait', margin: 36 });
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
  const totalWidth = widths.reduce((sum,width) => sum + width,0);
  widths = widths.map(width => width * tableWidth / totalWidth);
  const headerH = 26;
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
  const buf = createWorkbook(sheets);
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
      d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)?s+'-05:00':s);
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
  const uname = String(username || '').trim().toLowerCase();

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
  if (!validPassword(password)) return res.status(400).json({ error: 'weak-password' });
  const hp = await bcrypt.hash(password, 12);
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

  if(target.role==='supervisor'&&role!=='supervisor'){const others=await db.get("SELECT COUNT(*) AS c FROM users WHERE role='supervisor' AND id<>?",[id]);if(!others.c)return res.status(409).json({error:'must-keep-supervisor'});}
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

  if (!validPassword(password)) return res.status(400).json({ error: 'weak-password' });
  const hp = await bcrypt.hash(password, 12);
  await db.run("UPDATE users SET password=? WHERE id=?", [hp, id]);
  await logEvent(req, { action: 'update_password', entity: 'users', entityId: id });
  res.json({ ok: true });
});


app.patch('/api/auth/password', requireAuth, async (req,res) => {
  const { current_password, password }=req.body||{};
  if(!validPassword(password)) return res.status(400).json({error:'weak-password'});
  const user=await db.get('SELECT password FROM users WHERE id=?',[req.session.user.id]);
  if(!await bcrypt.compare(String(current_password||''),user.password)) return res.status(403).json({error:'incorrect-password'});
  await db.run('UPDATE users SET password=? WHERE id=?',[await bcrypt.hash(password,12),req.session.user.id]);
  await logEvent(req,{action:'update_password',entity:'users',entityId:req.session.user.id});
  res.json({ok:true});
});

// -----------------------------------------------------------------------------
// Módulo PRO: almacén, trazabilidad, códigos de barra y gestión operativa
// -----------------------------------------------------------------------------
const PRO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pro_proveedores(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  ruc TEXT,
  telefono TEXT,
  correo TEXT,
  contacto TEXT,
  observaciones TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pro_clientes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  documento TEXT,
  telefono TEXT,
  correo TEXT,
  direccion TEXT,
  contacto TEXT,
  observaciones TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pro_materiales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barra TEXT UNIQUE,
  tipo TEXT UNIQUE NOT NULL,
  categoria TEXT,
  etiqueta TEXT,
  unidad TEXT,
  ubicacion TEXT,
  stock_min INTEGER NOT NULL DEFAULT 0,
  stock_crit INTEGER NOT NULL DEFAULT 0,
  costo_unitario REAL NOT NULL DEFAULT 0,
  proveedor_id INTEGER,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pro_materiales_barcode ON pro_materiales(codigo_barra);
CREATE INDEX IF NOT EXISTS idx_pro_materiales_tipo ON pro_materiales(tipo);
CREATE TABLE IF NOT EXISTS pro_kardex(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barra TEXT,
  tipo TEXT NOT NULL,
  movimiento TEXT NOT NULL,
  entrada INTEGER NOT NULL DEFAULT 0,
  salida INTEGER NOT NULL DEFAULT 0,
  saldo INTEGER NOT NULL DEFAULT 0,
  unidad TEXT,
  referencia TEXT,
  observacion TEXT,
  username TEXT,
  fecha TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pro_kardex_tipo ON pro_kardex(tipo);
CREATE INDEX IF NOT EXISTS idx_pro_kardex_barcode ON pro_kardex(codigo_barra);
CREATE TABLE IF NOT EXISTS pro_productos_terminados(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barra TEXT UNIQUE,
  producto TEXT UNIQUE NOT NULL,
  descripcion TEXT,
  unidad TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  stock_min INTEGER NOT NULL DEFAULT 0,
  cliente_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pro_recetas(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL,
  material_tipo TEXT NOT NULL,
  cantidad_por_unidad REAL NOT NULL DEFAULT 1,
  unidad TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pro_ordenes_produccion(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT UNIQUE,
  producto TEXT NOT NULL,
  cantidad_planificada INTEGER NOT NULL DEFAULT 0,
  cantidad_producida INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'Pendiente',
  responsable TEXT,
  observacion TEXT,
  fecha TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pro_conteos_inventario(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barra TEXT,
  tipo TEXT NOT NULL,
  stock_sistema INTEGER NOT NULL DEFAULT 0,
  stock_fisico INTEGER NOT NULL DEFAULT 0,
  diferencia INTEGER NOT NULL DEFAULT 0,
  motivo TEXT,
  fecha TEXT NOT NULL,
  username TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pro_productos_terminados_movimientos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER,
  codigo_barra TEXT,
  producto TEXT NOT NULL,
  movimiento TEXT NOT NULL,
  entrada INTEGER NOT NULL DEFAULT 0,
  salida INTEGER NOT NULL DEFAULT 0,
  saldo INTEGER NOT NULL DEFAULT 0,
  unidad TEXT,
  cliente_id INTEGER,
  cliente TEXT,
  referencia TEXT,
  observacion TEXT,
  username TEXT,
  fecha TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pro_pt_mov_producto ON pro_productos_terminados_movimientos(producto);
CREATE INDEX IF NOT EXISTS idx_pro_pt_mov_barcode ON pro_productos_terminados_movimientos(codigo_barra);
CREATE TABLE IF NOT EXISTS pro_envios_terminados(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER,
  codigo_barra TEXT,
  producto TEXT NOT NULL,
  cantidad INTEGER NOT NULL DEFAULT 0,
  unidad TEXT,
  cliente_id INTEGER,
  cliente TEXT,
  observacion TEXT,
  username TEXT,
  fecha TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pro_envios_terminados_producto ON pro_envios_terminados(producto);
CREATE INDEX IF NOT EXISTS idx_pro_envios_terminados_fecha ON pro_envios_terminados(fecha);
`;
await db.exec(PRO_SCHEMA_SQL);

// Migraciones no destructivas del módulo Almacén para bases de datos existentes
await ensureColumn('pro_ordenes_produccion', 'fecha_inicio', 'TEXT');
await ensureColumn('pro_ordenes_produccion', 'fecha_final', 'TEXT');
await ensureColumn('pro_productos_terminados', 'activo', 'INTEGER NOT NULL DEFAULT 1');
await rebuildAllStock();

function safeText(v, max=255){ return String(v ?? '').trim().slice(0,max); }
function safeInt(v, def=0){ const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : def; }
function safeFloat(v, def=0){ const n = Number(v); return Number.isFinite(n) ? n : def; }
function nowLocalISO(){ return localISO(); }
async function getStockForTipo(tipo){
  const row = await db.get("SELECT cantidad FROM stock_productos WHERE LOWER(tipo)=LOWER(?) LIMIT 1", [tipo]);
  return safeInt(row?.cantidad, 0);
}

async function findMaterialByCodeOrName(value) {
  const q = safeText(value,180);
  return db.get("SELECT * FROM pro_materiales WHERE activo=1 AND (LOWER(codigo_barra)=LOWER(?) OR LOWER(tipo)=LOWER(?)) LIMIT 1", [q,q]);
}
async function findProductoTerminadoByCodeOrName(value) {
  const q = safeText(value,180);
  return db.get("SELECT pt.*,c.nombre AS cliente FROM pro_productos_terminados pt LEFT JOIN pro_clientes c ON c.id=pt.cliente_id WHERE COALESCE(pt.activo,1)=1 AND (LOWER(pt.codigo_barra)=LOWER(?) OR LOWER(pt.producto)=LOWER(?)) LIMIT 1", [q,q]);
}

async function recordProductoTerminadoMovimiento(req, { producto_id=null, codigo_barra='', producto, movimiento, entrada=0, salida=0, saldo=0, unidad='', cliente_id=null, cliente='', referencia='', observacion='', fecha='' }){
  await db.run(`INSERT INTO pro_productos_terminados_movimientos(producto_id,codigo_barra,producto,movimiento,entrada,salida,saldo,unidad,cliente_id,cliente,referencia,observacion,username,fecha)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    producto_id, safeText(codigo_barra,80), safeText(producto,180), safeText(movimiento,40), safeInt(entrada), safeInt(salida), safeInt(saldo), safeText(unidad,40),
    cliente_id, safeText(cliente,160), safeText(referencia,80), safeText(observacion,300), safeText(req.session.user?.username,80), safeText(fecha) || nowLocalISO()
  ]);
}
async function recordKardex(req, { codigo_barra='', tipo, movimiento, entrada=0, salida=0, unidad='', referencia='', observacion='', fecha='' }){
  const saldo = await getStockForTipo(tipo);
  await db.run(
    `INSERT INTO pro_kardex(codigo_barra,tipo,movimiento,entrada,salida,saldo,unidad,referencia,observacion,username,fecha)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [safeText(codigo_barra,80), safeText(tipo,180), safeText(movimiento,40), safeInt(entrada), safeInt(salida), saldo,
     safeText(unidad,40), safeText(referencia,80), safeText(observacion,300), safeText(req.session.user?.username,80), safeText(fecha) || nowLocalISO()]
  );
}

function crudRoutes({ base, table, fields, searchable=['nombre'] }){
  app.get(`/api/pro/${base}`, requireAuth, async (req, res) => {
    const q = safeText(req.query.q || '', 120).toLowerCase();
    let rows;
    if (q) {
      const wh = searchable.map(f => `LOWER(COALESCE(${f},'')) LIKE ?`).join(' OR ');
      rows = await db.all(`SELECT * FROM ${table} WHERE ${wh} ORDER BY id DESC`, searchable.map(() => `%${q}%`));
    } else {
      rows = await db.all(`SELECT * FROM ${table} ORDER BY id DESC`);
    }
    res.json({ items: rows || [] });
  });
  app.post(`/api/pro/${base}`, requireRole('supervisor','administrador'), async (req, res) => {
    if (!safeText(req.body?.nombre,160)) return res.status(400).json({error:'name-required'});
    const vals = fields.map(f => safeText(req.body?.[f], f === 'observaciones' ? 500 : 180));
    const placeholders = fields.map(() => '?').join(',');
    const sql = `INSERT INTO ${table}(${fields.join(',')}) VALUES(${placeholders})`;
    const r = await db.run(sql, vals);
    await logEvent(req, { action:'create', entity:`pro_${base}`, entityId:r.lastID, detail: JSON.stringify(req.body || {}) });
    res.json({ ok:true, id:r.lastID });
  });
  app.put(`/api/pro/${base}/:id`, requireRole('supervisor','administrador'), async (req, res) => {
    const id = safeInt(req.params.id);
    if (!safeText(req.body?.nombre,160)) return res.status(400).json({error:'name-required'});
    const vals = fields.map(f => safeText(req.body?.[f], f === 'observaciones' ? 500 : 180));
    const existing = await db.get(`SELECT id FROM ${table} WHERE id=?`,[id]);
    if(!existing) return res.status(404).json({error:'not-found'});
    const set = fields.map(f => `${f}=?`).join(',');
    await db.run(`UPDATE ${table} SET ${set}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...vals, id]);
    await logEvent(req, { action:'update', entity:`pro_${base}`, entityId:id, detail: JSON.stringify(req.body || {}) });
    res.json({ ok:true });
  });
  app.delete(`/api/pro/${base}/:id`, requireRole('supervisor'), async (req, res) => {
    const id = safeInt(req.params.id);
    const references = base === 'proveedores' ? await db.get('SELECT COUNT(*) AS c FROM pro_materiales WHERE proveedor_id=?',[id]) : await db.get('SELECT (SELECT COUNT(*) FROM pro_productos_terminados WHERE cliente_id=?) + (SELECT COUNT(*) FROM pro_envios_terminados WHERE cliente_id=?) AS c',[id,id]);
    if(references.c) return res.status(409).json({error:'record-in-use'});
    const deleted=await db.run(`DELETE FROM ${table} WHERE id=?`, [id]);
    if(!deleted.changes) return res.status(404).json({error:'not-found'});
    await logEvent(req, { action:'delete', entity:`pro_${base}`, entityId:id });
    res.json({ ok:true });
  });
}

crudRoutes({ base:'proveedores', table:'pro_proveedores', fields:['nombre','ruc','telefono','correo','contacto','observaciones'], searchable:['nombre','ruc','telefono','contacto','correo'] });
crudRoutes({ base:'clientes', table:'pro_clientes', fields:['nombre','documento','telefono','correo','direccion','contacto','observaciones'], searchable:['nombre','documento','telefono','contacto','correo','direccion'] });

app.get('/api/pro/materiales', requireAuth, async (req, res) => {
  const { q, from, to, stock } = req.query || {};
  const clauses = [stock==='ARCHIVED'?"m.activo=0":"m.activo=1"];
  if(stock==='CRITICO')clauses.push('COALESCE(s.cantidad,0)<=m.stock_crit');
  if(stock==='BAJO')clauses.push('COALESCE(s.cantidad,0)>m.stock_crit AND COALESCE(s.cantidad,0)<=m.stock_min');
  if(stock==='OK')clauses.push('COALESCE(s.cantidad,0)>m.stock_min');
  const params = [];
  const sWhere = buildTextSearchWhere(q, ['m.tipo','m.codigo_barra','m.categoria','m.ubicacion','m.etiqueta','p.nombre']);
  if (sWhere.clause) { clauses.push(sWhere.clause); params.push(...sWhere.params); }
  const f = buildDateWhere({ field: 'm.created_at', from, to });
  if (f.where) { clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const rows = await db.all(`
    SELECT m.*, COALESCE(s.cantidad,0) AS stock_actual, p.nombre AS proveedor,
      CASE WHEN m.activo=0 THEN 'ARCHIVED'
           WHEN COALESCE(s.cantidad,0) <= m.stock_crit THEN 'CRITICO'
           WHEN COALESCE(s.cantidad,0) <= m.stock_min THEN 'BAJO'
           ELSE 'OK' END AS estado_stock
    FROM pro_materiales m
    LEFT JOIN stock_productos s ON LOWER(s.tipo)=LOWER(m.tipo)
    LEFT JOIN pro_proveedores p ON p.id=m.proveedor_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY estado_stock ASC, m.tipo ASC`, params);
  res.json({ items: rows || [] });
});

app.get('/api/pro/materiales/barcode/:codigo', requireAuth, async (req, res) => {
  const material = await findMaterialByCodeOrName(req.params.codigo);
  if (!material) return res.status(404).json({ error:'not-found' });
  const row = await db.get(`SELECT m.*, COALESCE(s.cantidad,0) AS stock_actual FROM pro_materiales m LEFT JOIN stock_productos s ON LOWER(s.tipo)=LOWER(m.tipo) WHERE m.id=? LIMIT 1`, [material.id]);
  res.json({ item: row || material });
});

app.post('/api/pro/materiales', requireRole('supervisor','administrador'), async (req, res) => {
  const b = req.body || {};
  const tipo = safeText(b.tipo, 180);
  if (!tipo) return res.status(400).json({ error:'tipo-required' });
  const codigo = safeText(b.codigo_barra, 80) || null;
  const unidad = safeText(b.unidad, 40);
  const etiqueta = safeText(b.etiqueta, 180);
  if (!unidad || !nonNegativeInteger(b.stock_inicial ?? 0) || !nonNegativeInteger(b.stock_min ?? 0) || !nonNegativeInteger(b.stock_crit ?? 0) || Number(b.stock_crit || 0) > Number(b.stock_min || 0)) return res.status(400).json({ error:'invalid' });
  const duplicate = await db.get('SELECT id FROM pro_materiales WHERE LOWER(tipo)=LOWER(?)', [tipo]);
  if (duplicate) return res.status(409).json({error:'duplicate-record'});
  if(b.proveedor_id && !await db.get('SELECT id FROM pro_proveedores WHERE id=?',[safeInt(b.proveedor_id)]))return res.status(400).json({error:'invalid'});
  const stockInicial = Number(b.stock_inicial || 0);
  await db.exec('BEGIN IMMEDIATE');
  try {
    const r = await db.run(`INSERT INTO pro_materiales(codigo_barra,tipo,categoria,etiqueta,unidad,ubicacion,stock_min,stock_crit,costo_unitario,proveedor_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [codigo, tipo, safeText(b.categoria,120), etiqueta, unidad, safeText(b.ubicacion,120), safeInt(b.stock_min), safeInt(b.stock_crit), 0, b.proveedor_id ? safeInt(b.proveedor_id) : null]);
    if (stockInicial > 0) {
      const fecha = safeText(b.fecha) || nowLocalISO();
      await db.run("INSERT INTO recepciones(tipo,etiqueta,cantidad,fecha,unidad) VALUES(?,?,?,?,?)", [tipo, etiqueta, stockInicial, fecha, unidad]);
      await db.run("INSERT INTO recepciones_movimientos(tipo,etiqueta,delta,total,fecha,unidad,action) VALUES(?,?,?,?,?,?,?)", [tipo, etiqueta, stockInicial, stockInicial, fecha, unidad, 'create']);
      await rebuildStockForTipo(tipo);
      await recordKardex(req, { codigo_barra:codigo || '', tipo, movimiento:'entrada inicial', entrada:stockInicial, unidad, referencia:`MAT-${r.lastID}`, fecha });
    }
    await rebuildStockForTipo(tipo);
    await logEvent(req, { action:'create', entity:'pro_materiales', entityId:r.lastID, detail: JSON.stringify({ tipo, codigo_barra: codigo }) });
    await db.exec('COMMIT');
    res.json({ ok:true, id:r.lastID });
  } catch (e) {
    await db.exec('ROLLBACK').catch(()=>{});
    throw e;
  }
});

app.put('/api/pro/materiales/:id', requireRole('supervisor','administrador'), async (req,res) => {
  const id=safeInt(req.params.id), b=req.body||{};
  const item=await db.get('SELECT * FROM pro_materiales WHERE id=?',[id]);
  if(!item) return res.status(404).json({error:'not-found'});
  const tipo=safeText(b.tipo,180), unidad=safeText(b.unidad,40);
  if(!tipo || !unidad || !nonNegativeInteger(b.stock_min ?? 0) || !nonNegativeInteger(b.stock_crit ?? 0) || Number(b.stock_crit || 0)>Number(b.stock_min || 0)) return res.status(400).json({error:'invalid'});
  if(b.proveedor_id && !await db.get('SELECT id FROM pro_proveedores WHERE id=?',[safeInt(b.proveedor_id)]))return res.status(400).json({error:'invalid'});
  const duplicate=await db.get('SELECT id FROM pro_materiales WHERE LOWER(tipo)=LOWER(?) AND id<>?',[tipo,id]);
  if(duplicate) return res.status(409).json({error:'duplicate-record'});
  const history=await db.get('SELECT COUNT(*) AS c FROM pro_kardex WHERE LOWER(tipo)=LOWER(?)',[item.tipo]);
  const receipts=await db.get('SELECT COUNT(*) AS c FROM recepciones WHERE LOWER(tipo)=LOWER(?)',[item.tipo]);
  if(unidad!==item.unidad && (history.c || receipts.c)) return res.status(409).json({error:'unit-has-history'});
  await db.exec('BEGIN IMMEDIATE');
  try {
    for(const table of ['stock_productos','recepciones','recepciones_movimientos','stock_retiros','stock_ajustes','pro_kardex','pro_conteos_inventario']) {
      await db.run(`UPDATE ${table} SET tipo=? WHERE LOWER(tipo)=LOWER(?)`,[tipo,item.tipo]);
    }
    await db.run(`UPDATE pro_materiales SET codigo_barra=?,tipo=?,categoria=?,etiqueta=?,unidad=?,ubicacion=?,stock_min=?,stock_crit=?,proveedor_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [safeText(b.codigo_barra,80)||null,tipo,safeText(b.categoria,120),safeText(b.etiqueta,180),unidad,safeText(b.ubicacion,120),Number(b.stock_min||0),Number(b.stock_crit||0),b.proveedor_id?Number(b.proveedor_id):null,id]);
    await rebuildStockForTipo(tipo);
    await logEvent(req,{action:'update',entity:'pro_materiales',entityId:id});
    await db.exec('COMMIT'); res.json({ok:true});
  } catch(error) { await db.exec('ROLLBACK'); throw error; }
});
app.delete('/api/pro/materiales/:id', requireRole('supervisor'), async (req,res) => {
  const item=await db.get('SELECT * FROM pro_materiales WHERE id=?',[safeInt(req.params.id)]);
  if(!item) return res.status(404).json({error:'not-found'});
  if(await getStockForTipo(item.tipo)>0) return res.status(409).json({error:'stock-must-be-zero'});
  await db.run('UPDATE pro_materiales SET activo=0 WHERE id=?',[item.id]);
  await logEvent(req,{action:'archive',entity:'pro_materiales',entityId:item.id});
  res.json({ok:true});
});

app.patch('/api/pro/materiales/:id/activar',requireRole('supervisor'),async(req,res)=>{
  const id=safeInt(req.params.id);
  const item=await db.get('SELECT tipo FROM pro_materiales WHERE id=?',[id]);
  if(!item)return res.status(404).json({error:'not-found'});
  await db.run('UPDATE pro_materiales SET activo=1,updated_at=CURRENT_TIMESTAMP WHERE id=?',[id]);
  await rebuildStockForTipo(item.tipo);
  await logEvent(req,{action:'reactivate',entity:'pro_materiales',entityId:id});
  res.json({ok:true});
});

app.post('/api/pro/movimiento', requireRole('supervisor','administrador'), async (req, res) => {
  const b = req.body || {};
  const buscado = safeText(b.codigo_barra || b.tipo || b.material,180);
  const material = await findMaterialByCodeOrName(buscado);
  const tipo = safeText(material?.tipo, 180);
  if (!tipo) return res.status(400).json({ error:'tipo-required' });
  const codigo = safeText(material?.codigo_barra || '', 80);
  if (b.unidad && b.unidad !== material?.unidad) return res.status(400).json({ error:'unit_mismatch' });
  const unidad = safeText(material?.unidad, 40);
  if (!nonNegativeInteger(b.cantidad)) return res.status(400).json({ error:'invalid-quantity' });
  const cantidad = Number(b.cantidad);
  const accion = safeText(b.accion || 'entrada', 20).toLowerCase();
  const fecha = safeText(b.fecha) || nowLocalISO();
  const obs = safeText(b.observacion, 300);
  if(accion==='ajuste'&&!obs)return res.status(400).json({error:'reason-required'});
  if (!material) return res.status(404).json({ error:'material-not-found' });
  if (cantidad <= 0 && accion !== 'ajuste') return res.status(400).json({ error:'cantidad-required' });

  await db.exec('BEGIN IMMEDIATE');
  try {
    if (accion === 'entrada') {
      await db.run("INSERT INTO recepciones(tipo,etiqueta,cantidad,fecha,unidad) VALUES(?,?,?,?,?)", [tipo, safeText(b.etiqueta || material?.etiqueta,180), cantidad, fecha, unidad]);
      await db.run("INSERT INTO recepciones_movimientos(tipo,etiqueta,delta,total,fecha,unidad,action) VALUES(?,?,?,?,?,?,?)", [tipo, safeText(b.etiqueta || material?.etiqueta,180), cantidad, null, fecha, unidad, 'add']);
      await rebuildStockForTipo(tipo);
      await recordKardex(req, { codigo_barra:codigo, tipo, movimiento:'entrada', entrada:cantidad, unidad, referencia:'ALM-ENTRADA', observacion:obs, fecha });
    } else if (accion === 'salida' || accion === 'dispensamiento') {
      const stock = await getStockForTipo(tipo);
      if (stock < cantidad) {
        await db.exec('ROLLBACK').catch(()=>{});
        return res.status(409).json({ error:'stock-insuficiente', stock });
      }
      await db.run("INSERT INTO stock_retiros(tipo,cantidad,unidad,fecha) VALUES(?,?,?,?)", [tipo, cantidad, unidad, fecha]);
      await rebuildStockForTipo(tipo);
      await recordKardex(req, { codigo_barra:codigo, tipo, movimiento:'dispensamiento', salida:cantidad, unidad, referencia:'ALM-SALIDA', observacion:obs, fecha });
    } else if (accion === 'ajuste') {
      const before = await getStockForTipo(tipo);
      await saveStockAdjustment(db,tipo,cantidad,unidad);
      await rebuildStockForTipo(tipo);
      await recordKardex(req, { codigo_barra:codigo, tipo, movimiento:'ajuste', entrada:Math.max(0,cantidad-before), salida:Math.max(0,before-cantidad), unidad, referencia:'AJUSTE', observacion:obs, fecha });
    } else {
      await db.exec('ROLLBACK').catch(()=>{});
      return res.status(400).json({ error:'accion-invalid' });
    }
    await logEvent(req, { action:`pro_${accion}`, entity:'stock', entityId:tipo, detail: JSON.stringify({ codigo_barra: codigo, cantidad, obs }) });
    const stockActual = await getStockForTipo(tipo);
    await db.exec('COMMIT');
    res.json({ ok:true, stock_actual: stockActual, material: tipo });
  } catch(e) {
    await db.exec('ROLLBACK').catch(()=>{});
    throw e;
  }
});

app.get('/api/pro/kardex', requireAuth, async (req, res) => {
  const { q, from, to } = req.query || {};
  const params = [];
  const clauses = [];
  const sw = buildTextSearchWhere(q, ['tipo','codigo_barra','referencia','observacion','movimiento','username']);
  if (sw.clause) { clauses.push(sw.clause); params.push(...sw.params); }
  const f = buildDateWhere({ field: 'fecha', from, to });
  if (f.where) { clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all(`SELECT * FROM pro_kardex ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`, params);
  res.json({ items: rows || [] });
});

app.post('/api/pro/conteo', requireRole('supervisor','administrador'), async (req, res) => {
  const b = req.body || {};
  const buscado = safeText(b.codigo_barra || b.tipo || b.material,180);
  const material = await findMaterialByCodeOrName(buscado);
  const tipo = safeText(material?.tipo, 180);
  if (!material || !tipo) return res.status(404).json({ error:'material-not-found' });
  const codigo = safeText(material?.codigo_barra || '',80);
  const stockSistema = await getStockForTipo(tipo);
  if (!nonNegativeInteger(b.stock_fisico)) return res.status(400).json({ error:'invalid-quantity' });
  const stockFisico = Number(b.stock_fisico);
  const dif = stockFisico - stockSistema;
  const fecha = safeText(b.fecha) || nowLocalISO();
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.run("INSERT INTO pro_conteos_inventario(codigo_barra,tipo,stock_sistema,stock_fisico,diferencia,motivo,fecha,username) VALUES(?,?,?,?,?,?,?,?)", [codigo, tipo, stockSistema, stockFisico, dif, safeText(b.motivo,300), fecha, safeText(req.session.user?.username,80)]);
    if (String(b.aplicar_ajuste || '') === '1') {
      await saveStockAdjustment(db,tipo,stockFisico,material.unidad);
      await rebuildStockForTipo(tipo);
      await recordKardex(req, { codigo_barra:codigo, tipo, movimiento:'conteo físico', entrada:Math.max(dif,0), salida:Math.max(-dif,0), unidad:safeText(b.unidad || material?.unidad,40), referencia:'CONTEO', observacion:safeText(b.motivo,300), fecha });
    }
    await logEvent(req, { action:'conteo', entity:'pro_conteo', entityId:tipo, detail: JSON.stringify({ stockSistema, stockFisico, dif }) });
    await db.exec('COMMIT');
    res.json({ ok:true, diferencia:dif, stock_sistema:stockSistema, stock_fisico:stockFisico });
  } catch(e) {
    await db.exec('ROLLBACK').catch(()=>{});
    throw e;
  }
});

app.get('/api/pro/conteos', requireAuth, async (req, res) => {
  const search=buildTextSearchWhere(req.query.q,['tipo','codigo_barra','motivo','username']);
  const date=buildDateWhere({field:'fecha',from:req.query.from,to:req.query.to});
  const filter=mergeWhere(date.where,date.params,[search.clause],search.params);
  const rows=await db.all(`SELECT * FROM pro_conteos_inventario ${filter.where} ORDER BY created_at DESC,id DESC LIMIT 300`,filter.params);
  res.json({ items: rows || [] });
});

app.get('/api/pro/productos-terminados', requireAuth, async (req, res) => {
  const { q, from, to } = req.query || {};
  const clauses = ["COALESCE(pt.activo,1)=1"];
  const params = [];
  const sw = buildTextSearchWhere(q, ['pt.producto','pt.codigo_barra','pt.descripcion','pt.unidad','c.nombre']);
  if (sw.clause) { clauses.push(sw.clause); params.push(...sw.params); }
  const f = buildDateWhere({ field: 'pt.created_at', from, to });
  if (f.where) { clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const rows = await db.all(`SELECT pt.*, c.nombre AS cliente FROM pro_productos_terminados pt LEFT JOIN pro_clientes c ON c.id=pt.cliente_id WHERE ${clauses.join(' AND ')} ORDER BY pt.producto ASC`, params);
  res.json({ items: rows || [] });
});

app.get('/api/pro/productos-terminados-movimientos', requireAuth, async (req, res) => {
  const { q, from, to } = req.query || {};
  const clauses = [];
  const params = [];
  const sw = buildTextSearchWhere(q, ['producto','codigo_barra','cliente','observacion','movimiento','referencia','username']);
  if (sw.clause) { clauses.push(sw.clause); params.push(...sw.params); }
  const f = buildDateWhere({ field: 'fecha', from, to });
  if (f.where) { clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all(`SELECT * FROM pro_productos_terminados_movimientos ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`, params);
  res.json({ items: rows || [] });
});

app.post('/api/pro/productos-terminados', requireRole('supervisor','administrador'), async (req,res)=>{
  const b=req.body||{};
  const producto=safeText(b.producto || b.codigo_barra,180);
  if(!producto) return res.status(400).json({error:'producto-required'});
  const codigo=safeText(b.codigo_barra,80)||null;
  const unidad=safeText(b.unidad,40);
  if(!unidad) return res.status(400).json({error:'invalid'});
  if(!nonNegativeInteger(b.cantidad ?? b.stock)) return res.status(400).json({error:'invalid-quantity'});
  const cantidad=Number(b.cantidad ?? b.stock);
  if(cantidad <= 0) return res.status(400).json({error:'cantidad-required'});
  const fecha=safeText(b.fecha)||nowLocalISO();
  const clienteId=b.cliente_id ? safeInt(b.cliente_id) : null;
  const clienteRow=clienteId ? await db.get('SELECT nombre FROM pro_clientes WHERE id=?',[clienteId]) : null;
  if(clienteId&&!clienteRow) return res.status(400).json({error:'client-required'});
  await db.exec('BEGIN IMMEDIATE');
  try{
    let item = codigo ? await findProductoTerminadoByCodeOrName(codigo) : null;
    if(!item) item = await findProductoTerminadoByCodeOrName(producto);
    let id, saldo;
    if(item){
      if (unidad && unidad !== item.unidad) { await db.exec('ROLLBACK'); return res.status(409).json({error:'unit_mismatch'}); }
      saldo = safeInt(item.stock) + cantidad;
      id = item.id;
      await db.run(`UPDATE pro_productos_terminados SET codigo_barra=COALESCE(?,codigo_barra), producto=?, descripcion=?, unidad=?, stock=?, cliente_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [codigo, item.producto, safeText(b.descripcion || item.descripcion,300), unidad || item.unidad, saldo, clienteId || item.cliente_id || null, id]);
    } else {
      const r=await db.run("INSERT INTO pro_productos_terminados(codigo_barra,producto,descripcion,unidad,stock,stock_min,cliente_id) VALUES(?,?,?,?,?,?,?)", [codigo, producto, safeText(b.descripcion,300), unidad, cantidad, 0, clienteId]);
      id=r.lastID; saldo=cantidad;
    }
    await recordProductoTerminadoMovimiento(req,{producto_id:id,codigo_barra:codigo||item?.codigo_barra||'',producto:item?.producto||producto,movimiento:'producción',entrada:cantidad,saldo,unidad,cliente_id:clienteId,cliente:clienteRow?.nombre||'',referencia:'PRODUCCION',observacion:safeText(b.observacion,300),fecha});
    await logEvent(req,{action:'create',entity:'pro_productos_terminados',entityId:id,detail:JSON.stringify({producto,cantidad})});
    await db.exec('COMMIT');
    res.json({ok:true,id,stock_actual:saldo});
  }catch(e){ await db.exec('ROLLBACK').catch(()=>{}); throw e; }
});

app.put('/api/pro/productos-terminados/:id',requireRole('supervisor','administrador'),async(req,res)=>{
  const b=req.body||{},id=safeInt(req.params.id);
  const item=await db.get('SELECT * FROM pro_productos_terminados WHERE id=?',[id]);
  if(!item) return res.status(404).json({error:'not-found'});
  const producto=safeText(b.producto,180),unidad=safeText(b.unidad,40);
  if(!producto||!unidad) return res.status(400).json({error:'invalid'});
  const other=await db.get('SELECT id FROM pro_productos_terminados WHERE LOWER(producto)=LOWER(?) AND id<>?',[producto,id]);
  if(other) return res.status(409).json({error:'duplicate-record'});
  if(unidad!==item.unidad) return res.status(409).json({error:'unit-has-history'});
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.run('UPDATE pro_productos_terminados SET codigo_barra=?,producto=?,descripcion=?,cliente_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[safeText(b.codigo_barra,80)||null,producto,safeText(b.descripcion,300),b.cliente_id?safeInt(b.cliente_id):null,id]);
    await db.run('UPDATE pro_productos_terminados_movimientos SET producto=? WHERE producto_id=?',[producto,id]);
    await db.run('UPDATE pro_envios_terminados SET producto=? WHERE producto_id=?',[producto,id]);
    await db.run('UPDATE pro_ordenes_produccion SET producto=? WHERE LOWER(producto)=LOWER(?)',[producto,item.producto]);
    await logEvent(req,{action:'update',entity:'pro_productos_terminados',entityId:id});
    await db.exec('COMMIT');res.json({ok:true});
  }catch(error){await db.exec('ROLLBACK');throw error;}
});

app.get('/api/pro/envios-terminados', requireAuth, async (req,res)=>{
  const { q, from, to } = req.query || {};
  const clauses=[]; const params=[];
  const sw=buildTextSearchWhere(q, ['producto','codigo_barra','cliente','observacion','unidad','username']);
  if(sw.clause){ clauses.push(sw.clause); params.push(...sw.params); }
  const f=buildDateWhere({ field:'fecha', from, to });
  if(f.where){ clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const where=clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows=await db.all(`SELECT * FROM pro_envios_terminados ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`, params);
  res.json({items:rows||[]});
});

app.post('/api/pro/envios-terminados',requireRole('supervisor','administrador'),async(req,res)=>{
  const result=await shipProduct(db,req.body||{},req.session.user.username);
  await logEvent(req,{action:'create',entity:'pro_envios_terminados',entityId:result.id});
  res.json(result);
});

app.get('/api/pro/ordenes-produccion', requireAuth, async (req,res)=>{
  const search=buildTextSearchWhere(req.query.q,['codigo','producto','estado','observacion']);
  const rows=await db.all(`SELECT * FROM pro_ordenes_produccion ${search.clause?'WHERE '+search.clause:''} ORDER BY created_at DESC,id DESC LIMIT 500`,search.params);res.json({items:rows||[]});
});
app.post('/api/pro/ordenes-produccion', requireRole('supervisor','administrador'), async (req,res)=>{
  const b=req.body||{};
  if(Number(b.cantidad_producida||0)!==0 || b.estado==='Completada') return res.status(400).json({error:'invalid-order'});
  const codigo=safeText(b.codigo,80) || `OP-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  const fechaInicio=safeText(b.fecha_inicio,10);
  const fechaFinal=safeText(b.fecha_final,10);
  if(!safeText(b.producto,180) || !nonNegativeInteger(b.cantidad_planificada) || Number(b.cantidad_planificada)<=0 || !nonNegativeInteger(b.cantidad_producida ?? 0) || Number(b.cantidad_producida||0)>Number(b.cantidad_planificada) || !['Pendiente','En proceso','Completada','Cancelada'].includes(b.estado||'Pendiente') || (fechaFinal && fechaInicio && fechaFinal<fechaInicio)) return res.status(400).json({error:'invalid-order'});
  const r=await db.run("INSERT INTO pro_ordenes_produccion(codigo,producto,cantidad_planificada,cantidad_producida,estado,responsable,observacion,fecha,fecha_inicio,fecha_final) VALUES(?,?,?,?,?,?,?,?,?,?)", [codigo,safeText(b.producto,180),safeInt(b.cantidad_planificada),safeInt(b.cantidad_producida),safeText(b.estado,40)||'Pendiente','',safeText(b.observacion,300),fechaInicio||nowLocalISO(),fechaInicio,fechaFinal]);
  await logEvent(req,{action:'create',entity:'pro_ordenes_produccion',entityId:r.lastID,detail:codigo}); res.json({ok:true,id:r.lastID,codigo});
});
app.put('/api/pro/ordenes-produccion/:id', requireRole('supervisor','administrador'), async (req,res)=>{
  const b=req.body||{}; const id=safeInt(req.params.id);
  const existing=await db.get('SELECT * FROM pro_ordenes_produccion WHERE id=?',[id]);
  if(!existing) return res.status(404).json({error:'not-found'});
  if(existing.estado==='Completada' || b.estado==='Completada') return res.status(409).json({error:'order-closed'});
  if(Number(b.cantidad_producida||0)!==Number(existing.cantidad_producida)) return res.status(400).json({error:'invalid-order'});
  const fechaInicio=safeText(b.fecha_inicio,10);
  const fechaFinal=safeText(b.fecha_final,10);
  if(!safeText(b.producto,180) || !nonNegativeInteger(b.cantidad_planificada) || Number(b.cantidad_planificada)<=0 || !nonNegativeInteger(b.cantidad_producida ?? 0) || Number(b.cantidad_producida||0)>Number(b.cantidad_planificada) || !['Pendiente','En proceso','Completada','Cancelada'].includes(b.estado||'Pendiente') || (fechaFinal && fechaInicio && fechaFinal<fechaInicio)) return res.status(400).json({error:'invalid-order'});
  await db.run("UPDATE pro_ordenes_produccion SET producto=?, cantidad_planificada=?, cantidad_producida=?, estado=?, responsable='', observacion=?, fecha=?, fecha_inicio=?, fecha_final=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [safeText(b.producto,180),safeInt(b.cantidad_planificada),safeInt(b.cantidad_producida),safeText(b.estado,40)||'Pendiente',safeText(b.observacion,300),fechaInicio||nowLocalISO(),fechaInicio,fechaFinal,id]);
  res.json({ok:true});
});


app.get('/api/pro/materiales.pdf', requireAuth, async (req,res)=>{
  const { q, from, to } = req.query || {};
  const clauses=[req.query.stock==='ARCHIVED'?"m.activo=0":"m.activo=1"]; const params=[];
  if(req.query.stock==='CRITICO')clauses.push('COALESCE(s.cantidad,0)<=m.stock_crit');
  if(req.query.stock==='BAJO')clauses.push('COALESCE(s.cantidad,0)>m.stock_crit AND COALESCE(s.cantidad,0)<=m.stock_min');
  if(req.query.stock==='OK')clauses.push('COALESCE(s.cantidad,0)>m.stock_min');
  const sw=buildTextSearchWhere(q, ['m.tipo','m.codigo_barra','m.categoria','m.ubicacion','m.etiqueta','p.nombre']);
  if(sw.clause){ clauses.push(sw.clause); params.push(...sw.params); }
  const f=buildDateWhere({field:'m.created_at',from,to});
  if(f.where){ clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const rows=await db.all(`SELECT m.*, COALESCE(s.cantidad,0) AS stock_actual, p.nombre AS proveedor FROM pro_materiales m LEFT JOIN stock_productos s ON LOWER(s.tipo)=LOWER(m.tipo) LEFT JOIN pro_proveedores p ON p.id=m.proveedor_id WHERE ${clauses.join(' AND ')} ORDER BY m.tipo ASC`, params);
  const doc=startPdf(res,'almacen_materiales.pdf','Almacén – Catálogo de materiales',{layout:'landscape'});
  drawTable(doc,['Código','Material','Categoría','Lote','Stock','Unidad','Ubicación','Proveedor'],[90,160,95,90,55,70,110,100],rows.map(r=>[r.codigo_barra||'',r.tipo||'',r.categoria||'',r.etiqueta||'',r.stock_actual||0,r.unidad||'',r.ubicacion||'',r.proveedor||'']));
  doc.end();
});

app.get('/api/pro/kardex.pdf', requireAuth, async (req,res)=>{
  const { q, from, to }=req.query||{}; const clauses=[]; const params=[];
  const sw=buildTextSearchWhere(q, ['tipo','codigo_barra','referencia','observacion','movimiento','username']);
  if(sw.clause){ clauses.push(sw.clause); params.push(...sw.params); }
  const f=buildDateWhere({field:'fecha',from,to}); if(f.where){ clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const rows=await db.all(`SELECT * FROM pro_kardex ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`, params);
  const doc=startPdf(res,'almacen_kardex.pdf','Almacén – Kardex de movimientos',{layout:'landscape'});
  drawTable(doc,['Fecha','Código','Material','Mov.','Entrada','Salida','Saldo','Obs.'],[95,90,170,90,55,55,55,160],rows.map(r=>[formatPdfDateTime(r.fecha),r.codigo_barra||'',r.tipo||'',r.movimiento||'',r.entrada||0,r.salida||0,r.saldo||0,r.observacion||'']));
  doc.end();
});

app.get('/api/pro/productos-terminados.pdf', requireAuth, async (req,res)=>{
  const { q, from, to }=req.query||{}; const clauses=["COALESCE(pt.activo,1)=1"]; const params=[];
  const sw=buildTextSearchWhere(q, ['pt.producto','pt.codigo_barra','pt.descripcion','pt.unidad','c.nombre']); if(sw.clause){ clauses.push(sw.clause); params.push(...sw.params); }
  const f=buildDateWhere({field:'pt.created_at',from,to}); if(f.where){ clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const rows=await db.all(`SELECT pt.*, c.nombre AS cliente FROM pro_productos_terminados pt LEFT JOIN pro_clientes c ON c.id=pt.cliente_id WHERE ${clauses.join(' AND ')} ORDER BY pt.producto ASC`,params);
  const doc=startPdf(res,'productos_terminados.pdf','Almacén – Productos terminados',{layout:'landscape'});
  drawTable(doc,['Código','Producto','Stock','Unidad','Cliente','Descripción','Actualizado'],[90,180,55,70,130,160,85],rows.map(r=>[r.codigo_barra||'',r.producto||'',r.stock||0,r.unidad||'',r.cliente||'',r.descripcion||'',formatPdfDateTime(r.updated_at)]));
  doc.end();
});

app.get('/api/pro/envios-terminados.pdf', requireAuth, async (req,res)=>{
  const { q, from, to }=req.query||{}; const clauses=[]; const params=[];
  const sw=buildTextSearchWhere(q, ['producto','codigo_barra','cliente','observacion','unidad','username']); if(sw.clause){ clauses.push(sw.clause); params.push(...sw.params); }
  const f=buildDateWhere({field:'fecha',from,to}); if(f.where){ clauses.push(f.where.replace(/^WHERE\s+/i,'')); params.push(...f.params); }
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const rows=await db.all(`SELECT * FROM pro_envios_terminados ${where} ORDER BY created_at DESC, id DESC LIMIT 1000`,params);
  const doc=startPdf(res,'envios_productos_terminados.pdf','Almacén – Envíos de productos terminados',{layout:'landscape'});
  drawTable(doc,['Fecha','Código','Producto','Cliente','Cantidad','Unidad','Observación','Usuario'],[85,85,160,130,65,65,140,80],rows.map(r=>[formatPdfDateTime(r.fecha),r.codigo_barra||'',r.producto||'',r.cliente||'',r.cantidad||0,r.unidad||'',r.observacion||'',r.username||'']));
  doc.end();
});

app.get('/api/pro/productos-terminados-movimientos.pdf',requireAuth,async(req,res)=>{
  const search=buildTextSearchWhere(req.query.q,['producto','codigo_barra','movimiento','cliente','referencia']);
  const date=buildDateWhere({field:'fecha',from:req.query.from,to:req.query.to});
  const filter=mergeWhere(date.where,date.params,[search.clause],search.params);
  const rows=await db.all(`SELECT * FROM pro_productos_terminados_movimientos ${filter.where} ORDER BY id DESC LIMIT 1000`,filter.params);
  const doc=startPdf(res,'productos_movimientos.pdf','Productos terminados – Movimientos',{layout:'landscape'});
  drawTable(doc,['Fecha','Producto','Movimiento','Entrada','Salida','Saldo','Cliente','Referencia'],[95,150,90,55,55,55,100,100],rows.map(row=>[formatPdfDateTime(row.fecha),row.producto,row.movimiento,row.entrada,row.salida,row.saldo,row.cliente,row.referencia]));
  doc.end();
});

app.get('/api/pro/:scope.xlsx', requireAuth, async (req,res) => {
  const configs={
    materiales:{sql:"SELECT m.codigo_barra AS Código,m.tipo AS Material,m.categoria AS Categoría,m.unidad AS Unidad,COALESCE(s.cantidad,0) AS Stock,m.stock_min AS Mínimo,m.stock_crit AS Crítico,m.ubicacion AS Ubicación FROM pro_materiales m LEFT JOIN stock_productos s ON LOWER(s.tipo)=LOWER(m.tipo) WHERE m.activo=1",fields:['Material','Código','Categoría','Ubicación']},
    kardex:{sql:'SELECT fecha AS Fecha,tipo AS Material,codigo_barra AS Código,movimiento AS Movimiento,entrada AS Entrada,salida AS Salida,saldo AS Saldo,unidad AS Unidad,observacion AS Observación,username AS Usuario FROM pro_kardex',fields:['Material','Código','Movimiento','Observación']},
    'productos-terminados':{sql:'SELECT codigo_barra AS Código,producto AS Producto,stock AS Stock,unidad AS Unidad,descripcion AS Descripción FROM pro_productos_terminados WHERE activo=1',fields:['Producto','Código','Descripción']},
    'productos-terminados-movimientos':{sql:'SELECT fecha AS Fecha,producto AS Producto,codigo_barra AS Código,movimiento AS Movimiento,entrada AS Entrada,salida AS Salida,saldo AS Saldo,unidad AS Unidad,cliente AS Cliente,referencia AS Referencia,username AS Usuario FROM pro_productos_terminados_movimientos',fields:['Producto','Código','Movimiento','Cliente','Referencia']},
    'envios-terminados':{sql:'SELECT fecha AS Fecha,producto AS Producto,codigo_barra AS Código,cliente AS Cliente,cantidad AS Cantidad,unidad AS Unidad,observacion AS Observación FROM pro_envios_terminados',fields:['Producto','Código','Cliente','Observación']}
  };
  const config=configs[req.params.scope];
  if(!config) return res.status(404).json({error:'not-found'});
  if(req.params.scope==='materiales'&&req.query.stock==='ARCHIVED'){config.sql=config.sql.replace('WHERE m.activo=1','WHERE m.activo=0');}
  let rows=await db.all(config.sql);
  if(req.params.scope==='materiales'&&['CRITICO','BAJO','OK'].includes(req.query.stock))rows=rows.filter(row=>req.query.stock==='CRITICO'?row.Stock<=row.Crítico:req.query.stock==='BAJO'?row.Stock>row.Crítico&&row.Stock<=row.Mínimo:row.Stock>row.Mínimo);
  const q=safeText(req.query.q,120).toLocaleLowerCase('es');
  if(q) rows=rows.filter(row=>config.fields.some(field=>String(row[field]||'').toLocaleLowerCase('es').includes(q)));
  if(req.query.from) rows=rows.filter(row=>!row.Fecha || String(row.Fecha).slice(0,10)>=req.query.from);
  if(req.query.to) rows=rows.filter(row=>!row.Fecha || String(row.Fecha).slice(0,10)<=req.query.to);
  const headers=rows.length?Object.keys(rows[0]):config.fields;
  sendXlsx(res,`${req.params.scope}.xlsx`,[{name:'Inventario',aoa:[headers,...rows.map(row=>headers.map(key=>row[key]??''))]}]);
});

app.post('/api/pro/ordenes-produccion/:id/completar',requireRole('supervisor','administrador'),async(req,res)=>{
  const id=safeInt(req.params.id);
  const result=await completeOrder(db,id,req.session.user.username,safeText(req.body?.unidad,40)||'unidades');
  await logEvent(req,{action:'complete',entity:'pro_ordenes_produccion',entityId:id});
  res.json(result);
});

app.get('/api/pro/dashboard', requireAuth, async (req, res) => {
  const getCount = async (sql, params=[]) => {
    try { const row = await db.get(sql, params); return row?.c || 0; } catch { return 0; }
  };
  const mats = await db.get("SELECT COUNT(*) AS c FROM pro_materiales WHERE activo=1");
  const low = await db.get(`SELECT COUNT(*) AS c FROM pro_materiales m LEFT JOIN stock_productos s ON LOWER(s.tipo)=LOWER(m.tipo) WHERE m.activo=1 AND COALESCE(s.cantidad,0) <= m.stock_min`);
  const op = await db.get("SELECT COUNT(*) AS c FROM pro_ordenes_produccion WHERE estado IN ('Pendiente','En proceso')");
  const opTotal = await getCount("SELECT COUNT(*) AS c FROM pro_ordenes_produccion");
  const pt = await db.get("SELECT COUNT(*) AS c, COALESCE(SUM(stock),0) AS total FROM pro_productos_terminados WHERE COALESCE(activo,1)=1");
  const env = await db.get("SELECT COUNT(*) AS c FROM pro_envios_terminados WHERE date(substr(fecha,1,10)) >= date('now','-5 hours','-30 day')");
  const envTotal = await getCount("SELECT COUNT(*) AS c FROM pro_envios_terminados");
  const kardex = await getCount("SELECT COUNT(*) AS c FROM pro_kardex");
  const conteos = await getCount("SELECT COUNT(*) AS c FROM pro_conteos_inventario");
  const proveedores = await getCount("SELECT COUNT(*) AS c FROM pro_proveedores");
  const clientes = await getCount("SELECT COUNT(*) AS c FROM pro_clientes");
  const defectuosos = await getCount("SELECT COUNT(*) AS c FROM defectuosos");
  const maquinaria = await getCount("SELECT COUNT(*) AS c FROM maquinaria_logs");
  const repuestos = await getCount("SELECT COUNT(*) AS c FROM repuestos_inventario");
  const entradas30 = await getCount("SELECT COUNT(*) AS c FROM pro_kardex WHERE movimiento IN ('entrada','entrada inicial','producción') AND date(substr(fecha,1,10)) >= date('now','-5 hours','-30 day')");
  const salidas30 = await getCount("SELECT COUNT(*) AS c FROM pro_kardex WHERE movimiento IN ('dispensamiento','envío') AND date(substr(fecha,1,10)) >= date('now','-5 hours','-30 day')");
  res.json({
    materiales:mats?.c||0,
    stock_bajo:low?.c||0,
    ordenes_abiertas:op?.c||0,
    ordenes_total:opTotal,
    productos_terminados:pt?.c||0,
    stock_terminados:pt?.total||0,
    envios_30d:env?.c||0,
    envios_total:envTotal,
    kardex_movimientos:kardex,
    conteos_fisicos:conteos,
    proveedores,
    clientes,
    defectuosos,
    maquinaria,
    repuestos,
    entradas_30d:entradas30,
    salidas_30d:salidas30
  });
});

// -----------------------------------------------------------------------------
// Healthcheck simple
// -----------------------------------------------------------------------------
app.get('/healthz', async (req, res) => { await db.get('SELECT 1'); res.json({ ok:true }); });

// -----------------------------------------------------------------------------
// Manejador global de errores
// -----------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof OperationError) return res.status(err.status).json({error:err.message,...err.detail});
  if (err.code?.startsWith('SQLITE_CONSTRAINT') || (err.errcode & 255) === 19) return res.status(409).json({ error:'duplicate-record' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error:'size' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error:'invalid-json' });
  res.status(500).json({ error:'internal-error' });
});

// -----------------------------------------------------------------------------
// Inicio del servidor
// -----------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Brumap running at http://localhost:${PORT} (NODE_ENV=${NODE_ENV})`);
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  server.close(async () => { sessionStore.close(); await db.close(); process.exit(0); });
  setTimeout(() => process.exit(1),10000).unref();
});
