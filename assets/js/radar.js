/* ==========================================================================
   RoadMap - radar.js (Dispersión por Placa + Mapa Interactivo de Zonas Viales)
   ========================================================================== */

(() => {
  const FALLBACKS = [
    window.RoadMapConfig?.CSV_URL,
    './RoadMap.csv',
    './assets/data/RoadMap.csv',
    'https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv'
  ].filter(Boolean);

  // Coordenadas exactas de los 3 Centros de Distribución (Región Lima)
  const CD_COORDS = {
    "0374-ATE":     { lat: -12.067013469355048, lng: -76.97943349160968 },
    "0780-ATE2":    { lat: -12.045124965310059, lng: -76.93813036277461 },
    "0754-CHANCAY": { lat: -11.551110366002629, lng: -77.27641679959045 }
  };

  // Paleta distintiva de colores para diferenciar placas en el mapa vial
  const PLATE_PALETTE = [
    "#8e24aa", "#2563eb", "#10b981", "#f97316", "#ec4899",
    "#06b6d4", "#eab308", "#6366f1", "#14b8a6", "#f43f5e",
    "#84cc16", "#a855f7", "#0ea5e9", "#d97706"
  ];

  // Corredores Viales Críticos con sus Bounding Boxes para dibujar el polígono en el mapa
  const TRAFFIC_CORRIDORS = [
    {
      id: "CARRETERA_CENTRAL",
      name: "Eje Carretera Central / Ate - Sta. Anita",
      level: "CRÍTICO",
      cls: "lvl-critico",
      zoneColor: "#ef4444",
      reason: "Obras Línea 2 + transporte pesado",
      bounds: [[-12.085, -76.985], [-12.005, -76.820]],
      check: (lat, lng) => lat >= -12.085 && lat <= -12.005 && lng >= -76.985 && lng <= -76.820
    },
    {
      id: "CENTRO_HISTORICO",
      name: "Centro Histórico / Abancay - Grau - La Victoria",
      level: "CRÍTICO",
      cls: "lvl-critico",
      zoneColor: "#ef4444",
      reason: "Congestión comercial y restricción horaria",
      bounds: [[-12.085, -77.055], [-12.035, -77.005]],
      check: (lat, lng) => lat >= -12.085 && lat <= -12.035 && lng >= -77.055 && lng <= -77.005
    },
    {
      id: "PANAMERICANA_NORTE",
      name: "Panamericana Norte / Puente Piedra - Ancón",
      level: "ALTO",
      cls: "lvl-alto",
      zoneColor: "#f97316",
      reason: "Cuellos de botella en óvalos y peajes",
      bounds: [[-11.980, -77.180], [-11.720, -77.030]],
      check: (lat, lng) => lat >= -11.980 && lat <= -11.720 && lng >= -77.180 && lng <= -77.030
    },
    {
      id: "VIA_EXPRESA_FINANCIERO",
      name: "Eje Javier Prado / San Isidro - Surquillo",
      level: "ALTO",
      cls: "lvl-alto",
      zoneColor: "#f97316",
      reason: "Alta densidad vehicular en hora punta",
      bounds: [[-12.125, -77.055], [-12.080, -76.985]],
      check: (lat, lng) => lat >= -12.125 && lat <= -12.080 && lng >= -77.055 && lng <= -76.985
    },
    {
      id: "CALLAO_PUERTO",
      name: "Eje Av. Argentina / Faucett - Callao",
      level: "ALTO",
      cls: "lvl-alto",
      zoneColor: "#f97316",
      reason: "Flujo de contenedores y carga portuaria",
      bounds: [[-12.075, -77.150], [-11.990, -77.075]],
      check: (lat, lng) => lat >= -12.075 && lat <= -11.990 && lng >= -77.150 && lng <= -77.075
    },
    {
      id: "CONO_SUR",
      name: "Panamericana Sur / SJM - VMT - VES",
      level: "MEDIO",
      cls: "lvl-medio",
      zoneColor: "#eab308",
      reason: "Tráfico interdistrital y mercados zonales",
      bounds: [[-12.260, -77.020], [-12.130, -76.900]],
      check: (lat, lng) => lat >= -12.260 && lat <= -12.130 && lng >= -77.020 && lng <= -76.900
    },
    {
      id: "NORTE_CHICO",
      name: "Corredor Chancay - Huaral - Huacho",
      level: "MEDIO",
      cls: "lvl-medio",
      zoneColor: "#eab308",
      reason: "Tramos interurbanos y desvíos portuarios",
      bounds: [[-11.650, -77.650], [-11.050, -77.150]],
      check: (lat, lng) => lat < -11.050 && lat >= -11.650
    }
  ];

  const WEIGHT_RANGES = [
    { id: "0-1",     label: "0 a 1 kg",         min: 0,   max: 1 },
    { id: "1-5",     label: "1 a 5 kg",         min: 1,   max: 5 },
    { id: "5-10",    label: "5 a 10 kg",        min: 5,   max: 10 },
    { id: "10-50",   label: "10 a 50 kg",       min: 10,  max: 50 },
    { id: "50-100",  label: "50 a 100 kg",      min: 50,  max: 100 },
    { id: "100-200", label: "100 a 200 kg",     min: 100, max: 200 },
    { id: "200+",    label: "Mayores a 200 kg", min: 200, max: Infinity }
  ];

  const CHANNEL_COLORS = {
    DET: "#ef4444",
    FSE: "#2563eb",
    MES: "#f97316",
    MOD: "#eab308"
  };

  function normalizeChannelCode(raw) {
    const clean = String(raw ?? "").replace(/\s*\([^\)]*\)/g, "").trim().toUpperCase();
    if (clean === "FSE" || clean.includes("FOSE")) return "FSE";
    if (clean.includes("DET")) return "DET";
    if (clean.includes("MES")) return "MES";
    if (clean.includes("MOD")) return "MOD";
    return "OTRO";
  }

  function parseTimeWindow(rawWin) {
    const raw = String(rawWin ?? "").trim();
    if (!raw) return { raw, status: "MISSING", startMin: null, endMin: null, durationMin: 0 };

    const matches = Array.from(raw.matchAll(/(\d{1,2}):(\d{2})\s*([AaPp]\.?\s*[Mm]\.?)?/g));
    if (matches.length < 2) {
      return { raw, status: "INVALID_FORMAT", startMin: null, endMin: null, durationMin: 0 };
    }

    const parsePart = (m) => {
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = (m[3] || "").replace(/[\.\s]/g, "").toUpperCase();

      if (min < 0 || min > 59) return null;

      if (mer === "AM" || mer === "PM") {
        if (h < 1 || h > 12) return null;
        if (mer === "AM" && h === 12) h = 0;
        if (mer === "PM" && h !== 12) h += 12;
      } else {
        if (h < 0 || h > 23) return null;
      }

      const hh = String(h).padStart(2, "0");
      const mm = String(min).padStart(2, "0");
      return { mins: h * 60 + min, str24: `${hh}:${mm}` };
    };

    const startObj = parsePart(matches[0]);
    const endObj   = parsePart(matches[1]);

    if (!startObj || !endObj) {
      return { raw, status: "INVALID_TIME", startMin: null, endMin: null, durationMin: 0 };
    }
    if (startObj.mins >= endObj.mins) {
      return {
        raw,
        status: "REVERSED",
        startMin: startObj.mins,
        endMin: endObj.mins,
        durationMin: endObj.mins - startObj.mins
      };
    }

    const durationMin  = endObj.mins - startObj.mins;
    const isNarrow     = durationMin <= 120;
    const isEarlyClose = endObj.mins <= 11 * 60;

    return {
      raw,
      status: "VALID",
      startStr: startObj.str24,
      endStr: endObj.str24,
      startMin: startObj.mins,
      endMin: endObj.mins,
      durationMin,
      isNarrow,
      isEarlyClose
    };
  }

  function isValidCoord(lat, lng) {
    return !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0 &&
           lat >= -13.5 && lat <= -10.5 && lng >= -78.0 && lng <= -75.5;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function getQuantile(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const pos = (sortedArr.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedArr[base + 1] !== undefined) {
      return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
    }
    return sortedArr[base];
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
      return await resp.text();
    } finally { clearTimeout(timer); }
  }

  async function loadCSVWithFallback() {
    for (const u of FALLBACKS) {
      try { return await fetchWithTimeout(u); } catch {}
    }
    throw new Error('No se pudo cargar RoadMap.csv');
  }

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    if (!lines.length) return { header: [], rows: [] };
    const parseLine = line => {
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
    };
    return {
      header: parseLine(lines[0]),
      rows: lines.slice(1).map(parseLine)
    };
  }

  let IDX = {
    FECHA: 0, CENTRO: 1, PLACA: 2, CLIENTE: 3, NOMBRE: 4, RUTA: 6, PEDIDO: 7,
    SKU_COD: 8, SKU_DESC: 9, KG: 10, SOLES: 11, CIUDAD: 14, DIRECCION: 15,
    LAT: 16, LNG: 17, VENTANA: 18, CANAL: 19
  };

  function detectColumns(header) {
    if (!header || !header.length) return;
    header.forEach((h, i) => {
      const u = String(h).trim().toUpperCase();
      if (u.includes("MATERIAL") || u.includes("COD_PROD") || u === "SKU") IDX.SKU_COD = i;
      if (u.includes("DESCRIP") || u.includes("PRODUCTO") || u === "ARTICULO") IDX.SKU_DESC = i;
      if (u.includes("VENTANA") || u.includes("HORARIO")) IDX.VENTANA = i;
      if (u.includes("DISTRITO") || u.includes("CIUDAD") || u.includes("POBLAC")) IDX.CIUDAD = i;
    });
  }

  const EXCLUDE_FRT = "FRT-001";
  const TRUCKS_EXCLUDED = new Set(["FRT-001", "RES-CLI"]);

  const cleanStr = v => String(v ?? "").trim();
  const upperStr = v => cleanStr(v).toUpperCase();
  const toNum = v => { const n = parseFloat(String(v ?? "0").replace(",", ".")); return isNaN(n) ? 0 : n; };
  const isFRT = r => upperStr(r[IDX.PLACA]) === EXCLUDE_FRT;
  const isTruckExcluded = r => {
    const p = upperStr(r[IDX.PLACA]);
    return !p || TRUCKS_EXCLUDED.has(p);
  };

  let allRows = [];
  let currentUnitAuditsMap = new Map();
  let currentTrafficStatsMap = new Map();
  let lastAnalyzedClients = [];

  let dispersionMap = null;
  let dispersionLayer = null;
  let trafficZoneMap = null;
  let trafficZoneLayer = null;

  let state = {
    activeTab: "tab-riesgo",
    selectedCenter: "Todos",
    riskSort: "risk"
  };

  /* ==========================================================================
     1. AUDITORÍA DE CALIDAD DE DATOS Y RECONCILIACIÓN
     ========================================================================== */
  function auditDataQuality(rows) {
    const total = rows.length;
    const frtRows = rows.filter(r => isFRT(r));
    const validRows = rows.filter(r => !isFRT(r));

    const emptyPlate = validRows.filter(r => !cleanStr(r[IDX.PLACA]));
    const zeroOrNegKg = validRows.filter(r => toNum(r[IDX.KG]) <= 0);
    const badCoords = validRows.filter(r => {
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      return !isValidCoord(lat, lng);
    });

    const badWindows = validRows.filter(r => {
      const w = parseTimeWindow(r[IDX.VENTANA]);
      return w.status === "REVERSED" || w.status === "INVALID_FORMAT" || w.status === "INVALID_TIME";
    });
    const missingWindows = validRows.filter(r => parseTimeWindow(r[IDX.VENTANA]).status === "MISSING");

    const plateCenters = new Map();
    validRows.filter(r => !isTruckExcluded(r)).forEach(r => {
      const p = upperStr(r[IDX.PLACA]);
      const c = cleanStr(r[IDX.CENTRO]);
      if (!plateCenters.has(p)) plateCenters.set(p, new Set());
      plateCenters.get(p).add(c);
    });
    const multiCenterPlates = Array.from(plateCenters.entries()).filter(([, set]) => set.size > 1);

    const orderPlates = new Map();
    validRows.forEach(r => {
      const ped = cleanStr(r[IDX.PEDIDO]);
      const p = upperStr(r[IDX.PLACA]);
      if (!ped) return;
      if (!orderPlates.has(ped)) orderPlates.set(ped, new Set());
      orderPlates.get(ped).add(p);
    });
    const splitOrders = Array.from(orderPlates.entries()).filter(([, set]) => set.size > 1);

    const totalKgRaw = rows.reduce((s, r) => s + toNum(r[IDX.KG]), 0);
    const totalKgValid = validRows.reduce((s, r) => s + toNum(r[IDX.KG]), 0);
    const totalKgExcluded = frtRows.reduce((s, r) => s + toNum(r[IDX.KG]), 0);

    const checks = [
      {
        title: "Ventanas Horarias Inválidas o Invertidas",
        count: badWindows.length,
        pct: validRows.length ? ((badWindows.length / validRows.length) * 100).toFixed(2) : "0.00",
        sev: badWindows.length > 0 ? "crit" : "ok",
        desc: badWindows.length > 0
          ? `Ej: Cliente ${cleanStr(badWindows[0][IDX.CLIENTE])} tiene ventana "${cleanStr(badWindows[0][IDX.VENTANA])}".`
          : `Sin ventanas invertidas. (${missingWindows.length} líneas sin ventana informada).`
      },
      {
        title: "Coordenadas Vacías, Cero o Fuera de Lima",
        count: badCoords.length,
        pct: validRows.length ? ((badCoords.length / validRows.length) * 100).toFixed(2) : "0.00",
        sev: badCoords.length > 0 ? "crit" : "ok",
        desc: badCoords.length > 0
          ? `Ej: Cliente ${cleanStr(badCoords[0][IDX.CLIENTE])} (${cleanStr(badCoords[0][IDX.NOMBRE])}) con Lat/Lng inválida.`
          : "Todas las entregas válidas tienen geoposición dentro de Región Lima."
      },
      {
        title: "Registros Ficticios / Excluidos (FRT-001)",
        count: frtRows.length,
        pct: total ? ((frtRows.length / total) * 100).toFixed(2) : "0.00",
        sev: frtRows.length > 0 ? "warn" : "ok",
        desc: `Se excluyen ${frtRows.length} filas (${totalKgExcluded.toFixed(1)} kg) de FRT-001 según regla operativa.`
      },
      {
        title: "Líneas con Peso Cero o Negativo (<= 0 kg)",
        count: zeroOrNegKg.length,
        pct: validRows.length ? ((zeroOrNegKg.length / validRows.length) * 100).toFixed(2) : "0.00",
        sev: zeroOrNegKg.length > 0 ? "warn" : "ok",
        desc: zeroOrNegKg.length > 0
          ? `Ej: Pedido ${cleanStr(zeroOrNegKg[0][IDX.PEDIDO])} registra ${zeroOrNegKg[0][IDX.KG]} kg.`
          : "Sin líneas con peso nulo o negativo."
      },
      {
        title: "Pedidos Divididos en Múltiples Placas",
        count: splitOrders.length,
        pct: orderPlates.size ? ((splitOrders.length / orderPlates.size) * 100).toFixed(2) : "0.00",
        sev: splitOrders.length > 0 ? "warn" : "ok",
        desc: splitOrders.length > 0
          ? `Pedido ${splitOrders[0][0]} asignado a placas: ${Array.from(splitOrders[0][1]).join(", ")}.`
          : "Cada pedido está asignado íntegro a una sola placa."
      },
      {
        title: "Placas Asignadas a Múltiples Centros",
        count: multiCenterPlates.length,
        pct: plateCenters.size ? ((multiCenterPlates.length / plateCenters.size) * 100).toFixed(2) : "0.00",
        sev: multiCenterPlates.length > 0 ? "crit" : "ok",
        desc: multiCenterPlates.length > 0
          ? `Placa ${multiCenterPlates[0][0]} figura en centros: ${Array.from(multiCenterPlates[0][1]).join(" y ")}.`
          : "Ninguna placa física opera simultáneamente en dos centros."
      }
    ];

    const issueRowsCount = badCoords.length + badWindows.length + zeroOrNegKg.length + emptyPlate.length;
    const integrityPct = validRows.length
      ? Math.max(0, 100 - ((issueRowsCount / validRows.length) * 100)).toFixed(1)
      : "100.0";

    return {
      total,
      validCount: validRows.length,
      excludedCount: frtRows.length,
      totalKgRaw,
      totalKgValid,
      totalKgExcluded,
      integrityPct,
      checks
    };
  }

  /* ==========================================================================
     2. MOTOR ANALÍTICO DE DISPERSIÓN, ZONAS VIALES Y PRODUCTOS
     ========================================================================== */
  function analyzeOperation(filteredRows) {
    const clientsMap = new Map();
    filteredRows.forEach(r => {
      const cli = cleanStr(r[IDX.CLIENTE]);
      if (!cli) return;
      const fecha = cleanStr(r[IDX.FECHA]).split(" ")[0];
      const centro = cleanStr(r[IDX.CENTRO]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      const kg = toNum(r[IDX.KG]);
      const soles = toNum(r[IDX.SOLES]);

      if (!clientsMap.has(cli)) {
        const cdPos = CD_COORDS[centro];
        const distFromCd = (isValidCoord(lat, lng) && cdPos)
          ? haversineKm(cdPos.lat, cdPos.lng, lat, lng)
          : 0;
        const winParsed = parseTimeWindow(r[IDX.VENTANA]);

        clientsMap.set(cli, {
          fecha,
          cod: cli,
          nombre: cleanStr(r[IDX.NOMBRE]) || cli,
          centro,
          ruta: cleanStr(r[IDX.RUTA]) || "-",
          placa: upperStr(r[IDX.PLACA]),
          canal: normalizeChannelCode(r[IDX.CANAL]),
          ciudad: cleanStr(r[IDX.CIUDAD]) || "-",
          direccion: cleanStr(r[IDX.DIRECCION]) || "-",
          lat, lng,
          hasValidCoord: isValidCoord(lat, lng),
          distFromCd,
          win: winParsed,
          kg: 0,
          soles: 0
        });
      }
      const cObj = clientsMap.get(cli);
      cObj.kg += kg;
      cObj.soles += soles;
    });
    const clients = Array.from(clientsMap.values());

    // Agrupación directa por Centro + Placa
    const unitsMap = new Map();
    filteredRows.filter(r => !isTruckExcluded(r)).forEach(r => {
      const centro = cleanStr(r[IDX.CENTRO]);
      const placa  = upperStr(r[IDX.PLACA]);
      const key    = `${centro}|${placa}`;

      if (!unitsMap.has(key)) {
        unitsMap.set(key, {
          key,
          centro,
          placa,
          kg: 0,
          soles: 0,
          pedidosSet: new Set(),
          channelsSet: new Set(),
          stopsMap: new Map()
        });
      }
      const unit = unitsMap.get(key);
      unit.kg += toNum(r[IDX.KG]);
      unit.soles += toNum(r[IDX.SOLES]);
      const ped = cleanStr(r[IDX.PEDIDO]);
      if (ped) unit.pedidosSet.add(ped);
      unit.channelsSet.add(normalizeChannelCode(r[IDX.CANAL]));

      const cli = cleanStr(r[IDX.CLIENTE]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      if (cli) {
        if (!unit.stopsMap.has(cli)) {
          unit.stopsMap.set(cli, {
            cod: cli,
            nombre: cleanStr(r[IDX.NOMBRE]) || cli,
            direccion: cleanStr(r[IDX.DIRECCION]) || "-",
            canal: normalizeChannelCode(r[IDX.CANAL]),
            win: parseTimeWindow(r[IDX.VENTANA]),
            lat, lng,
            hasValidCoord: isValidCoord(lat, lng),
            kg: 0,
            soles: 0
          });
        }
        const st = unit.stopsMap.get(cli);
        st.kg += toNum(r[IDX.KG]);
        st.soles += toNum(r[IDX.SOLES]);
      }
    });

    const allOutliers = [];

    const unitAudits = Array.from(unitsMap.values()).map(unit => {
      const stops = Array.from(unit.stopsMap.values());
      const validStops = stops.filter(s => s.hasValidCoord);
      const missingCoordStops = stops.filter(s => !s.hasValidCoord);

      const criticalWinStops = stops.filter(s => s.win.status === "VALID" && (s.win.isNarrow || s.win.isEarlyClose));
      const invalidWinStops  = stops.filter(s => s.win.status === "REVERSED" || s.win.status === "INVALID_FORMAT" || s.win.status === "INVALID_TIME");

      let centLat = 0, centLng = 0;
      if (validStops.length > 0) {
        centLat = validStops.reduce((s, p) => s + p.lat, 0) / validStops.length;
        centLng = validStops.reduce((s, p) => s + p.lng, 0) / validStops.length;
      }

      let maxDiameterKm = 0;
      for (let i = 0; i < validStops.length; i++) {
        for (let j = i + 1; j < validStops.length; j++) {
          const d = haversineKm(validStops[i].lat, validStops[i].lng, validStops[j].lat, validStops[j].lng);
          if (d > maxDiameterKm) maxDiameterKm = d;
        }
      }

      const stopsWithDist = stops.map(s => ({
        ...s,
        distToCentroid: s.hasValidCoord ? haversineKm(centLat, centLng, s.lat, s.lng) : 0
      }));

      const validDists = stopsWithDist.filter(s => s.hasValidCoord).map(d => d.distToCentroid).sort((a, b) => a - b);
      const q1 = getQuantile(validDists, 0.25);
      const q3 = getQuantile(validDists, 0.75);
      const iqr = q3 - q1;
      const outlierThreshold = Math.max(4.5, q3 + 1.5 * iqr);

      const unitOutliers = stopsWithDist.filter(d => d.hasValidCoord && validStops.length >= 4 && d.distToCentroid > outlierThreshold);
      const outlierSet = new Set(unitOutliers.map(o => o.cod));

      const enrichedStops = stopsWithDist.map(s => ({
        ...s,
        isOutlier: outlierSet.has(s.cod)
      }));

      unitOutliers.forEach(o => {
        allOutliers.push({
          ...o,
          unitKey: unit.key,
          centro: unit.centro,
          placa: unit.placa,
          thresholdKm: outlierThreshold
        });
      });

      const isHighlyDispersed = validStops.length > 0 && (unitOutliers.length > 0 || maxDiameterKm > 16);

      const clientDefects = [];
      enrichedStops.forEach(s => {
        if (!s.hasValidCoord) {
          clientDefects.push({
            cod: s.cod,
            nombre: s.nombre,
            canal: s.canal,
            kg: s.kg,
            sev: "crit",
            badge: "SIN COORDENADA",
            detail: `Lat/Lng vacía, en 0 o fuera de Lima (${isNaN(s.lat) ? "vacío" : s.lat}, ${isNaN(s.lng) ? "vacío" : s.lng}).`
          });
        }
        if (s.isOutlier) {
          clientDefects.push({
            cod: s.cod,
            nombre: s.nombre,
            canal: s.canal,
            kg: s.kg,
            sev: "crit",
            badge: "GENERA DISPERSIÓN",
            detail: `Alejado +${s.distToCentroid.toFixed(1)} km del centroide de la placa (umbral IQR: ${outlierThreshold.toFixed(1)} km).`
          });
        }
        if (s.win.status === "REVERSED" || s.win.status === "INVALID_FORMAT" || s.win.status === "INVALID_TIME") {
          clientDefects.push({
            cod: s.cod,
            nombre: s.nombre,
            canal: s.canal,
            kg: s.kg,
            sev: "crit",
            badge: "VH INVÁLIDA",
            detail: `Ventana horaria mal estructurada o invertida: "${s.win.raw}".`
          });
        } else if (s.win.status === "VALID" && (s.win.isNarrow || s.win.isEarlyClose)) {
          clientDefects.push({
            cod: s.cod,
            nombre: s.nombre,
            canal: s.canal,
            kg: s.kg,
            sev: "warn",
            badge: "VH RESTRICTIVA",
            detail: `Horario estrecho o cierre temprano (${s.win.startStr} - ${s.win.endStr}). Priorizar en secuencia.`
          });
        }
      });

      const maxClientKg = stops.reduce((m, s) => Math.max(m, s.kg), 0);
      const maxClientShare = unit.kg > 0 ? (maxClientKg / unit.kg) * 100 : 0;

      const geoScore  = Math.min(100, (unitOutliers.length * 34) + (maxDiameterKm > 16 ? 25 : 0));
      const winScore  = Math.min(100, (criticalWinStops.length * 18) + (invalidWinStops.length * 35));
      const compScore = Math.min(100, (stops.length > 35 ? 45 : stops.length > 25 ? 25 : 10) + (unit.channelsSet.size >= 3 ? 25 : 0));
      const balScore  = Math.min(100, (unit.kg < 400 ? 65 : 0) + (maxClientShare > 50 ? 35 : 0));
      const dqScore   = Math.min(100, (missingCoordStops.length * 35) + (invalidWinStops.length * 35));

      let riskScore = Math.round(
        (geoScore  * 0.33) +
        (winScore  * 0.33) +
        (compScore * 0.14) +
        (balScore  * 0.12) +
        (dqScore   * 0.08)
      );

      if (unitOutliers.length >= 2 || criticalWinStops.length >= 5) {
        riskScore = Math.max(riskScore, 62);
      }

      let semaphore = "VERDE";
      let semClass = "sem-verde";
      if (validStops.length === 0) {
        semaphore = "NEGRO";
        semClass = "sem-negro";
      } else if (riskScore >= 61) {
        semaphore = "ROJO";
        semClass = "sem-rojo";
      } else if (riskScore >= 31) {
        semaphore = "AMARILLO";
        semClass = "sem-amarillo";
      }

      const dataDefectsCount = missingCoordStops.length + invalidWinStops.length;

      let finding = "Nube compacta sin alertas relevantes.";
      if (validStops.length === 0) {
        finding = `100% de clientes (${stops.length}) sin coordenada válida → Corregir Lat/Lng.`;
      } else if (unitOutliers.length > 0) {
        finding = `${unitOutliers.length} cliente(s) disperso(s) > ${outlierThreshold.toFixed(1)} km del centroide → Clic para ver en mapa.`;
      } else if (maxDiameterKm > 16) {
        finding = `Ruta extendida (${maxDiameterKm.toFixed(1)} km de extremo a extremo) → Clic para revisar cobertura.`;
      } else if (dataDefectsCount > 0) {
        finding = `${dataDefectsCount} defecto(s) de dato (VH o Lat/Lng) → Clic para ver cliente exacto.`;
      } else if (criticalWinStops.length >= 2) {
        finding = `${criticalWinStops.length} clientes con cierre temprano/ventana estrecha → Priorizar salida.`;
      } else if (unit.kg < 400) {
        finding = `Carga baja (${unit.kg.toFixed(0)} kg) → Evaluar consolidación con unidad cercana.`;
      }

      return {
        ...unit,
        stops: enrichedStops,
        centroid: { lat: centLat, lng: centLng },
        outlierThreshold,
        maxDiameterKm,
        isHighlyDispersed,
        clientDefects,
        dataDefectsCount,
        clientCount: stops.length,
        orderCount: unit.pedidosSet.size,
        outliersCount: unitOutliers.length,
        criticalWinCount: criticalWinStops.length,
        invalidWinCount: invalidWinStops.length,
        missingCoordsCount: missingCoordStops.length,
        dimScores: { geoScore, winScore, compScore, balScore, dqScore },
        riskScore,
        semaphore,
        semClass,
        finding
      };
    });

    // Mix de Productos
    const productsMap = new Map();
    filteredRows.forEach(r => {
      const cod = cleanStr(r[IDX.SKU_COD]);
      const desc = cleanStr(r[IDX.SKU_DESC]);
      const key = desc || cod;
      if (!key) return;
      if (!productsMap.has(key)) {
        productsMap.set(key, { cod, nombre: desc || cod, clientesSet: new Set(), pedidosSet: new Set(), kg: 0, soles: 0 });
      }
      const p = productsMap.get(key);
      if (cleanStr(r[IDX.CLIENTE])) p.clientesSet.add(cleanStr(r[IDX.CLIENTE]));
      if (cleanStr(r[IDX.PEDIDO])) p.pedidosSet.add(cleanStr(r[IDX.PEDIDO]));
      p.kg += toNum(r[IDX.KG]);
      p.soles += toNum(r[IDX.SOLES]);
    });
    const products = Array.from(productsMap.values()).map(p => ({
      ...p,
      clientCount: p.clientesSet.size,
      orderCount: p.pedidosSet.size
    }));

    // Rangos de Peso
    const rangeStats = WEIGHT_RANGES.map(rng => {
      const matching = clients.filter(c => rng.min === 0 ? (c.kg >= 0 && c.kg <= rng.max) : (c.kg > rng.min && c.kg <= rng.max));
      const byChannel = { DET: 0, FSE: 0, MES: 0, MOD: 0 };
      matching.forEach(c => { if (byChannel[c.canal] !== undefined) byChannel[c.canal]++; });
      return {
        ...rng,
        count: matching.length,
        totalKg: matching.reduce((s, c) => s + c.kg, 0),
        byChannel
      };
    });

    // Tráfico vial con detalle de clientes y placas involucradas
    const trafficStats = TRAFFIC_CORRIDORS.map(zone => {
      const zClients = clients.filter(c => c.hasValidCoord && zone.check(c.lat, c.lng));
      const platesMap = new Map();
      zClients.forEach(c => {
        if (!c.placa || TRUCKS_EXCLUDED.has(c.placa)) return;
        const pKey = `${c.centro}|${c.placa}`;
        if (!platesMap.has(pKey)) {
          platesMap.set(pKey, {
            unitKey: pKey,
            placa: c.placa,
            centro: c.centro,
            clientCount: 0,
            kg: 0
          });
        }
        const pObj = platesMap.get(pKey);
        pObj.clientCount++;
        pObj.kg += c.kg;
      });

      const platesList = Array.from(platesMap.values())
        .sort((a, b) => b.clientCount - a.clientCount || b.kg - a.kg)
        .map((p, idx) => ({
          ...p,
          color: PLATE_PALETTE[idx % PLATE_PALETTE.length]
        }));

      return {
        ...zone,
        clientCount: zClients.length,
        totalKg: zClients.reduce((s, c) => s + c.kg, 0),
        platesCount: platesList.length,
        platesList,
        clients: zClients
      };
    }).filter(z => z.clientCount > 0).sort((a, b) => b.clientCount - a.clientCount);

    return { clients, unitAudits, allOutliers, products, rangeStats, trafficStats };
  }

  /* ==========================================================================
     3. EXPORTADOR CSV DE INCIDENCIAS (VENTANAS HORARIAS Y CANAL "OTROS")
     ========================================================================== */
  function exportWindowIssuesCSV() {
    const issues = lastAnalyzedClients.filter(
      c => c.win.status !== "VALID" || c.canal === "OTRO"
    );

    if (!issues.length) {
      alert("No hay clientes con incidencias de ventana horaria ni sin canal asignado en el filtro actual.");
      return;
    }

    const esc = val => `"${String(val ?? "").replace(/"/g, '""')}"`;

    const headers = [
      "Fecha",
      "Centro",
      "Ruta",
      "Placa",
      "Codigo_Cliente",
      "Nombre_Cliente",
      "Canal",
      "Kg_Totales",
      "Ciudad_Distrito",
      "Direccion",
      "Ventana_Original",
      "Observacion_Detectada"
    ];

    const lines = [headers.join(",")];
    issues.forEach(c => {
      const obsList = [];

      if (c.win.status === "MISSING") {
        obsList.push("SIN VENTANA HORARIA");
      } else if (c.win.status === "REVERSED") {
        obsList.push("VENTANA INVERTIDA (INICIO >= FIN)");
      } else if (c.win.status === "INVALID_FORMAT" || c.win.status === "INVALID_TIME") {
        obsList.push("FORMATO DE HORA INVALIDO");
      }

      if (c.canal === "OTRO") {
        obsList.push("SIN CANAL ASIGNADO (OTROS)");
      }

      lines.push([
        esc(c.fecha),
        esc(c.centro),
        esc(c.ruta),
        esc(c.placa),
        esc(c.cod),
        esc(c.nombre),
        esc(c.canal === "OTRO" ? "Otros" : c.canal),
        c.kg.toFixed(2),
        esc(c.ciudad),
        esc(c.direccion),
        esc(c.win.raw || "VACIO"),
        esc(obsList.join(" + "))
      ].join(","));
    });

    const csvContent = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const centerTag = state.selectedCenter === "Todos" ? "Global_Lima" : state.selectedCenter;
    a.href = url;
    a.download = `Incidencias_VH_y_Canal_${centerTag}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ==========================================================================
     4A. DRAWER 1: MAPA DE DISPERSIÓN Y AUDITORÍA POR PLACA
     ========================================================================== */
  function renderDispersionMapForUnit(unit) {
    const mapContainer = document.getElementById("plateDispersionMap");
    if (!mapContainer || typeof L === "undefined") return;

    if (!dispersionMap) {
      dispersionMap = L.map("plateDispersionMap", {
        zoomControl: true,
        attributionControl: false
      }).setView([-12.04, -77.02], 11);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(dispersionMap);

      dispersionLayer = L.layerGroup().addTo(dispersionMap);
    }

    dispersionLayer.clearLayers();
    const validStops = unit.stops.filter(s => s.hasValidCoord);
    const bounds = [];

    const cdPos = CD_COORDS[unit.centro];
    if (cdPos) {
      const cdIcon = L.divIcon({
        className: "",
        html: `<div style="background:#16141c; color:#fff; border:2px solid #8e24aa; padding:2px 7px; border-radius:8px; font-size:10px; font-weight:800; white-space:nowrap; transform:translate(-50%,-50%); box-shadow:0 3px 8px rgba(0,0,0,0.4);">CD ${unit.centro.replace(/^\d+-/, "")}</div>`,
        iconSize: [0, 0]
      });
      L.marker([cdPos.lat, cdPos.lng], { icon: cdIcon }).addTo(dispersionLayer);
      bounds.push([cdPos.lat, cdPos.lng]);
    }

    if (!validStops.length) {
      setTimeout(() => {
        dispersionMap.invalidateSize();
        if (bounds.length) dispersionMap.setView(bounds[0], 11);
      }, 250);
      return;
    }

    L.circle([unit.centroid.lat, unit.centroid.lng], {
      radius: unit.outlierThreshold * 1000,
      color: "#8e24aa",
      weight: 1.5,
      dashArray: "4, 4",
      fillColor: "#8e24aa",
      fillOpacity: 0.08
    }).addTo(dispersionLayer);

    const centIcon = L.divIcon({
      className: "",
      html: `<div style="width:12px; height:12px; border-radius:50%; background:#8e24aa; border:2px solid #fff; transform:translate(-50%,-50%); box-shadow:0 0 0 3px rgba(142,36,170,0.35);" title="Centroide de la placa"></div>`,
      iconSize: [0, 0]
    });
    L.marker([unit.centroid.lat, unit.centroid.lng], { icon: centIcon })
      .bindPopup(`<strong>Centroide Placa ${unit.placa}</strong><br>Umbral IQR: ${unit.outlierThreshold.toFixed(1)} km`)
      .addTo(dispersionLayer);

    validStops.forEach(s => {
      const isDisp = s.isOutlier;
      const color = isDisp ? "#ef4444" : "#10b981";

      if (isDisp) {
        L.polyline(
          [[unit.centroid.lat, unit.centroid.lng], [s.lat, s.lng]],
          { color: "#ef4444", weight: 2, dashArray: "4, 4", opacity: 0.9 }
        ).addTo(dispersionLayer);
      }

      const circle = L.circleMarker([s.lat, s.lng], {
        radius: isDisp ? 8 : 5.5,
        fillColor: color,
        color: "#ffffff",
        weight: isDisp ? 2 : 1.5,
        opacity: 1,
        fillOpacity: 0.95
      });

      circle.bindPopup(`
        <div style="font-family:'Inter',sans-serif; font-size:11px; line-height:1.4;">
          <strong>${s.cod} • ${s.nombre}</strong><br>
          <span style="color:${color}; font-weight:800;">${isDisp ? "⚠ CLIENTE DISPERSO (ATÍPICO)" : "● DENTRO DEL NÚCLEO"}</span><br>
          <strong>Dist. al centroide:</strong> ${s.distToCentroid.toFixed(1)} km<br>
          <strong>Peso:</strong> ${s.kg.toFixed(1)} kg • <strong>Canal:</strong> ${s.canal}
        </div>
      `);

      circle.addTo(dispersionLayer);
      bounds.push([s.lat, s.lng]);
    });

    setTimeout(() => {
      dispersionMap.invalidateSize();
      if (bounds.length > 1) {
        dispersionMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      }
    }, 260);
  }

  function openPlateDetailDrawer(unitKey) {
    closeAllDrawers();
    const unit = currentUnitAuditsMap.get(unitKey);
    if (!unit) return;

    document.getElementById("drawerCenterTag").textContent = unit.centro;
    const semEl = document.getElementById("drawerSemaphoreTag");
    semEl.textContent = unit.semaphore;
    semEl.className = `sem-dot ${unit.semClass}`;

    const riskEl = document.getElementById("drawerRiskTag");
    riskEl.textContent = `${unit.riskScore}/100`;
    riskEl.className = `risk-pill ${unit.riskScore >= 61 ? "risk-high" : unit.riskScore >= 31 ? "risk-med" : "risk-low"}`;

    document.getElementById("drawerPlateTitle").textContent = `Placa ${unit.placa}`;
    document.getElementById("drawerPlateSub").textContent =
      `${unit.clientCount} clientes • ${unit.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg • Diámetro dispersión: ${unit.maxDiameterKm.toFixed(1)} km`;

    document.getElementById("drawerScoreGrid").innerHTML = `
      <div class="d-score-box"><span>Geografía (33%)</span><strong>${unit.dimScores.geoScore}/100</strong></div>
      <div class="d-score-box"><span>Ventanas VH (33%)</span><strong>${unit.dimScores.winScore}/100</strong></div>
      <div class="d-score-box"><span>Complejidad (14%)</span><strong>${unit.dimScores.compScore}/100</strong></div>
      <div class="d-score-box"><span>Balance Carga (12%)</span><strong>${unit.dimScores.balScore}/100</strong></div>
      <div class="d-score-box"><span>Calidad Datos (8%)</span><strong>${unit.dimScores.dqScore}/100</strong></div>
      <div class="d-score-box"><span>Capacidad Vehic.</span><strong>Pend. raw</strong></div>
    `;

    document.getElementById("drawerDefectsCount").textContent = `${unit.clientDefects.length} observados`;
    const defectsListEl = document.getElementById("drawerDefectsList");
    defectsListEl.innerHTML = unit.clientDefects.length
      ? unit.clientDefects.map(d => `
          <div class="defect-card ${d.sev === "warn" ? "defect-card--warn" : ""}">
            <div class="defect-card-top">
              <strong>${d.cod} • ${d.nombre}</strong>
              <span class="defect-type-pill">${d.badge}</span>
            </div>
            <div class="defect-card-sub">${d.detail} (${d.kg.toFixed(1)} kg • ${d.canal})</div>
          </div>
        `).join("")
      : `<div style="padding:10px; font-size:0.72rem; color:#15803d; background:#f0fdf4; border-radius:9px; font-weight:600;">Esta unidad no presenta defectos de VH, coordenadas faltantes ni atípicos geográficos.</div>`;

    document.getElementById("drawerAllClientsCount").textContent = `${unit.stops.length} clientes`;
    const sortedStops = [...unit.stops].sort((a, b) => Number(b.isOutlier) - Number(a.isOutlier) || b.distToCentroid - a.distToCentroid);
    document.getElementById("drawerClientsBody").innerHTML = sortedStops.map(s => {
      const vhBad = s.win.status === "REVERSED" || s.win.status === "INVALID_FORMAT" || s.win.status === "INVALID_TIME";
      const vhText = s.win.status === "VALID"
        ? `${s.win.startStr}-${s.win.endStr}`
        : (s.win.raw ? `<span style="color:#dc2626; font-weight:800;">${s.win.raw}</span>` : `<span style="color:#71717a;">Sin VH</span>`);
      const distText = s.hasValidCoord
        ? (s.isOutlier ? `<span style="color:#dc2626; font-weight:800;">+${s.distToCentroid.toFixed(1)} km ⚠</span>` : `${s.distToCentroid.toFixed(1)} km`)
        : `<span style="color:#dc2626; font-weight:800;">Sin Lat/Lng</span>`;

      return `
        <tr style="${s.isOutlier ? "background:#fef2f2;" : ""}">
          <td><strong>${s.cod}</strong><br><span style="color:#52525b;">${s.nombre}</span></td>
          <td>${s.canal}</td>
          <td>${distText}</td>
          <td style="${vhBad ? "background:#fef2f2;" : ""}">${vhText}</td>
          <td style="font-weight:700;">${s.kg.toFixed(1)} kg</td>
        </tr>
      `;
    }).join("");

    document.getElementById("plateDrawerBackdrop").classList.add("is-open");
    document.getElementById("plateDetailDrawer").classList.add("is-open");

    renderDispersionMapForUnit(unit);
  }

  /* ==========================================================================
     4B. DRAWER 2: MAPA DE COMPLEJIDAD VIAL Y PLACAS INVOLUCRADAS
     ========================================================================== */
  function renderTrafficZoneMap(zone, filterPlate = null) {
    const mapContainer = document.getElementById("trafficZoneMap");
    if (!mapContainer || typeof L === "undefined") return;

    if (!trafficZoneMap) {
      trafficZoneMap = L.map("trafficZoneMap", {
        zoomControl: true,
        attributionControl: false
      }).setView([-12.05, -77.02], 12);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(trafficZoneMap);

      trafficZoneLayer = L.layerGroup().addTo(trafficZoneMap);
    }

    trafficZoneLayer.clearLayers();

    // 1. Dibujar el polígono del corredor vial con complejidad marcada
    const zoneRect = L.rectangle(zone.bounds, {
      color: zone.zoneColor,
      weight: 2.5,
      dashArray: "6, 5",
      fillColor: zone.zoneColor,
      fillOpacity: 0.14
    }).addTo(trafficZoneLayer);

    zoneRect.bindPopup(`<strong>${zone.name}</strong><br>Nivel: ${zone.level}<br>${zone.reason}`);

    // Mapa rápido de color por placa
    const plateColorMap = new Map();
    zone.platesList.forEach(p => plateColorMap.set(p.placa, p.color));

    // 2. Pintar los clientes dentro de la zona coloreados según su Placa
    const visibleClients = filterPlate
      ? zone.clients.filter(c => c.placa === filterPlate)
      : zone.clients;

    const bounds = L.latLngBounds(zone.bounds);

    visibleClients.forEach(c => {
      const pColor = plateColorMap.get(c.placa) || "#8e24aa";
      const marker = L.circleMarker([c.lat, c.lng], {
        radius: 6.5,
        fillColor: pColor,
        color: "#ffffff",
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.95
      });

      marker.bindPopup(`
        <div style="font-family:'Inter',sans-serif; font-size:11px; line-height:1.4;">
          <strong>${c.cod} • ${c.nombre}</strong><br>
          <span style="display:inline-block; background:${pColor}; color:#fff; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:800; margin:2px 0;">Placa: ${c.placa}</span><br>
          <strong>Peso:</strong> ${c.kg.toFixed(1)} kg • <strong>Canal:</strong> ${c.canal}<br>
          <strong>Dir:</strong> ${c.direccion}
        </div>
      `);

      marker.addTo(trafficZoneLayer);
      bounds.extend([c.lat, c.lng]);
    });

    setTimeout(() => {
      trafficZoneMap.invalidateSize();
      trafficZoneMap.fitBounds(bounds, { padding: [25, 25], maxZoom: 14 });
    }, 260);
  }

  function openTrafficZoneDrawer(zoneId) {
    closeAllDrawers();
    const zone = currentTrafficStatsMap.get(zoneId);
    if (!zone) return;

    const lvlEl = document.getElementById("trfLevelBadge");
    lvlEl.textContent = `NIVEL ${zone.level}`;
    lvlEl.className = `traffic-level ${zone.cls}`;

    document.getElementById("trfPlatesCountBadge").textContent = `${zone.platesCount} placas involucradas`;
    document.getElementById("trfZoneTitle").textContent = zone.name;
    document.getElementById("trfZoneSub").textContent =
      `${zone.reason} • ${zone.clientCount} clientes (${(zone.totalKg / 1000).toFixed(2)} T)`;

    // Píldoras interactivas para filtrar por Placa en el mapa
    const pillsWrap = document.getElementById("trfPlateFilterPills");
    pillsWrap.innerHTML = `
      <button type="button" class="trf-plate-pill is-active" data-trf-plate="ALL">
        Todas (${zone.platesCount})
      </button>
      ${zone.platesList.map(p => `
        <button type="button" class="trf-plate-pill" data-trf-plate="${p.placa}">
          <i class="trf-plate-dot" style="background:${p.color};"></i>
          ${p.placa} (${p.clientCount})
        </button>
      `).join("")}
    `;

    pillsWrap.querySelectorAll(".trf-plate-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        pillsWrap.querySelectorAll(".trf-plate-pill").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const selPlate = btn.getAttribute("data-trf-plate");
        renderTrafficZoneMap(zone, selPlate === "ALL" ? null : selPlate);
      });
    });

    // Tabla de placas involucradas en esta zona vial
    document.getElementById("trfSummaryTag").textContent = `${zone.clientCount} entregas en zona`;
    const tbody = document.getElementById("trfPlatesTableBody");
    tbody.innerHTML = zone.platesList.map(p => `
      <tr>
        <td>
          <span style="display:inline-flex; align-items:center; gap:6px; font-weight:800;">
            <i class="trf-plate-dot" style="background:${p.color};"></i>
            ${p.placa}
          </span>
        </td>
        <td>${p.centro}</td>
        <td><strong>${p.clientCount}</strong> cli.</td>
        <td>${p.kg.toFixed(1)} kg</td>
        <td>
          <button type="button" class="radar-export-btn" data-open-unit="${p.unitKey}" style="padding:2px 8px; font-size:0.6rem;">
            Auditar placa
          </button>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll("button[data-open-unit]").forEach(btn => {
      btn.addEventListener("click", () => {
        openPlateDetailDrawer(btn.getAttribute("data-open-unit"));
      });
    });

    document.getElementById("plateDrawerBackdrop").classList.add("is-open");
    document.getElementById("trafficDetailDrawer").classList.add("is-open");

    renderTrafficZoneMap(zone, null);
  }

  function closeAllDrawers() {
    document.getElementById("plateDrawerBackdrop").classList.remove("is-open");
    document.getElementById("plateDetailDrawer").classList.remove("is-open");
    document.getElementById("trafficDetailDrawer").classList.remove("is-open");
  }

  /* ==========================================================================
     5. RENDERIZADO DE LAS 5 PESTAÑAS
     ========================================================================== */
  function renderAll() {
    const dq = auditDataQuality(allRows);
    const filteredRows = allRows.filter(r => {
      if (isFRT(r)) return false;
      if (state.selectedCenter !== "Todos" && cleanStr(r[IDX.CENTRO]) !== state.selectedCenter) return false;
      return true;
    });
    const op = analyzeOperation(filteredRows);

    lastAnalyzedClients = op.clients;
    currentUnitAuditsMap.clear();
    op.unitAudits.forEach(u => currentUnitAuditsMap.set(u.key, u));

    currentTrafficStatsMap.clear();
    op.trafficStats.forEach(z => currentTrafficStatsMap.set(z.id, z));

    renderTabRiesgo(op);
    renderTabVentanas(op);
    renderTabCalidad(dq, op);
    renderTabGeo(op);
    renderTabProductos(op);
  }

  function renderTabRiesgo({ unitAudits, allOutliers }) {
    const rojos     = unitAudits.filter(u => u.semaphore === "ROJO");
    const amarillos = unitAudits.filter(u => u.semaphore === "AMARILLO");
    const verdes    = unitAudits.filter(u => u.semaphore === "VERDE");
    const negros    = unitAudits.filter(u => u.semaphore === "NEGRO");

    const dispersedUnits = unitAudits.filter(u => u.isHighlyDispersed);
    const criticalUnits = [...rojos, ...amarillos, ...negros];
    const exposedKg = criticalUnits.reduce((s, u) => s + u.kg, 0);
    const exposedCli = criticalUnits.reduce((s, u) => s + u.clientCount, 0);

    document.getElementById("execRutasVal").textContent = `${unitAudits.length} placas`;
    document.getElementById("execRutasSub").textContent = `Centro: ${state.selectedCenter}`;

    document.getElementById("execIncVal").textContent = `${dispersedUnits.length} placas dispersas`;
    document.getElementById("execIncSub").textContent = `${allOutliers.length} clientes atípicos IQR detectados`;

    document.getElementById("execExpVal").textContent = `${(exposedKg / 1000).toFixed(1)} T`;
    document.getElementById("execExpSub").textContent = `${exposedCli} clientes en placas observadas`;

    document.getElementById("execSemaphoreCounts").innerHTML = `
      <span class="sem-dot sem-rojo" title="Rojo: Score >= 61">${rojos.length}</span>
      <span class="sem-dot sem-amarillo" title="Amarillo: Score 31 - 60">${amarillos.length}</span>
      <span class="sem-dot sem-verde" title="Verde: Score <= 30">${verdes.length}</span>
      <span class="sem-dot sem-negro" title="Negro: 100% sin coordenadas">${negros.length}</span>
    `;

    let sorted = [...unitAudits];
    if (state.riskSort === "risk") sorted.sort((a, b) => b.riskScore - a.riskScore || b.kg - a.kg);
    else if (state.riskSort === "disp") sorted.sort((a, b) => b.maxDiameterKm - a.maxDiameterKm || b.outliersCount - a.outliersCount);
    else if (state.riskSort === "outliers") sorted.sort((a, b) => b.outliersCount - a.outliersCount || b.maxDiameterKm - a.maxDiameterKm);
    else if (state.riskSort === "win") sorted.sort((a, b) => b.criticalWinCount - a.criticalWinCount || b.riskScore - a.riskScore);
    else if (state.riskSort === "kg") sorted.sort((a, b) => b.kg - a.kg);

    const tbody = document.getElementById("riskRadarBody");
    tbody.innerHTML = sorted.map((u, idx) => {
      const riskCls = u.riskScore >= 61 ? "risk-high" : u.riskScore >= 31 ? "risk-med" : "risk-low";
      const dispBadge = u.isHighlyDispersed
        ? `<strong style="color:#fca5a5;">${u.maxDiameterKm.toFixed(1)} km</strong>`
        : `${u.maxDiameterKm.toFixed(1)} km`;

      return `
        <tr data-unit-key="${u.key}">
          <td>#${idx + 1}</td>
          <td>${u.centro}</td>
          <td style="text-align:left; font-weight:800; color:#fff;">${u.placa}</td>
          <td>${u.clientCount}</td>
          <td>${u.kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg</td>
          <td><span class="badge-na">Pend. raw</span></td>
          <td>${dispBadge}</td>
          <td>${u.outliersCount > 0 ? `<strong style="color:#fca5a5;">${u.outliersCount}</strong>` : "0"}</td>
          <td>${u.criticalWinCount > 0 ? `<strong style="color:#fde047;">${u.criticalWinCount}</strong>` : "0"}</td>
          <td><span class="risk-pill ${riskCls}">${u.riskScore}/100</span></td>
          <td><span class="sem-dot ${u.semClass}">${u.semaphore}</span></td>
          <td>${u.finding}</td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("tr[data-unit-key]").forEach(tr => {
      tr.addEventListener("click", () => {
        openPlateDetailDrawer(tr.getAttribute("data-unit-key"));
      });
    });
  }

  function renderTabVentanas({ clients }) {
    const validWin  = clients.filter(c => c.win.status === "VALID");
    const narrowWin = validWin.filter(c => c.win.isNarrow);
    const earlyWin  = validWin.filter(c => c.win.isEarlyClose);
    const badOrMiss = clients.filter(c => c.win.status !== "VALID");
    const noChannelCount = clients.filter(c => c.canal === "OTRO").length;
    const totalExportable = clients.filter(c => c.win.status !== "VALID" || c.canal === "OTRO").length;

    document.getElementById("winValidVal").textContent  = `${validWin.length} / ${clients.length} cli.`;
    document.getElementById("winValidSub").textContent  = `${clients.length ? Math.round((validWin.length / clients.length) * 100) : 0}% con horario estructurado`;

    document.getElementById("winNarrowVal").textContent = `${narrowWin.length} clientes`;
    document.getElementById("winNarrowSub").textContent = `${(narrowWin.reduce((s, c) => s + c.kg, 0) / 1000).toFixed(1)} T en ventanas <= 2h`;

    document.getElementById("winEarlyVal").textContent  = `${earlyWin.length} clientes`;
    document.getElementById("winEarlySub").textContent  = `${(earlyWin.reduce((s, c) => s + c.kg, 0) / 1000).toFixed(1)} T con cierre <= 11:00 AM`;

    document.getElementById("winBadVal").textContent    = `${badOrMiss.length} sin VH / ${noChannelCount} Otros`;
    document.getElementById("winBadSub").textContent    = `${totalExportable} registros consolidados en CSV`;

    const bracketMap = new Map();
    clients.forEach(c => {
      const label = c.win.status === "VALID" ? `${c.win.startStr} - ${c.win.endStr}` : (c.win.raw || "Sin Ventana Informada");
      if (!bracketMap.has(label)) {
        bracketMap.set(label, {
          label,
          status: c.win.status,
          isNarrow: c.win.isNarrow,
          isEarlyClose: c.win.isEarlyClose,
          count: 0,
          kg: 0
        });
      }
      const b = bracketMap.get(label);
      b.count++;
      b.kg += c.kg;
    });

    const brackets = Array.from(bracketMap.values()).sort((a, b) => b.count - a.count);
    const maxB = Math.max(1, brackets[0]?.count || 1);

    document.getElementById("windowBracketsList").innerHTML = brackets.map(b => {
      const wPct = Math.round((b.count / maxB) * 100);
      const tag = b.status !== "VALID"
        ? `<span class="traffic-level lvl-critico">REVISAR</span>`
        : (b.isNarrow || b.isEarlyClose)
          ? `<span class="traffic-level lvl-alto">RESTRICTIVA</span>`
          : `<span class="traffic-level lvl-medio">ESTÁNDAR</span>`;

      return `
        <div class="sku-row-card">
          <div class="sku-row-top">
            <span class="sku-row-name">${b.label}</span>
            <div style="display:flex; align-items:center; gap:6px;">
              ${tag}
              <strong style="font-size:0.72rem; color:#18181b;">${b.count} cli.</strong>
            </div>
          </div>
          <div class="sku-bar-bg"><div class="sku-bar-fill" style="width:${wPct}%"></div></div>
          <div class="sku-row-sub">
            <span>Participación: ${clients.length ? ((b.count / clients.length) * 100).toFixed(1) : 0}% de cartera</span>
            <span>${(b.kg / 1000).toFixed(2)} T comprometidas</span>
          </div>
        </div>
      `;
    }).join("");

    const priorityClients = validWin
      .filter(c => c.win.isNarrow || c.win.isEarlyClose)
      .sort((a, b) => a.win.endMin - b.win.endMin || a.win.durationMin - b.win.durationMin);

    document.getElementById("priorityWindowsBody").innerHTML = priorityClients.length
      ? priorityClients.slice(0, 60).map(c => {
          const hrs = (c.win.durationMin / 60).toFixed(1);
          return `
            <tr>
              <td style="color:#fff; font-weight:700; max-width:165px; overflow:hidden; text-overflow:ellipsis;">${c.nombre}</td>
              <td>${c.centro}</td>
              <td style="text-align:left; font-weight:800; color:#fff;">${c.placa}</td>
              <td style="text-align:right; color:#fde047; font-weight:800;">${c.win.startStr} - ${c.win.endStr}</td>
              <td>${hrs} h</td>
              <td>${c.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</td>
            </tr>
          `;
        }).join("")
      : `<tr><td colspan="6" style="text-align:center; color:#a1a1aa; padding:16px;">No se detectaron ventanas restrictivas (&le;2h) ni cierres tempranos (&le;11:00) en este filtro.</td></tr>`;
  }

  function renderTabCalidad(dq, { unitAudits }) {
    document.getElementById("dqScoreBadge").textContent = `Integridad: ${dq.integrityPct}%`;

    document.getElementById("dataQualityList").innerHTML = dq.checks.map(chk => `
      <div class="dq-item dq-item--${chk.sev}">
        <div class="dq-top">
          <strong>${chk.title}</strong>
          <span class="dq-count">${chk.count} reg. (${chk.pct}%)</span>
        </div>
        <div class="dq-desc">${chk.desc}</div>
      </div>
    `).join("");

    const diffKg = Math.abs(dq.totalKgRaw - (dq.totalKgValid + dq.totalKgExcluded));
    document.getElementById("reconcilStatusBadge").textContent = diffKg < 0.01 ? "CONCILIACIÓN APROBADA" : "OBSERVADA";

    document.getElementById("reconciliationGrid").innerHTML = `
      <div class="rec-box"><span>Total Registros Raw</span><strong>${dq.total.toLocaleString("es-PE")} filas</strong></div>
      <div class="rec-box"><span>Registros Válidos / Excluidos</span><strong>${dq.validCount.toLocaleString("es-PE")} / ${dq.excludedCount}</strong></div>
      <div class="rec-box"><span>Peso Total Archivo Raw</span><strong>${dq.totalKgRaw.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</strong></div>
      <div class="rec-box"><span>Peso Válido Analizado</span><strong>${dq.totalKgValid.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</strong></div>
      <div class="rec-box"><span>Diferencia de Reconciliación</span><strong>${diffKg.toFixed(2)} kg</strong></div>
      <div class="rec-box"><span>Placas Evaluadas / Bloqueadas</span><strong>${unitAudits.filter(u => u.semaphore !== "NEGRO").length} / ${unitAudits.filter(u => u.semaphore === "NEGRO").length}</strong></div>
    `;

    document.getElementById("coverageLimitationsList").innerHTML = `
      <li><strong>Dispersión y Zonas Viales:</strong> Ambas vistas permiten abrir el mapa interactivo con los puntos exactos y polígonos críticos.</li>
      <li><strong>Regla de Semáforo:</strong> Rojo (&ge;61), Amarillo (31–60), Verde (&le;30) y Negro solo si 100% de clientes no tienen geoposición.</li>
      <li><strong>Bloqueado por dato faltante (1/6):</strong> Capacidad vehicular máxima por placa (pendiente raw) y hora de salida/secuencia.</li>
    `;
  }

  function renderTabGeo({ clients, allOutliers, rangeStats, trafficStats }) {
    document.getElementById("outliersCountTag").textContent = `${allOutliers.length} detectados`;

    const sortedOutliers = [...allOutliers].sort((a, b) => b.distToCentroid - a.distToCentroid);
    const outListEl = document.getElementById("geoOutliersList");
    outListEl.innerHTML = sortedOutliers.length
      ? sortedOutliers.map(o => `
          <div class="outlier-card" data-unit-key="${o.unitKey}" style="cursor:pointer;" title="Clic para abrir mapa de dispersión de la placa ${o.placa}">
            <div class="outlier-top">
              <strong>${o.nombre}</strong>
              <span class="traffic-level lvl-alto">+${o.distToCentroid.toFixed(1)} km</span>
            </div>
            <div class="outlier-sub">
              <span>${o.centro} • <b>${o.placa}</b> (Ver mapa)</span>
              <span>Umbral IQR: ${o.thresholdKm.toFixed(1)} km • ${o.kg.toFixed(1)} kg</span>
            </div>
          </div>
        `).join("")
      : `<div style="padding:12px; color:#71717a; font-size:0.75rem;">Ningún cliente supera el umbral relativo Q3 + 1.5×IQR en su unidad.</div>`;

    outListEl.querySelectorAll(".outlier-card[data-unit-key]").forEach(card => {
      card.addEventListener("click", () => {
        openPlateDetailDrawer(card.getAttribute("data-unit-key"));
      });
    });

    const totalCli = Math.max(1, clients.length);
    document.getElementById("kgRangesContainer").innerHTML = rangeStats.map(rng => {
      const pct = Math.round((rng.count / totalCli) * 100);
      const segsHtml = ["DET", "FSE", "MES", "MOD"].map(ch => {
        const w = rng.count > 0 ? (rng.byChannel[ch] / rng.count) * 100 : 0;
        return `<div class="radar-stacked-seg" style="width:${w}%; background:${CHANNEL_COLORS[ch]};"></div>`;
      }).join("");
      return `
        <div class="radar-range-row">
          <div class="radar-range-top">
            <strong>${rng.label}</strong>
            <span style="font-size:0.68rem; font-weight:700;">${rng.count} cli. (${pct}%) • ${(rng.totalKg / 1000).toFixed(1)} T</span>
          </div>
          <div class="radar-stacked-bar">${segsHtml}</div>
          <div class="radar-range-ch-detail">
            <span>DET: <b>${rng.byChannel.DET}</b> • FSE: <b>${rng.byChannel.FSE}</b> • MES: <b>${rng.byChannel.MES}</b> • MOD: <b>${rng.byChannel.MOD}</b></span>
          </div>
        </div>
      `;
    }).join("");

    // Renderizar tarjetas interactivas de Zonas de Complejidad Vial
    const trafficListEl = document.getElementById("trafficZonesList");
    trafficListEl.innerHTML = trafficStats.map(z => `
      <div class="radar-traffic-item" data-zone-id="${z.id}" title="Clic para abrir mapa de la zona y placas involucradas">
        <div class="radar-traffic-top">
          <strong>${z.name}</strong>
          <span class="traffic-level ${z.cls}">${z.level}</span>
        </div>
        <div class="radar-traffic-meta">
          <span>${z.reason}</span>
          <span><b>${z.clientCount}</b> cli. • <b>${(z.totalKg / 1000).toFixed(1)} T</b> • <b>${z.platesCount}</b> u.</span>
        </div>
      </div>
    `).join("");

    trafficListEl.querySelectorAll(".radar-traffic-item[data-zone-id]").forEach(card => {
      card.addEventListener("click", () => {
        openTrafficZoneDrawer(card.getAttribute("data-zone-id"));
      });
    });
  }

  function renderTabProductos({ clients, products }) {
    const totalCli = Math.max(1, clients.length);
    const byClients = [...products].sort((a, b) => b.clientCount - a.clientCount || b.kg - a.kg);
    const byKg      = [...products].sort((a, b) => b.kg - a.kg);
    const leastSold = [...products].filter(p => p.clientCount > 0).sort((a, b) => a.clientCount - b.clientCount || a.kg - b.kg);

    document.getElementById("prodTotalSkus").textContent = `${products.length} SKUs`;

    if (byClients[0]) {
      const cov = Math.round((byClients[0].clientCount / totalCli) * 100);
      document.getElementById("prodTopCliName").textContent = byClients[0].nombre;
      document.getElementById("prodTopCliSub").textContent  = `En ${byClients[0].clientCount} clientes (${cov}% cobertura) • ${byClients[0].kg.toFixed(0)} kg`;
    }
    if (byKg[0]) {
      document.getElementById("prodTopKgName").textContent = byKg[0].nombre;
      document.getElementById("prodTopKgSub").textContent  = `${(byKg[0].kg / 1000).toFixed(2)} T • ${byKg[0].clientCount} clientes`;
    }
    if (leastSold[0]) {
      document.getElementById("prodLowCliName").textContent = leastSold[0].nombre;
      document.getElementById("prodLowCliSub").textContent  = `Solo en ${leastSold[0].clientCount} cliente(s) • ${leastSold[0].kg.toFixed(1)} kg`;
    }

    const maxCliCount = Math.max(1, byClients[0]?.clientCount || 1);

    document.getElementById("topProductsList").innerHTML = byClients.slice(0, 18).map((p, i) => {
      const covPct = Math.round((p.clientCount / totalCli) * 100);
      const barW = Math.round((p.clientCount / maxCliCount) * 100);
      return `
        <div class="sku-row-card">
          <div class="sku-row-top">
            <span class="sku-row-name">#${i + 1} ${p.nombre}</span>
            <span style="font-weight:800; color:#6a1b9a; font-size:0.7rem;">${p.clientCount} cli. (${covPct}%)</span>
          </div>
          <div class="sku-bar-bg"><div class="sku-bar-fill" style="width:${barW}%"></div></div>
          <div class="sku-row-sub">
            <span>Cód: ${p.cod || "-"} • ${p.orderCount} pedidos</span>
            <span>${p.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg • S/ ${p.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</span>
          </div>
        </div>
      `;
    }).join("");

    document.getElementById("lowProductsList").innerHTML = leastSold.slice(0, 18).map((p, i) => {
      const covPct = ((p.clientCount / totalCli) * 100).toFixed(1);
      return `
        <div class="sku-row-card">
          <div class="sku-row-top">
            <span class="sku-row-name">#${i + 1} ${p.nombre}</span>
            <span style="font-weight:800; color:#fde047; font-size:0.7rem;">${p.clientCount} cli. (${covPct}%)</span>
          </div>
          <div class="sku-bar-bg"><div class="sku-bar-fill" style="width:${Math.max(5, Math.round((p.clientCount / maxCliCount) * 100))}%"></div></div>
          <div class="sku-row-sub">
            <span>Cód: ${p.cod || "-"} • ${p.orderCount} pedido(s)</span>
            <span>${p.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg • S/ ${p.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  function bindEvents() {
    document.querySelectorAll(".radar-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-tab-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const targetId = btn.getAttribute("data-tab");
        state.activeTab = targetId;
        document.querySelectorAll(".radar-pane").forEach(p => p.classList.remove("is-active"));
        document.getElementById(targetId)?.classList.add("is-active");
      });
    });

    document.querySelectorAll(".radar-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".radar-pill").forEach(p => p.classList.remove("is-active"));
        pill.classList.add("is-active");
        state.selectedCenter = pill.getAttribute("data-center");
        renderAll();
      });
    });

    document.querySelectorAll(".radar-sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-sort-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.riskSort = btn.getAttribute("data-sort");
        renderAll();
      });
    });

    document.getElementById("btnExportWinIssues").addEventListener("click", exportWindowIssuesCSV);

    document.getElementById("btnClosePlateDrawer").addEventListener("click", closeAllDrawers);
    document.getElementById("btnCloseTrafficDrawer").addEventListener("click", closeAllDrawers);
    document.getElementById("plateDrawerBackdrop").addEventListener("click", closeAllDrawers);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeAllDrawers();
    });
  }

  async function init() {
    try {
      const text = await loadCSVWithFallback();
      const { header, rows } = parseCSV(text);
      detectColumns(header);
      allRows = rows;
      bindEvents();
      renderAll();
    } catch (err) {
      console.error("Error inicializando Radar de Distribución:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
