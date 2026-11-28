import csv
import glob
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

SAP_TXT_PATH = os.environ.get("SAP_TXT_PATH", "data/sap_deb.txt")
ROADMAP_PATH = os.environ.get("ROADMAP_PATH", "RoadMap.csv")
TOP_N = int(os.environ.get("TOP_N", "5"))
ARCHIVO_ORIGEN = os.environ.get("ARCHIVO_ORIGEN", os.path.basename(SAP_TXT_PATH))

OUT_DIR = "reports"
STATE_PATH = os.path.join(OUT_DIR, "alerta_rechazos_estado.json")
EXCLUDED_PLATES = {"FRT-001", "RES-CLI"}
LIMA_TZ = timezone(timedelta(hours=-5))

# Configura aquí los correos por CD (separados por ";")
DESTINATARIOS_POR_CENTRO = {
    "ATE": "juzambrano@sigma-alimentos.com; bbracamonte@sigma-alimentos.com; hjimenezv@sigma-alimentos.com; alortega@sigma-alimentos.com",
    "ATE2": "juzambrano@sigma-alimentos.com; bbracamonte@sigma-alimentos.com; hjimenezv@sigma-alimentos.com; alortega@sigma-alimentos.com; rzavaleta@sigma-alimentos.com; yventura@sigma-alimentos.com",
    "CHANCAY": "juzambrano@sigma-alimentos.com; bbracamonte@sigma-alimentos.com; hjimenezv@sigma-alimentos.com; alortega@sigma-alimentos.com; mvelasquez1@sigma-alimentos.com",
    "DEFAULT": "mdavilab@sigma-alimentos.com",
}


def norm_key(text):
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def clean_id(val):
    s = str(val or "").strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s


def clean_num_id(val):
    s = clean_id(val)
    if s.isdigit():
        return s.lstrip("0") or "0"
    return s


def safe_slug(val):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(val or "CD")).strip("_")


def get_destinatarios(centro):
    c = str(centro or "").upper()
    if c in DESTINATARIOS_POR_CENTRO:
        return DESTINATARIOS_POR_CENTRO[c]
    if "780" in c or "ATE2" in c or "ATE 2" in c or "ATE 02" in c:
        return DESTINATARIOS_POR_CENTRO.get("ATE2", DESTINATARIOS_POR_CENTRO["DEFAULT"])
    if "754" in c or "CHANCAY" in c:
        return DESTINATARIOS_POR_CENTRO.get("CHANCAY", DESTINATARIOS_POR_CENTRO["DEFAULT"])
    if "374" in c or "ATE" in c:
        return DESTINATARIOS_POR_CENTRO.get("ATE", DESTINATARIOS_POR_CENTRO["DEFAULT"])
    return DESTINATARIOS_POR_CENTRO["DEFAULT"]


def to_kg(val):
    s = str(val or "").strip().replace(",", "")
    if not s:
        return 0.0
    neg = False
    if s.endswith("-"):
        neg = True
        s = s[:-1].strip()
    try:
        n = float(s)
        return -n if neg else n
    except ValueError:
        return 0.0


def read_text_auto(path):
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, "r", encoding="latin-1", errors="replace") as f:
        return f.read()


def find_col(headers_norm, candidates):
    for cand in candidates:
        for idx, h in enumerate(headers_norm):
            if h == cand or cand in h:
                return idx
    return None


