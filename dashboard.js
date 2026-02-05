/* Dashboard con Card de Indicadores + Tablas por Canal y Rangos (barras solo en no‑ratio) */
"use strict";

// URLs CSV
const ROADMAP_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/Catalogo%20Sigma.csv";

// Índices (0-based)
const RM = { Centro: 1, Placa: 2, Cliente: 3, KgPlan: 10, Valor: 11 };
const CT = { Clave: 0, Canal: 21 };

// Reglas
const PLACA_EXCLUIR     = "FRT-001"; // excluida de TODO
const PLACA_NO_VEHICULO = "RES-CLI"; // excluida SOLO del conteo de vehículos

// Rangos (tabla por Rango)
const KG_RANGES = [
  { label: "0–1",     test: kg => kg >= 0   && kg < 1   },
  { label: "1–3",     test: kg => kg >= 1   && kg < 3   },
  { label: "3–5",     test: kg => kg >= 3   && kg < 5   },
  { label: "5–10",    test: kg => kg >= 5   && kg < 10  },
  { label: "10–20",   test: kg => kg >= 10  && kg < 20  },
  { label: "20–50",   test: kg => kg >= 20  && kg < 50  },
  { label: "50–100",  test: kg => kg >= 50  && kg < 100 },
  { label: "100–200", test: kg => kg >= 100 && kg < 200 },
  { label: "200–500", test: kg => kg >= 200 && kg <= 500 },
  { label: "Pedidos >500", test: kg => kg > 500 }
];

// Formatters
const fmtInt   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtNum   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const fmtSoles = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });

// Estado
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map();
let GLOBAL_AGG   = null;

/* ==== CSV utils ==== */
function detectDelimiter(firstLine = "") {
  const candidates = [",", ";", "\t"];
  const counts = candidates.map(d => firstLine.split(d).length - 1);
  const max = Math.max(...counts);
  const idx = counts.indexOf(max);
  return candidates[idx] || ",";
}
function parseCSV(text) {
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
function toNumber(s) {
  if (s == null) return 0;
  let x = String(s).trim();
  if (!x) return 0;
  const hasComma = x.includes(","), hasDot = x.includes(".");
  if (hasComma && hasDot)      x = x.replace(/\./g,"").replace(",",".");
  else if (hasComma && !hasDot){ if(/,\d{3}$/.test(x)) x = x.replace(/,/g,""); else x = x.replace(",","."); }
  else                          x = x.replace(/,/g,"");
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}
const HTML_ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, ch => HTML_ESC_MAP[ch]);
const toKey = s => String(s ?? "").trim().replace(/\s+/g," ").toUpperCase();

/* ==== Init ==== */
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

    let roadmap = parseCSV(tRoad);
    let catalog = parseCSV(tCat);

    if (roadmap.length) roadmap.shift(); // header
    if (catalog.length && /canal/i.test(String(catalog[0][CT.Canal] ?? ""))) catalog.shift();

    // Excluir FRT-001 del dataset
    ROADMAP_ROWS = roadmap.filter(r => String(r[RM.Placa] ?? "").trim().toUpperCase() !== PLACA_EXCLUIR);

    // Mapa cliente -> canal
    CATALOGO_MAP.clear();
    for (const row of catalog){
      const k = toKey(row[CT.Clave]);
      const canal = String(row[CT.Canal] ?? "").trim() || "Sin Canal";
      if (k) CATALOGO_MAP.set(k, canal);
    }

    // Filtro de centros
    const sel = document.getElementById("locationFilter");
    const locs = Array.from(new Set(ROADMAP_ROWS.map(r => String(r[RM.Centro] ?? "").trim()).filter(Boolean)))
      .sort((a,b)=>a.localeCompare(b,"es"));
    for (const loc of locs){
      const o = document.createElement("option"); o.value = loc; o.textContent = loc; sel.appendChild(o);
    }
    sel.addEventListener("change", ()=>renderAll(sel.value));

    // Totales globales (para % de la Card no‑ratio)
    GLOBAL_AGG = aggregateTotals(ROADMAP_ROWS);

    // Primer render
    renderAll("__all__");

    if(status){
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=>status.style.display="none", 800);
    }
  }catch(e){
    console.error(e);
    if (status) status.innerHTML = `<span>⚠️ ${String(e.message ?? e)}</span>`;
  }
}

