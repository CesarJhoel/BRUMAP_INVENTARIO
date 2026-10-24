export function nonNegativeInteger(value) {
  if (!['number','string'].includes(typeof value) || String(value).trim() === '') return false;
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

export function localISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function rebuildMaterialStock(db, tipo) {
  const t = String(tipo || '').trim();
  if (!t) return;
  const lastRec = await db.get('SELECT tipo, unidad, etiqueta FROM recepciones WHERE LOWER(tipo)=LOWER(?) ORDER BY id DESC LIMIT 1', [t]);
  const material = await db.get('SELECT tipo, unidad, etiqueta FROM pro_materiales WHERE LOWER(tipo)=LOWER(?) LIMIT 1', [t]);
  const lastAdj = await db.get('SELECT * FROM stock_ajustes WHERE LOWER(tipo)=LOWER(?) ORDER BY id DESC LIMIT 1', [t]);
  const ref = material || lastRec;
  if (!ref) {
    await db.run('DELETE FROM stock_productos WHERE LOWER(tipo)=LOWER(?)', [t]);
    return;
  }
  let quantity;
  if (lastAdj) {
    // Los cursores evitan volver a sumar movimientos hechos en el mismo segundo del ajuste.
    const added = await db.get(`SELECT COALESCE(SUM(delta),0) AS total FROM recepciones_movimientos
      WHERE LOWER(tipo)=LOWER(?) AND delta>0 AND action IN ('add','create') AND
      (${lastAdj.recepcion_cursor != null ? 'id > ?' : 'created_at > ?'})`, [t, lastAdj.recepcion_cursor ?? lastAdj.created_at]);
    const withdrawn = await db.get(`SELECT COALESCE(SUM(cantidad),0) AS total FROM stock_retiros
      WHERE LOWER(tipo)=LOWER(?) AND (${lastAdj.retiro_cursor != null ? 'id > ?' : 'created_at > ?'})`, [t, lastAdj.retiro_cursor ?? lastAdj.created_at]);
    quantity = Number(lastAdj.cantidad) + Number(added.total) - Number(withdrawn.total);
  } else {
    const received = await db.get('SELECT COALESCE(SUM(cantidad),0) AS total FROM recepciones WHERE LOWER(tipo)=LOWER(?)', [t]);
    const withdrawn = await db.get('SELECT COALESCE(SUM(cantidad),0) AS total FROM stock_retiros WHERE LOWER(tipo)=LOWER(?)', [t]);
    quantity = Number(received.total) - Number(withdrawn.total);
  }
  const existing = await db.get('SELECT id FROM stock_productos WHERE LOWER(tipo)=LOWER(?) LIMIT 1', [t]);
  const values = [ref.tipo, ref.etiqueta || '', Math.max(0, quantity), ref.unidad || ''];
  if (existing) await db.run('UPDATE stock_productos SET tipo=?,etiqueta=?,cantidad=?,unidad=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [...values, existing.id]);
  else await db.run('INSERT INTO stock_productos(tipo,etiqueta,cantidad,unidad) VALUES(?,?,?,?)', values);
  return Math.max(0, quantity);
}

export async function saveStockAdjustment(db, tipo, quantity, unit) {
  const received = await db.get('SELECT COALESCE(MAX(id),0) AS cursor FROM recepciones_movimientos');
  const withdrawn = await db.get('SELECT COALESCE(MAX(id),0) AS cursor FROM stock_retiros');
  await db.run('INSERT INTO stock_ajustes(tipo,cantidad,unidad,recepcion_cursor,retiro_cursor) VALUES(?,?,?,?,?)',
    [tipo, quantity, unit, received.cursor, withdrawn.cursor]);
}
