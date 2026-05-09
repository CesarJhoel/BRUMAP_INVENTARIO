async function api(url, opt = {}) {
  opt.headers = opt.headers || {};
  if (opt.body && typeof opt.body !== 'string') {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(opt.body);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((opt.method || 'GET').toUpperCase())) {
    try {
      if (!window.__CSRF) {
        window.__CSRF = (await fetch('/csrf').then(r => r.json())).token;
      }
      opt.headers['x-csrf-token'] = window.__CSRF || '';
    } catch {}
  }
  const r = await fetch(url, opt);
  if (!r.ok) {
    let msg;
    try { msg = await r.json(); } catch { msg = { error: await r.text() }; }
    const err = new Error(msg && msg.error ? msg.error : (r.status + ''));
    err.status = r.status;
    err.payload = msg;
    throw err;
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return r.json();
  return r.text();
}

// Formato de fecha para la tabla (DD-MM-YYYY [HH:MM])
function formatDateForTable(value, withTime = false) {
  if (!value) return '';
  const raw = String(value || '').trim();
  // Las fechas puras de planificación (YYYY-MM-DD) no deben moverse por zona horaria.
  if (!withTime && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    return `${d}-${m}-${y}`;
  }

  // SQLite suele guardar UTC como 'YYYY-MM-DD HH:MM:SS'
  const parseSqliteTsUTC = (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
        return new Date(s.replace(' ', 'T') + 'Z'); // interpretar como UTC
      }
    }
    return new Date(v);
  };

  const d = parseSqliteTsUTC(value);
  if (isNaN(d.getTime())) return String(value);

  const tz = 'America/Lima';
  const optsDate = { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' };
  const optsDateTime = { ...optsDate, hour: '2-digit', minute: '2-digit', hour12: false };

  const fmt = new Intl.DateTimeFormat('es-PE', withTime ? optsDateTime : optsDate);
  const parts = fmt.formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  const dd = parts.day || '';
  const mm = parts.month || '';
  const yy = parts.year || '';
  if (withTime) {
    const hh = parts.hour || '00';
    const mi = parts.minute || '00';
    return `${dd}-${mm}-${yy} ${hh}:${mi}`;
  }
  return `${dd}-${mm}-${yy}`;
}


// Estado global para saber si estamos editando algo
window.__editing = { scope: null, id: null };

// Filtros por rango de fechas (YYYY-MM-DD) por módulo
window.__filters = window.__filters || {
  recepciones: { from: '', to: '', q: '', min: '', max: '' },
  produccion: { from: '', to: '', q: '', min: '', max: '' },
  defectuosos: { from: '', to: '', q: '', min: '', max: '' },
  envios: { from: '', to: '', q: '', min: '', max: '' },
  stock: { from: '', to: '', q: '', min: '', max: '' },
  stock_retiros: { from: '', to: '', q: '', min: '', max: '' },
  maquinaria: { from: '', to: '', q: '', min: '', max: '' },
  repuestos: { from: '', to: '', q: '', min: '', max: '' },
  users: { from: '', to: '', q: '', min: '', max: '' },
  event_logs: { from: '', to: '', q: '', min: '', max: '' }
};

// Ordenamiento por módulo
//  - date_*: por fecha de creación/registro (según módulo)
//  - alpha_*: por campo principal (según módulo)
window.__sort = window.__sort || {
  recepciones: 'date_desc',
  produccion: 'date_desc',
  defectuosos: 'date_desc',
  envios: 'date_desc',
  stock: 'date_desc',
  stock_retiros: 'date_desc',
  maquinaria: 'date_desc',
  repuestos: 'date_desc',
  users: 'alpha_asc',
  event_logs: 'date_desc',
  recep_hist: 'date_desc'
};


// Paginación por módulo (por defecto: 20 filas)
window.__pager = window.__pager || {};
const DEFAULT_PAGE_SIZE = 20;

function getPager(scope) {
  if (!window.__pager[scope]) {
    window.__pager[scope] = { page: 1, pageSize: DEFAULT_PAGE_SIZE };
  }
  return window.__pager[scope];
}

function resetPager(scope) {
  const p = getPager(scope);
  p.page = 1;
}

function ensurePagerEl(scope, afterEl) {
  let el = document.querySelector(`[data-pager="${scope}"]`);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'pager';
  el.dataset.pager = scope;
  // insertar después del elemento de referencia
  if (afterEl && afterEl.parentNode) {
    afterEl.parentNode.insertBefore(el, afterEl.nextSibling);
  }
  return el;
}

function renderPager(scope, totalItems, afterEl, onChange) {
  const p = getPager(scope);
  const totalPages = Math.max(1, Math.ceil(totalItems / p.pageSize));
  if (p.page > totalPages) p.page = totalPages;
  if (p.page < 1) p.page = 1;

  const el = ensurePagerEl(scope, afterEl);
  el.innerHTML = '';
  el.style.display = totalItems > p.pageSize ? 'flex' : 'none';
  if (el.style.display === 'none') return;

  const btnPrev = document.createElement('button');
  btnPrev.type = 'button';
  btnPrev.className = 'pager-btn';
  btnPrev.textContent = 'Anterior';
  btnPrev.disabled = p.page <= 1;

  const btnNext = document.createElement('button');
  btnNext.type = 'button';
  btnNext.className = 'pager-btn';
  btnNext.textContent = 'Siguiente';
  btnNext.disabled = p.page >= totalPages;

  const label = document.createElement('div');
  label.className = 'pager-label';
  label.textContent = `Página ${p.page} de ${totalPages}  (Total: ${totalItems})`;

  btnPrev.addEventListener('click', () => {
    if (p.page > 1) {
      p.page -= 1;
      onChange && onChange();
    }
  });
  btnNext.addEventListener('click', () => {
    if (p.page < totalPages) {
      p.page += 1;
      onChange && onChange();
    }
  });

  el.appendChild(btnPrev);
  el.appendChild(label);
  el.appendChild(btnNext);
}

function slicePage(scope, items) {
  const p = getPager(scope);
  const start = (p.page - 1) * p.pageSize;
  const end = start + p.pageSize;
  return items.slice(start, end);
}

function buildFilterQuery(scope) {
  const f = (window.__filters && window.__filters[scope]) || { from: '', to: '', q: '', min: '', max: '' };
  const qs = new URLSearchParams();
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  if (f.q) qs.set('q', f.q);
  if (f.min !== undefined && f.min !== null && String(f.min).trim() !== '') qs.set('min', String(f.min).trim());
  if (f.max !== undefined && f.max !== null && String(f.max).trim() !== '') qs.set('max', String(f.max).trim());
  const s = qs.toString();
  return s ? `?${s}` : '';
}


// -----------------------------------------------------------------------------
// Helpers: ordenamiento y filtrado (tablas)
// -----------------------------------------------------------------------------
function parseDateLoose(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return 0;
  // SQLite UTC: 'YYYY-MM-DD HH:MM:SS'
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function limaDateKey(v) {
  if (!v) return '';
  const s = String(v).trim();
  // Si el dato ya viene como fecha (YYYY-MM-DD), úsala tal cual para evitar desplazamientos por zona horaria.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const t = parseDateLoose(s);
  if (!t) return '';
  const d = new Date(t);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(d); // YYYY-MM-DD
}

function getSortMode(scope) {
  return (window.__sort && window.__sort[scope]) ? window.__sort[scope] : 'date_desc';
}

function sortItems(scope, items, meta) {
  const mode = getSortMode(scope);
  const dateField = (meta && meta.dateField) ? meta.dateField : 'created_at';
  const alphaField = (meta && meta.alphaField) ? meta.alphaField : 'tipo';
  const dir = mode.endsWith('_asc') ? 1 : -1;
  const arr = items.slice();

  if (mode.startsWith('date_')) {
    arr.sort((a, b) => {
      const av = parseDateLoose(a[dateField] || a.created_at || a.updated_at || a.fecha || a.ts || a.id);
      const bv = parseDateLoose(b[dateField] || b.created_at || b.updated_at || b.fecha || b.ts || b.id);
      return (av - bv) * dir;
    });
    return arr;
  }

  if (mode.startsWith('alpha_')) {
    arr.sort((a, b) => {
      const av = String(a[alphaField] || '').toLowerCase();
      const bv = String(b[alphaField] || '').toLowerCase();
      const c = av.localeCompare(bv, 'es', { sensitivity: 'base' });
      if (c !== 0) return c * dir;
      const at = parseDateLoose(a[dateField] || a.created_at || a.updated_at || a.fecha || a.ts || a.id);
      const bt = parseDateLoose(b[dateField] || b.created_at || b.updated_at || b.fecha || b.ts || b.id);
      return bt - at;
    });
    return arr;
  }
  return arr;
}


// -----------------------------------------------------------------------------
// Unidades: permitir "Agregar unidad..." en todos los select de unidad
//  - Se guarda en localStorage y se replica entre formularios.
// -----------------------------------------------------------------------------
const CUSTOM_UNITS_KEY = 'brumap_custom_units_v1';
const ADD_UNIT_VALUE = '__add_unit__';

function loadCustomUnits() {
  try {
    const raw = localStorage.getItem(CUSTOM_UNITS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function saveCustomUnits(units) {
  try {
    localStorage.setItem(CUSTOM_UNITS_KEY, JSON.stringify(units || []));
  } catch {}
}

function sanitizeUnit(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  // límite coherente con backend (16 chars)
  return s.slice(0, 16);
}

function ensureOption(select, value, label) {
  if (!select) return;
  const exists = Array.from(select.options || []).some(o => String(o.value) === String(value));
  if (exists) return;
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label != null ? String(label) : String(value);
  select.appendChild(opt);
}

function upsertCustomUnitOptions() {
  const custom = loadCustomUnits();
  document.querySelectorAll('select[name="unidad"]').forEach(sel => {
    // Insertar unidades personalizadas (si no existen)
    custom.forEach(u => {
      const v = sanitizeUnit(u);
      if (!v) return;
      const exists = Array.from(sel.options || []).some(o => String(o.value) === v);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        // Insertar antes de "Agregar unidad..." si existe, si no al final.
        const addOpt = Array.from(sel.options || []).find(o => String(o.value) === ADD_UNIT_VALUE);
        if (addOpt && addOpt.parentNode) sel.insertBefore(opt, addOpt);
        else sel.appendChild(opt);
      }
    });

    // Opción para agregar unidad
    ensureOption(sel, ADD_UNIT_VALUE, 'Agregar unidad...');
  });
}

function initUnitSelectors() {
  // Asegurar opciones de unidades personalizadas al cargar
  upsertCustomUnitOptions();

  document.querySelectorAll('select[name="unidad"]').forEach(sel => {
    let last = sel.value;

    sel.addEventListener('focus', () => {
      last = sel.value;
    });

    sel.addEventListener('change', () => {
      const v = String(sel.value || '');
      if (v !== ADD_UNIT_VALUE) {
        last = v;
        return;
      }

      const raw = prompt('Escribe la unidad (máx. 16 caracteres):');
      const unit = sanitizeUnit(raw);
      if (!unit) {
        sel.value = last || '';
        return;
      }

      const custom = loadCustomUnits();
      if (!custom.some(x => sanitizeUnit(x) === unit)) {
        custom.push(unit);
        saveCustomUnits(custom);
      }

      // Refrescar opciones en todos los selects
      upsertCustomUnitOptions();
      sel.value = unit;
      last = unit;
    });
  });
}


function filterItemsByDateText(scope, items, meta) {
  const f = (window.__filters && window.__filters[scope]) ? window.__filters[scope] : { from: '', to: '', q: '' };
  const from = String(f.from || '').trim();
  const to = String(f.to || '').trim();
  const q = String(f.q || '').trim().toLowerCase();
  const dateField = (meta && meta.dateField) ? meta.dateField : 'created_at';
  const textFields = (meta && meta.textFields) ? meta.textFields : [];

  return items.filter(it => {
    if (from || to) {
      const k = limaDateKey(it[dateField] || it.created_at || it.updated_at || it.fecha || it.ts || it.id);
      if (k) {
        if (from && k < from) return false;
        if (to && k > to) return false;
      }
    }

    if (q) {
      const hay = textFields.some(fld => String(it[fld] || '').toLowerCase().includes(q));
      if (!hay) return false;
    }

    return true;
  });
}

function setEditing(scope, id) {
  window.__editing = { scope, id };
}

function clearEditing() {
  window.__editing = { scope: null, id: null };
}

// Rellena el formulario correspondiente con los datos del registro
function fillForm(scope, record) {
  const form = document.querySelector(`form[data-form="${scope}"]`);
  if (!form) return;

  if (scope === 'recepciones') {
    if (form.fecha) form.fecha.value = record.fecha || '';
    if (form.tipo) form.tipo.value = record.tipo || '';
    if (form.etiqueta) form.etiqueta.value = record.etiqueta || '';
    if (form.cantidad) form.cantidad.value = record.cantidad || '';
    if (form.unidad) form.unidad.value = record.unidad || '';
  }

  if (scope === 'produccion') {
    if (form.fecha_ini) form.fecha_ini.value = record.fecha_ini || '';
    if (form.tipo) form.tipo.value = record.tipo || '';
    if (form.cantidad) form.cantidad.value = record.cantidad || '';
    if (form.unidad) form.unidad.value = record.unidad || '';
  }

  if (scope === 'defectuosos') {
    if (form.fecha) form.fecha.value = record.fecha || '';
    if (form.tipo) form.tipo.value = record.tipo || '';
    if (form.cantidad) form.cantidad.value = record.cantidad || '';
    if (form.unidad) form.unidad.value = record.unidad || '';
    if (form.razon) form.razon.value = record.razon || '';
  }

  if (scope === 'envios') {
    if (form.fecha) form.fecha.value = record.fecha || '';
    if (form.cliente) form.cliente.value = record.cliente || '';
    if (form.tipo) form.tipo.value = record.tipo || '';
    if (form.descripcion) form.descripcion.value = record.descripcion || '';
    if (form.cantidad) form.cantidad.value = record.cantidad || '';
    if (form.unidad) form.unidad.value = record.unidad || '';
  }
}

function hookForm(scope) {
  const form = document.querySelector(`form[data-form="${scope}"]`);
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') {
      alert('Solo visualización para Operario.');
      return;
    }

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    const editing = window.__editing && window.__editing.scope === scope && window.__editing.id;

    try {
      if (editing) {
        await api(`/api/${scope}/${window.__editing.id}`, {
          method: 'PUT',
          body: payload
        });
      } else {
        // Recepciones: si el producto ya existe, pedir confirmación antes de actualizar (sumar cantidades)
        if (scope === 'recepciones') {
          try {
            await api(`/api/${scope}`, { method: 'POST', body: payload });
          } catch (e) {
            if (e && e.status === 409 && e.payload && e.payload.error === 'exists') {
              const cur = (e.payload && e.payload.current) || {};
              const msg =
                'Este material ya está registrado.\n\n' +
                'Material: ' + String(cur.tipo || payload.tipo || '') + '\n' +
                'Etiqueta: ' + String(cur.etiqueta || payload.etiqueta || '-') + '\n' +
                'Unidad: ' + String(cur.unidad || payload.unidad || '-') + '\n' +
                'Stock actual: ' + String((cur.stock_actual != null) ? cur.stock_actual : '-') + '\n\n' +
                'Al registrar esta recepción, la cantidad se agregará al stock.\n¿Deseas continuar?';
              const ok = confirm(msg);
              if (!ok) return;
              await api(`/api/${scope}`, { method: 'POST', body: { ...payload, confirm_update: '1' } });
            } else if (e && e.payload && (e.payload.error === 'unit_mismatch' || e.payload.error === 'unidad_required')) {
              const exp = (e.payload && e.payload.expected) ? String(e.payload.expected) : '';
              alert(exp
                ? ('No se puede registrar: la unidad debe coincidir con la ya registrada (' + exp + ').')
                : 'No se puede registrar: debes seleccionar o ingresar una unidad.');
              return;
            } else {
              throw e;
            }
          }
        } else {
          await api(`/api/${scope}`, {
            method: 'POST',
            body: payload
          });
        }
      }

      form.reset();
      clearEditing();
      await renderTable(scope);
      if (scope === 'recepciones') {
        await renderStock().catch(() => {});
      }
    } catch (err) {
      console.error(err);
      alert('Error guardando datos');
    }
  });
}