def load_roadmap(path):
    text = read_text_auto(path)
    sample = text[:4096]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    rows = list(csv.reader(text.splitlines(), delimiter=delim))
    if not rows:
        return {}, {}

    headers_norm = [norm_key(h) for h in rows[0]]
    idx_centro = find_col(headers_norm, ["location", "centro", "cd", "sede", "ce"])
    idx_placa = find_col(headers_norm, ["vehiclekey", "placa", "vehiculo", "unidad"])
    idx_canal = find_col(headers_norm, ["canal"])
    idx_ruta = find_col(headers_norm, ["rutaventa", "ruta", "rutadeventa"])
    idx_pedido = find_col(headers_norm, ["shipmentcustom", "doccomer", "pedido", "shipment", "entrega", "nropedido", "numpedido", "documento"])
    idx_cli_nom = find_col(headers_norm, ["customername", "nombrecliente", "cliente"])
    idx_mat = find_col(headers_norm, ["itemid", "material", "sku", "codmaterial", "codproducto"])
    idx_desc = find_col(headers_norm, ["itemdescription", "descripcion", "descmaterial", "producto", "nombreproducto", "denominacion"])

    if idx_pedido is None or idx_placa is None:
        raise RuntimeError(f"Columnas clave no encontradas en RoadMap.csv. Cabeceras: {rows[0]}")

    pedido_map = {}
    sku_desc = {}

    for r in rows[1:]:
        if len(r) <= max(idx_pedido, idx_placa):
            continue
        ped = clean_num_id(r[idx_pedido])
        placa = clean_id(r[idx_placa]).upper()
        if not ped or not placa or placa in EXCLUDED_PLATES:
            continue

        centro = clean_id(r[idx_centro]).upper() if idx_centro is not None and idx_centro < len(r) else "SIN-CENTRO"
        canal = clean_id(r[idx_canal]) if idx_canal is not None and idx_canal < len(r) else "-"
        ruta = clean_id(r[idx_ruta]) if idx_ruta is not None and idx_ruta < len(r) else "-"
        cli_nom_rm = clean_id(r[idx_cli_nom]) if idx_cli_nom is not None and idx_cli_nom < len(r) else ""

        if ped not in pedido_map:
            pedido_map[ped] = {
                "centro": centro,
                "placa": placa,
                "canal": canal,
                "ruta": ruta,
                "cliente_nom_rm": cli_nom_rm,
            }

        if idx_mat is not None and idx_desc is not None and max(idx_mat, idx_desc) < len(r):
            m_cod = clean_num_id(r[idx_mat])
            m_desc = clean_id(r[idx_desc])
            if m_cod and m_desc and m_cod not in sku_desc:
                sku_desc[m_cod] = m_desc

    return pedido_map, sku_desc


def parse_sap_txt(path):
    lines = read_text_auto(path).splitlines()
    header_idx = None
    col_map = {}

    for i, line in enumerate(lines[:15]):
        parts = line.split("\t")
        normed = [norm_key(p) for p in parts]
        if "doccomer" in normed and "clpedido" in normed:
            header_idx = i
            for idx, h in enumerate(normed):
                if h == "ce":
                    col_map["ce"] = idx
                elif h == "cliente":
                    col_map["cliente"] = idx
                elif "solic" in h:
                    col_map["cliente_nom"] = idx
                elif h == "material":
                    col_map["material"] = idx
                elif h == "doccomer":
                    col_map["doc_comer"] = idx
                elif "entrega" in h:
                    col_map["fe_entrega"] = idx
                elif h == "pedido":
                    col_map["pedido_kg"] = idx
                elif h == "surtido":
                    col_map["surtido_kg"] = idx
                elif h == "factura":
                    col_map["factura"] = idx
                elif h == "clpedido":
                    col_map["cl_pedido"] = idx
                elif h == "referencia":
                    col_map["referencia"] = idx
                elif h == "util":
                    col_map["util"] = idx
                elif h.startswith("denominaci"):
                    col_map["motivo"] = idx
            break

    if header_idx is None:
        raise RuntimeError("No se encontró la cabecera SAP ('Doc.comer.' y 'Cl Pedido').")

    def get_val(parts, key):
        idx = col_map.get(key)
        return parts[idx].strip() if idx is not None and idx < len(parts) else ""

    records = []
    for line in lines[header_idx + 1 :]:
        if not line.strip():
            continue
        parts = line.split("\t")
        cl = get_val(parts, "cl_pedido").upper()
        if cl not in ("ZY10", "ZY35"):
            continue
        records.append({
            "ce": get_val(parts, "ce"),
            "cliente": clean_num_id(get_val(parts, "cliente")),
            "cliente_nom": get_val(parts, "cliente_nom"),
            "material": clean_num_id(get_val(parts, "material")),
            "doc_comer": clean_num_id(get_val(parts, "doc_comer")),
            "fe_entrega": get_val(parts, "fe_entrega"),
            "surtido_kg": to_kg(get_val(parts, "surtido_kg")),
            "factura": clean_num_id(get_val(parts, "factura")),
            "cl_pedido": cl,
            "referencia": clean_num_id(get_val(parts, "referencia")),
            "util": get_val(parts, "util"),
            "motivo": get_val(parts, "motivo"),
        })
    return records


