/* dashboard.js – RoadMap Dashboard (dos tablas: Global por Centro + Canal filtrado, con barra “carretera”) */
"use strict";

// ===============================
// CONFIG: URLs correctas (raw.githubusercontent.com)
// ===============================
const ROADMAP_CSV_URL  = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/Catalogo%20Sigma.csv";

// Índices (0-based) acordados
const RM = { Centro: 1, Placa: 2, Cliente: 3, KgPlan: 10, Valor: 11 };
const CT = { Clave: 0, Canal: 21 };

// Placa a excluir en todo el dashboard
const PLACA_EXCLUIR = "FRT-001";

// Formatters
const fmtInt   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtNum   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const fmtSoles = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });

// Normaliza claves (cliente)
const toKey = s => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

// Estado
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map(); // cliente -> canal

// ===============================
// CSV utils (detección de separador + comillas)
// ===============================
function detectDelimiter(firstLine) {
  const counts = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0] || ",";
}

function parseCSV(text) {
  if (!text) return [];
  // quitar BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const firstNL = text.indexOf("\n");
  const headerLine = firstNL >= 0 ? text.slice(0, firstNL) : text;
  const delim = detectDelimiter(headerLine);

  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQuotes) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(cur); cur = ""; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === '\r') { /* ignore */ }
      else { cur += c; }
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  // filtrar filas vacías
  return rows.filter(r => r.some(x => String(x).trim() !== ""));
}

