import csv
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime

SAP_TXT_PATH = os.environ.get("SAP_TXT_PATH", "data/sap_deb.txt")
ROADMAP_PATH = os.environ.get("ROADMAP_PATH", "RoadMap.csv")
UMBRAL_KG = float(os.environ.get("UMBRAL_KG", "100"))
ARCHIVO_ORIGEN = os.environ.get("ARCHIVO_ORIGEN", os.path.basename(SAP_TXT_PATH))

OUT_DIR = "reports"
HTML_PATH = os.path.join(OUT_DIR, "alerta_rechazos_email.html")
CSV_OUT_PATH = os.path.join(OUT_DIR, "alerta_rechazos_detalle.csv")
STATE_PATH = os.path.join(OUT_DIR, "alerta_rechazos_estado.json")

EXCLUDED_PLATES = {"FRT-001", "RES-CLI"}


def norm_key(text):
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def clean_id(val):
    s = str(val or "").strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s


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
    """Carga RoadMap.csv mapeando Doc.comer./Pedido -> Centro, Placa, Canal, Ruta, y SKU -> Descripción."""
    text = read_text_auto(path)
    sample = text[:4096]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    rows = list(csv.reader(text.splitlines(), delimiter=delim))
    if not rows:
        return {}, {}

    headers_norm = [norm_key(h) for h in rows[0]]
    idx_centro = find_col(headers_norm, ["centro", "cd", "sede", "ce"])
    idx_placa = find_col(headers_norm, ["placa", "vehiculo", "unidad"])
    idx_canal = find_col(headers_norm, ["canal"])
    idx_ruta = find_col(headers_norm, ["rutaventa", "ruta", "rutadeventa"])
    idx_pedido = find_col(headers_norm, ["doccomer", "pedido", "shipment", "entrega", "nropedido", "numpedido", "documento"])
    idx_mat = find_col(headers_norm, ["material", "sku", "codmaterial", "codproducto"])
    idx_desc = find_col(headers_norm, ["descripcion", "descmaterial", "producto", "nombreproducto", "denominacion"])

    if idx_pedido is None or idx_placa is None:
        raise RuntimeError(
            f"No se encontraron columnas clave en RoadMap.csv. Cabeceras detectadas: {rows[0]}"
        )

    pedido_map = {}
    sku_desc = {}

    for r in rows[1:]:
        if len(r) <= max(idx_pedido, idx_placa):
            continue
        ped = clean_id(r[idx_pedido])
        placa = clean_id(r[idx_placa]).upper()
        if not ped or not placa or placa in EXCLUDED_PLATES:
            continue

        centro = clean_id(r[idx_centro]) if idx_centro is not None and idx_centro < len(r) else "-"
        canal = clean_id(r[idx_canal]) if idx_canal is not None and idx_canal < len(r) else "-"
        ruta = clean_id(r[idx_ruta]) if idx_ruta is not None and idx_ruta < len(r) else "-"

        if ped not in pedido_map:
            pedido_map[ped] = {
                "centro": centro,
                "placa": placa,
                "canal": canal,
                "ruta": ruta,
            }

        if idx_mat is not None and idx_desc is not None and max(idx_mat, idx_desc) < len(r):
            m_cod = clean_id(r[idx_mat])
            m_desc = clean_id(r[idx_desc])
            if m_cod and m_desc and m_cod not in sku_desc:
                sku_desc[m_cod] = m_desc

    return pedido_map, sku_desc