async function renderTable(scope) {
  const tbl = document.querySelector(`table[data-table="${scope}"]`);
  if (!tbl) return;
  const data = await api(`/api/${scope}${buildFilterQuery(scope)}`);
  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  const allItems = data.items || [];

  const META = {
    recepciones: { dateField: 'fecha', alphaField: 'tipo' },
    produccion: { dateField: 'fecha_ini', alphaField: 'tipo' },
    defectuosos: { dateField: 'fecha', alphaField: 'tipo' },
    envios: { dateField: 'fecha', alphaField: 'tipo' }
  };

  const sortedItems = sortItems(scope, allItems, META[scope] || {});
  const total = sortedItems.length;
  const pageItems = slicePage(scope, sortedItems);

  // Actualizar contador si existe
  const countEl = document.getElementById(`count-${scope}`);
  if (countEl) countEl.textContent = String(total);

  // Paginación (20 por página)
  renderPager(scope, total, tbl, () => renderTable(scope));

  pageItems.forEach(r => {
    const tr = document.createElement('tr');

    const addCell = (value, cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = value == null ? '' : String(value);
      tr.appendChild(td);
    };

    if (scope === 'recepciones') {
      const fechaText = formatDateForTable(r.fecha, true);
      addCell(fechaText);
      addCell(r.tipo,'col-tipo');
      addCell(r.etiqueta || '', 'col-etiqueta');
      addCell(r.cantidad);
      addCell(r.unidad || '');
    }

    if (scope === 'produccion') {
      const fechaText = formatDateForTable(r.fecha_ini, true);
      addCell(fechaText);
      addCell(r.tipo || '','col-tipo');
      addCell(r.cantidad);
      addCell(r.unidad || '');
    }

    if (scope === 'defectuosos') {
      const fechaText = formatDateForTable(r.fecha, false);
      addCell(fechaText);
      addCell(r.tipo,'col-tipo');
      addCell(r.cantidad);
      addCell(r.unidad || '');
      addCell(r.razon || '');
    }

    if (scope === 'envios') {
      const fechaText = formatDateForTable(r.fecha, false);
      addCell(fechaText);
      addCell(r.cliente);
      addCell(r.tipo,'col-tipo');
      addCell(r.descripcion || '','col-detalle');
      addCell(r.cantidad);
      addCell(r.unidad || '');
    }

    // Columna de acciones (Editar / Eliminar)
    const tdActions = document.createElement('td');
    tdActions.className = 'actions-row';

    // Historial de entradas (Recepción de Materiales)
    if (scope === 'recepciones') {
      const btnHist = document.createElement('button');
      btnHist.type = 'button';
      btnHist.className = 'btn-small btn-white btn-hist';
      btnHist.dataset.tipo = r.tipo || '';
      btnHist.textContent = 'Entradas';
      tdActions.appendChild(btnHist);
    }

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn-small btn-edit';
    btnEdit.dataset.id = r.id;
    btnEdit.textContent = 'Editar';

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-small btn-del';
    btnDel.dataset.id = r.id;
    btnDel.textContent = 'Eliminar';

    tdActions.appendChild(btnEdit);
    tdActions.appendChild(btnDel);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  // Botones eliminar
  tbody.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      if (!confirm('¿Eliminar registro?')) return;
      const id = btn.dataset.id;
      try {
        await api(`/api/${scope}/${id}`, { method: 'DELETE' });
        await renderByScope(scope);
        if (scope === 'recepciones') {
          await renderStock().catch(() => {});
        }
      } catch (err) {
        console.error(err);
        alert('Error eliminando registro');
      }
    });
  });

  // Historial de entradas (Recepción de Materiales)
  tbody.querySelectorAll('.btn-hist').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const tipo = btn.dataset.tipo || '';
      if (!tipo) return;
      try {
        await openRecepHistModal(tipo);
      } catch (err) {
        console.error(err);
        alert('No se pudo cargar el historial de entradas.');
      }
    });
  });

  // Botones editar
  tbody.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      const id = btn.dataset.id;
      const rec = allItems.find(x => String(x.id) === String(id));
      if (!rec) return;
      setEditing(scope, id);
      fillForm(scope, rec);
      // ya no hacemos scroll hacia arriba para evitar el salto molesto
    });
  });
}

function renderByScope(scope) {
  if (scope === 'recepciones' || scope === 'produccion' || scope === 'defectuosos' || scope === 'envios') return renderTable(scope);
  if (scope === 'stock') return renderStock();
  if (scope === 'stock_retiros') return renderStockHistory();
  if (scope === 'maquinaria') return renderMaquinaria();
  if (scope === 'repuestos') return renderRepuestos();
  if (scope === 'users') return renderUsers();
}

// ------------------------------
// Stock de productos (derivado de Recepción)
// ------------------------------
async function renderStock() {
  const tbl = document.getElementById('stockTable');
  const sel = document.getElementById('stock_tipo');
  const unitEl = document.getElementById('stock_unidad');
  const msgEl = document.getElementById('stockMsg');
  const countEl = document.getElementById('count-stock');
  if (!tbl) return;

  const data = await api('/api/stock');
  const items = data.items || [];
  window.__STOCK_ITEMS = items;

  const meta = { dateField: "updated_at", alphaField: "tipo", textFields: ["tipo", "etiqueta", "unidad"] };
  let viewItems = filterItemsByDateText("stock", items, meta);
  viewItems = sortItems("stock", viewItems, meta);

  if (countEl) countEl.textContent = String(items.length);
  if (msgEl && !msgEl.textContent) msgEl.textContent = '';

  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  renderPager('stock', viewItems.length, tbl, () => renderStock().catch(() => {}));
  const pageItems = slicePage('stock', viewItems);

  pageItems.forEach(it => {
    const tr = document.createElement('tr');
    const tdTipo = document.createElement('td');
    tdTipo.className = 'col-material';
    tdTipo.textContent = it.tipo || '';
    tr.appendChild(tdTipo);

    const tdEt = document.createElement('td');
    tdEt.className = 'col-etiqueta';
    tdEt.textContent = it.etiqueta || '';
    tr.appendChild(tdEt);

    const tdC = document.createElement('td');
    tdC.className = 'col-num';
    tdC.textContent = String(it.cantidad ?? '');
    tr.appendChild(tdC);

    const tdU = document.createElement('td');
    tdU.className = 'col-num';
    tdU.textContent = it.unidad || '';
    tr.appendChild(tdU);

        const tdS = document.createElement('td');
        tdS.className = 'col-status';
        const badge = document.createElement('span');
        const ok = Number(it.cantidad ?? 0) > 0;
        badge.className = 'status-badge ' + (ok ? 'ok' : 'bad');
        badge.textContent = ok ? 'Disponible' : 'Agotado';
        tdS.appendChild(badge);
        tr.appendChild(tdS);


    const tdUp = document.createElement('td');
    tdUp.className = 'col-date';
    tdUp.textContent = formatDateForTable(it.updated_at || it.created_at || '', true);
    tr.appendChild(tdUp);

    tbody.appendChild(tr);
  });

  // Dropdown de retiro
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '';
    items.forEach(it => {
      const opt = document.createElement('option');
      opt.value = it.tipo;
      opt.textContent = it.tipo;
      sel.appendChild(opt);
    });
    if (items.length) {
      sel.value = items.some(x => x.tipo === prev) ? prev : items[0].tipo;
    }
    const current = items.find(x => x.tipo === sel.value);
    if (unitEl) unitEl.value = current ? (current.unidad || '') : '';
  }
}