function renderAll(centroValue){
  const rows = (centroValue && centroValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[RM.Centro] ?? "").trim() === centroValue)
    : ROADMAP_ROWS;

  renderKpiCard(rows);   // KPIs (no‑ratio con barra + ratios sin barra)
  renderByCanal(rows);   // Tabla por canal
  renderByRangos(rows);  // Tabla por rangos
}

/* ==== Helpers de agregación / visual ==== */
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
    const placa = toKey(r[RM.Placa]);  if (placaCuentaVehiculo(placa)) plates.add(placa);
    kg  += toNumber(r[RM.KgPlan]);
    val += toNumber(r[RM.Valor]);
  }
  return { clientes: clients.size, vehiculos: plates.size, kg, val };
}

/* ==== Card de Indicadores ==== */
function renderKpiCard(rows){
  const el = document.getElementById("kpiCard");
  if (!el) return;

  const aggSel = aggregateTotals(rows);
  const base   = GLOBAL_AGG || { clientes:0, vehiculos:0, kg:0, val:0 };

  // % vs base global para métricas no‑ratio
  const pCli = pct(aggSel.clientes, base.clientes);
  const pVeh = pct(aggSel.vehiculos, base.vehiculos);
  const pKg  = pct(aggSel.kg,        base.kg);
  const pVal = pct(aggSel.val,       base.val);

  // Ratios en base al filtro actual
  const kgVeh = ratio(aggSel.kg, aggSel.vehiculos);
  const kgCli = ratio(aggSel.kg, aggSel.clientes);
  const cliVeh= ratio(aggSel.clientes, aggSel.vehiculos);

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
    // No‑ratio con barra + %
    kpiBar("kpi--valor",     "Valor (S/.)", fmtSoles.format(aggSel.val).replace("S/.", "S/."), pVal),
    kpiBar("kpi--kg",        "Kg Plan.",    fmtNum.format(aggSel.kg), pKg),
    kpiBar("kpi--clientes",  "# Clientes",  fmtInt.format(aggSel.clientes), pCli),
    kpiBar("kpi--vehiculos", "# Vehículos", fmtInt.format(aggSel.vehiculos), pVeh),

    // Ratios (sin barra)
    kpiPlain("kpi--kgveh",   "Kg/Vehículo",     fmtNum.format(kgVeh)),
    kpiPlain("kpi--kgcli",   "Kg/Cliente",      fmtNum.format(kgCli)),
    kpiPlain("kpi--cliveh",  "Clientes/Vehículo", fmtNum.format(cliVeh)),
  ].join("");
}

