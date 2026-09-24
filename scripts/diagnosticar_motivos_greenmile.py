#!/usr/bin/env python3
"""
Diagnóstico de campos de rechazo/cancelación en GreenMile.

Objetivo:
- Revisar únicamente rutas de una fecha objetivo (por defecto 2026-09-23).
- No imprimir objetos completos ni miles de cabeceras repetidas.
- Inventariar rutas JSON (paths) presentes en stops/orders rechazados o cancelados.
- Guardar ejemplos de valores por path para localizar los campos reales de:
  MotivoNoEntrega y MotivoCancelacion.

Variables de entorno obligatorias:
  GREENMILE_USERNAME
  GREENMILE_PASSWORD

Variables opcionales:
  GREENMILE_TARGET_DATE=2026-09-23
  GREENMILE_SCAN_PAGE_SIZE=100
  GREENMILE_DETAIL_PAGE_SIZE=10
  GREENMILE_MAX_PAGES=2000
  GREENMILE_HTTP_RETRIES=3
  GREENMILE_MAX_SAMPLES_PER_PATH=5
  GREENMILE_ONLY_PROGRAMMED=1

Si GREENMILE_ONLY_PROGRAMMED=1 y existe RoadMap_Shipment.json, limita el diagnóstico
al conjunto de ShipmentCustom programados para la fecha objetivo.
"""

import base64
import json
import os
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Optional

ROADMAP_FILE = Path("RoadMap_Shipment.json")
OUTPUT_FILE = Path("GreenMile_Diagnostico_Motivos_2026-09-23.json")
SUMMARY_FILE = Path("GreenMile_Diagnostico_Motivos_2026-09-23.txt")
GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"

TARGET_DATE = os.getenv("GREENMILE_TARGET_DATE", "2026-09-23").strip()
SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
MAX_SAMPLES_PER_PATH = int(os.getenv("GREENMILE_MAX_SAMPLES_PER_PATH", "5"))
ONLY_PROGRAMMED = os.getenv("GREENMILE_ONLY_PROGRAMMED", "1").strip() != "0"

LIGHT_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
]

# Se solicitan los objetos completos de stop/order sólo en las páginas que contienen
# la fecha objetivo. El archivo de salida NO guarda los objetos completos: sólo paths,
# tipos y muestras compactas.
DETAIL_FIELDS = [
    "id",
    "organization.*",
    "date",
    "key",
    "status",
    "canceledStops",
    "undeliveredStops",
    "redeliveredStops",
    "stops.*",
    "stops.orders.*",
]

REJECTED_DELIVERY_STATUSES = {
    "REJECTED",
    "UNDELIVERED",
    "NOT_DELIVERED",
    "CANCELED",
    "CANCELLED",
    "FAILED",
}

REASON_TOKENS = (
    "reason", "razon", "motivo", "undeliver", "notdeliver", "noentreg",
    "reject", "rechaz", "failure", "failed", "refusal", "refused",
    "exception", "occurrence", "incident", "returnreason", "cancelreason",
    "cancellationreason", "cancel", "deliveryfailure", "nondelivery",
)

TECHNICAL_TOKENS = (
    "latitude", "longitude", "accuracy", "distance", "provider", "gps",
    "quality", "conformity", "timestamp", "datetime",
)


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value).strip()


def normalise_status(value: Any) -> str:
    return clean_text(value).upper()


def normalise_key(value: Any) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return "".join(char.lower() for char in text if char.isalnum())


def require_environment_variable(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"No se configuró el secreto obligatorio: {name}")
    return value