async function renderStockHistory() {
  const tbl = document.getElementById('retirosTable');
  if (!tbl) return;

  // Solo roles con permiso deberían poder ver este historial (UI lo oculta para otros)
  const data = await api('/api/stock/retiros');
  const items = data.items || [];

  const meta = { dateField: 'created_at', alphaField: 'tipo', textFields: ['tipo', 'unidad'] };
  let viewItems = filterItemsByDateText('stock_retiros', items, meta);
  viewItems = sortItems('stock_retiros', viewItems, meta);

  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  renderPager('stock_retiros', viewItems.length, tbl, () => renderStockHistory().catch(() => {}));
  const pageItems = slicePage('stock_retiros', viewItems);

  pageItems.forEach(r => {
    const tr = document.createElement('tr');

    const tdF = document.createElement('td');
    tdF.className = 'col-date';
    tdF.textContent = formatDateForTable(r.fecha || r.created_at || '', true);
    tr.appendChild(tdF);

    const tdT = document.createElement('td');
    tdT.className = 'col-material';
    tdT.textContent = r.tipo || '';
    tr.appendChild(tdT);

    const tdC = document.createElement('td');
    tdC.className = 'col-num';
    tdC.textContent = String(r.cantidad ?? '');
    tr.appendChild(tdC);

    const tdU = document.createElement('td');
    tdU.className = 'col-num';
    tdU.textContent = r.unidad || '';
    tr.appendChild(tdU);

    tbody.appendChild(tr);
  });
}

function initStockViewToggle() {
  const btnStock = document.getElementById('btnShowStock');
  const btnRetiros = document.getElementById('btnShowRetiros');
  const btnExpPdf = document.getElementById('btnExportStockPdf');
  const btnExpXlsx = document.getElementById('btnExportStockXlsx');
  const cardStock = document.getElementById('stockTableCard');
  const cardRetiros = document.getElementById('retirosTableCard');
  if (!btnStock || !cardStock || !cardRetiros) return;

  const setActive = (view) => {
    btnStock.classList.toggle('active', view === 'stock');
    if (btnRetiros) btnRetiros.classList.toggle('active', view === 'retiros');
    cardStock.style.display = (view === 'stock') ? 'block' : 'none';
    cardRetiros.style.display = (view === 'retiros') ? 'block' : 'none';
    if (btnExpPdf) btnExpPdf.style.display = (view === 'stock') ? 'inline-flex' : 'none';
    if (btnExpXlsx) btnExpXlsx.style.display = (view === 'stock') ? 'inline-flex' : 'none';
  };

  btnStock.addEventListener('click', async () => {
    setActive('stock');
    await renderStock().catch(() => {});
  });

  if (btnRetiros) {
    btnRetiros.addEventListener('click', async () => {
      setActive('retiros');
      await renderStockHistory().catch(err => {
        console.error('Error cargando historial de retiros:', err);
        alert('No se pudo cargar el historial de retiros.');
      });
    });
  }

  // Vista inicial
  setActive('stock');
}


function initStockUI() {
  const form = document.getElementById('stockRetiroForm');
  const sel = document.getElementById('stock_tipo');
  const qty = document.getElementById('stock_cantidad');
  const unitEl = document.getElementById('stock_unidad');
  const msgEl = document.getElementById('stockMsg');
  const btnDelete = document.getElementById('btnDeleteStockItem');
  if (!form) return;

  sel && sel.addEventListener('change', () => {
    const items = window.__STOCK_ITEMS || [];
    const current = items.find(x => x.tipo === sel.value);
    if (unitEl) unitEl.value = current ? (current.unidad || '') : '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') {
      alert('Solo visualización para Operario.');
      return;
    }

    const tipo = sel ? String(sel.value || '').trim() : '';
    const cantidad = qty ? parseInt(String(qty.value || '0'), 10) : 0;
    const unidad = unitEl ? String(unitEl.value || '').trim() : '';
    if (!tipo || !cantidad || cantidad <= 0) {
      alert('Selecciona un producto e ingresa una cantidad válida.');
      return;
    }

    try {
      await api('/api/stock/retiro', {
        method: 'POST',
        body: { tipo, cantidad, unidad }
      });
      if (qty) qty.value = '';
      if (msgEl) msgEl.textContent = 'Retiro registrado.';
      await renderStock();
      try{
        const cardR = document.getElementById('retirosTableCard');
        if (cardR && cardR.style.display !== 'none') {
          await renderStockHistory();
        }
      }catch(e){}
    } catch (err) {
      console.error(err);
      if (err && err.payload && err.payload.error === 'insufficient_stock') {
        alert('Stock insuficiente para realizar el retiro.');
      } else {
        alert('No se pudo registrar el retiro.');
      }
    }
  });

  // Eliminar producto del stock (elimina también el registro base para obligar a re-registrarlo)
  if (btnDelete) {
    btnDelete.addEventListener('click', async () => {
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }

      const tipo = sel ? String(sel.value || '').trim() : '';
      if (!tipo) {
        alert('Selecciona un producto para eliminar.');
        return;
      }

      const ok = confirm('Estás a punto de eliminar Stock de Producto.');
      if (!ok) return;

      try {
        await api('/api/stock/delete-product', {
          method: 'POST',
          body: { tipo }
        });
        if (msgEl) msgEl.textContent = 'Producto eliminado del stock.';
        if (qty) qty.value = '';
        await renderStock();
        try {
          const cardR = document.getElementById('retirosTableCard');
          if (cardR && cardR.style.display !== 'none') {
            await renderStockHistory();
          }
        } catch (_) {}
      } catch (err) {
        console.error(err);
        alert('No se pudo eliminar el producto.');
      }
    });
  }
}

// ------------------------------
// Maquinaria (Supervisor/Admin)
// ------------------------------
async function renderMaquinaria() {
  const tbl = document.getElementById('maquinariaTable');
  const countEl = document.getElementById('count-maquinaria');
  if (!tbl) return;

  const data = await api(`/api/maquinaria${buildFilterQuery('maquinaria')}`);
  const items = data.items || [];
  window.__MAQ_ITEMS = items;

  const meta = { dateField: 'fecha', alphaField: 'maquina', textFields: ['maquina', 'servicio', 'descripcion'] };
  let viewItems = filterItemsByDateText('maquinaria', items, meta);
  viewItems = sortItems('maquinaria', viewItems, meta);
  if (countEl) countEl.textContent = String(viewItems.length);

  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  renderPager('maquinaria', viewItems.length, tbl, () => renderMaquinaria().catch(() => {}));
  const pageItems = slicePage('maquinaria', viewItems);

  pageItems.forEach(it => {
    const tr = document.createElement('tr');

    const tdF = document.createElement('td');
    tdF.className = 'col-date';
    tdF.textContent = formatDateForTable(it.fecha || it.created_at || '', true);
    tr.appendChild(tdF);

    const tdM = document.createElement('td');
    tdM.className = 'col-material';
    tdM.textContent = it.maquina || '';
    tr.appendChild(tdM);

    const tdS = document.createElement('td');
    tdS.className = 'col-material';
    tdS.textContent = it.servicio || '';
    tr.appendChild(tdS);

    const tdD = document.createElement('td');
    tdD.textContent = it.descripcion || '';
    tr.appendChild(tdD);

    // Acciones
    const tdA = document.createElement('td');
    tdA.className = 'actions-row';

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn-small btn-edit maq-edit';
    btnEdit.dataset.id = it.id;
    btnEdit.textContent = 'Editar';

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-small btn-del maq-del';
    btnDel.dataset.id = it.id;
    btnDel.textContent = 'Eliminar';

    tdA.appendChild(btnEdit);
    tdA.appendChild(btnDel);
    tr.appendChild(tdA);

    tbody.appendChild(tr);
  });

  // Eliminar
  tbody.querySelectorAll('.maq-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      if (!confirm('¿Eliminar registro de maquinaria?')) return;
      try {
        await api(`/api/maquinaria/${btn.dataset.id}`, { method: 'DELETE' });
        // Si se eliminó el registro que estaba en edición, limpiar
        if (window.__editing && window.__editing.scope === 'maquinaria' && String(window.__editing.id) === String(btn.dataset.id)) {
          clearEditing();
          resetMaquinariaEditUI();
        }
        await renderMaquinaria();
      } catch (err) {
        console.error(err);
        alert('No se pudo eliminar el registro.');
      }
    });
  });

  // Editar
  tbody.querySelectorAll('.maq-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      const id = btn.dataset.id;
      const rec = (window.__MAQ_ITEMS || []).find(x => String(x.id) === String(id));
      if (!rec) return;
      setEditing('maquinaria', id);
      fillMaquinariaForm(rec);
    });
  });
}


function fillMaquinariaForm(rec){
  const maquinaEl = document.getElementById('maq_maquina');
  const servicioEl = document.getElementById('maq_servicio');
  const customEl = document.getElementById('maq_servicio_custom');
  const fechaEl = document.getElementById('maq_fecha');
  const descEl = document.getElementById('maq_desc');
  if (maquinaEl) maquinaEl.value = rec.maquina || '';
  if (fechaEl) fechaEl.value = (rec.fecha || '').replace(' ', 'T').slice(0, 16);

  // Servicio: si no está en la lista, pasar a manual
  const known = ['reparacion','mantenimiento','averia'];
  const raw = String(rec.servicio || '').trim();
  const v = raw.toLowerCase();
  if (servicioEl) {
    if (known.includes(v)) {
      servicioEl.value = v;
      if (customEl) { customEl.style.display = 'none'; customEl.value = ''; }
    } else {
      servicioEl.value = '__custom__';
      if (customEl) { customEl.style.display = 'block'; customEl.value = raw; }
    }
  }
  if (descEl) descEl.value = rec.descripcion || '';
  const submitBtn = document.getElementById('maqSubmit');
  if (submitBtn) submitBtn.textContent = 'Actualizar';
}

function resetMaquinariaEditUI(){
  const submitBtn = document.getElementById('maqSubmit');
  if (submitBtn) submitBtn.textContent = 'Registrar';
  const customEl = document.getElementById('maq_servicio_custom');
  const servicioEl = document.getElementById('maq_servicio');
  if (servicioEl && servicioEl.value !== '__custom__' && customEl) {
    customEl.style.display = 'none';
    customEl.value = '';
  }
}


