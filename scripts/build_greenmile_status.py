import base64
import json
import os
import sys
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Optional

ROADMAP_FILE = Path("RoadMap_Shipment.json")
OUTPUT_FILE = Path("GreenMile_Estados.json")
GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"

SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
DEBUG_REJECTED_LIMIT = int(os.getenv("GREENMILE_DEBUG_REJECTED_LIMIT", "12"))
DEBUG_REJECTED_COUNT = 0

# Campos de Route aceptados por GreenMile que traen status y pedidos
SCAN_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
    "stops.deliveryStatus",
    "stops.latitude",
    "stops.longitude",
    "stops.orders.number",
]

REJECTED_DELIVERY_STATUSES = {
    "REJECTED",
    "UNDELIVERED",
    "NOT_DELIVERED",
    "CANCELED",
    "CANCELLED",
    "FAILED",
}

TECHNICAL_VALUES = {
    "DRIVER_ENTERED", "ROUTER_INFERRED", "FUSED", "GPS", "TRUE", "FALSE", "0",
}


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
    text = "".join(c for c in text if not unicodedata.combining(c))
    return "".join(c.lower() for c in text if c.isalnum())


def normalise_shipment_number(value: Any) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value))
    text = text.replace("\u00A0", "")
    return "".join(text.split())


def to_number(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def require_environment_variable(name: str) -> str:
    value = os.getenv(name, "").strip()
    if value == "":
        raise RuntimeError(f"No se configuro el secreto obligatorio: {name}")
    return value


def load_programmed_shipments() -> list[dict[str, Any]]:
    if not ROADMAP_FILE.exists():
        raise FileNotFoundError(f"No existe {ROADMAP_FILE}.")

    with ROADMAP_FILE.open("r", encoding="utf-8") as file:
        records = json.load(file)

    if not isinstance(records, list) or not records:
        raise ValueError("RoadMap_Shipment.json no contiene datos.")

    valid_records: list[dict[str, Any]] = []
    shipments_seen: set[str] = set()

    for position, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            raise ValueError(f"El registro {position} no es un objeto JSON.")

        shipment = normalise_shipment_number(record.get("ShipmentCustom"))
        delivery_date = clean_text(record.get("DeliveryDate"))

        if shipment == "":
            continue
        if delivery_date == "":
            raise ValueError(f"El Shipment {shipment} no tiene DeliveryDate.")
        if shipment in shipments_seen:
            raise ValueError(
                f"ShipmentCustom duplicado en RoadMap_Shipment.json: {shipment}"
            )

        shipments_seen.add(shipment)
        valid_records.append(
            {
                **record,
                "ShipmentCustom": shipment,
                "DeliveryDate": delivery_date,
                "VehicleKey": clean_text(record.get("VehicleKey")),
                "Location": clean_text(record.get("Location")),
            }
        )

    if not valid_records:
        raise ValueError("No se encontraron shipments validos.")

    return valid_records


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
                response_text = response.read().decode("utf-8")

            data = json.loads(response_text)
            if not isinstance(data, list):
                raise RuntimeError("La respuesta de GreenMile no es una matriz.")
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
                f"Error al consultar GreenMile; firstResult={first_result}; "
                f"maxResults={max_results}; error={error}"
            )

        if attempt < HTTP_RETRIES:
            wait_seconds = attempt * 2
            print(f"Reintento en {wait_seconds}s...")
            time.sleep(wait_seconds)

    if latest_error is not None:
        raise latest_error
    raise RuntimeError("Error no identificado al consultar GreenMile.")


def get_route_ids(routes: list[dict[str, Any]]) -> set[str]:
    return {
        clean_text(route.get("id"))
        for route in routes
        if clean_text(route.get("id")) != ""
    }


def map_delivery_status(delivery_status: Any) -> str:
    status = normalise_status(delivery_status)
    if status == "DELIVERED":
        return "ENTREGADO"
    if status in REJECTED_DELIVERY_STATUSES:
        return "RECHAZADO"
    if status in {"PENDING", "IN_PROGRESS"}:
        return "PENDIENTE"
    return "SIN INFORMACION"


def map_connection_status(value: Any) -> str:
    status = normalise_status(value)
    if status in {"", "NOT_STARTED"}:
        return "SIN CONEXION"
    return "CONECTADO"


def delivery_priority(value: Any) -> int:
    return {
        "DELIVERED": 40,
        "REJECTED": 35,
        "UNDELIVERED": 35,
        "NOT_DELIVERED": 35,
        "CANCELED": 35,
        "CANCELLED": 35,
        "FAILED": 35,
        "IN_PROGRESS": 20,
        "PENDING": 10,
        "": 0,
    }.get(normalise_status(value), 5)


