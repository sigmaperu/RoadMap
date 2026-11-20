/* ==========================================================================
   RoadMap - radar.js (Auditoría Preventiva por Placa + Ventanas Horarias)
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

  // Corredores Viales Críticos (Lima Metropolitana & Norte Chico)
  const TRAFFIC_CORRIDORS = [
    {
      id: "CARRETERA_CENTRAL",
      name: "Eje Carretera Central / Ate - Sta. Anita",
      level: "CRÍTICO",
      cls: "lvl-critico",
      reason: "Obras Línea 2 + transporte pesado",
      check: (lat, lng) => lat >= -12.085 && lat <= -12.005 && lng >= -76.985 && lng <= -76.820
    },
    {
      id: "CENTRO_HISTORICO",
      name: "Centro Histórico / Abancay - Grau - La Victoria",
      level: "CRÍTICO",
      cls: "lvl-critico",
      reason: "Congestión comercial y restricción horaria",
      check: (lat, lng) => lat >= -12.085 && lat <= -12.035 && lng >= -77.055 && lng <= -77.005
    },
    {
      id: "PANAMERICANA_NORTE",
      name: "Panamericana Norte / Puente Piedra - Ancón",
      level: "ALTO",
      cls: "lvl-alto",
      reason: "Cuellos de botella en óvalos y peajes",
      check: (lat, lng) => lat >= -11.980 && lat <= -11.720 && lng >= -77.180 && lng <= -77.030
    },
    {
      id: "VIA_EXPRESA_FINANCIERO",
      name: "Eje Javier Prado / San Isidro - Surquillo",
      level: "ALTO",
      cls: "lvl-alto",
      reason: "Alta densidad vehicular en hora punta",
      check: (lat, lng) => lat >= -12.125 && lat <= -12.080 && lng >= -77.055 && lng <= -76.985
    },
    {
      id: "CALLAO_PUERTO",
      name: "Eje Av. Argentina / Faucett - Callao",
      level: "ALTO",
      cls: "lvl-alto",
      reason: "Flujo de contenedores y carga portuaria",
      check: (lat, lng) => lat >= -12.075 && lat <= -11.990 && lng >= -77.150 && lng <= -77.075
    },
    {
      id: "CONO_SUR",
      name: "Panamericana Sur / SJM - VMT - VES",
      level: "MEDIO",
      cls: "lvl-medio",
      reason: "Tráfico interdistrital y mercados zonales",
      check: (lat, lng) => lat >= -12.260 && lat <= -12.130 && lng >= -77.020 && lng <= -76.900
    },
    {
      id: "NORTE_CHICO",
      name: "Corredor Chancay - Huaral - Huacho",
      level: "MEDIO",
      cls: "lvl-medio",
      reason: "Tramos interurbanos y desvíos portuarios",
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

  // Parser de Ventana Horaria ("08:00 - 12:00", "08:00 a 13:00", etc.)
  function parseTimeWindow(rawWin) {
    const raw = String(rawWin ?? "").trim();
    if (!raw) return { raw, status: "MISSING", startMin: null, endMin: null, durationMin: 0 };

    const matches = raw.match(/(\d{1,2}):(\d{2})/g);
    if (!matches || matches.length < 2) {
      return { raw, status: "INVALID_FORMAT", startMin: null, endMin: null, durationMin: 0 };
    }

    const toMins = hhmm => {
      const [h, m] = hhmm.split(":").map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) return null;
      return h * 60 + m;
    };

    const startMin = toMins(matches[0]);
    const endMin   = toMins(matches[1]);
    if (startMin === null || endMin === null) {
      return { raw, status: "INVALID_TIME", startMin: null, endMin: null, durationMin: 0 };
    }
    if (startMin >= endMin) {
      return { raw, status: "REVERSED", startMin, endMin, durationMin: endMin - startMin };
    }

    const durationMin = endMin - startMin;
    const isNarrow = durationMin <= 120; // <= 2 horas
    const isEarlyClose = endMin <= 11 * 60; // Cierra <= 11:00 AM

    return {
      raw,
      status: "VALID",
      startStr: matches[0],
      endStr: matches[1],
      startMin,
      endMin,
      durationMin,
      isNarrow,
      isEarlyClose
    };
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
    SKU_COD: 8, SKU_DESC: 9, KG: 10, SOLES: 11, DIRECCION: 15, LAT: 16, LNG: 17,
    VENTANA: 18, CANAL: 19
  };

  function detectColumns(header) {
    if (!header || !header.length) return;
    header.forEach((h, i) => {
      const u = String(h).trim().toUpperCase();
      if (u.includes("MATERIAL") || u.includes("COD_PROD") || u === "SKU") IDX.SKU_COD = i;
      if (u.includes("DESCRIP") || u.includes("PRODUCTO") || u === "ARTICULO") IDX.SKU_DESC = i;
      if (u.includes("VENTANA") || u.includes("HORARIO")) IDX.VENTANA = i;
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
  const unique = arr => Array.from(new Set(arr.filter(v => v !== "" && v != null)));

  let allRows = [];
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
      return isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0 || lat < -13.5 || lat > -10.5 || lng < -78.0 || lng > -75.5;
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
     2. MOTOR ANALÍTICO CONCENTRADO POR PLACA / CENTRO
     ========================================================================== */
  function analyzeOperation(filteredRows) {
    const clientsMap = new Map();
    filteredRows.forEach(r => {
      const cli = cleanStr(r[IDX.CLIENTE]);
      if (!cli) return;
      const centro = cleanStr(r[IDX.CENTRO]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      const kg = toNum(r[IDX.KG]);
      const soles = toNum(r[IDX.SOLES]);

      if (!clientsMap.has(cli)) {
        const cdPos = CD_COORDS[centro];
        const distFromCd = (!isNaN(lat) && !isNaN(lng) && cdPos)
          ? haversineKm(cdPos.lat, cdPos.lng, lat, lng)
          : 0;
        const winParsed = parseTimeWindow(r[IDX.VENTANA]);

        clientsMap.set(cli, {
          cod: cli,
          nombre: cleanStr(r[IDX.NOMBRE]) || cli,
          centro,
          placa: upperStr(r[IDX.PLACA]),
          canal: normalizeChannelCode(r[IDX.CANAL]),
          lat, lng,
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

    // Agrupación directa por Centro + Placa (Sin fragmentar por ruta comercial)
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
            canal: normalizeChannelCode(r[IDX.CANAL]),
            win: parseTimeWindow(r[IDX.VENTANA]),
            lat, lng,
            kg: 0
          });
        }
        unit.stopsMap.get(cli).kg += toNum(r[IDX.KG]);
      }
    });

    const allOutliers = [];

    const unitAudits = Array.from(unitsMap.values()).map(unit => {
      const stops = Array.from(unit.stopsMap.values());
      const validStops = stops.filter(s => !isNaN(s.lat) && !isNaN(s.lng) && s.lat !== 0 && s.lng !== 0);
      const missingCoordsCount = stops.length - validStops.length;

      // Análisis estructural de ventanas por placa
      const criticalWinStops = stops.filter(s => s.win.status === "VALID" && (s.win.isNarrow || s.win.isEarlyClose));
      const invalidWinStops  = stops.filter(s => s.win.status === "REVERSED" || s.win.status === "INVALID_FORMAT" || s.win.status === "INVALID_TIME");

      // Centroide e IQR geográfico de la placa
      let centLat = 0, centLng = 0;
      if (validStops.length > 0) {
        centLat = validStops.reduce((s, p) => s + p.lat, 0) / validStops.length;
        centLng = validStops.reduce((s, p) => s + p.lng, 0) / validStops.length;
      }

      const distsToCentroid = validStops.map(s => ({
        ...s,
        distToCentroid: haversineKm(centLat, centLng, s.lat, s.lng)
      }));
      const sortedDists = distsToCentroid.map(d => d.distToCentroid).sort((a, b) => a - b);
      const q1 = getQuantile(sortedDists, 0.25);
      const q3 = getQuantile(sortedDists, 0.75);
      const iqr = q3 - q1;
      const outlierThreshold = Math.max(4.5, q3 + 1.5 * iqr);

      const unitOutliers = distsToCentroid.filter(d => validStops.length >= 4 && d.distToCentroid > outlierThreshold);
      unitOutliers.forEach(o => {
        allOutliers.push({
          ...o,
          centro: unit.centro,
          placa: unit.placa,
          thresholdKm: outlierThreshold
        });
      });

      // Distancia lineal acumulada desde CD
      const cdPos = CD_COORDS[unit.centro];
      let linearRouteKm = 0;
      if (cdPos && validStops.length > 0) {
        const unvisited = [...validStops];
        let curLat = cdPos.lat;
        let curLng = cdPos.lng;
        while (unvisited.length > 0) {
          let bestIdx = 0, bestD = Infinity;
          for (let i = 0; i < unvisited.length; i++) {
            const d = haversineKm(curLat, curLng, unvisited[i].lat, unvisited[i].lng);
            if (d < bestD) { bestD = d; bestIdx = i; }
          }
          linearRouteKm += bestD;
          curLat = unvisited[bestIdx].lat;
          curLng = unvisited[bestIdx].lng;
          unvisited.splice(bestIdx, 1);
        }
        linearRouteKm += haversineKm(curLat, curLng, cdPos.lat, cdPos.lng);
      }

      const maxClientKg = stops.reduce((m, s) => Math.max(m, s.kg), 0);
      const maxClientShare = unit.kg > 0 ? (maxClientKg / unit.kg) * 100 : 0;

      // ======================================================================
      // PLANNING RISK SCORE (0-100) POR PLACA CON 5 DIMENSIONES ACTIVAS:
      // Geografía: 33% | Ventanas Horarias: 33% | Complejidad/Canal: 14%
      // Balance Carga: 12% | Calidad de Datos: 8%
      // ======================================================================
      const geoScore  = Math.min(100, (unitOutliers.length * 32) + (linearRouteKm > 65 ? 25 : 0));
      const winScore  = Math.min(100, (criticalWinStops.length * 18) + (invalidWinStops.length * 45));
      const compScore = Math.min(100, (stops.length > 35 ? 45 : stops.length > 25 ? 25 : 10) + (unit.channelsSet.size >= 3 ? 25 : 0));
      const balScore  = Math.min(100, (unit.kg < 400 ? 65 : 0) + (maxClientShare > 50 ? 35 : 0));
      const dqScore   = Math.min(100, (missingCoordsCount * 40) + (invalidWinStops.length * 35));

      const riskScore = Math.round(
        (geoScore  * 0.33) +
        (winScore  * 0.33) +
        (compScore * 0.14) +
        (balScore  * 0.12) +
        (dqScore   * 0.08)
      );

      let semaphore = "VERDE";
      let semClass = "sem-verde";
      if ((missingCoordsCount > 0 && validStops.length === 0) || invalidWinStops.length > 0) {
        semaphore = "NEGRO";
        semClass = "sem-negro";
      } else if (riskScore >= 61 || unitOutliers.length >= 2 || criticalWinStops.length >= 5) {
        semaphore = "ROJO";
        semClass = "sem-rojo";
      } else if (riskScore >= 31 || unitOutliers.length === 1 || criticalWinStops.length >= 2 || unit.kg < 400) {
        semaphore = "AMARILLO";
        semClass = "sem-amarillo";
      }

      let finding = "Sin anomalías geográficas ni ventanas críticas.";
      if (invalidWinStops.length > 0) {
        finding = `${invalidWinStops.length} ventana(s) inválida(s) → Corregir horario antes de liberar.`;
      } else if (missingCoordsCount > 0) {
        finding = `${missingCoordsCount} cliente(s) sin coordenada válida → Corregir Lat/Lng.`;
      } else if (unitOutliers.length > 0 && criticalWinStops.length > 0) {
        finding = `${unitOutliers.length} atípico(s) geo + ${criticalWinStops.length} ventana(s) restrictiva(s) → Priorizar salida y evaluar traslado.`;
      } else if (criticalWinStops.length >= 3) {
        finding = `${criticalWinStops.length} clientes con cierre temprano/ventana estrecha → Atender primero.`;
      } else if (unitOutliers.length > 0) {
        finding = `${unitOutliers.length} cliente(s) alejado(s) > ${outlierThreshold.toFixed(1)} km del centroide → Evaluar reasignación.`;
      } else if (unit.kg < 400) {
        finding = `Carga baja (${unit.kg.toFixed(0)} kg) → Evaluar consolidación con unidad cercana.`;
      }

      return {
        ...unit,
        clientCount: stops.length,
        orderCount: unit.pedidosSet.size,
        linearRouteKm,
        outliersCount: unitOutliers.length,
        criticalWinCount: criticalWinStops.length,
        invalidWinCount: invalidWinStops.length,
        missingCoordsCount,
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

    // Tráfico vial
    const trafficStats = TRAFFIC_CORRIDORS.map(zone => {
      const zClients = clients.filter(c => !isNaN(c.lat) && !isNaN(c.lng) && zone.check(c.lat, c.lng));
      return {
        ...zone,
        clientCount: zClients.length,
        totalKg: zClients.reduce((s, c) => s + c.kg, 0),
        platesCount: new Set(zClients.map(c => c.placa)).size
      };
    }).filter(z => z.clientCount > 0).sort((a, b) => b.clientCount - a.clientCount);

    return { clients, unitAudits, allOutliers, products, rangeStats, trafficStats };
  }

  /* ==========================================================================
     3. RENDERIZADO DE LAS 5 PESTAÑAS
     ========================================================================== */
  function renderAll() {
    const dq = auditDataQuality(allRows);
    const filteredRows = allRows.filter(r => {
      if (isFRT(r)) return false;
      if (state.selectedCenter !== "Todos" && cleanStr(r[IDX.CENTRO]) !== state.selectedCenter) return false;
      return true;
    });
    const op = analyzeOperation(filteredRows);

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

    const criticalUnits = [...rojos, ...amarillos, ...negros];
    const exposedKg = criticalUnits.reduce((s, u) => s + u.kg, 0);
    const exposedCli = criticalUnits.reduce((s, u) => s + u.clientCount, 0);

    document.getElementById("execRutasVal").textContent = `${unitAudits.length} placas`;
    document.getElementById("execRutasSub").textContent = `Centro: ${state.selectedCenter}`;

    document.getElementById("execIncVal").textContent = `${criticalUnits.length} placas observadas`;
    document.getElementById("execIncSub").textContent = `${allOutliers.length} atípicos IQR • ${unitAudits.reduce((s, u) => s + u.criticalWinCount, 0)} vent. crít.`;

    document.getElementById("execExpVal").textContent = `${(exposedKg / 1000).toFixed(1)} T`;
    document.getElementById("execExpSub").textContent = `${exposedCli} clientes comprometidos`;

    document.getElementById("execSemaphoreCounts").innerHTML = `
      <span class="sem-dot sem-rojo" title="Rojas (Alto/Crítico)">${rojos.length}</span>
      <span class="sem-dot sem-amarillo" title="Amarillas (Revisión)">${amarillos.length}</span>
      <span class="sem-dot sem-verde" title="Verdes (Sin alertas)">${verdes.length}</span>
      <span class="sem-dot sem-negro" title="Negras (Info insuficiente/inválida)">${negros.length}</span>
    `;

    let sorted = [...unitAudits];
    if (state.riskSort === "risk") sorted.sort((a, b) => b.riskScore - a.riskScore || b.kg - a.kg);
    else if (state.riskSort === "win") sorted.sort((a, b) => b.criticalWinCount - a.criticalWinCount || b.riskScore - a.riskScore);
    else if (state.riskSort === "outliers") sorted.sort((a, b) => b.outliersCount - a.outliersCount || b.riskScore - a.riskScore);
    else if (state.riskSort === "kg") sorted.sort((a, b) => b.kg - a.kg);

    document.getElementById("riskRadarBody").innerHTML = sorted.map((u, idx) => {
      const riskCls = u.riskScore >= 61 ? "risk-high" : u.riskScore >= 31 ? "risk-med" : "risk-low";
      return `
        <tr>
          <td>#${idx + 1}</td>
          <td>${u.centro}</td>
          <td style="text-align:left; font-weight:800; color:#fff;">${u.placa}</td>
          <td>${u.clientCount}</td>
          <td>${u.orderCount}</td>
          <td>${u.kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg</td>
          <td><span class="badge-na">Pend. raw</span></td>
          <td>${u.linearRouteKm.toFixed(1)} km</td>
          <td>${u.criticalWinCount > 0 ? `<strong style="color:#fde047;">${u.criticalWinCount}</strong>` : "0"}</td>
          <td>${u.outliersCount > 0 ? `<strong style="color:#fca5a5;">${u.outliersCount}</strong>` : "0"}</td>
          <td><span class="risk-pill ${riskCls}">${u.riskScore}/100</span></td>
          <td><span class="sem-dot ${u.semClass}">${u.semaphore}</span></td>
          <td>${u.finding}</td>
        </tr>
      `;
    }).join("");
  }

  function renderTabVentanas({ clients }) {
    const validWin  = clients.filter(c => c.win.status === "VALID");
    const narrowWin = validWin.filter(c => c.win.isNarrow);
    const earlyWin  = validWin.filter(c => c.win.isEarlyClose);
    const badOrMiss = clients.filter(c => c.win.status !== "VALID");

    document.getElementById("winValidVal").textContent  = `${validWin.length} / ${clients.length} cli.`;
    document.getElementById("winValidSub").textContent  = `${clients.length ? Math.round((validWin.length / clients.length) * 100) : 0}% con horario estructurado`;

    document.getElementById("winNarrowVal").textContent = `${narrowWin.length} clientes`;
    document.getElementById("winNarrowSub").textContent = `${(narrowWin.reduce((s, c) => s + c.kg, 0) / 1000).toFixed(1)} T en ventanas <= 2h`;

    document.getElementById("winEarlyVal").textContent  = `${earlyWin.length} clientes`;
    document.getElementById("winEarlySub").textContent  = `${(earlyWin.reduce((s, c) => s + c.kg, 0) / 1000).toFixed(1)} T con cierre <= 11:00 AM`;

    document.getElementById("winBadVal").textContent    = `${badOrMiss.length} registros`;
    document.getElementById("winBadSub").textContent    = `Sin dato o formato inválido`;

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
      <li><strong>Granularidad:</strong> Línea de pedido/producto consolidada por Centro y Placa.</li>
      <li><strong>Dimensiones Evaluadas (5/6):</strong> Calidad de datos, Geografía (Haversine + IQR), Ventanas Horarias, Complejidad/Canal y Balance de carga.</li>
      <li><strong>Bloqueado por dato faltante (1/6):</strong> Capacidad vehicular máxima por placa (pendiente raw) y hora de salida/secuencia para simulación dinámica de llegada.</li>
    `;
  }

  function renderTabGeo({ clients, allOutliers, rangeStats, trafficStats }) {
    document.getElementById("outliersCountTag").textContent = `${allOutliers.length} detectados`;

    const sortedOutliers = [...allOutliers].sort((a, b) => b.distToCentroid - a.distToCentroid);
    document.getElementById("geoOutliersList").innerHTML = sortedOutliers.length
      ? sortedOutliers.map(o => `
          <div class="outlier-card">
            <div class="outlier-top">
              <strong>${o.nombre}</strong>
              <span class="traffic-level lvl-alto">+${o.distToCentroid.toFixed(1)} km</span>
            </div>
            <div class="outlier-sub">
              <span>${o.centro} • ${o.placa}</span>
              <span>Umbral IQR: ${o.thresholdKm.toFixed(1)} km • ${o.kg.toFixed(1)} kg</span>
            </div>
          </div>
        `).join("")
      : `<div style="padding:12px; color:#71717a; font-size:0.75rem;">Ningún cliente supera el umbral relativo Q3 + 1.5×IQR en su unidad.</div>`;

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

    document.getElementById("trafficZonesList").innerHTML = trafficStats.map(z => `
      <div class="radar-traffic-item">
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
