import base64
import json
import os
import sys
import time
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
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
DEBUG_REJECTED_LIMIT = int(os.getenv("GREENMILE_DEBUG_REJECTED_LIMIT", "12"))
DEBUG_REJECTED_COUNT = 0

LIGHT_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
]

DETAIL_FIELDS = [
    "id",
    "organization.*",
    "date",
    "key",
    "status",
    "driverAssignments.*",
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

REASON_KEY_TOKENS = (
    "reason",
    "razon",
    "motivo",
    "undeliver",
    "notdeliver",
    "noentreg",
    "reject",
    "rechaz",
    "failure",
    "failed",
    "refusal",
    "refused",
    "exception",
    "occurrence",
    "incident",
    "returnreason",
    "cancelreason",
    "cancellationreason",
)

TECHNICAL_KEY_TOKENS = (
    "latitude",
    "longitude",
    "accuracy",
    "distance",
    "provider",
    "gps",
    "quality",
    "conformity",
    "actualcancel",
    "timestamp",
    "datetime",
)

TECHNICAL_VALUES = {
    "DRIVER_ENTERED",
    "ROUTER_INFERRED",
    "FUSED",
    "GPS",
    "TRUE",
    "FALSE",
    "0",
}

PREFERRED_TEXT_KEYS = (
    "description",
    "name",
    "label",
    "reason",
    "value",
    "displayName",
    "key",
    "code",
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
    text = "".join(c for c in text if not unicodedata.combining(c))
    return "".join(c.lower() for c in text if c.isalnum())


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

    valid_records = []
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


def scalar_from_value(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""

    if isinstance(value, (str, int, float)):
        text = clean_text(value)
        if normalise_status(text) in TECHNICAL_VALUES:
            return ""
        return text

    if isinstance(value, dict):
        normalised = {normalise_key(k): v for k, v in value.items()}
        for preferred_key in PREFERRED_TEXT_KEYS:
            text = scalar_from_value(normalised.get(normalise_key(preferred_key)))
            if text != "":
                return text
        for item in value.values():
            text = scalar_from_value(item)
            if text != "":
                return text
        return ""

    if isinstance(value, list):
        texts = []
        for item in value:
            text = scalar_from_value(item)
            if text != "" and text not in texts:
                texts.append(text)
        return " | ".join(texts)

    return ""


def is_reason_path(path: str) -> bool:
    key = normalise_key(path)
    return any(token in key for token in REASON_KEY_TOKENS)


def is_technical_path(path: str) -> bool:
    key = normalise_key(path)
    return any(token in key for token in TECHNICAL_KEY_TOKENS)


def discover_reason_candidates(
    value: Any,
    path: str = "",
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if is_reason_path(child_path) and not is_technical_path(child_path):
                text = scalar_from_value(child)
                if text != "":
                    candidates.append((child_path, text))
            candidates.extend(discover_reason_candidates(child, child_path))

    elif isinstance(value, list):
        for index, child in enumerate(value):
            candidates.extend(
                discover_reason_candidates(child, f"{path}[{index}]")
            )

    unique = []
    seen = set()
    for candidate in candidates:
        if candidate not in seen:
            unique.append(candidate)
            seen.add(candidate)
    return unique


def classify_reason_path(path: str) -> str:
    key = normalise_key(path)
    if "cancel" in key:
        return "CANCELACION"
    if any(
        token in key
        for token in (
            "undeliver",
            "notdeliver",
            "noentreg",
            "reject",
            "rechaz",
            "refusal",
            "failed",
            "failure",
        )
    ):
        return "NO_ENTREGA"
    return "GENERICA"


def extract_rejection_reasons(
    stop: dict[str, Any],
    order: dict[str, Any],
) -> tuple[str, str, list[tuple[str, str]]]:
    candidates = (
        discover_reason_candidates(order, "order")
        + discover_reason_candidates(stop, "stop")
    )

    motivo_no_entrega = ""
    motivo_cancelacion = ""
    motivo_generico = ""

    for path, text in candidates:
        category = classify_reason_path(path)
        if category == "CANCELACION" and motivo_cancelacion == "":
            motivo_cancelacion = text
        elif category == "NO_ENTREGA" and motivo_no_entrega == "":
            motivo_no_entrega = text
        elif motivo_generico == "":
            motivo_generico = text

    if motivo_no_entrega == "" and motivo_generico != "":
        motivo_no_entrega = motivo_generico

    return motivo_no_entrega, motivo_cancelacion, candidates


def dump_rejected_objects(
    shipment_number: str,
    delivery_status_raw: str,
    stop: dict[str, Any],
    order: dict[str, Any],
) -> None:
    global DEBUG_REJECTED_COUNT

    if delivery_status_raw not in REJECTED_DELIVERY_STATUSES:
        return
    if DEBUG_REJECTED_COUNT >= DEBUG_REJECTED_LIMIT:
        return

    DEBUG_REJECTED_COUNT += 1
    payload = {
        "ShipmentCustom": shipment_number,
        "DeliveryStatusRaw": delivery_status_raw,
        "StopCompleto": stop,
        "OrderCompleto": order,
    }

    print("\n" + "=" * 100)
    print(f"DEBUG_RECHAZO_INICIO {DEBUG_REJECTED_COUNT}/{DEBUG_REJECTED_LIMIT}")
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    print("DEBUG_RECHAZO_FIN")
    print("=" * 100 + "\n")


def map_delivery_status(
    delivery_status: Any,
    motivo_no_entrega: str,
    motivo_cancelacion: str,
) -> str:
    status = normalise_status(delivery_status)
    if status == "DELIVERED":
        return "ENTREGADO"
    if (
        status in REJECTED_DELIVERY_STATUSES
        or motivo_no_entrega != ""
        or motivo_cancelacion != ""
    ):
        return "RECHAZADO"
    if status == "PENDING":
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
        "PENDING": 10,
        "": 0,
    }.get(normalise_status(value), 5)


def reason_score(record: dict[str, Any]) -> int:
    return sum(
        clean_text(record.get(field)) != ""
        for field in ("MotivoNoEntrega", "MotivoCancelacion")
    )


def choose_best_record(
    existing: Optional[dict[str, Any]],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    if existing is None:
        return candidate

    old_priority = delivery_priority(existing.get("DeliveryStatusRaw"))
    new_priority = delivery_priority(candidate.get("DeliveryStatusRaw"))

    if new_priority > old_priority:
        return candidate
    if new_priority == old_priority and reason_score(candidate) > reason_score(existing):
        return candidate
    return existing


def extract_coordinates(
    stop: dict[str, Any],
) -> tuple[Optional[float], Optional[float], str]:
    pairs = [
        ("serviceLatitude", "serviceLongitude", "SERVICIO"),
        ("departureLatitude", "departureLongitude", "PARTIDA"),
        ("arrivalLatitude", "arrivalLongitude", "LLEGADA"),
        ("cancellationLatitude", "cancellationLongitude", "CANCELACION"),
        ("cancelLatitude", "cancelLongitude", "CANCELACION"),
        ("latitude", "longitude", "PARADA"),
    ]

    for latitude_key, longitude_key, source in pairs:
        latitude = to_number(stop.get(latitude_key))
        longitude = to_number(stop.get(longitude_key))
        if latitude is not None and longitude is not None:
            return latitude, longitude, source

    return None, None, ""


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


def process_detail_routes(
    detail_routes: list[dict[str, Any]],
    target_dates: set[str],
    programmed_by_number: dict[str, dict[str, Any]],
    found_shipments: dict[str, dict[str, Any]],
    observed_route_statuses: Counter[str],
    observed_delivery_statuses: Counter[str],
    observed_reason_candidates: Counter[str],
) -> int:
    matching_routes = 0

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
            delivery_status_raw = normalise_status(stop.get("deliveryStatus"))
            observed_delivery_statuses[delivery_status_raw] += 1
            latitude, longitude, coordinate_source = extract_coordinates(stop)

            for order in stop.get("orders") or []:
                shipment_number = clean_text(order.get("number"))
                if (
                    shipment_number == ""
                    or shipment_number not in programmed_by_number
                ):
                    continue

                dump_rejected_objects(
                    shipment_number,
                    delivery_status_raw,
                    stop,
                    order,
                )

                (
                    motivo_no_entrega,
                    motivo_cancelacion,
                    candidates,
                ) = extract_rejection_reasons(stop, order)

                for path, text in candidates:
                    observed_reason_candidates[f"{path}={text}"] += 1

                candidate = {
                    "ShipmentCustom": shipment_number,
                    "VehicleKey": vehicle_key,
                    "Location": location,
                    "FechaOperacion": route_date,
                    "EstadoMigracion": "MIGRADO",
                    "EstadoConexion": map_connection_status(route_status_raw),
                    "EstadoEntrega": map_delivery_status(
                        delivery_status_raw,
                        motivo_no_entrega,
                        motivo_cancelacion,
                    ),
                    "LatitudActual": latitude,
                    "LongitudActual": longitude,
                    "FuenteCoordenada": coordinate_source,
                    "DeliveryStatusRaw": delivery_status_raw,
                    "MotivoNoEntrega": motivo_no_entrega,
                    "MotivoCancelacion": motivo_cancelacion,
                }

                found_shipments[shipment_number] = choose_best_record(
                    found_shipments.get(shipment_number),
                    candidate,
                )

    return matching_routes


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
    observed_reason_candidates: Counter[str] = Counter()

    first_result = 0
    page_number = 0
    total_routes_reviewed = 0
    matching_routes = 0
    previous_page_signature: Optional[frozenset[str]] = None

    while page_number < MAX_PAGES:
        light_routes = request_routes_page(
            LIGHT_FIELDS,
            first_result,
            SCAN_PAGE_SIZE,
            authorisation,
        )
        page_number += 1

        if not light_routes:
            print(f"Fin de paginacion. firstResult={first_result}")
            break

        signature = frozenset(get_route_ids(light_routes))
        if signature and signature == previous_page_signature:
            raise RuntimeError(
                f"GreenMile devolvio la misma pagina. firstResult={first_result}."
            )
        previous_page_signature = signature

        total_routes_reviewed += len(light_routes)
        page_dates = {
            clean_text(route.get("date"))
            for route in light_routes
            if clean_text(route.get("date")) != ""
        }
        matching_dates = page_dates & target_dates

        print(
            f"Pagina {page_number}: firstResult={first_result}, "
            f"rutas={len(light_routes)}, fechas={sorted(page_dates)}, "
            f"coincidencias={sorted(matching_dates)}"
        )

        if matching_dates:
            for offset in range(0, len(light_routes), DETAIL_PAGE_SIZE):
                detail_first = first_result + offset
                detail_size = min(DETAIL_PAGE_SIZE, len(light_routes) - offset)
                print(
                    f"  Detalle: firstResult={detail_first}, "
                    f"maxResults={detail_size}"
                )

                detail_routes = request_routes_page(
                    DETAIL_FIELDS,
                    detail_first,
                    detail_size,
                    authorisation,
                )

                matching_routes += process_detail_routes(
                    detail_routes,
                    target_dates,
                    programmed_by_number,
                    found_shipments,
                    observed_route_statuses,
                    observed_delivery_statuses,
                    observed_reason_candidates,
                )

        first_result += len(light_routes)
    else:
        raise RuntimeError(
            f"Se alcanzo GREENMILE_MAX_PAGES={MAX_PAGES} sin finalizar."
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
        record["EstadoMigracion"] == "MIGRADO" for record in output_records
    )
    rejected = sum(
        record["EstadoEntrega"] == "RECHAZADO" for record in output_records
    )
    rejected_with_reason = sum(
        record["EstadoEntrega"] == "RECHAZADO"
        and (
            clean_text(record.get("MotivoNoEntrega")) != ""
            or clean_text(record.get("MotivoCancelacion")) != ""
        )
        for record in output_records
    )
    with_coordinates = sum(
        record.get("LatitudActual") is not None
        and record.get("LongitudActual") is not None
        for record in output_records
    )

    print("\nRESUMEN")
    print(f"Rutas revisadas: {total_routes_reviewed}")
    print(f"Rutas de fecha operativa: {matching_routes}")
    print(f"Shipments migrados: {migrated}")
    print(f"Shipments no migrados: {len(output_records) - migrated}")
    print(f"Shipments rechazados: {rejected}")
    print(f"Rechazados con motivo: {rejected_with_reason}")
    print(f"Shipments con coordenadas: {with_coordinates}")
    print(f"Estados de ruta observados: {dict(observed_route_statuses)}")
    print(f"Estados de entrega observados: {dict(observed_delivery_statuses)}")

    if observed_reason_candidates:
        print("Candidatos de motivo observados:")
        for candidate, count in observed_reason_candidates.most_common(50):
            print(f"  {count} x {candidate}")
    else:
        print("Candidatos de motivo observados: ninguno")

    print(f"Rechazos impresos para diagnostico: {DEBUG_REJECTED_COUNT}")
    print(f"Archivo generado: {OUTPUT_FILE}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
