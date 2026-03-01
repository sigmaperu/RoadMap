document.addEventListener('DOMContentLoaded', () => {
  // ---- Menú lateral ----
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');

  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('sidebar--open');
    });
  }

  // Cerrar sidebar al hacer clic en un enlace, solo en móvil
  const navLinks = document.querySelectorAll('.sidebar__nav .nav-item');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 920 && sidebar && sidebar.classList.contains('sidebar--open')) {
        sidebar.classList.remove('sidebar--open');
      }
    });
  });

  // ---- Fecha + camión en header (páginas que tengan #topbarFecha) ----
  initTopbarFecha();
});

const CSV_URL = "https://raw.githubusercontent.com/sigmaperu/RoadMap/main/RoadMap.csv";

function formatFecha(raw) {
  if (!raw) return "";
  const parts = raw.replace(/["']/g, "").trim().split(/[/-]/);
  if (parts.length === 3) {
    // yyyy-mm-dd
    if (parts[0].length === 4) {
      return parts[2].padStart(2, "0") + "/" +
             parts[1].padStart(2, "0") + "/" +
             parts[0];
    }
    // dd/mm/yyyy
    return parts[0].padStart(2, "0") + "/" +
           parts[1].padStart(2, "0") + "/" +
           parts[2];
  }
  return raw;
}

async function initTopbarFecha() {
  const el = document.getElementById("topbarFecha");
  if (!el) return;

  try {
    const resp = await fetch(CSV_URL);
    const text = await resp.text();

    // Línea por línea (maneja 
 y 
 correctamente) [web:311]
    const lines = text.split(/
?
/).filter(l => l.trim() !== "");
    if (lines.length < 2) return;

    const firstDataRow = lines[1].split(",");
    const rawDate = firstDataRow[0] || "";
    el.textContent = formatFecha(rawDate);
  } catch (e) {
    console.error("No se pudo cargar fecha RoadMap:", e);
  }
}
