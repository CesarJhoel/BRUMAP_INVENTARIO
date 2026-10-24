'use strict';
import {esc,number,dateOnly,dateTime,formatDate} from './utils.js';
const $ = selector => document.querySelector(selector);
const paths = {
  dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  box:'m3 7 9-4 9 4-9 4-9-4 M3 7v10l9 4 9-4V7 M12 11v10 M7 5l10 4',
  move:'M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4',
  history:'M3 12a9 9 0 1 0 2-6 M3 3v6h6 M12 7v5l3 2',
  check:'M9 5H5v16h14V5h-4 M9 3h6v4H9z m-1 11 3 3 5-6',
  factory:'M3 21V10l6 4V10l6 4V3h4v18H3 M6 18h1 M11 18h1 M16 18h1',
  truck:'M3 5h12v12H3z M15 10h4l3 4v3h-7 M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M18 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  people:'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-3a4 4 0 0 0-3-4',
  alert:'m12 3 10 18H2L12 3 M12 9v4 M12 17h.01',
  tool:'m14 6 4 4 4-4a7 7 0 0 1-9 9l-6 6a3 3 0 0 1-4-4l6-6a7 7 0 0 1 5-9l-4 4',
  backup:'M5 17a4 4 0 0 1-1-8 7 7 0 0 1 13-3 5 5 0 0 1 3 11 M12 20V10 m-4 4 4-4 4 4',
  search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 m5 12 6 6',
  plus:'M12 5v14 M5 12h14', edit:'m16 3 5 5-12 12-6 1 1-6L16 3 M14 5l5 5',
  trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  download:'M12 3v12 m-5-5 5 5 5-5 M4 15v6h16v-6',
  sun:'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  moon:'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10',
  user:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3',
  lock:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.box}"/></svg>`;