def build_html_centro(centro, top_clientes, total_clientes_cd, total_rej_cd, fecha_display, hora_corte):
    total_rej_top = sum(c["rechazo_kg"] for c in top_clientes)
    total_sur_top = sum(c["surtido_kg"] for c in top_clientes)
    pct_top = (total_rej_top / total_sur_top * 100.0) if total_sur_top > 0 else 0.0
    share_cd = (total_rej_top / total_rej_cd * 100.0) if total_rej_cd > 0 else 0.0

    resumen_rows = ""
    detalle_rows = ""

    for rank, c in enumerate(top_clientes, 1):
        pct_c = (c["rechazo_kg"] / c["surtido_kg"] * 100.0) if c["surtido_kg"] > 0 else 0.0
        mot_top = max(c["motivos_kg"].items(), key=lambda kv: kv[1])[0] if c["motivos_kg"] else "-"
        placas_txt = ", ".join(sorted(c["placas_rechazo"])) or "-"
        canales_txt = ", ".join(sorted(c["canales_rechazo"])) or "-"
        rutas_txt = ", ".join(sorted(c["rutas_rechazo"])) or "-"
        n_peds = len(c["pedidos_rechazo"])
        ped_lbl = "1 pedido" if n_peds == 1 else f"{n_peds} pedidos"

        resumen_rows += f"""
          <tr>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-weight:800; color:#6a1b9a; text-align:center; white-space:nowrap;">#{rank}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11.5px;">
              <b style="color:#28174E;">{c['cliente_nom']}</b><br>
              <span style="color:#71717a; font-size:10.5px;">Cód: {c['cliente_cod']} &bull; {ped_lbl} con rechazo</span>
            </td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-weight:700; color:#18181b; font-size:11.5px; white-space:nowrap;">{placas_txt}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11px;">
              <b>{canales_txt}</b><br>
              <span style="color:#71717a;">{rutas_txt}</span>
            </td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; white-space:nowrap;">{c['surtido_kg']:,.2f}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:800; color:#c61c27; white-space:nowrap;">{c['rechazo_kg']:,.2f}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:700; color:#991b1b; white-space:nowrap;">{pct_c:.1f}%</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11px; color:#52525b;">{mot_top}</td>
          </tr>
        """

        for d in sorted(c["detalles_rechazo"], key=lambda x: x["rechazo_kg"], reverse=True):
            sku_label = f"<b>{d['material']}</b>" + (f" – {d['sku_desc']}" if d["sku_desc"] else "")
            detalle_rows += f"""
              <tr>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11px;">
                  <b style="color:#28174E;">#{rank} {d['cliente_nom']}</b><br>
                  <span style="color:#71717a;">Ped: {d['doc_comer']} &bull; Placa: <b>{d['placa']}</b></span>
                </td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11px;">{d['canal']}<br><span style="color:#71717a;">{d['ruta']}</span></td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11.5px;">{sku_label}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11px; color:#78350f;">{d['motivo_txt']}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; text-align:right; white-space:nowrap;">{d['surtido_kg']:,.2f}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:800; color:#c61c27; white-space:nowrap;">{d['rechazo_kg']:,.2f}</td>
              </tr>
            """

    return f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background-color:#f4f3f8; font-family:'Segoe UI', Arial, sans-serif; color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f3f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="880" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
          <tr>
            <td style="background-color:#28174E; padding:20px 24px; color:#ffffff;">
              <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#f89b22; font-weight:700;">Distribución Lima &bull; Centro {centro}</div>
              <h1 style="margin:4px 0 4px; font-size:20px; color:#ffffff;">Top {TOP_N} Clientes con Mayor Rechazo</h1>
              <div style="font-size:12px; color:#d4d4d8;">
                Fecha operativa: <b>{fecha_display}</b> &bull; Hora de corte: <b style="color:#f89b22;">{hora_corte} hrs</b> &bull; Fuente: <b>{ARCHIVO_ORIGEN}</b>
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px 12px;">
              <div style="background:#fffbeb; border-left:4px solid #f89b22; padding:10px 12px; border-radius:6px; font-size:12px; color:#78350f; margin-bottom:14px;">
                <b>Corte informativo a las {hora_corte} hrs:</b> Refleja las devoluciones registradas en SAP hasta este horario; las unidades que aún continúan en ruta pueden actualizarse al cierre del día.
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td width="32%" style="background:#fef2f2; border:1px solid #fecaca; border-top:3px solid #c61c27; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#991b1b; font-weight:700;">KG RECHAZO (TOP {len(top_clientes)} CLIENTES)</div>
                    <div style="font-size:20px; font-weight:800; color:#c61c27;">{total_rej_top:,.2f} kg</div>
                    <div style="font-size:10.5px; color:#71717a; margin-top:2px;">{share_cd:.1f}% del total rechazado del CD ({total_rej_cd:,.2f} kg)</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#faf5ff; border:1px solid #e9d5ff; border-top:3px solid #6a1b9a; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#6b21a8; font-weight:700;">CLIENTES CON RECHAZO EN EL CD</div>
                    <div style="font-size:20px; font-weight:800; color:#6a1b9a;">{total_clientes_cd} clientes</div>
                    <div style="font-size:10.5px; color:#71717a; margin-top:2px;">Mostrando los {len(top_clientes)} de mayor impacto</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #28174E; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#71717a; font-weight:700;">% RECHAZO SOBRE SURTIDO (TOP)</div>
                    <div style="font-size:20px; font-weight:800; color:#28174E;">{pct_top:.1f}%</div>
                    <div style="font-size:10.5px; color:#71717a; margin-top:2px;">Surtido del Top: {total_sur_top:,.2f} kg</div>
                  </td>
                </tr>
              </table>

              <h3 style="margin:0 0 8px; font-size:14px; color:#28174E;">1. Top {len(top_clientes)} Clientes con Mayor Impacto – {centro}</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px; margin-bottom:18px;">
                <tr style="background:#16365c; color:#ffffff;">
                  <th style="padding:8px; text-align:center;">#</th>
                  <th style="padding:8px; text-align:left;">Cliente</th>
                  <th style="padding:8px; text-align:left;">Placa(s)</th>
                  <th style="padding:8px; text-align:left;">Canal / Ruta</th>
                  <th style="padding:8px; text-align:right;">Kg Surtido</th>
                  <th style="padding:8px; text-align:right;">Kg Rechazo</th>
                  <th style="padding:8px; text-align:right;">% Rech.</th>
                  <th style="padding:8px; text-align:left;">Motivo Principal</th>
                </tr>
                {resumen_rows}
              </table>

              <h3 style="margin:0 0 8px; font-size:14px; color:#28174E;">2. Detalle por SKU / Producto (Clientes del Top {len(top_clientes)})</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#28174E; color:#ffffff;">
                  <th style="padding:8px; text-align:left;">Cliente / Pedido / Placa</th>
                  <th style="padding:8px; text-align:left;">Canal / Ruta</th>
                  <th style="padding:8px; text-align:left;">SKU / Material</th>
                  <th style="padding:8px; text-align:left;">Motivo</th>
                  <th style="padding:8px; text-align:right;">Kg Surtido</th>
                  <th style="padding:8px; text-align:right;">Kg Rechazo</th>
                </tr>
                {detalle_rows}
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#faf9fc; padding:12px 24px; border-top:1px solid #e4e4e7; font-size:11px; color:#71717a; text-align:center;">
              Cruce automático <b>SAP (ZY10/ZY35) + RoadMap.csv</b> &bull; Corte {hora_corte} hrs &bull; Se adjunta CSV con el detalle de SKUs del Top {len(top_clientes)} clientes de <b>{centro}</b>.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    for old_file in glob.glob(os.path.join(OUT_DIR, "alerta_rechazos_*.html")) + glob.glob(os.path.join(OUT_DIR, "alerta_rechazos_*.csv")):
        os.remove(old_file)

    pedido_map, sku_desc = load_roadmap(ROADMAP_PATH)
    sap_rows = parse_sap_txt(SAP_TXT_PATH)

    zy10_total = sum(1 for r in sap_rows if r["cl_pedido"] == "ZY10")
    zy35_total = sum(1 for r in sap_rows if r["cl_pedido"] == "ZY35")

    # 1. Agrupar ZY10 presentes en RoadMap por (doc_comer, factura, material)
    zy10_grouped = {}
    zy10_matched = 0
    fecha_op = ""
    for r in sap_rows:
        if r["cl_pedido"] != "ZY10" or r["doc_comer"] not in pedido_map:
            continue
        zy10_matched += 1
        if not fecha_op and r["fe_entrega"]:
            fecha_op = r["fe_entrega"]
        key = (r["doc_comer"], r["factura"], r["material"])
        if key not in zy10_grouped:
            zy10_grouped[key] = {
                "doc_comer": r["doc_comer"],
                "factura": r["factura"],
                "material": r["material"],
                "cliente": r["cliente"],
                "cliente_nom": r["cliente_nom"],
                "fe_entrega": r["fe_entrega"],
                "surtido_kg": 0.0,
            }
        zy10_grouped[key]["surtido_kg"] += r["surtido_kg"]

    # 2. Agrupar ZY35 por (referencia, material)
    zy35_grouped = {}
    for r in sap_rows:
        if r["cl_pedido"] != "ZY35" or not r["referencia"]:
            continue
        kg_rej = abs(r["surtido_kg"])
        key = (r["referencia"], r["material"])
        if key not in zy35_grouped:
            zy35_grouped[key] = {"rechazo_kg": 0.0, "motivos": set()}
        zy35_grouped[key]["rechazo_kg"] += kg_rej
        mot = r["motivo"] or (f"Cod. {r['util']}" if r["util"] else "")
        if mot and kg_rej > 0:
            zy35_grouped[key]["motivos"].add(mot)

    # 3. Cruzar ZY10 <-> ZY35 y consolidar 1 fila por (doc_comer, material)
    consolidado = {}
    for (doc_comer, factura, material), item in zy10_grouped.items():
        rej = zy35_grouped.get((factura, material)) if factura else None
        kg_rej = rej["rechazo_kg"] if rej else 0.0
        motivos = set(rej["motivos"]) if rej else set()
        rm = pedido_map[doc_comer]
        cli_nom = item["cliente_nom"] or rm["cliente_nom_rm"] or f"Cliente {item['cliente']}"

        ckey = (doc_comer, material)
        if ckey not in consolidado:
            consolidado[ckey] = {
                "fecha": item["fe_entrega"] or fecha_op,
                "centro": rm["centro"],
                "placa": rm["placa"],
                "canal": rm["canal"],
                "ruta": rm["ruta"],
                "doc_comer": doc_comer,
                "cliente_cod": item["cliente"],
                "cliente_nom": cli_nom,
                "material": material,
                "sku_desc": sku_desc.get(material, ""),
                "facturas": set(),
                "surtido_kg": 0.0,
                "rechazo_kg": 0.0,
                "motivos": set(),
            }
        if factura:
            consolidado[ckey]["facturas"].add(factura)
        consolidado[ckey]["surtido_kg"] += item["surtido_kg"]
        consolidado[ckey]["rechazo_kg"] += kg_rej
        consolidado[ckey]["motivos"].update(motivos)

    # 4. Agrupar por (Centro, Cliente)
    clientes = {}
    for row in consolidado.values():
        cli_id = row["cliente_cod"] or row["cliente_nom"]
        ckey = (row["centro"], cli_id)
        if ckey not in clientes:
            clientes[ckey] = {
                "centro": row["centro"],
                "cliente_cod": row["cliente_cod"] or "-",
                "cliente_nom": row["cliente_nom"],
                "placas_rechazo": set(),
                "canales_rechazo": set(),
                "rutas_rechazo": set(),
                "pedidos_rechazo": set(),
                "surtido_kg": 0.0,
                "rechazo_kg": 0.0,
                "motivos_kg": defaultdict(float),
                "detalles_rechazo": [],
            }
        c = clientes[ckey]
        c["surtido_kg"] += row["surtido_kg"]
        c["rechazo_kg"] += row["rechazo_kg"]

        if row["rechazo_kg"] > 0:
            c["placas_rechazo"].add(row["placa"])
            if row["canal"] and row["canal"] != "-":
                c["canales_rechazo"].add(row["canal"])
            if row["ruta"] and row["ruta"] != "-":
                c["rutas_rechazo"].add(row["ruta"])
            c["pedidos_rechazo"].add(row["doc_comer"])

            mot_txt = " / ".join(sorted(row["motivos"])) or "Sin motivo registrado"
            c["motivos_kg"][mot_txt] += row["rechazo_kg"]
            c["detalles_rechazo"].append({**row, "motivo_txt": mot_txt})

    # 5. Seleccionar Top N clientes con rechazo > 0 por cada Centro
    rechazos_por_centro = defaultdict(list)
    for c in clientes.values():
        if c["rechazo_kg"] > 0:
            rechazos_por_centro[c["centro"]].append(c)

    now_lima = datetime.now(LIMA_TZ)
    hora_corte = now_lima.strftime("%H:%M")
    fecha_display = fecha_op or now_lima.strftime("%d.%m.%Y")
    alertas = []

    for centro in sorted(rechazos_por_centro.keys()):
        todos_con_rechazo = sorted(
            rechazos_por_centro[centro], key=lambda x: x["rechazo_kg"], reverse=True
        )
        top_clientes = todos_con_rechazo[:TOP_N]
        total_clientes_cd = len(todos_con_rechazo)
        total_rej_cd = sum(c["rechazo_kg"] for c in todos_con_rechazo)
        total_rej_top = sum(c["rechazo_kg"] for c in top_clientes)

        slug = safe_slug(centro)
        html_name = f"alerta_rechazos_{slug}.html"
        csv_name = f"alerta_rechazos_{slug}.csv"

        with open(os.path.join(OUT_DIR, html_name), "w", encoding="utf-8") as f:
            f.write(
                build_html_centro(
                    centro, top_clientes, total_clientes_cd, total_rej_cd, fecha_display, hora_corte
                )
            )

        with open(os.path.join(OUT_DIR, csv_name), "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow([
                "Ranking_Cliente", "Hora_Corte", "Fecha", "Centro", "Cod_Cliente",
                "Cliente", "Placa", "Canal", "Ruta_Venta", "Pedido", "Facturas",
                "Material", "Descripcion_SKU", "Kg_Surtido", "Kg_Rechazo", "Motivo"
            ])
            for rank, c in enumerate(top_clientes, 1):
                for d in sorted(c["detalles_rechazo"], key=lambda x: x["rechazo_kg"], reverse=True):
                    w.writerow([
                        rank, hora_corte, d["fecha"], d["centro"], d["cliente_cod"],
                        d["cliente_nom"], d["placa"], d["canal"], d["ruta"],
                        d["doc_comer"], " | ".join(sorted(d["facturas"])),
                        d["material"], d["sku_desc"],
                        f"{d['surtido_kg']:.3f}", f"{d['rechazo_kg']:.3f}", d["motivo_txt"]
                    ])

        alertas.append({
            "centro": centro,
            "para": get_destinatarios(centro),
            "asunto": f"📊 Top {len(top_clientes)} Clientes con Rechazo [{centro}] ({total_rej_top:,.1f} kg) – Corte {hora_corte} | {fecha_display}",
            "hora_corte": hora_corte,
            "clientes_en_top": len(top_clientes),
            "total_clientes_con_rechazo": total_clientes_cd,
            "kg_rechazo_top": round(total_rej_top, 2),
            "kg_rechazo_cd": round(total_rej_cd, 2),
            "html_file": html_name,
            "csv_file": csv_name,
        })

    state = {
        "fecha": fecha_display,
        "hora_corte": hora_corte,
        "archivo": ARCHIVO_ORIGEN,
        "top_n": TOP_N,
        "total_centros_alertados": len(alertas),
        "alertas": alertas,
    }
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    print(
        f"OK [{hora_corte} Lima]: RoadMap={len(pedido_map)} pedidos | SAP ZY10={zy10_total} "
        f"(cruzados={zy10_matched}) | ZY35={zy35_total} | Clientes={len(clientes)} | "
        f"Centros con rechazo={[a['centro'] for a in alertas]}"
    )


if __name__ == "__main__":
    main()