/* ==== Tabla por Canal ==== */
function renderByCanal(rows){
  const agg = new Map(); // canal -> {clients:Set, veh:Set, kg, val}
  for (const r of rows){
    const cliente = toKey(r[RM.Cliente]);
    const placa   = toKey(r[RM.Placa]);
    const canal   = CATALOGO_MAP.get(cliente) || "Sin Canal";
    const kg  = toNumber(r[RM.KgPlan]);
    const val = toNumber(r[RM.Valor]);

    if(!agg.has(canal)) agg.set(canal,{clients:new Set(), veh:new Set(), kg:0, val:0});
    const o = agg.get(canal);
    if (cliente) o.clients.add(cliente);
    if (placaCuentaVehiculo(placa)) o.veh.add(placa);
    o.kg  += kg;
    o.val += val;
  }

  const data = Array.from(agg.entries()).map(([canal,o])=>({
    canal, clientes:o.clients.size, vehiculos:o.veh.size, kg:o.kg, val:o.val
  })).sort((a,b)=>b.val-a.val);

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
        <td class="num">${cellRoadHTML(fmtInt.format(r.clientes),   pct(r.clientes,tCli))}</td>
        <td class="num">${cellRoadHTML(fmtInt.format(r.vehiculos),  pct(r.vehiculos,tVeh))}</td>
        <td class="num">${cellRoadHTML(fmtNum.format(r.kg),         pct(r.kg,tKg))}</td>
        <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), pct(r.val,tVal))}</td>
        <td class="num">${fmtNum.format(kgVeh)}</td>
        <td class="num">${fmtNum.format(kgCli)}</td>
        <td class="num">${fmtNum.format(cliVeh)}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="8" class="muted" style="padding:14px">Sin datos.</td></tr>`;

  document.getElementById("totClientes").textContent = fmtInt.format(tCli);
  document.getElementById("totVeh").textContent      = fmtInt.format(tVeh);
  document.getElementById("totKg").textContent       = fmtNum.format(tKg);
  document.getElementById("totVal").textContent      = fmtSoles.format(tVal).replace("S/.", "S/.");
  document.getElementById("totKgVeh").textContent    = fmtNum.format(ratio(tKg, tVeh));
  document.getElementById("totKgCli").textContent    = fmtNum.format(ratio(tKg, tCli));
  document.getElementById("totCliVeh").textContent   = fmtNum.format(ratio(tCli, tVeh));
}

/* ==== Tabla por Rangos (POR CLIENTE) ==== */
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

    // Agrego por CLIENTE (suma del día) + placas válidas
    const perClient = new Map(); // cliente -> {kg, val, plates:Set}
    for (const r of rows){
      const cliente = toKey(r[RM.Cliente]); if (!cliente) continue;
      const kg  = toNumber(r[RM.KgPlan]);
      const val = toNumber(r[RM.Valor]);
      const placa = toKey(r[RM.Placa]);

      const o = perClient.get(cliente) || { kg:0, val:0, plates:new Set() };
      if (Number.isFinite(kg) && kg >= 0){ o.kg += kg; if (Number.isFinite(val) && val >= 0) o.val += val; }
      if (placaCuentaVehiculo(placa)) o.plates.add(placa);
      perClient.set(cliente, o);
    }

    // Agregación por rango
    const agg = new Map(KG_RANGES.map(R => [R.label, { clients:new Set(), veh:new Set(), kg:0, val:0 }]));
    for (const [cliente, o] of perClient){
      const found = KG_RANGES.find(R => R.test(o.kg)); if (!found) continue;
      const a = agg.get(found.label);
      a.clients.add(cliente);
      o.plates.forEach(p => a.veh.add(p));
      a.kg  += o.kg;
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
          <td class="num">${cellRoadHTML(fmtInt.format(r.clientes),   pct(r.clientes,tCli))}</td>
          <td class="num">${cellRoadHTML(fmtInt.format(r.vehiculos),  pct(r.vehiculos,tVeh))}</td>
          <td class="num">${cellRoadHTML(fmtNum.format(r.kg),         pct(r.kg,tKg))}</td>
          <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), pct(r.val,tVal))}</td>
          <td class="num">${fmtNum.format(kgVeh)}</td>
          <td class="num">${fmtNum.format(kgCli)}</td>
          <td class="num">${fmtNum.format(cliVeh)}</td>
        </tr>
      `;
    }).join("");

    tCliE.textContent   = fmtInt.format(tCli);
    tVehE.textContent   = fmtInt.format(tVeh);
    tKgE.textContent    = fmtNum.format(tKg);
    tValE.textContent   = fmtSoles.format(tVal).replace("S/.", "S/.");
    tKgVehE.textContent = fmtNum.format(ratio(tKg,tVeh));
    tKgCliE.textContent = fmtNum.format(ratio(tKg,tCli));
    tCliVehE.textContent= fmtNum.format(ratio(tCli,tVeh));
  }catch(err){
    console.error("[Dashboard] Error en renderByRangos]:", err);
    const tbody = document.getElementById("tbodyRangos");
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted" style="padding:14px">⚠️ Error al construir la tabla de rangos.</td></tr>`;
  }
}