def build_basic_authorisation(username: str, password: str) -> str:
    raw = f"{username}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def request_routes_page(
    fields: list[str],
    first_result: int,
    max_results: int,
    authorisation: str,
) -> list[dict[str, Any]]:
    criteria = {
        "filters": fields,
        "firstResult": first_result,
        "maxResults": max_results,
    }
    encoded = urllib.parse.quote(
        json.dumps(criteria, ensure_ascii=False, separators=(",", ":")),
        safe="",
    )

    latest_error: Optional[Exception] = None
    for attempt in range(1, HTTP_RETRIES + 1):
        request = urllib.request.Request(
            url=f"{GREENMILE_URL}?criteria={encoded}",
            data=b"{}",
            method="POST",
            headers={
                "Authorization": authorisation,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = response.read().decode("utf-8")
            data = json.loads(payload)
            if not isinstance(data, list):
                raise RuntimeError("La respuesta de GreenMile no es una matriz JSON.")
            return data
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            latest_error = RuntimeError(
                f"GreenMile HTTP {error.code}; firstResult={first_result}; "
                f"maxResults={max_results}; respuesta={body[:1000]}"
            )
            if error.code not in {429, 500, 502, 503, 504}:
                raise latest_error from error
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            latest_error = RuntimeError(
                f"Error GreenMile; firstResult={first_result}; "
                f"maxResults={max_results}; error={error}"
            )

        if attempt < HTTP_RETRIES:
            wait_seconds = attempt * 2
            print(f"Reintento en {wait_seconds}s...")
            time.sleep(wait_seconds)

    if latest_error is not None:
        raise latest_error
    raise RuntimeError("Error no identificado al consultar GreenMile.")


def load_programmed_shipments_for_target_date() -> set[str]:
    if not ONLY_PROGRAMMED or not ROADMAP_FILE.exists():
        return set()
    with ROADMAP_FILE.open("r", encoding="utf-8") as file:
        records = json.load(file)
    if not isinstance(records, list):
        raise ValueError(f"{ROADMAP_FILE} no contiene una matriz JSON.")
    return {
        clean_text(record.get("ShipmentCustom"))
        for record in records
        if isinstance(record, dict)
        and clean_text(record.get("DeliveryDate")) == TARGET_DATE
        and clean_text(record.get("ShipmentCustom"))
    }


def get_route_ids(routes: list[dict[str, Any]]) -> set[str]:
    return {
        clean_text(route.get("id"))
        for route in routes
        if clean_text(route.get("id"))
    }


def value_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def compact_sample(value: Any, limit: int = 240) -> str:
    if isinstance(value, (dict, list)):
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        rendered = clean_text(value)
    return rendered if len(rendered) <= limit else rendered[:limit] + "…"


def flatten_paths(value: Any, path: str = "") -> list[tuple[str, str, str]]:
    """Devuelve únicamente hojas JSON: (path, tipo, muestra)."""
    leaves: list[tuple[str, str, str]] = []
    if isinstance(value, dict):
        if not value:
            leaves.append((path, "object", "{}"))
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            leaves.extend(flatten_paths(child, child_path))
    elif isinstance(value, list):
        if not value:
            leaves.append((path, "array", "[]"))
        # Se normaliza el índice para agrupar la misma cabecera entre registros.
        for child in value:
            leaves.extend(flatten_paths(child, f"{path}[]"))
    else:
        leaves.append((path, value_type(value), compact_sample(value)))
    return leaves


def is_reason_like_path(path: str) -> bool:
    key = normalise_key(path)
    return (
        any(token in key for token in REASON_TOKENS)
        and not any(token in key for token in TECHNICAL_TOKENS)
    )


def add_inventory(
    inventory: dict[str, dict[str, Any]],
    value: Any,
    root: str,
) -> None:
    for path, kind, sample in flatten_paths(value, root):
        item = inventory.setdefault(
            path,
            {"types": Counter(), "occurrences": 0, "non_empty": 0, "samples": []},
        )
        item["types"][kind] += 1
        item["occurrences"] += 1
        if sample not in {"", "null", "[]", "{}"}:
            item["non_empty"] += 1
            if sample not in item["samples"] and len(item["samples"]) < MAX_SAMPLES_PER_PATH:
                item["samples"].append(sample)


def serialise_inventory(inventory: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for path in sorted(inventory):
        item = inventory[path]
        output.append({
            "path": path,
            "types": dict(item["types"]),
            "occurrences": item["occurrences"],
            "nonEmpty": item["non_empty"],
            "samples": item["samples"],
            "looksLikeReason": is_reason_like_path(path),
        })
    return output


def process_routes(
    routes: list[dict[str, Any]],
    programmed_shipments: set[str],
    all_paths: dict[str, dict[str, Any]],
    reason_paths: dict[str, dict[str, Any]],
    statuses: Counter[str],
    diagnostic_rows: list[dict[str, Any]],
) -> int:
    matched_routes = 0
    for route in routes:
        if clean_text(route.get("date")) != TARGET_DATE:
            continue
        matched_routes += 1
        route_key = clean_text(route.get("key"))
        organization = route.get("organization") or {}
        location = clean_text(organization.get("key"))

        for stop_index, stop in enumerate(route.get("stops") or []):
            if not isinstance(stop, dict):
                continue
            stop_status = normalise_status(stop.get("deliveryStatus"))
            orders = stop.get("orders") or []
            if not isinstance(orders, list):
                orders = []

            for order_index, order in enumerate(orders):
                if not isinstance(order, dict):
                    continue
                shipment = clean_text(order.get("number"))
                if programmed_shipments and shipment not in programmed_shipments:
                    continue

                order_status = normalise_status(
                    order.get("deliveryStatus")
                    or order.get("status")
                    or stop_status
                )
                effective_status = order_status or stop_status
                if effective_status not in REJECTED_DELIVERY_STATUSES:
                    continue

                statuses[effective_status] += 1
                add_inventory(all_paths, stop, "stop")
                add_inventory(all_paths, order, "order")

                local_candidates = []
                for root, obj in (("stop", stop), ("order", order)):
                    for path, kind, sample in flatten_paths(obj, root):
                        if is_reason_like_path(path):
                            local_candidates.append({
                                "path": path,
                                "type": kind,
                                "value": sample,
                            })
                            add_inventory(reason_paths, obj, root)

                diagnostic_rows.append({
                    "date": TARGET_DATE,
                    "routeKey": route_key,
                    "location": location,
                    "shipmentCustom": shipment,
                    "stopIndex": stop_index,
                    "orderIndex": order_index,
                    "deliveryStatus": effective_status,
                    "reasonCandidates": local_candidates,
                })
    return matched_routes


def main() -> None:
    username = require_environment_variable("GREENMILE_USERNAME")
    password = require_environment_variable("GREENMILE_PASSWORD")
    authorisation = build_basic_authorisation(username, password)
    programmed_shipments = load_programmed_shipments_for_target_date()

    # Nombres de salida ajustados a la fecha configurada.
    global OUTPUT_FILE, SUMMARY_FILE
    OUTPUT_FILE = Path(f"GreenMile_Diagnostico_Motivos_{TARGET_DATE}.json")
    SUMMARY_FILE = Path(f"GreenMile_Diagnostico_Motivos_{TARGET_DATE}.txt")

    print(f"Fecha objetivo: {TARGET_DATE}")
    if programmed_shipments:
        print(f"Shipments programados de la fecha: {len(programmed_shipments)}")
    else:
        print("Diagnóstico sin restricción por RoadMap_Shipment.json.")

    all_paths: dict[str, dict[str, Any]] = {}
    reason_paths: dict[str, dict[str, Any]] = {}
    statuses: Counter[str] = Counter()
    diagnostic_rows: list[dict[str, Any]] = []
    total_routes_reviewed = 0
    matching_routes = 0
    first_result = 0
    page_number = 0
    previous_signature: Optional[frozenset[str]] = None

    while page_number < MAX_PAGES:
        light_routes = request_routes_page(
            LIGHT_FIELDS, first_result, SCAN_PAGE_SIZE, authorisation
        )
        page_number += 1
        if not light_routes:
            break

        signature = frozenset(get_route_ids(light_routes))
        if signature and signature == previous_signature:
            raise RuntimeError(
                f"GreenMile devolvió la misma página; firstResult={first_result}."
            )
        previous_signature = signature
        total_routes_reviewed += len(light_routes)

        page_has_target_date = any(
            clean_text(route.get("date")) == TARGET_DATE for route in light_routes
        )
        print(
            f"Página {page_number}: firstResult={first_result}, "
            f"rutas={len(light_routes)}, fecha_objetivo={page_has_target_date}"
        )

        if page_has_target_date:
            for offset in range(0, len(light_routes), DETAIL_PAGE_SIZE):
                detail_first = first_result + offset
                detail_size = min(DETAIL_PAGE_SIZE, len(light_routes) - offset)
                detail_routes = request_routes_page(
                    DETAIL_FIELDS, detail_first, detail_size, authorisation
                )
                matching_routes += process_routes(
                    detail_routes,
                    programmed_shipments,
                    all_paths,
                    reason_paths,
                    statuses,
                    diagnostic_rows,
                )

        first_result += len(light_routes)
    else:
        raise RuntimeError(
            f"Se alcanzó GREENMILE_MAX_PAGES={MAX_PAGES} sin finalizar."
        )

    all_fields = serialise_inventory(all_paths)
    # Filtrado correcto de candidatos tras inventariar todos los paths.
    reason_candidates = [item for item in all_fields if item["looksLikeReason"]]

    result = {
        "targetDate": TARGET_DATE,
        "onlyProgrammedShipments": bool(programmed_shipments),
        "programmedShipmentCount": len(programmed_shipments),
        "routesReviewed": total_routes_reviewed,
        "matchingRouteObjectsFetched": matching_routes,
        "rejectedOrCanceledOrderCount": len(diagnostic_rows),
        "observedRejectedStatuses": dict(statuses),
        "reasonCandidatePaths": reason_candidates,
        "allLeafPathsInRejectedObjects": all_fields,
        "rejectedOrCanceledItems": diagnostic_rows,
    }

    with OUTPUT_FILE.open("w", encoding="utf-8", newline="") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
        file.write("\n")

    summary_lines = [
        "DIAGNÓSTICO GREENMILE - MOTIVOS DE RECHAZO/CANCELACIÓN",
        f"Fecha objetivo: {TARGET_DATE}",
        f"Rutas revisadas: {total_routes_reviewed}",
        f"Objetos de ruta de fecha objetivo procesados: {matching_routes}",
        f"Pedidos rechazados/cancelados: {len(diagnostic_rows)}",
        f"Estados observados: {dict(statuses)}",
        "",
        "PATHS CANDIDATOS A MOTIVO:",
    ]
    if reason_candidates:
        for item in reason_candidates:
            samples = " | ".join(item["samples"]) or "<vacío>"
            summary_lines.append(
                f'- {item["path"]} | apariciones={item["occurrences"]} '
                f'| no_vacíos={item["nonEmpty"]} | muestras={samples}'
            )
    else:
        summary_lines.append("- No se detectaron paths candidatos por nombre.")

    summary_lines.extend([
        "",
        "SIGUIENTE REVISIÓN:",
        "- Abrir el JSON y revisar reasonCandidatePaths.",
        "- Si está vacío, revisar allLeafPathsInRejectedObjects y sus samples.",
        "- No se han guardado los objetos completos; sólo paths, tipos y muestras.",
    ])
    SUMMARY_FILE.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")

    print("\nRESUMEN")
    print(f"Rutas revisadas: {total_routes_reviewed}")
    print(f"Pedidos rechazados/cancelados: {len(diagnostic_rows)}")
    print(f"Paths candidatos: {len(reason_candidates)}")
    print(f"Archivo JSON: {OUTPUT_FILE}")
    print(f"Resumen TXT: {SUMMARY_FILE}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