function initMaquinariaUI() {
  const form = document.getElementById('maquinariaForm');
  if (!form) return;

  const selServicio = document.getElementById('maq_servicio');
  const customServicio = document.getElementById('maq_servicio_custom');

  const toggleCustom = () => {
    if (!selServicio || !customServicio) return;
    const isCustom = selServicio.value === '__custom__';
    customServicio.style.display = isCustom ? 'block' : 'none';
    if (!isCustom) customServicio.value = '';
  };
  selServicio && selServicio.addEventListener('change', toggleCustom);
  toggleCustom();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') {
      alert('Solo visualización para Operario.');
      return;
    }

    const maquina = String((document.getElementById('maq_maquina') || {}).value || '').trim();
    let servicio = String((selServicio || {}).value || '').trim();
    const fecha = String((document.getElementById('maq_fecha') || {}).value || '').trim();
    const descripcion = String((document.getElementById('maq_desc') || {}).value || '').trim();
    if (servicio === '__custom__') servicio = String((customServicio || {}).value || '').trim();

    if (!maquina || !servicio || !fecha) {
      alert('Completa máquina, servicio y fecha.');
      return;
    }

    const isEditing = window.__editing && window.__editing.scope === 'maquinaria' && window.__editing.id;

    try {
      if (isEditing) {
        await api(`/api/maquinaria/${window.__editing.id}`, {
          method: 'PUT',
          body: { maquina, servicio, fecha, descripcion }
        });
      } else {
        await api('/api/maquinaria', { method: 'POST', body: { maquina, servicio, fecha, descripcion } });
      }

      // limpiar
      (document.getElementById('maq_desc') || {}).value = '';
      // no tocamos fecha por defecto para permitir registros consecutivos
      if (selServicio) selServicio.value = 'mantenimiento';
      if (customServicio) customServicio.value = '';
      toggleCustom();

      clearEditing();
      resetMaquinariaEditUI();
      await renderMaquinaria();
    } catch (err) {
      console.error(err);
      alert('No se pudo guardar el servicio de maquinaria.');
    }
  });
}

// ------------------------------
// Repuestos e inventario (Supervisor/Admin)
// ------------------------------
async function renderRepuestos() {
  const tbl = document.getElementById('repuestosTable');
  const countEl = document.getElementById('count-repuestos');
  if (!tbl) return;
  const data = await api(`/api/repuestos${buildFilterQuery('repuestos')}`);
  const items = data.items || [];
  window.__REP_ITEMS = items;

  const meta = { dateField: 'fecha', alphaField: 'repuesto', textFields: ['repuesto', 'observaciones'] };
  let viewItems = filterItemsByDateText('repuestos', items, meta);
  viewItems = sortItems('repuestos', viewItems, meta);
  if (countEl) countEl.textContent = String(viewItems.length);

  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  renderPager('repuestos', viewItems.length, tbl, () => renderRepuestos().catch(() => {}));
  const pageItems = slicePage('repuestos', viewItems);

  pageItems.forEach(it => {
    const tr = document.createElement('tr');

    const tdF = document.createElement('td');
    tdF.className = 'col-date';
    tdF.textContent = formatDateForTable(it.fecha || it.created_at || '', true);
    tr.appendChild(tdF);

    const tdR = document.createElement('td');
    tdR.className = 'col-material';
    tdR.textContent = it.repuesto || '';
    tr.appendChild(tdR);

    const tdC = document.createElement('td');
    tdC.className = 'col-num';
    tdC.textContent = String(it.cantidad ?? '');
    tr.appendChild(tdC);

    const tdO = document.createElement('td');
    tdO.textContent = it.observaciones || '';
    tr.appendChild(tdO);

    const tdS = document.createElement('td');
    const ok = (Number(it.cantidad || 0) > 0);
    const b = document.createElement('span');
    b.className = ok ? 'badge badge-ok' : 'badge badge-bad';
    b.textContent = ok ? 'Disponible' : 'No disponible';
    tdS.appendChild(b);
    tr.appendChild(tdS);

    // Acciones
    const tdA = document.createElement('td');
    tdA.className = 'actions-row';

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn-small btn-edit rep-edit';
    btnEdit.dataset.id = it.id;
    btnEdit.textContent = 'Editar';

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-small btn-del rep-del';
    btnDel.dataset.id = it.id;
    btnDel.textContent = 'Eliminar';

    tdA.appendChild(btnEdit);
    tdA.appendChild(btnDel);
    tr.appendChild(tdA);

    tbody.appendChild(tr);
  });

  // Eliminar
  tbody.querySelectorAll('.rep-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      if (!confirm('¿Eliminar repuesto?')) return;
      try {
        await api(`/api/repuestos/${btn.dataset.id}`, { method: 'DELETE' });
        if (window.__editing && window.__editing.scope === 'repuestos' && String(window.__editing.id) === String(btn.dataset.id)) {
          clearEditing();
          resetRepuestosEditUI();
        }
        await renderRepuestos();
      } catch (err) {
        console.error(err);
        alert('No se pudo eliminar el repuesto.');
      }
    });
  });

  // Editar
  tbody.querySelectorAll('.rep-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') {
        alert('Solo visualización para Operario.');
        return;
      }
      const id = btn.dataset.id;
      const rec = (window.__REP_ITEMS || []).find(x => String(x.id) === String(id));
      if (!rec) return;
      setEditing('repuestos', id);
      fillRepuestosForm(rec);
    });
  });
}


function fillRepuestosForm(rec){
  const sel = document.getElementById('rep_repuesto');
  const custom = document.getElementById('rep_repuesto_custom');
  const cantidadEl = document.getElementById('rep_cantidad');
  const fechaEl = document.getElementById('rep_fecha');
  const obsEl = document.getElementById('rep_obs');

  const known = ['calentador','resistencia','rodamiento','boquilla'];
  const raw = String(rec.repuesto || '').trim();
  const v = raw.toLowerCase();

  if (sel) {
    if (known.includes(v)) {
      sel.value = v;
      if (custom) { custom.style.display = 'none'; custom.value = ''; }
    } else {
      sel.value = '__custom__';
      if (custom) { custom.style.display = 'block'; custom.value = raw; }
    }
  }

  if (cantidadEl) cantidadEl.value = String(rec.cantidad ?? '');
  if (fechaEl) fechaEl.value = String(rec.fecha || '').slice(0, 10);
  if (obsEl) obsEl.value = rec.observaciones || '';

  const submitBtn = document.getElementById('repSubmit');
  if (submitBtn) submitBtn.textContent = 'Actualizar';
}

function resetRepuestosEditUI(){
  const submitBtn = document.getElementById('repSubmit');
  if (submitBtn) submitBtn.textContent = 'Registrar';
  const custom = document.getElementById('rep_repuesto_custom');
  const sel = document.getElementById('rep_repuesto');
  if (sel && sel.value !== '__custom__' && custom) {
    custom.style.display = 'none';
    custom.value = '';
  }
}


function initRepuestosUI() {
  const form = document.getElementById('repuestosForm');
  if (!form) return;
  const sel = document.getElementById('rep_repuesto');
  const custom = document.getElementById('rep_repuesto_custom');

  const toggleCustom = () => {
    if (!sel || !custom) return;
    const isCustom = sel.value === '__custom__';
    custom.style.display = isCustom ? 'block' : 'none';
    if (!isCustom) custom.value = '';
  };
  sel && sel.addEventListener('change', toggleCustom);
  toggleCustom();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') {
      alert('Solo visualización para Operario.');
      return;
    }

    let repuesto = String((sel || {}).value || '').trim();
    if (repuesto === '__custom__') repuesto = String((custom || {}).value || '').trim();

    const cantidad = parseInt(String((document.getElementById('rep_cantidad') || {}).value || '0'), 10);
    const fecha = String((document.getElementById('rep_fecha') || {}).value || '').trim();
    const observaciones = String((document.getElementById('rep_obs') || {}).value || '').trim();

    if (!repuesto || !fecha || !Number.isFinite(cantidad) || cantidad < 0) {
      alert('Completa repuesto, cantidad y fecha.');
      return;
    }

    const isEditing = window.__editing && window.__editing.scope === 'repuestos' && window.__editing.id;

    try {
      if (isEditing) {
        await api(`/api/repuestos/${window.__editing.id}`, {
          method: 'PUT',
          body: { repuesto, cantidad, fecha, observaciones }
        });
      } else {
        await api('/api/repuestos', { method: 'POST', body: { repuesto, cantidad, fecha, observaciones } });
      }

      (document.getElementById('rep_cantidad') || {}).value = '';
      (document.getElementById('rep_obs') || {}).value = '';
      if (sel) sel.value = 'resistencia';
      if (custom) custom.value = '';
      toggleCustom();

      clearEditing();
      resetRepuestosEditUI();
      await renderRepuestos();
    } catch (err) {
      console.error(err);
      alert('No se pudo guardar el repuesto.');
    }
  });
}

async function renderUsers() {
  const tbl = document.getElementById('usersTable');
  if (!tbl) return;
  const data = await api('/api/users');
  const tbody = tbl.querySelector('tbody');
  tbody.innerHTML = '';

  const meta = { dateField: 'id', alphaField: 'username' };
  const viewItems = sortItems('users', data.items || [], meta);

  viewItems.forEach(u => {
    const tr = document.createElement('tr');

    const isProtected = Number(u.is_protected || 0) === 1;

    // Columna usuario
    const tdUser = document.createElement('td');
    tdUser.textContent = u.username + (isProtected ? ' (PROTEGIDO)' : '');
    tr.appendChild(tdUser);

    // Columna rol (select)
    const tdRole = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'input inline-edit roleSel';
    sel.dataset.id = u.id;
    if (isProtected) sel.disabled = true;

    ['operario', 'supervisor', 'administrador'].forEach(role => {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = role;
      if (u.role === role) opt.selected = true;
      sel.appendChild(opt);
    });

    tdRole.appendChild(sel);
    tr.appendChild(tdRole);

    // Columna acciones
    const tdActions = document.createElement('td');
    tdActions.className = 'actions-row';

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn-small reset';
    btnReset.dataset.id = u.id;
    btnReset.textContent = 'Reset Pass';

    if (isProtected) {
      btnReset.disabled = true;
      btnReset.title = 'Usuario protegido';
    }

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-small del';
    btnDel.dataset.id = u.id;
    btnDel.textContent = 'Eliminar';

    if (isProtected) {
      btnDel.disabled = true;
      btnDel.title = 'Usuario protegido';
    }

    tdActions.appendChild(btnReset);
    tdActions.appendChild(btnDel);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.roleSel').forEach(sel => {
    sel.addEventListener('change', async () => {
      await api('/api/users/' + sel.dataset.id, {
        method: 'PUT',
        body: { role: sel.value }
      });
      alert('Rol actualizado');
    });
  });

  tbody.querySelectorAll('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (!confirm('¿Eliminar usuario?')) return;
      try {
        await api('/api/users/' + btn.dataset.id, { method: 'DELETE' });
        renderUsers();
      } catch (err) {
        if (err && err.payload && err.payload.error === 'protected-user') {
          alert('Este usuario está protegido y no puede eliminarse.');
          return;
        }
        if (err && err.payload && err.payload.error === 'must-keep-supervisor') {
          alert('Debe existir al menos un Supervisor.');
          return;
        }
        if (err && err.payload && err.payload.error === 'cannot-delete-last-user') {
          alert('No se puede eliminar el último usuario.');
          return;
        }
        console.error(err);
        alert('No se pudo eliminar el usuario.');
      }
    });
  });

  tbody.querySelectorAll('.reset').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const p = prompt('Nueva contraseña', 'Admin');
      if (!p) return;
      try {
        await api('/api/users/' + btn.dataset.id + '/password', {
          method: 'PATCH',
          body: { password: p }
        });
        alert('Contraseña cambiada');
      } catch (err) {
        if (err && err.payload && err.payload.error === 'protected-user') {
          alert('Este usuario está protegido y su contraseña no puede modificarse.');
          return;
        }
        console.error(err);
        alert('No se pudo cambiar la contraseña.');
      }
    });
  });
}


