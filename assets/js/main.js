// assets/js/main.js
(() => {
  // Config global única (evita dobles declaraciones)
  window.RoadMapConfig = window.RoadMapConfig || {};
  RoadMapConfig.CSV_URL = RoadMapConfig.CSV_URL || "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";

  // Monta el header compartido en todas las páginas
  async function mountHeader() {
    const host = document.getElementById('app-header');
    if (!host) return; // si una página no tiene contenedor, no hacemos nada

    try {
      const res = await fetch('partials/header.html', { cache: 'no-cache' });
      host.innerHTML = await res.text();

      // Título: lo tomamos de data-title del <body> (o de <title>)
      const titleEl = document.getElementById('pageTitle');
      if (titleEl) {
        const pageTitle = document.body.dataset.title || document.title || 'RoadMap';
        titleEl.textContent = pageTitle;
      }

      // Menú hamburguesa
      const menuToggle = document.getElementById('menuToggle');
      const sidebar = document.querySelector('.sidebar');
      if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
          sidebar.classList.toggle('sidebar--open');
        });
      }

      // Cierra el sidebar al navegar en mobile
      const navLinks = document.querySelectorAll('.sidebar__nav .nav-item');
      navLinks.forEach(link => {
        link.addEventListener('click', () => {
          if (window.innerWidth <= 920 && sidebar && sidebar.classList.contains('sidebar--open')) {
            sidebar.classList.remove('sidebar--open');
          }
        });
      });

      // Fecha en header
      initTopbarFecha();
    } catch (e) {
      console.error('No se pudo montar el header:', e);
    }
  }

  // ---- Fecha en header: lee de CSV (fallback a hora local) ----
  function getLocalNow() {
    const d = new Date();
    const pad = n => (n < 10 ? "0"+n : ""+n);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function setLocalNow(el) { el.textContent = getLocalNow(); }

  function formatFecha(raw) {
    if (!raw) return "";
    const s = String(raw).trim().replace(/[\"'\[\]]/g, "");
    // ISO yyyy-mm-dd
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
      const [, yyyy, mm, dd] = iso;
      return `${String(dd).padStart(2,"0")}/${String(mm).padStart(2,"0")}/${yyyy}`;
    }
    // dd/mm/yyyy
    const latam = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (latam) {
      const [, dd, mm, yyyy] = latam;
      return `${String(dd).padStart(2,"0")}/${String(mm).padStart(2,"0")}/${yyyy}`;
    }
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

  // Espera DOM y monta el header
  document.addEventListener('DOMContentLoaded', mountHeader);
})();