// Números: acepta 1.234,56 o 1,234.56
function toNumber(s) {
  if (s == null) return 0;
  let x = String(s).trim();
  if (!x) return 0;
  x = x.replace(/\u00A0/g," ").replace(/\s+/g," ");
  if (x.includes(".") && x.includes(",")) x = x.replace(/\./g,"").replace(",",".");
  else if (x.includes(",")) x = x.replace(/\./g,"").replace(",",".");
  else x = x.replace(/,/g,"");
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

// Escape HTML (seguro)
const HTML_ESC_MAP = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
function escapeHTML(s) { return String(s ?? "").replace(/[&<>"']/g, ch => HTML_ESC_MAP[ch]); }

// ===============================
// Init
// ===============================
(function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

async function start() {
  const status = document.getElementById("status");
  try {
    if (status) status.querySelector("span:last-child").textContent = "Descargando CSV…";

    const [roadmapText, catalogText] = await Promise.all([
      fetch(ROADMAP_CSV_URL, { cache:"no-store" }).then(r => { if(!r.ok) throw new Error("RoadMap.csv HTTP "+r.status); return r.text(); }),
      fetch(CATALOGO_CSV_URL, { cache:"no-store" }).then(r => { if(!r.ok) throw new Error("Catalogo.csv HTTP "+r.status); return r.text(); }),
    ]);

    let roadmap = parseCSV(roadmapText);
    let catalog = parseCSV(catalogText);

    // Omitir encabezado en RoadMap (siempre)
    if (roadmap.length) roadmap.shift();
    // Omitir encabezado en Catálogo si detecta "Canal" en col 21
    if (catalog.length && /canal/i.test(String(catalog[0][CT.Canal]||""))) catalog.shift();

    // === Filtrar FRT-001 y limpiar dataset base ===
    ROADMAP_ROWS = roadmap.filter(r => String(r[RM.Placa] ?? "").trim().toUpperCase() !== PLACA_EXCLUIR);

    // Mapa cliente -> canal
    CATALOGO_MAP.clear();
    for (const row of catalog) {
      const key = toKey(row[CT.Clave]);
      const canal = String(row[CT.Canal] ?? "").trim() || "Sin Canal";
      if (key) CATALOGO_MAP.set(key, canal);
    }

    // Poblar filtro "Centro" (ya con FRT-001 excluido)
    const sel = document.getElementById("locationFilter");
    const locSet = new Set();
    for (const r of ROADMAP_ROWS) {
      const c = String(r[RM.Centro] ?? "").trim();
      if (c) locSet.add(c);
    }
    [...locSet].sort((a,b)=>a.localeCompare(b,"es")).forEach(loc => {
      const opt = document.createElement("option");
      opt.value = loc; opt.textContent = loc; sel.appendChild(opt);
    });
    sel.addEventListener("change", () => renderByCanal(sel.value));

    // Render global por Centro (NO filtrado) y por Canal (filtrado)
    renderGlobalByCentro();      // no usa el selector
    renderByCanal("__all__");    // selector en "Todos"

    // Estado
    if (status) {
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=>{ status.style.display="none"; }, 800);
    }

    console.log("[Dashboard] RoadMap filas (sin FRT-001):", ROADMAP_ROWS.length, "Catálogo claves:", CATALOGO_MAP.size);
  } catch (err) {
    console.error("Error cargando datos:", err);
    if (status) status.innerHTML = `<span>⚠️ ${String(err.message || err)}</span>`;
  }
}

// ===============================
// Helpers de presentación (porcentaje + barra “carretera”)
// ===============================
const pct = (value,total) => total>0 ? (value/total*100) : 0;
const pctTxt = p => `${p.toFixed(1)}%`;

/** Genera la celda con valor + % + barra carretera */
function cellRoadHTML(valorFormateado, porcentaje) {
  const p = Math.max(0, Math.min(100, porcentaje)); // 0–100
  return `
    <div class="cell-stat">
      <div class="cell-top">
        <span>${valorFormateado}</span>
        <span class="pct">(${pctTxt(p)})</span>
      </div>
      <div class="road-progress" aria-hidden="true">
        <div class="road-bar" style="width:${p}%"></div>
      </div>
    </div>
  `;
}

// ===============================
// Tabla GLOBAL por Centro (NO filtrada)
// ===============================
function renderGlobalByCentro() {
  // Agregación por centro
  const agg = new Map(); // centro -> { clients:Set, kg:number, val:number }
  for (const r of ROADMAP_ROWS) {
    const centro = String(r[RM.Centro] ?? "").trim() || "Sin Centro";
    const cliente = toKey(r[RM.Cliente]);
    const kg  = toNumber(r[RM.KgPlan]);
    const val = toNumber(r[RM.Valor]);

    if (!agg.has(centro)) agg.set(centro, { clients: new Set(), kg: 0, val: 0 });
    const o = agg.get(centro);
    if (cliente) o.clients.add(cliente);
    o.kg  += kg;
    o.val += val;
  }

  const data = Array.from(agg.entries()).map(([centro, o]) => ({
    centro, clientes: o.clients.size, kg: o.kg, val: o.val
  })).sort((a,b)=> b.val - a.val);

  // Totales (globales)
  const totClientes = data.reduce((s,x)=>s+x.clientes,0);
  const totKg       = data.reduce((s,x)=>s+x.kg,0);
  const totVal      = data.reduce((s,x)=>s+x.val,0);

  // Render
  const tbody = document.getElementById("tbodyCentro");
  tbody.innerHTML = data.length
    ? data.map(r => {
        const pCli = pct(r.clientes, totClientes);
        const pKg  = pct(r.kg, totKg);
        const pVal = pct(r.val, totVal);
        return `
          <tr>
            <td>${escapeHTML(r.centro)}</td>
            <td class="num">${cellRoadHTML(fmtInt.format(r.clientes), pCli)}</td>
            <td class="num">${cellRoadHTML(fmtNum.format(r.kg), pKg)}</td>
            <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), pVal)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" class="muted" style="padding:18px">Sin datos.</td></tr>`;

  document.getElementById("totClientesCen").textContent = fmtInt.format(totClientes);
  document.getElementById("totKgCen").textContent       = fmtNum.format(totKg);
  document.getElementById("totValCen").textContent      = fmtSoles.format(totVal).replace("S/.", "S/.");
}

// ===============================
// Tabla por Canal (FILTRADA por Centro)
// ===============================
function renderByCanal(centroValue) {
  const rows = (centroValue && centroValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[RM.Centro] ?? "").trim() === centroValue)
    : ROADMAP_ROWS;

  // Agregación por canal
  const agg = new Map(); // canal -> { clients:Set, kg:number, val:number }
  for (const r of rows) {
    const clienteKey = toKey(r[RM.Cliente]);
    const canal = CATALOGO_MAP.get(clienteKey) || "Sin Canal";
    const kg  = toNumber(r[RM.KgPlan]);
    const val = toNumber(r[RM.Valor]);

    if (!agg.has(canal)) agg.set(canal, { clients: new Set(), kg: 0, val: 0 });
    const o = agg.get(canal);
    if (clienteKey) o.clients.add(clienteKey);
    o.kg  += kg;
    o.val += val;
  }

  const data = Array.from(agg.entries()).map(([canal, o]) => ({
    canal, clientes: o.clients.size, kg: o.kg, val: o.val
  })).sort((a,b)=> b.val - a.val);

  // Totales (del conjunto filtrado)
  const totClientes = data.reduce((s,x)=>s+x.clientes,0);
  const totKg       = data.reduce((s,x)=>s+x.kg,0);
  const totVal      = data.reduce((s,x)=>s+x.val,0);

  // Render
  const tbody = document.getElementById("summaryBody");
  tbody.innerHTML = data.length
    ? data.map(r => {
        const pCli = pct(r.clientes, totClientes);
        const pKg  = pct(r.kg, totKg);
        const pVal = pct(r.val, totVal);
        return `
          <tr>
            <td>${escapeHTML(r.canal)}</td>
            <td class="num">${cellRoadHTML(fmtInt.format(r.clientes), pCli)}</td>
            <td class="num">${cellRoadHTML(fmtNum.format(r.kg), pKg)}</td>
            <td class="num">${cellRoadHTML(fmtSoles.format(r.val).replace("S/.", "S/."), pVal)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" class="muted" style="padding:18px">Sin datos para el filtro.</td></tr>`;

  document.getElementById("totClientes").textContent = fmtInt.format(totClientes);
  document.getElementById("totKg").textContent       = fmtNum.format(totKg);
  document.getElementById("totVal").textContent      = fmtSoles.format(totVal).replace("S/.", "S/.");
}
