/**
 * BRUMAP Dashboard Pro — Charts & KPIs avanzados
 * Usa Chart.js si está disponible; si no carga, mantiene KPIs, resumen y listas visibles
 */
(function initDashboardPro() {
  'use strict';

  // ─── Utilidades ────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt = n => Number(n || 0).toLocaleString('es-AR');

  // Paleta coherente con el tema naranja de Brumap
  const COLORS = [
    '#ff8c1a','#ffad42','#e05a00','#ffd480',
    '#c44d00','#ffbf60','#7c3a00','#ffcf90'
  ];
  const COLORS_FADE = COLORS.map(c => c + 'aa');

  let charts = {}; // instancias Chart.js para poder destruirlas al refrescar

  // ─── Tema dinámico para Chart.js ───────────────────────────────────────────
  function getThemeColors() {
    const isLight = document.body.classList.contains('theme-light');
    return {
      text:   isLight ? '#111827' : '#e8e8e8',
      muted:  isLight ? '#6b7280' : '#bdbdbd',
      grid:   isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)',
      bg:     isLight ? '#ffffff' : '#2a2c31',
    };
  }

  function chartDefaults() {
    if (typeof Chart === 'undefined') return;
    const t = getThemeColors();
    Chart.defaults.color = t.text;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.font.family = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
    Chart.defaults.font.size = 12;
  }

  // ─── Fetch helper ──────────────────────────────────────────────────────────
  async function apiFetch(url) {
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ─── Agrupadores ───────────────────────────────────────────────────────────
  function groupByField(items, field, valueField = null) {
    const map = {};
    for (const item of (items || [])) {
      const key = item[field] || 'Sin clasificar';
      if (valueField) {
        map[key] = (map[key] || 0) + (Number(item[valueField]) || 0);
      } else {
        map[key] = (map[key] || 0) + 1;
      }
    }
    return map;
  }

  function sortedEntries(map, topN = 8) {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN);
  }

  // Agrupar por semana (últimas N semanas)
  function groupByWeek(items, dateField, valueField = null, weeks = 8) {
    const now = new Date();
    const result = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const label = `S${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      result.push({ label, count: 0, value: 0, date: d });
    }
    for (const item of (items || [])) {
      const dt = new Date(item[dateField] || item.created_at);
      if (isNaN(dt)) continue;
      for (const bucket of result) {
        const diff = (bucket.date - dt) / (1000 * 60 * 60 * 24);
        if (diff >= 0 && diff < 7) {
          bucket.count++;
          bucket.value += Number(item[valueField]) || 0;
          break;
        }
      }
    }
    return result;
  }

  // Agrupar por mes (últimos N meses)
  function groupByMonth(items, dateField, weeks = 6) {
    const now = new Date();
    const buckets = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleDateString('es-AR', { month: 'short', year:'2-digit' });
      buckets.push({ label, count: 0, value: 0, year: d.getFullYear(), month: d.getMonth() });
    }
    for (const item of (items || [])) {
      const dt = new Date(item[dateField] || item.created_at);
      if (isNaN(dt)) continue;
      const b = buckets.find(x => x.year === dt.getFullYear() && x.month === dt.getMonth());
      if (b) { b.count++; b.value += Number(item.cantidad) || 0; }
    }
    return buckets;
  }

  // ─── Destruir chart anterior ────────────────────────────────────────────────
  function destroyChart(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  // ─── Crear charts ───────────────────────────────────────────────────────────

  function renderChartEntradas(items) {
    destroyChart('chartRecepciones');
    const canvas = $('chartRecepciones');
    if (!canvas) return;
    if (typeof Chart === 'undefined') { showEmpty(canvas, 'Gráfico disponible al cargar Chart.js'); return; }
    const t = getThemeColors();
    const map = groupByField(items, 'tipo');
    const entries = sortedEntries(map, 8);
    if (!entries.length) { showEmpty(canvas, 'Sin entradas registradas aún'); return; }
    charts.chartRecepciones = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(e => e[0]),
        datasets: [{
          label: 'Entradas',
          data: entries.map(e => e[1]),
          backgroundColor: COLORS_FADE,
          borderColor: COLORS,
          borderWidth: 2,
          borderRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: ctx => ` ${ctx.parsed.y} registros`
        }}},
        scales: {
          x: { ticks: { color: t.muted, maxRotation: 30 }, grid: { color: t.grid } },
          y: { ticks: { color: t.muted, precision: 0 }, grid: { color: t.grid } }
        }
      }
    });
  }

  function renderChartStock(items) {
    destroyChart('chartStock');
    const canvas = $('chartStock');
    if (!canvas) return;
    if (typeof Chart === 'undefined') { showEmpty(canvas, 'Gráfico disponible al cargar Chart.js'); return; }
    const t = getThemeColors();
    const map = groupByField(items, 'tipo', 'cantidad');
    const entries = sortedEntries(map, 8);
    if (!entries.length) { showEmpty(canvas, 'Sin datos de stock aún'); return; }
    charts.chartStock = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: entries.map(e => e[0]),
        datasets: [{
          data: entries.map(e => e[1]),
          backgroundColor: COLORS_FADE,
          borderColor: COLORS,
          borderWidth: 2,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: t.text, boxWidth: 12, padding: 10, font: { size: 11 } }
          },
          tooltip: { callbacks: {
            label: ctx => ` ${ctx.label}: ${fmt(ctx.parsed)} uds`
          }}
        }
      }
    });
  }

  function renderChartTendencia(receps, envios) {
    destroyChart('chartTendencia');
    const canvas = $('chartTendencia');
    if (!canvas) return;
    if (typeof Chart === 'undefined') { showEmpty(canvas, 'Gráfico disponible al cargar Chart.js'); return; }
    const t = getThemeColors();
    const rBuckets = groupByMonth(receps, 'fecha');
    const eBuckets = groupByMonth(envios, 'fecha');
    const labels = rBuckets.map(b => b.label);

    charts.chartTendencia = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Entradas',
            data: rBuckets.map(b => b.count),
            borderColor: '#ff8c1a',
            backgroundColor: 'rgba(255,140,26,0.12)',
            borderWidth: 2.5,
            pointRadius: 4,
            pointBackgroundColor: '#ff8c1a',
            tension: 0.35,
            fill: true,
          },
          {
            label: 'Envíos',
            data: eBuckets.map(b => b.count),
            borderColor: '#ffad42',
            backgroundColor: 'rgba(255,173,66,0.08)',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#ffad42',
            tension: 0.35,
            fill: true,
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: t.text, boxWidth: 12, padding: 16 } }
        },
        scales: {
          x: { ticks: { color: t.muted }, grid: { color: t.grid } },
          y: { ticks: { color: t.muted, precision: 0 }, grid: { color: t.grid } }
        }
      }
    });
  }

  function renderChartDefectuosos(items) {
    destroyChart('chartDefectuosos');
    const canvas = $('chartDefectuosos');
    if (!canvas) return;
    if (typeof Chart === 'undefined') { showEmpty(canvas, 'Gráfico disponible al cargar Chart.js'); return; }
    const t = getThemeColors();
    const map = groupByField(items, 'tipo');
    const entries = sortedEntries(map, 6);
    if (!entries.length) { showEmpty(canvas, 'Sin defectuosos registrados'); return; }
    charts.chartDefectuosos = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(e => e[0]),
        datasets: [{
          label: 'Defectuosos',
          data: entries.map(e => e[1]),
          backgroundColor: 'rgba(220,53,69,0.55)',
          borderColor: '#dc3545',
          borderWidth: 2,
          borderRadius: 6,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.muted, precision: 0 }, grid: { color: t.grid } },
          y: { ticks: { color: t.muted } }
        }
      }
    });
  }

  // ─── Placeholder cuando no hay datos ───────────────────────────────────────
  function showEmpty(canvas, msg) {
    const ctx = canvas.getContext('2d');
    const t = getThemeColors();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = t.muted;
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

  // ─── KPIs avanzados ────────────────────────────────────────────────────────
  function setKpi(id, value, extra = '') {
    const el = $(id);
    if (!el) return;
    el.textContent = fmt(value);
    if (extra) {
      let badge = el.nextElementSibling;
      if (!badge || !badge.classList.contains('kpi-badge')) {
        badge = document.createElement('span');
        badge.className = 'kpi-badge';
        el.parentNode.insertBefore(badge, el.nextSibling);
      }
      badge.textContent = extra;
    }
  }

  // ─── Alertas de stock crítico ───────────────────────────────────────────────
  function renderAlertas(stockItems) {
    const container = $('dashAlertas');
    if (!container) return;
    const criticos = (stockItems || []).filter(s => Number(s.cantidad) <= 5 && Number(s.cantidad) > 0);
    const agotados = (stockItems || []).filter(s => Number(s.cantidad) <= 0);

    // Actualizar badge contador
    const badge = $('alertasBadge');
    const total = criticos.length + agotados.length;
    if (badge) {
      badge.textContent = total;
      badge.style.display = total > 0 ? 'inline-flex' : 'none';
    }

    if (!total) {
      container.innerHTML = `<div class="dash-empty-state">
        <div class="dash-empty-icon">✓</div>
        <p>Todo el stock en niveles normales</p>
      </div>`;
      return;
    }

    let html = '';
    for (const item of agotados.slice(0, 5)) {
      html += `<div class="alerta-row alerta-agotado">
        <span class="alerta-dot"></span>
        <div class="alerta-info">
          <strong>${esc(item.tipo)}</strong>
          <small>Stock agotado</small>
        </div>
        <span class="alerta-qty">0</span>
      </div>`;
    }
    for (const item of criticos.slice(0, 8)) {
      html += `<div class="alerta-row alerta-critico">
        <span class="alerta-dot"></span>
        <div class="alerta-info">
          <strong>${esc(item.tipo)}</strong>
          <small>Stock bajo</small>
        </div>
        <span class="alerta-qty">${fmt(item.cantidad)} ${esc(item.unidad || '')}</span>
      </div>`;
    }
    container.innerHTML = html;
  }

  // ─── Actividad reciente combinada ──────────────────────────────────────────
  function renderActividad(receps, prod, envios, defect) {
    const container = $('dashActividad');
    if (!container) return;

    const events = [];
    const push = (arr, tipo, label, dateField, colorClass) => {
      for (const item of (arr || []).slice(0, 5)) {
        events.push({
          fecha: new Date(item[dateField] || item.created_at),
          tipo, label,
          desc: item.tipo || item.cliente || '—',
          cantidad: item.cantidad,
          unidad: item.unidad || '',
          colorClass,
        });
      }
    };

    push(receps,  'recep',  'Recepción',   'created_at', 'act-recep');
    push(prod,    'prod',   'Producción',  'created_at', 'act-prod');
    push(envios,  'envio',  'Envío',       'created_at', 'act-envio');
    push(defect,  'defect', 'Defectuoso',  'created_at', 'act-defect');

    events.sort((a, b) => b.fecha - a.fecha);
    const top = events.slice(0, 10);

    if (!top.length) {
      container.innerHTML = `<div class="dash-empty-state"><p>Sin actividad reciente</p></div>`;
      return;
    }

    container.innerHTML = top.map(ev => {
      const dateStr = isNaN(ev.fecha) ? '—' :
        ev.fecha.toLocaleDateString('es-AR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
      return `<div class="act-row">
        <span class="act-badge ${ev.colorClass}">${ev.label}</span>
        <div class="act-info">
          <strong>${esc(ev.desc)}</strong>
          <small>${dateStr}</small>
        </div>
        <span class="act-cant">${ev.cantidad ? fmt(ev.cantidad) + ' ' + esc(ev.unidad) : ''}</span>
      </div>`;
    }).join('');
  }

  // ─── Resumen de producción (mini tabla) ────────────────────────────────────
  function renderResumenProduccion(items) {
    const container = $('dashProduccionResumen');
    if (!container) return;
    const top = (items || []).slice(0, 6);
    if (!top.length) {
      container.innerHTML = `<div class="dash-empty-state"><p>Sin órdenes registradas</p></div>`;
      return;
    }
    container.innerHTML = `<table class="dash-mini-table">
      <thead><tr><th>OP</th><th>Producto</th><th>Estado</th><th>Final</th></tr></thead>
      <tbody>${top.map(it => `<tr>
        <td>${esc(it.codigo || '—')}</td>
        <td>${esc(it.producto || '—')}</td>
        <td>${esc(it.estado || '—')}</td>
        <td>${it.fecha_final ? esc(it.fecha_final) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderApartadosResumen(summary, fallback = {}) {
    const container = $('dashApartadosResumen');
    if (!container) return;
    const s = summary || {};
    const rows = [
      ['Catálogo de materiales', s.materiales ?? fallback.materiales ?? 0, 'Materiales activos registrados'],
      ['Kardex', s.kardex_movimientos ?? fallback.kardex ?? 0, 'Entradas, dispensamientos, ajustes y conteos'],
      ['Conteos físicos', s.conteos_fisicos ?? fallback.conteos ?? 0, 'Verificaciones físicas realizadas'],
      ['Proveedores', s.proveedores ?? fallback.proveedores ?? 0, 'Proveedores del almacén'],
      ['Clientes', s.clientes ?? fallback.clientes ?? 0, 'Clientes relacionados'],
      ['Productos terminados', s.productos_terminados ?? fallback.terminados ?? 0, 'Productos terminados activos'],
      ['Órdenes abiertas', s.ordenes_abiertas ?? fallback.ordenes ?? 0, 'Pendientes o en proceso'],
      ['Envíos terminados', s.envios_30d ?? fallback.envios ?? 0, 'Envíos de los últimos 30 días'],
      ['Defectuosos', s.defectuosos ?? fallback.defectuosos ?? 0, 'Registros de material rechazado'],
      ['Maquinaria', s.maquinaria ?? fallback.maquinaria ?? 0, 'Equipos registrados'],
      ['Repuestos', s.repuestos ?? fallback.repuestos ?? 0, 'Repuestos registrados'],
    ];
    container.innerHTML = rows.map(([label, value, desc]) => `<div class="dash-apartado-item">
      <strong>${fmt(value)}</strong>
      <span>${esc(label)}</span>
      <small>${esc(desc)}</small>
    </div>`).join('');
  }

  // ─── Dashboard principal: carga todos los datos ────────────────────────────
  async function loadDashboard() {
    showLoadingState(true);

    const [matRes, kardexRes, conteoRes, provRes, cliRes, ptRes, ptMovRes, envRes, ordenRes, defectRes, maqRes, repRes, dashRes] = await Promise.all([
      apiFetch('/api/pro/materiales'),
      apiFetch('/api/pro/kardex'),
      apiFetch('/api/pro/conteos'),
      apiFetch('/api/pro/proveedores'),
      apiFetch('/api/pro/clientes'),
      apiFetch('/api/pro/productos-terminados'),
      apiFetch('/api/pro/productos-terminados-movimientos'),
      apiFetch('/api/pro/envios-terminados'),
      apiFetch('/api/pro/ordenes-produccion'),
      apiFetch('/api/defectuosos'),
      apiFetch('/api/maquinaria'),
      apiFetch('/api/repuestos'),
      apiFetch('/api/pro/dashboard'),
    ]);

    const materiales = matRes?.items || [];
    const kardex = kardexRes?.items || [];
    const conteos = conteoRes?.items || [];
    const proveedores = provRes?.items || [];
    const clientes = cliRes?.items || [];
    const terminados = ptRes?.items || [];
    const terminadoMovs = ptMovRes?.items || [];
    const enviosTerminados = envRes?.items || [];
    const ordenes = ordenRes?.items || [];
    const defects = defectRes?.items || [];
    const maquinaria = maqRes?.items || [];
    const repuestos = repRes?.items || [];

    const receps = kardex
      .filter(k => Number(k.entrada || 0) > 0)
      .map(k => ({ tipo: k.tipo, cantidad: k.entrada, unidad: k.unidad, fecha: k.fecha, created_at: k.created_at }));
    const stocks = materiales.map(m => ({ tipo: m.tipo, cantidad: Number(m.stock_actual || 0), unidad: m.unidad }));
    const prods = terminadoMovs.length
      ? terminadoMovs.map(p => ({ tipo: p.producto, cantidad: Number(p.entrada || p.salida || 0), unidad: p.unidad, fecha_ini: p.fecha || p.created_at, created_at: p.created_at, movimiento:p.movimiento }))
      : terminados.map(p => ({ tipo: p.producto, cantidad: p.stock, unidad: p.unidad, fecha_ini: p.updated_at || p.created_at, created_at: p.updated_at || p.created_at }));
    const envios = enviosTerminados.map(e => ({ tipo: e.producto, cliente: e.cliente, cantidad: e.cantidad, unidad: e.unidad, fecha: e.fecha, created_at: e.created_at }));

    showLoadingState(false);

    setKpi('kpiRecepciones', dashRes?.materiales ?? materiales.length);
    setKpi('kpiStock',       dashRes?.stock_bajo ?? stocks.filter(s => Number(s.cantidad) <= 0).length);
    setKpi('kpiProduccion',  dashRes?.productos_terminados ?? terminados.length);
    setKpi('kpiEnvios',      dashRes?.envios_30d ?? envios.length);
    setKpi('kpiDefectuosos', dashRes?.defectuosos ?? defects.length);
    setKpi('kpiAlertas', dashRes?.ordenes_abiertas ?? ordenes.filter(o => ['Pendiente','En proceso'].includes(o.estado)).length);

    const elTotalStock = $('kpiStockTotal');
    if (elTotalStock) elTotalStock.textContent = 'Materiales bajo mínimo';

    renderApartadosResumen(dashRes, {
      materiales: materiales.length,
      kardex: kardex.length,
      conteos: conteos.length,
      proveedores: proveedores.length,
      clientes: clientes.length,
      terminados: terminados.length,
      ordenes: ordenes.length,
      envios: envios.length,
      defectuosos: defects.length,
      maquinaria: maquinaria.length,
      repuestos: repuestos.length,
    });

    chartDefaults();
    renderChartEntradas(receps);
    renderChartStock(stocks);
    renderChartTendencia(receps, envios);
    renderChartDefectuosos(defects);

    renderAlertas(stocks);
    renderActividad(receps, prods, envios, defects);
    renderResumenProduccion(ordenes);

    const el = $('dashLastUpdate');
    if (el) el.textContent = new Date().toLocaleTimeString('es-PE');
  }

  function showLoadingState(loading) {
    const spinner = $('dashSpinner');
    if (spinner) spinner.style.display = loading ? 'flex' : 'none';
  }

  // ─── Re-render charts cuando cambia tema ───────────────────────────────────
  function observeTheme() {
    const observer = new MutationObserver(() => {
      chartDefaults();
      Object.values(charts).forEach(ch => ch.update());
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // ─── Botón de refrescar ────────────────────────────────────────────────────
  function setupRefreshButton() {
    const btn = $('btnDashRefresh');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Actualizando…';
      await loadDashboard();
      btn.disabled = false;
      btn.textContent = '↻ Actualizar';
    });
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (typeof Chart !== 'undefined') {
      observeTheme();
    } else {
      console.warn('[Dashboard] Chart.js no cargado; se mostrarán KPIs y resumen sin gráficos.');
    }
    setupRefreshButton();

    const runIfDashboard = () => {
      if (location.hash === '#dashboard' || location.hash === '') loadDashboard();
    };
    window.addEventListener('hashchange', runIfDashboard);
    window.refreshDashboardBrumap = loadDashboard;
    setTimeout(runIfDashboard, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
