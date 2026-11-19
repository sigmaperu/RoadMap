/* ==========================================================================
   RoadMap - main.js (Header, Sidebar Modular y Fecha Real desde RoadMap.csv)
   ========================================================================== */

window.RoadMapConfig = {
  CSV_URL: "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv"
};

window.RoadMapFechaOperativa = null;

function formatFechaCSV(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/"/g, "").trim().split(" ")[0];
  // Si viene en formato YYYY-MM-DD -> DD/MM/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const [y, m, d] = clean.split("-");
    return `${d}/${m}/${y}`;
  }
  // Si ya viene en DD/MM/YYYY o DD-MM-YYYY
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(clean)) {
    return clean.replace(/-/g, "/");
  }
  return clean;
}

async function syncGlobalDateFromCSV() {
  const dateBadge = document.getElementById("header-date-badge");
  try {
    const resp = await fetch(`${window.RoadMapConfig.CSV_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });
    if (!resp.ok) throw new Error("No se pudo leer RoadMap.csv");
    const text = await resp.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");

    if (lines.length > 1) {
      // Extraer primera columna (Fecha) de la primera fila de datos
      const firstRow = lines[1];
      let firstCol = "";
      if (firstRow.startsWith('"')) {
        const endQuote = firstRow.indexOf('"', 1);
        firstCol = endQuote > 0 ? firstRow.slice(1, endQuote) : firstRow.split(",")[0];
      } else {
        firstCol = firstRow.split(",")[0];
      }

      const formatted = formatFechaCSV(firstCol);
      if (formatted) {
        window.RoadMapFechaOperativa = formatted;
        if (dateBadge) dateBadge.textContent = formatted;
        document.dispatchEvent(new CustomEvent("roadmap:dateLoaded", { detail: formatted }));
        return;
      }
    }
  } catch (err) {
    console.warn("Usando fecha de respaldo en header:", err);
  }

  // Respaldo solo si no hay red
  if (dateBadge && (!dateBadge.textContent || dateBadge.textContent === "Cargando...")) {
    const now = new Date();
    dateBadge.textContent = now.toLocaleDateString("es-PE", {
      day: "2-digit", month: "2-digit", year: "numeric"
    });
  }
}

function renderGlobalLayout() {
  const sidebarEl = document.getElementById("app-sidebar");
  const headerEl = document.getElementById("app-header");
  const currentPage = window.location.pathname.split("/").pop() || "index.html";

  if (sidebarEl && !sidebarEl.innerHTML.trim()) {
    const navItems = [
      { href: "index.html", icon: "home", label: "Inicio" },
      { href: "agenda.html", icon: "event", label: "Agenda" },
      { href: "dashboard.html", icon: "dashboard", label: "Dashboard" },
      { href: "planif.html", icon: "timeline", label: "Planificación" },
      { href: "planos.html", icon: "map", label: "Planos" },
      { href: "program.html", icon: "view_week", label: "Programación" },
      { href: "ubicame.html", icon: "my_location", label: "Ubícame" }
    ];

    sidebarEl.innerHTML = `
      <div class="sidebar__logo"><img src="assets/img/logotipo.png" alt="RoadMap"></div>
      <nav class="sidebar__nav">
        ${navItems.map(item => `
          <a href="${item.href}" class="nav-item ${currentPage === item.href ? "nav-item--active" : ""}">
            <span class="nav-item__icon material-icons">${item.icon}</span>
            <span>${item.label}</span>
          </a>
        `).join("")}
      </nav>
    `;
  }

  if (headerEl && !headerEl.innerHTML.trim()) {
    const pageTitle = document.body.getAttribute("data-title") || "RoadMap";
    headerEl.innerHTML = `
      <header class="topbar">
        <div class="topbar__left">
          <button id="btnMobileMenu" class="mobile-menu-btn" type="button" aria-label="Menú">
            <span class="material-icons">menu</span>
          </button>
          <h1 class="topbar__title">${pageTitle}</h1>
        </div>
        <div class="topbar__right">
          <span id="header-date-badge" class="date-pill" title="Fecha de planificación (RoadMap.csv)">
            ${window.RoadMapFechaOperativa || "Cargando..."}
          </span>
        </div>
      </header>
    `;

    const mobileBtn = document.getElementById("btnMobileMenu");
    if (mobileBtn && sidebarEl) {
      mobileBtn.addEventListener("click", () => {
        sidebarEl.classList.toggle("sidebar--open");
      });
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderGlobalLayout();
  syncGlobalDateFromCSV();
});
