// dashboard.js

// === Config: URLs de los CSV proporcionados ===
const ROADMAP_CSV_URL  = "https://raw.github.com/sigmaperu/RoadMap/blob/main/RoadMap.csv";
const CATALOGO_CSV_URL = "https://raw.github.com/sigmaperu/RoadMap/blob/main/Catalogo%20Sigma.csv";

// === Normaliza URLs de GitHub a raw.githubusercontent.com ===
function normalizeGitHubRaw(url) {
  if (!url) return url;
  return url
    .replace(/^https?:\/\/raw\.github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/^https?:\/\/github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/\/blob\//, "/");
}

// === CSV parser simple (soporta comillas) ===
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  // Remover BOM si existe
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inQuotes) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ""; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === '\r') { /* ignore */ }
      else { cur += c; }
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

// === Normalización numérica (puntos y comas) ===
function toNumber(s) {
  if (s == null) return 0;
  let x = String(s).trim();
  if (x === "") return 0;
  if (x.includes(".") && x.includes(",")) {
    x = x.replace(/\./g, "").replace(",", ".");
  } else if (x.includes(",")) {
    x = x.replace(/\./g, "").replace(",", ".");
  } else {
    x = x.replace(/,/g, "");
  }
  const n = parseFloat(x);
  return isNaN(n) ? 0 : n;
}

const fmtInt   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const fmtNum   = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const fmtSoles = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 });

const ROADMAP_IDX = {
  Centro: 1,      // "Location" en tu descripción, renombrado a Centro
  Cliente: 3,
  KgPlan: 10,
  Valor: 11,
};

const CATALOGO_IDX = {
  Clave: 0,
  Canal: 21,
};

// Helpers de normalización de claves cliente
const norm = s => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

// Estado
let ROADMAP_ROWS = [];
let CATALOGO_MAP = new Map(); // cliente normalizado -> canal
let LOCATIONS = [];

// Charts instances para poder destruir/actualizar
let chartValor = null;
let chartKg    = null;
let chartDonut = null;

// Colores
const COLOR_BRAND = "#f1c40f";
const COLOR_BORDER = "#333";

// Chart.js defaults en modo oscuro
if (window.Chart) {
  Chart.defaults.color = "#cfcfcf";
  Chart.defaults.borderColor = COLOR_BORDER;
  Chart.defaults.plugins.legend.labels = { color: "#cfcfcf", usePointStyle: true, pointStyle: "circle" };
  Chart.defaults.datasets.bar.borderRadius = 6;
}

// Inicialización
(async function init() {
  const status = document.getElementById("status");
  try {
    status?.querySelector("span:last-child") && (status.querySelector("span:last-child").textContent = "Cargando CSV…");

    const [roadmapText, catalogText] = await Promise.all([
      fetch(normalizeGitHubRaw(ROADMAP_CSV_URL)).then(r => r.text()),
      fetch(normalizeGitHubRaw(CATALOGO_CSV_URL)).then(r => r.text()),
    ]);

    let roadmap = parseCSV(roadmapText).filter(r => r && r.length > 1);
    let catalog = parseCSV(catalogText).filter(r => r && r.length > 1);

    // Omitir SIEMPRE encabezado en RoadMap (primera fila)
    if (roadmap.length) roadmap.shift();

    // Omitir encabezado en Catálogo si el col 21 parece "Canal"
    if (catalog.length && /canal/i.test(String(catalog[0][CATALOGO_IDX.Canal] || ""))) {
      catalog.shift();
    }

    ROADMAP_ROWS = roadmap;

    // Mapa de cliente -> canal
    CATALOGO_MAP.clear();
    for (const row of catalog) {
      const key = norm(row[CATALOGO_IDX.Clave]);
      const canal = String(row[CATALOGO_IDX.Canal] ?? "").trim() || "Sin Canal";
      if (key) CATALOGO_MAP.set(key, canal);
    }

    // Poblar filtro de Centro (col índice 1)
    const locSet = new Set();
    for (const r of ROADMAP_ROWS) {
      const loc = String(r[ROADMAP_IDX.Centro] ?? "").trim();
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
      sel.addEventListener("change", () => render(sel.value));
    }

    // Primer render (todos los centros)
    render("__all__");

    // Estado listo
    if (status) {
      status.innerHTML = `<span class="dotloader" aria-hidden="true"></span><span>Listo</span>`;
      setTimeout(()=> { status.style.display = "none"; }, 700);
    }
  } catch (e) {
    console.error("Error cargando datos:", e);
    if (status) status.innerHTML = `<span>⚠️ No se pudo cargar los CSV. Revisa los enlaces o CORS.</span>`;
  }
})();

