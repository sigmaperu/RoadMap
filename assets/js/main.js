// assets/js/main.js
(() => {
  // Config global única (evita choques)
  window.RoadMapConfig = window.RoadMapConfig || {};
  RoadMapConfig.CSV_URL =
    RoadMapConfig.CSV_URL ||
    "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";

  // ---- Monta el header en todas las páginas ----
  async function mountHeader() {
    const host = document.getElementById('app-header');
    if (!host) return;

    try {
      const res = await fetch('partials/header.html', { cache: 'no-cache' });
      host.innerHTML = await res.text();

      // Título dinámico
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

      // Cierra sidebar al navegar en mobile
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

      // Fallback por si tarda el CSV
      setTimeout(() => {
        const el = document.getElementById('topbarFecha');
        if (el && !el.textContent.trim()) el.textContent = getLocalNow();
      }, 500);

      document.dispatchEvent(new CustomEvent('header:ready'));
    } catch (e) {
      console.error('No se pudo montar el header:', e);
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

  document.addEventListener('DOMContentLoaded', mountHeader);
})();
