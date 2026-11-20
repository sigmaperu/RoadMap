/* ==========================================================================
   RoadMap - radar.js (Radar de Distribución Multi-Pestaña • Productos, Flota, Rangos, Tráfico)
   ========================================================================== */

(() => {
  const FALLBACKS = [
    window.RoadMapConfig?.CSV_URL,
    './RoadMap.csv',
    './assets/data/RoadMap.csv',
    'https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv'
  ].filter(Boolean);

  // Coordenadas reales de los 3 Centros de Distribución (Región Lima)
  const CD_COORDS = {
    "0374-ATE":     { lat: -12.067013469355048, lng: -76.97943349160968 },
    "0780-ATE2":    { lat: -12.045124965310059, lng: -76.93813036277461 },
    "0754-CHANCAY": { lat: -11.551110366002629, lng: -77.27641679959045 }
  };

  // Corredores Viales de Lima Metropolitana y Norte Chico con historial de complejidad vial
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

  // Tramos de Peso (Drop Size por Cliente)
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

  // Índices base + detección automática de columnas de SKU/Producto
  let IDX = {
    CENTRO: 1, PLACA: 2, CLIENTE: 3, NOMBRE: 4, RUTA: 6, PEDIDO: 7,
    SKU_COD: 8, SKU_DESC: 9, KG: 10, SOLES: 11, DIRECCION: 15, LAT: 16, LNG: 17, CANAL: 19
  };

  function detectProductColumns(header) {
    if (!header || !header.length) return;
    header.forEach((h, i) => {
      const u = String(h).trim().toUpperCase();
      if (u.includes("MATERIAL") || u.includes("COD_PROD") || u === "SKU" || u === "CODIGO") {
        IDX.SKU_COD = i;
      }
      if (u.includes("DESCRIP") || u.includes("PRODUCTO") || u.includes("MATERIAL_DESC") || u === "ARTICULO") {
        IDX.SKU_DESC = i;
      }
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
    activeTab: "tab-flota",
    selectedCenter: "Todos",
    fleetSort: "dist",
    selectedRangeId: null,
    selectedTrafficId: null
  };

  function getFilteredRows() {
    return allRows.filter(r => {
      if (isFRT(r)) return false;
      if (state.selectedCenter !== "Todos" && cleanStr(r[IDX.CENTRO]) !== state.selectedCenter) return false;
      return true;
    });
  }

  /* ==========================================================================
     PROCESAMIENTO DE DATOS POR SEGMENTO
     ========================================================================== */
  function computeAnalytics(rows) {
    // 1. Clientes Únicos
    const clientsMap = new Map();
    rows.forEach(r => {
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

        clientsMap.set(cli, {
          cod: cli,
          nombre: cleanStr(r[IDX.NOMBRE]) || cli,
          centro,
          placa: upperStr(r[IDX.PLACA]),
          canal: normalizeChannelCode(r[IDX.CANAL]),
          lat, lng,
          distFromCd,
          kg: 0,
          soles: 0
        });
      }
      const cObj = clientsMap.get(cli);
      cObj.kg += kg;
      cObj.soles += soles;
    });
    const clients = Array.from(clientsMap.values());

    // 2. Mix de Productos (SKUs)
    const productsMap = new Map();
    rows.forEach(r => {
      const cod = cleanStr(r[IDX.SKU_COD]);
      const desc = cleanStr(r[IDX.SKU_DESC]);
      const key = desc || cod;
      if (!key) return;

      if (!productsMap.has(key)) {
        productsMap.set(key, {
          cod,
          nombre: desc || cod,
          clientesSet: new Set(),
          pedidosSet: new Set(),
          kg: 0,
          soles: 0
        });
      }
      const p = productsMap.get(key);
      const cli = cleanStr(r[IDX.CLIENTE]);
      const ped = cleanStr(r[IDX.PEDIDO]);
      if (cli) p.clientesSet.add(cli);
      if (ped) p.pedidosSet.add(ped);
      p.kg += toNum(r[IDX.KG]);
      p.soles += toNum(r[IDX.SOLES]);
    });

    const products = Array.from(productsMap.values()).map(p => ({
      ...p,
      clientCount: p.clientesSet.size,
      orderCount: p.pedidosSet.size
    }));

    // 3. Rangos de Peso (Kg)
    const rangeStats = WEIGHT_RANGES.map(rng => {
      const matching = clients.filter(c => {
        if (rng.min === 0) return c.kg >= 0 && c.kg <= rng.max;
        return c.kg > rng.min && c.kg <= rng.max;
      });
      const byChannel = { DET: 0, FSE: 0, MES: 0, MOD: 0 };
      matching.forEach(c => {
        if (byChannel[c.canal] !== undefined) byChannel[c.canal]++;
      });
      return {
        ...rng,
        count: matching.length,
        totalKg: matching.reduce((s, c) => s + c.kg, 0),
        byChannel,
        clients: matching
      };
    });

    // 4. Flota por Unidad (Llave compuesta CENTRO|PLACA)
    const fleetMap = new Map();
    rows.filter(r => !isTruckExcluded(r)).forEach(r => {
      const centro = cleanStr(r[IDX.CENTRO]);
      const placa = upperStr(r[IDX.PLACA]);
      const key = `${centro}|${placa}`;
      if (!fleetMap.has(key)) {
        fleetMap.set(key, {
          key,
          placa,
          centro,
          kg: 0,
          soles: 0,
          pedidosSet: new Set(),
          stopsMap: new Map()
        });
      }
      const u = fleetMap.get(key);
      u.kg += toNum(r[IDX.KG]);
      u.soles += toNum(r[IDX.SOLES]);
      const ped = cleanStr(r[IDX.PEDIDO]);
      if (ped) u.pedidosSet.add(ped);

      const cli = cleanStr(r[IDX.CLIENTE]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      if (cli && !isNaN(lat) && !isNaN(lng) && !u.stopsMap.has(cli)) {
        u.stopsMap.set(cli, { lat, lng });
      }
    });

    const fleetList = Array.from(fleetMap.values()).map(u => {
      const stops = Array.from(u.stopsMap.values());
      const cdPos = CD_COORDS[u.centro];
      let estRouteKm = 0;
      let maxRadiusKm = 0;

      if (cdPos && stops.length > 0) {
        const unvisited = [...stops];
        let curLat = cdPos.lat;
        let curLng = cdPos.lng;

        while (unvisited.length > 0) {
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let i = 0; i < unvisited.length; i++) {
            const dFromCd = haversineKm(cdPos.lat, cdPos.lng, unvisited[i].lat, unvisited[i].lng);
            if (dFromCd > maxRadiusKm) maxRadiusKm = dFromCd;

            const dStep = haversineKm(curLat, curLng, unvisited[i].lat, unvisited[i].lng);
            if (dStep < bestDist) {
              bestDist = dStep;
              bestIdx = i;
            }
          }
          estRouteKm += bestDist;
          curLat = unvisited[bestIdx].lat;
          curLng = unvisited[bestIdx].lng;
          unvisited.splice(bestIdx, 1);
        }
        estRouteKm = (estRouteKm + haversineKm(curLat, curLng, cdPos.lat, cdPos.lng)) * 1.28;
      }

      const clientCount = u.stopsMap.size || unique(rows.filter(r => cleanStr(r[IDX.CENTRO]) === u.centro && upperStr(r[IDX.PLACA]) === u.placa).map(r => r[IDX.CLIENTE])).length;
      const densityKgKm = estRouteKm > 0 ? (u.kg / estRouteKm) : 0;

      return {
        ...u,
        clientCount,
        orderCount: u.pedidosSet.size,
        estRouteKm,
        maxRadiusKm,
        densityKgKm
      };
    });

    // 5. Zonas Críticas de Tráfico
    const trafficStats = TRAFFIC_CORRIDORS.map(zone => {
      const zoneClients = clients.filter(c => !isNaN(c.lat) && !isNaN(c.lng) && zone.check(c.lat, c.lng));
      return {
        ...zone,
        clientCount: zoneClients.length,
        totalKg: zoneClients.reduce((s, c) => s + c.kg, 0),
        platesCount: new Set(zoneClients.map(c => c.placa)).size,
        clients: zoneClients
      };
    }).filter(z => z.clientCount > 0).sort((a, b) => b.clientCount - a.clientCount);

    return { clients, products, rangeStats, fleetList, trafficStats };
  }

  /* ==========================================================================
     RENDERIZADO POR PESTAÑA
     ========================================================================== */
  function renderAll() {
    const rows = getFilteredRows();
    const data = computeAnalytics(rows);

    renderTabFlota(data);
    renderTabProductos(data);
    renderTabRangos(data);
    renderTabTrafico(data);
  }

  // PESTAÑA 1: FLOTA & RECORRIDOS
  function renderTabFlota({ fleetList }) {
    const byDist = [...fleetList].sort((a, b) => b.estRouteKm - a.estRouteKm);
    const byKg   = [...fleetList].sort((a, b) => b.kg - a.kg);
    const byCli  = [...fleetList].sort((a, b) => b.clientCount - a.clientCount);
    const lowUnits = fleetList.filter(u => u.kg < 450);

    document.getElementById("flotaMaxDistVal").textContent = byDist[0] ? `${byDist[0].placa} • ${byDist[0].estRouteKm.toFixed(1)} km` : "–";
    document.getElementById("flotaMaxDistSub").textContent = byDist[0] ? `${byDist[0].centro} • Radio máx: ${byDist[0].maxRadiusKm.toFixed(1)} km` : "";

    document.getElementById("flotaMaxKgVal").textContent   = byKg[0] ? `${byKg[0].placa} • ${(byKg[0].kg / 1000).toFixed(2)} T` : "–";
    document.getElementById("flotaMaxKgSub").textContent   = byKg[0] ? `${byKg[0].centro} • ${byKg[0].clientCount} clientes` : "";

    document.getElementById("flotaMaxCliVal").textContent  = byCli[0] ? `${byCli[0].placa} • ${byCli[0].clientCount} cli.` : "–";
    document.getElementById("flotaMaxCliSub").textContent  = byCli[0] ? `${byCli[0].centro} • ${byCli[0].kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg` : "";

    document.getElementById("flotaLowCountVal").textContent = `${lowUnits.length} unidades`;
    document.getElementById("flotaLowCountSub").textContent = lowUnits.length ? `Ej: ${lowUnits.slice(0, 3).map(u => u.placa).join(", ")}` : "Toda la flota con carga óptima";

    let sorted = [...fleetList];
    if (state.fleetSort === "dist") sorted.sort((a, b) => b.estRouteKm - a.estRouteKm);
    else if (state.fleetSort === "kg") sorted.sort((a, b) => b.kg - a.kg);
    else if (state.fleetSort === "cli") sorted.sort((a, b) => b.clientCount - a.clientCount);
    else if (state.fleetSort === "dens") sorted.sort((a, b) => b.densityKgKm - a.densityKgKm);
    else if (state.fleetSort === "low") sorted.sort((a, b) => a.kg - b.kg);

    const tbody = document.getElementById("fleetRadarBody");
    tbody.innerHTML = sorted.map((u, idx) => {
      const isLow = u.kg < 450;
      return `
        <tr>
          <td>#${idx + 1}</td>
          <td>${u.placa}</td>
          <td style="text-align:left; color:#e1bee7; font-weight:600;">${u.centro}</td>
          <td>${u.clientCount}</td>
          <td>${u.orderCount}</td>
          <td>${isLow ? `<span class="badge-warn-low">${u.kg.toFixed(0)} kg</span>` : `${u.kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg`}</td>
          <td>S/ ${u.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</td>
          <td><strong>${u.estRouteKm.toFixed(1)} km</strong></td>
          <td>${u.maxRadiusKm.toFixed(1)} km</td>
          <td>${u.densityKgKm.toFixed(1)} kg/km</td>
        </tr>
      `;
    }).join("");
  }

  // PESTAÑA 2: MIX DE PRODUCTOS (SKUs)
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

    // Top 15 más vendidos (por cobertura de clientes)
    document.getElementById("topProductsList").innerHTML = byClients.slice(0, 15).map((p, i) => {
      const covPct = Math.round((p.clientCount / totalCli) * 100);
      const barW = Math.round((p.clientCount / maxCliCount) * 100);
      return `
        <div class="sku-row-card">
          <div class="sku-row-top">
            <span class="sku-row-name">#${i + 1} ${p.nombre}</span>
            <span class="sku-row-metrics">${p.clientCount} cli. (${covPct}%)</span>
          </div>
          <div class="sku-bar-bg"><div class="sku-bar-fill" style="width:${barW}%"></div></div>
          <div class="sku-row-sub">
            <span>Cód: ${p.cod || "-"} • ${p.orderCount} pedidos</span>
            <span>${p.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg • S/ ${p.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</span>
          </div>
        </div>
      `;
    }).join("");

    // Top 15 menos vendidos (oportunidades de impulsar venta)
    document.getElementById("lowProductsList").innerHTML = leastSold.slice(0, 15).map((p, i) => {
      const covPct = ((p.clientCount / totalCli) * 100).toFixed(1);
      return `
        <div class="sku-row-card">
          <div class="sku-row-top">
            <span class="sku-row-name">#${i + 1} ${p.nombre}</span>
            <span class="sku-row-metrics">${p.clientCount} cli. (${covPct}%)</span>
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

  // PESTAÑA 3: RANGOS DE PESO & CLIENTES
  function renderTabRangos({ clients, rangeStats }) {
    const container = document.getElementById("kgRangesContainer");
    const btnReset  = document.getElementById("btnResetRangeFilter");
    btnReset.classList.toggle("is-hidden", !state.selectedRangeId);

    const totalCli = Math.max(1, clients.length);

    container.innerHTML = "";
    rangeStats.forEach(rng => {
      const pct = Math.round((rng.count / totalCli) * 100);
      const isSel = state.selectedRangeId === rng.id;

      const segsHtml = ["DET", "FSE", "MES", "MOD"].map(ch => {
        const w = rng.count > 0 ? (rng.byChannel[ch] / rng.count) * 100 : 0;
        return `<div class="radar-stacked-seg" style="width:${w}%; background:${CHANNEL_COLORS[ch]};"></div>`;
      }).join("");

      const row = document.createElement("div");
      row.className = `radar-range-row ${isSel ? "is-selected" : ""}`;
      row.innerHTML = `
        <div class="radar-range-top">
          <strong>${rng.label}</strong>
          <div class="radar-range-stats">
            <span>${rng.count} clientes</span>
            <span>${(rng.totalKg / 1000).toFixed(1)} T</span>
            <span class="radar-range-pct">${pct}%</span>
          </div>
        </div>
        <div class="radar-stacked-bar">${segsHtml}</div>
        <div class="radar-range-ch-detail">
          <span>DET: <b>${rng.byChannel.DET}</b> • FSE: <b>${rng.byChannel.FSE}</b> • MES: <b>${rng.byChannel.MES}</b> • MOD: <b>${rng.byChannel.MOD}</b></span>
          <span>Prom: ${rng.count ? (rng.totalKg / rng.count).toFixed(1) : 0} kg/cli</span>
        </div>
      `;
      row.addEventListener("click", () => {
        state.selectedRangeId = (state.selectedRangeId === rng.id) ? null : rng.id;
        renderTabRangos({ clients, rangeStats });
      });
      container.appendChild(row);
    });

    // Tabla derecha de clientes del rango seleccionado (o todos)
    let listClients = [...clients];
    const titleEl = document.getElementById("rangeDetailTitle");
    const subEl   = document.getElementById("rangeDetailSub");

    if (state.selectedRangeId) {
      const found = rangeStats.find(r => r.id === state.selectedRangeId);
      listClients = found ? [...found.clients] : [];
      titleEl.textContent = `Clientes en Rango: ${found?.label || ""}`;
      subEl.textContent   = `${listClients.length} puntos de venta en este tramo`;
    } else {
      titleEl.textContent = "Todos los Clientes (Top por Peso)";
      subEl.textContent   = "Haz clic en un rango a la izquierda para filtrar";
    }

    listClients.sort((a, b) => b.kg - a.kg);
    document.getElementById("rangeClientsBody").innerHTML = listClients.slice(0, 60).map(c => {
      const chColor = CHANNEL_COLORS[c.canal] || "#a1a1aa";
      return `
        <tr>
          <td style="color:#fff; font-weight:700; max-width:170px; overflow:hidden; text-overflow:ellipsis;">${c.nombre}</td>
          <td style="text-align:left;"><span style="color:${chColor}; font-weight:800;">● ${c.canal}</span></td>
          <td>${c.placa}</td>
          <td>${c.distFromCd.toFixed(1)} km</td>
          <td><strong>${c.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</strong></td>
          <td>S/ ${c.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</td>
        </tr>
      `;
    }).join("");
  }

  // PESTAÑA 4: ZONAS CRÍTICAS & TRÁFICO VIAL
  function renderTabTrafico({ trafficStats }) {
    const listEl = document.getElementById("trafficZonesList");
    listEl.innerHTML = "";

    if (!trafficStats.length) {
      listEl.innerHTML = `<div style="padding:14px; color:#71717a; font-size:0.78rem;">No se detectaron entregas en corredores críticos para este filtro.</div>`;
      document.getElementById("trafficClientsBody").innerHTML = "";
      return;
    }

    // Si no hay zona seleccionada o ya no existe en el filtro actual, seleccionar la primera
    if (!state.selectedTrafficId || !trafficStats.some(z => z.id === state.selectedTrafficId)) {
      state.selectedTrafficId = trafficStats[0].id;
    }

    trafficStats.forEach(z => {
      const isSel = z.id === state.selectedTrafficId;
      const div = document.createElement("div");
      div.className = `radar-traffic-item ${isSel ? "is-selected" : ""}`;
      div.innerHTML = `
        <div class="radar-traffic-top">
          <strong>${z.name}</strong>
          <span class="traffic-level ${z.cls}">${z.level}</span>
        </div>
        <div class="radar-traffic-meta">
          <span>${z.reason}</span>
          <span><b>${z.clientCount}</b> cli. • <b>${(z.totalKg / 1000).toFixed(1)} T</b> • <b>${z.platesCount}</b> u.</span>
        </div>
      `;
      div.addEventListener("click", () => {
        state.selectedTrafficId = z.id;
        renderTabTrafico({ trafficStats });
      });
      listEl.appendChild(div);
    });

    const activeZone = trafficStats.find(z => z.id === state.selectedTrafficId) || trafficStats[0];
    document.getElementById("trafficDetailTitle").textContent = activeZone.name;
    document.getElementById("trafficDetailSub").textContent   = `${activeZone.clientCount} entregas programadas • ${activeZone.platesCount} unidades involucradas`;
    document.getElementById("trafficZoneBadge").textContent   = activeZone.level;

    const zClients = [...activeZone.clients].sort((a, b) => b.kg - a.kg);
    document.getElementById("trafficClientsBody").innerHTML = zClients.slice(0, 60).map(c => {
      const chColor = CHANNEL_COLORS[c.canal] || "#a1a1aa";
      return `
        <tr>
          <td style="color:#fff; font-weight:700; max-width:180px; overflow:hidden; text-overflow:ellipsis;">${c.nombre}</td>
          <td style="text-align:left;"><span style="color:${chColor}; font-weight:800;">● ${c.canal}</span></td>
          <td style="text-align:left; color:#e1bee7;">${c.centro}</td>
          <td>${c.placa}</td>
          <td><strong>${c.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</strong></td>
        </tr>
      `;
    }).join("");
  }

  /* ==========================================================================
     EVENTOS DE NAVEGACIÓN POR PESTAÑAS Y FILTROS
     ========================================================================== */
  function bindEvents() {
    // Cambio de pestaña
    document.querySelectorAll(".radar-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-tab-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");

        const targetId = btn.getAttribute("data-tab");
        state.activeTab = targetId;

        document.querySelectorAll(".radar-pane").forEach(pane => pane.classList.remove("is-active"));
        const targetPane = document.getElementById(targetId);
        if (targetPane) targetPane.classList.add("is-active");
      });
    });

    // Filtro por Centro
    document.querySelectorAll(".radar-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".radar-pill").forEach(p => p.classList.remove("is-active"));
        pill.classList.add("is-active");
        state.selectedCenter = pill.getAttribute("data-center");
        renderAll();
      });
    });

    // Ordenamiento de flota
    document.querySelectorAll(".radar-sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-sort-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.fleetSort = btn.getAttribute("data-sort");
        renderAll();
      });
    });

    // Limpiar filtro de rango
    document.getElementById("btnResetRangeFilter").addEventListener("click", () => {
      state.selectedRangeId = null;
      renderAll();
    });
  }

  async function init() {
    try {
      const text = await loadCSVWithFallback();
      const { header, rows } = parseCSV(text);
      detectProductColumns(header);
      allRows = rows;
      bindEvents();
      renderAll();
    } catch (err) {
      console.error("Error inicializando Radar de Distribución:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
