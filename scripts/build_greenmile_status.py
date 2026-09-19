import base64
import json
import os
import sys
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

LIGHT_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
]

DETAIL_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
    "driverAssignments.driver.key",
    "stops.id",
    "stops.key",
    "stops.stopType.id",
    "stops.stopType.key",
    "stops.orders.*",
    "stops.deliveryStatus",
]


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalise_status(value: Any) -> str:
    return clean_text(value).upper()


def require_environment_variable(name: str) -> str:
    value = os.getenv(name, "").strip()
    if value == "":
        raise RuntimeError(f"No se configuró el secreto obligatorio: {name}")
    return value


def load_programmed_shipments() -> list[dict[str, Any]]:
    if not ROADMAP_FILE.exists():
        raise FileNotFoundError(
            f"No existe {ROADMAP_FILE} en la raíz del repositorio."
        )

    with ROADMAP_FILE.open("r", encoding="utf-8") as file:
        records = json.load(file)

    if not isinstance(records, list) or len(records) == 0:
        raise ValueError(
            "RoadMap_Shipment.json no contiene una matriz con datos."
        )

    valid_records: list[dict[str, Any]] = []

    for position, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            raise ValueError(f"El registro {position} no es un objeto JSON.")

        shipment = clean_text(record.get("ShipmentCustom"))
        delivery_date = clean_text(record.get("DeliveryDate"))

        if shipment == "":
            continue

        if delivery_date == "":
            raise ValueError(f"El Shipment {shipment} no tiene DeliveryDate.")

        valid_records.append(
            {
                **record,
                "ShipmentCustom": shipment,
                "DeliveryDate": delivery_date,
                "VehicleKey": clean_text(record.get("VehicleKey")),
                "Location": clean_text(record.get("Location")),
            }
        )

    if len(valid_records) == 0:
        raise ValueError("No se encontraron shipments válidos.")

    return valid_records


def build_basic_authorisation(username: str, password: str) -> str:
    credentials = f"{username}:{password}".encode("utf-8")
    encoded_credentials = base64.b64encode(credentials).decode("ascii")
    return f"Basic {encoded_credentials}"


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

    encoded_criteria = urllib.parse.quote(
        json.dumps(criteria, ensure_ascii=False, separators=(",", ":")),
        safe="",
    )

    request = urllib.request.Request(
        url=f"{GREENMILE_URL}?criteria={encoded_criteria}",
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
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GreenMile respondió HTTP {error.code}. "
            f"firstResult={first_result}. Respuesta={error_body[:1000]}"
        ) from error
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"No fue posible conectar con GreenMile. "
            f"firstResult={first_result}. Error={error}"
        ) from error

    try:
        data = json.loads(response_text)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"GreenMile no devolvió JSON válido. "
            f"firstResult={first_result}. Respuesta={response_text[:1000]}"
        ) from error

    if not isinstance(data, list):
        raise RuntimeError("La respuesta de GreenMile no es una matriz.")

    return data


def get_route_ids(routes: list[dict[str, Any]]) -> list[str]:
    return [clean_text(route.get("id")) for route in routes]


def map_delivery_status(value: Any) -> str:
    status = normalise_status(value)
    if status == "DELIVERED":
        return "ENTREGADO"
    if status == "PENDING":
        return "PENDIENTE"
    return "SIN INFORMACIÓN"


def map_connection_status(value: Any) -> str:
    status = normalise_status(value)
    if status in {"", "NOT_STARTED"}:
        return "SIN CONEXIÓN"
    return "CONECTADO"


def delivery_priority(value: Any) -> int:
    priorities = {
        "DELIVERED": 30,
        "PENDING": 10,
        "": 0,
    }
    return priorities.get(normalise_status(value), 5)


def choose_best_record(
    existing: Optional[dict[str, Any]],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    if existing is None:
        return candidate

    if delivery_priority(candidate.get("DeliveryStatusRaw")) > delivery_priority(
        existing.get("DeliveryStatusRaw")
    ):
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
        "EstadoEntrega": "SIN INFORMACIÓN",
        "DeliveryStatusRaw": "",
        "EstadoRutaRaw": "",
        "MotivoNoEntrega": "",
    }