async function initBackupUI() {
  const btnDl = document.getElementById('btnDownloadBackup');
  const fileEl = document.getElementById('backupFile');
  const btnRs = document.getElementById('btnRestoreBackup');
  const status = document.getElementById('backupStatus');

  if (btnDl) {
    btnDl.addEventListener('click', async () => {
      try {
        status && (status.textContent = 'Generando y descargando backup...');
        const resp = await fetch('/api/backup/download', { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const blob = await resp.blob();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const fname = `brumapp_backup_${ts}.db`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        status && (status.textContent = 'Backup descargado.');
      } catch (e) {
        console.error(e);
        status && (status.textContent = 'No se pudo descargar el backup. Revisa consola.');
        alert('No se pudo descargar el backup.');
      }
    });
  }

  if (btnRs) {
    btnRs.addEventListener('click', async () => {
      try {
        const file = fileEl && fileEl.files && fileEl.files[0];
        if (!file) {
          alert('Selecciona un archivo .db primero.');
          return;
        }

        const ok = confirm('Esto reemplazará la base de datos actual. ¿Deseas continuar?');
        if (!ok) return;

        status && (status.textContent = 'Subiendo y restaurando backup...');
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Convert a base64 (sin librerías externas)
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        const fileBase64 = btoa(binary);

        const data = await api('/api/backup/restore', {
          method: 'POST',
          body: { fileBase64, filename: file.name }
        });

        if (!data.ok) throw new Error('restore_failed');
        status && (status.textContent = 'Restore completado. Recargando...');
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        console.error(e);
        status && (status.textContent = 'No se pudo restaurar el backup. Revisa consola.');
        alert('No se pudo restaurar el backup.');
      }
    });
  }
}

async function initEventLogsUI() {
  const tbl = document.getElementById('eventsTable');
  const qEl = document.getElementById('ev_q');
  const fromEl = document.getElementById('ev_from');
  const toEl = document.getElementById('ev_to');
  const sortEl = document.getElementById('ev_sort');
  const btnApply = document.getElementById('ev_apply');
  const btnRefresh = document.getElementById('ev_refresh');
  const btnExport = document.getElementById('ev_export_excel');
  const btnPrev = document.getElementById('ev_prev');
  const btnNext = document.getElementById('ev_next');
  const pageEl = document.getElementById('ev_page');

  if (!tbl) return;

  let page = 1;
  const pageSize = 50;

  const render = async () => {
    const q = qEl ? String(qEl.value || '').trim() : '';
    const from = fromEl ? String(fromEl.value || '').trim() : '';
    const to = toEl ? String(toEl.value || '').trim() : '';

    const offset = (page - 1) * pageSize;
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    qs.set('limit', String(pageSize));
    qs.set('offset', String(offset));

    const data = await api('/api/event-logs?' + qs.toString());
    const tbody = tbl.querySelector('tbody');
    tbody.innerHTML = '';

    window.__sort = window.__sort || {};
    if (sortEl && sortEl.value) window.__sort.event_logs = sortEl.value;
    const meta = { dateField: 'ts', alphaField: 'username' };
    const viewItems = sortItems('event_logs', data.items || [], meta);

    viewItems.forEach(ev => {
      const tr = document.createElement('tr');

      const tdTs = document.createElement('td');
      tdTs.textContent = formatDateForTable(ev.ts || '', true);
      tr.appendChild(tdTs);

      const tdU = document.createElement('td');
      tdU.textContent = ev.username || '';
      tr.appendChild(tdU);

      const tdR = document.createElement('td');
      tdR.textContent = ev.role || '';
      tr.appendChild(tdR);

      const tdA = document.createElement('td');
      tdA.textContent = ev.action || '';
      tr.appendChild(tdA);

      const tdE = document.createElement('td');
      tdE.textContent = ev.entity || '';
      tr.appendChild(tdE);

      const tdId = document.createElement('td');
      tdId.textContent = ev.entity_id || '';
      tr.appendChild(tdId);

      const tdD = document.createElement('td');
      tdD.textContent = ev.detail || '';
      tr.appendChild(tdD);

      const tdIp = document.createElement('td');
      tdIp.textContent = ev.ip || '';
      tr.appendChild(tdIp);

      tbody.appendChild(tr);
    });

    pageEl && (pageEl.textContent = String(page));
  };

  btnApply && btnApply.addEventListener('click', async () => {
    page = 1;
    await render().catch(err => console.error(err));
  });

  btnRefresh && btnRefresh.addEventListener('click', async () => {
    await render().catch(err => console.error(err));
  });

  sortEl && sortEl.addEventListener('change', async () => {
    page = 1;
    await render().catch(err => console.error(err));
  });

  btnExport && btnExport.addEventListener('click', () => {
    const q = qEl ? String(qEl.value || '').trim() : '';
    const from = fromEl ? String(fromEl.value || '').trim() : '';
    const to = toEl ? String(toEl.value || '').trim() : '';

    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);

    const url = '/api/event-logs.xlsx' + (qs.toString() ? ('?' + qs.toString()) : '');
    window.location.href = url;
  });

  btnPrev && btnPrev.addEventListener('click', async () => {
    if (page <= 1) return;
    page -= 1;
    await render().catch(err => console.error(err));
  });

  btnNext && btnNext.addEventListener('click', async () => {
    page += 1;
    await render().catch(err => console.error(err));
  });

  try {
    await render();
  } catch (e) {
    console.error('Error cargando eventos:', e);
  }
}



// ------------------------------
// Modal: Historial de entradas (Recepciones)
// ------------------------------
let __recepHistModalInited = false;

// Estado del modal para permitir ordenamiento sin volver a consultar
let __recepHistState = { tipo: null, items: [], summary: null };

function initRecepHistModal() {
  if (__recepHistModalInited) return;
  __recepHistModalInited = true;
  const overlay = document.getElementById('recepHistModal');
  const closeBtn = document.getElementById('recepHistClose');
  if (!overlay) return;

  const close = () => { overlay.style.display = 'none'; };
  if (closeBtn) closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });
}

function renderRecepHistFromState() {
  const tipo = __recepHistState && __recepHistState.tipo ? String(__recepHistState.tipo) : '';
  const items = (__recepHistState && Array.isArray(__recepHistState.items)) ? __recepHistState.items : [];
  const summary = (__recepHistState && __recepHistState.summary) ? __recepHistState.summary : {};

  const sub = document.getElementById('recepHistSub');
  const timesEl = document.getElementById('recepHistTimes');
  const totalEl = document.getElementById('recepHistTotal');
  const lastEl = document.getElementById('recepHistLast');
  const emptyEl = document.getElementById('recepHistEmpty');
  const table = document.getElementById('recepHistTable');
  const tbody = table ? table.querySelector('tbody') : null;

  if (sub && tipo) sub.textContent = `Material: ${tipo}`;
  if (timesEl) timesEl.textContent = String(summary.veces ?? 0);
  if (totalEl) totalEl.textContent = String(summary.total_agregado ?? 0);
  if (lastEl) lastEl.textContent = String(summary.ultimo_total ?? 0);

  if (tbody) tbody.innerHTML = '';
  if (emptyEl) emptyEl.style.display = items.length ? 'none' : 'block';
  if (!tbody || !items.length) return;

  const labelAction = (a) => {
    const v = String(a || '').toLowerCase();
    if (v === 'baseline') return 'Base';
    if (v === 'create') return 'Nuevo';
    if (v === 'add') return 'Ingreso';
    if (v === 'adjust') return 'Ajuste';
    if (v === 'delete') return 'Eliminación';
    return a || '';
  };

  const sorted = sortItems('recep_hist', items, { dateField: 'created_at', alphaField: 'action' });

  sorted.forEach(mv => {
    const tr = document.createElement('tr');

    const tdTs = document.createElement('td');
    tdTs.className = 'col-date';
    tdTs.textContent = formatDateForTable(mv.created_at || mv.ts || '', true);
    tr.appendChild(tdTs);

    const tdA = document.createElement('td');
    tdA.textContent = labelAction(mv.action);
    tr.appendChild(tdA);

    const tdD = document.createElement('td');
    tdD.className = 'col-num';
    const act = String(mv.action || '').toLowerCase();
    const cantidad = (act === 'adjust') ? (mv.total ?? '') : (mv.delta ?? '');
    tdD.textContent = String(cantidad);
    tr.appendChild(tdD);

    const tdT = document.createElement('td');
    tdT.className = 'col-num';
    tdT.textContent = String(mv.total ?? '');
    tr.appendChild(tdT);

    const tdF = document.createElement('td');
    tdF.textContent = String(mv.fecha || '');
    tr.appendChild(tdF);

    const tdU = document.createElement('td');
    tdU.textContent = String(mv.unidad || '');
    tr.appendChild(tdU);

    const tdE = document.createElement('td');
    tdE.className = 'col-etiqueta';
    tdE.textContent = String(mv.etiqueta || '');
    tr.appendChild(tdE);

    tbody.appendChild(tr);
  });
}


async function openRecepHistModal(tipo) {
  initRecepHistModal();
  const overlay = document.getElementById('recepHistModal');
  if (!overlay) return;

  const sub = document.getElementById('recepHistSub');
  const timesEl = document.getElementById('recepHistTimes');
  const totalEl = document.getElementById('recepHistTotal');
  const lastEl = document.getElementById('recepHistLast');
  const emptyEl = document.getElementById('recepHistEmpty');
  const table = document.getElementById('recepHistTable');
  const tbody = table ? table.querySelector('tbody') : null;

  if (sub) sub.textContent = `Material: ${tipo}`;
  if (timesEl) timesEl.textContent = '...';
  if (totalEl) totalEl.textContent = '...';
  if (lastEl) lastEl.textContent = '...';
  if (tbody) tbody.innerHTML = '';
  if (emptyEl) emptyEl.style.display = 'none';

  overlay.style.display = 'flex';

  const data = await api(`/api/recepciones/historial?tipo=${encodeURIComponent(tipo)}&limit=200&offset=0`);
  __recepHistState = { tipo, items: (data.items || []), summary: (data.summary || {}) };
  renderRecepHistFromState();

}

