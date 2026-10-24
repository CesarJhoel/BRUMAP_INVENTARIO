import { nonNegativeInteger, localISO } from './inventory.js';

export class OperationError extends Error {
  constructor(code, status = 400, detail = {}) { super(code); this.status = status; this.detail = detail; }
}
export async function completeOrder(db, id, username, unit = 'unidades') {
  return db.transaction(async () => {
    const order = await db.get('SELECT * FROM pro_ordenes_produccion WHERE id=?', [id]);
    if (!order) throw new OperationError('not-found', 404);
    if (!['Pendiente', 'En proceso'].includes(order.estado)) throw new OperationError('order-closed', 409);
    const quantity = order.cantidad_planificada - order.cantidad_producida;
    if (!nonNegativeInteger(quantity) || quantity <= 0) throw new OperationError('invalid-order');
    const item = await db.get('SELECT * FROM pro_productos_terminados WHERE activo=1 AND LOWER(producto)=LOWER(?)', [order.producto]);
    const stock = Number(item?.stock || 0) + quantity;
    const product = item?.producto || order.producto;
    let productId = item?.id;
    unit = item?.unidad || unit;
    if (item) await db.run('UPDATE pro_productos_terminados SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [stock, productId]);
    else {
      const created = await db.run('INSERT INTO pro_productos_terminados(producto,unidad,stock) VALUES(?,?,?)', [product, unit, quantity]);
      productId = created.lastID;
    }
    await db.run(`INSERT INTO pro_productos_terminados_movimientos(producto_id,codigo_barra,producto,movimiento,entrada,saldo,unidad,referencia,username,fecha)
      VALUES(?,?,?,'producción',?,?,?,?,?,?)`, [productId, item?.codigo_barra || '', product, quantity, stock, unit, order.codigo, username, localISO()]);
    await db.run("UPDATE pro_ordenes_produccion SET estado='Completada',cantidad_producida=cantidad_planificada,fecha_final=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [localISO().slice(0,10), id]);
    return { ok: true, stock_actual: stock };
  });
}

export async function shipProduct(db, input, username) {
  if (!nonNegativeInteger(input.cantidad) || Number(input.cantidad) <= 0) throw new OperationError('invalid-quantity');
  return db.transaction(async () => {
    const search = String(input.buscar || input.codigo_barra || input.producto || '').trim();
    const item = await db.get('SELECT * FROM pro_productos_terminados WHERE activo=1 AND (LOWER(producto)=LOWER(?) OR LOWER(codigo_barra)=LOWER(?)) LIMIT 1', [search, search]);
    if (!item) throw new OperationError('producto-not-found', 404);
    const quantity = Number(input.cantidad);
    if (item.stock < quantity) throw new OperationError('stock-insuficiente', 409, { stock:item.stock });
    if (input.unidad && input.unidad !== item.unidad) throw new OperationError('unit_mismatch', 409);
    const clientId = Number(input.cliente_id || item.cliente_id);
    const client = await db.get('SELECT nombre FROM pro_clientes WHERE id=?', [clientId]);
    if (!client) throw new OperationError('client-required');
    const stock = item.stock - quantity;
    const date = String(input.fecha || localISO()).slice(0,32);
    const note = String(input.observacion || '').trim().slice(0,300);
    await db.run('UPDATE pro_productos_terminados SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [stock,item.id]);
    const result = await db.run(`INSERT INTO pro_envios_terminados(producto_id,codigo_barra,producto,cantidad,unidad,cliente_id,cliente,observacion,username,fecha)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [item.id,item.codigo_barra||'',item.producto,quantity,item.unidad,clientId,client.nombre,note,username,date]);
    await db.run(`INSERT INTO pro_productos_terminados_movimientos(producto_id,codigo_barra,producto,movimiento,salida,saldo,unidad,cliente_id,cliente,referencia,observacion,username,fecha)
      VALUES(?,?,?,'envío',?,?,?,?,?,?,?,?,?)`, [item.id,item.codigo_barra||'',item.producto,quantity,stock,item.unidad,clientId,client.nombre,`ENV-${result.lastID}`,note,username,date]);
    return { ok:true, id:result.lastID, stock_actual:stock };
  });
}
