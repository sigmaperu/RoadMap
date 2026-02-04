// dashboard.js

// === Configuración: URLs de los CSV (usa las que compartiste) ===
const ROADMAP_CSV_URL  = "https://raw.github.com/sigmaperu/RoadMap/blob/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.github.com/sigmaperu/RoadMap/blob/main/Catalogo%20Sigma.csv";

// === Utilidad: normalizar URLs de GitHub a raw.githubusercontent.com ===
function normalizeGitHubRaw(url) {
  if (!url) return url;
  // Reemplaza dominios y /blob/ por ruta raw directa
  return url
    .replace(/^https?:\/\/raw\.github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/^https?:\/\/github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/\/blob\//, "/");
}

// === CSV parser simple con soporte de comillas ===
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inQuotes) {
      if (c === '"' && n === '"') { // comilla escapada ""
        cur += '"'; i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cur); cur = "";
      } else if (c === '\n') {
        row.push(cur); rows.push(row); row = []; cur = "";
      } else if (c === '\r') {
        // ignorar CR, manejar CRLF
      } else {
        cur += c;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// === Normalización numérica (maneja miles y decimales con coma o punto) ===
function toNumber(s) {
  if (s == null) return 0;
  let x = String(s).trim();
  if (x === "") return 0;
  // Si tiene ambos . y , asumimos . miles y , decimal
  if (x.includes(".") && x.includes(",")) {
    x = x.replace(/\./g, "").replace(",", ".");
  } else if (x.includes(",")) {
    // Solo coma -> decimal con coma
    x = x.replace(/\./g, "").replace(",", ".");
  } else {
    // Solo punto -> decimal con punto, eliminar comas de miles (por si acaso)
    x = x.replace(/,/g, "");
  }
  const n = parseFloat(x);
  return isNaN(n) ? 0 : n;
}

// === Formateadores ===
const fmtInt  = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtKg   = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtSoles= new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });

// === Estado ===
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map(); // key: cliente (cat[0]) -> canal (cat[21])
let LOCATIONS = [];

// === Cargar datos y preparar UI ===
(async function init() {
  const status = document.getElementById("status");
  try {
    status?.querySelector("span:last-child") && (status.querySelector("span:last-child").textContent = "Cargando CSV…");

    const [roadmapText, catalogoText] = await Promise.all([
      fetch(normalizeGitHubRaw(ROADMAP_CSV_URL)).then(r => r.text()),
      fetch(normalizeGitHubRaw(CATALOGO_CSV_URL)).then(r => r.text()),
    ]);

    let roadmap = parseCSV(roadmapText).filter(r => r && r.length > 1);
    let catalog = parseCSV(catalogoText).filter(r => r && r.length > 1);

    // Detectar y remover cabeceras básicas (si Kg/Valor no son números en la primera fila)
    const hasHeaderRoadmap = roadmap.length > 0 && (isNaN(toNumber(roadmap[0][10])) && isNaN(toNumber(roadmap[0][11])));
    if (hasHeaderRoadmap) roadmap.shift();

    const maybeHeaderCatalog = catalog.length > 0 && (typeof catalog[0][0] === "string" && /cliente|cod/i.test(catalog[0][0] || "") || typeof catalog[0][21] === "string" && /canal/i.test(catalog[0][21] || ""));
    if (maybeHeaderCatalog) catalog.shift();

    ROADMAP_ROWS = roadmap;

    // Construir mapa de cliente -> canal
    CATALOGO_MAP = new Map();
    for (const row of catalog) {
      const key = String(row[0] ?? "").trim();           // índice 0 (clave del catálogo)
      const canal = String(row[21] ?? "").trim() || "Sin Canal"; // índice 21 (canal)
      if (key) CATALOGO_MAP.set(key, canal);
    }

    // Poblar filtro de Location (col índice 1 en RoadMap)
    const locSet = new Set();
    for (const r of ROADMAP_ROWS) {
      const loc = String(r[1] ?? "").trim();
      if (loc) locSet.add(loc);
    }
    LOCATIONS = Array.from(locSet).sort((a,b)=>a.localeCompare(b,"es"));
    const sel = document.getElementById("locationFilter");
    if (sel) {
      for (const loc of LOCATIONS) {
        const opt = document.createElement("option");
        opt.value = loc;
        opt.textContent = loc;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => renderSummary(sel.value));
    }

    // Render inicial (todas las locations)
    renderSummary("__all__");

    // Estado listo
    if (status) {
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=> { status.style.display = "none"; }, 600);
    }
  } catch (err) {
    console.error("Error cargando datos:", err);
    if (status) {
      status.innerHTML = `<span>⚠️ No se pudo cargar los CSV. Revisa los enlaces o CORS.</span>`;
    }
  }
})();

// === Agrupar por Canal y renderizar ===
function renderSummary(locationValue) {
  // Filtrar por location si corresponde
  const rows = (locationValue && locationValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[1] ?? "").trim() === locationValue)
    : ROADMAP_ROWS;

  // Acumular por canal
  const agg = new Map(); // canal -> { clients:Set, kg:number, val:number }
  for (const r of rows) {
    const cliente = String(r[3] ?? "").trim(); // índice 3 en RoadMap
    const canal = CATALOGO_MAP.get(cliente) || "Sin Canal";
    const kg    = toNumber(r[10]); // índice 10 (Kg Plan.)
    const val   = toNumber(r[11]); // índice 11 (Valor S/.)

    if (!agg.has(canal)) agg.set(canal, { clients: new Set(), kg: 0, val: 0 });
    const o = agg.get(canal);
    if (cliente) o.clients.add(cliente);
    o.kg  += kg;
    o.val += val;
  }

  // Convertir a array y ordenar por Valor desc
  const out = Array.from(agg.entries()).map(([canal, o]) => ({
    canal, clientes: o.clients.size, kg: o.kg, val: o.val
  })).sort((a,b)=> b.val - a.val);

  // Totales
  const totClientes = out.reduce((s,x)=> s + x.clientes, 0);
  const totKg       = out.reduce((s,x)=> s + x.kg, 0);
  const totVal      = out.reduce((s,x)=> s + x.val, 0);

  // Render tabla
  const tbody = document.getElementById("summaryBody");
  tbody.innerHTML = out.length
    ? out.map(r => `
      <tr>
        <td>${escapeHTML(r.canal)}</td>
        <td class="num">${fmtInt.format(r.clientes)}</td>
        <td class="num">${fmtKg.format(r.kg)}</td>
        <td class="num">${fmtSoles.format(r.val).replace("S/.", "S/.")}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted" style="padding:18px">Sin resultados para el filtro.</td></tr>`;

  document.getElementById("totClientes").textContent = fmtInt.format(totClientes);
  document.getElementById("totKg").textContent       = fmtKg.format(totKg);
  document.getElementById("totVal").textContent      = fmtSoles.format(totVal).replace("S/.", "S/.");
}

// Escapar HTML básico
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#39;"
  }[m]));
}
