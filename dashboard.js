/* Dashboard: KPIs con filtros Centro + Canal, tablas por Centro, mapa de calor por Centro+Canal */
"use strict";

// ================== Config ==================
const ROADMAP_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/Catalogo%20Sigma.csv";

// Índices (0-based) ya usados
const RM = { Centro: 1, Placa: 2, Cliente: 3, KgPlan: 10, Valor: 11, Lat: null, Lon: null };
const CT = { Clave: 0, Canal: 21 };

// Reglas
const PLACA_EXCLUIR = "FRT-001";   // fuera de TODO
const PLACA_NO_VEHICULO = "RES-CLI"; // fuera SOLO del conteo de vehículos

// Rango KPI (tabla por Rango)
const KG_RANGES = [
  { label: "0–1", test: kg => kg >= 0 && kg < 1 },
  { label: "1–3", test: kg => kg >= 1 && kg < 3 },
  { label: "3–5", test: kg => kg >= 3 && kg < 5 },
  { label: "5–10", test: kg => kg >= 5 && kg < 10 },
  { label: "10–20", test: kg => kg >= 10 && kg < 20 },
  { label: "20–50", test: kg => kg >= 20 && kg < 50 },
  { label: "50–100", test: kg => kg >= 50 && kg < 100 },
  { label: "100–200", test: kg => kg >= 100 && kg < 200 },
  { label: "200–500", test: kg => kg >= 200 && kg <= 500 },
  { label: "Pedidos >500", test: kg => kg > 500 }
];

// === (Opcional) Forzar índices de geo si no hay encabezados o no detecta ===
//  Pon números de columna (0-based). Ejemplo: GEO_CONFIG = { Lat: 12, Lon: 13 }
const GEO_CONFIG = { Lat: null, Lon: null };

// Formatters
const fmtInt = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtSoles = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });

// Estado
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map();
let GLOBAL_AGG = null;

