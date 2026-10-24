import { DatabaseSync } from 'node:sqlite';

export function createSessionStore(Store, filename) {
  return new class extends Store {
    constructor() {
      super();
      this.connection = new DatabaseSync(filename);
      this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
      this.timer = setInterval(() => this.connection.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000);
      this.timer.unref();
    }
    get(sid, callback) {
      try {
        const row = this.connection.prepare('SELECT data FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now());
        callback(null, row ? JSON.parse(row.data) : null);
      } catch (error) { callback(error); }
    }
    set(sid, value, callback = () => {}) {
      try {
        const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 28800000;
        this.connection.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(sid, JSON.stringify(value), expires);
        callback();
      } catch (error) { callback(error); }
    }
    destroy(sid, callback = () => {}) {
      try { this.connection.prepare('DELETE FROM sessions WHERE sid=?').run(sid); callback(); }
      catch (error) { callback(error); }
    }
    touch(sid, value, callback) { this.set(sid, value, callback); }
    clear(callback = () => {}) {
      try { this.connection.exec('DELETE FROM sessions'); callback(); }
      catch (error) { callback(error); }
    }
    close() { clearInterval(this.timer); this.connection.close(); }
  }();
}