// Render de tabla y charts según filtro
function render(locationValue) {
  const filtered = (locationValue && locationValue !== "__all__")
    ? ROADMAP_ROWS.filter(r => String(r[ROADMAP_IDX.Centro] ?? "").trim() === locationValue)
    : ROADMAP_ROWS;

  // Agregación por Canal
  const agg = new Map(); // canal -> { clients:Set, kg:number, val:number }
  for (const r of filtered) {
    const cliente = norm(r[ROADMAP_IDX.Cliente]);
    const canal = CATALOGO_MAP.get(cliente) || "Sin Canal";
    const kg  = toNumber(r[ROADMAP_IDX.KgPlan]);
    const val = toNumber(r[ROADMAP_IDX.Valor]);

    if (!agg.has(canal)) agg.set(canal, { clients: new Set(), kg: 0, val: 0 });
    const o = agg.get(canal);
    if (cliente) o.clients.add(cliente);
    o.kg  += kg;
    o.val += val;
  }

  // Array ordenado por Valor desc
  const rows = Array.from(agg.entries()).map(([canal, o]) => ({
    canal,
    clientes: o.clients.size,
    kg: o.kg,
    val: o.val
  })).sort((a,b)=> b.val - a.val);

  // Totales
  const totClientes = rows.reduce((s,x)=> s + x.clientes, 0);
  const totKg       = rows.reduce((s,x)=> s + x.kg, 0);
  const totVal      = rows.reduce((s,x)=> s + x.val, 0);

  // Render tabla
  const tbody = document.getElementById("summaryBody");
  tbody.innerHTML = rows.length
    ? rows.map(r => `
      <tr>
        <td>${escapeHTML(r.canal)}</td>
        <td class="num">${fmtInt.format(r.clientes)}</td>
        <td class="num">${fmtNum.format(r.kg)}</td>
        <td class="num">${fmtSoles.format(r.val).replace("S/.", "S/.")}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="muted" style="padding:18px">Sin resultados para el filtro.</td></tr>`;

  document.getElementById("totClientes").textContent = fmtInt.format(totClientes);
  document.getElementById("totKg").textContent       = fmtNum.format(totKg);
  document.getElementById("totVal").textContent      = fmtSoles.format(totVal).replace("S/.", "S/.");

  // Render/actualiza charts
  renderCharts(rows);
}

// Gráficos (Chart.js)
function renderCharts(rows) {
  const labels = rows.map(r => r.canal);
  const dataVal = rows.map(r => r.val);
  const dataKg  = rows.map(r => r.kg);

  // Paleta basada en amarillo con variaciones
  const colors = labels.map((_, i) => shade(COLOR_BRAND, -0.15 + (i % 8)*0.05));
  const colorsBorder = colors.map(c => c);

  // Destruir instancias anteriores
  [chartValor, chartKg, chartDonut].forEach(ch => ch && ch.destroy());

  const ctxVal = document.getElementById("chartValor");
  const ctxKg  = document.getElementById("chartKg");
  const ctxDon = document.getElementById("chartDonut");

  if (ctxVal) {
    chartValor = new Chart(ctxVal, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Valor (S/.)",
          data: dataVal,
          backgroundColor: colors,
          borderColor: colorsBorder,
          borderWidth: 1
        }]
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: {
            ticks: { callback: v => fmtSoles.format(v).replace("S/.", "S/.") }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${fmtSoles.format(ctx.raw).replace("S/.", "S/.")}`
            }
          },
          legend: { display: false }
        }
      }
    });
  }

  if (ctxKg) {
    chartKg = new Chart(ctxKg, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Kg Plan.",
          data: dataKg,
          backgroundColor: colors,
          borderColor: colorsBorder,
          borderWidth: 1
        }]
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: v => fmtNum.format(v) } }
        },
        plugins: {
          tooltip: { callbacks: { label: ctx => ` ${fmtNum.format(ctx.raw)} kg` } },
          legend: { display: false }
        }
      }
    });
  }

  if (ctxDon) {
    chartDonut = new Chart(ctxDon, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          label: "Participación por Valor",
          data: dataVal,
          backgroundColor: colors,
          borderColor: "#000",
          borderWidth: 1
        }]
      },
      options: {
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtSoles.format(ctx.raw).replace("S/.", "S/.")}` } },
          legend: { position: "bottom" }
        }
      }
    });
  }
}

// Pequeña utilidad para variar color (hsl)
function shade(hex, lum = 0) {
  // convierte #rrggbb a hsl y ajusta luminosidad
  const c = hex.replace("#",""); 
  const r = parseInt(c.substr(0,2),16)/255;
  const g = parseInt(c.substr(2,2),16)/255;
  const b = parseInt(c.substr(4,2),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max===min) { h=0; s=0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      case b: h = (r-g)/d + 4; break;
    }
    h/=6;
  }
  l = Math.min(1, Math.max(0, l + lum));
  // hsl -> rgb
  const hue2rgb = (p, q, t) => {
    if (t<0) t+=1; if (t>1) t-=1;
    if (t<1/6) return p + (q-p)*6*t;
    if (t<1/2) return q;
    if (t<2/3) return p + (q-p)*(2/3 - t)*6;
    return p;
  };
  const q = l < .5 ? l*(1+s) : l + s - l*s;
  const p = 2*l - q;
  const R = Math.round(hue2rgb(p,q,h+1/3)*255);
  const G = Math.round(hue2rgb(p,q,h)*255);
  const B = Math.round(hue2rgb(p,q,h-1/3)*255);
  return `rgb(${R},${G},${B})`;
}

// Escape básico
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;'}[m]));
}
