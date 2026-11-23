import csv
import os
import re
from collections import defaultdict
from datetime import datetime
from staticmap import StaticMap, CircleMarker

CSV_PATH = "RoadMap.csv"
OUT_DIR = "reports"
PAGES_BASE_URL = "https://sigmaperu.github.io/RoadMap"

CENTERS_ORDER = ["0374-ATE", "0780-ATE2", "0754-CHANCAY"]

CD_COORDS = {
    "0374-ATE":     (-12.067013, -76.979433),
    "0780-ATE2":    (-12.045125, -76.938130),
    "0754-CHANCAY": (-11.551110, -77.276417),
}

CHANNEL_COLORS = {
    "DET": "#ef4444",
    "FSE": "#2563eb",
    "MES": "#f97316",
    "MOD": "#eab308",
    "OTRO": "#71717a",
}

TRUCKS_EXCLUDED = {"FRT-001", "RES-CLI"}


def to_num(val):
    try:
        return float(str(val or "0").replace(",", ".").strip())
    except ValueError:
        return 0.0


def clean_str(val):
    return str(val or "").strip()


def norm_channel(raw):
    c = re.sub(r"\s*\([^)]*\)", "", clean_str(raw)).strip().upper()
    if c == "FSE" or "FOSE" in c:
        return "FSE"
    if "DET" in c:
        return "DET"
    if "MES" in c:
        return "MES"
    if "MOD" in c:
        return "MOD"
    return "OTRO"


def is_valid_coord(lat, lng):
    return (
        lat != 0 and lng != 0
        and -13.5 <= lat <= -10.5
        and -78.0 <= lng <= -75.5
    )


def compute_metrics(rows):
    kg_total = 0.0
    soles_total = 0.0
    clients_map = {}
    pedidos_set = set()
    placas_set = set()
    ch_kg = defaultdict(float)
    ch_cli = defaultdict(set)

    for r in rows:
        kg = to_num(r["kg"])
        soles = to_num(r["soles"])
        kg_total += kg
        soles_total += soles

        cli = r["cli"]
        ch = r["canal"]
        ch_kg[ch] += kg
        if cli:
            ch_cli[ch].add(cli)
            if cli not in clients_map:
                clients_map[cli] = {
                    "cod": cli,
                    "lat": r["lat"],
                    "lng": r["lng"],
                    "has_coord": r["has_coord"],
                    "canal": ch,
                }
        if r["ped"]:
            pedidos_set.add(r["ped"])
        if r["placa"] and r["placa"] not in TRUCKS_EXCLUDED:
            placas_set.add(r["placa"])

    n_cli = len(clients_map)
    n_ped = len(pedidos_set)
    n_placas = len(placas_set)

    drop_size_kg = (kg_total / n_cli) if n_cli else 0.0
    ticket_prom = (soles_total / n_cli) if n_cli else 0.0
    cli_x_placa = (n_cli / n_placas) if n_placas else 0.0
    kg_x_placa = (kg_total / n_placas) if n_placas else 0.0

    return {
        "kg": kg_total,
        "ton": kg_total / 1000.0,
        "soles": soles_total,
        "clientes": n_cli,
        "pedidos": n_ped,
        "placas": n_placas,
        "drop_size": drop_size_kg,
        "ticket_prom": ticket_prom,
        "cli_x_placa": cli_x_placa,
        "kg_x_placa": kg_x_placa,
        "ch_kg": ch_kg,
        "ch_cli": {k: len(v) for k, v in ch_cli.items()},
        "clients_list": list(clients_map.values()),
    }