async function initRecepcionesAjusteUI() {
  const btnToggle = document.getElementById('btnToggleAjusteRecep');
  const box = document.getElementById('ajusteRecepBox');
  const sel = document.getElementById('ajusteRecepSelect');
  const inpQty = document.getElementById('ajusteRecepCantidad');
  const inpFecha = document.getElementById('ajusteRecepFecha');
  const btnNow = document.getElementById('ajusteRecepNow');
  const btnApply = document.getElementById('ajusteRecepApply');
  const status = document.getElementById('ajusteRecepStatus');

  if (!btnToggle || !box || !sel || !inpQty || !inpFecha || !btnNow || !btnApply) return;

  const setNow = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const v = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    inpFecha.value = v;
  };

  btnNow.addEventListener('click', (e) => { e.preventDefault(); setNow(); });

  const loadOptions = async () => {
    sel.innerHTML = '';
    const data = await api('/api/stock');
    const items = (data && data.items) ? data.items : [];
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'Selecciona un material...';
    sel.appendChild(opt0);
    items.forEach(it => {
      const o = document.createElement('option');
      o.value = String(it.tipo || '');
      o.dataset.etiqueta = String(it.etiqueta || '');
      o.dataset.unidad = String(it.unidad || '');
      o.dataset.stock = String(it.cantidad != null ? it.cantidad : '');
      o.textContent = `${it.tipo || ''} | ${it.etiqueta || ''} | ${it.unidad || ''} | Stock: ${it.cantidad != null ? it.cantidad : 0}`;
      sel.appendChild(o);
    });
  };

  sel.addEventListener('change', () => {
    const opt = sel.options[sel.selectedIndex];
    const tipo = sel.value || '';
    const etiqueta = opt?.dataset?.etiqueta || '';
    const unidad = opt?.dataset?.unidad || '';

    // Rellenar el formulario principal de Recepción para evitar inconsistencias
    const form = document.querySelector('form[data-form="recepciones"]');
    if (form) {
      const inTipo = form.querySelector('input[name="tipo"]');
      const inEt = form.querySelector('input[name="etiqueta"]');
      const inUn = form.querySelector('input[name="unidad"]');
      if (inTipo) inTipo.value = tipo;
      if (inEt) inEt.value = etiqueta;
      if (inUn) inUn.value = unidad;
    }
    if (status) status.textContent = tipo ? `Seleccionado: ${tipo} (${etiqueta || '-'}, ${unidad || '-'})` : '';
  });

  btnToggle.addEventListener('click', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') return;
    const open = box.style.display === 'none' || !box.style.display;
    box.style.display = open ? 'block' : 'none';
    if (open) {
      try { await loadOptions(); } catch (err) { console.error(err); }
      if (!inpFecha.value) setNow();
    }
  });

  btnApply.addEventListener('click', async (e) => {
    e.preventDefault();
    if (window.__ROLE === 'operario') {
      alert('Solo visualización para Operario.');
      return;
    }
    const tipo = String(sel.value || '').trim();
    const cantidad = parseInt(String(inpQty.value || ''), 10);
    const fecha = String(inpFecha.value || '').trim();
    const opt = sel.options[sel.selectedIndex];
    const unidad = String(opt?.dataset?.unidad || '').trim();

    if (!tipo) { alert('Selecciona un material.'); return; }
    if (!Number.isFinite(cantidad) || cantidad < 0) { alert('Ingresa una cantidad base válida.'); return; }

    const doApply = async (confirmFlag) => {
      const body = { tipo, cantidad, unidad, fecha };
      if (confirmFlag) body.confirm_adjust = '1';
      return api('/api/recepciones/ajuste', { method: 'POST', body });
    };

    try {
      await doApply(false);
      if (status) status.textContent = 'Ajuste aplicado correctamente.';
      await renderStock().catch(() => {});
      await renderTable('recepciones').catch(() => {});
    } catch (err) {
      if (err && err.status === 409 && err.payload && err.payload.error === 'confirm_adjust_required') {
        const cur = err.payload.current || {};
        const msg =
          'Vas a aplicar un ajuste de stock.\n\n' +
          'Material: ' + String(cur.tipo || tipo) + '\n' +
          'Stock actual: ' + String((cur.stock_actual != null) ? cur.stock_actual : '-') + '\n' +
          'Nueva base: ' + String(cantidad) + '\n\n' +
          'Advertencia: los movimientos anteriores quedarán en el historial, pero dejarán de influir en el stock actual.\n' +
          '¿Deseas continuar?';
        const ok = confirm(msg);
        if (!ok) return;
        await doApply(true);
        if (status) status.textContent = 'Ajuste aplicado correctamente.';
        await renderStock().catch(() => {});
        await renderTable('recepciones').catch(() => {});
        return;
      }
      if (err && err.payload && err.payload.error === 'unit_mismatch') {
        alert('No se puede ajustar: la unidad debe coincidir con la ya registrada.');
        return;
      }
      console.error(err);
      alert('Error aplicando ajuste');
    }
  });
}

// Historial global de recepciones: eliminado por requerimiento

async function initPanel() {
  const me = await api('/me');
  if (!me.user) {
    location.href = '/';
    return;
  }

  document.getElementById('whoami').textContent =
    me.user.username + ' (' + me.user.role + ')';

  window.__ROLE = me.user.role;

  // Unidades: habilitar "Agregar unidad..." en todos los formularios
  initUnitSelectors();

  if (me.user.role === 'operario') {
    document.body.classList.add('readonly');
    document.body.classList.add('role-operario');
  } else if (me.user.role === 'administrador') {
    document.body.classList.add('role-admin');
  } else if (me.user.role === 'supervisor') {
    document.body.classList.add('role-supervisor');
  }

  ['recepciones', 'produccion', 'defectuosos', 'envios'].forEach(scope => {
    hookForm(scope);
    renderTable(scope).catch(err => {
      console.error(`Error cargando tabla ${scope}:`, err);
    });
  });

  // Recepciones: ajuste de stock
  initRecepcionesAjusteUI();

  // Stock de materiales
  initStockUI();
  initStockViewToggle();
  renderStock().catch(err => console.error('Error cargando stock:', err));

  // Maquinaria y Repuestos (solo supervisor)
  if (me.user.role === 'supervisor') {
    initMaquinariaUI();
    initRepuestosUI();
    renderMaquinaria().catch(err => console.error('Error cargando maquinaria:', err));
    renderRepuestos().catch(err => console.error('Error cargando repuestos:', err));
  }

  // Hook filtros (from/to) y exportaciones (PDF/XLSX) por sección
  document.querySelectorAll('[data-filter-apply]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.filterApply;
      const fromEl = document.querySelector(`[data-filter-from="${scope}"]`);
      const toEl = document.querySelector(`[data-filter-to="${scope}"]`);
      const qEl = document.querySelector(`[data-filter-q="${scope}"]`);
      const minEl = document.querySelector(`[data-filter-min="${scope}"]`);
      const maxEl = document.querySelector(`[data-filter-max="${scope}"]`);
      const from = fromEl ? String(fromEl.value || '') : '';
      const to = toEl ? String(toEl.value || '') : '';
      const q = qEl ? String(qEl.value || '').trim() : '';
      const min = minEl ? String(minEl.value || '').trim() : '';
      const max = maxEl ? String(maxEl.value || '').trim() : '';
      window.__filters[scope] = { from, to, q, min, max };
      try {
        resetPager(scope);
        await renderByScope(scope);
      } catch (err) {
        console.error('Error aplicando filtro:', err);
        alert('No se pudo aplicar el filtro. Revisa consola.');
      }
    });
  });

  document.querySelectorAll('[data-filter-all]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.filterAll;
      window.__filters[scope] = { from: '', to: '', q: '', min: '', max: '' };
      const fromEl = document.querySelector(`[data-filter-from="${scope}"]`);
      const toEl = document.querySelector(`[data-filter-to="${scope}"]`);
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      const qEl = document.querySelector(`[data-filter-q="${scope}"]`);
      const minEl = document.querySelector(`[data-filter-min="${scope}"]`);
      const maxEl = document.querySelector(`[data-filter-max="${scope}"]`);
      if (qEl) qEl.value = '';
      if (minEl) minEl.value = '';
      if (maxEl) maxEl.value = '';
      try {
        resetPager(scope);
        await renderByScope(scope);
      } catch (err) {
        console.error('Error mostrando todo:', err);
        alert('No se pudo refrescar la tabla. Revisa consola.');
      }
    });
  });

  
  // Limpiar filtros por sección
  document.querySelectorAll('[data-filter-clear]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.filterClear;
      const fromEl = document.querySelector(`[data-filter-from="${scope}"]`);
      const toEl = document.querySelector(`[data-filter-to="${scope}"]`);
      const qEl = document.querySelector(`[data-filter-q="${scope}"]`);
      const minEl = document.querySelector(`[data-filter-min="${scope}"]`);
      const maxEl = document.querySelector(`[data-filter-max="${scope}"]`);
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      if (qEl) qEl.value = '';
      if (minEl) minEl.value = '';
      if (maxEl) maxEl.value = '';
      window.__filters = window.__filters || {};
      window.__filters[scope] = { from: '', to: '', q: '', min: '', max: '' };
      try {
        resetPager(scope);
        await renderByScope(scope);
      } catch (err) {
        console.error('Error limpiando filtros:', err);
        alert('No se pudo refrescar la tabla.');
      }
    });
  });



  // Ordenamiento por tabla (fecha de creación / alfabético)
  document.querySelectorAll('[data-sort-scope]').forEach(sel => {
    const scope = sel.dataset.sortScope;
    if (scope && window.__sort && window.__sort[scope]) {
      sel.value = window.__sort[scope];
    }
    sel.addEventListener('change', async () => {
      const s = sel.dataset.sortScope;
      if (!s) return;
      window.__sort = window.__sort || {};
      window.__sort[s] = sel.value || 'date_desc';
      resetPager(s);
      if (s === 'event_logs') {
        // Se maneja dentro de initEventLogsUI
        return;
      }
      if (s === 'recep_hist') {
        // Ordenamiento del modal "Historial de entradas"
        try { renderRecepHistFromState(); } catch (e) { console.error(e); }
        return;
      }
      try {
        await renderByScope(s);
      } catch (err) {
        console.error('Error ordenando tabla:', err);
      }
    });
  });

  // Botón "Ahora" (fecha/hora actual Perú) en todos los módulos
  document.querySelectorAll('.now-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      if (!form) return;
      const dt = form.querySelector('input[type="datetime-local"]');
      const d = form.querySelector('input[type="date"]');
      if (dt) dt.value = getLimaNowForDatetimeLocal();
      else if (d) d.value = getLimaTodayForDate();
    });
  });

  function getLimaTodayForDate() {
    // YYYY-MM-DD en America/Lima
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function getLimaNowForDatetimeLocal() {
    // YYYY-MM-DDTHH:MM en America/Lima
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }
document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.export;
      const fmt = btn.dataset.format || 'pdf';
      const qs = (btn.dataset.all === '1') ? '' : buildFilterQuery(scope);
      // Evita bloqueos de pop-ups: para descargas usamos navegación directa.
      // En caso de PDF el navegador lo abrirá o descargará según configuración.
      window.location.href = `/api/${scope}.${fmt}${qs}`;
    });
  });

  // Botones PDF
  document.querySelectorAll('[data-pdf]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.pdf;
      // Si existe filtro activo en ese módulo, lo respetamos
      const qs = (window.__filters && window.__filters[type]) ? buildFilterQuery(type) : '';
      window.open(`/api/${type}.pdf${qs}`, '_blank');
    });
  });

  // Gestión de usuarios: SOLO supervisor o administrador
  const add = document.getElementById('addUser');
  const canManageUsers =
    me.user.role === 'supervisor' || me.user.role === 'administrador';

  if (add && canManageUsers) {
    add.addEventListener('click', async () => {
      const uname = document.getElementById('nu_user').value.trim();
      const role = document.getElementById('nu_role').value;
      const pass = document.getElementById('nu_pass').value;
      await api('/api/users', {
        method: 'POST',
        body: { username: uname, role, password: pass }
      });
      document.getElementById('nu_user').value = '';
      await renderUsers();
    });

    // Carga inicial de usuarios protegida por rol
    try {
      await renderUsers();
    } catch (err) {
      console.error('Error cargando usuarios:', err);
    }
  }


  if (me.user.role === 'supervisor') {
    initBackupUI().catch(err => console.error(err));
    initEventLogsUI().catch(err => console.error(err));
  }

  // Navegación: al hacer clic en el menú, mostrar solo la sección seleccionada.
  initMenuActiveAndSectionSwitch();
  // Botón Salir: debe funcionar PARA TODOS LOS ROLES
  const lo = document.getElementById('logoutBtn');
  if (lo) {
    lo.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (err) {
        console.error('Error en logout:', err);
      }
      location.href = '/';
    });
  }
}