const badge = (text, tone='') => `<span class="badge ${tone}">${esc(text)}</span>`;
const state = { user:null, scope:'dashboard', rows:[], page:1, size:15, query:'', from:'', to:'', stockFilter:'', view:'current', sequence:0, editing:null, options:{}, request:0, sortKey:'', sortDirection:1, pendingMovement:null };
const errorMessages = {
  'bad-csrf':'La sesión cambió. Intenta nuevamente.', forbidden:'Tu cuenta no tiene permiso para esta acción.',
  'duplicate-record':'Ya existe un registro con ese nombre o código.', 'stock-insuficiente':'No hay stock suficiente.',
  'material-not-found':'Selecciona un material del catálogo o escanea su código completo.', 'producto-not-found':'Selecciona un producto existente o escanea su código completo.',
  'invalid-quantity':'La cantidad debe ser un número entero igual o mayor que cero.', 'cantidad-required':'La cantidad debe ser mayor que cero.',
  'unit_mismatch':'La unidad debe coincidir con la registrada en el catálogo.', 'unit-has-history':'No se puede cambiar la unidad de un material con movimientos.',
  'weak-password':'Usa una contraseña de al menos 12 caracteres y máximo 72 bytes.', 'incorrect-password':'La contraseña actual es incorrecta.',
  'protected-user':'La cuenta principal está protegida contra cambios de rol y eliminación.', 'invalid-username':'Usa entre 3 y 32 caracteres: letras, números, puntos, guiones o guiones bajos.',
  'record-in-use':'Este contacto tiene registros asociados. Puedes editar sus datos.', 'stock-must-be-zero':'El stock debe ser cero antes de archivar el material.',
  'order-closed':'Esta orden ya fue completada o cancelada.', 'invalid-order':'Revisa el producto, las cantidades y el rango de fechas.',
  'invalid-backup':'El archivo no contiene una base de datos válida de BRUMAP.', not_sqlite:'Selecciona un archivo SQLite .db válido.',
  'reason-required':'Indica un motivo para el ajuste.', restore_failed:'No se pudo restaurar el archivo. La base anterior se conserva.', size:'El archivo supera el tamaño permitido.',
  'client-required':'Selecciona un cliente para el envío.', 'name-required':'El nombre es obligatorio.', 'not-found':'El registro ya no existe.',
  'invalid-role':'Selecciona un rol válido.', 'discounted-record':'Este descarte ya descontó stock. Registra la corrección en Movimientos.',
  invalid:'Revisa los campos obligatorios y las cantidades.', 'internal-error':'No se pudo completar la operación. Intenta nuevamente.'
};
let csrfPromise;
async function api(url, options={}, retry=true) {
  const init = {...options,headers:{...options.headers}};
  if (init.body && typeof init.body !== 'string') { init.body=JSON.stringify(init.body); init.headers['Content-Type']='application/json'; }
  if (['POST','PUT','PATCH','DELETE'].includes(init.method)) {
    csrfPromise ||= fetch('/csrf').then(async response => { if(!response.ok) throw new Error('No se pudo validar la sesión.'); return (await response.json()).token; }).catch(error=>{csrfPromise=null;throw error;});
    init.headers['x-csrf-token']=await csrfPromise;
  }
  let response;
  try { response=await fetch(url,init); } catch { throw new Error('No hay conexión con el servidor. Intenta nuevamente.'); }
  if (!response.ok) {
    const data=await response.json().catch(()=>({}));
    if (data.error==='bad-csrf' && retry) {csrfPromise=null;return api(url,options,false);}
    if(response.status===401){location.replace('/');throw new Error('Tu sesión terminó. Inicia sesión nuevamente.');}
    const error=new Error(errorMessages[data.error] || (response.status===429 ? 'Demasiadas solicitudes. Espera un momento.' : 'No se pudo completar la operación.'));
    error.code=data.error;error.payload=data;throw error;
  }
  return response.json();
}
function toast(message,error=false){const div=document.createElement('div');div.className=`toast${error?' error':''}`;div.textContent=message;$('#toastRegion').append(div);setTimeout(()=>div.remove(),6500);}
function confirmAction(text,title='Confirmar acción',accept='Confirmar') {
  const dialog=$('#confirmDialog');if(dialog.open)return Promise.resolve(false);$('#confirmTitle').textContent=title;$('#confirmText').textContent=text;$('#confirmAccept').textContent=accept;
  return new Promise(resolve=>{const finish=value=>{dialog.close();$('#confirmAccept').onclick=null;$('#confirmCancel').onclick=null;dialog.oncancel=null;resolve(value);};$('#confirmAccept').onclick=()=>finish(true);$('#confirmCancel').onclick=()=>finish(false);dialog.oncancel=()=>finish(false);dialog.showModal();$('#confirmCancel').focus();});
}
const field = (name,label,type='text',extra={}) => ({name,label,type,...extra});
const qty = (name,label,extra={}) => field(name,label,'number',{min:0,step:1,...extra});
const units = ['unidades','kg','gramos','cajas','metros','centímetros','litros','mililitros','rollos','paquetes'];
const unit = () => field('unidad','Unidad','select',{options:units,default:'unidades',required:true});
const columns = (...items) => items.map(([key,label,render,numeric])=>({key,label,render,numeric}));
const materialCell = row => `<strong>${esc(row.tipo)}</strong><small>${esc(row.codigo_barra||'Sin código')}</small>`;
const productCell = row => `<strong>${esc(row.producto)}</strong><small>${esc(row.codigo_barra||'Sin código')}</small>`;
const statusCell = row => row.estado_stock==='ARCHIVED'?badge('Archivado'):badge(row.estado_stock==='CRITICO'?'Crítico':row.estado_stock==='BAJO'?'Bajo mínimo':'Disponible',row.estado_stock==='CRITICO'?'danger':row.estado_stock==='BAJO'?'warning':'success');
const orderStatus = row => badge(row.estado,row.estado==='Completada'?'success':row.estado==='Cancelada'?'danger':row.estado==='En proceso'?'accent':'warning');
const configs = {
  materiales:{title:'Materiales',description:'Tu catálogo de insumos, con existencias, ubicación y niveles de reposición.',icon:'box',group:'ALMACÉN',endpoint:'/api/pro/materiales',newLabel:'Nuevo material',exports:true,fields:[field('tipo','Nombre del material','text',{required:true,full:true,max:180}),field('codigo_barra','Código de barras','text',{max:80}),field('categoria','Categoría'),unit(),field('ubicacion','Ubicación'),field('etiqueta','Lote o etiqueta'),field('proveedor_id','Proveedor','select',{source:'proveedores'}),qty('stock_inicial','Stock inicial',{default:0,createOnly:true}),qty('stock_min','Stock mínimo',{default:0}),qty('stock_crit','Stock crítico',{default:0,help:'Debe ser igual o menor que el mínimo.'})],columns:columns(['tipo','Material',materialCell],['categoria','Categoría'],['stock_actual','Stock',r=>`<strong>${number(r.stock_actual)}</strong> <small>${esc(r.unidad)}</small>`,true],['stock_min','Mínimo',r=>number(r.stock_min),true],['ubicacion','Ubicación'],['estado_stock','Estado',statusCell]),empty:'Registra tu primer material para empezar a controlar las existencias.'},
  kardex:{title:'Kardex',description:'Cada entrada, salida y ajuste, con su saldo y usuario responsable.',icon:'history',group:'ALMACÉN',endpoint:'/api/pro/kardex',readOnly:true,exports:true,dates:true,columns:columns(['fecha','Fecha',r=>formatDate(r.fecha)],['tipo','Material',materialCell],['movimiento','Movimiento',r=>badge(r.movimiento)],['entrada','Entrada',r=>number(r.entrada),true],['salida','Salida',r=>number(r.salida),true],['saldo','Saldo',r=>number(r.saldo),true],['observacion','Detalle'],['username','Usuario']),empty:'Los movimientos de almacén aparecerán aquí automáticamente.',limit:1000},
  conteos:{title:'Recuentos físicos',description:'Compara el stock del sistema con el conteo real y registra las diferencias.',icon:'check',group:'ALMACÉN',endpoint:'/api/pro/conteos',newLabel:'Nuevo recuento',createEndpoint:'/api/pro/conteo',noEdit:true,dates:true,fields:[field('codigo_barra','Material o código','text',{required:true,list:'materialSuggestions',full:true}),qty('stock_fisico','Stock físico',{required:true}),field('fecha','Fecha','datetime-local',{default:dateTime,required:true}),field('motivo','Motivo del recuento','textarea',{full:true,required:true}),field('aplicar_ajuste','Actualizar el stock con este recuento','checkbox',{help:'El ajuste quedará registrado en el Kardex.'})],columns:columns(['fecha','Fecha',r=>formatDate(r.fecha)],['tipo','Material',materialCell],['stock_sistema','Sistema',r=>number(r.stock_sistema),true],['stock_fisico','Físico',r=>number(r.stock_fisico),true],['diferencia','Diferencia',r=>badge(`${r.diferencia>0?'+':''}${number(r.diferencia)}`,r.diferencia?'warning':'success'),true],['motivo','Motivo'],['username','Usuario']),empty:'Crea un recuento para verificar tus existencias.',limit:300},
  productos:{title:'Productos terminados',description:'Registra la producción disponible y consulta las entradas y envíos de cada producto.',icon:'box',group:'PRODUCCIÓN',endpoint:'/api/pro/productos-terminados',newLabel:'Registrar producción',exports:true,dates:true,fields:[field('producto','Nombre del producto','text',{required:true,full:true,list:'productSuggestions',max:180}),field('codigo_barra','Código de barras','text',{max:80}),unit(),qty('cantidad','Cantidad producida',{required:true,min:1,default:1,createOnly:true}),field('cliente_id','Cliente relacionado','select',{source:'clientes'}),field('descripcion','Descripción','textarea',{full:true}),field('fecha','Fecha de producción','datetime-local',{default:dateTime,createOnly:true,required:true})],columns:columns(['producto','Producto',productCell],['stock','Stock',r=>`<strong>${number(r.stock)}</strong><small>${esc(r.unidad)}</small>`,true],['cliente','Cliente'],['descripcion','Descripción'],['updated_at','Actualizado',r=>formatDate(r.updated_at)]),empty:'Registra una producción o completa una orden para añadir productos.'},
  ordenes:{title:'Órdenes de producción',description:'Planifica la producción y completa la orden para sumar las unidades al stock de productos terminados.',icon:'factory',group:'PRODUCCIÓN',endpoint:'/api/pro/ordenes-produccion',newLabel:'Nueva orden',fields:[field('codigo','Código de orden','text',{createOnly:true,help:'Opcional. Se genera automáticamente.'}),field('producto','Producto','text',{required:true,list:'productSuggestions',full:true,max:180}),qty('cantidad_planificada','Cantidad planificada',{required:true,min:1}),field('estado','Estado','select',{options:['Pendiente','En proceso','Cancelada'],default:'Pendiente'}),field('fecha_inicio','Fecha de inicio','date',{default:dateOnly,required:true}),field('fecha_final','Fecha prevista de finalización','date'),field('observacion','Observaciones','textarea',{full:true})],columns:columns(['codigo','Orden',r=>`<strong>${esc(r.codigo)}</strong>`],['producto','Producto'],['cantidad_planificada','Planificado',r=>number(r.cantidad_planificada),true],['cantidad_producida','Producido',r=>number(r.cantidad_producida),true],['estado','Estado',orderStatus],['fecha_inicio','Inicio',r=>formatDate(r.fecha_inicio)],['fecha_final','Finalización',r=>formatDate(r.fecha_final)]),empty:'Planifica tu primera orden de producción.',limit:500},
  envios:{title:'Envíos',description:'Despacha productos a tus clientes. El stock se descuenta al confirmar cada envío.',icon:'truck',group:'PRODUCCIÓN',endpoint:'/api/pro/envios-terminados',newLabel:'Nuevo envío',noEdit:true,exports:true,dates:true,fields:[field('buscar','Producto o código','text',{required:true,list:'productSuggestions',full:true}),qty('cantidad','Cantidad a enviar',{required:true,min:1,default:1}),field('cliente_id','Cliente','select',{required:true,source:'clientes'}),field('fecha','Fecha del envío','datetime-local',{required:true,default:dateTime}),field('observacion','Observaciones','textarea',{full:true})],columns:columns(['fecha','Fecha',r=>formatDate(r.fecha)],['producto','Producto',productCell],['cliente','Cliente'],['cantidad','Cantidad',r=>`${number(r.cantidad)} ${esc(r.unidad)}`,true],['observacion','Observación'],['username','Usuario']),empty:'Registra clientes y productos antes de crear tu primer envío.',limit:1000},
  proveedores:{title:'Proveedores',description:'Mantén los contactos que abastecen tus materiales.',icon:'people',group:'CONTACTOS',endpoint:'/api/pro/proveedores',newLabel:'Nuevo proveedor',deletable:true,fields:[field('nombre','Nombre o razón social','text',{required:true,full:true}),field('ruc','RUC'),field('contacto','Persona de contacto'),field('telefono','Teléfono','tel'),field('correo','Correo electrónico','email'),field('observaciones','Observaciones','textarea',{full:true})],columns:columns(['nombre','Proveedor',r=>`<strong>${esc(r.nombre)}</strong>`],['ruc','RUC'],['contacto','Contacto'],['telefono','Teléfono'],['correo','Correo']),empty:'Agrega tus proveedores y vincúlalos a los materiales.'},
  clientes:{title:'Clientes',description:'Organiza los destinos, datos de contacto y documentos de tus clientes.',icon:'people',group:'CONTACTOS',endpoint:'/api/pro/clientes',newLabel:'Nuevo cliente',deletable:true,fields:[field('nombre','Nombre o razón social','text',{required:true,full:true}),field('documento','Documento / RUC'),field('contacto','Persona de contacto'),field('telefono','Teléfono','tel'),field('correo','Correo electrónico','email'),field('direccion','Dirección','text',{full:true}),field('observaciones','Observaciones','textarea',{full:true})],columns:columns(['nombre','Cliente',r=>`<strong>${esc(r.nombre)}</strong>`],['documento','Documento'],['contacto','Contacto'],['telefono','Teléfono'],['direccion','Dirección']),empty:'Agrega un cliente para registrar tus envíos.'},
  defectuosos:{title:'Material defectuoso',description:'Registra los descartes y su motivo. Puedes descontar el material del almacén al guardarlo.',icon:'alert',group:'OPERACIÓN',endpoint:'/api/defectuosos',newLabel:'Registrar descarte',deletable:true,dates:true,exports:true,fields:[field('tipo','Material','text',{required:true,list:'materialSuggestions',full:true}),qty('cantidad','Cantidad descartada',{required:true,min:1}),unit(),field('fecha','Fecha','date',{default:dateOnly,required:true}),field('razon','Motivo del descarte','textarea',{required:true,full:true}),field('descontar_stock','Descontar esta cantidad del almacén','checkbox',{createOnly:true,help:'Requiere un material del catálogo con stock suficiente.'})],columns:columns(['fecha','Fecha',r=>formatDate(r.fecha)],['tipo','Material'],['cantidad','Cantidad',r=>`${number(r.cantidad)} ${esc(r.unidad)}`,true],['razon','Motivo'],['stock_descontado','Inventario',r=>badge(r.stock_descontado?'Stock descontado':'Solo registro',r.stock_descontado?'success':'' )]),empty:'Los descartes que registres aparecerán aquí.'},
  maquinaria:{title:'Maquinaria',description:'Lleva un registro de servicios, mantenimientos e incidencias.',icon:'tool',group:'OPERACIÓN',endpoint:'/api/maquinaria',newLabel:'Registrar servicio',deletable:true,dates:true,exports:true,restricted:true,fields:[field('maquina','Máquina','text',{required:true,max:48}),field('servicio','Servicio','text',{required:true,max:64}),field('fecha','Fecha','date',{required:true,default:dateOnly}),field('descripcion','Descripción','textarea',{full:true,max:400})],columns:columns(['maquina','Máquina'],['servicio','Servicio'],['fecha','Fecha',r=>formatDate(r.fecha)],['descripcion','Descripción']),empty:'Registra el primer servicio de tu maquinaria.'},
  repuestos:{title:'Repuestos',description:'Consulta las existencias y observaciones de tus repuestos.',icon:'tool',group:'OPERACIÓN',endpoint:'/api/repuestos',newLabel:'Nuevo repuesto',deletable:true,dates:true,exports:true,restricted:true,fields:[field('repuesto','Repuesto','text',{required:true,max:80,full:true}),qty('cantidad','Cantidad',{required:true,default:0}),field('fecha','Fecha','date',{required:true,default:dateOnly}),field('observaciones','Observaciones','textarea',{full:true,max:400})],columns:columns(['repuesto','Repuesto'],['cantidad','Cantidad',r=>number(r.cantidad),true],['fecha','Fecha',r=>formatDate(r.fecha)],['observaciones','Observaciones']),empty:'Agrega tus repuestos para controlar sus cantidades.'},
  usuarios:{title:'Usuarios',description:'Gestiona el acceso. Operarios consultan; administradores gestionan la operación; supervisores gestionan todo.',icon:'people',group:'ADMINISTRACIÓN',endpoint:'/api/users',newLabel:'Nuevo usuario',deletable:true,supervisor:true,fields:[field('username','Usuario','text',{required:true,createOnly:true,minlength:3,max:32,pattern:'[a-z0-9._-]{3,32}'}),field('password','Contraseña inicial','password',{required:true,createOnly:true,minlength:12,max:72,help:'Mínimo 12 caracteres.'}),field('role','Rol','select',{required:true,options:[['operario','Operario'],['administrador','Administrador'],['supervisor','Supervisor']]})],columns:columns(['username','Usuario',r=>`<strong>${esc(r.username)}</strong>${r.is_protected?'<small>Cuenta principal protegida</small>':''}`],['role','Rol',r=>badge(r.role)]),empty:'No hay usuarios registrados.'}
};
const writable = () => state.user?.role !== 'operario';
const supervisor = () => state.user?.role === 'supervisor';
const permitted = cfg => (!cfg.restricted || writable()) && (!cfg.supervisor || supervisor());
function renderNavigation() {
  let html=`<a class="nav-link" href="#dashboard">${icon('dashboard')}Resumen</a>`;
  let group='';
  const entries=Object.entries(configs);
  entries.splice(1,0,['movimientos',{title:'Movimientos',icon:'move',group:'ALMACÉN'}]);
  entries.forEach(([key,cfg])=>{if(!permitted(cfg))return;if(group!==cfg.group){group=cfg.group;html+=`<div class="nav-group">${group}</div>`;}html+=`<a class="nav-link" href="#${key}">${icon(cfg.icon)}${cfg.title}</a>`;});
  if(supervisor()) html+=`<a class="nav-link" href="#backups">${icon('backup')}Copias de seguridad</a>`;
  $('#navigation').innerHTML=html;
}
function heading(title,description,actions='',eyebrow='GESTIÓN OPERATIVA') {return `<div class="page-heading"><div><span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="page-actions">${actions}</div></div>`;}
function emptyState(title,description,action=''){return `<div class="empty-state">${icon('box')}<h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
async function route() {
  const scope=location.hash.slice(1)||'dashboard';
  const cfg=configs[scope];
  if((cfg&&!permitted(cfg))||(scope==='backups'&&!supervisor())){location.hash='dashboard';return;}
  state.scope=scope;state.page=1;state.query='';state.from='';state.to='';state.stockFilter='';state.view='current';state.sortKey='';state.sortDirection=1;
  const sequence=++state.sequence;
  closeMenu();
  $$('.nav-link').forEach(link=>{const active=link.hash===`#${scope}`;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  $('#breadcrumb').textContent=cfg?.title||({dashboard:'Resumen',movimientos:'Movimientos',backups:'Copias de seguridad',cuenta:'Mi cuenta'}[scope]||'Resumen');
  $('#content').innerHTML='<div class="loading-state" role="status">Cargando…</div>';
  try {
    if(scope==='dashboard') await dashboard(sequence);
    else if(scope==='movimientos') {const pending=state.pendingMovement;state.pendingMovement=null;await movementPage(sequence,pending?{codigo_barra:pending.tipo}:{},pending?.mode||'entrada');}
    else if(scope==='backups') backupPage();
    else if(scope==='cuenta') accountPage();
    else if(cfg) await tablePage(cfg,sequence);
    else {location.hash='dashboard';return;}
    if(sequence===state.sequence) $('#lastUpdate').textContent=`Actualizado ${new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}`;
  } catch(error) { if(sequence!==state.sequence)return;$('#content').innerHTML=emptyState('No se pudo cargar la información',error.message,'<button class="btn" data-action="refresh">Reintentar</button>');toast(error.message,true); }
}
function $$(selector){return [...document.querySelectorAll(selector)];}
async function dashboard(sequence) {
  const [summary,materials,orders,activity] = await Promise.all([api('/api/pro/dashboard'),api('/api/pro/materiales'),api('/api/pro/ordenes-produccion'),api('/api/pro/kardex')]);
  if(sequence!==state.sequence)return;
  const low=materials.items.filter(item=>item.estado_stock!=='OK').sort((a,b)=>Number(a.stock_actual)-Number(b.stock_actual));
  const active=orders.items.filter(order=>['Pendiente','En proceso'].includes(order.estado)).slice(0,5);
  const stats=[['Materiales en catálogo',summary.materiales,'box','Insumos activos'],['Stock por reponer',summary.stock_bajo,'alert','Materiales en mínimo o por debajo'],['Órdenes abiertas',summary.ordenes_abiertas,'factory','Pendientes o en proceso'],['Envíos del mes',summary.envios_30d,'truck','Registrados en los últimos 30 días']];
  const actions=writable()?`<a class="btn primary" href="#movimientos">${icon('plus')}Registrar movimiento</a>`:'';
  $('#content').innerHTML=heading('Tu operación, de un vistazo','Revisa las existencias y las prioridades de hoy.',actions,'RESUMEN GENERAL')+
    `<div class="stats-grid">${stats.map(([label,value,i,caption])=>`<div class="card stat-card"><div class="stat-label">${esc(label)}${icon(i)}</div><strong class="stat-value">${number(value)}</strong><span class="stat-caption">${esc(caption)}</span></div>`).join('')}</div>`+
    `<div class="quick-actions"><a class="btn" href="#materiales">${icon('box')}Ver materiales</a><a class="btn" href="#ordenes">${icon('factory')}Órdenes de producción</a><a class="btn" href="#envios">${icon('truck')}Envíos</a><a class="btn" href="#kardex">${icon('history')}Consultar Kardex</a></div>`+
    `<div class="dashboard-grid"><section class="card"><div class="card-header"><h3>Materiales por reponer</h3>${badge(`${low.length} materiales`,low.length?'warning':'success')}</div><div class="card-body">${low.length?low.slice(0,6).map(row=>`<a class="attention-row" href="#materiales"><div class="attention-info"><span class="status-dot ${row.estado_stock==='CRITICO'?'critical':''}"></span><div><strong>${esc(row.tipo)}</strong><small>${esc(row.ubicacion||'Sin ubicación')} · Mínimo ${number(row.stock_min)}</small></div></div><div class="attention-quantity"><strong>${number(row.stock_actual)} ${esc(row.unidad)}</strong>${statusCell(row)}</div></a>`).join(''):emptyState('Stock al día','Tus materiales están por encima del mínimo definido.')}<a class="btn small" href="#materiales">Ver catálogo →</a></div></section>`+
    `<section class="card"><div class="card-header"><h3>Producción en curso</h3><a class="muted" href="#ordenes">Ver todas →</a></div>${active.length?`<div class="table-scroll"><table><thead><tr><th>Orden / Producto</th><th class="number">Planificado</th><th>Estado</th></tr></thead><tbody>${active.map(row=>`<tr><td><strong>${esc(row.codigo)}</strong><small>${esc(row.producto)}</small></td><td class="number">${number(row.cantidad_planificada)}</td><td>${orderStatus(row)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('Sin órdenes pendientes','Las nuevas órdenes aparecerán aquí.')}</section>`+
    `<section class="card"><div class="card-header"><h3>Últimos movimientos de materiales</h3><a class="muted" href="#kardex">Ver Kardex →</a></div><div class="card-body">${activity.items.length?activity.items.slice(0,5).map(row=>`<div class="activity-row"><div><strong>${esc(row.tipo)}</strong><small>${esc(row.movimiento)} · ${formatDate(row.fecha)}</small></div><span class="badge">${row.entrada?'+':'−'}${number(row.entrada||row.salida)} ${esc(row.unidad)}</span></div>`).join(''):emptyState('Aún no hay movimientos','Registra una entrada para iniciar la trazabilidad.')}</div></section>`+
    `<section class="card"><div class="card-header"><h3>Tu flujo de trabajo</h3></div><div class="card-body"><ol class="steps"><li><strong>Abastece el almacén.</strong> Registra materiales, proveedores y entradas.</li><li><strong>Controla la producción.</strong> Registra el consumo en movimientos y completa las órdenes.</li><li><strong>Despacha con control.</strong> Selecciona un cliente y envía los productos disponibles.</li><li><strong>Verifica existencias.</strong> Revisa el Kardex y realiza recuentos físicos.</li></ol></div></section></div>`;
}
function filters(cfg) {
  return `<div class="filterbar"><div class="search-field">${icon('search')}<input id="tableSearch" type="search" placeholder="Buscar ${esc(cfg.title.toLowerCase())}…" aria-label="Buscar registros"></div>${cfg.dates?'<label>Desde <input id="filterFrom" type="date"></label><label>Hasta <input id="filterTo" type="date"></label>':''}${state.scope==='materiales'?'<select id="stockFilter" aria-label="Filtrar estado de stock"><option value="">Todos los estados</option><option value="CRITICO">Stock crítico</option><option value="BAJO">Bajo mínimo</option><option value="OK">Disponible</option><option value="ARCHIVED">Archivados</option></select>':''}<button class="icon-button" data-action="reload" aria-label="Actualizar tabla" title="Actualizar">${icon('history')}</button></div>`;
}
async function tablePage(cfg,sequence) {
  const response=await api(cfg.endpoint);
  if(sequence!==state.sequence)return;
  state.rows=response.items||[];
  const buttons=`${cfg.exports?'<button class="btn" data-action="excel">'+icon('download')+'Excel</button><button class="btn" data-action="pdf">PDF</button>':''}${writable()&&!cfg.readOnly?`<button class="btn primary" data-action="new">${icon('plus')}${esc(cfg.newLabel)}</button>`:''}`;
  $('#content').innerHTML=heading(cfg.title,cfg.description,buttons)+`${!writable()&&!cfg.readOnly?'<div class="notice">Tu cuenta de operario permite consultar y exportar información.</div>':''}${state.scope==='productos'?'<div class="history-switch"><button class="btn small" data-action="currentProducts">Existencias</button><button class="btn small" data-action="productHistory">Historial de movimientos</button></div>':''}<section class="card">${filters(cfg)}<div class="table-scroll" id="tableContainer"></div><div id="tableFooter" class="table-footer"></div></section>`;
  renderRows();
  let filterTimer;
  const update=()=>{state.page=1;renderRows();clearTimeout(filterTimer);filterTimer=setTimeout(()=>{if(sequence===state.sequence)reloadTable().catch(error=>toast(error.message,true));},300);};
  $('#tableSearch').addEventListener('input',event=>{state.query=event.target.value;update();});
  ['filterFrom','filterTo','stockFilter'].forEach(id=>{const input=$(`#${id}`);if(input) input.addEventListener('change',()=>{state[{filterFrom:'from',filterTo:'to',stockFilter:'stockFilter'}[id]]=input.value;if(state.from&&state.to&&state.from>state.to){toast('La fecha inicial debe ser anterior a la final.',true);return;}update();});});
}
const historyColumns=columns(['fecha','Fecha',r=>formatDate(r.fecha)],['producto','Producto',productCell],['movimiento','Movimiento',r=>badge(r.movimiento)],['entrada','Entrada',r=>number(r.entrada),true],['salida','Salida',r=>number(r.salida),true],['saldo','Saldo',r=>number(r.saldo),true],['cliente','Cliente'],['referencia','Referencia']);
function filteredRows() {
  const q=state.query.trim().toLocaleLowerCase('es');
  return state.rows.filter(row=>{
    const matches=!q||Object.values(row).some(value=>String(value??'').toLocaleLowerCase('es').includes(q));
    const created=row.created_at?new Date(/^\d{4}-\d{2}-\d{2} /.test(row.created_at)?row.created_at.replace(' ','T')+'Z':row.created_at):null;
    const date=row.fecha?String(row.fecha).slice(0,10):created&&!Number.isNaN(created.getTime())?dateOnly(created):'';
    return matches&&(!state.from||date>=state.from)&&(!state.to||date<=state.to)&&(!state.stockFilter||row.estado_stock===state.stockFilter);
  });
}
function rowActions(row,cfg) {
  if(!writable()||cfg.readOnly||state.view==='history')return '';
  let result='';
  const button=(action,title,i)=>`<button class="icon-button" data-action="${action}" data-id="${row.id}" title="${esc(title)}" aria-label="${esc(title)}">${icon(i)}</button>`;
  if(state.scope==='materiales'&&row.estado_stock==='ARCHIVED')return supervisor()?`<div class="row-actions">${button('reactivate','Reactivar material','history')}</div>`:'';
  if(state.scope==='materiales'){result+=button('entry','Registrar entrada','plus')+button('exit','Registrar salida','move');}
  if(state.scope==='ordenes'&&['Pendiente','En proceso'].includes(row.estado))result+=button('complete','Completar orden y registrar producción','check');
  if(state.scope==='productos')result+=button('addProduction','Añadir producción','plus');
  const locked=(state.scope==='usuarios'&&row.is_protected)||(state.scope==='defectuosos'&&row.stock_descontado)||(state.scope==='ordenes'&&row.estado==='Completada');
  if(!cfg.noEdit&&!locked)result+=button('edit','Editar registro','edit');
  if(state.scope==='usuarios'&&supervisor())result+=button('resetPassword','Cambiar contraseña','lock');
  if((cfg.deletable&&!locked&&(state.scope!=='usuarios'||supervisor())&&(!['clientes','proveedores'].includes(state.scope)||supervisor()))||(state.scope==='materiales'&&supervisor()))result+=button('delete',state.scope==='materiales'?'Archivar material':'Eliminar registro','trash');
  return result?`<div class="row-actions">${result}</div>`:'';
}
function renderRows() {
  const cfg=configs[state.scope];const rows=filteredRows();const cols=state.view==='history'?historyColumns:cfg.columns;
  if(state.sortKey)rows.sort((a,b)=>{const av=a[state.sortKey],bv=b[state.sortKey];return (typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''),'es',{numeric:true}))*state.sortDirection;});
  const total=Math.max(1,Math.ceil(rows.length/state.size));state.page=Math.min(total,Math.max(1,state.page));
  const slice=rows.slice((state.page-1)*state.size,state.page*state.size);
  const hasActions=writable()&&!cfg.readOnly&&state.view!=='history'&&!(cfg.noEdit&&state.scope!=='materiales');
  $('#tableContainer').innerHTML=slice.length?`<table><thead><tr>${cols.map(col=>`<th${col.numeric?' class="number"':''}><button class="sort-button" data-action="sort" data-key="${col.key}" aria-label="Ordenar por ${esc(col.label)}">${esc(col.label)}${state.sortKey===col.key?(state.sortDirection===1?' ↑':' ↓'):''}</button></th>`).join('')}${hasActions?'<th class="number">Acciones</th>':''}</tr></thead><tbody>${slice.map(row=>`<tr>${cols.map(col=>`<td${col.numeric?' class="number"':''}>${col.render?col.render(row):esc(row[col.key]||'—')}</td>`).join('')}${hasActions?`<td>${rowActions(row,cfg)}</td>`:''}</tr>`).join('')}</tbody></table>`:emptyState(state.rows.length?'Sin coincidencias':'Aún no hay registros',state.rows.length?'Prueba con otra búsqueda o elimina los filtros.':cfg.empty,state.rows.length?'<button class="btn small" data-action="clearFilters">Limpiar filtros</button>':'');
  const limit=state.view==='history'?1000:cfg.limit;
  $('#tableFooter').innerHTML=`<span>${number(rows.length)} registro${rows.length===1?'':'s'}${limit&&state.rows.length>=limit?` · Se muestran los últimos ${limit}. Consulta por fechas para ver otros registros.`:''}</span><div class="pagination"><button class="btn" data-action="prev" ${state.page===1?'disabled':''}>← Anterior</button><span>${state.page} / ${total}</span><button class="btn" data-action="next" ${state.page===total?'disabled':''}>Siguiente →</button></div>`;
}
async function loadOptions() {
  const [materials,products,suppliers,clients]=await Promise.all([api('/api/pro/materiales'),api('/api/pro/productos-terminados'),api('/api/pro/proveedores'),api('/api/pro/clientes')]);
  state.options={materiales:materials.items,productos:products.items,proveedores:suppliers.items,clientes:clients.items};
  $('#materialSuggestions').innerHTML=materials.items.map(row=>`<option value="${esc(row.tipo)}">${esc(row.codigo_barra||'')} · ${number(row.stock_actual)} ${esc(row.unidad)}</option>`).join('');
  $('#productSuggestions').innerHTML=products.items.map(row=>`<option value="${esc(row.producto)}">${esc(row.codigo_barra||'')} · ${number(row.stock)} ${esc(row.unidad)}</option>`).join('');
}
function fieldHTML(spec,values={},editing=false) {
  const name=spec.name;const value=values[name]??(typeof spec.default==='function'?spec.default():spec.default??'');
  const id=`field-${name}`;
  const attributes=`id="${id}" name="${name}" ${spec.required?'required':''} ${spec.readonly?'readonly':''} ${spec.min!=null?`min="${spec.min}"`:''} ${spec.step!=null?`step="${spec.step}"`:''} ${spec.max?`maxlength="${spec.max}"`:''} ${spec.minlength?`minlength="${spec.minlength}"`:''} ${spec.list?`list="${spec.list}"`:''} ${spec.pattern?`pattern="${spec.pattern}"`:''}`;
  if(spec.type==='checkbox')return `<div class="field full checkbox-field"><input type="checkbox" ${attributes} value="1" ${value?'checked':''}><label for="${id}">${esc(spec.label)}${spec.help?`<small>${esc(spec.help)}</small>`:''}</label></div>`;
  let input;
  if(spec.type==='select') {
    let choices=spec.source?(state.options[spec.source]||[]).map(row=>[row.id,row.nombre]):(spec.options||[]).map(option=>Array.isArray(option)?option:[option,option]);
    if(name==='unidad'&&value&&!choices.some(([key])=>String(key)===String(value)))choices=[...choices,[value,value]];
    input=`<select ${attributes}>${!spec.required||spec.source?'<option value="">Seleccionar…</option>':''}${choices.map(([key,label])=>`<option value="${esc(key)}" ${String(value)===String(key)?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
  } else if(spec.type==='textarea')input=`<textarea ${attributes}>${esc(value)}</textarea>`;
  else input=`<input type="${spec.type}" ${attributes} value="${esc(spec.type==='datetime-local'?String(value).slice(0,16):value)}" ${spec.type==='password'?'autocomplete="new-password"':'autocomplete="off"'}>`;
  return `<div class="field${spec.full?' full':''}"><label for="${id}">${esc(spec.label)}${spec.required?' <span class="muted">*</span>':''}</label>${input}${spec.help?`<small>${esc(spec.help)}</small>`:''}</div>`;
}
async function openForm(row=null,mode='default') {
  const scope=state.scope,cfg=configs[scope];
  await loadOptions();if(scope!==state.scope)return;
  let specs=cfg.fields;let endpoint=cfg.createEndpoint||cfg.endpoint;let method=row?'PUT':'POST';let title=row?'Editar registro':cfg.newLabel;
  let values=row?{...row}:{};
  if(row) {endpoint=cfg.endpoint+'/'+row.id;specs=specs.filter(spec=>!spec.createOnly);}
  if(mode==='addProduction'){method='POST';endpoint=cfg.endpoint;specs=cfg.fields.map(spec=>spec.name==='producto'?{...spec,readonly:true}:spec);values={...row,cantidad:1,fecha:dateTime()};title='Añadir producción';}
  if(mode==='resetPassword'){method='PATCH';endpoint=cfg.endpoint+'/'+row.id+'/password';specs=[field('password','Nueva contraseña','password',{required:true,minlength:12,max:72,full:true,help:'Mínimo 12 caracteres. Comunica la nueva clave al usuario.'})];title=`Contraseña de ${row.username}`;values={};}
  if(state.scope==='ordenes'&&row&&mode==='default') values.cantidad_producida=row.cantidad_producida;
  state.editing={cfg,endpoint,method,row,mode,scope:state.scope};
  $('#dialogTitle').textContent=title;$('#dialogEyebrow').textContent=cfg.title.toUpperCase();$('#formFields').innerHTML=specs.map(spec=>fieldHTML(spec,values,Boolean(row))).join('');$('#formMessage').textContent='';
  $('#saveRecord').textContent=mode==='addProduction'?'Registrar producción':'Guardar registro';
  $('#formDialog').showModal();
  if(scope==='defectuosos') {const input=$('#recordForm [name=tipo]');input.addEventListener('change',()=>{const item=state.options.materiales.find(row=>row.tipo.toLowerCase()===input.value.trim().toLowerCase());if(item){const select=$('#recordForm [name=unidad]');if(![...select.options].some(option=>option.value===item.unidad)){const option=new Option(item.unidad,item.unidad);select.add(option);}select.value=item.unidad;}});}
}
$('#recordForm').addEventListener('submit',async event=>{
  event.preventDefault();const context=state.editing;if(!context)return;
  const values=Object.fromEntries(new FormData(event.target));
  if(context.scope==='ordenes'&&context.row)values.cantidad_producida=context.row.cantidad_producida;
  if(Number(values.stock_crit||0)>Number(values.stock_min||0)&&context.scope==='materiales'){$('#formMessage').textContent='El stock crítico no puede superar el stock mínimo.';return;}
  if(values.aplicar_ajuste==='1'&&!await confirmAction('Se reemplazará el stock actual por el recuento físico. La diferencia quedará registrada.','Aplicar recuento','Aplicar ajuste'))return;
  const button=$('#saveRecord');button.disabled=true;$('#formMessage').textContent='';
  try{await api(context.endpoint,{method:context.method,body:values});$('#formDialog').close();toast('Registro guardado correctamente.');await route();}
  catch(error){$('#formMessage').textContent=error.message;}
  finally{button.disabled=false;}
});
async function movementPage(sequence,selected={},mode='entrada') {
  await loadOptions();if(sequence!==state.sequence)return;
  const formFields=[field('codigo_barra','Material o código de barras','text',{required:true,list:'materialSuggestions',full:true}),qty('cantidad',mode==='ajuste'?'Nueva cantidad total':'Cantidad',{required:true,min:mode==='ajuste'?0:1,default:1}),field('fecha','Fecha del movimiento','datetime-local',{default:dateTime,required:true}),field('observacion','Referencia u observación','textarea',{full:true,required:mode==='ajuste'})];
  $('#content').innerHTML=heading('Movimientos de almacén','Registra entradas, consumos o ajustes. Escanea el código o elige el nombre completo del material.')+
    `${!writable()?'<div class="notice">Tu cuenta permite consultar el catálogo y el Kardex. Para registrar movimientos, contacta al administrador.</div>':''}<div class="operation-layout"><section class="card"><div class="card-body"><div class="form-tabs">${[['entrada','Entrada'],['salida','Salida / consumo'],['ajuste','Ajuste de stock']].map(([value,label])=>`<button class="btn ${mode===value?'active':''}" data-action="movementMode" data-mode="${value}">${label}</button>`).join('')}</div><form id="movementForm" class="operation-form"><input type="hidden" name="accion" value="${mode}"><div class="form-grid">${formFields.map(spec=>fieldHTML(spec,selected)).join('')}</div><div id="lookupPreview" class="lookup-preview">Selecciona un material para ver su stock y unidad.</div><p class="form-message" id="movementMessage" role="alert"></p><button class="btn primary" type="submit" ${!writable()?'disabled':''}>${icon('check')}${mode==='ajuste'?'Confirmar ajuste':mode==='salida'?'Registrar salida':'Registrar entrada'}</button></form></div></section><section class="card"><div class="card-body"><h3>Un movimiento claro, un saldo confiable.</h3><ol class="steps"><li><strong>Selecciona el material.</strong> Puedes usar un lector de códigos de barras conectado como teclado.</li><li><strong>Revisa la cantidad.</strong> Las entradas suman; las salidas descuentan. El ajuste establece una nueva cantidad total.</li><li><strong>Confirma el registro.</strong> El stock se actualiza y el movimiento queda en el Kardex.</li></ol><div class="notice">Los lectores con Enter seleccionan el material. Confirma la cantidad antes de guardar.</div><a class="btn" href="#kardex">${icon('history')}Consultar Kardex</a></div></section></div>`;
  const input=$('#movementForm [name=codigo_barra]');
  const preview=()=>{const q=input.value.trim().toLowerCase();const material=state.options.materiales.find(row=>row.tipo.toLowerCase()===q||String(row.codigo_barra||'').toLowerCase()===q);$('#lookupPreview').innerHTML=material?`<strong>${esc(material.tipo)}</strong>Stock disponible: ${number(material.stock_actual)} ${esc(material.unidad)} · ${esc(material.ubicacion||'Sin ubicación')}`:'Selecciona un material del catálogo o escanea el código completo.';};
  input.addEventListener('input',preview);preview();
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();preview();$('#movementForm [name=cantidad]').focus();}});
  $('#movementForm').addEventListener('submit',async event=>{
    event.preventDefault();const values=Object.fromEntries(new FormData(event.target));
    if(values.accion==='ajuste'&&!await confirmAction(`El stock se establecerá en ${values.cantidad}. Esta cantidad reemplaza el saldo actual.`, 'Ajustar stock','Confirmar ajuste'))return;
    const button=event.target.querySelector('[type=submit]');button.disabled=true;$('#movementMessage').textContent='';
    try{const result=await api('/api/pro/movimiento',{method:'POST',body:values});toast(`${result.material}: stock actualizado a ${number(result.stock_actual)}.`);await movementPage(state.sequence,{},values.accion);$('#movementForm [name=codigo_barra]').focus();}
    catch(error){$('#movementMessage').textContent=error.code==='stock-insuficiente'?`${error.message} Disponible: ${number(error.payload.stock)}.`:error.message;button.disabled=false;}
  });
}
async function download(url,filename) {
  const response=await fetch(url);
  if(!response.ok)throw new Error('No se pudo descargar el archivo. Revisa tu sesión.');
  const blob=await response.blob();const objectUrl=URL.createObjectURL(blob);const link=document.createElement('a');link.href=objectUrl;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),15000);
}
function backupPage() {
  $('#content').innerHTML=heading('Copias de seguridad','Descarga una copia completa o restaura una base de datos de BRUMAP.', '', 'ADMINISTRACIÓN')+
    '<div class="backup-grid"><section class="card"><div class="card-body">'+icon('download')+'<h3>Descargar copia</h3><p>Guarda una copia consistente de todos los registros y usuarios, incluso mientras el sistema está en uso.</p><button class="btn primary" id="downloadBackup">Descargar base de datos</button></div></section><section class="card"><div class="card-body">'+icon('backup')+'<h3>Restaurar copia</h3><p>Reemplaza la base actual. Se conserva una copia previa en el servidor y todos los usuarios deberán iniciar sesión nuevamente.</p><label for="backupFile">Archivo de respaldo (.db, máximo 50 MB)</label><input type="file" id="backupFile" accept=".db,.sqlite,.sqlite3"><button class="btn danger" id="restoreBackup">Restaurar base de datos</button><p class="form-message" id="backupMessage" role="alert"></p></div></section></div>';
  $('#downloadBackup').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await download('/api/backup/download',`brumap-${dateOnly()}.db`);toast('Copia de seguridad descargada.');}catch(error){toast(error.message,true);}finally{button.disabled=false;}};
  $('#restoreBackup').onclick=async event=>{
    const button=event.currentTarget;const file=$('#backupFile').files[0];$('#backupMessage').textContent='';
    if(!file){$('#backupMessage').textContent='Selecciona un archivo de respaldo.';return;}
    if(file.size>50*1024*1024){$('#backupMessage').textContent='El tamaño máximo es 50 MB.';return;}
    if(!await confirmAction(`Se reemplazarán todos los registros y usuarios por el contenido de ${file.name}. Se conserva una copia de la base actual en el servidor.`, 'Restaurar base de datos','Restaurar'))return;
    button.disabled=true;
    try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await api('/api/backup/restore',{method:'POST',body:{fileBase64:base64,filename:file.name}});location.replace('/');}
    catch(error){$('#backupMessage').textContent=error.message;button.disabled=false;}
  };
}
function accountPage() {
  const specs=[field('current_password','Contraseña actual','password',{required:true,full:true}),field('password','Nueva contraseña','password',{required:true,minlength:12,max:72,full:true,help:'Usa al menos 12 caracteres.'}),field('password_confirmation','Repetir nueva contraseña','password',{required:true,full:true})];
  $('#content').innerHTML=heading('Mi cuenta','Actualiza tu contraseña de acceso.','','PREFERENCIAS')+`<section class="card account-card"><div class="card-body"><div class="account-details"><span class="avatar">${esc(state.user.username[0].toUpperCase())}</span><div><strong>${esc(state.user.username)}</strong><div class="muted">${esc(state.user.role)}</div></div></div><form id="passwordForm"><div class="form-grid">${specs.map(spec=>fieldHTML(spec)).join('')}</div><p class="form-message" id="passwordMessage" role="alert"></p><div class="dialog-actions"><button class="btn primary" type="submit">Actualizar contraseña</button></div></form></div></section>`;
  $('#passwordForm [name=current_password]').autocomplete='current-password';
  $('#passwordForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));if(values.password!==values.password_confirmation){$('#passwordMessage').textContent='Las contraseñas nuevas no coinciden.';return;}const button=event.target.querySelector('button');button.disabled=true;try{await api('/api/auth/password',{method:'PATCH',body:values});event.target.reset();$('#passwordMessage').textContent='';toast('Contraseña actualizada.');}catch(error){$('#passwordMessage').textContent=error.message;}finally{button.disabled=false;}};
}
async function handleAction(event) {
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;const cfg=configs[state.scope];const row=state.rows.find(item=>Number(item.id)===Number(target.dataset.id));
  try {
    if(action==='restart'){location.reload();return;}
    if(action==='sort'){state.sortDirection=state.sortKey===target.dataset.key?-state.sortDirection:1;state.sortKey=target.dataset.key;renderRows();return;}
    if(action==='refresh'){await route();return;}
    if(action==='new'){await openForm();return;}
    if(action==='edit'){await openForm(row);return;}
    if(action==='addProduction'||action==='resetPassword'){await openForm(row,action);return;}
    if(action==='prev'||action==='next'){state.page+=action==='next'?1:-1;renderRows();return;}
    if(action==='clearFilters'){state.query=state.from=state.to=state.stockFilter='';$('#tableSearch').value='';['filterFrom','filterTo','stockFilter'].forEach(id=>{if($(`#${id}`))$(`#${id}`).value='';});state.page=1;await reloadTable();return;}
    if(action==='reload'){await reloadTable();return;}
    if(action==='entry'||action==='exit'){state.pendingMovement={tipo:row.tipo,mode:action==='entry'?'entrada':'salida'};location.hash='movimientos';return;}
    if(action==='movementMode'){await movementPage(state.sequence,{},target.dataset.mode);return;}
    if(action==='complete'){
      if(!await confirmAction(`La orden ${row.codigo} se completará. Se sumarán ${number(row.cantidad_planificada-row.cantidad_producida)} unidades de ${row.producto} a productos terminados. Registra los consumos de materiales en Movimientos.`, 'Completar producción','Completar orden'))return;
      target.disabled=true;await api(cfg.endpoint+'/'+row.id+'/completar',{method:'POST',body:{}});toast('Orden completada y producción registrada.');await reloadTable();return;
    }
    if(action==='reactivate'){target.disabled=true;await api(cfg.endpoint+'/'+row.id+'/activar',{method:'PATCH'});toast('Material reactivado.');await reloadTable();return;}
    if(action==='delete'){
      const archive=state.scope==='materiales';
      if(!await confirmAction(archive?'El material se ocultará del catálogo. Su historial se conserva y el stock debe ser cero.':'Se eliminará este registro. Los contactos con operaciones asociadas se conservan.',archive?'Archivar material':'Eliminar registro',archive?'Archivar':'Eliminar'))return;
      target.disabled=true;await api(cfg.endpoint+'/'+row.id,{method:'DELETE'});toast(archive?'Material archivado.':'Registro eliminado.');await reloadTable();return;
    }
    if(action==='excel'||action==='pdf'){
      const scopes={materiales:'materiales',productos:'productos-terminados',envios:'envios-terminados',kardex:'kardex'};
      const base=state.scope==='productos'&&state.view==='history'?'/api/pro/productos-terminados-movimientos':scopes[state.scope]?'/api/pro/'+scopes[state.scope]:cfg.endpoint;
      const query=new URLSearchParams();if(state.query)query.set('q',state.query);if(state.from)query.set('from',state.from);if(state.to)query.set('to',state.to);if(state.stockFilter)query.set('stock',state.stockFilter);
      target.disabled=true;await download(`${base}.${action==='excel'?'xlsx':'pdf'}?${query}`,`${state.scope}-${dateOnly()}.${action==='excel'?'xlsx':'pdf'}`);target.disabled=false;return;
    }
    if(action==='productHistory'||action==='currentProducts'){
      const history=action==='productHistory';const result=await api(history?'/api/pro/productos-terminados-movimientos':cfg.endpoint);state.rows=result.items;state.view=history?'history':'current';state.page=1;renderRows();return;
    }
  } catch(error){target.disabled=false;toast(error.message,true);}
}
async function reloadTable() {
  const cfg=configs[state.scope];if(!cfg)return;const sequence=state.sequence,request=++state.request;const query=new URLSearchParams();if(state.query)query.set('q',state.query);if(state.from)query.set('from',state.from);if(state.to)query.set('to',state.to);if(state.stockFilter)query.set('stock',state.stockFilter);
  const endpoint=state.view==='history'?'/api/pro/productos-terminados-movimientos':cfg.endpoint;
  const result=await api(`${endpoint}?${query}`);if(sequence!==state.sequence||request!==state.request)return;state.rows=result.items||[];renderRows();
  $('#lastUpdate').textContent=`Actualizado ${new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}`;
}
function closeMenu(){$('#sidebar').classList.remove('is-open');$('#menuOverlay').hidden=true;$('#menuToggle').setAttribute('aria-expanded','false');}
function setTheme(theme){document.documentElement.dataset.theme=theme;$('#themeToggle').innerHTML=icon(theme==='dark'?'sun':'moon');$('#themeToggle').setAttribute('aria-label',theme==='dark'?'Activar tema claro':'Activar tema oscuro');try{localStorage.setItem('brumap_theme',theme);}catch{}}
$('#themeToggle').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('#menuToggle').onclick=()=>{const open=!$('#sidebar').classList.contains('is-open');$('#sidebar').classList.toggle('is-open',open);$('#menuOverlay').hidden=!open;$('#menuToggle').setAttribute('aria-expanded',String(open));};
$('#menuOverlay').onclick=closeMenu;
$('#closeDialog').onclick=$('#cancelDialog').onclick=()=>$('#formDialog').close();
$('#content').addEventListener('click',handleAction);
$('#logoutButton').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await api('/api/auth/logout',{method:'POST'});location.replace('/');}catch(error){toast(error.message,true);button.disabled=false;}};
window.addEventListener('hashchange',()=>{if(state.user)route();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
(async()=>{
  let theme='light';try{theme=localStorage.getItem('brumap_theme')==='dark'?'dark':'light';}catch{}setTheme(theme);
  try{const result=await api('/me');if(!result.user){location.replace('/');return;}state.user=result.user;$('#userName').textContent=state.user.username;$('#userAvatar').textContent=state.user.username[0].toUpperCase();renderNavigation();await route();}
  catch(error){$('#content').innerHTML=emptyState('No se pudo iniciar el panel',error.message,'<button class="btn" data-action="restart">Reintentar</button>');}
})();