def generate_center_map(center_id, clients_list, out_path):
    """Genera mapa PNG de un CD con sus clientes coloreados por canal y el pin del CD resaltado."""
    m = StaticMap(700, 270, url_template="https://a.tile.openstreetmap.org/{z}/{x}/{y}.png")

    for c in clients_list:
        if c["has_coord"]:
            col = CHANNEL_COLORS.get(c["canal"], "#71717a")
            m.add_marker(CircleMarker((c["lng"], c["lat"]), "#ffffff", 8))
            m.add_marker(CircleMarker((c["lng"], c["lat"]), col, 6))

    # Pin del Centro de Distribución encima de los clientes para que siempre destaque
    if center_id in CD_COORDS:
        clat, clng = CD_COORDS[center_id]
        m.add_marker(CircleMarker((clng, clat), "#ffffff", 16))
        m.add_marker(CircleMarker((clng, clat), "#28174E", 13))
        m.add_marker(CircleMarker((clng, clat), "#f89b22", 6))

    img = m.render()
    img.save(out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(CSV_PATH, "r", encoding="utf-8-sig", errors="replace") as f:
        raw_rows = list(csv.reader(f))

    data = [r for r in raw_rows[1:] if any(c.strip() for c in r)]
    fecha_op = clean_str(data[0][0]).split(" ")[0] if data else datetime.now().strftime("%Y-%m-%d")

    parsed = []
    for r in data:
        if len(r) < 20:
            continue
        placa = clean_str(r[2]).upper()
        if placa == "FRT-001":
            continue
        lat, lng = to_num(r[16]), to_num(r[17])
        parsed.append({
            "centro": clean_str(r[1]),
            "placa": placa,
            "cli": clean_str(r[3]),
            "ped": clean_str(r[7]),
            "kg": to_num(r[10]),
            "soles": to_num(r[11]),
            "lat": lat,
            "lng": lng,
            "has_coord": is_valid_coord(lat, lng),
            "canal": norm_channel(r[19]),
        })

    global_m = compute_metrics(parsed)
    version_tag = datetime.now().strftime("%Y%m%d%H%M")

    # Calcular métricas y generar mapas por cada Centro
    centers_metrics = {}
    for cd in CENTERS_ORDER:
        cd_rows = [r for r in parsed if r["centro"] == cd]
        m = compute_metrics(cd_rows)
        centers_metrics[cd] = m
        map_file = f"map_{cd}.png"
        generate_center_map(cd, m["clients_list"], os.path.join(OUT_DIR, map_file))

    # Filas de la tabla comparativa de Centros
    comp_rows_html = ""
    for cd in CENTERS_ORDER:
        m = centers_metrics[cd]
        share_kg = (m["kg"] / global_m["kg"] * 100) if global_m["kg"] else 0
        comp_rows_html += f"""
          <tr>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; font-weight:800; color:#28174E;">{cd}</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right; font-weight:700;">{m['ton']:.2f} T <span style="color:#71717a; font-weight:400; font-size:11px;">({share_kg:.0f}%)</span></td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right;">S/ {m['soles']:,.0f}</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right;">{m['clientes']}</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right; font-weight:700;">{m['placas']}</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right; color:#6a1b9a; font-weight:700;">{m['drop_size']:.1f} kg</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right;">{m['cli_x_placa']:.1f}</td>
            <td style="padding:8px 10px; border-bottom:1px solid #eceaf2; text-align:right;">{m['kg_x_placa']:,.0f} kg</td>
          </tr>
        """

    # Bloques visuales por cada Centro con su mapa + KPIs + PIs
    center_cards_html = ""
    for cd in CENTERS_ORDER:
        m = centers_metrics[cd]
        map_url = f"{PAGES_BASE_URL}/reports/map_{cd}.png?v={version_tag}"
        center_cards_html += f"""
          <tr>
            <td style="padding:10px 24px 14px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7; border-radius:10px; overflow:hidden; background:#ffffff;">
                <tr>
                  <td style="background:#28174E; padding:10px 14px; color:#ffffff;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:14px; font-weight:800; color:#ffffff;">&#128205; Centro {cd}</td>
                        <td align="right" style="font-size:11px; color:#f89b22; font-weight:700;">
                          {m['placas']} Placas &bull; {m['clientes']} Clientes &bull; {m['pedidos']} Pedidos
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 14px;">
                    <!-- KPIs & PIs del Centro -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
                      <tr>
                        <td width="24%" style="background:#faf9fc; border:1px solid #eceaf2; border-radius:7px; padding:8px;">
                          <div style="font-size:10px; color:#71717a; font-weight:700;">TONELAJE</div>
                          <div style="font-size:15px; font-weight:800; color:#18181b;">{m['ton']:.2f} T</div>
                          <div style="font-size:10px; color:#52525b;">S/ {m['soles']:,.0f}</div>
                        </td>
                        <td width="1.3%"></td>
                        <td width="24%" style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:7px; padding:8px;">
                          <div style="font-size:10px; color:#6b21a8; font-weight:700;">DROP SIZE</div>
                          <div style="font-size:15px; font-weight:800; color:#6a1b9a;">{m['drop_size']:.1f} kg/cli</div>
                          <div style="font-size:10px; color:#581c87;">Ticket: S/ {m['ticket_prom']:,.0f}</div>
                        </td>
                        <td width="1.3%"></td>
                        <td width="24%" style="background:#fff7ed; border:1px solid #fed7aa; border-radius:7px; padding:8px;">
                          <div style="font-size:10px; color:#9a3412; font-weight:700;">CARGA / PLACA</div>
                          <div style="font-size:15px; font-weight:800; color:#c2410c;">{m['kg_x_placa']:,.0f} kg</div>
                          <div style="font-size:10px; color:#7c2d12;">{m['cli_x_placa']:.1f} cli/placa</div>
                        </td>
                        <td width="1.3%"></td>
                        <td width="24%" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:7px; padding:8px;">
                          <div style="font-size:10px; color:#475569; font-weight:700;">MIX CLIENTES</div>
                          <div style="font-size:10.5px; color:#18181b; line-height:1.4; margin-top:2px;">
                            <span style="color:#ef4444;">&#9679;</span> DET:<b>{m['ch_cli'].get('DET',0)}</b> &nbsp;
                            <span style="color:#2563eb;">&#9679;</span> FSE:<b>{m['ch_cli'].get('FSE',0)}</b><br>
                            <span style="color:#f97316;">&#9679;</span> MES:<b>{m['ch_cli'].get('MES',0)}</b> &nbsp;
                            <span style="color:#eab308;">&#9679;</span> MOD:<b>{m['ch_cli'].get('MOD',0)}</b>
                          </div>
                        </td>
                      </tr>
                    </table>
                    <!-- Mapa del Centro -->
                    <img src="{map_url}" width="684" alt="Mapa de clientes {cd}" style="display:block; width:100%; border-radius:8px; border:1px solid #e4e4e7;" />
                    <div style="font-size:10.5px; color:#71717a; margin-top:5px; text-align:right;">
                      <b style="color:#28174E;">&#9673; Pin Morado/Naranja:</b> Geo CD {cd} &nbsp;|&nbsp;
                      <span style="color:#ef4444;">&#9679;</span> DET &nbsp;
                      <span style="color:#2563eb;">&#9679;</span> FSE &nbsp;
                      <span style="color:#f97316;">&#9679;</span> MES &nbsp;
                      <span style="color:#eab308;">&#9679;</span> MOD
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        """

    # HTML Ejecutivo Completo para Outlook
    html = f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#f4f3f8; font-family:'Segoe UI', Arial, sans-serif; color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f3f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">

          <!-- CABECERA -->
          <tr>
            <td style="background-color:#28174E; padding:22px 26px; color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#f89b22; font-weight:700;">RoadMap &bull; Dashboard Operativo</div>
                    <h1 style="margin:4px 0 2px; font-size:22px; color:#ffffff;">Resumen Diario de Distribución &ndash; Región Lima</h1>
                    <div style="font-size:12px; color:#d4d4d8;">Fecha operativa: <b>{fecha_op}</b> &bull; Consolidado Global y Despliegue por CD</div>
                  </td>
                  <td align="right" valign="middle">
                    <a href="{PAGES_BASE_URL}/dashboard.html" style="background-color:#c61c27; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:8px; font-size:12px; font-weight:700; display:inline-block;">Abrir Dashboard</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 1: KPIs Y PIs GLOBAL REGIÓN LIMA -->
          <tr>
            <td style="padding:18px 24px 6px;">
              <h2 style="margin:0 0 10px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">1. Consolidado Región Lima (KPIs &amp; PIs)</h2>
              <!-- Fila KPIs -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
                <tr>
                  <td width="24%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #28174E; border-radius:8px; padding:10px;">
                    <div style="font-size:10.5px; color:#71717a; font-weight:700;">TONELAJE TOTAL</div>
                    <div style="font-size:19px; font-weight:800; color:#18181b;">{global_m['ton']:.2f} T</div>
                    <div style="font-size:11px; color:#52525b;">{global_m['kg']:,.0f} kg planificados</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #c61c27; border-radius:8px; padding:10px;">
                    <div style="font-size:10.5px; color:#71717a; font-weight:700;">VALORIZACIÓN</div>
                    <div style="font-size:19px; font-weight:800; color:#c61c27;">S/ {global_m['soles']:,.0f}</div>
                    <div style="font-size:11px; color:#52525b;">Ticket Prom: S/ {global_m['ticket_prom']:,.0f}</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #f89b22; border-radius:8px; padding:10px;">
                    <div style="font-size:10.5px; color:#71717a; font-weight:700;">COBERTURA</div>
                    <div style="font-size:19px; font-weight:800; color:#18181b;">{global_m['clientes']} cli.</div>
                    <div style="font-size:11px; color:#52525b;">{global_m['pedidos']} pedidos totales</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #8e24aa; border-radius:8px; padding:10px;">
                    <div style="font-size:10.5px; color:#71717a; font-weight:700;">FLOTA ACTIVA</div>
                    <div style="font-size:19px; font-weight:800; color:#6a1b9a;">{global_m['placas']} placas</div>
                    <div style="font-size:11px; color:#52525b;">Excluye FRT-001 / RES-CLI</div>
                  </td>
                </tr>
              </table>
              <!-- Fila PIs -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="32.5%" style="background:#f3e5f5; border-radius:8px; padding:8px 12px;">
                    <span style="font-size:10.5px; color:#6a1b9a; font-weight:700;">DROP SIZE GLOBAL:</span>
                    <b style="font-size:14px; color:#28174E; margin-left:4px;">{global_m['drop_size']:.1f} kg/cli</b>
                  </td>
                  <td width="1.2%"></td>
                  <td width="32.5%" style="background:#fff7ed; border-radius:8px; padding:8px 12px;">
                    <span style="font-size:10.5px; color:#c2410c; font-weight:700;">CARGA PROM. / PLACA:</span>
                    <b style="font-size:14px; color:#9a3412; margin-left:4px;">{global_m['kg_x_placa']:,.0f} kg</b>
                  </td>
                  <td width="1.2%"></td>
                  <td width="32.5%" style="background:#eff6ff; border-radius:8px; padding:8px 12px;">
                    <span style="font-size:10.5px; color:#1d4ed8; font-weight:700;">PARADAS / PLACA:</span>
                    <b style="font-size:14px; color:#1e3a8a; margin-left:4px;">{global_m['cli_x_placa']:.1f} cli/u</b>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 2: COMPARATIVO POR CENTRO -->
          <tr>
            <td style="padding:14px 24px 8px;">
              <h2 style="margin:0 0 8px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">2. Comparativo por Centro de Distribución</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#28174E; color:#ffffff;">
                  <th style="padding:8px 10px; text-align:left;">Centro</th>
                  <th style="padding:8px 10px; text-align:right;">Tonelaje</th>
                  <th style="padding:8px 10px; text-align:right;">Soles</th>
                  <th style="padding:8px 10px; text-align:right;">Clientes</th>
                  <th style="padding:8px 10px; text-align:right;">Placas</th>
                  <th style="padding:8px 10px; text-align:right;">Drop Size</th>
                  <th style="padding:8px 10px; text-align:right;">Cli/Placa</th>
                  <th style="padding:8px 10px; text-align:right;">Kg/Placa</th>
                </tr>
                {comp_rows_html}
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 3: DESPLIEGUE GEOGRÁFICO Y KPIs POR CENTRO -->
          <tr>
            <td style="padding:10px 24px 0;">
              <h2 style="margin:0 0 4px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">3. Despliegue Geográfico por Centro (Geo CD + Clientes)</h2>
            </td>
          </tr>
          {center_cards_html}

          <!-- PIE DE CORREO -->
          <tr>
            <td style="background:#faf9fc; padding:14px 24px; border-top:1px solid #e4e4e7; font-size:11px; color:#71717a; text-align:center;">
              Reporte generado automáticamente desde <b>RoadMap Dashboard Operativo</b> &bull; Región Lima (0374-ATE, 0780-ATE2, 0754-CHANCAY).
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

    with open(os.path.join(OUT_DIR, "dashboard_email.html"), "w", encoding="utf-8") as f:
        f.write(html)

    print("OK: Generados reports/dashboard_email.html y los 3 mapas por Centro.")


if __name__ == "__main__":
    main()
