/* ==========================================================================
   RoadMap - radar.js (Inteligencia de Ruteo, Distancias, Rangos Kg y Tráfico)
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
    { id: "0-1",     label: "0 a 1 kg",      min: 0,   max: 1 },
    { id: "1-5",     label: "1 a 5 kg",      min: 1,   max: 5 },
    { id: "5-10",    label: "5 a 10 kg",     min: 5,   max: 10 },
    { id: "10-50",   label: "10 a 50 kg",    min: 10,  max: 50 },
    { id: "50-100",  label: "50 a 100 kg",   min: 50,  max: 100 },
    { id: "100-200", label: "100 a 200 kg",  min: 100, max: 200 },
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

  // Fórmula de Haversine para distancia real en Km entre dos coordenadas
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
    if (!lines.length) return [];
    return lines.slice(1).map(line => {
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
  }

  const IDX = {
    CENTRO: 1, PLACA: 2, CLIENTE: 3, NOMBRE: 4, RUTA: 6, PEDIDO: 7,
    KG: 10, SOLES: 11, DIRECCION: 15, LAT: 16, LNG: 17, CANAL: 19
  };

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
  let state = {
    selectedCenter: "Todos",
    selectedRangeId: null,
    fleetSort: "dist" // dist | kg | cli | low
  };

  function getFilteredRows() {
    return allRows.filter(r => {
      if (isFRT(r)) return false;
      if (state.selectedCenter !== "Todos" && cleanStr(r[IDX.CENTRO]) !== state.selectedCenter) return false;
      return true;
    });
  }

  /* ==========================================================================
     MOTOR ANALÍTICO DEL RADAR
     ========================================================================== */
  function analyzeOperation(rows) {
    // 1. Consolidar por Cliente Único (sumando sus Kg y Soles del día)
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

    // 2. Clasificar Clientes en los 7 Rangos de Peso (Kg)
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

    // 3. Auditoría de Flota por Unidad (Llave compuesta CENTRO|PLACA)
    // Estimamos recorrido secuencial desde el CD pasando por sus paradas (Nearest Neighbor + Factor vial 1.28x)
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
          stopsMap: new Map()
        });
      }
      const unit = fleetMap.get(key);
      unit.kg += toNum(r[IDX.KG]);
      unit.soles += toNum(r[IDX.SOLES]);

      const cli = cleanStr(r[IDX.CLIENTE]);
      const lat = parseFloat(String(r[IDX.LAT] ?? "").replace(",", "."));
      const lng = parseFloat(String(r[IDX.LNG] ?? "").replace(",", "."));
      if (cli && !isNaN(lat) && !isNaN(lng) && !unit.stopsMap.has(cli)) {
        unit.stopsMap.set(cli, { lat, lng });
      }
    });

    const fleetList = Array.from(fleetMap.values()).map(u => {
      const stops = Array.from(u.stopsMap.values());
      const cdPos = CD_COORDS[u.centro];
      let estRouteKm = 0;
      let maxRadiusKm = 0;

      if (cdPos && stops.length > 0) {
        // Calcular radio máximo desde el CD y ruta encadenada (Nearest Neighbor)
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
        // Retorno al CD + factor de sinuosidad vial urbana (1.28)
        estRouteKm = (estRouteKm + haversineKm(curLat, curLng, cdPos.lat, cdPos.lng)) * 1.28;
      }

      return {
        ...u,
        clientCount: u.stopsMap.size || unique(rows.filter(r => cleanStr(r[IDX.CENTRO]) === u.centro && upperStr(r[IDX.PLACA]) === u.placa).map(r => r[IDX.CLIENTE])).length,
        estRouteKm,
        maxRadiusKm
      };
    });

    // 4. Detección de Zonas de Complejidad Vial / Tráfico
    const trafficStats = TRAFFIC_CORRIDORS.map(zone => {
      const zoneClients = clients.filter(c => !isNaN(c.lat) && !isNaN(c.lng) && zone.check(c.lat, c.lng));
      return {
        ...zone,
        clientCount: zoneClients.length,
        totalKg: zoneClients.reduce((s, c) => s + c.kg, 0),
        platesCount: new Set(zoneClients.map(c => c.placa)).size
      };
    }).filter(z => z.clientCount > 0).sort((a, b) => b.clientCount - a.clientCount);

    return { clients, rangeStats, fleetList, trafficStats };
  }

  function unique(arr) {
    return Array.from(new Set(arr.filter(v => v !== "" && v != null)));
  }

  /* ==========================================================================
     RENDERIZADO DE COMPONENTES
     ========================================================================== */
  function renderRadar() {
    const rows = getFilteredRows();
    const { clients, rangeStats, fleetList, trafficStats } = analyzeOperation(rows);

    // 1. Hallazgos Destacados (Tarjetas Superiores)
    const byDist = [...fleetList].sort((a, b) => b.estRouteKm - a.estRouteKm);
    const byKg   = [...fleetList].sort((a, b) => b.kg - a.kg);
    const byCli  = [...fleetList].sort((a, b) => b.clientCount - a.clientCount);
    const topRng = [...rangeStats].sort((a, b) => b.count - a.count)[0];
    const topTrf = trafficStats[0];

    if (byDist[0]) {
      document.getElementById("hlMaxDistPlaca").textContent = `${byDist[0].placa} (${byDist[0].estRouteKm.toFixed(1)} km)`;
      document.getElementById("hlMaxDistSub").textContent   = `${byDist[0].centro} • Radio máx: ${byDist[0].maxRadiusKm.toFixed(1)} km`;
    } else {
      document.getElementById("hlMaxDistPlaca").textContent = "–";
    }

    if (byKg[0]) {
      document.getElementById("hlMaxKgPlaca").textContent = `${byKg[0].placa} (${(byKg[0].kg / 1000).toFixed(2)} T)`;
      document.getElementById("hlMaxKgSub").textContent   = `${byKg[0].centro} • ${byKg[0].clientCount} clientes`;
    }

    if (byCli[0]) {
      document.getElementById("hlMaxCliPlaca").textContent = `${byCli[0].placa} (${byCli[0].clientCount} cli.)`;
      document.getElementById("hlMaxCliSub").textContent   = `${byCli[0].centro} • ${byCli[0].kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg`;
    }

    if (topRng && clients.length > 0) {
      const pct = Math.round((topRng.count / clients.length) * 100);
      document.getElementById("hlTopRange").textContent    = `${topRng.label} (${pct}%)`;
      document.getElementById("hlTopRangeSub").textContent = `${topRng.count} clientes • ${(topRng.totalKg / 1000).toFixed(1)} T acumuladas`;
    }

    if (topTrf) {
      document.getElementById("hlTopTrafficZone").textContent = `${topTrf.clientCount} cli. en zona ${topTrf.level}`;
      document.getElementById("hlTopTrafficSub").textContent  = `${topTrf.name} (${topTrf.platesCount} unid.)`;
    } else {
      document.getElementById("hlTopTrafficZone").textContent = "Sin congestión crítica";
      document.getElementById("hlTopTrafficSub").textContent  = "Flujo normal en corredores";
    }

    // 2. Renderizar Rangos de Peso (Kg) con Barra Apilada por Canal
    const rangesContainer = document.getElementById("kgRangesContainer");
    const btnResetRange   = document.getElementById("btnResetRangeFilter");
    rangesContainer.innerHTML = "";
    btnResetRange.classList.toggle("is-hidden", !state.selectedRangeId);

    const totalClientsCount = Math.max(1, clients.length);

    rangeStats.forEach(rng => {
      const pct = Math.round((rng.count / totalClientsCount) * 100);
      const isSelected = state.selectedRangeId === rng.id;

      const segsHtml = ["DET", "FSE", "MES", "MOD"].map(ch => {
        const w = rng.count > 0 ? (rng.byChannel[ch] / rng.count) * 100 : 0;
        return `<div class="radar-stacked-seg" style="width:${w}%; background:${CHANNEL_COLORS[ch]};" title="${ch}: ${rng.byChannel[ch]}"></div>`;
      }).join("");

      const row = document.createElement("div");
      row.className = `radar-range-row ${isSelected ? "is-selected" : ""}`;
      row.innerHTML = `
        <div class="radar-range-top">
          <strong>${rng.label}</strong>
          <div class="radar-range-stats">
            <span>${rng.count} cli.</span>
            <span>${(rng.totalKg / 1000).toFixed(1)} T</span>
            <span class="radar-range-pct">${pct}%</span>
          </div>
        </div>
        <div class="radar-stacked-bar">${segsHtml}</div>
        <div class="radar-range-ch-detail">
          <span>DET: <b>${rng.byChannel.DET}</b></span>
          <span>FSE: <b>${rng.byChannel.FSE}</b></span>
          <span>MES: <b>${rng.byChannel.MES}</b></span>
          <span>MOD: <b>${rng.byChannel.MOD}</b></span>
        </div>
      `;

      row.addEventListener("click", () => {
        state.selectedRangeId = (state.selectedRangeId === rng.id) ? null : rng.id;
        renderRadar();
      });

      rangesContainer.appendChild(row);
    });

    // 3. Renderizar Tabla de Auditoría de Flota
    const tbody = document.getElementById("fleetRadarBody");
    tbody.innerHTML = "";

    let sortedFleet = [...fleetList];
    if (state.fleetSort === "dist") sortedFleet.sort((a, b) => b.estRouteKm - a.estRouteKm);
    else if (state.fleetSort === "kg") sortedFleet.sort((a, b) => b.kg - a.kg);
    else if (state.fleetSort === "cli") sortedFleet.sort((a, b) => b.clientCount - a.clientCount);
    else if (state.fleetSort === "low") sortedFleet.sort((a, b) => a.kg - b.kg); // Menor carga primero

    sortedFleet.forEach(u => {
      const isLowLoad = u.kg < 450;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.placa}</td>
        <td>${u.centro.replace(/^\d+-/, "")}</td>
        <td>${u.clientCount}</td>
        <td>${isLowLoad ? `<span class="badge-warn-low">${u.kg.toFixed(0)} kg</span>` : `${u.kg.toLocaleString("es-PE", { maximumFractionDigits: 0 })} kg`}</td>
        <td><strong>${u.estRouteKm.toFixed(1)} km</strong></td>
        <td>${u.maxRadiusKm.toFixed(1)} km</td>
      `;
      tbody.appendChild(tr);
    });

    // 4. Renderizar Zonas de Complejidad Vial
    const trafficContainer = document.getElementById("trafficZonesList");
    trafficContainer.innerHTML = "";
    trafficStats.forEach(z => {
      const div = document.createElement("div");
      div.className = "radar-traffic-item";
      div.innerHTML = `
        <div class="radar-traffic-top">
          <strong>${z.name}</strong>
          <span class="traffic-level ${z.cls}">${z.level}</span>
        </div>
        <div class="radar-traffic-meta">
          <span>${z.reason}</span>
          <span><b>${z.clientCount}</b> cli. • <b>${(z.totalKg / 1000).toFixed(1)} T</b></span>
        </div>
      `;
      trafficContainer.appendChild(div);
    });

    // 5. Renderizar Top Clientes por Volumen (Filtrado por rango si hay uno seleccionado)
    const clientsContainer = document.getElementById("topClientsList");
    const topClientsTitle  = document.getElementById("topClientsTitle");
    const topClientsHint   = document.getElementById("topClientsHint");
    clientsContainer.innerHTML = "";

    let displayClients = [...clients];
    if (state.selectedRangeId) {
      const foundRng = rangeStats.find(r => r.id === state.selectedRangeId);
      displayClients = foundRng ? [...foundRng.clients] : displayClients;
      topClientsTitle.textContent = `Clientes en Rango: ${foundRng?.label || ""}`;
      topClientsHint.textContent  = `${displayClients.length} clientes encontrados en este tramo`;
    } else {
      topClientsTitle.textContent = "Top Clientes de Mayor Volumen";
      topClientsHint.textContent  = "Principales receptores por tonelaje asignado";
    }

    displayClients.sort((a, b) => b.kg - a.kg).slice(0, 15).forEach(c => {
      const chColor = CHANNEL_COLORS[c.canal] || "#71717a";
      const item = document.createElement("div");
      item.className = "radar-client-item";
      item.innerHTML = `
        <div class="radar-client-info">
          <div class="radar-client-name">${c.nombre}</div>
          <div class="radar-client-sub">
            <span style="color:${chColor}; font-weight:800;">● ${c.canal}</span> • ${c.placa} • ${c.distFromCd.toFixed(1)} km del CD
          </div>
        </div>
        <div class="radar-client-val">
          <strong>${c.kg.toLocaleString("es-PE", { maximumFractionDigits: 1 })} kg</strong>
          <span>S/ ${c.soles.toLocaleString("es-PE", { maximumFractionDigits: 0 })}</span>
        </div>
      `;
      clientsContainer.appendChild(item);
    });
  }

  function bindEvents() {
    document.querySelectorAll(".radar-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(".radar-pill").forEach(p => p.classList.remove("is-active"));
        pill.classList.add("is-active");
        state.selectedCenter = pill.getAttribute("data-center");
        renderRadar();
      });
    });

    document.querySelectorAll(".radar-sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".radar-sort-btn").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.fleetSort = btn.getAttribute("data-sort");
        renderRadar();
      });
    });

    document.getElementById("btnResetRangeFilter").addEventListener("click", () => {
      state.selectedRangeId = null;
      renderRadar();
    });
  }

  async function init() {
    try {
      const text = await loadCSVWithFallback();
      allRows = parseCSV(text);
      bindEvents();
      renderRadar();
    } catch (err) {
      console.error("Error inicializando Radar de Distribución:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
