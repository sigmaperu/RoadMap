/* ==========================================================================
   RoadMap - dashboard.js (Zoom Fijo 10 + Fecha CSV + Captura con Link)
   ========================================================================== */

(() => {
  const FALLBACKS = [
    window.RoadMapConfig?.CSV_URL,
    './RoadMap.csv',
    './assets/data/RoadMap.csv',
    'https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv'
  ].filter(Boolean);

  const DASHBOARD_PUBLIC_URL = "https://sigmaperu.github.io/RoadMap/dashboard.html";

  // Coordenadas exactas de los 3 Centros de Distribución (Región Lima)
  const CD_LOCATIONS = {
    "0374-ATE": {
      lat: -12.067013469355048,
      lng: -76.97943349160968,
      calloutLat: -12.095,
      calloutLng: -77.015,
      offsetClass: "cd-offset-ate",
      label: "0374-ATE"
    },
    "0780-ATE2": {
      lat: -12.045124965310059,
      lng: -76.93813036277461,
      calloutLat: -12.035,
      calloutLng: -76.855,
      offsetClass: "cd-offset-ate2",
      label: "0780-ATE2"
    },
    "0754-CHANCAY": {
      lat: -11.551110366002629,
      lng: -77.27641679959045,
      calloutLat: -11.500,
      calloutLng: -77.195,
      offsetClass: "cd-offset-chancay",
      label: "0754-CHANCAY"
    }
  };

  // Paleta Oficial de Colores por Canal (Rojo DET, Azul FSE, Naranja MES, Amarillo MOD)
  const CHANNEL_CONFIG = [
    { key: "DET", label: "DET", color: "#ef4444" }, // Rojo
    { key: "FSE", label: "FSE", color: "#2563eb" }, // Azul
    { key: "MES", label: "MES", color: "#f97316" }, // Naranja
    { key: "MOD", label: "MOD", color: "#eab308" }  // Amarillo
  ];

  // Resumen completo de los otros 7 indicadores cuando se selecciona Flota Asignada (Camiones)
  const FLEET_SUMMARY_METRICS = [
    { metric: "Clientes",        label: "Clientes",  color: "#a1a1aa" },
    { metric: "Pedidos",         label: "Pedidos",   color: "#ab47bc" },
    { metric: "Kilogramos",      label: "Peso",      color: "#10b981" },
    { metric: "Soles",           label: "Soles",     color: "#f59e0b" },
    { metric: "Kg/Camión",       label: "Kg / Cam",  color: "#34d399" },
    { metric: "Kg/Cliente",      label: "Kg / Cli",  color: "#6ee7b7" },
    { metric: "Clientes/Camión", label: "Cli / Cam", color: "#e1bee7" }
  ];

  function normalizeChannelCode(raw) {
    const clean = String(raw ?? "").replace(/\s*\([^\)]*\)/g, "").trim().toUpperCase();
    if (clean === "FSE" || clean.includes("FOSE")) return "FSE";
    if (clean.includes("DET")) return "DET";
    if (clean.includes("MES")) return "MES";
    if (clean.includes("MOD")) return "MOD";
    return clean;
  }

  function getChannelColor(raw) {
    const code = normalizeChannelCode(raw);
    const found = CHANNEL_CONFIG.find(c => c.key === code);
    return found ? found.color : "#71717a";
  }

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

  const IDX = {
    FECHA: 0, CENTRO: 1, PLACA: 2, CLIENTE: 3, NOMBRE: 4, RUTA: 6, PEDIDO: 7,
    KG: 10, SOLES: 11, DIRECCION: 15, LAT: 16, LNG: 17, CANAL: 19
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

  let allRows = [];
  let csvPlanningDate = "";
  let state = {
    selectedCenter: null,
    selectedChannelCode: null,
    activeMetric: "Camiones"
  };

  let map = null;
  let mapLayerGroup = null;

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
      default:                return countTrucks(rows);
    }
  }

  function formatMetric(val, metricName, compact = false) {
    if (metricName === "Soles") {
      if (compact && val >= 1000) return `S/ ${(val / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
      return `S/ ${val.toLocaleString("es-PE", { maximumFractionDigits: 1 })}`;
    }
    if (metricName === "Kilogramos") {
      if (compact && val >= 1000) return `${(val / 1000).toLocaleString("es-PE", { maximumFractionDigits: 1 })} T`;
      return `${val.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg`;
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
      if (state.selectedChannelCode && normalizeChannelCode(r[IDX.CANAL]) !== state.selectedChannelCode) return false;
      return true;
    });
  }

  // Vista y Zoom exacto calibrado como en tu captura de referencia
  const REGIONAL_CENTER = [-11.815, -76.96];
  const REGIONAL_ZOOM   = 10;

  function initMap() {
    map = L.map("geoDashboardMap", {
      zoomControl: false,
      attributionControl: false
    }).setView(REGIONAL_CENTER, REGIONAL_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      crossOrigin: true
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    mapLayerGroup = L.layerGroup().addTo(map);
  }

  function renderMapState() {
    if (!map) return;
    mapLayerGroup.clearLayers();

    const hudTitle    = document.getElementById("hudMapTitle");
    const hudSubtitle = document.getElementById("hudMapSubtitle");
    const btnBack     = document.getElementById("btnBackToRegion");

    const hudMetricLabel = state.activeMetric === "Camiones" ? "Flota Asignada" : state.activeMetric;
    document.getElementById("hudActiveMetricBadge").textContent = `Métrica: ${hudMetricLabel}`;

    // MODO 1: VISTA GLOBAL REGIÓN LIMA (3 CDs con Zoom Fijo 10)
    if (!state.selectedCenter) {
      hudTitle.textContent    = "Región Lima • 3 Centros de Distribución";
      hudSubtitle.textContent = state.activeMetric === "Camiones"
        ? "Resumen integral de indicadores por Centro • Toca un CD para ver sus geoposiciones"
        : `Desglose por canal (${state.activeMetric}) • Toca un CD para ver sus geoposiciones`;
      btnBack.classList.add("is-hidden");

      const isFleetSelected = (state.activeMetric === "Camiones");

      Object.entries(CD_LOCATIONS).forEach(([cdCode, info]) => {
        const cdRows = allRows.filter(r => cleanStr(r[IDX.CENTRO]) === cdCode);
        const mainVal = metricCalc(cdRows, state.activeMetric);
        const formattedMain = formatMetric(mainVal, state.activeMetric, true);

        const anchorIcon = L.divIcon({
          className: "",
          html: `<div class="cd-anchor-dot"></div>`,
          iconSize: [0, 0]
        });
        const anchorMarker = L.marker([info.lat, info.lng], { icon: anchorIcon });
        anchorMarker.on("click", () => openCenterGeopositions(cdCode));
        anchorMarker.addTo(mapLayerGroup);

        if (info.lat !== info.calloutLat || info.lng !== info.calloutLng) {
          L.polyline(
            [[info.lat, info.lng], [info.calloutLat, info.calloutLng]],
            { color: "#8e24aa", weight: 2, dashArray: "4, 4", opacity: 0.85 }
          ).addTo(mapLayerGroup);
        }

        let cardBodyHtml = "";
        if (isFleetSelected) {
          const summaryItems = FLEET_SUMMARY_METRICS.map(sm => {
            const smVal = metricCalc(cdRows, sm.metric);
            return `
              <div class="cd-ch-item">
                <span class="cd-ch-left"><i class="cd-ch-dot" style="background:${sm.color};"></i>${sm.label}</span>
                <strong>${formatMetric(smVal, sm.metric, true)}</strong>
              </div>
            `;
          }).join("");
          cardBodyHtml = `<div class="cd-mini-channels">${summaryItems}</div>`;
        } else {
          const chItems = CHANNEL_CONFIG.map(ch => {
            const chRows = cdRows.filter(r => normalizeChannelCode(r[IDX.CANAL]) === ch.key);
            const chVal = metricCalc(chRows, state.activeMetric);
            return `
              <div class="cd-ch-item">
                <span class="cd-ch-left"><i class="cd-ch-dot" style="background:${ch.color};"></i>${ch.label}</span>
                <strong>${formatMetric(chVal, state.activeMetric, true)}</strong>
              </div>
            `;
          }).join("");
          cardBodyHtml = `<div class="cd-mini-channels">${chItems}</div>`;
        }

        const calloutIcon = L.divIcon({
          className: "",
          html: `
            <div class="cd-callout-card ${info.offsetClass}">
              <div class="cd-callout-head">
                <span class="cd-callout-name">${info.label}</span>
                <span class="cd-callout-mainval">${formattedMain}</span>
              </div>
              ${cardBodyHtml}
            </div>
          `,
          iconSize: [0, 0]
        });

        const cardMarker = L.marker([info.calloutLat, info.calloutLng], { icon: calloutIcon });
        cardMarker.on("click", () => openCenterGeopositions(cdCode));
        cardMarker.addTo(mapLayerGroup);
      });

      // Mantener siempre el nivel de zoom exacto (10)
      map.setView(REGIONAL_CENTER, REGIONAL_ZOOM, { animate: true });
      return;
    }

    // MODO 2: GEOPOSICIONES DE ATENCIONES DEL DÍA POR CANAL
    const cdInfo = CD_LOCATIONS[state.selectedCenter];
    hudTitle.textContent    = `Geoposiciones • ${state.selectedCenter}`;
    hudSubtitle.textContent = state.selectedChannelCode
      ? `Filtrado por Canal ${state.selectedChannelCode} • Click en pin para detalle`
      : "Puntos de atención coloreados por Canal (DET, FSE, MES, MOD)";
    btnBack.classList.remove("is-hidden");

    const bounds = [];

    if (cdInfo) {
      const originIcon = L.divIcon({
        className: "",
        html: `
          <div class="cd-callout-card" style="transform:translate(-50%, -120%); min-width:110px; padding:5px 10px; background:#8e24aa; border-color:#fff;">
            <div class="cd-callout-head" style="border:none; margin:0; padding:0; justify-content:center;">
              <span class="cd-callout-name" style="color:#fff;">CD ${state.selectedCenter}</span>
            </div>
          </div>
          <div class="cd-anchor-dot"></div>
        `,
        iconSize: [0, 0]
      });
      L.marker([cdInfo.lat, cdInfo.lng], { icon: originIcon }).addTo(mapLayerGroup);
      bounds.push([cdInfo.lat, cdInfo.lng]);
    }

    const activeRows = getActiveRows().filter(r => !isFRT(r));
    const clientPoints = new Map();

    activeRows.forEach(r => {
      const cli = cleanStr(r[IDX.CLIENTE]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      if (!cli || isNaN(lat) || isNaN(lng)) return;

      if (!clientPoints.has(cli)) {
        clientPoints.set(cli, {
          cod: cli,
          nombre: cleanStr(r[IDX.NOMBRE]) || cli,
          direccion: cleanStr(r[IDX.DIRECCION]) || "-",
          placa: cleanStr(r[IDX.PLACA]) || "-",
          ruta: cleanStr(r[IDX.RUTA]) || "-",
          canalCode: normalizeChannelCode(r[IDX.CANAL]),
          lat, lng,
          rows: []
        });
      }
      clientPoints.get(cli).rows.push(r);
    });

    clientPoints.forEach(pt => {
      const color = getChannelColor(pt.canalCode);
      const val = metricCalc(pt.rows, state.activeMetric);
      const textBadgeColor = pt.canalCode === "MOD" ? "#18181b" : "#ffffff";

      const marker = L.circleMarker([pt.lat, pt.lng], {
        radius: 6.5,
        fillColor: color,
        color: "#ffffff",
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.92
      });

      marker.bindPopup(`
        <div style="font-family:'Inter',sans-serif; font-size:12px; line-height:1.45; min-width:190px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <strong style="color:#18181b;">${pt.cod}</strong>
            <span style="background:${color}; color:${textBadgeColor}; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:800;">${pt.canalCode}</span>
          </div>
          <div style="font-weight:700; color:#3f3f46; margin-bottom:4px;">${pt.nombre}</div>
          <div style="color:#71717a; font-size:11px; margin-bottom:6px;">${pt.direccion}</div>
          <div style="background:#f4f4f5; padding:5px 8px; border-radius:6px;">
            <strong>${hudMetricLabel}:</strong> ${formatMetric(val, state.activeMetric)}<br>
            <strong>Placa:</strong> ${pt.placa} • <strong>Ruta:</strong> ${pt.ruta}
          </div>
        </div>
      `);

      marker.addTo(mapLayerGroup);
      bounds.push([pt.lat, pt.lng]);
    });

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [65, 65], maxZoom: 13 });
    } else if (cdInfo) {
      map.setView([cdInfo.lat, cdInfo.lng], 12);
    }
  }

  function openCenterGeopositions(cdCode) {
    state.selectedCenter = cdCode;
    state.selectedChannelCode = null;
    updateDashboard();
  }

  function renderSidePanel() {
    const activeRows = getActiveRows();

    const cli = countClientes(activeRows);
    const ped = countPedidos(activeRows);
    const kg  = sumKg(activeRows);
    const sol = sumSoles(activeRows);
    const cam = countTrucks(activeRows);

    const titleEl = document.getElementById("panelTitle");
    const shareEl = document.getElementById("panelShareBadge");

    if (!state.selectedCenter) {
      titleEl.textContent = "Región Lima (Total)";
      shareEl.textContent = "3 Centros • 100%";
    } else {
      titleEl.textContent = state.selectedChannelCode
        ? `${state.selectedCenter} • ${state.selectedChannelCode}`
        : state.selectedCenter;

      const activeMetricVal = metricCalc(activeRows, state.activeMetric);
      const globalMetricVal = metricCalc(allRows, state.activeMetric);

      if (state.activeMetric.includes("/")) {
        const diffPct = globalMetricVal ? Math.round(((activeMetricVal - globalMetricVal) / globalMetricVal) * 100) : 0;
        const sign = diffPct >= 0 ? "+" : "";
        shareEl.textContent = `${sign}${diffPct}% vs Prom. Lima`;
      } else {
        const sharePct = globalMetricVal ? Math.round((activeMetricVal / globalMetricVal) * 100) : 0;
        const shortMetricNames = {
          Clientes: "Clientes",
          Pedidos: "Pedidos",
          Kilogramos: "Kg",
          Soles: "Soles",
          Camiones: "Flota"
        };
        const labelMetric = shortMetricNames[state.activeMetric] || state.activeMetric;
        shareEl.textContent = `${sharePct}% de ${labelMetric} Lima`;
      }
    }

    document.getElementById("valClientes").textContent   = cli.toLocaleString("es-PE");
    document.getElementById("valPedidos").textContent    = ped.toLocaleString("es-PE");
    document.getElementById("valKilogramos").textContent = formatMetric(kg, "Kilogramos", true);
    document.getElementById("valSoles").textContent      = formatMetric(sol, "Soles", true);
    document.getElementById("valCamiones").textContent   = `${cam} u.`;

    ["Clientes", "Pedidos", "Kilogramos", "Soles", "Camiones"].forEach(m => {
      const subEl = document.getElementById(`sub${m}`);
      if (!subEl) return;
      subEl.textContent = (state.activeMetric === m) ? "● Mostrando en mapa" : "Click para ver en mapa";
    });

    const kgCam  = cam ? (kg / cam) : 0;
    const kgCli  = cli ? (kg / cli) : 0;
    const cliCam = cam ? (cli / cam) : 0;

    document.getElementById("valKgCamion").textContent  = kgCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valKgCliente").textContent = kgCli.toLocaleString("es-PE", { maximumFractionDigits: 1 });
    document.getElementById("valCliCamion").textContent = cliCam.toLocaleString("es-PE", { maximumFractionDigits: 1 });

    document.querySelectorAll(".geo-kpi-row-card").forEach(card => {
      card.classList.toggle("is-active", card.getAttribute("data-metric") === state.activeMetric);
    });
    document.querySelectorAll(".geo-pi-card").forEach(card => {
      card.classList.toggle("is-active", card.getAttribute("data-metric") === state.activeMetric);
    });

    renderBreakdownList();
  }

  function renderBreakdownList() {
    const listEl  = document.getElementById("geoBreakdownList");
    const titleEl = document.getElementById("breakdownTitle");
    const tagEl   = document.getElementById("breakdownMetricTag");
    listEl.innerHTML = "";
    tagEl.textContent = state.activeMetric === "Camiones" ? "Flota" : state.activeMetric;

    if (!state.selectedCenter) {
      titleEl.textContent = "Comparativa por Centro";
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
        extra: `${countTrucks(rows)} u.`,
        color: "#10b981"
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
          <div class="geo-break-bar"><span style="width:${barW}%; background:${it.color};"></span></div>
        `;
        row.addEventListener("click", () => openCenterGeopositions(it.key));
        listEl.appendChild(row);
      });

    } else {
      titleEl.textContent = `Canales en ${state.selectedCenter}`;
      const centerRows = allRows.filter(r => cleanStr(r[IDX.CENTRO]) === state.selectedCenter);

      const items = CHANNEL_CONFIG.map(ch => {
        const rows = centerRows.filter(r => normalizeChannelCode(r[IDX.CANAL]) === ch.key);
        return {
          key: ch.key,
          label: ch.label,
          val: metricCalc(rows, state.activeMetric),
          extra: `${countPedidos(rows)} ped.`,
          color: ch.color
        };
      }).filter(it => it.val > 0).sort((a, b) => b.val - a.val);

      const totalSum = items.reduce((acc, it) => acc + it.val, 0) || 1;
      const maxVal   = Math.max(1, ...items.map(it => it.val));

      items.forEach(it => {
        const pct = Math.round((it.val / totalSum) * 100);
        const barW = Math.round((it.val / maxVal) * 100);
        const row = document.createElement("div");
        row.className = `geo-break-row ${state.selectedChannelCode === it.key ? "is-selected" : ""}`;
        row.innerHTML = `
          <div class="geo-break-top">
            <strong><i class="cd-ch-dot" style="background:${it.color};"></i> ${it.label} <small style="color:#e1bee7; font-weight:500;">(${it.extra})</small></strong>
            <div class="geo-break-nums">
              <span class="geo-break-pct">${pct}%</span>
              <span class="geo-break-val">${formatMetric(it.val, state.activeMetric, true)}</span>
            </div>
          </div>
          <div class="geo-break-bar"><span style="width:${barW}%; background:${it.color};"></span></div>
        `;
        row.addEventListener("click", () => {
          state.selectedChannelCode = (state.selectedChannelCode === it.key) ? null : it.key;
          updateDashboard();
        });
        listEl.appendChild(row);
      });
    }
  }

  /* ==========================================================================
     CAPTURA DE PANTALLA CON PIE EJECUTIVO (FECHA CSV + LINK DASHBOARD)
     ========================================================================== */
  function showToast(msg) {
    const toast = document.getElementById("shotToast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("is-visible");
    setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  async function captureDashboardToClipboard() {
    const target = document.getElementById("dashboardCaptureArea");
    const btn = document.getElementById("btnCopyScreenshot");
    const icon = document.getElementById("shotIcon");
    if (!target || typeof html2canvas !== "function") return;

    const zoomCtrl = document.querySelector(".leaflet-control-zoom");
    btn.style.visibility = "hidden";
    if (zoomCtrl) zoomCtrl.style.visibility = "hidden";

    const fechaPlan = window.RoadMapFechaOperativa || csvPlanningDate || "del día";

    try {
      const baseCanvas = await html2canvas(target, {
        useCORS: true,
        allowTaint: false,
        scale: 2,
        backgroundColor: "#f5f4f8"
      });

      // Crear lienzo final añadiendo pie ejecutivo con texto y link del dashboard
      const footerH = 72; // 36px reales a escala 2x
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = baseCanvas.width;
      finalCanvas.height = baseCanvas.height + footerH;

      const ctx = finalCanvas.getContext("2d");
      ctx.drawImage(baseCanvas, 0, 0);

      // Fondo grafito corporativo para el pie de imagen
      ctx.fillStyle = "#16141c";
      ctx.fillRect(0, baseCanvas.height, finalCanvas.width, footerH);

      // Texto informativo izquierdo
      ctx.fillStyle = "#e4e4e7";
      ctx.font = "600 22px Inter, Roboto, sans-serif";
      ctx.textBaseline = "middle";
      const infoText = `Estos son los datos de la planificación del día ${fechaPlan}`;
      ctx.fillText(infoText, 32, baseCanvas.height + footerH / 2);

      // Link derecho en tono amatista claro
      ctx.fillStyle = "#e1bee7";
      ctx.font = "700 22px Inter, Roboto, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(DASHBOARD_PUBLIC_URL, finalCanvas.width - 32, baseCanvas.height + footerH / 2);

      finalCanvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob })
          ]);
          icon.textContent = "check";
          showToast(`Captura copiada (Planificación ${fechaPlan})`);
          setTimeout(() => { icon.textContent = "photo_camera"; }, 1800);
        } catch (clipErr) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `RoadMap_Dashboard_${fechaPlan.replace(/\//g, "-")}.png`;
          a.click();
          URL.revokeObjectURL(url);
          showToast("Captura descargada en PNG");
        }
      }, "image/png");
    } catch (err) {
      console.error("Error generando captura:", err);
      showToast("No se pudo generar la captura");
    } finally {
      btn.style.visibility = "visible";
      if (zoomCtrl) zoomCtrl.style.visibility = "visible";
    }
  }

  function updateDashboard() {
    renderMapState();
    renderSidePanel();
  }

  function bindEvents() {
    document.querySelectorAll(".geo-kpi-row-card").forEach(card => {
      card.addEventListener("click", () => {
        state.activeMetric = card.getAttribute("data-metric");
        updateDashboard();
      });
    });

    document.querySelectorAll(".geo-pi-card").forEach(card => {
      card.addEventListener("click", () => {
        state.activeMetric = card.getAttribute("data-metric");
        updateDashboard();
      });
    });

    document.getElementById("btnBackToRegion").addEventListener("click", () => {
      state.selectedCenter = null;
      state.selectedChannelCode = null;
      updateDashboard();
    });

    document.getElementById("btnCopyScreenshot").addEventListener("click", captureDashboardToClipboard);

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

      // Extraer fecha operativa del CSV como respaldo inmediato
      if (rows.length > 0 && rows[0][IDX.FECHA]) {
        const rawF = cleanStr(rows[0][IDX.FECHA]).split(" ")[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(rawF)) {
          const [y, m, d] = rawF.split("-");
          csvPlanningDate = `${d}/${m}/${y}`;
        } else {
          csvPlanningDate = rawF.replace(/-/g, "/");
        }
        if (!window.RoadMapFechaOperativa) {
          window.RoadMapFechaOperativa = csvPlanningDate;
          const badge = document.getElementById("header-date-badge");
          if (badge) badge.textContent = csvPlanningDate;
        }
      }

      bindEvents();
      updateDashboard();
    } catch (err) {
      console.error("Error cargando RoadMap.csv:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
