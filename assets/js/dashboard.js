/* ==========================================================================
   RoadMap - dashboard.js (Control de Dashboard SaaS & Renderizado Dinámico)
   ========================================================================== */

(() => {
  const FALLBACKS = [
    window.RoadMapConfig?.CSV_URL,
    './RoadMap.csv',
    './assets/data/RoadMap.csv',
    'https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv'
  ].filter(Boolean);

  async function fetchWithTimeout(url, ms = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), ms);
    try {
      const bust = url.includes('?') ? '&' : '?';
      const resp = await fetch(url + bust + 't=' + Date.now(), {
        mode: 'cors', cache: 'no-store', signal: ctl.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (!text || !text.trim()) throw new Error('archivo vacío');
      return text;
    } finally { clearTimeout(timer); }
  }

  async function loadCSVWithFallback() {
    for (const u of FALLBACKS) {
      try { return await fetchWithTimeout(u); } catch {}
    }
    throw new Error('No se pudo cargar RoadMap.csv desde ningún origen.');
  }

  function parseCSV(text){
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    if (!lines.length) return { header:[], rows:[] };
    const header = lines[0].split(",");
    const rows = lines.slice(1).map(line => {
      const out=[]; let cur=""; let q=false;
      for (let i=0;i<line.length;i++){
        const c=line[i];
        if (c==='\"'){
          if(q && line[i+1]==='\"'){cur+='\"'; i++;}
          else q=!q;
        } else if(c===',' && !q){ out.push(cur); cur=""; }
        else cur+=c;
      }
      out.push(cur);
      return out;
    });
    return { header, rows };
  }

  const IDX = { CENTRO:1, PLACA:2, CLIENTE:3, RUTA:6, PEDIDO:7, KG:10, SOLES:11, CANAL:19 };
  const EXCLUDE_FRT = "FRT-001";
  const TRUCKS_EXCLUDED = new Set(["FRT-001", "RES-CLI"]);
  const isFRT = r => (String(r[IDX.PLACA] ?? "").trim().toUpperCase() === EXCLUDE_FRT);
  const isTruckExcluded = r => TRUCKS_EXCLUDED.has(String(r[IDX.PLACA] ?? "").trim().toUpperCase());
  const unique = arr => Array.from(new Set(arr.filter(v => v !== "" && v != null)));
  const toNum = v => { const n = parseFloat(String(v ?? "0").replace(",", ".")); return isNaN(n)?0:n; };
  const stripParens = s => String(s ?? "").replace(/\s*\([^\)]*\)/g, "");

  let allRows = [];
  let selectedCentro = "Todos";
  let activeMetric = "Pedidos";

  // Elementos DOM
  const filterCentro = document.getElementById("filterCentro");
  const kpiClientes = document.getElementById("kpiClientes");
  const kpiPedidos  = document.getElementById("kpiPedidos");
  const kpiKg       = document.getElementById("kpiKg");
  const kpiSoles    = document.getElementById("kpiSoles");
  const kpiCamiones = document.getElementById("kpiCamiones");

  const piKgCamion = document.getElementById("piKgCamion");
  const piKgCliente = document.getElementById("piKgCliente");
  const piClientesCamion = document.getElementById("piClientesCamion");

  async function init(){
    try{
      const text = await loadCSVWithFallback();
      const { rows } = parseCSV(text);
      allRows = rows;
      
      buildCentroFilter();
      setupInteractiveCards();
      render();
      window.addEventListener("resize", renderCharts);
    }catch(err){
      console.error("Error RoadMap.csv:", err);
      alert("No se pudo cargar RoadMap.csv para Dashboard");
    }
  }

  function setupInteractiveCards(){
    // Click en tarjetas KPI superiores para cambiar métrica activa
    document.querySelectorAll(".fin-kpi-card").forEach(card => {
      card.addEventListener("click", () => {
        const metric = card.getAttribute("data-metric");
        if (metric) {
          activeMetric = metric;
          renderCharts();
          // Scroll suave hacia los gráficos
          document.querySelector(".fin-dark-panel").scrollIntoView({ behavior: 'smooth' });
        }
      });
    });

    // Pestañas superiores del header
    document.querySelectorAll(".fin-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".fin-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
      });
    });

    // Pestañas del panel oscuro inferior
    document.querySelectorAll(".dark-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".dark-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
      });
    });
  }

  function buildCentroFilter(){
    const centros = ["Todos", ...unique(allRows.map(r => r[IDX.CENTRO] ?? "")).sort()];
    filterCentro.innerHTML = centros.map(c => `<option value="${c}">${c}</option>`).join("");
    filterCentro.value = selectedCentro;
    filterCentro.addEventListener("change", () => { selectedCentro = filterCentro.value; render(); });
  }

  function applyFilters(rows){
    return rows.filter(r => {
      const okC = (selectedCentro === "Todos" || (r[IDX.CENTRO] ?? "") === selectedCentro);
      return okC;
    });
  }

  const countClientes = rows => unique(rows.filter(r => !isFRT(r)).map(r => r[IDX.CLIENTE] ?? "")).length;
  const countPedidos  = rows => unique(rows.filter(r => !isFRT(r)).map(r => r[IDX.PEDIDO]  ?? "")).length;
  const sumKg         = rows => rows.filter(r => !isFRT(r)).reduce((a,r)=>a+toNum(r[IDX.KG]),0);
  const sumSoles      = rows => rows.filter(r => !isFRT(r)).reduce((a,r)=>a+toNum(r[IDX.SOLES]),0);
  const countTrucks   = rows => unique(rows.filter(r => !isTruckExcluded(r)).map(r => r[IDX.PLACA] ?? "")).length;

  function formatK(value){ return `S/ ${(value/1000).toLocaleString('en-US',{maximumFractionDigits:1})}K`; }

  function renderKPIs(){
    const rows = applyFilters(allRows);
    const clientes = countClientes(rows);
    const pedidos  = countPedidos(rows);
    const kg       = sumKg(rows);
    const soles    = sumSoles(rows);
    const camiones = countTrucks(rows);

    kpiClientes.textContent = clientes.toLocaleString("es-PE");
    kpiPedidos.textContent  = pedidos.toLocaleString("es-PE");
    kpiKg.textContent       = kg.toLocaleString("es-PE",{maximumFractionDigits:2});
    kpiSoles.textContent    = formatK(soles);
    kpiCamiones.textContent = camiones.toLocaleString("es-PE");

    const piKgCam = camiones ? (kg / camiones) : 0;
    const piKgCli = clientes ? (kg / clientes) : 0;
    const piCliCam= camiones ? (clientes / camiones) : 0;

    piKgCamion.textContent     = piKgCam.toLocaleString("es-PE",{maximumFractionDigits:2});
    piKgCliente.textContent    = piKgCli.toLocaleString("es-PE",{maximumFractionDigits:2});
    piClientesCamion.textContent = piCliCam.toLocaleString("es-PE",{maximumFractionDigits:2});
  }

  function metricCalc(rows, metricName){
    switch (metricName) {
      case "Clientes":       return countClientes(rows);
      case "Pedidos":        return countPedidos(rows);
      case "Kilogramos":     return sumKg(rows);
      case "Soles":          return sumSoles(rows);
      case "Camiones":       return countTrucks(rows);
      case "Kg/Camión":      { const kg=sumKg(rows), cam=countTrucks(rows);   return cam?kg/cam:0; }
      case "Kg/Cliente":     { const kg=sumKg(rows), cli=countClientes(rows); return cli?kg/cli:0; }
      case "Clientes/Camión":{ const cli=countClientes(rows), cam=countTrucks(rows); return cam?cli/cam:0; }
      default:               return countPedidos(rows);
    }
  }

  function chartH(containerId, series, { barColor="#3b82f6", valueFmt } = {}){
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    if (!series || series.length===0){ container.innerHTML='<div class="nodata">Sin datos</div>'; return; }

    const width = container.clientWidth || 740;
    const height = Math.max(260, 20 + series.length * 26);
    const leftX = 140;
    const padding = { top:10, right:24, bottom:10, left: leftX };

    const maxVal = Math.max(1, ...series.map(d=>d.value));
    const barH = Math.max(12, (height - padding.top - padding.bottom)/Math.max(1,series.length) - 6);
    const barGap = 6;
    const plotH = series.length * (barH + barGap);

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${Math.max(height, padding.top + plotH + padding.bottom)}`);
    svg.setAttribute("width","100%"); svg.setAttribute("height","100%");

    series.forEach((d,i)=>{
      const y = padding.top + i * (barH + barGap);
      const w = ((width - padding.left - padding.right) * d.value) / maxVal;

      const lbl = document.createElementNS(svgNS,"text");
      lbl.setAttribute("x", leftX - 10);
      lbl.setAttribute("y", y + barH * 0.75);
      lbl.setAttribute("text-anchor","end");
      lbl.setAttribute("font-size","12");
      lbl.setAttribute("fill","#cbd5e1");
      lbl.textContent = d.label;
      svg.appendChild(lbl);

      const rect = document.createElementNS(svgNS,"rect");
      rect.setAttribute("x", leftX);
      rect.setAttribute("y", y);
      rect.setAttribute("width", Math.max(2,w));
      rect.setAttribute("height", barH);
      rect.setAttribute("rx","4");
      rect.setAttribute("fill", barColor);
      svg.appendChild(rect);

      const val = document.createElementNS(svgNS,"text");
      const xVal = Math.min(leftX + w + 8, width - padding.right - 2);
      val.setAttribute("x", xVal);
      val.setAttribute("y", y + barH * 0.75);
      val.setAttribute("font-size","12");
      val.setAttribute("fill","#f8fafc");
      val.textContent = valueFmt ? valueFmt(d.value) : d.value.toLocaleString("es-PE",{maximumFractionDigits:2});
      svg.appendChild(val);
    });

    container.appendChild(svg);
  }

  function chartV(containerId, series, { barColor="#3b82f6", valueFmt } = {}){
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    if (!series || series.length===0){ container.innerHTML='<div class="nodata">Sin datos</div>'; return; }

    const width = container.clientWidth || 760;
    const height = 340;
    const padding = { top:25, right:18, bottom:70, left:50 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const n = series.length;
    const gap = 12;
    const barW = Math.max(16, Math.min(50, (plotW - gap * (n - 1)) / n));
    const maxVal = Math.max(1, ...series.map(d => d.value));

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width","100%"); svg.setAttribute("height","100%");

    series.forEach((d,i)=>{
      const x = padding.left + i * (barW + gap);
      const h = (plotH * d.value) / maxVal;
      const y = padding.top + (plotH - h);

      const rect = document.createElementNS(svgNS,"rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", barW);
      rect.setAttribute("height", Math.max(2,h));
      rect.setAttribute("rx","4");
      rect.setAttribute("fill", barColor);
      svg.appendChild(rect);

      const val = document.createElementNS(svgNS,"text");
      val.setAttribute("x", x + barW/2);
      val.setAttribute("y", Math.max(12, y - 6));
      val.setAttribute("text-anchor","middle");
      val.setAttribute("font-size","11");
      val.setAttribute("fill","#f8fafc");
      val.textContent = valueFmt ? valueFmt(d.value) : d.value.toLocaleString("es-PE",{maximumFractionDigits:2});
      svg.appendChild(val);

      const label = document.createElementNS(svgNS,"text");
      label.setAttribute("x", x + barW/2);
      label.setAttribute("y", height - 15);
      label.setAttribute("text-anchor","middle");
      label.setAttribute("font-size","11");
      label.setAttribute("fill","#cbd5e1");
      label.textContent = d.label;
      svg.appendChild(label);
    });

    container.appendChild(svg);
  }

  const topN = (arr,n=10)=>[...arr].sort((a,b)=>b.value-a.value).slice(0,n);
  const bottomN = (arr,n=10)=>[...arr].sort((a,b)=>a.value-b.value).slice(0,n);

  function seriesByGroup(rows, keyFn, metricName){
    const map = new Map();
    rows.forEach(r => {
      const k = keyFn(r);
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    return Array.from(map.entries()).map(([label, groupRows]) => ({
      label: stripParens(label), value: metricCalc(groupRows, metricName)
    }));
  }

  function renderCharts(){
    const rows = applyFilters(allRows);
    const metricName = activeMetric;
    const isMoney = (metricName === "Soles");
    const valueFmt = (v) => isMoney
      ? new Intl.NumberFormat("es-PE",{style:"currency",currency:"PEN",maximumFractionDigits:2}).format(v)
      : v.toLocaleString("es-PE",{maximumFractionDigits:2});

    // 1. Centros
    {
      const map = new Map();
      rows.forEach(r => { const k=r[IDX.CENTRO] ?? ""; if(!k) return; if(!map.has(k)) map.set(k,[]); map.get(k).push(r); });
      const serie = Array.from(map.entries()).map(([label,group]) => ({ label, value: metricCalc(group, metricName) }));
      chartV("chartCentrosV", topN(serie, 10), { barColor:"#3b82f6", valueFmt });
    }

    // 2. Canales
    {
      const map = new Map();
      rows.forEach(r => { const k=r[IDX.CANAL] ?? ""; if(!k) return; if(!map.has(k)) map.set(k,[]); map.get(k).push(r); });
      const serie = Array.from(map.entries()).map(([label,group]) => ({ label, value: metricCalc(group, metricName) }));
      chartV("chartCanalV", topN(serie, 10), { barColor:"#f59e0b", valueFmt });
    }

    // 3. Camiones y Rutas
    const truckRows = rows.filter(r => !isTruckExcluded(r));
    chartH('chartTruckBest',  topN(seriesByGroup(truckRows, r => r[IDX.PLACA] ?? "", metricName), 10), { barColor:"#10b981", valueFmt });
    chartH('chartTruckWorst', bottomN(seriesByGroup(truckRows, r => r[IDX.PLACA] ?? "", metricName).filter(d=>d.value>0), 10), { barColor:"#64748b", valueFmt });
    chartH('chartRutaBest',   topN(seriesByGroup(rows, r => r[IDX.RUTA] ?? "", metricName).filter(d=>d.value>0), 10), { barColor:"#10b981", valueFmt });
    chartH('chartRutaWorst',  bottomN(seriesByGroup(rows, r => r[IDX.RUTA] ?? "", metricName).filter(d=>d.value>0), 10), { barColor:"#f59e0b", valueFmt });
  }

  function render(){
    renderKPIs();
    renderCharts();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