def main() -> None:
    username = require_environment_variable("GREENMILE_USERNAME")
    password = require_environment_variable("GREENMILE_PASSWORD")
    authorisation = build_basic_authorisation(username, password)

    programmed_shipments = load_programmed_shipments()
    programmed_by_number = {
        record["ShipmentCustom"]: record for record in programmed_shipments
    }
    target_dates = {record["DeliveryDate"] for record in programmed_shipments}

    print("Fechas operativas: " + ", ".join(sorted(target_dates)))
    print(f"Shipments programados: {len(programmed_by_number)}")

    found_shipments: dict[str, dict[str, Any]] = {}
    observed_delivery_statuses: Counter[str] = Counter()
    observed_route_statuses: Counter[str] = Counter()

    first_result = 0
    page_number = 0
    total_routes_reviewed = 0
    matching_routes = 0
    previous_page_signature = ""

    while page_number < MAX_PAGES:
        light_routes = request_routes_page(
            fields=LIGHT_FIELDS,
            first_result=first_result,
            max_results=SCAN_PAGE_SIZE,
            authorisation=authorisation,
        )
        page_number += 1

        if len(light_routes) == 0:
            print(f"Fin de paginación. firstResult={first_result}")
            break

        current_page_signature = "|".join(get_route_ids(light_routes))
        if (
            current_page_signature != ""
            and current_page_signature == previous_page_signature
        ):
            raise RuntimeError(
                "GreenMile devolvió la misma página dos veces. "
                f"firstResult={first_result}."
            )
        previous_page_signature = current_page_signature

        total_routes_reviewed += len(light_routes)
        page_dates = {
            clean_text(route.get("date"))
            for route in light_routes
            if clean_text(route.get("date")) != ""
        }
        matching_dates = page_dates & target_dates

        print(
            f"Página {page_number}: firstResult={first_result}, "
            f"rutas={len(light_routes)}, fechas={sorted(page_dates)}, "
            f"coincidencias={sorted(matching_dates)}"
        )

        if matching_dates:
            detail_routes = request_routes_page(
                fields=DETAIL_FIELDS,
                first_result=first_result,
                max_results=len(light_routes),
                authorisation=authorisation,
            )

            if get_route_ids(light_routes) != get_route_ids(detail_routes):
                raise RuntimeError(
                    "El contenido de la página cambió entre la consulta ligera "
                    f"y la detallada. firstResult={first_result}."
                )

            for route in detail_routes:
                route_date = clean_text(route.get("date"))
                if route_date not in target_dates:
                    continue

                matching_routes += 1
                vehicle_key = clean_text(route.get("key"))
                route_status_raw = normalise_status(route.get("status"))
                observed_route_statuses[route_status_raw] += 1

                organization = route.get("organization") or {}
                location = clean_text(organization.get("key"))

                for stop in route.get("stops") or []:
                    delivery_status_raw = normalise_status(
                        stop.get("deliveryStatus")
                    )
                    observed_delivery_statuses[delivery_status_raw] += 1

                    for order in stop.get("orders") or []:
                        shipment_number = clean_text(order.get("number"))
                        if (
                            shipment_number == ""
                            or shipment_number not in programmed_by_number
                        ):
                            continue

                        candidate = {
                            "ShipmentCustom": shipment_number,
                            "VehicleKey": vehicle_key,
                            "Location": location,
                            "FechaOperacion": route_date,
                            "EstadoMigracion": "MIGRADO",
                            "EstadoConexion": map_connection_status(
                                route_status_raw
                            ),
                            "EstadoEntrega": map_delivery_status(
                                delivery_status_raw
                            ),
                            "DeliveryStatusRaw": delivery_status_raw,
                            "EstadoRutaRaw": route_status_raw,
                            "MotivoNoEntrega": "",
                        }

                        found_shipments[shipment_number] = choose_best_record(
                            found_shipments.get(shipment_number),
                            candidate,
                        )

        first_result += len(light_routes)
    else:
        raise RuntimeError(
            f"Se alcanzó GREENMILE_MAX_PAGES={MAX_PAGES} "
            "sin detectar el final de la información."
        )

    output_records: list[dict[str, Any]] = []
    for shipment_number in sorted(programmed_by_number):
        output_records.append(
            found_shipments.get(shipment_number)
            or create_not_migrated_record(programmed_by_number[shipment_number])
        )

    with OUTPUT_FILE.open("w", encoding="utf-8", newline="") as file:
        json.dump(output_records, file, ensure_ascii=False, indent=2)
        file.write("\n")

    migrated_count = sum(
        record["EstadoMigracion"] == "MIGRADO" for record in output_records
    )

    print("\nRESUMEN")
    print(f"Rutas revisadas: {total_routes_reviewed}")
    print(f"Rutas de fecha operativa: {matching_routes}")
    print(f"Shipments migrados: {migrated_count}")
    print(f"Shipments no migrados: {len(output_records) - migrated_count}")
    print(f"Estados de ruta observados: {dict(observed_route_statuses)}")
    print(f"Estados de entrega observados: {dict(observed_delivery_statuses)}")
    print(f"Archivo generado: {OUTPUT_FILE}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
