/* ==========================================================================
   RoadMap - dashboard.js (Mapa Geoespacial Lima + Heatmap por CD)
   ========================================================================== */

(() => {
  const FALLBACKS = [
    window.RoadMapConfig?.CSV_URL,
    './RoadMap.csv',
    './assets/data/RoadMap.csv',
    'https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv'
  ].filter(Boolean);

  // Coordenadas exactas de los 3 Centros de Distribución (Región Lima)
  const CD_LOCATIONS = {
    "0374-ATE":     { lat: -12.067013469355048, lng: -76.97943349160968, label: "0374-ATE" },
    "0780-ATE2":    { lat: -12.045124965310059, lng: -76.93813036277461, label: "0780-ATE2" },
    "0754-CHANCAY": { lat: -11.551110366002629, lng: -77.27641679959045, label: "0754-CHANCAY" }
  };

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

  // Índices CSV (incluyendo Latitud[16] y Longitud[17] para el mapa de calor)
  const IDX = {
    CENTRO: 1, PLACA: 2, CLIENTE: 3, RUTA: 6, PEDIDO: 7,
    KG: 10, SOLES: 11, LAT: 16, LNG: 17, CANAL: 19
  };

  const EXCLUDE_FRT = "FRT-001";
  const TRUCKS_EXCLUDED = new Set(["FRT-001", "RES-CLI"]);

  const cleanStr = v => String(v ?? "").trim();
  const upperStr = v => cleanStr(v).toUpperCase();
  const isFRT = r => upperStr(r[IDX.PLACA]) === EXCLUDE_FRT;
  const isTruckExcluded = r => {
    const p = upperStr(r[IDX.PLACA]);
    return !p || TRUCKS_EXCLUDED.has(p);
  };
  const unique = arr => Array.from(new Set(arr.filter(v => v !== "" && v != null)));
  const toNum = v => { const n = parseFloat(String(v ?? "0").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const stripParens = s => String(s ?? "").replace(/\s*\([^\)]*\)/g, "").trim();

  // Estado Global Interactivo
  let allRows = [];
  let state = {
    selectedCenter: null, // null = Región Lima (3 CDs) | string = Centro específico (Heatmap)
    selectedCanal: null,  // Filtro opcional al tocar un canal en la lista inferior
    activeMetric: "Pedidos"
  };

  // Capas Leaflet
  let map = null;
  let cdMarkersLayer = null;
  let heatLayer = null;

  // Agregadores Certificados (Llave compuesta CENTRO|PLACA para unidades)
  const countClientes = rows => unique(rows.filter(r => !isFRT(r)).map(r => cleanStr(r[IDX.CLIENTE]))).length;
  const countPedidos  = rows => unique(rows.filter(r => !isFRT(r)).map(r => cleanStr(r[IDX.PEDIDO]))).length;
  const sumKg         = rows => rows.filter(r => !isFRT(r)).reduce((a, r) => a + toNum(r[IDX.KG]), 0);
  const sumSoles      = rows => rows.filter(r => !isFRT(r)).reduce((a, r) => a + toNum(r[IDX.SOLES]), 0);
  const countTrucks   = rows => unique(
    rows.filter(r => !isTruckExcluded(r)).map(r => `${cleanStr(r[IDX.CENTRO])}|${upperStr(r[IDX.PLACA])}`)
  ).length;

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
    if (metricName === "Camiones") {
      return `${val.toLocaleString("es-PE", { maximumFractionDigits: 0 })} u.`;
    }
    if (metricName.includes("/")) {
      return val.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    }
    return val.toLocaleString("es-PE", { maximumFractionDigits: 0 });
  }

  function getActiveRows() {
    return allRows.filter(r => {
      if (state.selectedCenter && cleanStr(r[IDX.CENTRO]) !== state.selectedCenter) return false;
      if (state.selectedCanal  && cleanStr(r[IDX.CANAL])  !== state.selectedCanal)  return false;
      return true;
    });
  }

  /* ==========================================================================
     INICIALIZACIÓN DEL MAPA LEAFLET (REGIÓN LIMA)
     ========================================================================== */
  function initMap() {
    map = L.map("geoDashboardMap", {
      zoomControl: false,
      attributionControl: false
    }).setView([-11.85, -77.08], 9);

    // Estilo de mapa claro y limpio (CartoDB Positron) para que resalten el púrpura y el heatmap
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    cdMarkersLayer = L.layerGroup().addTo(map);
  }

  /* ==========================================================================
     RENDERIZADO DEL MAPA: MODO 3 CDs vs MODO MAPA DE CALOR (HEATMAP)
     ========================================================================== */
  function renderMapState() {
    if (!map) return;

    // Limpiar capas previas
    cdMarkersLayer.clearLayers();
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }

    const hudTitle    = document.getElementById("hudMapTitle");
    const hudSubtitle = document.getElementById("hudMapSubtitle");
    const btnBack     = document.getElementById("btnBackToRegion");
    const legendHeat  = document.getElementById("legendHeat");

    document.getElementById("hudActiveMetricBadge").textContent = `Métrica: ${state.activeMetric}`;

    // MODO 1: VISTA GLOBAL REGIÓN LIMA (Muestra los 3 CDs con el indicador seleccionado)
    if (!state.selectedCenter) {
      hudTitle.textContent    = "Región Lima • 3 Centros de Distribución";
      hudSubtitle.textContent = "Selecciona una tarjeta KPI a la derecha o haz clic en un CD del mapa";
      btnBack.classList.add("is-hidden");
      legendHeat.classList.add("is-hidden");

      const bounds = [];

      Object.entries(CD_LOCATIONS).forEach(([cdCode, coords]) => {
        const cdRows = allRows.filter(r => cleanStr(r[IDX.CENTRO]) === cdCode);
        const val = metricCalc(cdRows, state.activeMetric);
        const formattedVal = formatMetric(val, state.activeMetric, true);

        const iconHtml = `
          <div class="cd-map-marker">
            <div class="cd-marker-pill">
              <span class="cd-marker-name">${coords.label}</span>
              <span class="cd-marker-val">${formattedVal}</span>
            </div>
            <div class="cd-marker-pulse"></div>
          </div>
        `;

        const divIcon = L.divIcon({
          className: "",
          html: iconHtml,
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        });

        const marker = L.marker([coords.lat, coords.lng], { icon: divIcon });
        marker.on("click", () => {
          state.selectedCenter = cdCode;
          state.selectedCanal = null;
          updateDashboard();
        });
        marker.addTo(cdMarkersLayer);
        bounds.push([coords.lat, coords.lng]);
      });

      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [75, 75], maxZoom: 10 });
      }
      return;
    }

    // MODO 2: CENTRO SELECCIONADO -> MAPA DE CALOR DE LAS ATENCIONES DEL DÍA
    const cdInfo = CD_LOCATIONS[state.selectedCenter];
    hudTitle.textContent    = `Mapa de Calor • ${state.selectedCenter}`;
    hudSubtitle.textContent = `Densidad de atenciones del día (${state.activeMetric})`;
    btnBack.classList.remove("is-hidden");
    legendHeat.classList.remove("is-hidden");

    // Pin de referencia del CD seleccionado
    if (cdInfo) {
      const cdPin = L.divIcon({
        className: "",
        html: `
          <div class="cd-map-marker">
            <div class="cd-marker-pill" style="background:#8e24aa; border-color:#ffffff;">
              <span class="cd-marker-name" style="color:#fff;">CD ORIGEN</span>
              <span class="cd-marker-val">${state.selectedCenter}</span>
            </div>
            <div class="cd-marker-pulse"></div>
          </div>
        `,
        iconSize: [0, 0]
      });
      L.marker([cdInfo.lat, cdInfo.lng], { icon: cdPin }).addTo(cdMarkersLayer);
    }

    // Construir puntos de calor a partir de los clientes atendidos en ese centro
    const activeRows = getActiveRows().filter(r => !isFRT(r));
    const clientPoints = new Map();

    activeRows.forEach(r => {
      const cli = cleanStr(r[IDX.CLIENTE]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      if (!cli || isNaN(lat) || isNaN(lng)) return;

      if (!clientPoints.has(cli)) {
        clientPoints.set(cli, { lat, lng, rows: [] });
      }
      clientPoints.get(cli).rows.push(r);
    });

    const heatData = [];
    const bounds = cdInfo ? [[cdInfo.lat, cdInfo.lng]] : [];
    let maxIntensity = 1;

    const rawPoints = Array.from(clientPoints.values()).map(pt => {
      const weight = Math.max(0.2, metricCalc(pt.rows, state.activeMetric));
      if (weight > maxIntensity) maxIntensity = weight;
      bounds.push([pt.lat, pt.lng]);
      return { lat: pt.lat, lng: pt.lng, weight };
    });

    rawPoints.forEach(pt => {
      // Normalizamos intensidad entre 0.35 y 1.0 para que el mapa de calor sea bien visible
      const intensity = Math.max(0.35, Math.min(1, pt.weight / maxIntensity));
      heatData.push([pt.lat, pt.lng, intensity]);
    });

    if (typeof L.heatLayer === "function" && heatData.length > 0) {
      heatLayer = L.heatLayer(heatData, {
        radius: 26,
        blur: 18,
        maxZoom: 14,
        gradient: {
          0.25: "#10b981", // Esmeralda
          0.55: "#f59e0b", // Ámbar
          0.85: "#8e24aa", // Púrpura
          1.00: "#ef4444"  // Rojo intenso
        }
      }).addTo(map);
    }

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [55, 55], maxZoom: 13 });
    } else if (cdInfo) {
      map.setView([cdInfo.lat, cdInfo.lng], 12);
    }
  }

  /* ==========================================================================
     RENDERIZADO DEL PANEL DERECHO (KPIs, PIs Y LISTA DESGLOSE)
     ========================================================================== */
  function renderSidePanel() {
    const activeRows = getActiveRows();
    const totalGlobalPed = Math.max(1, countPedidos(allRows));

    const cli = countClientes(activeRows);
    const ped = countPedidos(activeRows);
    const kg  = sumKg(activeRows);
    const sol = sumSoles(activeRows);
    const cam = countTrucks(activeRows);

    const sharePct = Math.round((ped / totalGlobalPed) * 100);

    // Encabezado dinámico
    const eyebrowEl = document.getElementById("panelEyebrow");
    const titleEl   = document.getElementById("panelTitle");
    const shareEl   = document.getElementById("panelShareBadge");

    if (!state.selectedCenter) {
      eyebrowEl.textContent = "CONSOLIDADO REGIONAL";
      titleEl.textContent   = "Región Lima (Total)";
      shareEl.textContent   = "3 Centros • 100%";
    } else {
      eyebrowEl.textContent = "DESGLOSE CENTRO DE DISTRIBUCIÓN";
      titleEl.textContent   = state.selectedCenter;
      shareEl.textContent   = `${sharePct}% de Pedidos Lima`;
    }

    // Valores de las 5 tarjetas KPI
    document.getElementById("valClientes").textContent   = cli.toLocaleString("es-PE");
    document.getElementById("valPedidos").textContent    = ped.toLocaleString("es-PE");
    document.getElementById("valKilogramos").textContent = formatMetric(kg, "Kilogramos", true);
    document.getElementById("valSoles").textContent      = formatMetric(sol, "Soles", true);
    document.getElementById("valCamiones").textContent   = `${cam} unidades`;

    // Subtítulos dinámicos indicando cuál tarjeta controla el mapa
    ["Clientes", "Pedidos", "Kilogramos", "Soles", "Camiones"].forEach(m => {
      const subEl = document.getElementById(`sub${m}`);
      if (!subEl) return;
      if (state.activeMetric === m) {
        subEl.textContent = "● Mostrando en mapa";
      } else {
        subEl.textContent = "Click para ver en mapa";
      }
    });

    // Valores de los 3 PIs
    const kgCam  = cam ? (kg / cam) : 0;
    const kgCli  = cli ? (kg / cli) : 0;
    const cliCam = cam ? (cli / cam) : 0;

    document.getElementById("valKgCamion").textContent  = kgCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valKgCliente").textContent = kgCli.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valCliCamion").textContent = cliCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });

    // Resaltar tarjeta KPI o PI activa
    document.querySelectorAll(".geo-kpi-card").forEach(card => {
      card.classList.toggle("is-active", card.getAttribute("data-metric") === state.activeMetric);
    });
    document.querySelectorAll(".geo-pi-card").forEach(card => {
      card.classList.toggle("is-active", card.getAttribute("data-metric") === state.activeMetric);
    });

    // Lista Inferior de Desglose (Si estamos en Global -> muestra los 3 CDs; si estamos en un CD -> muestra sus Canales)
    renderBreakdownList();
  }

  function renderBreakdownList() {
    const listEl  = document.getElementById("geoBreakdownList");
    const titleEl = document.getElementById("breakdownTitle");
    const tagEl   = document.getElementById("breakdownMetricTag");
    listEl.innerHTML = "";
    tagEl.textContent = state.activeMetric;

    if (!state.selectedCenter) {
      // Comparativa de los 3 Centros de Lima
      titleEl.textContent = "Comparativa por Centro (Click para abrir Heatmap)";
      const mapCenters = new Map();
      allRows.forEach(r => {
        const c = cleanStr(r[IDX.CENTRO]);
        if (!c) return;
        if (!mapCenters.has(c)) mapCenters.set(c, []);
        mapCenters.get(c).push(r);
      });

      const items = Array.from(mapCenters.entries()).map(([label, rows]) => ({
        key: label,
        label,
        val: metricCalc(rows, state.activeMetric),
        extra: `${countTrucks(rows)} u.`
      })).sort((a, b) => b.val - a.val);

      const totalSum = items.reduce((acc, it) => acc + it.val, 0) || 1;
      const maxVal   = Math.max(1, ...items.map(it => it.val));

      items.forEach(it => {
        const pct = Math.round((it.val / totalSum) * 100);
        const barW = Math.round((it.val / maxVal) * 100);
        const row = document.createElement("div");
        row.className = "geo-break-row";
        row.innerHTML = `
          <div class="geo-break-top">
            <strong>${it.label} <small style="color:#a1a1aa; font-weight:500;">(${it.extra})</small></strong>
            <div class="geo-break-nums">
              <span class="geo-break-pct">${pct}%</span>
              <span class="geo-break-val">${formatMetric(it.val, state.activeMetric, true)}</span>
            </div>
          </div>
          <div class="geo-break-bar"><span style="width:${barW}%"></span></div>
        `;
        row.addEventListener("click", () => {
          state.selectedCenter = it.key;
          state.selectedCanal = null;
          updateDashboard();
        });
        listEl.appendChild(row);
      });

    } else {
      // Desglose por Canales dentro del Centro seleccionado (Clicable para filtrar el Heatmap)
      titleEl.textContent = `Canales en ${state.selectedCenter} (Click para filtrar calor)`;
      const centerRows = allRows.filter(r => cleanStr(r[IDX.CENTRO]) === state.selectedCenter);
      const mapCanales = new Map();
      centerRows.forEach(r => {
        const can = cleanStr(r[IDX.CANAL]);
        if (!can) return;
        if (!mapCanales.has(can)) mapCanales.set(can, []);
        mapCanales.get(can).push(r);
      });

      const items = Array.from(mapCanales.entries()).map(([rawCan, rows]) => ({
        key: rawCan,
        label: stripParens(rawCan),
        val: metricCalc(rows, state.activeMetric),
        extra: `${countPedidos(rows)} ped.`
      })).sort((a, b) => b.val - a.val);

      const totalSum = items.reduce((acc, it) => acc + it.val, 0) || 1;
      const maxVal   = Math.max(1, ...items.map(it => it.val));

      items.forEach(it => {
        const pct = Math.round((it.val / totalSum) * 100);
        const barW = Math.round((it.val / maxVal) * 100);
        const row = document.createElement("div");
        row.className = `geo-break-row ${state.selectedCanal === it.key ? "is-selected" : ""}`;
        row.innerHTML = `
          <div class="geo-break-top">
            <strong>${it.label} <small style="color:#e1bee7; font-weight:500;">(${it.extra})</small></strong>
            <div class="geo-break-nums">
              <span class="geo-break-pct">${pct}%</span>
              <span class="geo-break-val">${formatMetric(it.val, state.activeMetric, true)}</span>
            </div>
          </div>
          <div class="geo-break-bar"><span style="width:${barW}%"></span></div>
        `;
        row.addEventListener("click", () => {
          state.selectedCanal = (state.selectedCanal === it.key) ? null : it.key;
          updateDashboard();
        });
        listEl.appendChild(row);
      });
    }
  }

  function updateDashboard() {
    renderMapState();
    renderSidePanel();
  }

  function bindEvents() {
    // Click en tarjetas KPI del panel derecho -> Cambia la métrica que se refleja en el mapa
    document.querySelectorAll(".geo-kpi-card").forEach(card => {
      card.addEventListener("click", () => {
        state.activeMetric = card.getAttribute("data-metric");
        updateDashboard();
      });
    });

    // Click en tarjetas PI del panel derecho -> Cambia la métrica que se refleja en el mapa
    document.querySelectorAll(".geo-pi-card").forEach(card => {
      card.addEventListener("click", () => {
        state.activeMetric = card.getAttribute("data-metric");
        updateDashboard();
      });
    });

    // Botón para volver del Mapa de Calor de un CD a la vista Región Lima
    document.getElementById("btnBackToRegion").addEventListener("click", () => {
      state.selectedCenter = null;
      state.selectedCanal = null;
      updateDashboard();
    });

    window.addEventListener("resize", () => {
      if (map) map.invalidateSize();
    });
  }

  async function init() {
    initMap();
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