/* ========= Navegación: mostrar SOLO la sección seleccionada ========= */
function initMenuActiveAndSectionSwitch(){
  const menuLinks = Array.from(document.querySelectorAll('.menu .menu-item[href^="#"]'));
  const sections = Array.from(document.querySelectorAll('main.workspace .section'));
  if (!menuLinks.length || !sections.length) return;

  const canShow = (id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.classList.contains('only-supervisor') && window.__ROLE !== 'supervisor') return false;
    return true;
  };

  const showByHash = (hash) => {
    const id = String(hash || '').replace('#','') || 'dashboard';
    const finalId = canShow(id) ? id : 'dashboard';

    sections.forEach(s => {
      s.style.display = (s.id === finalId) ? 'block' : 'none';
    });
    const finalHash = `#${finalId}`;
    menuLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === finalHash));
    try{ localStorage.setItem('brumap_last_hash', finalHash); }catch(e){}
  };

  menuLinks.forEach(a => {
    a.addEventListener('click', (e) => {
      const hash = a.getAttribute('href');
      if (!hash || hash === '#') return;
      const id = hash.replace('#','');
      if (!canShow(id)) return;
      e.preventDefault();
      history.replaceState(null, '', hash);
      showByHash(hash);
    });
  });

  const initialHash = location.hash || (() => { try{ return localStorage.getItem('brumap_last_hash') || '#dashboard'; }catch(e){ return '#dashboard'; } })();
  showByHash(initialHash);
}


document.addEventListener('DOMContentLoaded', () => {

// ===== Menú móvil (drawer) =====
(function setupMobileMenu(){
  const btn = document.getElementById('btnMobileMenu');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 920px)').matches;

  const open = () => {
    if (!isMobile()) return;
    document.body.classList.add('sidebar-open');
    if (overlay) overlay.setAttribute('aria-hidden', 'false');
  };

  const close = () => {
    document.body.classList.remove('sidebar-open');
    if (overlay) overlay.setAttribute('aria-hidden', 'true');
  };

  if (btn) btn.addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) close();
    else open();
  });

  if (overlay) overlay.addEventListener('click', close);

  // Cierra al navegar en móvil
  document.querySelectorAll('.menu a.menu-item, .menu-item').forEach(a => {
    a.addEventListener('click', () => { if (isMobile()) close(); });
  });

  // Si se redimensiona a desktop, asegura estado limpio
  window.addEventListener('resize', () => {
    if (!isMobile()) close();
  });
})();


// ===== Tema (claro/oscuro) =====
const THEME_KEY = 'brumapp_theme';
const applyTheme = (t) => {
  document.body.classList.toggle('theme-light', t === 'light');
};
try{
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}catch(e){}
const themeBtn = document.getElementById('themeToggle');
if (themeBtn){
  themeBtn.addEventListener('click', () => {
    const isLight = document.body.classList.contains('theme-light');
    const next = isLight ? 'dark' : 'light';
    applyTheme(next);
    try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
  });
}


  // Inicializar panel cuando existe la interfaz principal, sin depender del pathname.
  if (document.getElementById('dashboard') || document.getElementById('almacen')) {
    initPanel().catch(err => console.error('Error inicializando panel:', err));
  }
});
// ==========================================================
// UI PRO BRUMAP - mejoras compatibles sin modificar backend
// ==========================================================
(function initBrumapUiPro(){
  function goToHash(hash){
    if(!hash) return;
    const target = String(hash).startsWith('#') ? String(hash) : ('#' + String(hash));
    const link = document.querySelector(`.menu a[href="${target}"]`);
    if(link){ link.click(); return; }
    location.hash = target;
  }

  async function safeCount(endpoint){
    try{
      const data = await api(endpoint);
      if(data && Array.isArray(data.items)) return data.items.length;
      if(Array.isArray(data)) return data.length;
    }catch(e){}
    return 0;
  }

  async function refreshDashboardKpis(){
    try{
      const d = await api('/api/pro/dashboard');
      const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = String(v ?? '0'); };
      set('kpiRecepciones', d.materiales || 0);
      set('kpiStock', d.stock_bajo || 0);
      set('kpiProduccion', d.productos_terminados || 0);
      set('kpiEnvios', d.envios_30d || 0);
      set('kpiAlertas', d.ordenes_abiertas || 0);
      const sub = document.getElementById('kpiStockTotal');
      if(sub) sub.textContent = 'Materiales bajo mínimo';
    }catch(e){ console.warn('No se pudo actualizar KPIs de almacén', e); }
  }

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('[data-go]').forEach(btn=>{
      btn.addEventListener('click', function(){ goToHash(btn.getAttribute('data-go')); });
    });

    // Si no hay hash guardado explícito, iniciar en dashboard.
    try{
      if(!location.hash && !localStorage.getItem('brumap_last_hash')){
        history.replaceState(null,'','#dashboard');
      }
    }catch(e){}

    // Asegurar que dashboard sea visible como módulo permitido.
    setTimeout(function(){
      const dashLink = document.querySelector('.menu a[href="#dashboard"]');
      if(dashLink && (!location.hash || location.hash === '#dashboard')){
        // No forzar si el usuario ya venía trabajando en recepción; solo cargar KPIs.
      }
      refreshDashboardKpis();
    }, 450);

    // Refrescar KPIs cuando se navega de vuelta al dashboard.
    window.addEventListener('hashchange', function(){
      if(location.hash === '#dashboard') refreshDashboardKpis();
    });
  });
})();

