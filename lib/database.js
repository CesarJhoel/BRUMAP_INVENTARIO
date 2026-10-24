import { DatabaseSync } from 'node:sqlite';

// Interfaz asíncrona compatible con las consultas existentes, sin módulos nativos externos.
export async function openDatabase(filename, { readOnly = false } = {}) {
  const connection = new DatabaseSync(filename, { readOnly });
  connection.function('lower', {deterministic:true}, value => value == null ? null : String(value).toLocaleLowerCase('es'));
  let transactions = Promise.resolve();
  const database = {
    async exec(sql) { connection.exec(sql); },
    async get(sql, params = []) { return connection.prepare(sql).get(...params); },
    async all(sql, params = []) { return connection.prepare(sql).all(...params); },
    async run(sql, params = []) {
      const result = connection.prepare(sql).run(...params);
      return { lastID: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async close() { connection.close(); },
    transaction(task) {
      const result = transactions.then(async () => {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const value = await task(database);
          connection.exec('COMMIT');
          return value;
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      });
      transactions = result.catch(() => {});
      return result;
    }
  };
  return database;
}
