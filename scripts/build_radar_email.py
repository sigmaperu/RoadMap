import csv
import math
import os
import re
from collections import defaultdict
from datetime import datetime
from staticmap import StaticMap, CircleMarker, Line

CSV_PATH = "RoadMap.csv"
OUT_DIR = "reports"
PAGES_BASE_URL = "https://sigmaperu.github.io/RoadMap"

CD_COORDS = {
    "0374-ATE":     (-12.067013, -76.979433),
    "0780-ATE2":    (-12.045125, -76.938130),
    "0754-CHANCAY": (-11.551110, -77.276417),
}

WEIGHT_RANGES = [
    ("0 a 1 kg",         0,   1),
    ("1 a 5 kg",         1,   5),
    ("5 a 10 kg",        5,   10),
    ("10 a 50 kg",       10,  50),
    ("50 a 100 kg",      50,  100),
    ("100 a 200 kg",     100, 200),
    ("Mayores a 200 kg", 200, float("inf")),
]

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


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def quantile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    pos = (len(sorted_vals) - 1) * q
    base = int(math.floor(pos))
    rest = pos - base
    if base + 1 < len(sorted_vals):
        return sorted_vals[base] + rest * (sorted_vals[base + 1] - sorted_vals[base])
    return sorted_vals[base]


def parse_time_window(raw_win):
    raw = clean_str(raw_win)
    if not raw:
        return {"raw": raw, "status": "MISSING", "narrow": False, "early": False}
    matches = re.findall(r"(\d{1,2}):(\d{2})\s*([AaPp]\.?\s*[Mm]\.?)?", raw)
    if len(matches) < 2:
        return {"raw": raw, "status": "INVALID", "narrow": False, "early": False}

    def parse_part(m):
        h, mn, mer = int(m[0]), int(m[1]), re.sub(r"[\.\s]", "", m[2]).upper()
        if mn < 0 or mn > 59:
            return None
        if mer in ("AM", "PM"):
            if h < 1 or h > 12:
                return None
            if mer == "AM" and h == 12:
                h = 0
            if mer == "PM" and h != 12:
                h += 12
        else:
            if h < 0 or h > 23:
                return None
        return h * 60 + mn, f"{h:02d}:{mn:02d}"

    s = parse_part(matches[0])
    e = parse_part(matches[1])
    if not s or not e:
        return {"raw": raw, "status": "INVALID", "narrow": False, "early": False}
    if s[0] >= e[0]:
        return {"raw": raw, "status": "REVERSED", "narrow": False, "early": False}
    dur = e[0] - s[0]
    return {
        "raw": raw,
        "status": "VALID",
        "start_str": s[1],
        "end_str": e[1],
        "start_min": s[0],
        "end_min": e[0],
        "dur": dur,
        "narrow": dur <= 120,
        "early": e[0] <= 11 * 60,
    }


def is_missing_route(val):
    u = clean_str(val).upper()
    return not u or u in {"-", "NONE", "NULL", "N/A"}


