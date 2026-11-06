// assets/js/main.js
(() => {
  window.RoadMapConfig = window.RoadMapConfig || {};
  RoadMapConfig.CSV_URL =
    RoadMapConfig.CSV_URL ||
    "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";

  // ---- Monta el Header ----
  async function mountHeader() {
    const host = document.getElementById('app-header');
    if (!host) return;
    try {
      const res = await fetch('partials/header.html', { cache: 'no-cache' });
      host.innerHTML = await res.text();

      const titleEl = document.getElementById('pageTitle');
      if (titleEl) {
        titleEl.textContent = document.body.dataset.title || document.title || 'RoadMap';
      }

      const menuToggle = document.getElementById('menuToggle');
      const sidebar = document.querySelector('.sidebar');
      if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
          sidebar.classList.toggle('sidebar--open');
        });
      }

      initTopbarFecha();
      setTimeout(() => {
        const el = document.getElementById('topbarFecha');
        if (el && !el.textContent.trim()) el.textContent = getLocalNow();
      }, 500);

      document.dispatchEvent(new CustomEvent('header:ready'));
    } catch (e) {
      console.error('No se pudo montar el header:', e);
    }
  }

  // ---- Monta el Sidebar Modular y marca la página activa (Notch) ----
  async function mountSidebar() {
    const host = document.getElementById('app-sidebar');
    if (!host) return;
    try {
      const res = await fetch('partials/sidebar.html', { cache: 'no-cache' });
      host.innerHTML = await res.text();

      // Detectar página actual para activar el notch automáticamente
      const currentPath = window.location.pathname.split("/").pop() || "index.html";
      const navLinks = host.querySelectorAll('.gm-nav__item');
      
      navLinks.forEach(link => {
        const pageAttr = link.getAttribute('data-page');
        if (currentPath === pageAttr || (currentPath === "" && pageAttr === "index.html")) {
          link.classList.add('active', 'nav-item--active');
        } else {
          link.classList.remove('active', 'nav-item--active');
        }

        // Cierra sidebar en mobile al navegar
        link.addEventListener('click', () => {
          const sidebar = document.querySelector('.sidebar');
          if (window.innerWidth <= 860 && sidebar && sidebar.classList.contains('sidebar--open')) {
            sidebar.classList.remove('sidebar--open');
          }
        });
      });
    } catch (e) {
      console.error('No se pudo montar el sidebar:', e);
    }
  }

  // ---- Fecha en header ----
  function getLocalNow() {
    const d = new Date();
    const pad = n => (n < 10 ? "0"+n : ""+n);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function setLocalNow(el) { el.textContent = getLocalNow(); }

  function formatFecha(raw) {
    if (!raw) return "";
    const s = String(raw).trim().replace(/[\"'\[\]]/g, "");
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) { const [, yyyy, mm, dd] = iso; return `${dd.padStart(2,"0")}/${mm.padStart(2,"0")}/${yyyy}`; }
    const latam = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (latam) { const [, dd, mm, yyyy] = latam; return `${dd.padStart(2,"0")}/${mm.padStart(2,"0")}/${yyyy}`; }
    return s;
  }

  async function initTopbarFecha() {
    const el = document.getElementById("topbarFecha");
    if (!el) return;
    try {
      const resp = await fetch(RoadMapConfig.CSV_URL);
      const text = await resp.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
      if (lines.length < 2) { setLocalNow(el); return; }
      const firstDataRow = lines[1].split(",");
      const rawDate = (firstDataRow[0] || "").trim();
      const formatted = formatFecha(rawDate);
      el.textContent = formatted || getLocalNow();
    } catch (e) {
      console.error("No se pudo cargar fecha RoadMap:", e);
      setLocalNow(el);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    mountSidebar();
    mountHeader();
  });
})();
