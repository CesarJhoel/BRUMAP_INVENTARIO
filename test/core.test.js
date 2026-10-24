import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import { openDatabase } from '../lib/database.js';
import { rebuildMaterialStock, saveStockAdjustment, nonNegativeInteger, localISO } from '../lib/inventory.js';
import { createSessionStore } from '../lib/session-store.js';
import { createWorkbook } from '../lib/workbook.js';
import { completeOrder, shipProduct } from '../lib/production.js';

const source = fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const base = source.match(/const BASE_SCHEMA_SQL = `([\s\S]*?)`;/)[1];
const pro = source.match(/const PRO_SCHEMA_SQL = `([\s\S]*?)`;/)[1];
async function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brumap-test-'));
  const db=await openDatabase(path.join(directory,'test.db'));
  await db.exec(base+pro+"ALTER TABLE stock_ajustes ADD COLUMN recepcion_cursor INTEGER; ALTER TABLE stock_ajustes ADD COLUMN retiro_cursor INTEGER; ALTER TABLE pro_productos_terminados ADD COLUMN activo INTEGER NOT NULL DEFAULT 1; ALTER TABLE pro_ordenes_produccion ADD COLUMN fecha_final TEXT; PRAGMA journal_mode=WAL;");
  t.after(async()=>{await db.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {db,directory};
}
async function material(db,stock=10) {
  await db.run('INSERT INTO pro_materiales(tipo,unidad) VALUES(?,?)',['Acero','kg']);
  if(stock) {
    await db.run("INSERT INTO recepciones(tipo,cantidad,unidad,fecha,created_at) VALUES('Acero',?,'kg','2026-10-09','2026-10-09 10:00:00')",[stock]);
    await db.run("INSERT INTO recepciones_movimientos(tipo,delta,fecha,action,created_at) VALUES('Acero',?,'2026-10-09','create','2026-10-09 10:00:00')",[stock]);
  }
  await rebuildMaterialStock(db,'Acero');
}
test('las cantidades rechazan negativos, fracciones, vacíos e infinito',()=>{
  for(const value of [-1,1.5,'',null,undefined,'foo',' ',true,false,[],[1],{},Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(nonNegativeInteger(value),false,String(value));
  for(const value of [0,1,'0','25']) assert.equal(nonNegativeInteger(value),true);
});
test('los movimientos usan la hora de Lima incluso cerca de medianoche',()=>{
  assert.equal(localISO(new Date('2026-10-09T02:30:00Z')),'2026-10-08T21:30:00');
});
test('un material sin recepciones admite un ajuste físico',async t=>{
  const {db}=await fixture(t);await material(db,0);await saveStockAdjustment(db,'Acero',8,'kg');
  assert.equal(await rebuildMaterialStock(db,'Acero'),8);
});
test('ajustes en el mismo segundo no vuelven a contar entradas anteriores',async t=>{
  const {db}=await fixture(t);await material(db,10);await saveStockAdjustment(db,'Acero',4,'kg');
  await db.run("UPDATE stock_ajustes SET created_at='2026-10-09 10:00:00'");
  assert.equal(await rebuildMaterialStock(db,'Acero'),4);
  await db.run("INSERT INTO recepciones_movimientos(tipo,delta,fecha,action,created_at) VALUES('Acero',3,'2026-10-09','add','2026-10-09 10:00:00')");
  assert.equal(await rebuildMaterialStock(db,'Acero'),7);
  await db.run("INSERT INTO stock_retiros(tipo,cantidad,unidad,fecha,created_at) VALUES('Acero',2,'kg','2026-10-09','2026-10-09 10:00:00')");
  assert.equal(await rebuildMaterialStock(db,'Acero'),5);
});
test('se puede ajustar a cero y reconstruir sin perder el saldo',async t=>{
  const {db}=await fixture(t);await material(db);await saveStockAdjustment(db,'Acero',0,'kg');
  assert.equal(await rebuildMaterialStock(db,'Acero'),0);assert.equal(await rebuildMaterialStock(db,'Acero'),0);
});
test('un segundo ajuste no vuelve a sumar movimientos anteriores',async t=>{
  const {db}=await fixture(t);await material(db);await saveStockAdjustment(db,'Acero',5,'kg');
  await db.run("INSERT INTO recepciones_movimientos(tipo,delta,fecha,action) VALUES('Acero',4,'2026-10-09','add')");
  await saveStockAdjustment(db,'Acero',2,'kg');assert.equal(await rebuildMaterialStock(db,'Acero'),2);
});
test('las transacciones fallidas revierten todas las escrituras',async t=>{
  const {db}=await fixture(t);
  await assert.rejects(db.transaction(async()=>{await db.run("INSERT INTO pro_clientes(nombre) VALUES('Temporal')");throw new Error('fallo');}));
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM pro_clientes')).c,0);
});
test('completar una orden registra producción y rechaza una segunda confirmación',async t=>{
  const {db}=await fixture(t);const order=await db.run("INSERT INTO pro_ordenes_produccion(codigo,producto,cantidad_planificada,fecha) VALUES('OP-1','Caja',8,'2026-10-09')");
  assert.equal((await completeOrder(db,order.lastID,'supervisor')).stock_actual,8);
  await assert.rejects(completeOrder(db,order.lastID,'supervisor'),{message:'order-closed'});
  assert.equal((await db.get('SELECT stock FROM pro_productos_terminados')).stock,8);
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM pro_productos_terminados_movimientos')).c,1);
});
test('dos confirmaciones simultáneas no duplican la producción',async t=>{
  const {db}=await fixture(t);const order=await db.run("INSERT INTO pro_ordenes_produccion(codigo,producto,cantidad_planificada,fecha) VALUES('OP-2','Caja',5,'2026-10-09')");
  const results=await Promise.allSettled([completeOrder(db,order.lastID,'a'),completeOrder(db,order.lastID,'b')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await db.get('SELECT stock FROM pro_productos_terminados')).stock,5);
});
async function product(db) {
  const client=await db.run("INSERT INTO pro_clientes(nombre) VALUES('Cliente de prueba')");
  await db.run("INSERT INTO pro_productos_terminados(producto,codigo_barra,stock,unidad) VALUES('Caja grande','P-001',10,'unidades')");
  return client.lastID;
}
test('un envío descuenta el stock y conserva trazabilidad',async t=>{
  const {db}=await fixture(t);const client=await product(db);
  const result=await shipProduct(db,{buscar:'P-001',cantidad:3,cliente_id:client},'supervisor');
  assert.equal(result.stock_actual,7);
  const movement=await db.get('SELECT * FROM pro_productos_terminados_movimientos');
  assert.equal(movement.salida,3);assert.equal(movement.saldo,7);assert.equal(movement.cliente,'Cliente de prueba');
});
test('envíos simultáneos no generan stock negativo',async t=>{
  const {db}=await fixture(t);const client=await product(db);
  const results=await Promise.allSettled([shipProduct(db,{buscar:'P-001',cantidad:7,cliente_id:client},'a'),shipProduct(db,{buscar:'P-001',cantidad:7,cliente_id:client},'b')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await db.get('SELECT stock FROM pro_productos_terminados')).stock,3);
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM pro_envios_terminados')).c,1);
});
test('nombres parciales y clientes inexistentes no producen envíos',async t=>{
  const {db}=await fixture(t);const client=await product(db);
  await assert.rejects(shipProduct(db,{buscar:'Caja',cantidad:2,cliente_id:client},'a'),{message:'producto-not-found'});
  await assert.rejects(shipProduct(db,{buscar:'Caja grande',cantidad:2,cliente_id:9999},'a'),{message:'client-required'});
  await assert.rejects(shipProduct(db,{buscar:'P-001',cantidad:0.5,cliente_id:client},'a'),{message:'invalid-quantity'});
  assert.equal((await db.get('SELECT stock FROM pro_productos_terminados')).stock,10);
});
test('VACUUM INTO incluye datos recientes que están en WAL',async t=>{
  const {db,directory}=await fixture(t);await material(db,27);
  const file=path.join(directory,'snapshot.db');await db.exec(`VACUUM INTO '${file}'`);
  const backup=await openDatabase(file,{readOnly:true});
  assert.equal((await backup.get('SELECT cantidad FROM stock_productos')).cantidad,27);
  assert.equal(Object.values(await backup.get('PRAGMA quick_check'))[0],'ok');await backup.close();
});
test('las sesiones sobreviven a un reinicio y se pueden invalidar',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brumap-session-'));const filename=path.join(directory,'sessions.db');
  let store=createSessionStore(EventEmitter,filename);
  const call=(method,...args)=>new Promise((resolve,reject)=>store[method](...args,(error,value)=>error?reject(error):resolve(value)));
  await call('set','active',{cookie:{expires:new Date(Date.now()+60000)},user:{id:1}});store.close();store=createSessionStore(EventEmitter,filename);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  assert.equal((await call('get','active')).user.id,1);
  await call('set','expired',{cookie:{expires:new Date(Date.now()-1000)},user:{id:2}});assert.equal(await call('get','expired'),null);
  await call('clear');assert.equal(await call('get','active'),null);
});
function unzipLocal(buffer) {
  const files={};let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50){const size=buffer.readUInt32LE(offset+18),length=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28);const name=buffer.subarray(offset+30,offset+30+length).toString();const start=offset+30+length+extra;files[name]=inflateRawSync(buffer.subarray(start,start+size)).toString();offset=start+size;}
  return files;
}
test('Excel preserva Unicode, números y texto sin ejecutar fórmulas',()=>{
  const workbook=createWorkbook([{name:'Inventario',aoa:[['Material','Cantidad'],['Ñ & <á>',12],['=HYPERLINK("https://example.invalid")',0]]}]);
  assert.equal(workbook.subarray(0,2).toString(),'PK');
  const files=unzipLocal(workbook);assert.equal(Object.keys(files).length,5);
  assert.match(files['xl/worksheets/sheet1.xml'],/Ñ &amp; &lt;á&gt;/);
  assert.match(files['xl/worksheets/sheet1.xml'],/<c r="B2"><v>12<\/v><\/c>/);
  assert.match(files['xl/worksheets/sheet1.xml'],/=HYPERLINK\(&quot;/);assert.doesNotMatch(files['xl/worksheets/sheet1.xml'],/<f[ >]/);
});
test('Excel admite hojas vacías y columnas después de Z',()=>{
  const files=unzipLocal(createWorkbook([{name:'Vacío',aoa:[]},{name:'Ancho',aoa:[Array.from({length:28},(_,i)=>i)]}]));
  assert.match(files['xl/worksheets/sheet2.xml'],/r="AB1"/);
  assert.match(files['xl/worksheets/sheet1.xml'],/<sheetData><\/sheetData>/);
});

test('la reconstrucción respeta nombres con diferente capitalización',async t=>{
  const {db}=await fixture(t);await material(db);
  await db.run("UPDATE stock_productos SET tipo='acero'");
  assert.equal(await rebuildMaterialStock(db,'ACERO'),10);
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM stock_productos')).c,1);
});

test('las búsquedas de materiales respetan mayúsculas y tildes en español',async t=>{
  const {db}=await fixture(t);await db.run("INSERT INTO pro_materiales(tipo,unidad) VALUES('Ácido','litros')");
  const row=await db.get('SELECT tipo FROM pro_materiales WHERE LOWER(tipo)=LOWER(?)',['ácido']);
  assert.equal(row.tipo,'Ácido');
});
