import csv
import os
import sys
from datetime import datetime

CSV_PATH = "RoadMap.csv"
OUT_DIR = "reports"
HIST_PATH = os.path.join(OUT_DIR, "historial_cambios.csv")
HTML_PATH = os.path.join(OUT_DIR, "cambios_email.html")

MOTIVO_PROVEEDOR = "Disponibilidad / designación de flota del proveedor"
MOTIVO_REFUERZO_DEFAULT = "Sobrecarga volumétrica / límite de apilamiento de cajas de cartón"


def to_num(val):
    try:
        return float(str(val or "0").replace(",", ".").strip())
    except ValueError:
        return 0.0


def clean_str(val):
    return str(val or "").strip()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    centro_sel = clean_str(os.environ.get("CENTRO", "Todos")) or "Todos"
    cambios_raw = clean_str(os.environ.get("CAMBIOS_RAW", ""))
    motivo_refuerzo = clean_str(os.environ.get("MOTIVO", "")) or MOTIVO_REFUERZO_DEFAULT

    if not cambios_raw:
        print("Sin cambios recibidos.")
        sys.exit(0)

    # 1. Leer RoadMap.csv y filtrar por el Centro seleccionado
    with open(CSV_PATH, "r", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.reader(f))

    data = [r for r in rows[1:] if len(r) > 10 and any(c.strip() for c in r)]
    fecha_op = clean_str(data[0][0]).split(" ")[0] if data else datetime.now().strftime("%d/%m/%Y")

    plate_info = {}
    for r in data:
        centro_row = clean_str(r[1])
        if centro_sel.upper() != "TODOS" and centro_row.upper() != centro_sel.upper():
            continue

        placa = clean_str(r[2]).upper()
        if not placa:
            continue
        if placa not in plate_info:
            plate_info[placa] = {"kg": 0.0, "clientes": {}, "centros": set()}
        plate_info[placa]["kg"] += to_num(r[10])
        plate_info[placa]["centros"].add(centro_row)
        cli_cod = clean_str(r[3])
        cli_nom = clean_str(r[4]) or cli_cod
        if cli_cod:
            plate_info[placa]["clientes"][cli_cod] = cli_nom

    # 2. Parsear líneas enviadas desde Teams y asignar motivo según tipo de cambio
    registros = []
    for line in cambios_raw.splitlines():
        line = line.strip()
        if not line:
            continue
        sep = "->" if "->" in line else (":" if ":" in line else None)
        if not sep:
            continue
        orig, nuevo = [p.strip().upper() for p in line.split(sep, 1)]
        info = plate_info.get(orig, {"kg": 0.0, "clientes": {}, "centros": set()})
        clientes_unicos = list(info["clientes"].values())
        es_refuerzo = "|" in nuevo or "+" in nuevo
        centro_label = centro_sel if centro_sel.upper() != "TODOS" else (", ".join(sorted(info["centros"])) or "-")

        motivo_fila = motivo_refuerzo if es_refuerzo else MOTIVO_PROVEEDOR

        registros.append({
            "fecha": fecha_op,
            "centro": centro_label,
            "orig": orig,
            "cambio": nuevo,
            "tipo": "Refuerzo / Unidad Extra" if es_refuerzo else "Cambio de Placa",
            "motivo": motivo_fila,
            "es_refuerzo": es_refuerzo,
            "kg": info["kg"],
            "n_cli": len(clientes_unicos),
            "clientes_str": "; ".join(clientes_unicos) if clientes_unicos else f"No encontrado en {centro_sel}",
        })

    # 3. Guardar en historial acumulado (reports/historial_cambios.csv)
    file_exists = os.path.isfile(HIST_PATH)
    with open(HIST_PATH, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        if not file_exists:
            w.writerow(["Fecha", "Centro", "Unidad / Placa", "Cambio", "Kg planificados", "Clientes planificados", "Clientes asociados", "Motivo"])
        for reg in registros:
            w.writerow([reg["fecha"], reg["centro"], reg["orig"], reg["cambio"], f"{reg['kg']:.2f}", reg["n_cli"], reg["clientes_str"], reg["motivo"]])

    # 4. Construir resumen dinámico de motivo
    total_kg = sum(r["kg"] for r in registros)
    total_refuerzos = sum(1 for r in registros if r["es_refuerzo"])
    total_cambios_1a1 = len(registros) - total_refuerzos
    centro_titulo = f"Centro {centro_sel}" if centro_sel.upper() != "TODOS" else "Región Lima (Todos los Centros)"

    if total_refuerzos == 0:
        resumen_motivo = f"{MOTIVO_PROVEEDOR}."
    elif total_cambios_1a1 == 0:
        resumen_motivo = f"{motivo_refuerzo}."
    else:
        resumen_motivo = f"Cambios 1 a 1 por {MOTIVO_PROVEEDOR.lower()}; refuerzos adicionales por {motivo_refuerzo.lower()}."

    rows_html = ""
    for reg in registros:
        badge_bg = "#fef2f2" if reg["es_refuerzo"] else "#f3e5f5"
        badge_col = "#c61c27" if reg["es_refuerzo"] else "#6a1b9a"
        rows_html += f"""
          <tr>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; white-space:nowrap;">{reg['fecha']}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; font-weight:700; color:#28174E; white-space:nowrap;">{reg['centro']}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; font-weight:700; color:#52525b; white-space:nowrap;">{reg['orig']}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; font-weight:800; color:#28174E; white-space:nowrap;">
              {reg['cambio']}<br>
              <span style="background:{badge_bg}; color:{badge_col}; font-size:10px; padding:1px 6px; border-radius:8px; font-weight:700;">{reg['tipo']}</span>
            </td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; font-size:11px; color:#52525b;">{reg['motivo']}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:700; white-space:nowrap;">{reg['kg']:,.2f}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; text-align:center; font-weight:700;">{reg['n_cli']}</td>
            <td style="padding:8px 8px; border-bottom:1px solid #e4e4e7; font-size:11px; color:#3f3f46;">{reg['clientes_str']}</td>
          </tr>
        """

    html = f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#f4f3f8; font-family:'Segoe UI', Arial, sans-serif; color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f3f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="840" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
          
          <!-- CABECERA -->
          <tr>
            <td style="background-color:#28174E; padding:20px 24px; color:#ffffff;">
              <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#f89b22; font-weight:700;">Distribución Lima &bull; {centro_titulo}</div>
              <h1 style="margin:4px 0 2px; font-size:20px; color:#ffffff;">Notificación Diaria de Cambios y Refuerzos de Unidades</h1>
              <div style="font-size:12px; color:#d4d4d8;">Fecha operativa: <b>{fecha_op}</b> &bull; Sede: <b>{centro_sel}</b></div>
            </td>
          </tr>

          <!-- RESUMEN -->
          <tr>
            <td style="padding:16px 24px 10px;">
              <p style="margin:0 0 12px; font-size:13px; color:#27272a; line-height:1.5;">
                Estimado, comparto el detalle de los cambios de placa y refuerzos de flota ejecutados en la programación de hoy para <b>{centro_titulo}</b>:
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
                <tr>
                  <td width="32%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #28174E; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#71717a; font-weight:700;">UNIDADES MODIFICADAS</div>
                    <div style="font-size:18px; font-weight:800; color:#18181b;">{len(registros)} placas</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#fef2f2; border:1px solid #fecaca; border-top:3px solid #c61c27; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#991b1b; font-weight:700;">REFUERZOS / EXTRAS</div>
                    <div style="font-size:18px; font-weight:800; color:#c61c27;">{total_refuerzos} unidades</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#faf5ff; border:1px solid #e9d5ff; border-top:3px solid #8e24aa; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#6b21a8; font-weight:700;">CARGA IMPACTADA</div>
                    <div style="font-size:18px; font-weight:800; color:#6a1b9a;">{total_kg:,.2f} kg</div>
                  </td>
                </tr>
              </table>

              <div style="background:#fffbeb; border-left:4px solid #f89b22; padding:10px 12px; border-radius:6px; font-size:12px; color:#78350f; margin-bottom:14px;">
                <b>Motivo / Observación:</b> {resumen_motivo}
              </div>

              <!-- TABLA DE CAMBIOS -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#16365c; color:#ffffff;">
                  <th style="padding:8px 8px; text-align:left;">Fecha</th>
                  <th style="padding:8px 8px; text-align:left;">Centro</th>
                  <th style="padding:8px 8px; text-align:left;">Unidad / Placa</th>
                  <th style="padding:8px 8px; text-align:left;">Cambio</th>
                  <th style="padding:8px 8px; text-align:left;">Motivo</th>
                  <th style="padding:8px 8px; text-align:right;">Kg planif.</th>
                  <th style="padding:8px 8px; text-align:center;">Cli.</th>
                  <th style="padding:8px 8px; text-align:left;">Clientes asociados</th>
                </tr>
                {rows_html}
              </table>
            </td>
          </tr>

          <!-- PIE -->
          <tr>
            <td style="background:#faf9fc; padding:12px 24px; border-top:1px solid #e4e4e7; font-size:11px; color:#71717a; text-align:center;">
              Registro consolidado automáticamente con la programación de <b>RoadMap</b>.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"OK: Correo HTML de cambios ({centro_sel}) y respaldo histórico generados.")


if __name__ == "__main__":
    main()