// ===== CSV utils =====
function detectDelimiter(firstLine = ""){
  const candidates = [",", ";", "\t"];
  const counts = candidates.map(d => firstLine.split(d).length - 1);
  const max = Math.max(...counts);
  const idx = counts.indexOf(max);
  return candidates[idx] || ",";
}
function parseCSV(text){
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstNL = text.indexOf("\n");
  const delim = detectDelimiter(firstNL >= 0 ? text.slice(0, firstNL) : text);
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(inQ){
      if(c === '"' && n === '"'){ cur += '"'; i++; }
      else if(c === '"'){ inQ=false; }
      else { cur += c; }
    }else{
      if(c === '"') inQ=true;
      else if(c === delim){ row.push(cur); cur=""; }
      else if(c === "\n"){ row.push(cur); rows.push(row); row=[]; cur=""; }
      else if(c !== "\r"){ cur += c; }
    }
  }
  if(cur.length>0 || row.length>0){ row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ""));
}
function toNumber(s){
  if (s == null) return 0;
  let x = String(s).trim();
  if (!x) return 0;
  const hasComma = x.includes(","), hasDot = x.includes(".");
  if (hasComma && hasDot) x = x.replace(/\./g,"").replace(",",".");
  else if (hasComma && !hasDot){ if(/,\d{3}$/.test(x)) x = x.replace(/,/g,""); else x = x.replace(",","."); }
  else x = x.replace(/,/g,"");
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}
const HTML_ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = s => String(s ?? "").replace(/[&<>\"']/g, ch => HTML_ESC_MAP[ch]);
const toKey = s => String(s ?? "").trim().replace(/\s+/g," ").toUpperCase();
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();

(function init(){
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

async function start(){
  const status = document.getElementById("status");
  try{
    if(status) status.querySelector("span:last-child").textContent = "Descargando CSV…";

    const [tRoad, tCat] = await Promise.all([
      fetch(ROADMAP_CSV_URL, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error("RoadMap.csv HTTP "+r.status); return r.text(); }),
      fetch(CATALOGO_CSV_URL,{cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error("Catalogo.csv HTTP "+r.status); return r.text(); }),
    ]);

    // Parse
    let roadFull = parseCSV(tRoad);
    let catalog = parseCSV(tCat);

    // Tomamos encabezado de RoadMap (si viene)
    let roadHeader = null;
    if (roadFull.length){
      const maybeHead = roadFull[0].map(x => String(x||""));
      // si parece encabezado (palabras, no solo números)
      const textish = maybeHead.some(x => /[A-Za-zÁÉÍÓÚáéíóú]/.test(x));
      if (textish){ roadHeader = maybeHead; roadFull.shift(); }
    }

    // Excluir FRT-001 de TODO
    ROADMAP_ROWS = roadFull.filter(r => String(r[RM.Placa] ?? "").trim().toUpperCase() !== PLACA_EXCLUIR);

    // Mapa cliente -> canal
    if (catalog.length && /canal/i.test(String(catalog[0][CT.Canal] ?? ""))) catalog.shift();
    CATALOGO_MAP.clear();
    for (const row of catalog){
      const k = toKey(row[CT.Clave]);
      const canal = String(row[CT.Canal] ?? "").trim() || "Sin Canal";
      if (k) CATALOGO_MAP.set(k, canal);
    }

    // Detectar Lat/Lon
    detectLatLonColumns(roadHeader);

    // Filtro CENTRO
    const selCentro = document.getElementById("locationFilter");
    const locs = Array.from(new Set(ROADMAP_ROWS.map(r => String(r[RM.Centro] ?? "").trim()).filter(Boolean)))
      .sort((a,b)=>a.localeCompare(b,"es"));
    for (const loc of locs){
      const o = document.createElement("option"); o.value = loc; o.textContent = loc; selCentro.appendChild(o);
    }
    selCentro.addEventListener("change", ()=>{
      buildCanalDropdown(selCentro.value);
      renderAll();
    });

    // Dropdown CANAL
    buildCanalDropdown("__all__");
    wireDropdownEvents();

    // Base para % KPIs no-ratio
    GLOBAL_AGG = aggregateTotals(ROADMAP_ROWS);

    // Inicializar mapa
    initHeatmap();

    // Primer render
    renderAll();

    if(status){
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=>status.style.display="none", 800);
    }
  }catch(e){
    console.error(e);
    if (status) status.innerHTML = `<span>⚠️ ${String(e.message ?? e)}</span>`;
  }
}

/* ================== Detectar columnas Lat/Lon ================== */
function detectLatLonColumns(header){
  if (GEO_CONFIG.Lat != null && GEO_CONFIG.Lon != null){
    RM.Lat = GEO_CONFIG.Lat; RM.Lon = GEO_CONFIG.Lon; return;
  }
  if (!header){ RM.Lat = null; RM.Lon = null; return; }
  const candLat = ["lat","latitude","latitud","y"];
  const candLon = ["lon","lng","long","longitud","longitude","x"];
  const H = header.map(h => norm(h));
  const findIdx = (cands) => {
    for (const c of cands){
      const i = H.findIndex(h => h === c || h.includes(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iLat = findIdx(candLat);
  const iLon = findIdx(candLon);
  RM.Lat = iLat >= 0 ? iLat : null;
  RM.Lon = iLon >= 0 ? iLon : null;
}

/* ================== Dropdown Canal (checkboxes) ================== */
let CANAL_SELECTED = new Set(); // valores seleccionados (sin "__all__")

function buildCanalDropdown(centroValue){
  const panel = document.getElementById("canalOptions");
  if (!panel) return;

  const rows = (centroValue && centroValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[RM.Centro] ?? "").trim() === centroValue)
    : ROADMAP_ROWS;

  const canales = Array.from(new Set(rows.map(r=>{
    const cliente = toKey(r[RM.Cliente]); return CATALOGO_MAP.get(cliente) || "Sin Canal";
  }))).sort((a,b)=>a.localeCompare(b,"es"));

  if (CANAL_SELECTED.size === 0) canales.forEach(c => CANAL_SELECTED.add(c));
  else {
    const cur = new Set(CANAL_SELECTED);
    CANAL_SELECTED.clear();
    canales.forEach(c => { if (cur.has(c)) CANAL_SELECTED.add(c); });
    if (CANAL_SELECTED.size === 0) canales.forEach(c => CANAL_SELECTED.add(c));
  }

  panel.innerHTML = canales.map(c=>{
    const id = `can_${c.replace(/\W+/g,'_')}`;
    const checked = CANAL_SELECTED.has(c) ? "checked" : "";
    return `
      <label class="dd-item" for="${id}">
        <input id="${id}" type="checkbox" value="${escapeHTML(c)}" ${checked} />
        <span>${escapeHTML(c)}</span>
      </label>
    `;
  }).join("");

  updateCanalToggleCaption();
}
function wireDropdownEvents(){
  const toggle = document.getElementById("canalDropdownToggle");
  const panel = document.getElementById("canalDropdownPanel");
  if (!toggle || !panel) return;

  toggle.addEventListener("click", ()=>{
    const open = !panel.hasAttribute("hidden");
    if (open){ panel.setAttribute("hidden",""); toggle.setAttribute("aria-expanded","false"); }
    else { panel.removeAttribute("hidden"); toggle.setAttribute("aria-expanded","true"); }
  });

  // Cerrar al click fuera
  document.addEventListener("click", (e)=>{
    if (!panel.contains(e.target) && !toggle.contains(e.target)){
      if (!panel.hasAttribute("hidden")){
        panel.setAttribute("hidden",""); toggle.setAttribute("aria-expanded","false");
      }
    }
  });

  // Cambios en checkboxes
  panel.addEventListener("change", (e)=>{
    if (e.target && e.target.type === "checkbox"){
      const val = e.target.value;
      if (e.target.checked) CANAL_SELECTED.add(val); else CANAL_SELECTED.delete(val);
      if (CANAL_SELECTED.size === 0){ CANAL_SELECTED.add(val); e.target.checked = true; } // evita vacío
      updateCanalToggleCaption();
      renderKpiOnly();                 // KPI
      renderHeatmapFilteredOnly();     // Mapa (cuando solo cambian canales)
    }
  });

  // Botones seleccionar/limpiar
  const btnAll = document.getElementById("canalSelectAllBtn");
  const btnClr = document.getElementById("canalClearBtn");
  btnAll?.addEventListener("click", ()=>{
    const inputs = panel.querySelectorAll("input[type=checkbox]");
    CANAL_SELECTED.clear();
    inputs.forEach(i=>{ i.checked = true; CANAL_SELECTED.add(i.value); });
    updateCanalToggleCaption(); renderKpiOnly(); renderHeatmapFilteredOnly();
  });
  btnClr?.addEventListener("click", ()=>{
    const inputs = panel.querySelectorAll("input[type=checkbox]");
    inputs.forEach(i=> i.checked = false);
    CANAL_SELECTED.clear();
    updateCanalToggleCaption(); renderKpiOnly(); renderHeatmapFilteredOnly();
  });
}
function updateCanalToggleCaption(){
  const toggle = document.getElementById("canalDropdownToggle");
  if (!toggle) return;
  toggle.textContent = CANAL_SELECTED.size === 0 ? "Ninguno" : `Canal (${CANAL_SELECTED.size})`;
}

/* ================== Render general ================== */
function renderAll(){
  const rowsCentro = getRowsByCentro();
  // Tablas (solo Centro)
  renderByCanal(rowsCentro);
  renderByRangos(rowsCentro);
  // KPIs (Centro + Canal)
  renderKpiCard(applyCanalFilter(rowsCentro));
  // Mapa (Centro + Canal)
  renderHeatmap(applyCanalFilter(rowsCentro));
}
function renderKpiOnly(){
  const rowsCentro = getRowsByCentro();
  renderKpiCard(applyCanalFilter(rowsCentro));
}
function renderHeatmapFilteredOnly(){
  const rowsCentro = getRowsByCentro();
  renderHeatmap(applyCanalFilter(rowsCentro));
}
function getRowsByCentro(){
  const sel = document.getElementById("locationFilter");
  const centroValue = sel?.value || "__all__";
  return (centroValue && centroValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[RM.Centro] ?? "").trim() === centroValue)
    : ROADMAP_ROWS;
}
function applyCanalFilter(rowsCentro){
  if (!CANAL_SELECTED || CANAL_SELECTED.size === 0) return rowsCentro;
  return rowsCentro.filter(r=>{
    const canal = CATALOGO_MAP.get(toKey(r[RM.Cliente])) || "Sin Canal";
    return CANAL_SELECTED.has(canal);
  });
}

/* ===== Agregación / Visual ===== */
function placaCuentaVehiculo(placaRaw){ const p = toKey(placaRaw); return p && p !== PLACA_NO_VEHICULO; }
function ratio(a,b){ return b>0 ? (a/b) : 0; }
const pct = (v,t) => t>0 ? (v/t*100) : 0;
const pctTxt = p => `${p.toFixed(1)}%`;

function cellRoadHTML(valFmt, part){
  const p = Math.max(0, Math.min(100, part));
  const small = p < 10 ? ` data-small="1"` : "";
  return `
    <div class="cell-stat">
      <div class="cell-top">
        <span>${valFmt}</span>
        <span class="pct">(${pctTxt(p)})</span>
      </div>
      <div class="road-progress" aria-hidden="true">
        <div class="road-bar"${small} style="width:${p}%"></div>
      </div>
    </div>
  `;
}
function aggregateTotals(rows){
  const clients = new Set(); const plates = new Set(); let kg=0, val=0;
  for(const r of rows){
    const cli = toKey(r[RM.Cliente]); if (cli) clients.add(cli);
    const placa = toKey(r[RM.Placa]); if (placaCuentaVehiculo(placa)) plates.add(placa);
    kg += toNumber(r[RM.KgPlan]);
    val += toNumber(r[RM.Valor]);
  }
  return { clientes: clients.size, vehiculos: plates.size, kg, val };
}

/* ===== KPIs ===== */
function renderKpiCard(rowsKpi){
  const el = document.getElementById("kpiCard");
  if (!el) return;
  const aggSel = aggregateTotals(rowsKpi);
  const base = GLOBAL_AGG || { clientes:0, vehiculos:0, kg:0, val:0 };

  const pCli = pct(aggSel.clientes, base.clientes);
  const pVeh = pct(aggSel.vehiculos, base.vehiculos);
  const pKg  = pct(aggSel.kg, base.kg);
  const pVal = pct(aggSel.val, base.val);

  const kgVeh = ratio(aggSel.kg, aggSel.vehiculos);
  const kgCli = ratio(aggSel.kg, aggSel.clientes);
  const cliVeh= Math.round(ratio(aggSel.clientes, aggSel.vehiculos));

  const kpiBar = (cssClass, label, valFmt, partPct) => `
    <div class="kpi ${cssClass}">
      <div class="kpi-head"><span class="kpi-icon" aria-hidden="true"></span><span class="kpi-label">${label}</span></div>
      ${cellRoadHTML(valFmt, partPct)}
    </div>
  `;
  const kpiPlain = (cssClass, label, valFmt) => `
    <div class="kpi ${cssClass}">
      <div class="kpi-head"><span class="kpi-icon" aria-hidden="true"></span><span class="kpi-label">${label}</span></div>
      <div class="kpi-value"><span>${valFmt}</span></div>
    </div>
  `;

  el.innerHTML = [
    kpiBar ("kpi--clientes",  "# Clientes",          fmtInt.format(aggSel.clientes), pCli),
    kpiBar ("kpi--vehiculos", "# Vehículos",         fmtInt.format(aggSel.vehiculos), pVeh),
    kpiBar ("kpi--kg",        "Kg Plan.",            fmtNum.format(aggSel.kg),        pKg ),
    kpiBar ("kpi--valor",     "Valor (S/.)",         fmtSoles.format(aggSel.val).replace("S/.", "S/."), pVal),
    kpiPlain("kpi--kgveh",    "Kg/Vehículo",         fmtNum.format(kgVeh)),
    kpiPlain("kpi--kgcli",    "Kg/Cliente",          fmtNum.format(kgCli)),
    kpiPlain("kpi--cliveh",   "Clientes/Vehículo",   fmt0.format(cliVeh)),
  ].join("");
}

/* ===== Tablas (solo centro) ===== */
function renderByCanal(rows){
  const agg = new Map(); // canal -> {clients:Set, veh:Set, kg, val}
  for (const r of rows){
    const cliente = toKey(r[RM.Cliente]);
    const placa = toKey(r[RM.Placa]);
    const canal = CATALOGO_MAP.get(cliente) || "Sin Canal";
    const kg = toNumber(r[RM.KgPlan]);
    const val = toNumber(r[RM.Valor]);
    if(!agg.has(canal)) agg.set(canal,{clients:new Set(), veh:new Set(), kg:0, val:0});
    const o = agg.get(canal);
    if (cliente) o.clients.add(cliente);
    if (placaCuentaVehiculo(placa)) o.veh.add(placa);
    o.kg += kg;
    o.val += val;
  }
  const data = Array.from(agg.entries()).map(([canal,o])=>({ canal, clientes:o.clients.size, vehiculos:o.veh.size, kg:o.kg, val:o.val })).sort((a,b)=>b.val-a.val);
  const tCli = data.reduce((s,x)=>s+x.clientes,0);
  const tVeh = data.reduce((s,x)=>s+x.vehiculos,0);
  const tKg  = data.reduce((s,x)=>s+x.kg,0);
  const tVal = data.reduce((s,x)=>s+x.val,0);
  const tbody = document.getElementById("summaryBody");
  tbody.innerHTML = data.length ? data.map(r=>{
    const kgVeh = ratio(r.kg, r.vehiculos);
    const kgCli = ratio(r.kg, r.clientes);
    const cliVeh= ratio(r.clientes, r.vehiculos);
    return `
      <tr>
        <td>${escapeHTML(r.canal)}</td>
        <td class="num">${cellRoadHTML(fmtInt.format(r.clientes), (tCli>0? r.clientes/tCli*100:0))}</td>
        <td class="num">${cellRoadHTML(fmtInt.format(r.vehiculos), (tVeh>0? r.vehiculos/tVeh*100:0))}</td>
        <td class="num">${cellRoadHTML(fmtNum.format(r.kg), (tKg>0? r.kg/tKg*100:0))}</td>
        <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), (tVal>0? r.val/tVal*100:0))}</td>
        <td class="num">${fmtNum.format(kgVeh)}</td>
        <td class="num">${fmtNum.format(kgCli)}</td>
        <td class="num">${fmt0.format(Math.round(cliVeh))}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="8" class="muted" style="padding:14px">Sin datos.</td></tr>`;
  document.getElementById("totClientes").textContent = fmtInt.format(tCli);
  document.getElementById("totVeh").textContent = fmtInt.format(tVeh);
  document.getElementById("totKg").textContent = fmtNum.format(tKg);
  document.getElementById("totVal").textContent = fmtSoles.format(tVal).replace("S/.", "S/.");
  document.getElementById("totKgVeh").textContent = fmtNum.format(ratio(tKg, tVeh));
  document.getElementById("totKgCli").textContent = fmtNum.format(ratio(tKg, tCli));
  document.getElementById("totCliVeh").textContent = fmt0.format(Math.round(ratio(tCli, tVeh)));
}

function renderByRangos(rows){
  try{
    const tbody = document.getElementById("tbodyRangos");
    const tCliE = document.getElementById("totClientesRng");
    const tVehE = document.getElementById("totVehRng");
    const tKgE  = document.getElementById("totKgRng");
    const tValE = document.getElementById("totValRng");
    const tKgVehE = document.getElementById("totKgVehRng");
    const tKgCliE = document.getElementById("totKgCliRng");
    const tCliVehE= document.getElementById("totCliVehRng");
    if (!tbody || !tCliE || !tVehE || !tKgE || !tValE || !tKgVehE || !tKgCliE || !tCliVehE) return;

    const perClient = new Map(); // cliente -> {kg, val, plates:Set}
    for (const r of rows){
      const cliente = toKey(r[RM.Cliente]); if (!cliente) continue;
      const kg = toNumber(r[RM.KgPlan]);
      const val = toNumber(r[RM.Valor]);
      const placa = toKey(r[RM.Placa]);
      const o = perClient.get(cliente) || { kg:0, val:0, plates:new Set() };
      if (Number.isFinite(kg) && kg >= 0){ o.kg += kg; if (Number.isFinite(val) && val >= 0) o.val += val; }
      if (placaCuentaVehiculo(placa)) o.plates.add(placa);
      perClient.set(cliente, o);
    }

    const agg = new Map(KG_RANGES.map(R => [R.label, { clients:new Set(), veh:new Set(), kg:0, val:0 }]));
    for (const [cliente, o] of perClient){
      const found = KG_RANGES.find(R => R.test(o.kg)); if (!found) continue;
      const a = agg.get(found.label);
      a.clients.add(cliente);
      o.plates.forEach(p => a.veh.add(p));
      a.kg += o.kg;
      a.val += o.val;
    }

    const data = KG_RANGES.map(R => {
      const o = agg.get(R.label);
      return { rango:R.label, clientes:o.clients.size, vehiculos:o.veh.size, kg:o.kg, val:o.val };
    });

    const tCli = data.reduce((s,x)=>s+x.clientes,0);
    const tVeh = data.reduce((s,x)=>s+x.vehiculos,0);
    const tKg  = data.reduce((s,x)=>s+x.kg,0);
    const tVal = data.reduce((s,x)=>s+x.val,0);

    tbody.innerHTML = data.map(r=>{
      const kgVeh = ratio(r.kg, r.vehiculos);
      const kgCli = ratio(r.kg, r.clientes);
      const cliVeh= ratio(r.clientes, r.vehiculos);
      return `
        <tr>
          <td>${escapeHTML(r.rango)}</td>
          <td class="num">${cellRoadHTML(fmtInt.format(r.clientes), (tCli>0? r.clientes/tCli*100:0))}</td>
          <td class="num">${cellRoadHTML(fmtInt.format(r.vehiculos), (tVeh>0? r.vehiculos/tVeh*100:0))}</td>
          <td class="num">${cellRoadHTML(fmtNum.format(r.kg), (tKg>0? r.kg/tKg*100:0))}</td>
          <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), (tVal>0? r.val/tVal*100:0))}</td>
          <td class="num">${fmtNum.format(kgVeh)}</td>
          <td class="num">${fmtNum.format(kgCli)}</td>
          <td class="num">${fmt0.format(Math.round(cliVeh))}</td>
        </tr>
      `;
    }).join("");

    tCliE.textContent = fmtInt.format(tCli);
    tVehE.textContent = fmtInt.format(tVeh);
    tKgE.textContent  = fmtNum.format(tKg);
    tValE.textContent = fmtSoles.format(tVal).replace("S/.", "S/.");
    tKgVehE.textContent = fmtNum.format(ratio(tKg,tVeh));
    tKgCliE.textContent = fmtNum.format(ratio(tKg,tCli));
    tCliVehE.textContent= fmt0.format(Math.round(ratio(tCli,tVeh)));
  }catch(err){
    console.error("[Dashboard] Error en renderByRangos]:", err);
    const tbody = document.getElementById("tbodyRangos");
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted" style="padding:14px">⚠️ Error al construir la tabla de rangos.</td></tr>`;
  }
}

/* ================== Mapa de calor (Leaflet) ================== */
let MAP = null;
let HEAT = null;

function initHeatmap(){
  const el = document.getElementById("heatmap");
  const hint = document.getElementById("mapHint");
  if (!el) return;

  if (RM.Lat == null || RM.Lon == null){
    hint.textContent = "No se detectaron columnas de Lat/Lon en RoadMap.csv. Define GEO_CONFIG en dashboard.js si tus columnas son distintas.";
    return;
  } else {
    hint.textContent = "Ponderado por Kg Plan. Afectado por filtros de Centro y Canal.";
  }

  MAP = L.map(el, { zoomControl: true, attributionControl: true });
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  tiles.addTo(MAP);

  HEAT = L.heatLayer([], {
    radius: 18,    // tamaño del “punto”
    blur: 16,
    maxZoom: 17,
    minOpacity: 0.3
  }).addTo(MAP);

  // Primer ajuste de vista en renderHeatmap()
}

function renderHeatmap(rows){
  const el = document.getElementById("heatmap");
  const hint = document.getElementById("mapHint");
  if (!el || RM.Lat == null || RM.Lon == null || !MAP || !HEAT){ return; }

  // Agregamos por CLIENTE (suma del día) con su lat/lon
  const perClient = new Map(); // key cliente -> {lat, lon, kg}
  for (const r of rows){
    const cliente = toKey(r[RM.Cliente]);
    const kg = toNumber(r[RM.KgPlan]);
    const lat = toNumber(r[RM.Lat]);
    const lon = toNumber(r[RM.Lon]);
    if (!cliente || !Number.isFinite(kg) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) continue; // evita 0,0
    const o = perClient.get(cliente) || { lat, lon, kg:0 };
    o.kg += kg;
    // si vienen varias filas con coords distintas para un mismo cliente, conservamos la primera válida
    perClient.set(cliente, o);
  }

  const data = Array.from(perClient.values());
  if (data.length === 0){
    HEAT.setLatLngs([]);
    hint.textContent = "Sin puntos georreferenciados para los filtros actuales.";
    try { MAP.setView([ -12.05, -77.05 ], 10); } catch {}
    return;
  } else {
    hint.textContent = "Ponderado por Kg Plan. Afectado por filtros de Centro y Canal.";
  }

  // Normalizamos intensidad por el máximo de Kg
  const maxKg = Math.max(...data.map(d => d.kg));
  const heatPts = data.map(d => [ d.lat, d.lon, (maxKg>0 ? d.kg/maxKg : 0) ]);

  HEAT.setLatLngs(heatPts);

  // Ajustar vista al bounding box
  const bounds = L.latLngBounds(data.map(d => [d.lat, d.lon]));
  MAP.fitBounds(bounds.pad(0.15)); // un poco de margen
}
``