def choose_best_record(
    existing: Optional[dict[str, Any]],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    if existing is None:
        return candidate

    old_priority = delivery_priority(existing.get("DeliveryStatusRaw"))
    new_priority = delivery_priority(candidate.get("DeliveryStatusRaw"))

    if new_priority >= old_priority:
        return candidate
    return existing


def create_not_migrated_record(programmed: dict[str, Any]) -> dict[str, Any]:
    return {
        "ShipmentCustom": clean_text(programmed.get("ShipmentCustom")),
        "VehicleKey": clean_text(programmed.get("VehicleKey")),
        "Location": clean_text(programmed.get("Location")),
        "FechaOperacion": clean_text(programmed.get("DeliveryDate")),
        "EstadoMigracion": "NO MIGRADO",
        "EstadoConexion": "NO APLICA",
        "EstadoEntrega": "SIN INFORMACION",
        "LatitudActual": None,
        "LongitudActual": None,
        "FuenteCoordenada": "",
        "DeliveryStatusRaw": "",
        "MotivoNoEntrega": "",
        "MotivoCancelacion": "",
    }


def process_routes_direct(
    routes: list[dict[str, Any]],
    programmed_by_number: dict[str, dict[str, Any]],
    found_shipments: dict[str, dict[str, Any]],
    observed_route_statuses: Counter[str],
    observed_delivery_statuses: Counter[str],
    all_greenmile_orders: set[str],
    matched_shipments_in_scan: set[str],
) -> int:
    routes_with_matches = 0

    for route in routes:
        if not isinstance(route, dict):
            continue

        route_status_raw = normalise_status(route.get("status"))
        observed_route_statuses[route_status_raw] += 1
        route_date = clean_text(route.get("date"))
        greenmile_route_key = clean_text(route.get("key"))
        organization = route.get("organization") or {}
        greenmile_location = clean_text(organization.get("key"))

        route_had_shipment = False

        for stop in route.get("stops") or []:
            if not isinstance(stop, dict):
                continue

            stop_status = normalise_status(stop.get("deliveryStatus"))
            observed_delivery_statuses[stop_status] += 1
            lat = to_number(stop.get("latitude"))
            lon = to_number(stop.get("longitude"))
            coord_source = "PARADA" if (lat is not None and lon is not None) else ""

            for order in stop.get("orders") or []:
                if not isinstance(order, dict):
                    continue

                shipment_number = normalise_shipment_number(order.get("number"))
                if shipment_number == "":
                    continue

                all_greenmile_orders.add(shipment_number)

                if shipment_number not in programmed_by_number:
                    continue

                route_had_shipment = True
                matched_shipments_in_scan.add(shipment_number)
                programmed = programmed_by_number[shipment_number]

                candidate = {
                    "ShipmentCustom": shipment_number,
                    "VehicleKey": clean_text(programmed.get("VehicleKey")),
                    "Location": clean_text(programmed.get("Location")),
                    "FechaOperacion": clean_text(programmed.get("DeliveryDate")),
                    "EstadoMigracion": "MIGRADO",
                    "EstadoConexion": map_connection_status(route_status_raw),
                    "EstadoEntrega": map_delivery_status(stop_status),
                    "LatitudActual": lat,
                    "LongitudActual": lon,
                    "FuenteCoordenada": coord_source,
                    "DeliveryStatusRaw": stop_status,
                    "MotivoNoEntrega": "",
                    "MotivoCancelacion": "",
                    "GreenMileRouteKey": greenmile_route_key,
                    "GreenMileLocation": greenmile_location,
                    "GreenMileRouteDate": route_date,
                }

                found_shipments[shipment_number] = choose_best_record(
                    found_shipments.get(shipment_number),
                    candidate,
                )

        if route_had_shipment:
            routes_with_matches += 1

    return routes_with_matches


def main() -> None:
    username = require_environment_variable("GREENMILE_USERNAME")
    password = require_environment_variable("GREENMILE_PASSWORD")
    authorisation = build_basic_authorisation(username, password)

    programmed_shipments = load_programmed_shipments()
    programmed_by_number = {
        record["ShipmentCustom"]: record
        for record in programmed_shipments
    }
    programmed_numbers = set(programmed_by_number)
    target_dates = {record["DeliveryDate"] for record in programmed_shipments}

    print("Fechas operativas RoadMap: " + ", ".join(sorted(target_dates)))
    print(f"Shipments programados: {len(programmed_by_number)}")
    print("Metodo de cruce: ShipmentCustom = stops.orders.number")
    print("Filtros decisorios por fecha/location: DESACTIVADOS")

    found_shipments: dict[str, dict[str, Any]] = {}
    observed_delivery_statuses: Counter[str] = Counter()
    observed_route_statuses: Counter[str] = Counter()

    all_greenmile_orders: set[str] = set()
    matched_shipments_in_scan: set[str] = set()

    first_result = 0
    page_number = 0
    total_routes_reviewed = 0
    routes_with_programmed_shipments = 0
    previous_page_signature: Optional[frozenset[str]] = None

    while page_number < MAX_PAGES:
        scan_routes = request_routes_page(
            SCAN_FIELDS,
            first_result,
            SCAN_PAGE_SIZE,
            authorisation,
        )
        page_number += 1

        if not scan_routes:
            print(f"Fin de paginacion. firstResult={first_result}")
            break

        signature = frozenset(get_route_ids(scan_routes))
        if signature and signature == previous_page_signature:
            raise RuntimeError(
                f"GreenMile devolvio la misma pagina. firstResult={first_result}."
            )
        previous_page_signature = signature
        total_routes_reviewed += len(scan_routes)

        matched_before = len(matched_shipments_in_scan)
        matched_routes = process_routes_direct(
            scan_routes,
            programmed_by_number,
            found_shipments,
            observed_route_statuses,
            observed_delivery_statuses,
            all_greenmile_orders,
            matched_shipments_in_scan,
        )
        routes_with_programmed_shipments += matched_routes
        matched_in_page = len(matched_shipments_in_scan) - matched_before

        print(
            f"Pagina {page_number}: firstResult={first_result}, "
            f"rutas={len(scan_routes)}, coincidencias_pagina={matched_in_page}, "
            f"total_migrados={len(found_shipments)}"
        )

        first_result += len(scan_routes)

    else:
        raise RuntimeError(
            f"Se alcanzo GREENMILE_MAX_PAGES={MAX_PAGES} sin finalizar."
        )

    if not all_greenmile_orders:
        raise RuntimeError(
            "La consulta de exploracion no devolvio ningun stops.orders.number."
        )

    output_records = [
        found_shipments.get(shipment)
        or create_not_migrated_record(programmed_by_number[shipment])
        for shipment in sorted(programmed_by_number)
    ]

    with OUTPUT_FILE.open("w", encoding="utf-8", newline="") as file:
        json.dump(output_records, file, ensure_ascii=False, indent=2)
        file.write("\n")

    migrated = sum(
        record["EstadoMigracion"] == "MIGRADO"
        for record in output_records
    )
    rejected = sum(
        record["EstadoEntrega"] == "RECHAZADO"
        for record in output_records
    )
    with_coordinates = sum(
        record.get("LatitudActual") is not None
        and record.get("LongitudActual") is not None
        for record in output_records
    )

    not_found_shipments = programmed_numbers - set(found_shipments)
    greenmile_not_in_roadmap = all_greenmile_orders - programmed_numbers
    migration_ratio = migrated / len(output_records) if output_records else 0

    print("\nRESUMEN")
    print(f"Rutas revisadas: {total_routes_reviewed}")
    print(
        "Rutas con shipment programado detectadas: "
        f"{routes_with_programmed_shipments}"
    )
    print(f"Pedidos unicos observados en GreenMile: {len(all_greenmile_orders)}")
    print(
        "Shipments programados detectados: "
        f"{len(matched_shipments_in_scan)}"
    )
    print(f"Shipments migrados: {migrated}")
    print(f"Shipments no migrados: {len(output_records) - migrated}")
    print(f"Porcentaje migrado: {migration_ratio:.2%}")
    print(
        "Shipments RoadMap no encontrados en GreenMile: "
        f"{len(not_found_shipments)}"
    )
    print(
        "Pedidos GreenMile no incluidos en RoadMap actual: "
        f"{len(greenmile_not_in_roadmap)}"
    )
    print(f"Shipments rechazados: {rejected}")
    print(f"Shipments con coordenadas: {with_coordinates}")
    print(f"Estados de ruta observados: {dict(observed_route_statuses)}")
    print(f"Estados de entrega observados: {dict(observed_delivery_statuses)}")

    if not_found_shipments:
        print("\nPrimeros shipments RoadMap no encontrados en GreenMile:")
        for shipment in sorted(not_found_shipments)[:50]:
            programmed = programmed_by_number[shipment]
            print(
                f"  {shipment} | "
                f"VehicleKey={clean_text(programmed.get('VehicleKey'))} | "
                f"Location={clean_text(programmed.get('Location'))} | "
                f"DeliveryDate={clean_text(programmed.get('DeliveryDate'))}"
            )

    print(f"\nArchivo generado: {OUTPUT_FILE}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
