// ===============================
// CONFIG: URLs correctas (raw.githubusercontent.com)
// ===============================
const ROADMAP_CSV_URL  = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/Catalogo%20Sigma.csv";

// Índices (0-based) acordados
const RM = { Centro: 1, Cliente: 3, KgPlan: 10, Valor: 11 };
const CT = { Clave: 0, Canal: 21 };

// Formatters
const fmtInt    = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtNum    = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const fmtSoles  = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });
const toKey     = s => String(s ?? "").trim().replace(/\s+/g," ").toUpperCase();

// Estado
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map(); // cliente -> canal
let chartValor = null, chartKg = null, chartDonut = null;

// Chart.js en modo oscuro
if (window.Chart) {
  Chart.defaults.color = "#cfcfcf";
  Chart.defaults.borderColor = "#333";
  Chart.defaults.plugins.legend.labels = { color:"#cfcfcf", usePointStyle:true, pointStyle:"circle" };
  Chart.defaults.datasets.bar.borderRadius = 6;
}

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
(async function init() {
  const status = document.getElementById("status");
  try {
    status && (status.querySelector("span:last-child").textContent = "Descargando CSV…");

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

    ROADMAP_ROWS = roadmap;

    // Mapa cliente -> canal
    CATALOGO_MAP.clear();
    for (const row of catalog) {
      const key = toKey(row[CT.Clave]);
      const canal = String(row[CT.Canal] ?? "").trim() || "Sin Canal";
      if (key) CATALOGO_MAP.set(key, canal);
    }

    // Poblar filtro "Centro"
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
    sel.addEventListener("change", () => render(sel.value));

    // Render inicial
    render("__all__");

    // Estado
    if (status) {
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=>{ status.style.display="none"; }, 800);
    }

    console.log("[Dashboard] RoadMap filas:", ROADMAP_ROWS.length, "Catálogo claves:", CATALOGO_MAP.size);
  } catch (err) {
    console.error("Error cargando datos:", err);
    if (status) status.innerHTML = `<span>⚠️ ${String(err.message || err)}</span>`;
  }
})();

// ===============================
// Render tabla y gráficos
// ===============================
function render(centroValue) {
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

  // Totales
  const totClientes = data.reduce((s,x)=>s+x.clientes,0);
  const totKg       = data.reduce((s,x)=>s+x.kg,0);
  const totVal      = data.reduce((s,x)=>s+x.val,0);

  // Tabla con % y barra de progreso en cada métrica
  const tbody = document.getElementById("summaryBody");
  const pct = (value,total) => total>0 ? (value/total*100) : 0;
  const pctTxt = p => `${p.toFixed(1)}%`;

  const cellStatHTML = (valFmt, part, colorClass="brand") => `
    <div class="cell-stat">
      <div class="cell-top">
        <span>${valFmt}</span>
        <span class="pct">(${pctTxt(part)})</span>
      </div>
      <div class="progress"><div class="bar" style="width:${Math.min(100,part)}%"></div></div>
    </div>
  `;

  tbody.innerHTML = data.length
    ? data.map(r => {
        const pCli = pct(r.clientes, totClientes);
        const pKg  = pct(r.kg, totKg);
        const pVal = pct(r.val, totVal);
        return `
          <tr>
            <td>${escapeHTML(r.canal)}</td>
            <td class="num">${cellStatHTML(fmtInt.format(r.clientes), pCli)}</td>
            <td class="num">${cellStatHTML(fmtNum.format(r.kg), pKg)}</td>
            <td class="num">${cellStatHTML(fmtSoles.format(r.val).replace("S/.", "S/."), pVal)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" class="muted" style="padding:18px">Sin datos.</td></tr>`;

  document.getElementById("totClientes").textContent = fmtInt.format(totClientes);
  document.getElementById("totKg").textContent       = fmtNum.format(totKg);
  document.getElementById("totVal").textContent      = fmtSoles.format(totVal).replace("S/.", "S/.");

  // Gráficos (barras horizontales)
  renderCharts(data);
}

// ===============================
// Gráficos (horizontales + altura dinámica)
// ===============================
function renderCharts(rows) {
  const labels  = rows.map(r => r.canal);
  const valores = rows.map(r => r.val);
  const kilos   = rows.map(r => r.kg);

  // Destruir instancias previas
  [chartValor, chartKg, chartDonut].forEach(c => c && c.destroy());

  // Paleta simple pero suficiente
  const colors = labels.map((_,i)=> `hsl(${(i*47)%360} 85% 55%)`);

  // Altura dinámica de canvas según cantidad de categorías (para no “estirar” la página)
  const setCanvasHeight = (canvas, n) => {
    const h = Math.max(140, n * 32 + 60); // 32px por categoría + margen
    canvas.height = h;
  };

  const ctxVal = document.getElementById("chartValor");
  const ctxKg  = document.getElementById("chartKg");
  const ctxDon = document.getElementById("chartDonut");

  if (ctxVal) {
    setCanvasHeight(ctxVal, labels.length);
    chartValor = new Chart(ctxVal, {
      type: "bar",
      data: { labels, datasets: [{ label: "Valor (S/.)", data: valores, backgroundColor: colors, parsing:false }] },
      options: {
        indexAxis: "y",           // << horizontal
        animation: { duration: 250 },
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { callback: v => fmtSoles.format(v).replace("S/.", "S/.") } },
          y: { grid: { display: false } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  if (ctxKg) {
    setCanvasHeight(ctxKg, labels.length);
    chartKg = new Chart(ctxKg, {
      type: "bar",
      data: { labels, datasets: [{ label: "Kg Plan.", data: kilos, backgroundColor: colors, parsing:false }] },
      options: {
        indexAxis: "y",           // << horizontal
        animation: { duration: 250 },
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { callback: v => fmtNum.format(v) } },
          y: { grid: { display: false } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  if (ctxDon) {
    chartDonut = new Chart(ctxDon, {
      type: "doughnut",
      data: { labels, datasets: [{ data: valores, backgroundColor: colors, borderColor: "#000", borderWidth: 1 }] },
      options: {
        maintainAspectRatio: false,
        cutout: "58%",
        animation: { duration: 250 },
        plugins: {
          legend: { position: "bottom" },
          tooltip: { callbacks: { label: c => ` ${c.label}: ${fmtSoles.format(c.raw).replace("S/.", "S/.")}` } }
        }
      }
    });
  }
}
