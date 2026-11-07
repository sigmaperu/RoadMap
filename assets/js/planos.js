/* ==========================================================================
   RoadMap - planos.js (Lógica optimizada con Selector Inicial y Mapa perezoso)
   ========================================================================== */

(() => {
  const CSV_URL = (window.RoadMapConfig && window.RoadMapConfig.CSV_URL) || "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";
  const JSON_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/refs/heads/main/PowerApp_Data.json";

  let allRows = [];
  let powerAppData = new Map();
  let leafletMap = null;
  let markersLayer = null;

  // Elementos del mapa y controles flotantes
  const filterCentro  = document.getElementById("filterCentro");
  const filterPlaca   = document.getElementById("filterPlaca");
  const filterCliente = document.getElementById("filterCliente");

  const btnToggleFilters = document.getElementById("btnToggleFilters");
  const filtersPanel     = document.getElementById("filtersPanel");

  // Elementos de la Pantalla Selectora Inicial
  const initialSelectorOverlay = document.getElementById("initialSelectorOverlay");
  const initCentro = document.getElementById("initCentro");
  const initPlaca = document.getElementById("initPlaca");
  const initCliente = document.getElementById("initCliente");
  const btnLaunchMap = document.getElementById("btnLaunchMap");

  function parseCSV(text){
    const lines = text.split(/\r?\n/).filter(l=>l.trim()!=="");
    lines.shift();
    const rows=[];
    for (const line of lines){
      let inQuotes=false, cur="", row=[];
      for (let i=0;i<line.length;i++){
        const c=line[i];
        if (c === '"'){
          if(inQuotes && line[i+1]==='"'){ cur+='"'; i++; }
          else inQuotes=!inQuotes;
        } else if(c === "," && !inQuotes){
          row.push(cur); cur="";
        } else cur+=c;
      }
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }
  const unique = arr => [...new Set(arr.filter(v=>v!=="" && v!=null))];
  const toNum = v => { const n = parseFloat(String(v??"0").replace(",", ".")); return isNaN(n)?0:n; };
  const extractCleanId = val => {
    if (!val) return "";
    const match = String(val).match(/\d+/);
    return match ? match[0] : String(val).trim();
  };

  async function loadPowerAppData() {
    try {
      const resp = await fetch(JSON_URL);
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data)) {
        data.forEach(item => {
          const cleanKey = extractCleanId(item.CustomerAccount);
          const statusVal = item.EstadoEntrega || "";
          if (cleanKey) {
            powerAppData.set(cleanKey, String(statusVal).trim());
          }
        });
      }
    } catch (e) {
      console.warn("No se pudo cargar PowerApp_Data.json en Planos:", e);
    }
  }

  function getStatusClass(clienteCod) {
    const cleanKey = extractCleanId(clienteCod);
    const statusRaw = String(powerAppData.get(cleanKey) || "").toLowerCase();

    if (statusRaw.includes("entreg") || statusRaw.includes("aten") || statusRaw.includes("verde") || statusRaw.includes("ok")) {
      return { cssClass: "pin-verde", texto: "Entregado" };
    }
    if (statusRaw.includes("rech") || statusRaw.includes("anul") || statusRaw.includes("rojo")) {
      return { cssClass: "pin-rojo", texto: "Rechazado" };
    }
    if (statusRaw.includes("pend") || statusRaw.includes("ruta")) {
      return { cssClass: "pin-naranja", texto: "Pendiente" };
    }
    return { cssClass: "pin-gris", texto: "Sin información" };
  }

  function buildClienteLabelFromRow(r){
    const cod = r[3] ?? "";
    const nom = r[4] ?? "";
    const sec = r[5] ?? "";
    const validNom = nom && nom !== "0" && nom.toLowerCase() !== "error";
    const validSec = sec && sec !== "0" && sec.toLowerCase() !== "error";
    if (validNom && validSec) return `${cod} - ${nom} - ${sec}`;
    if (validNom) return `${cod} - ${nom}`;
    if (validSec) return `${cod} - ${sec}`;
    return cod;
  }

  let allCentros=[], allPlacas=[], allClientes=[];

  function populateBaseOptions(){
    allCentros  = unique(allRows.map(r=>r[1]??"")).sort();
    allPlacas   = unique(allRows.map(r=>r[2]??"")).sort();
    allClientes = unique(allRows.map(r=>r[3]??"")).sort();
  }

  function fillSelect(sel, items, defaultText = "Todos"){
    sel.innerHTML = "";
    const o = document.createElement("option");
    o.value = "";
    o.textContent = defaultText;
    sel.appendChild(o);
    items.forEach(val => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    });
  }

  function fillClientSelect(sel, subset){
    sel.innerHTML = "";
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "Todos";
    sel.appendChild(o);

    unique(subset.map(r=>r[3]??"")).sort().forEach(cod=>{
      const rowOne = subset.find(r=> (r[3]??"") === cod );
      const label  = rowOne ? buildClienteLabelFromRow(rowOne) : cod;
      const opt = document.createElement("option");
      opt.value = cod;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  /* ========================================== */
  /* POBLAR SELECTORES (INICIAL Y FLOTANTE)      */
  /* ========================================== */
  function setupSelectors(){
    // Llenar selector inicial
    fillSelect(initCentro, allCentros);
    fillSelect(initPlaca, allPlacas);
    fillClientSelect(initCliente, allRows);

    // Llenar selector flotante del mapa
    fillSelect(filterCentro, allCentros);
    fillSelect(filterPlaca, allPlacas);
    fillClientSelect(filterCliente, allRows);

    // Sincronizar cambios en el selector inicial
    initCentro.addEventListener("change", () => {
      const c = initCentro.value;
      let subset = c ? allRows.filter(r => (r[1]??"") === c) : allRows;
      fillSelect(initPlaca, unique(subset.map(r=>r[2]??"")).sort());
      fillClientSelect(initCliente, subset);
    });

    initPlaca.addEventListener("change", () => {
      const c = initCentro.value;
      const p = initPlaca.value;
      let subset = allRows;
      if (c) subset = subset.filter(r => (r[1]??"") === c);
      if (p) subset = subset.filter(r => (r[2]??"") === p);
      fillClientSelect(initCliente, subset);
    });

    // Sincronizar cambios en los filtros flotantes del mapa
    filterCentro.addEventListener("change", () => {
      const c = filterCentro.value;
      let subset = c ? allRows.filter(r => (r[1]??"") === c) : allRows;
      fillSelect(filterPlaca, unique(subset.map(r=>r[2]??"")).sort());
      fillClientSelect(filterCliente, subset);
      applyFilters();
    });

    filterPlaca.addEventListener("change", () => {
      const c = filterCentro.value;
      const p = filterPlaca.value;
      let subset = allRows;
      if (c) subset = subset.filter(r => (r[1]??"") === c);
      if (p) subset = subset.filter(r => (r[2]??"") === p);
      fillClientSelect(filterCliente, subset);
      applyFilters();
    });

    filterCliente.addEventListener("change", () => {
      applyFilters();
    });
  }

  /* ========================================== */
  /* MAPA LEAFLET                               */
  /* ========================================== */
  function initMap(){
    if (leafletMap) return;
    leafletMap = L.map("map",{zoomControl:false}).setView([-9.19,-75.02],5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:19, attribution:"© OpenStreetMap"
    }).addTo(leafletMap);
    L.control.zoom({position:"bottomright"}).addTo(leafletMap);
    markersLayer = L.layerGroup().addTo(leafletMap);
  }

  function renderMarkers(points){
    if (!markersLayer) return;
    markersLayer.clearLayers();
    const bounds=[];
    points.forEach(p=>{
      const statusInfo = getStatusClass(p.codCliente);
      const addressText = (p.direccion && p.direccion.trim()) ? p.direccion.trim() : "-";
      const googleUrl = `https://www.google.com/maps?q=${encodeURIComponent(p.lat + "," + p.lng)}`;

      const popupHtml=`
        <div style="min-width:210px; padding:4px;">
          <div style="font-weight:700; color:var(--primary,#9C27B0); margin-bottom:4px;">${p.cliente}</div>
          <strong>Estado:</strong> <span style="font-weight:600;">${statusInfo.texto}</span><br>
          <strong>Dirección:</strong> <a href="${googleUrl}" target="_blank" rel="noopener noreferrer">${addressText}</a><br>
          <strong>Ruta:</strong> ${p.ruta ?? "-"}<br>
          <strong>VH:</strong> ${p.vh ?? "-"}<br>
          <label style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:.82rem;cursor:pointer;user-select:none;">
            <input type="checkbox" class="visitado-checkbox" style="cursor:pointer;"/> Marcar como visitado
          </label>
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-pin-container',
        html: `<div class="custom-pin ${statusInfo.cssClass}"><div class="custom-pin-body"><div class="custom-pin-dot"></div></div></div>`,
        iconSize: [28, 38],
        iconAnchor: [14, 38],
        popupAnchor: [0, -36]
      });

      const m = L.marker([p.lat, p.lng], { icon: customIcon });
      m.bindPopup(popupHtml);
      m.addTo(markersLayer);
      bounds.push([p.lat, p.lng]);

      m.on("popupopen", e => {
        const cb = e.popup.getElement().querySelector(".visitado-checkbox");
        const pinElement = m.getElement().querySelector('.custom-pin');
        if(cb && pinElement) {
          cb.addEventListener("change", () => {
            if (cb.checked) {
              pinElement.classList.add('is-visited');
            } else {
              pinElement.classList.remove('is-visited');
            }
          });
        }
      });
    });

    if(bounds.length > 0) leafletMap.fitBounds(bounds, { padding: [40, 40] });
    else leafletMap.setView([-9.19, -75.02], 5);
  }

  function locateUserOnLoad() {
    if (!leafletMap || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        L.circleMarker([latitude, longitude], {
          radius: 6, color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.9, weight: 2
        }).bindPopup("Mi ubicación actual").addTo(leafletMap);

        try {
          const hasData = markersLayer && markersLayer.getLayers().length > 0;
          if (!hasData) leafletMap.setView([latitude, longitude], 13);
        } catch(_) {}
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  function applyFilters(){
    const centro  = filterCentro.value;
    const placa   = filterPlaca.value;
    const codCli  = filterCliente.value;

    let filtered = allRows.slice();
    if(centro) filtered = filtered.filter(r=> (r[1]??"")===centro );
    if(placa)  filtered = filtered.filter(r=> (r[2]??"")===placa );
    if(codCli) filtered = filtered.filter(r=> (r[3]??"")===codCli );

    const clientMap=new Map();

    filtered.forEach(r=>{
      const cod = r[3] ?? "";
      if(!cod) return;
      if(String(r[2]).trim().toUpperCase() === "FRT-001") return;

      const lat=parseFloat((r[16]??"").replace(",","."));
      const lng=parseFloat((r[17]??"").replace(",","."));
      if(isNaN(lat)||isNaN(lng)) return;

      const nom=r[4]??"";
      const sec=r[5]??"";
      const ruta=r[6]??"";
      const rutaExt=r[19]??"";
      const dir15=r[15]??"";
      const dir14=r[14]??"";
      const vh=r[18]??"";
      const peso=toNum(r[10]??"0");

      const clienteLabel = buildClienteLabelFromRow(r);

      let direccion = "";
      if (dir15 && dir15 !== "0" && dir15.toLowerCase() !== "error") direccion = dir15;
      if (dir14 && dir14 !== "0" && dir14.toLowerCase() !== "error") {
        direccion = direccion ? `${direccion} - ${dir14}` : dir14;
      }

      const rutaTexto=(rutaExt && rutaExt!=="0" && rutaExt.toLowerCase()!=="error")
                       ? (ruta ? `${ruta} - ${rutaExt}` : rutaExt)
                       : ruta;

      const exists=clientMap.get(cod);
      if(!exists){
        clientMap.set(cod,{
          codCliente: cod,
          cliente: clienteLabel,
          lat, lng,
          direccion,
          ruta: rutaTexto,
          vh,
          pesoTotal: peso
        });
      } else exists.pesoTotal += peso;
    });

    renderMarkers([...clientMap.values()]);
  }

  /* ========================================== */
  /* INICIALIZACIÓN Y EVENTO DE APERTURA MAPA   */
  /* ========================================== */
  async function init(){
    try{
      await loadPowerAppData();
      const resp = await fetch(CSV_URL);
      const text = await resp.text();
      allRows = parseCSV(text);

      populateBaseOptions();
      setupSelectors();
    }catch(e){
      console.error(e);
      alert("No se pudo cargar RoadMap.csv para el mapa.");
    }

    // Botón para lanzar el mapa desde la pantalla selectora inicial
    btnLaunchMap.addEventListener("click", () => {
      // Transferir selecciones iniciales a los filtros flotantes del mapa
      filterCentro.value = initCentro.value;
      
      // Actualizar opciones de placa según centro elegido
      let subset = filterCentro.value ? allRows.filter(r => (r[1]??"") === filterCentro.value) : allRows;
      fillSelect(filterPlaca, unique(subset.map(r=>r[2]??"")).sort());
      filterPlaca.value = initPlaca.value;

      // Actualizar opciones de cliente según centro y placa
      if (filterPlaca.value) subset = subset.filter(r => (r[2]??"") === filterPlaca.value);
      fillClientSelect(filterCliente, subset);
      filterCliente.value = initCliente.value;

      // Ocultar pantalla selectora inicial con transición suave
      initialSelectorOverlay.classList.add("hidden");

      // Inicializar Leaflet y renderizar puntos
      initMap();
      applyFilters();
      setTimeout(() => {
        leafletMap.invalidateSize();
        locateUserOnLoad();
      }, 200);
    });

    // Toggle panel de filtros flotante dentro del mapa
    btnToggleFilters.addEventListener("click",()=>{
      filtersPanel.classList.toggle("filters-floating--collapsed");
    });
  }

  document.addEventListener("DOMContentLoaded",init);
})();