def parse_sap_txt(path):
    """Lee el TXT tabulado de SAP ignorando filas vacías y columna A vacía."""
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
        raise RuntimeError("No se encontró la fila de cabecera de SAP ('Doc.comer.' y 'Cl Pedido').")

    def get_val(parts, key):
        idx = col_map.get(key)
        if idx is None or idx >= len(parts):
            return ""
        return parts[idx].strip()

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
            "cliente": clean_id(get_val(parts, "cliente")),
            "cliente_nom": get_val(parts, "cliente_nom"),
            "material": clean_id(get_val(parts, "material")),
            "doc_comer": clean_id(get_val(parts, "doc_comer")),
            "fe_entrega": get_val(parts, "fe_entrega"),
            "pedido_kg": to_kg(get_val(parts, "pedido_kg")),
            "surtido_kg": to_kg(get_val(parts, "surtido_kg")),
            "factura": clean_id(get_val(parts, "factura")),
            "cl_pedido": cl,
            "referencia": clean_id(get_val(parts, "referencia")),
            "util": get_val(parts, "util"),
            "motivo": get_val(parts, "motivo"),
        })
    return records


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    pedido_map, sku_desc = load_roadmap(ROADMAP_PATH)
    sap_rows = parse_sap_txt(SAP_TXT_PATH)

    # 1. Agrupar ZY10 filtrando solo pedidos presentes en RoadMap.csv
    # Clave intermedia: (doc_comer, factura, material) para evitar duplicados antes de cruzar con ZY35
    zy10_grouped = {}
    fecha_op = ""
    centros_txt = set()

    for r in sap_rows:
        if r["cl_pedido"] != "ZY10":
            continue
        if r["doc_comer"] not in pedido_map:
            continue
        if not fecha_op and r["fe_entrega"]:
            fecha_op = r["fe_entrega"]
        if r["ce"]:
            centros_txt.add(r["ce"])

        key = (r["doc_comer"], r["factura"], r["material"])
        if key not in zy10_grouped:
            zy10_grouped[key] = {
                "doc_comer": r["doc_comer"],
                "factura": r["factura"],
                "material": r["material"],
                "ce": r["ce"],
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

    # 3. Cruzar ZY10 <-> ZY35 y consolidar en 1 sola fila por (doc_comer, material)
    consolidado = {}
    for (doc_comer, factura, material), item in zy10_grouped.items():
        rej = zy35_grouped.get((factura, material)) if factura else None
        kg_rej = rej["rechazo_kg"] if rej else 0.0
        motivos = set(rej["motivos"]) if rej else set()

        rm = pedido_map[doc_comer]
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
                "cliente_nom": item["cliente_nom"],
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

    # 4. Agrupar por (Centro, Placa) y detectar placas > UMBRAL_KG
    placas = {}
    for row in consolidado.values():
        pkey = (row["centro"], row["placa"])
        if pkey not in placas:
            placas[pkey] = {
                "centro": row["centro"],
                "placa": row["placa"],
                "canales": set(),
                "rutas": set(),
                "surtido_kg": 0.0,
                "rechazo_kg": 0.0,
                "motivos_kg": defaultdict(float),
                "detalles_rechazo": [],
            }
        p = placas[pkey]
        if row["canal"] and row["canal"] != "-":
            p["canales"].add(row["canal"])
        if row["ruta"] and row["ruta"] != "-":
            p["rutas"].add(row["ruta"])
        p["surtido_kg"] += row["surtido_kg"]
        p["rechazo_kg"] += row["rechazo_kg"]

        if row["rechazo_kg"] > 0:
            mot_txt = " / ".join(sorted(row["motivos"])) or "Sin motivo registrado"
            p["motivos_kg"][mot_txt] += row["rechazo_kg"]
            p["detalles_rechazo"].append({**row, "motivo_txt": mot_txt})

    criticas = sorted(
        [p for p in placas.values() if p["rechazo_kg"] > UMBRAL_KG],
        key=lambda x: x["rechazo_kg"],
        reverse=True,
    )

    fecha_display = fecha_op or datetime.now().strftime("%d.%m.%Y")
    hora_corte = datetime.now().strftime("%H:%M")
    enviar = len(criticas) > 0
    total_rej_crit = sum(p["rechazo_kg"] for p in criticas)
    total_sur_crit = sum(p["surtido_kg"] for p in criticas)
    pct_crit = (total_rej_crit / total_sur_crit * 100.0) if total_sur_crit > 0 else 0.0

    # 5. Guardar JSON de estado para Power Automate
    state = {
        "enviar": enviar,
        "fecha": fecha_display,
        "hora_corte": hora_corte,
        "archivo": ARCHIVO_ORIGEN,
        "centros": sorted(centros_txt),
        "umbral_kg": UMBRAL_KG,
        "placas_criticas": len(criticas),
        "kg_rechazo_critico": round(total_rej_crit, 2),
        "asunto": f"🚨 Alerta de Rechazos > {int(UMBRAL_KG)} kg ({len(criticas)} placas • {total_rej_crit:,.1f} kg) – {fecha_display}",
    }
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    # 6. Guardar CSV adjunto con detalle SKU de placas críticas
    with open(CSV_OUT_PATH, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Fecha", "Centro", "Placa", "Canal", "Ruta_Venta", "Pedido",
            "Facturas", "Cod_Cliente", "Cliente", "Material", "Descripcion_SKU",
            "Kg_Surtido", "Kg_Rechazo", "Motivo"
        ])
        for p in criticas:
            for d in sorted(p["detalles_rechazo"], key=lambda x: x["rechazo_kg"], reverse=True):
                w.writerow([
                    d["fecha"], d["centro"], d["placa"], d["canal"], d["ruta"],
                    d["doc_comer"], " | ".join(sorted(d["facturas"])),
                    d["cliente_cod"], d["cliente_nom"], d["material"], d["sku_desc"],
                    f"{d['surtido_kg']:.3f}", f"{d['rechazo_kg']:.3f}", d["motivo_txt"]
                ])

    if not enviar:
        print(f"OK: Ninguna placa superó los {UMBRAL_KG} kg de rechazo. No se enviará correo.")
        return

    # 7. Construir HTML ejecutivo compatible con Outlook
    resumen_rows = ""
    detalle_rows = ""

    for p in criticas:
        pct_p = (p["rechazo_kg"] / p["surtido_kg"] * 100.0) if p["surtido_kg"] > 0 else 0.0
        mot_top = max(p["motivos_kg"].items(), key=lambda kv: kv[1])[0] if p["motivos_kg"] else "-"
        resumen_rows += f"""
          <tr>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-weight:700; color:#28174E; white-space:nowrap;">{p['centro']}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-weight:800; color:#18181b; white-space:nowrap;">{p['placa']}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11.5px;">{', '.join(sorted(p['canales'])) or '-'}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11.5px;">{', '.join(sorted(p['rutas'])) or '-'}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; white-space:nowrap;">{p['surtido_kg']:,.2f}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:800; color:#c61c27; white-space:nowrap;">{p['rechazo_kg']:,.2f}</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:700; color:#991b1b; white-space:nowrap;">{pct_p:.1f}%</td>
            <td style="padding:8px; border-bottom:1px solid #e4e4e7; font-size:11.5px; color:#52525b;">{mot_top}</td>
          </tr>
        """

        for d in sorted(p["detalles_rechazo"], key=lambda x: x["rechazo_kg"], reverse=True):
            sku_label = f"<b>{d['material']}</b>" + (f" – {d['sku_desc']}" if d["sku_desc"] else "")
            detalle_rows += f"""
              <tr>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-weight:700; color:#28174E; white-space:nowrap;">{d['placa']}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11px;">{d['cliente_nom']}<br><span style="color:#71717a;">Ped: {d['doc_comer']} &bull; {d['canal']} / {d['ruta']}</span></td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11.5px;">{sku_label}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; font-size:11px; color:#78350f;">{d['motivo_txt']}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; text-align:right; white-space:nowrap;">{d['surtido_kg']:,.2f}</td>
                <td style="padding:7px 8px; border-bottom:1px solid #e4e4e7; text-align:right; font-weight:800; color:#c61c27; white-space:nowrap;">{d['rechazo_kg']:,.2f}</td>
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
          <tr>
            <td style="background-color:#28174E; padding:20px 24px; color:#ffffff;">
              <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#f89b22; font-weight:700;">Distribución Lima &bull; Alerta Temprana de Rechazos (SAP + RoadMap)</div>
              <h1 style="margin:4px 0 2px; font-size:20px; color:#ffffff;">Placas con Rechazo Superior a {int(UMBRAL_KG)} kg</h1>
              <div style="font-size:12px; color:#d4d4d8;">Fecha operativa: <b>{fecha_display}</b> &bull; Archivo: <b>{ARCHIVO_ORIGEN}</b></div>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px 12px;">
              <div style="background:#fffbeb; border-left:4px solid #f89b22; padding:10px 12px; border-radius:6px; font-size:12px; color:#78350f; margin-bottom:14px;">
                <b>Corte parcial informativo:</b> Corresponde a las devoluciones registradas en SAP al momento de la descarga; las unidades aún en ruta pueden actualizarse al cierre de la jornada.
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td width="32%" style="background:#fef2f2; border:1px solid #fecaca; border-top:3px solid #c61c27; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#991b1b; font-weight:700;">PLACAS SOBRE UMBRAL (&gt;{int(UMBRAL_KG)} KG)</div>
                    <div style="font-size:20px; font-weight:800; color:#c61c27;">{len(criticas)} placas</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#faf5ff; border:1px solid #e9d5ff; border-top:3px solid #6a1b9a; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#6b21a8; font-weight:700;">KG RECHAZADOS (PLACAS CRÍTICAS)</div>
                    <div style="font-size:20px; font-weight:800; color:#6a1b9a;">{total_rej_crit:,.2f} kg</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="background:#faf9fc; border:1px solid #e4e4e7; border-top:3px solid #28174E; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#71717a; font-weight:700;">% RECHAZO SOBRE SURTIDO</div>
                    <div style="font-size:20px; font-weight:800; color:#28174E;">{pct_crit:.1f}%</div>
                  </td>
                </tr>
              </table>

              <h3 style="margin:0 0 8px; font-size:14px; color:#28174E;">1. Resumen de Placas Críticas</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px; margin-bottom:18px;">
                <tr style="background:#16365c; color:#ffffff;">
                  <th style="padding:8px; text-align:left;">Centro</th>
                  <th style="padding:8px; text-align:left;">Placa</th>
                  <th style="padding:8px; text-align:left;">Canal</th>
                  <th style="padding:8px; text-align:left;">Ruta Venta</th>
                  <th style="padding:8px; text-align:right;">Kg Surtido</th>
                  <th style="padding:8px; text-align:right;">Kg Rechazo</th>
                  <th style="padding:8px; text-align:right;">% Rech.</th>
                  <th style="padding:8px; text-align:left;">Motivo Principal</th>
                </tr>
                {resumen_rows}
              </table>

              <h3 style="margin:0 0 8px; font-size:14px; color:#28174E;">2. Detalle de Rechazos por SKU / Producto</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:12px;">
                <tr style="background:#28174E; color:#ffffff;">
                  <th style="padding:8px; text-align:left;">Placa</th>
                  <th style="padding:8px; text-align:left;">Cliente / Pedido / Canal</th>
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
              Cruce automático <b>SAP (ZY10/ZY35) + RoadMap.csv</b> &bull; Se adjunta CSV con el detalle completo por SKU.
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

    print(f"OK: Alerta generada ({len(criticas)} placas > {UMBRAL_KG} kg, {total_rej_crit:,.2f} kg totales).")


if __name__ == "__main__":
    main()
