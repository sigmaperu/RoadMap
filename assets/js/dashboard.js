/* ==========================================================================
   RoadMap - dashboard.js (Cross-Filtering Finnova Engine • Cero Combos)
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

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    if (!lines.length) return { header: [], rows: [] };
    const header = lines[0].split(",");
    const rows = lines.slice(1).map(line => {
      const out = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (q && line[i + 1] === '"') { cur += '"'; i++; }
          else q = !q;
        } else if (c === ',' && !q) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out;
    });
    return { header, rows };
  }

  // Índices y reglas de negocio corporativas (Exclusión FRT-001 y RES-CLI)
  const IDX = { CENTRO: 1, PLACA: 2, CLIENTE: 3, RUTA: 6, PEDIDO: 7, KG: 10, SOLES: 11, CANAL: 19 };
  const EXCLUDE_FRT = "FRT-001";
  const TRUCKS_EXCLUDED = new Set(["FRT-001", "RES-CLI"]);
  const isFRT = r => (String(r[IDX.PLACA] ?? "").trim().toUpperCase() === EXCLUDE_FRT);
  const isTruckExcluded = r => TRUCKS_EXCLUDED.has(String(r[IDX.PLACA] ?? "").trim().toUpperCase());
  const unique = arr => Array.from(new Set(arr.filter(v => v !== "" && v != null)));
  const toNum = v => { const n = parseFloat(String(v ?? "0").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const stripParens = s => String(s ?? "").replace(/\s*\([^\)]*\)/g, "");

  // Estado Global de Interacción Cruzada (Cross-Filtering)
  let allRows = [];
  let state = {
    centro: "Todos",      // Filtrado desde las píldoras superiores o desde la lista
    canal: "Todos",       // Filtrado desde los chips de canal o desde la lista
    metric: "Pedidos",    // Filtrado al tocar cualquiera de las tarjetas o PIs
    dimension: "CENTRO",  // CENTRO | CANAL | PLACA | RUTA (Pestañas del Notch)
    selectedItem: null,   // Ítem específico seleccionado en la lista izquierda
    bestOrder: true       // true = Top Performers, false = Top Offenders
  };

  // Referencias DOM
  const centroPillsBar = document.getElementById("centroPillsBar");
  const canalQuickPills = document.getElementById("canalQuickPills");
  const activeFilterBadges = document.getElementById("activeFilterBadges");
  const activeContextSubtitle = document.getElementById("activeContextSubtitle");

  // Funciones de Agregación
  const countClientes = rows => unique(rows.filter(r => !isFRT(r)).map(r => r[IDX.CLIENTE] ?? "")).length;
  const countPedidos  = rows => unique(rows.filter(r => !isFRT(r)).map(r => r[IDX.PEDIDO]  ?? "")).length;
  const sumKg         = rows => rows.filter(r => !isFRT(r)).reduce((a, r) => a + toNum(r[IDX.KG]), 0);
  const sumSoles      = rows => rows.filter(r => !isFRT(r)).reduce((a, r) => a + toNum(r[IDX.SOLES]), 0);
  const countTrucks   = rows => unique(rows.filter(r => !isTruckExcluded(r)).map(r => r[IDX.PLACA] ?? "")).length;

  function metricCalc(rows, metricName) {
    switch (metricName) {
      case "Clientes":        return countClientes(rows);
      case "Pedidos":         return countPedidos(rows);
      case "Kilogramos":      return sumKg(rows);
      case "Soles":           return sumSoles(rows);
      case "Camiones":        return countTrucks(rows);
      case "Kg/Camión":       { const kg = sumKg(rows), cam = countTrucks(rows); return cam ? kg / cam : 0; }
      case "Kg/Cliente":      { const kg = sumKg(rows), cli = countClientes(rows); return cli ? kg / cli : 0; }
      case "Clientes/Camión": { const cli = countClientes(rows), cam = countTrucks(rows); return cam ? cli / cam : 0; }
      default:                return countPedidos(rows);
    }
  }

  function formatMetric(val, metricName, compact = false) {
    if (metricName === "Soles") {
      if (compact && val >= 1000) return `S/ ${(val / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
      return `S/ ${val.toLocaleString("es-PE", { maximumFractionDigits: 1 })}`;
    }
    if (metricName === "Kilogramos") {
      if (compact && val >= 1000) return `${(val / 1000).toLocaleString("es-PE", { maximumFractionDigits: 1 })} T`;
      return `${val.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg`;
    }
    if (metricName.includes("/")) {
      return val.toLocaleString("es-PE", { maximumFractionDigits: 2 });
    }
    return val.toLocaleString("es-PE", { maximumFractionDigits: 0 });
  }

  // Filas filtradas según selecciones activas
  function getFilteredRows(ignoreSelectedItem = false) {
    return allRows.filter(r => {
      const okCentro = (state.centro === "Todos" || (r[IDX.CENTRO] ?? "") === state.centro);
      const okCanal  = (state.canal === "Todos"  || (r[IDX.CANAL]  ?? "") === state.canal);
      if (!okCentro || !okCanal) return false;

      if (!ignoreSelectedItem && state.selectedItem) {
        const colIdx = IDX[state.dimension];
        const val = stripParens(r[colIdx] ?? "");
        if (val !== state.selectedItem) return false;
      }
      return true;
    });
  }

  /* ==========================================================================
     CONSTRUCCIÓN DE PÍLDORAS INTERACTIVAS (CERO DROPDOWNS)
     ========================================================================== */
  function renderTopPills() {
    // 1. Píldoras de Centros en la barra oscura superior
    const centros = ["Todos", ...unique(allRows.map(r => r[IDX.CENTRO] ?? "")).sort()];
    centroPillsBar.innerHTML = "";
    centros.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `fin-nav-pill ${state.centro === c ? "is-active" : ""}`;
      btn.textContent = c === "Todos" ? "● Global" : c;
      btn.addEventListener("click", () => {
        state.centro = (state.centro === c && c !== "Todos") ? "Todos" : c;
        if (state.dimension === "CENTRO") state.selectedItem = null;
        updateDashboard();
      });
      centroPillsBar.appendChild(btn);
    });

    // 2. Chips de Canales en la cinta media
    const canales = ["Todos", ...unique(allRows.map(r => r[IDX.CANAL] ?? "")).sort()];
    canalQuickPills.innerHTML = "";
    canales.forEach(can => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `fin-canal-chip ${state.canal === can ? "is-active" : ""}`;
      btn.textContent = can === "Todos" ? "Todos los Canales" : stripParens(can);
      btn.addEventListener("click", () => {
        state.canal = (state.canal === can && can !== "Todos") ? "Todos" : can;
        if (state.dimension === "CANAL") state.selectedItem = null;
        updateDashboard();
      });
      canalQuickPills.appendChild(btn);
    });

    // 3. Badges de filtros cruzados activos
    activeFilterBadges.innerHTML = "";
    if (state.selectedItem) {
      const chip = document.createElement("span");
      chip.className = "fin-filter-chip";
      chip.innerHTML = `${state.dimension}: ${state.selectedItem} <span class="material-icons">close</span>`;
      chip.addEventListener("click", () => {
        state.selectedItem = null;
        updateDashboard();
      });
      activeFilterBadges.appendChild(chip);
    }
  }

  /* ==========================================================================
     MINI-GRÁFICOS SVG DENTRO DE LAS 4 TARJETAS BLANCAS (Clicables)
     ========================================================================== */
  function renderCardMiniChart(containerId, metricName, color) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";

    // Agrupamos por Centro para que las barritas de la tarjeta representen los centros
    const baseRows = allRows.filter(r => state.canal === "Todos" || (r[IDX.CANAL] ?? "") === state.canal);
    const map = new Map();
    baseRows.forEach(r => {
      const k = r[IDX.CENTRO] ?? "";
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });

    const series = Array.from(map.entries())
      .map(([label, grp]) => ({ label, value: metricCalc(grp, metricName) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    if (!series.length) return;

    const w = container.clientWidth || 200;
    const h = 34;
    const maxV = Math.max(1, ...series.map(s => s.value));
    const gap = 6;
    const barW = Math.max(8, Math.min(20, (w - gap * (series.length - 1)) / series.length));

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    series.forEach((d, i) => {
      const bh = Math.max(4, (d.value / maxV) * (h - 4));
      const x = i * (barW + gap);
      const y = h - bh;

      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", barW);
      rect.setAttribute("height", bh);
      rect.setAttribute("rx", "3");

      const isCurrentCentro = (state.centro === "Todos" || state.centro === d.label);
      rect.setAttribute("fill", isCurrentCentro ? color : "#cbd5e1");
      rect.setAttribute("opacity", isCurrentCentro ? "0.9" : "0.4");

      // Al hacer clic en una barrita dentro de la tarjeta, filtra ese Centro directamente
      rect.style.cursor = "pointer";
      rect.addEventListener("click", (e) => {
        e.stopPropagation();
        state.centro = (state.centro === d.label) ? "Todos" : d.label;
        state.metric = metricName;
        updateDashboard();
      });

      const title = document.createElementNS(svgNS, "title");
      title.textContent = `${d.label}: ${formatMetric(d.value, metricName)}`;
      rect.appendChild(title);

      svg.appendChild(rect);
    });

    container.appendChild(svg);
  }

  /* ==========================================================================
     TARJETAS SUPERIORES Y CINTA DE PIs
     ========================================================================== */
  function renderTopCardsAndPIs() {
    const rows = getFilteredRows(false);
    const totalGlobalRows = allRows;

    const cli = countClientes(rows);
    const ped = countPedidos(rows);
    const kg  = sumKg(rows);
    const sol = sumSoles(rows);
    const cam = countTrucks(rows);

    const sharePed = countPedidos(totalGlobalRows) ? Math.round((ped / countPedidos(totalGlobalRows)) * 100) : 100;

    document.getElementById("valClientes").textContent   = cli.toLocaleString("es-PE");
    document.getElementById("valPedidos").textContent    = ped.toLocaleString("es-PE");
    document.getElementById("valKilogramos").textContent = kg.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valSoles").textContent      = formatMetric(sol, "Soles", true);

    document.getElementById("subClientes").textContent   = `${sharePed}% del volumen operativo`;
    document.getElementById("subPedidos").textContent    = state.metric === "Pedidos" ? "● Métrica activa en gráficos" : "Click para enfocar Pedidos";
    document.getElementById("subKilogramos").textContent = state.metric === "Kilogramos" ? "● Métrica activa en gráficos" : "Click para enfocar Kilogramos";
    document.getElementById("subSoles").textContent      = state.metric === "Soles" ? "● Métrica activa en gráficos" : "Click para enfocar Soles";

    // PIs en cinta media
    const kgCam  = cam ? (kg / cam) : 0;
    const kgCli  = cli ? (kg / cli) : 0;
    const cliCam = cam ? (cli / cam) : 0;

    document.getElementById("valCamiones").textContent  = cam.toLocaleString("es-PE");
    document.getElementById("valKgCamion").textContent  = kgCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valKgCliente").textContent = kgCli.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valCliCamion").textContent = cliCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });

    // Resaltar tarjeta o píldora activa
    document.querySelectorAll(".fin-card").forEach(card => {
      card.classList.toggle("is-active", card.getAttribute("data-metric") === state.metric);
    });
    document.querySelectorAll(".fin-pi-pill").forEach(pill => {
      pill.classList.toggle("is-active", pill.getAttribute("data-metric") === state.metric);
    });

    // Mini gráficos dentro de cada tarjeta
    renderCardMiniChart("miniChartClientes",   "Clientes",   "#475569");
    renderCardMiniChart("miniChartPedidos",    "Pedidos",    "#5b5ce2");
    renderCardMiniChart("miniChartKilogramos", "Kilogramos", "#16a34a");
    renderCardMiniChart("miniChartSoles",      "Soles",      "#d97706");
  }

  /* ==========================================================================
     PANEL OSCURO INFERIOR: LISTA MAESTRA + TARJETA MORADA DE INSPECCIÓN
     ========================================================================== */
  function renderDarkStage() {
    const baseRows = getFilteredRows(true); // Filas según Centro y Canal activos

    // Contadores de las pestañas del Notch Blanco
    document.getElementById("countDimCentro").textContent = unique(baseRows.map(r => r[IDX.CENTRO] ?? "")).length;
    document.getElementById("countDimCanal").textContent  = unique(baseRows.map(r => r[IDX.CANAL]  ?? "")).length;
    document.getElementById("countDimPlaca").textContent  = unique(baseRows.filter(r => !isTruckExcluded(r)).map(r => r[IDX.PLACA] ?? "")).length;
    document.getElementById("countDimRuta").textContent   = unique(baseRows.map(r => r[IDX.RUTA]   ?? "")).length;

    const dimNames = {
      CENTRO: "Ranking por Centros Operativos",
      CANAL:  "Participación por Canales",
      PLACA:  "Rendimiento de Flota (Placas)",
      RUTA:   "Desempeño por Rutas"
    };
    document.getElementById("stageLeftTitle").textContent  = dimNames[state.dimension];
    document.getElementById("stageMetricBadge").textContent = state.metric;

    // Agrupar filas por la dimensión activa
    const colIdx = IDX[state.dimension];
    const sourceRows = state.dimension === "PLACA" ? baseRows.filter(r => !isTruckExcluded(r)) : baseRows.filter(r => !isFRT(r));

    const groups = new Map();
    sourceRows.forEach(r => {
      const rawKey = r[colIdx] ?? "";
      const key = stripParens(rawKey).trim();
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    let series = Array.from(groups.entries()).map(([label, grpRows]) => ({
      label,
      rows: grpRows,
      value: metricCalc(grpRows, state.metric),
      pedidos: countPedidos(grpRows),
      clientes: countClientes(grpRows),
      camiones: countTrucks(grpRows)
    })).filter(d => d.value > 0);

    series.sort((a, b) => state.bestOrder ? (b.value - a.value) : (a.value - b.value));
    const displaySeries = series.slice(0, 12);

    const totalMetricBase = Math.max(1, metricCalc(sourceRows, state.metric));

    // Renderizar Lista Maestra Izquierda
    const listContainer = document.getElementById("masterRankingList");
    listContainer.innerHTML = "";

    displaySeries.forEach((item, idx) => {
      const share = Math.round((item.value / totalMetricBase) * 100);
      const rowEl = document.createElement("div");
      rowEl.className = `fin-list-item ${state.selectedItem === item.label ? "is-selected" : ""}`;
      rowEl.innerHTML = `
        <div class="fin-list-rank">#${idx + 1}</div>
        <div class="fin-list-info">
          <div class="fin-list-title">${item.label}</div>
          <div class="fin-list-sub">${item.clientes} clientes • ${item.camiones} camiones</div>
        </div>
        <span class="fin-list-badge">${share}%</span>
        <div class="fin-list-val">${formatMetric(item.value, state.metric, true)}</div>
      `;

      // Click en la fila izquierda -> Filtra la Tarjeta Derecha y las Tarjetas Superiores
      rowEl.addEventListener("click", () => {
        state.selectedItem = (state.selectedItem === item.label) ? null : item.label;
        updateDashboard();
      });

      listContainer.appendChild(rowEl);
    });

    // Renderizar Tarjeta Morada Derecha (Spotlight Detail)
    renderSpotlightCard(baseRows, series);
  }

  function renderSpotlightCard(baseRows, currentDimensionSeries) {
    const activeRows = getFilteredRows(false); // Incluye state.selectedItem si hay uno marcado
    const baseTotalPed = Math.max(1, countPedidos(baseRows));
    const baseTotalKg  = Math.max(1, sumKg(baseRows));
    const baseTotalSol = Math.max(1, sumSoles(baseRows));

    const ped = countPedidos(activeRows);
    const kg  = sumKg(activeRows);
    const sol = sumSoles(activeRows);
    const cli = countClientes(activeRows);
    const cam = countTrucks(activeRows);

    const pctPed = Math.min(100, Math.round((ped / baseTotalPed) * 100));
    const pctKg  = Math.min(100, Math.round((kg  / baseTotalKg)  * 100));
    const pctSol = Math.min(100, Math.round((sol / baseTotalSol) * 100));

    // Títulos dinámicos del Spotlight
    const titleEl = document.getElementById("spotTitle");
    const badgeEl = document.getElementById("spotShareBadge");
    const subCtx  = document.getElementById("spotSubContext");

    if (state.selectedItem) {
      titleEl.textContent = state.selectedItem;
      badgeEl.textContent = `${pctPed}% de Pedidos`;
    } else if (state.centro !== "Todos") {
      titleEl.textContent = `Centro ${state.centro}`;
      badgeEl.textContent = "Vista de Centro";
    } else {
      titleEl.textContent = "Consolidado General";
      badgeEl.textContent = "100% Operación";
    }

    subCtx.textContent = `${state.centro === "Todos" ? "Todos los Centros" : state.centro} • ${state.canal === "Todos" ? "Todos los Canales" : stripParens(state.canal)}`;

    // Líder destacado
    const topItem = currentDimensionSeries[0];
    document.getElementById("spotLeaderTitle").textContent = topItem ? `Líder (${state.dimension})` : "Sin datos";
    document.getElementById("spotLeaderValue").textContent = topItem ? `${topItem.label} (${formatMetric(topItem.value, state.metric, true)})` : "–";

    // 3 Cajas de Métricas del Spotlight
    document.getElementById("spotBoxPedidos").textContent = ped.toLocaleString("es-PE");
    document.getElementById("spotBoxKg").textContent      = formatMetric(kg, "Kilogramos", true);
    document.getElementById("spotBoxSoles").textContent   = formatMetric(sol, "Soles", true);

    document.getElementById("barSpotPedidos").style.width = `${pctPed}%`;
    document.getElementById("barSpotKg").style.width      = `${pctKg}%`;
    document.getElementById("barSpotSoles").style.width   = `${pctSol}%`;

    // 4ta Caja: Mini Desglose Cruzado (Si estás viendo Centros, te muestra sus Top Placas clicables; si estás en Placas, sus Rutas)
    const crossDim = state.dimension === "PLACA" ? "RUTA" : "PLACA";
    document.getElementById("spotBreakdownTitle").textContent = `Top ${crossDim === "PLACA" ? "Placas" : "Rutas"} aquí (Click)`;
    const breakdownList = document.getElementById("spotBreakdownList");
    breakdownList.innerHTML = "";

    const crossGroups = new Map();
    activeRows.filter(r => !isTruckExcluded(r)).forEach(r => {
      const k = stripParens(r[IDX[crossDim]] ?? "").trim();
      if (!k) return;
      if (!crossGroups.has(k)) crossGroups.set(k, []);
      crossGroups.get(k).push(r);
    });

    const topCross = Array.from(crossGroups.entries())
      .map(([label, grp]) => ({ label, val: metricCalc(grp, state.metric) }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 3);

    topCross.forEach(c => {
      const div = document.createElement("div");
      div.className = "fin-mini-row";
      div.innerHTML = `<span>${c.label}</span><strong>${formatMetric(c.val, state.metric, true)}</strong>`;
      div.addEventListener("click", () => {
        state.dimension = crossDim;
        state.selectedItem = c.label;
        syncNotchTabs();
        updateDashboard();
      });
      breakdownList.appendChild(div);
    });

    // Pie del Spotlight (PIs de la selección)
    document.getElementById("spotFootCamiones").textContent = `${cam} camiones`;
    document.getElementById("spotFootKgCam").textContent    = cam ? (kg / cam).toLocaleString("es-PE", { maximumFractionDigits: 1 }) : "0";
    document.getElementById("spotFootKgCli").textContent    = cli ? (kg / cli).toLocaleString("es-PE", { maximumFractionDigits: 1 }) : "0";
    document.getElementById("spotFootCliCam").textContent   = cam ? (cli / cam).toLocaleString("es-PE", { maximumFractionDigits: 1 }) : "0";
  }

  function syncNotchTabs() {
    document.querySelectorAll(".fin-notch-btn").forEach(btn => {
      btn.classList.toggle("is-active", btn.getAttribute("data-dimension") === state.dimension);
    });
  }

  function updateSubtitle() {
    const parts = [];
    parts.push(state.centro === "Todos" ? "Todos los Centros" : `Centro: ${state.centro}`);
    if (state.canal !== "Todos") parts.push(`Canal: ${stripParens(state.canal)}`);
    if (state.selectedItem) parts.push(`${state.dimension}: ${state.selectedItem}`);
    parts.push(`Enfoque: ${state.metric}`);
    activeContextSubtitle.textContent = parts.join(" • ");
  }

  function updateDashboard() {
    updateSubtitle();
    renderTopPills();
    renderTopCardsAndPIs();
    renderDarkStage();
  }

  /* ==========================================================================
     EVENTOS DE INTERACCIÓN DIRECTA
     ========================================================================== */
  function bindEvents() {
    // Click en las 4 Macro-Tarjetas blancas superiores
    document.querySelectorAll(".fin-card").forEach(card => {
      card.addEventListener("click", () => {
        state.metric = card.getAttribute("data-metric");
        updateDashboard();
      });
    });

    // Click en las píldoras de PIs y Flota
    document.querySelectorAll(".fin-pi-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        state.metric = pill.getAttribute("data-metric");
        updateDashboard();
      });
    });

    // Click en las pestañas del Notch blanco (Centros / Canales / Flota / Rutas)
    document.querySelectorAll(".fin-notch-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        state.dimension = btn.getAttribute("data-dimension");
        state.selectedItem = null;
        syncNotchTabs();
        updateDashboard();
      });
    });

    // Click en las 3 cajas interiores del Spotlight morado
    document.querySelectorAll(".fin-spot-box[data-spot-metric]").forEach(box => {
      box.addEventListener("click", () => {
        state.metric = box.getAttribute("data-spot-metric");
        updateDashboard();
      });
    });

    // Alternar Top Performers vs Offenders
    document.getElementById("btnToggleOrder").addEventListener("click", () => {
      state.bestOrder = !state.bestOrder;
      document.getElementById("orderIcon").textContent  = state.bestOrder ? "trending_up" : "trending_down";
      document.getElementById("orderLabel").textContent = state.bestOrder ? "Top Performers" : "Top Offenders";
      updateDashboard();
    });

    // Botones de Reset Global
    const resetAll = () => {
      state.centro = "Todos";
      state.canal = "Todos";
      state.metric = "Pedidos";
      state.selectedItem = null;
      state.bestOrder = true;
      updateDashboard();
    };
    document.getElementById("btnResetAll").addEventListener("click", resetAll);
    document.getElementById("btnClearSelection").addEventListener("click", resetAll);

    window.addEventListener("resize", () => renderTopCardsAndPIs());
  }

  async function init() {
    try {
      const text = await loadCSVWithFallback();
      const { rows } = parseCSV(text);
      allRows = rows;
      bindEvents();
      updateDashboard();
    } catch (err) {
      console.error("Error cargando RoadMap.csv:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