def generate_map_image(red_units, out_path):
    """Genera un mapa PNG con calles de OpenStreetMap mostrando clientes núcleo vs dispersos de placas en ROJO."""
    m = StaticMap(760, 340, url_template="https://a.tile.openstreetmap.org/{z}/{x}/{y}.png")
    added = 0

    for cd_name, (clat, clng) in CD_COORDS.items():
        m.add_marker(CircleMarker((clng, clat), "#28174E", 10))

    for u in red_units:
        cx, cy = u["centroid_lng"], u["centroid_lat"]
        for s in u["stops"]:
            if not s["has_coord"]:
                continue
            if s["is_outlier"]:
                m.add_line(Line([(cx, cy), (s["lng"], s["lat"])], "#c61c27", 2))
                m.add_marker(CircleMarker((s["lng"], s["lat"]), "#c61c27", 9))
            else:
                m.add_marker(CircleMarker((s["lng"], s["lat"]), "#10b981", 6))
            added += 1

    if added == 0:
        m.add_marker(CircleMarker((-76.979433, -12.067013), "#8e24aa", 10))

    image = m.render()
    image.save(out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(CSV_PATH, "r", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.reader(f))

    header, data = rows[0], [r for r in rows[1:] if any(c.strip() for c in r)]

    # Índices estándar de RoadMap.csv
    IDX = {
        "FECHA": 0, "CENTRO": 1, "PLACA": 2, "CLIENTE": 3, "NOMBRE": 4,
        "RUTA": 6, "PEDIDO": 7, "KG": 10, "SOLES": 11, "CIUDAD": 14,
        "DIR": 15, "LAT": 16, "LNG": 17, "VENTANA": 18, "CANAL": 19,
    }
    for i, h in enumerate(header):
        u = clean_str(h).upper()
        if "VENTANA" in u or "HORARIO" in u:
            IDX["VENTANA"] = i
        if "DISTRITO" in u or "CIUDAD" in u:
            IDX["CIUDAD"] = i

    fecha_op = clean_str(data[0][IDX["FECHA"]]).split(" ")[0] if data else datetime.now().strftime("%Y-%m-%d")

    frt_rows = [r for r in data if clean_str(r[IDX["PLACA"]]).upper() == "FRT-001"]
    valid_rows = [r for r in data if clean_str(r[IDX["PLACA"]]).upper() != "FRT-001"]

    frt_kg = sum(to_num(r[IDX["KG"]]) for r in frt_rows)
    total_kg = sum(to_num(r[IDX["KG"]]) for r in valid_rows)

    # Consolidación por cliente
    clients_map = {}
    for r in valid_rows:
        cli = clean_str(r[IDX["CLIENTE"]])
        if not cli:
            continue
        lat, lng = to_num(r[IDX["LAT"]]), to_num(r[IDX["LNG"]])
        if cli not in clients_map:
            clients_map[cli] = {
                "cod": cli,
                "nombre": clean_str(r[IDX["NOMBRE"]]) or cli,
                "centro": clean_str(r[IDX["CENTRO"]]),
                "ruta": clean_str(r[IDX["RUTA"]]) or "-",
                "placa": clean_str(r[IDX["PLACA"]]).upper(),
                "canal": norm_channel(r[IDX["CANAL"]]),
                "ciudad": clean_str(r[IDX["CIUDAD"]]) or "-",
                "win": parse_time_window(r[IDX["VENTANA"]]),
                "lat": lat, "lng": lng,
                "has_coord": is_valid_coord(lat, lng),
                "kg": 0.0, "soles": 0.0,
            }
        clients_map[cli]["kg"] += to_num(r[IDX["KG"]])
        clients_map[cli]["soles"] += to_num(r[IDX["SOLES"]])

    clients = list(clients_map.values())

    # 1. Rangos de peso
    range_rows_html = []
    max_rng_cli = 1
    range_data = []
    for label, mn, mx in WEIGHT_RANGES:
        m = [c for c in clients if (mn <= c["kg"] <= mx if mn == 0 else mn < c["kg"] <= mx)]
        by_ch = defaultdict(int)
        for c in m:
            by_ch[c["canal"]] += 1
        max_rng_cli = max(max_rng_cli, len(m))
        range_data.append((label, m, by_ch))

    for label, m, by_ch in range_data:
        pct = (len(m) / max(1, len(clients))) * 100
        ton = sum(c["kg"] for c in m) / 1000.0
        bar_w = int((len(m) / max_rng_cli) * 100)
        range_rows_html.append(f"""
          <tr>
            <td style="padding:7px 10px; border-bottom:1px solid #eceaf2; font-weight:700; color:#18181b;">{label}</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eceaf2; text-align:right; font-weight:700;">{len(m)} ({pct:.1f}%)</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eceaf2; text-align:right;">{ton:.2f} T</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eceaf2; font-size:11px; color:#52525b;">
              DET:<b>{by_ch['DET']}</b> &bull; FSE:<b>{by_ch['FSE']}</b> &bull; MES:<b>{by_ch['MES']}</b> &bull; MOD:<b>{by_ch['MOD']}</b>
            </td>
            <td style="padding:7px 10px; border-bottom:1px solid #eceaf2; width:110px;">
              <div style="background:#eceaf2; height:8px; border-radius:4px; width:100%;">
                <div style="background:#8e24aa; height:8px; border-radius:4px; width:{bar_w}%;"></div>
              </div>
            </td>
          </tr>
        """)

    # 2. Clientes con <= 1 kg facturado
    clients_1kg = sorted([c for c in clients if c["kg"] <= 1.0], key=lambda x: x["kg"])

    # 3. Calidad de datos (VH inválida/vacía, sin canal, sin ruta, sin coords, FRT-001)
    bad_vh_canal_ruta = []
    for c in clients:
        obs = []
        if c["win"]["status"] == "MISSING":
            obs.append("Sin VH")
        elif c["win"]["status"] != "VALID":
            obs.append(f"VH inválida ({c['win']['raw']})")
        if c["canal"] == "OTRO":
            obs.append("Sin Canal")
        if is_missing_route(c["ruta"]):
            obs.append("Sin Ruta Venta")
        if obs:
            bad_vh_canal_ruta.append((c, " + ".join(obs)))

    bad_coords_clients = [c for c in clients if not c["has_coord"]]

    # 4. Análisis por Placa (Radar de Riesgo)
    units_map = {}
    for r in valid_rows:
        placa = clean_str(r[IDX["PLACA"]]).upper()
        if not placa or placa in TRUCKS_EXCLUDED:
            continue
        centro = clean_str(r[IDX["CENTRO"]])
        key = f"{centro}|{placa}"
        if key not in units_map:
            units_map[key] = {
                "centro": centro, "placa": placa, "kg": 0.0,
                "channels": set(), "stops": {}
            }
        u = units_map[key]
        u["kg"] += to_num(r[IDX["KG"]])
        u["channels"].add(norm_channel(r[IDX["CANAL"]]))
        cli = clean_str(r[IDX["CLIENTE"]])
        if cli and cli not in u["stops"]:
            lat, lng = to_num(r[IDX["LAT"]]), to_num(r[IDX["LNG"]])
            u["stops"][cli] = {
                "cod": cli, "nombre": clean_str(r[IDX["NOMBRE"]]) or cli,
                "win": parse_time_window(r[IDX["VENTANA"]]),
                "lat": lat, "lng": lng, "has_coord": is_valid_coord(lat, lng),
                "kg": 0.0, "is_outlier": False
            }
        if cli:
            u["stops"][cli]["kg"] += to_num(r[IDX["KG"]])

    unit_audits = []
    for u in units_map.values():
        stops = list(u["stops"].values())
        valid_s = [s for s in stops if s["has_coord"]]
        miss_c = len(stops) - len(valid_s)
        crit_w = [s for s in stops if s["win"]["status"] == "VALID" and (s["win"]["narrow"] or s["win"]["early"])]
        inv_w = [s for s in stops if s["win"]["status"] in ("INVALID", "REVERSED")]

        cent_lat = sum(s["lat"] for s in valid_s) / len(valid_s) if valid_s else 0.0
        cent_lng = sum(s["lng"] for s in valid_s) / len(valid_s) if valid_s else 0.0

        max_diam = 0.0
        for i in range(len(valid_s)):
            for j in range(i + 1, len(valid_s)):
                d = haversine_km(valid_s[i]["lat"], valid_s[i]["lng"], valid_s[j]["lat"], valid_s[j]["lng"])
                if d > max_diam:
                    max_diam = d

        dists = sorted(haversine_km(cent_lat, cent_lng, s["lat"], s["lng"]) for s in valid_s)
        q1, q3 = quantile(dists, 0.25), quantile(dists, 0.75)
        thr = max(4.5, q3 + 1.5 * (q3 - q1))

        outliers = 0
        for s in valid_s:
            d = haversine_km(cent_lat, cent_lng, s["lat"], s["lng"])
            if len(valid_s) >= 4 and d > thr:
                s["is_outlier"] = True
                outliers += 1

        max_cli_kg = max((s["kg"] for s in stops), default=0.0)
        max_share = (max_cli_kg / u["kg"] * 100) if u["kg"] > 0 else 0.0

        geo_s = min(100, outliers * 34 + (25 if max_diam > 16 else 0))
        win_s = min(100, len(crit_w) * 18 + len(inv_w) * 35)
        comp_s = min(100, (45 if len(stops) > 35 else 25 if len(stops) > 25 else 10) + (25 if len(u["channels"]) >= 3 else 0))
        bal_s = min(100, (65 if u["kg"] < 400 else 0) + (35 if max_share > 50 else 0))
        dq_s = min(100, miss_c * 35 + len(inv_w) * 35)

        score = round(geo_s * 0.33 + win_s * 0.33 + comp_s * 0.14 + bal_s * 0.12 + dq_s * 0.08)
        if outliers >= 2 or len(crit_w) >= 5:
            score = max(score, 62)

        if len(valid_s) == 0:
            sem = "NEGRO"
        elif score >= 61:
            sem = "ROJO"
        elif score >= 31:
            sem = "AMARILLO"
        else:
            sem = "VERDE"

        unit_audits.append({
            **u, "stops": stops, "client_count": len(stops),
            "centroid_lat": cent_lat, "centroid_lng": cent_lng,
            "max_diam": max_diam, "outliers": outliers,
            "crit_win": len(crit_w), "score": score, "sem": sem,
        })

    red_units = sorted([u for u in unit_audits if u["sem"] == "ROJO"], key=lambda x: -x["score"])
    black_units = [u for u in unit_audits if u["sem"] == "NEGRO"]

    # 5. Clientes prioritarios por VH restrictiva (<=2h o cierre <=11:00)
    prio_win = sorted(
        [c for c in clients if c["win"]["status"] == "VALID" and (c["win"]["narrow"] or c["win"]["early"])],
        key=lambda x: (x["win"]["end_min"], x["win"]["dur"])
    )

    # Generar mapa PNG de placas en ROJO
    map_png_path = os.path.join(OUT_DIR, "mapa_riesgo.png")
    generate_map_image(red_units, map_png_path)
    map_url = f"{PAGES_BASE_URL}/reports/mapa_riesgo.png?v={datetime.now().strftime('%Y%m%d%H%M')}"

    # Exportar CSV adjuntable de incidencias
    csv_out_path = os.path.join(OUT_DIR, "incidencias_radar.csv")
    with open(csv_out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Tipo", "Centro", "Ruta", "Placa", "Codigo", "Cliente", "Canal", "Kg", "Ventana", "Observacion"])
        for c, obs in bad_vh_canal_ruta:
            w.writerow(["CALIDAD", c["centro"], c["ruta"], c["placa"], c["cod"], c["nombre"], c["canal"], f"{c['kg']:.2f}", c["win"]["raw"], obs])
        for c in clients_1kg:
            w.writerow(["CARGA <=1KG", c["centro"], c["ruta"], c["placa"], c["cod"], c["nombre"], c["canal"], f"{c['kg']:.2f}", c["win"]["raw"], "Pedido de 1 kg o menos"])

    # Filas HTML de Placas en Rojo
    red_rows_html = "".join(
        f"""
        <tr>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; font-weight:700; color:#28174E;">{u['centro']}</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; font-weight:800; color:#18181b;">{u['placa']}</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:right;">{u['client_count']}</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:right;">{u['kg']:,.0f} kg</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:right;">{u['max_diam']:.1f} km</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:right; color:#c61c27; font-weight:700;">{u['outliers']}</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:right; color:#d97706; font-weight:700;">{u['crit_win']}</td>
          <td style="padding:7px 8px; border-bottom:1px solid #eceaf2; text-align:center;">
            <span style="background:#fee2e2; color:#c61c27; padding:2px 8px; border-radius:10px; font-weight:800; font-size:11px;">{u['score']}/100 ROJO</span>
          </td>
        </tr>
        """ for u in red_units[:15]
    ) or '<tr><td colspan="8" style="padding:12px; text-align:center; color:#10b981; font-weight:700;">Sin placas en Semáforo Rojo.</td></tr>'

    # Filas HTML de Clientes <= 1 kg (Top 15)
    c1kg_rows_html = "".join(
        f"""
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;"><b>{c['cod']}</b> &ndash; {c['nombre']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;">{c['canal']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;">{c['ruta']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;">{c['centro']} / <b>{c['placa']}</b></td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2; text-align:right; font-weight:700;">{c['kg']:.2f} kg</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2; text-align:right;">S/ {c['soles']:,.0f}</td>
        </tr>
        """ for c in clients_1kg[:15]
    ) or '<tr><td colspan="6" style="padding:10px; text-align:center; color:#71717a;">Sin clientes en tramo 0 a 1 kg.</td></tr>'

    # Filas HTML de Prioritarios por VH Restrictiva (Top 15)
    prio_rows_html = "".join(
        f"""
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;"><b>{c['cod']}</b> &ndash; {c['nombre']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2;">{c['centro']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2; font-weight:700;">{c['placa']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2; color:#c61c27; font-weight:800;">{c['win']['start_str']} - {c['win']['end_str']}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eceaf2; text-align:right;">{c['kg']:.1f} kg</td>
        </tr>
        """ for c in prio_win[:15]
    ) or '<tr><td colspan="5" style="padding:10px; text-align:center; color:#71717a;">Sin ventanas restrictivas detectadas.</td></tr>'

    # HTML Ejecutivo 100% compatible con Outlook Desktop
    html = f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#f4f3f8; font-family:'Segoe UI', Arial, sans-serif; color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f3f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
          
          <!-- CABECERA CORPORATIVA -->
          <tr>
            <td style="background-color:#28174E; padding:22px 26px; color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#f89b22; font-weight:700;">RoadMap &bull; Radar de Distribución</div>
                    <h1 style="margin:4px 0 2px; font-size:22px; color:#ffffff;">Resumen Ejecutivo de Planificación</h1>
                    <div style="font-size:12px; color:#d4d4d8;">Fecha operativa: <b>{fecha_op}</b> &bull; Región Lima (ATE, ATE2, CHANCAY)</div>
                  </td>
                  <td align="right" valign="middle">
                    <a href="{PAGES_BASE_URL}/radar.html" style="background-color:#c61c27; color:#ffffff; text-decoration:none; padding:10px 16px; border-radius:8px; font-size:12px; font-weight:700; display:inline-block;">Abrir Radar Web</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI CARDS -->
          <tr>
            <td style="padding:18px 24px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="24%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #28174E; border-radius:8px; padding:10px;">
                    <div style="font-size:11px; color:#71717a; font-weight:700;">CARGA PLANIFICADA</div>
                    <div style="font-size:18px; font-weight:800; color:#18181b;">{total_kg/1000:.1f} T</div>
                    <div style="font-size:11px; color:#52525b;">{len(clients)} clientes / {len(unit_audits)} placas</div>
                  </td>
                  <td width="2%"></td>
                  <td width="24%" style="background:#fef2f2; border:1px solid #fecaca; border-top:3px solid #c61c27; border-radius:8px; padding:10px;">
                    <div style="font-size:11px; color:#991b1b; font-weight:700;">PLACAS EN ROJO</div>
                    <div style="font-size:18px; font-weight:800; color:#c61c27;">{len(red_units)} placas</div>
                    <div style="font-size:11px; color:#7f1d1d;">+{len(black_units)} en Semáforo Negro</div>
                  </td>
                  <td width="2%"></td>
                  <td width="24%" style="background:#fffbeb; border:1px solid #fde68a; border-top:3px solid #f89b22; border-radius:8px; padding:10px;">
                    <div style="font-size:11px; color:#92400e; font-weight:700;">VH / CANAL / RUTA</div>
                    <div style="font-size:18px; font-weight:800; color:#b45309;">{len(bad_vh_canal_ruta)} cli.</div>
                    <div style="font-size:11px; color:#78350f;">{len(bad_coords_clients)} sin coordenadas</div>
                  </td>
                  <td width="2%"></td>
                  <td width="24%" style="background:#faf5ff; border:1px solid #e9d5ff; border-top:3px solid #8e24aa; border-radius:8px; padding:10px;">
                    <div style="font-size:11px; color:#6b21a8; font-weight:700;">EXCLUIDOS FRT-001</div>
                    <div style="font-size:18px; font-weight:800; color:#6a1b9a;">{len(frt_rows)} filas</div>
                    <div style="font-size:11px; color:#581c87;">{frt_kg:.1f} kg excluidos</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 1: MAPA + PLACAS EN ROJO -->
          <tr>
            <td style="padding:14px 24px;">
              <h2 style="margin:0 0 8px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">1. Radar de Riesgo: Placas en Semáforo Rojo y Mapa de Dispersión</h2>
              <p style="margin:0 0 10px; font-size:12px; color:#52525b;">
                Puntos en <b style="color:#c61c27;">Rojo</b> indican clientes atípicos que generan dispersión en las placas críticas; <b style="color:#10b981;">Verde</b> indica el núcleo de la ruta; <b style="color:#28174E;">Morado</b> indica los CDs.
              </p>
              <img src="{map_url}" width="712" alt="Mapa de Dispersión de Placas en Rojo" style="display:block; width:100%; border-radius:8px; border:1px solid #e4e4e7; margin-bottom:12px;" />
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#28174E; color:#ffffff;">
                  <th style="padding:7px 8px; text-align:left;">Centro</th>
                  <th style="padding:7px 8px; text-align:left;">Placa</th>
                  <th style="padding:7px 8px; text-align:right;">Cli.</th>
                  <th style="padding:7px 8px; text-align:right;">Peso</th>
                  <th style="padding:7px 8px; text-align:right;">Dispersión</th>
                  <th style="padding:7px 8px; text-align:right;">Atíp.</th>
                  <th style="padding:7px 8px; text-align:right;">VH Crít.</th>
                  <th style="padding:7px 8px; text-align:center;">Estado</th>
                </tr>
                {red_rows_html}
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 2: RANGOS DE PESO -->
          <tr>
            <td style="padding:8px 24px 14px;">
              <h2 style="margin:0 0 8px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">2. Distribución por Rangos de Peso (Kg) y Canal</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#f4f4f5; color:#3f3f46;">
                  <th style="padding:7px 10px; text-align:left;">Tramo de Peso</th>
                  <th style="padding:7px 10px; text-align:right;">Clientes</th>
                  <th style="padding:7px 10px; text-align:right;">Tonelaje</th>
                  <th style="padding:7px 10px; text-align:left;">Desglose Canal</th>
                  <th style="padding:7px 10px; text-align:left;">Peso Visual</th>
                </tr>
                {''.join(range_rows_html)}
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 3: CLIENTES QUE SOLO LLEVAN <= 1 KG -->
          <tr>
            <td style="padding:8px 24px 14px;">
              <h2 style="margin:0 0 8px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">3. Clientes con 1 kg o menos Facturado ({len(clients_1kg)} detectados &ndash; Top 15)</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:11.5px;">
                <tr style="background:#f4f4f5; color:#3f3f46;">
                  <th style="padding:6px 8px; text-align:left;">Cliente</th>
                  <th style="padding:6px 8px; text-align:left;">Canal</th>
                  <th style="padding:6px 8px; text-align:left;">Ruta</th>
                  <th style="padding:6px 8px; text-align:left;">Centro / Placa</th>
                  <th style="padding:6px 8px; text-align:right;">Peso</th>
                  <th style="padding:6px 8px; text-align:right;">Soles</th>
                </tr>
                {c1kg_rows_html}
              </table>
            </td>
          </tr>

          <!-- SECCIÓN 4: CLIENTES PRIORITARIOS POR VH RESTRICTIVA -->
          <tr>
            <td style="padding:8px 24px 18px;">
              <h2 style="margin:0 0 8px; font-size:15px; color:#28174E; border-bottom:2px solid #f3e5f5; padding-bottom:4px;">4. Clientes Prioritarios por Ventana Horaria Restrictiva ({len(prio_win)} en total &ndash; Top 15)</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:11.5px;">
                <tr style="background:#f4f4f5; color:#3f3f46;">
                  <th style="padding:6px 8px; text-align:left;">Cliente</th>
                  <th style="padding:6px 8px; text-align:left;">Centro</th>
                  <th style="padding:6px 8px; text-align:left;">Placa</th>
                  <th style="padding:6px 8px; text-align:left;">Ventana (24h)</th>
                  <th style="padding:6px 8px; text-align:right;">Peso</th>
                </tr>
                {prio_rows_html}
              </table>
            </td>
          </tr>

          <!-- PIE DE CORREO -->
          <tr>
            <td style="background:#faf9fc; padding:14px 24px; border-top:1px solid #e4e4e7; font-size:11px; color:#71717a; text-align:center;">
              Reporte generado automáticamente desde <b>RoadMap Radar de Distribución</b> &bull; Se adjunta CSV con el detalle completo de incidencias (VH, sin canal/ruta y pedidos &le;1 kg).
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

    with open(os.path.join(OUT_DIR, "radar_email.html"), "w", encoding="utf-8") as f:
        f.write(html)

    print("OK: Generados reports/radar_email.html, reports/mapa_riesgo.png y reports/incidencias_radar.csv")


if __name__ == "__main__":
    main()
