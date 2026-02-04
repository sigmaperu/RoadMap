// app.js

// Inyección del header (y futuro footer) sin duplicar código
document.querySelectorAll("#header-placeholder, #footer-placeholder").forEach(async host => {
  const src = host.getAttribute("data-src");
  if (!src) return;
  try {
    const html = await fetch(src).then(r => r.text());
    host.innerHTML = html;

    // Toggle menú móvil
    const toggle = host.querySelector(".menu-toggle");
    const menu   = host.querySelector(".nav-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", () => {
        const isOpen = menu.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(isOpen));
      });

      // Cerrar al hacer click en un enlace (móvil)
      menu.querySelectorAll("a").forEach(a => {
        a.addEventListener("click", () => {
          if (menu.classList.contains("open")) {
            menu.classList.remove("open");
            toggle.setAttribute("aria-expanded", "false");
          }
        });
      });
    }

    // Activar el link de la página actual
    const path = location.pathname.split("/").pop() || "index.html";
    host.querySelectorAll(".nav-link").forEach(a => {
      const href = a.getAttribute("href");
      if (href === path) a.classList.add("active");
    });
  } catch (e) {
    console.error("No se pudo cargar el layout:", e);
  }
});
