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
DEBUG_FILE = Path("GreenMile_Rechazos_Debug.json")
GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"

SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
MAX_DEBUG_REJECTS = int(os.getenv("GREENMILE_MAX_DEBUG_REJECTS", "100"))

LIGHT_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
]

# Se pide el objeto completo de paradas y pedidos para descubrir la estructura
# real de motivos de rechazo/cancelación en este ambiente de GreenMile.
DETAIL_FIELDS = [
    "id",
    "organization.*",
    "date",
    "key",
    "status",
    "driverAssignments.*",
    "stops.*",
    "stops.orders.*",
    "canceledStops",
    "undeliveredStops",
    "redeliveredStops",
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
    "refusal",
    "refused",
    "failure",
    "failed",
    "exception",
    "occurrence",
    "incident",
    "returnreason",
    "nonDelivery",
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
    text = "".join(
        character
        for character in text
        if not unicodedata.combining(character)
    )
    return "".join(
        character.lower()
        for character in text
        if character.isalnum()
    )


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
        raise RuntimeError(
            f"No se configuró el secreto obligatorio: {name}"
        )
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
            raise ValueError(
                f"El registro {position} no es un objeto JSON."
            )

        shipment = clean_text(record.get("ShipmentCustom"))
        delivery_date = clean_text(record.get("DeliveryDate"))

        if shipment == "":
            continue

        if delivery_date == "":
            raise ValueError(
                f"El Shipment {shipment} no tiene DeliveryDate."
            )

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
        json.dumps(
            criteria,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        safe="",
    )

    latest_error: Optional[Exception] = None

    for attempt in range(1, HTTP_RETRIES + 1):
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

            try:
                data = json.loads(response_text)
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    "GreenMile no devolvió JSON válido. "
                    f"firstResult={first_result}. "
                    f"Respuesta={response_text[:1000]}"
                ) from error

            if not isinstance(data, list):
                raise RuntimeError(
                    "La respuesta de GreenMile no es una matriz."
                )

            return data

        except urllib.error.HTTPError as error:
            error_body = error.read().decode(
                "utf-8",
                errors="replace",
            )
            latest_error = RuntimeError(
                f"GreenMile respondió HTTP {error.code}. "
                f"firstResult={first_result}, "
                f"maxResults={max_results}. "
                f"Respuesta={error_body[:1000]}"
            )

            if error.code not in {429, 500, 502, 503, 504}:
                raise latest_error from error

        except urllib.error.URLError as error:
            latest_error = RuntimeError(
                "No fue posible conectar con GreenMile. "
                f"firstResult={first_result}, "
                f"maxResults={max_results}. "
                f"Error={error}"
            )

        if attempt < HTTP_RETRIES:
            wait_seconds = attempt * 2
            print(
                f"Reintento HTTP {attempt + 1}/{HTTP_RETRIES} "
                f"en {wait_seconds}s. "
                f"firstResult={first_result}, "
                f"maxResults={max_results}"
            )
            time.sleep(wait_seconds)

    if latest_error is not None:
        raise latest_error

    raise RuntimeError(
        "Error HTTP no identificado al consultar GreenMile."
    )


def get_route_ids(routes: list[dict[str, Any]]) -> set[str]:
    return {
        clean_text(route.get("id"))
        for route in routes
        if clean_text(route.get("id")) != ""
    }


def is_technical_path(path: str) -> bool:
    normalised_path = normalise_key(path)
    return any(
        normalise_key(token) in normalised_path
        for token in TECHNICAL_KEY_TOKENS
    )


def is_reason_path(path: str) -> bool:
    normalised_path = normalise_key(path)
    return any(
        normalise_key(token) in normalised_path
        for token in REASON_KEY_TOKENS
    )


