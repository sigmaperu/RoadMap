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
  // Fecha actual en el topbar
  const fechaEl = document.getElementById("topbarFecha");
  if (fechaEl) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    fechaEl.textContent = new Date().toLocaleDateString('es-PE', options);
  }

  // Control del menú hamburguesa en móviles
  const menuToggle = document.getElementById("menuToggle");
  const sidebar = document.querySelector(".sidebar");

  if (menuToggle && sidebar) {
    // Crear un fondo oscuro (backdrop) dinámico para móviles si no existe
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
