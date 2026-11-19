/* ==========================================================================
   RoadMap - main.js (Partials originales + Fecha dinámica desde RoadMap.csv)
   ========================================================================== */

window.RoadMapConfig = window.RoadMapConfig || {
  CSV_URL: "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv"
};

window.RoadMapFechaOperativa = null;

function formatFechaCSV(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/"/g, "").trim().split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const [y, m, d] = clean.split("-");
    return `${d}/${m}/${y}`;
  }
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(clean)) {
    return clean.replace(/-/g, "/");
  }
  return clean;
}

async function syncTopbarDateFromCSV() {
  const fechaEl = document.getElementById("topbarFecha");
  try {
    const resp = await fetch(`${window.RoadMapConfig.CSV_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });
    if (!resp.ok) throw new Error("No se pudo leer RoadMap.csv");
    const text = await resp.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");

    if (lines.length > 1) {
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
        if (fechaEl) fechaEl.textContent = formatted;
        document.dispatchEvent(new CustomEvent("roadmap:dateLoaded", { detail: formatted }));
        return;
      }
    }
  } catch (err) {
    console.warn("No se pudo obtener la fecha de RoadMap.csv:", err);
  }

  // Respaldo si falla la red
  if (fechaEl && !window.RoadMapFechaOperativa) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    fechaEl.textContent = new Date().toLocaleDateString('es-PE', options);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // 1. Inyección automática del Sidebar modular si existe el contenedor
  const sidebarContainer = document.getElementById("app-sidebar");
  if (sidebarContainer) {
    fetch("partials/sidebar.html")
      .then(res => res.text())
      .then(html => {
        sidebarContainer.innerHTML = html;
        setActiveNavLink();
      })
      .catch(err => console.warn("No se pudo cargar el sidebar modular:", err));
  }

  // 2. Inyección automática del Header si existe
  const headerContainer = document.getElementById("app-header");
  if (headerContainer) {
    fetch("partials/header.html")
      .then(res => res.text())
      .then(html => {
        headerContainer.innerHTML = html;
        initHeaderControls();
      })
      .catch(err => console.warn("No se pudo cargar el header modular:", err));
  } else {
    initHeaderControls();
  }
});

function setActiveNavLink() {
  const currentPath = window.location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".sidebar__nav a, .gm-nav a").forEach(link => {
    const page = link.getAttribute("data-page") || link.getAttribute("href");
    if (page === currentPath) {
      link.classList.add("active", "nav-item--active");
    } else {
      link.classList.remove("active", "nav-item--active");
    }
  });
}

function initHeaderControls() {
  // Fecha operativa en el topbar (desde RoadMap.csv)
  syncTopbarDateFromCSV();

  // Control del menú hamburguesa en móviles
  const menuToggle = document.getElementById("menuToggle");
  const sidebar = document.querySelector(".sidebar");

  if (menuToggle && sidebar) {
    let backdrop = document.querySelector(".sidebar-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "sidebar-backdrop";
      document.body.appendChild(backdrop);
    }

    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      sidebar.classList.toggle("sidebar--open");
      backdrop.classList.toggle("backdrop--active");
    });

    backdrop.addEventListener("click", () => {
      sidebar.classList.remove("sidebar--open");
      backdrop.classList.remove("backdrop--active");
    });
  }
}
