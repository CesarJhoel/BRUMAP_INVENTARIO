import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const source = path.resolve(process.argv[2] || '/import/brumapp.db');
const destination = path.join(process.env.DATA_DIR || '/app/Data', 'brumapp.db');
if (!fs.existsSync(source)) throw new Error('No se encontró la base de datos de origen.');
if (fs.existsSync(destination)) throw new Error('El destino ya tiene una base de datos. Usa Restaurar copia desde el panel.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brumap-import-'));
let database;
try {
  const copied = path.join(temporary, 'source.db');
  fs.copyFileSync(source, copied);
  if (fs.existsSync(source + '-wal')) fs.copyFileSync(source + '-wal', copied + '-wal');
  database = new DatabaseSync(copied);
  const integrity = database.prepare('PRAGMA quick_check').get();
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (Object.values(integrity)[0] !== 'ok' || !['users','recepciones','stock_productos'].every(name => tables.has(name))) throw new Error('La base de datos no es una copia válida de BRUMAP.');
  fs.mkdirSync(path.dirname(destination), { recursive:true });
  database.exec(`VACUUM INTO '${destination.replace(/'/g,"''")}'`);
  console.log('Base de datos migrada al volumen persistente. Se conservaron usuarios y movimientos.');
} finally {
  if (database) database.close();
  fs.rmSync(temporary, { recursive:true, force:true });
}