def scalar_from_value(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""

    if isinstance(value, (str, int, float)):
        text = clean_text(value)
        if normalise_status(text) in TECHNICAL_VALUES:
            return ""
        return text

    if isinstance(value, dict):
        normalised_items = {
            normalise_key(key): item
            for key, item in value.items()
        }

        for preferred_key in PREFERRED_TEXT_KEYS:
            candidate = normalised_items.get(
                normalise_key(preferred_key)
            )
            text = scalar_from_value(candidate)
            if text != "":
                return text

        for item in value.values():
            text = scalar_from_value(item)
            if text != "":
                return text

        return ""

    if isinstance(value, list):
        texts: list[str] = []
        for item in value:
            text = scalar_from_value(item)
            if text != "" and text not in texts:
                texts.append(text)
        return " | ".join(texts)

    return ""


def discover_reason_candidates(
    value: Any,
    path: str = "",
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key

            if (
                is_reason_path(child_path)
                and not is_technical_path(child_path)
            ):
                text = scalar_from_value(child)
                if text != "":
                    candidates.append((child_path, text))

            candidates.extend(
                discover_reason_candidates(child, child_path)
            )

    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            candidates.extend(
                discover_reason_candidates(child, child_path)
            )

    unique_candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for candidate in candidates:
        if candidate not in seen:
            unique_candidates.append(candidate)
            seen.add(candidate)

    return unique_candidates


def classify_reason_path(path: str) -> str:
    normalised_path = normalise_key(path)

    if "cancel" in normalised_path:
        return "CANCELACION"

    if any(
        token in normalised_path
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

    reason_not_delivered = ""
    reason_cancelled = ""
    generic_reason = ""

    for path, text in candidates:
        classification = classify_reason_path(path)

        if (
            classification == "CANCELACION"
            and reason_cancelled == ""
        ):
            reason_cancelled = text
        elif (
            classification == "NO_ENTREGA"
            and reason_not_delivered == ""
        ):
            reason_not_delivered = text
        elif generic_reason == "":
            generic_reason = text

    if reason_not_delivered == "" and generic_reason != "":
        reason_not_delivered = generic_reason

    return reason_not_delivered, reason_cancelled, candidates


def map_delivery_status(
    delivery_status: Any,
    reason_not_delivered: str,
    reason_cancelled: str,
) -> str:
    status = normalise_status(delivery_status)

    if status == "DELIVERED":
        return "ENTREGADO"

    if (
        status in REJECTED_DELIVERY_STATUSES
        or reason_not_delivered != ""
        or reason_cancelled != ""
    ):
        return "RECHAZADO"

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
        "DELIVERED": 40,
        "REJECTED": 35,
        "UNDELIVERED": 35,
        "NOT_DELIVERED": 35,
        "CANCELED": 35,
        "CANCELLED": 35,
        "FAILED": 35,
        "PENDING": 10,
        "": 0,
    }
    return priorities.get(normalise_status(value), 5)


def reason_score(record: dict[str, Any]) -> int:
    return sum(
        1
        for field in (
            "MotivoNoEntrega",
            "MotivoCancelacion",
        )
        if clean_text(record.get(field)) != ""
    )


def choose_best_record(
    existing: Optional[dict[str, Any]],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    if existing is None:
        return candidate

    existing_priority = delivery_priority(
        existing.get("DeliveryStatusRaw")
    )
    candidate_priority = delivery_priority(
        candidate.get("DeliveryStatusRaw")
    )

    if candidate_priority > existing_priority:
        return candidate

    if (
        candidate_priority == existing_priority
        and reason_score(candidate) > reason_score(existing)
    ):
        return candidate

    return existing


def extract_coordinates(
    stop: dict[str, Any],
) -> tuple[Optional[float], Optional[float], str]:
    coordinate_pairs = [
        ("serviceLatitude", "serviceLongitude", "SERVICIO"),
        ("departureLatitude", "departureLongitude", "PARTIDA"),
        ("arrivalLatitude", "arrivalLongitude", "LLEGADA"),
        (
            "cancellationLatitude",
            "cancellationLongitude",
            "CANCELACIÓN",
        ),
        ("cancelLatitude", "cancelLongitude", "CANCELACIÓN"),
        ("latitude", "longitude", "PARADA"),
    ]

    for latitude_key, longitude_key, source in coordinate_pairs:
        latitude = to_number(stop.get(latitude_key))
        longitude = to_number(stop.get(longitude_key))

        if latitude is not None and longitude is not None:
            return latitude, longitude, source

    return None, None, ""


def create_not_migrated_record(
    programmed: dict[str, Any],
) -> dict[str, Any]:
    return {
        "ShipmentCustom": clean_text(
            programmed.get("ShipmentCustom")
        ),
        "VehicleKey": clean_text(
            programmed.get("VehicleKey")
        ),
        "Location": clean_text(
            programmed.get("Location")
        ),
        "FechaOperacion": clean_text(
            programmed.get("DeliveryDate")
        ),
        "EstadoMigracion": "NO MIGRADO",
        "EstadoConexion": "NO APLICA",
        "EstadoEntrega": "SIN INFORMACIÓN",
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
    rejected_debug_records: list[dict[str, Any]],
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
            delivery_status_raw = normalise_status(
                stop.get("deliveryStatus")
            )
            observed_delivery_statuses[delivery_status_raw] += 1

            latitude, longitude, coordinate_source = (
                extract_coordinates(stop)
            )

            for order in stop.get("orders") or []:
                shipment_number = clean_text(
                    order.get("number")
                )

                if (
                    shipment_number == ""
                    or shipment_number not in programmed_by_number
                ):
                    continue

                (
                    reason_not_delivered,
                    reason_cancelled,
                    reason_candidates,
                ) = extract_rejection_reasons(stop, order)

                for path, text in reason_candidates:
                    observed_reason_candidates[
                        f"{path}={text}"
                    ] += 1

                mapped_delivery_status = map_delivery_status(
                    delivery_status_raw,
                    reason_not_delivered,
                    reason_cancelled,
                )

                if (
                    mapped_delivery_status == "RECHAZADO"
                    and len(rejected_debug_records)
                    < MAX_DEBUG_REJECTS
                ):
                    rejected_debug_records.append(
                        {
                            "ShipmentCustom": shipment_number,
                            "DeliveryStatusRaw": delivery_status_raw,
                            "RouteKey": vehicle_key,
                            "RouteStatus": route_status_raw,
                            "RouteDate": route_date,
                            "MotivoNoEntregaDetectado": (
                                reason_not_delivered
                            ),
                            "MotivoCancelacionDetectado": (
                                reason_cancelled
                            ),
                            "CandidatosDetectados": [
                                {
                                    "RutaCampo": path,
                                    "Valor": text,
                                }
                                for path, text in reason_candidates
                            ],
                            "StopCompleto": stop,
                            "OrderCompleto": order,
                        }
                    )

                candidate = {
                    "ShipmentCustom": shipment_number,
                    "VehicleKey": vehicle_key,
                    "Location": location,
                    "FechaOperacion": route_date,
                    "EstadoMigracion": "MIGRADO",
                    "EstadoConexion": map_connection_status(
                        route_status_raw
                    ),
                    "EstadoEntrega": mapped_delivery_status,
                    "LatitudActual": latitude,
                    "LongitudActual": longitude,
                    "FuenteCoordenada": coordinate_source,
                    "DeliveryStatusRaw": delivery_status_raw,
                    "MotivoNoEntrega": reason_not_delivered,
                    "MotivoCancelacion": reason_cancelled,
                }

                found_shipments[shipment_number] = (
                    choose_best_record(
                        found_shipments.get(shipment_number),
                        candidate,
                    )
                )

    return matching_routes


def main() -> None:
    username = require_environment_variable(
        "GREENMILE_USERNAME"
    )
    password = require_environment_variable(
        "GREENMILE_PASSWORD"
    )
    authorisation = build_basic_authorisation(
        username,
        password,
    )

    programmed_shipments = load_programmed_shipments()
    programmed_by_number = {
        record["ShipmentCustom"]: record
        for record in programmed_shipments
    }
    target_dates = {
        record["DeliveryDate"]
        for record in programmed_shipments
    }

    print(
        "Fechas operativas: "
        + ", ".join(sorted(target_dates))
    )
    print(
        f"Shipments programados: {len(programmed_by_number)}"
    )

    found_shipments: dict[str, dict[str, Any]] = {}
    observed_delivery_statuses: Counter[str] = Counter()
    observed_route_statuses: Counter[str] = Counter()
    observed_reason_candidates: Counter[str] = Counter()
    rejected_debug_records: list[dict[str, Any]] = []

    first_result = 0
    page_number = 0
    total_routes_reviewed = 0
    matching_routes = 0
    previous_page_signature: Optional[frozenset[str]] = None

    while page_number < MAX_PAGES:
        light_routes = request_routes_page(
            fields=LIGHT_FIELDS,
            first_result=first_result,
            max_results=SCAN_PAGE_SIZE,
            authorisation=authorisation,
        )
        page_number += 1

        if len(light_routes) == 0:
            print(
                f"Fin de paginación. firstResult={first_result}"
            )
            break

        current_page_signature = frozenset(
            get_route_ids(light_routes)
        )
        if (
            current_page_signature
            and current_page_signature
            == previous_page_signature
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
            f"Página {page_number}: "
            f"firstResult={first_result}, "
            f"rutas={len(light_routes)}, "
            f"fechas={sorted(page_dates)}, "
            f"coincidencias={sorted(matching_dates)}"
        )

        if matching_dates:
            light_page_ids = get_route_ids(light_routes)
            detail_ids_seen: set[str] = set()

            for detail_offset in range(
                0,
                len(light_routes),
                DETAIL_PAGE_SIZE,
            ):
                detail_first_result = (
                    first_result + detail_offset
                )
                detail_max_results = min(
                    DETAIL_PAGE_SIZE,
                    len(light_routes) - detail_offset,
                )

                print(
                    "  Detalle: "
                    f"firstResult={detail_first_result}, "
                    f"maxResults={detail_max_results}"
                )

                detail_routes = request_routes_page(
                    fields=DETAIL_FIELDS,
                    first_result=detail_first_result,
                    max_results=detail_max_results,
                    authorisation=authorisation,
                )

                detail_ids_seen.update(
                    get_route_ids(detail_routes)
                )
                matching_routes += process_detail_routes(
                    detail_routes=detail_routes,
                    target_dates=target_dates,
                    programmed_by_number=programmed_by_number,
                    found_shipments=found_shipments,
                    observed_route_statuses=(
                        observed_route_statuses
                    ),
                    observed_delivery_statuses=(
                        observed_delivery_statuses
                    ),
                    observed_reason_candidates=(
                        observed_reason_candidates
                    ),
                    rejected_debug_records=(
                        rejected_debug_records
                    ),
                )

            missing_ids = light_page_ids - detail_ids_seen
            if missing_ids:
                print(
                    "ADVERTENCIA: la consulta detallada "
                    f"no devolvió {len(missing_ids)} rutas "
                    "de la página ligera."
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
            or create_not_migrated_record(
                programmed_by_number[shipment_number]
            )
        )

    with OUTPUT_FILE.open(
        "w",
        encoding="utf-8",
        newline="",
    ) as file:
        json.dump(
            output_records,
            file,
            ensure_ascii=False,
            indent=2,
        )
        file.write("\n")

    with DEBUG_FILE.open(
        "w",
        encoding="utf-8",
        newline="",
    ) as file:
        json.dump(
            rejected_debug_records,
            file,
            ensure_ascii=False,
            indent=2,
            default=str,
        )
        file.write("\n")

    migrated_count = sum(
        record["EstadoMigracion"] == "MIGRADO"
        for record in output_records
    )
    rejected_count = sum(
        record["EstadoEntrega"] == "RECHAZADO"
        for record in output_records
    )
    rejected_with_reason_count = sum(
        record["EstadoEntrega"] == "RECHAZADO"
        and (
            clean_text(record.get("MotivoNoEntrega")) != ""
            or clean_text(record.get("MotivoCancelacion")) != ""
        )
        for record in output_records
    )
    coordinates_count = sum(
        record.get("LatitudActual") is not None
        and record.get("LongitudActual") is not None
        for record in output_records
    )

    print("\nRESUMEN")
    print(f"Rutas revisadas: {total_routes_reviewed}")
    print(
        f"Rutas de fecha operativa: {matching_routes}"
    )
    print(f"Shipments migrados: {migrated_count}")
    print(
        "Shipments no migrados: "
        f"{len(output_records) - migrated_count}"
    )
    print(f"Shipments rechazados: {rejected_count}")
    print(
        "Rechazados con motivo: "
        f"{rejected_with_reason_count}"
    )
    print(
        f"Shipments con coordenadas: {coordinates_count}"
    )
    print(
        "Estados de ruta observados: "
        f"{dict(observed_route_statuses)}"
    )
    print(
        "Estados de entrega observados: "
        f"{dict(observed_delivery_statuses)}"
    )

    if observed_reason_candidates:
        print("Candidatos de motivo observados:")
        for candidate, count in (
            observed_reason_candidates.most_common(50)
        ):
            print(f"  {count} x {candidate}")
    else:
        print(
            "Candidatos de motivo observados: ninguno"
        )

    print(f"Archivo generado: {OUTPUT_FILE}")
    print(f"Archivo diagnóstico: {DEBUG_FILE}")
    print(
        "Rechazos guardados para diagnóstico: "
        f"{len(rejected_debug_records)}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
