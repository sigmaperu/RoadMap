// ===============================
// CONFIG
// ===============================
const URL_ROADMAP  = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
const URL_CATALOGO = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/Catalogo%20Sigma.csv";

let DATA_ROADMAP = [];
let MAP_CATALOGO = new Map();
let CHART_VALOR, CHART_KG, CHART_DONUT;

// ===============================
// MIDI PARSER CSV
// ===============================
function parseCSV(text){
  return text.trim().split(/\r?\n/).map(r => r.split(","));
}

// ===============================
// NUMERIC NORMALIZER
// ===============================
function n(x){
  return Number(String(x).replace(",",".").replace(/[^0-9.\-]/g,"")) || 0;
}

// ===============================
// LOAD DATA
// ===============================

async function cargarDatos(){
  const estado = id("estadoCarga");
  estado.textContent = "Cargando datos…";

  const [r1, r2] = await Promise.all([
    fetch(URL_ROADMAP).then(r=>r.text()),
    fetch(URL_CATALOGO).then(r=>r.text()),
  ]);

  let rm = parseCSV(r1);
  let cat = parseCSV(r2);

  // Omitir encabezados
  rm.shift();
  cat.shift();

  DATA_ROADMAP = rm;

  MAP_CATALOGO.clear();
  for (let i of cat){
    let key = i[0]?.trim().toUpperCase();
    let canal = i[21] || "Sin Canal";
    MAP_CATALOGO.set(key, canal);
  }

  estado.textContent = "Listo";
  setTimeout(()=> estado.remove(), 800);

  poblarCentros();
  render("__all__");
}

// ===============================
// UTILIDADES
// ===============================
const id = x => document.getElementById(x);

function poblarCentros(){
  const set = new Set();

  DATA_ROADMAP.forEach(r => {
    if(r[1]) set.add(r[1].trim());
  });

  const sel = id("filtroCentro");
  [...set].sort().forEach(c => {
    let o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  });

  sel.onchange = ()=> render(sel.value);
}

// ===============================
// RENDER TABLA + CHARTS
// ===============================
function render(centro){
  let rows = centro === "__all__"
    ? DATA_ROADMAP
    : DATA_ROADMAP.filter(r => r[1] === centro);

  // Agregación por Canal
  let agg = new Map();

  for (let r of rows){
    let cliente = r[3]?.trim().toUpperCase();
    let canal = MAP_CATALOGO.get(cliente) || "Sin Canal";
    let kg = n(r[10]);
    let val = n(r[11]);

    if(!agg.has(canal))
      agg.set(canal, {clientes:new Set(), kg:0, val:0});

    let obj = agg.get(canal);
    obj.clientes.add(cliente);
    obj.kg += kg;
    obj.val += val;
  }

  const arr = [...agg.entries()].map(([canal,o]) => ({
    canal,
    clientes: o.clientes.size,
    kg: o.kg,
    val: o.val
  })).sort((a,b)=>b.val-a.val);

  // Render tabla
  const tbody = id("tbodyResumen");
  tbody.innerHTML = arr.map(r => `
    <tr>
      <td>${r.canal}</td>
      <td class="num">${r.clientes}</td>
      <td class="num">${r.kg.toLocaleString("es-PE")}</td>
      <td class="num">S/. ${r.val.toLocaleString("es-PE")}</td>
    </tr>
  `).join("");

  // Totales
  id("tClientes").textContent = arr.reduce((a,b)=>a+b.clientes,0).toLocaleString();
  id("tKg").textContent       = arr.reduce((a,b)=>a+b.kg,0).toLocaleString("es-PE");
  id("tValor").textContent    = "S/. " + arr.reduce((a,b)=>a+b.val,0).toLocaleString("es-PE");

  // Charts
  renderCharts(arr);
}

// ===============================
// CHARTS
// ===============================
function renderCharts(arr){
  const labels = arr.map(r=>r.canal);
  const valores = arr.map(r=>r.val);
  const kilos   = arr.map(r=>r.kg);

  // LIMPIAR GRAFICOS PREVIOS
  [CHART_VALOR, CHART_KG, CHART_DONUT].forEach(c => c?.destroy());

  // ---- Valor
  CHART_VALOR = new Chart(id("chartValor"), {
    type:"bar",
    data:{ labels, datasets:[{
      label:"Valor (S/.)",
      data:valores,
      backgroundColor:"#f1c40f"
    }]},
    options:{ responsive:true, plugins:{legend:{display:false}} }
  });

  // ---- Kg
  CHART_KG = new Chart(id("chartKg"), {
    type:"bar",
    data:{ labels, datasets:[{
      label:"Kg",
      data:kilos,
      backgroundColor:"#f39c12"
    }]},
    options:{ responsive:true, plugins:{legend:{display:false}} }
  });

  // ---- Donut
  CHART_DONUT = new Chart(id("chartDonut"), {
    type:"doughnut",
    data:{
      labels,
      datasets:[{
        data: valores,
        backgroundColor: labels.map((_,i)=>`hsl(${i*40},80%,55%)`)
      }]
    },
    options:{ responsive:true }
  });
}

// ===============================
// INICIO
// ===============================
cargarDatos();