// =============================================================================
// MÓDULO ALMACÉN: trazabilidad, escaneo por pistola/nombre y productos terminados
// =============================================================================
(function initAlmacenModule(){
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v ?? ''); };
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtNum = (v) => Number(v || 0).toLocaleString('es-PE');
  const val = (id) => String(document.getElementById(id)?.value || '').trim();
  const refreshDashboardGlobal = () => {
    if (typeof window.refreshDashboardBrumap === 'function') {
      window.refreshDashboardBrumap().catch(err => console.warn('No se pudo refrescar dashboard global', err));
    }
  };

  async function proApi(path, opt={}) { return api('/api/pro' + path, opt); }

  function qsFrom(prefix){
    const params = new URLSearchParams();
    const q = val(prefix + 'Search');
    const from = val(prefix + 'From');
    const to = val(prefix + 'To');
    if (q) params.set('q', q);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const s = params.toString();
    return s ? '?' + s : '';
  }

  function renderRows(tbody, rows, cols, empty='Sin registros'){
    if(!tbody) return;
    tbody.innerHTML = '';
    if(!rows || !rows.length){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${cols.length}" class="subtitle">${empty}</td>`;
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = cols.map(fn => `<td>${fn(row)}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function setDatalist(id, items, buildValues){
    const dl = document.getElementById(id);
    if(!dl) return;
    const seen = new Set();
    const values = [];
    (items || []).forEach(item => {
      (buildValues(item) || []).forEach(v => {
        const s = String(v || '').trim();
        if(!s || seen.has(s.toLowerCase())) return;
        seen.add(s.toLowerCase());
        values.push(s);
      });
    });
    dl.innerHTML = values.slice(0, 400).map(v => `<option value="${esc(v)}"></option>`).join('');
  }

  async function refreshProDashboard(){
    try{
      const d = await proApi('/dashboard');
      setText('proKpiMateriales', d.materiales || 0);
      setText('proKpiBajo', d.stock_bajo || 0);
      setText('proKpiTerminados', d.productos_terminados || 0);
      setText('proKpiOP', d.ordenes_abiertas || 0);
      setText('kpiRecepciones', d.materiales || 0);
      setText('kpiStock', d.stock_bajo || 0);
      setText('kpiProduccion', d.productos_terminados || 0);
      setText('kpiEnvios', d.envios_30d || 0);
      setText('kpiAlertas', d.ordenes_abiertas || 0);
    }catch(e){ console.warn('No se pudo cargar dashboard de almacén', e); }
  }

  async function loadProveedores(){
    const data = await proApi('/proveedores');
    const items = data.items || [];
    renderRows($('#proProveedorTable tbody'), items, [
      r=>esc(r.nombre), r=>esc(r.ruc), r=>esc(r.telefono), r=>esc(r.contacto), r=>esc(r.correo)
    ]);
    const sel = $('#proMaterialProveedor');
    if(sel){
      const cur = sel.value;
      sel.innerHTML = '<option value="">Proveedor</option>' + items.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join('');
      sel.value = cur;
    }
  }

  async function loadClientes(){
    const data = await proApi('/clientes');
    const items = data.items || [];
    renderRows($('#proClienteTable tbody'), items, [
      r=>esc(r.nombre), r=>esc(r.documento), r=>esc(r.telefono), r=>esc(r.contacto), r=>esc(r.direccion)
    ]);
    ['proTerminadoCliente','proEnvioCliente'].forEach(id => {
      const sel = document.getElementById(id);
      if(sel){
        const cur = sel.value;
        sel.innerHTML = `<option value="">${id === 'proEnvioCliente' ? 'Cliente' : 'Cliente relacionado'}</option>` + items.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join('');
        sel.value = cur;
      }
    });
  }

  async function loadMateriales(){
    const data = await proApi('/materiales' + qsFrom('proMaterial'));
    const items = data.items || [];
    window.__ALMACEN_MATERIALES = items;
    setDatalist('proMaterialOptions', items, r => [r.codigo_barra, r.tipo]);
    renderRows($('#proMaterialTable tbody'), items, [
      r=>`<button class="table-link" type="button" data-use-material="${esc(r.codigo_barra || r.tipo)}"><code>${esc(r.codigo_barra || '-')}</code></button>`,
      r=>`<button class="table-link text-left" type="button" data-use-material="${esc(r.tipo)}"><b>${esc(r.tipo)}</b></button><br><small>${esc(r.categoria || '')}${r.etiqueta ? ' · Lote: ' + esc(r.etiqueta) : ''}</small>`,
      r=>`<b>${fmtNum(r.stock_actual || 0)}</b>`,
      r=>`<span class="stock-pill stock-${String(r.estado_stock || 'OK').toLowerCase().replace('í','i')}">${esc(r.estado_stock || 'OK')}</span>`,
      r=>esc(r.unidad || ''),
      r=>esc(r.ubicacion || ''),
      r=>esc(r.proveedor || ''),
      r=>`<button class="btn-small btn-white" type="button" data-use-material="${esc(r.codigo_barra || r.tipo)}">Usar</button>`
    ]);
    $$('#proMaterialTable [data-use-material]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.useMaterial || '';
        const input = $('#proScanCode');
        if(input) { input.value = v; input.focus(); }
      });
    });
    await refreshProDashboard();
  }

  async function loadKardex(){
    const data = await proApi('/kardex' + qsFrom('proKardex'));
    renderRows($('#proKardexTable tbody'), data.items || [], [
      r=>esc(formatDateForTable(r.fecha || r.created_at, true)),
      r=>`<code>${esc(r.codigo_barra || '-')}</code>`,
      r=>esc(r.tipo),
      r=>esc(r.movimiento),
      r=>esc(r.entrada),
      r=>esc(r.salida),
      r=>`<b>${esc(r.saldo)}</b>`,
      r=>esc(r.username || ''),
      r=>esc(r.observacion || '')
    ]);
  }

  async function loadConteos(){
    const data = await proApi('/conteos');
    renderRows($('#proConteoTable tbody'), data.items || [], [
      r=>esc(formatDateForTable(r.fecha || r.created_at, true)),
      r=>`<code>${esc(r.codigo_barra || '-')}</code>`,
      r=>esc(r.tipo),
      r=>esc(r.stock_sistema),
      r=>esc(r.stock_fisico),
      r=>`<b>${esc(r.diferencia)}</b>`,
      r=>esc(r.username || ''),
      r=>esc(r.motivo || '')
    ]);
  }

  async function loadTerminados(){
    const data = await proApi('/productos-terminados' + qsFrom('proTerminado'));
    const items = data.items || [];
    window.__ALMACEN_TERMINADOS = items;
    setDatalist('proProductoOptions', items, r => [r.codigo_barra, r.producto]);
    renderRows($('#proTerminadoTable tbody'), items, [
      r=>`<button class="table-link" type="button" data-fill-product="${esc(r.producto)}" data-fill-code="${esc(r.codigo_barra || '')}"><code>${esc(r.codigo_barra || '-')}</code></button>`,
      r=>`<button class="table-link text-left" type="button" data-fill-product="${esc(r.producto)}" data-fill-code="${esc(r.codigo_barra || '')}"><b>${esc(r.producto)}</b></button>`,
      r=>`<b>${fmtNum(r.stock || 0)}</b>`,
      r=>esc(r.unidad || ''),
      r=>esc(r.cliente || ''),
      r=>esc(r.descripcion || '')
    ]);
    $$('#proTerminadoTable [data-fill-product]').forEach(btn => {
      btn.addEventListener('click', () => fillProductoForm(btn.dataset.fillProduct || '', btn.dataset.fillCode || ''));
    });
    await loadTerminadoMovimientos();
    await refreshProDashboard();
  }

  async function loadTerminadoMovimientos(){
    const data = await proApi('/productos-terminados-movimientos' + qsFrom('proTerminado'));
    renderRows($('#proTerminadoMovTable tbody'), data.items || [], [
      r=>esc(formatDateForTable(r.fecha || r.created_at, true)),
      r=>esc(r.producto),
      r=>esc(r.movimiento),
      r=>esc(r.entrada),
      r=>esc(r.salida),
      r=>`<b>${esc(r.saldo)}</b>`,
      r=>esc(r.cliente || ''),
      r=>esc(r.observacion || '')
    ]);
  }

  async function loadEnviosTerminados(){
    const data = await proApi('/envios-terminados' + qsFrom('proEnvio'));
    renderRows($('#proEnvioTable tbody'), data.items || [], [
      r=>esc(formatDateForTable(r.fecha || r.created_at, true)),
      r=>`<code>${esc(r.codigo_barra || '-')}</code>`,
      r=>esc(r.producto),
      r=>esc(r.cliente || ''),
      r=>esc(r.cantidad),
      r=>esc(r.unidad || ''),
      r=>esc(r.username || ''),
      r=>esc(r.observacion || '')
    ]);
    await refreshProDashboard();
  }

  async function loadOrdenes(){
    const data = await proApi('/ordenes-produccion');
    renderRows($('#proOrdenTable tbody'), data.items || [], [
      r=>`<code>${esc(r.codigo || '-')}</code>`,
      r=>esc(r.producto),
      r=>esc(r.cantidad_planificada),
      r=>esc(r.cantidad_producida),
      r=>`<span class="tag">${esc(r.estado)}</span>`,
      r=>esc(formatDateForTable(r.fecha_inicio || r.fecha, false)),
      r=>esc(formatDateForTable(r.fecha_final || '', false))
    ]);
    await refreshProDashboard();
  }

  function fillProductoForm(producto, codigo){
    const form = document.getElementById('proTerminadoForm');
    if(!form) return;
    if(form.elements.producto) form.elements.producto.value = producto || '';
    if(form.elements.codigo_barra) form.elements.codigo_barra.value = codigo || '';
    if(form.elements.cantidad) form.elements.cantidad.focus();
  }

  function hookSimpleForm(formId, endpoint, after, statusId){
    const form = document.getElementById(formId);
    if(!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (window.__ROLE === 'operario') { alert('Solo visualización para Operario.'); return; }
      const payload = Object.fromEntries(new FormData(form).entries());
      try{
        const r = await proApi(endpoint, { method:'POST', body: payload });
        form.reset();
        if(statusId) setText(statusId, r.stock_actual != null ? `Registrado. Stock actual: ${r.stock_actual}` : 'Registrado correctamente.');
        if(after) await after();
        await refreshProDashboard();
        refreshDashboardGlobal();
      }catch(err){
        console.error(err);
        const code = err.payload?.error || '';
        if (code === 'stock-insuficiente') alert(`Stock insuficiente. Stock actual: ${err.payload.stock}`);
        else if (code === 'material-not-found') alert('No se encontró el material. Regístralo en Catálogo de materiales o escribe más letras hasta que aparezca.');
        else if (code === 'producto-not-found') alert('No se encontró el producto terminado. Regístralo primero en Productos terminados.');
        else alert('No se pudo guardar. Revisa duplicados o datos incompletos.');
      }
    });
  }

  async function registerMovimiento(){
    if (window.__ROLE === 'operario') { alert('Solo visualización para Operario.'); return; }
    const status = $('#proScanStatus');
    const payload = {
      codigo_barra: $('#proScanCode')?.value || '',
      accion: $('#proScanAccion')?.value || 'entrada',
      cantidad: $('#proScanCantidad')?.value || '1',
      fecha: $('#proScanFecha')?.value || '',
      observacion: $('#proScanObs')?.value || ''
    };
    if(!payload.codigo_barra){
      alert('Escanea un código o escribe el nombre del material.');
      return;
    }
    try{
      const r = await proApi('/movimiento', { method:'POST', body: payload });
      if(status) status.textContent = `Movimiento registrado para ${r.material || 'material'}. Stock actual: ${r.stock_actual}`;
      $('#proScanCode').value = '';
      $('#proScanCantidad').value = '1';
      $('#proScanObs').value = '';
      $('#proScanCode').focus();
      await Promise.all([loadMateriales(), loadKardex(), refreshProDashboard()]);
      refreshDashboardGlobal();
    }catch(err){
      console.error(err);
      if(status) {
        if(err.payload?.error === 'stock-insuficiente') status.textContent = `Stock insuficiente. Stock actual: ${err.payload.stock}`;
        else if(err.payload?.error === 'material-not-found') status.textContent = 'No se encontró el material. Regístralo o escribe más letras hasta seleccionar una coincidencia.';
        else status.textContent = 'No se pudo registrar el movimiento.';
      }
    }
  }

  async function loadTab(tab){
    $$('.pro-panel').forEach(p => p.style.display = p.dataset.proPanel === tab ? '' : 'none');
    $$('.pro-tab').forEach(b=>b.classList.toggle('active', b.dataset.proTab === tab));
    if(tab==='materiales') await loadMateriales();
    else if(tab==='kardex') await loadKardex();
    else if(tab==='conteo') await loadConteos();
    else if(tab==='proveedores') await loadProveedores();
    else if(tab==='clientes') await loadClientes();
    else if(tab==='terminados') await loadTerminados();
    else if(tab==='ordenes') await loadOrdenes();
    else if(tab==='envios-terminados') await loadEnviosTerminados();
  }

  function initTabs(){
    const tabsWrap = document.querySelector('.pro-tabs');
    if(!tabsWrap || tabsWrap.dataset.bound === '1') return;
    tabsWrap.dataset.bound = '1';
    tabsWrap.addEventListener('click', async (e) => {
      const btn = e.target.closest('.pro-tab');
      if(!btn) return;
      e.preventDefault();
      const tab = btn.dataset.proTab || 'materiales';
      try { await loadTab(tab); }
      catch(err) { console.error('Error cargando pestaña de almacén:', err); alert('No se pudo cargar esta pestaña. Revisa la conexión o permisos.'); }
    });
    const active = document.querySelector('.pro-tab.active')?.dataset.proTab || 'materiales';
    loadTab(active).catch(err => console.warn('No se pudo cargar pestaña inicial de almacén', err));
  }

  function initScannerHelpers(){
    $$('.barcode-input').forEach(input => {
      input.setAttribute('autocomplete','off');
      input.addEventListener('keydown', async (e) => {
        if(e.key === 'Enter'){
          e.preventDefault();
          if(input.id === 'proScanCode') await registerMovimiento();
          else input.form?.requestSubmit?.();
        }
      });
    });
    $('#proScanCode')?.addEventListener('input', debounce(loadMateriales, 250));
  }

  function debounce(fn, ms){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args).catch?.(()=>{}), ms); };
  }

  function initFilters(){
    const pairs = [
      ['proRefreshMateriales', loadMateriales], ['proMaterialSearch', debounce(loadMateriales, 250)],
      ['proRefreshKardex', loadKardex], ['proKardexSearch', debounce(loadKardex, 250)],
      ['proRefreshTerminados', loadTerminados], ['proTerminadoSearch', debounce(loadTerminados, 250)],
      ['proRefreshEnvios', loadEnviosTerminados], ['proEnvioSearch', debounce(loadEnviosTerminados, 250)]
    ];
    pairs.forEach(([id, fn]) => {
      const el = document.getElementById(id);
      if(!el) return;
      const ev = el.tagName === 'INPUT' ? 'input' : 'click';
      el.addEventListener(ev, e => { if(ev === 'click') e.preventDefault(); fn().catch(console.error); });
    });
    ['proMaterialFrom','proMaterialTo'].forEach(id => document.getElementById(id)?.addEventListener('change', () => loadMateriales().catch(console.error)));
    ['proKardexFrom','proKardexTo'].forEach(id => document.getElementById(id)?.addEventListener('change', () => loadKardex().catch(console.error)));
    ['proTerminadoFrom','proTerminadoTo'].forEach(id => document.getElementById(id)?.addEventListener('change', () => loadTerminados().catch(console.error)));
    ['proEnvioFrom','proEnvioTo'].forEach(id => document.getElementById(id)?.addEventListener('change', () => loadEnviosTerminados().catch(console.error)));
  }

  function initProExports(){
    $$('[data-pro-export-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.proExportUrl;
        const prefix = btn.dataset.proFilter || '';
        const qs = prefix ? qsFrom(prefix) : '';
        window.location.href = url + qs;
      });
    });
  }

  function init(){
    if(!document.getElementById('almacen')) return;
    initTabs();
    initScannerHelpers();
    initFilters();
    initProExports();
    hookSimpleForm('proProveedorForm','/proveedores', loadProveedores);
    hookSimpleForm('proClienteForm','/clientes', loadClientes);
    hookSimpleForm('proMaterialForm','/materiales', async()=>{ await loadMateriales(); await loadProveedores(); });
    hookSimpleForm('proTerminadoForm','/productos-terminados', loadTerminados);
    hookSimpleForm('proOrdenForm','/ordenes-produccion', loadOrdenes);
    hookSimpleForm('proEnvioTerminadoForm','/envios-terminados', async()=>{ await loadEnviosTerminados(); await loadTerminados(); }, 'proEnvioStatus');
    const conteoForm = document.getElementById('proConteoForm');
    if(conteoForm){
      conteoForm.addEventListener('submit', async (e)=>{
        e.preventDefault();
        if (window.__ROLE === 'operario') { alert('Solo visualización para Operario.'); return; }
        const payload = Object.fromEntries(new FormData(conteoForm).entries());
        try{
          const r = await proApi('/conteo', { method:'POST', body: payload });
          setText('proConteoStatus', `Conteo guardado. Sistema: ${r.stock_sistema}, físico: ${r.stock_fisico}, diferencia: ${r.diferencia}`);
          conteoForm.reset();
          await Promise.all([loadConteos(), loadMateriales(), loadKardex(), refreshProDashboard()]);
          refreshDashboardGlobal();
        }catch(err){ console.error(err); setText('proConteoStatus','No se pudo guardar el conteo. Verifica que el material exista.'); }
      });
    }
    $('#proBtnMovimiento')?.addEventListener('click', registerMovimiento);
    refreshProDashboard();
    loadProveedores().catch(()=>{});
    loadClientes().catch(()=>{});
    loadMateriales().catch(()=>{});
    loadTerminados().catch(()=>{});
    refreshDashboardGlobal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.refreshAlmacenPro = async function(){
    await Promise.all([refreshProDashboard(), loadProveedores(), loadClientes(), loadMateriales(), loadKardex(), loadConteos(), loadTerminados(), loadOrdenes(), loadEnviosTerminados()]);
  };
})();
