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


# =============================================================================
# ARCHIVOS Y ENDPOINT
# =============================================================================

ROADMAP_FILE = Path("RoadMap_Shipment.json")
OUTPUT_FILE = Path("GreenMile_Estados.json")

GREENMILE_URL = (
    "https://sigmaperu.greenmile.com/Route/restrictions"
)


# =============================================================================
# CONFIGURACIÓN
# =============================================================================

SCAN_PAGE_SIZE = int(
    os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100")
)

DETAIL_PAGE_SIZE = int(
    os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10")
)

MAX_PAGES = int(
    os.getenv("GREENMILE_MAX_PAGES", "2000")
)

HTTP_RETRIES = int(
    os.getenv("GREENMILE_HTTP_RETRIES", "3")
)

DEBUG_REJECTED_LIMIT = int(
    os.getenv("GREENMILE_DEBUG_REJECTED_LIMIT", "12")
)

DEBUG_REJECTED_COUNT = 0


# =============================================================================
# CAMPOS DE CONSULTA
# =============================================================================

# La consulta inicial revisa todas las rutas y recupera únicamente la
# información necesaria para localizar rutas que contienen alguno de los
# ShipmentCustom programados.
#
# No se utiliza fecha, Location ni organización para decidir la coincidencia.
# La llave única es:
#
# RoadMap ShipmentCustom = GreenMile stops.orders.number
#
SCAN_FIELDS = [
    "id",
    "organization.key",
    "date",
    "key",
    "status",
    "stops.orders.number",
]


# Una vez encontrada una ruta con uno o más ShipmentCustom programados,
# se recupera el detalle completo de esa ruta.
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


# =============================================================================
# ESTADOS Y CAMPOS DE DIAGNÓSTICO
# =============================================================================

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


# =============================================================================
# FUNCIONES GENERALES
# =============================================================================

def clean_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"

    return str(value).strip()


def normalise_status(value: Any) -> str:
    return clean_text(value).upper()


def normalise_key(value: Any) -> str:
    text = unicodedata.normalize(
        "NFKD",
        clean_text(value),
    )

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


def normalise_shipment_number(value: Any) -> str:
    """
    Normaliza ShipmentCustom y order.number sin eliminar ceros iniciales.

    Se aplican únicamente transformaciones seguras:
    - conversión a texto;
    - normalización Unicode;
    - eliminación de espacios y caracteres de espacio no separable.

    No se convierte el shipment a número porque el identificador debe
    tratarse como una llave textual.
    """

    text = unicodedata.normalize(
        "NFKC",
        clean_text(value),
    )

    text = text.replace("\u00A0", "")

    return "".join(text.split())


def to_number(value: Any) -> Optional[float\]:
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
            f"No se configuro el secreto obligatorio: {name}"
        )

    return value


# =============================================================================
# CARGA DEL ROADMAP
# =============================================================================

def load_programmed_shipments() -> list[dict[str, Any]\]:
    if not ROADMAP_FILE.exists():
        raise FileNotFoundError(
            f"No existe {ROADMAP_FILE}."
        )

    with ROADMAP_FILE.open(
        "r",
        encoding="utf-8",
    ) as file:
        records = json.load(file)

    if not isinstance(records, list) or not records:
        raise ValueError(
            "RoadMap_Shipment.json no contiene datos."
        )

    valid_records: list[dict[str, Any]] = []
    shipments_seen: set[str] = set()

    for position, record in enumerate(records, start=1):
        if not isinstance(record, dict):
            raise ValueError(
                f"El registro {position} no es un objeto JSON."
            )

        shipment = normalise_shipment_number(
            record.get("ShipmentCustom")
        )

        delivery_date = clean_text(
            record.get("DeliveryDate")
        )

        if shipment == "":
            continue

        if delivery_date == "":
            raise ValueError(
                f"El Shipment {shipment} no tiene DeliveryDate."
            )

        if shipment in shipments_seen:
            raise ValueError(
                "ShipmentCustom duplicado en "
                f"RoadMap_Shipment.json: {shipment}"
            )

        shipments_seen.add(shipment)

        valid_records.append(
            {
                **record,
                "ShipmentCustom": shipment,
                "DeliveryDate": delivery_date,
                "VehicleKey": clean_text(
                    record.get("VehicleKey")
                ),
                "Location": clean_text(
                    record.get("Location")
                ),
            }
        )

    if not valid_records:
        raise ValueError(
            "No se encontraron shipments validos."
        )

    return valid_records


# =============================================================================
# AUTENTICACIÓN Y CONSULTA API
# =============================================================================

def build_basic_authorisation(
    username: str,
    password: str,
) -> str:
    raw = f"{username}:{password}".encode("utf-8")

    return (
        "Basic "
        + base64.b64encode(raw).decode("ascii")
    )


def request_routes_page(
    fields: list[str],
    first_result: int,
    max_results: int,
    authorisation: str,
) -> list[dict[str, Any]\]:
    criteria = {
        "filters": fields,
        "firstResult": first_result,
        "maxResults": max_results,
    }

    encoded = urllib.parse.quote(
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
            with urllib.request.urlopen(
                request,
                timeout=120,
            ) as response:
                response_text = (
                    response.read().decode("utf-8")
                )

            data = json.loads(response_text)

            if not isinstance(data, list):
                raise RuntimeError(
                    "La respuesta de GreenMile "
                    "no es una matriz."
                )

            return data

        except urllib.error.HTTPError as error:
            body = error.read().decode(
                "utf-8",
                errors="replace",
            )

            latest_error = RuntimeError(
                f"GreenMile HTTP {error.code}; "
                f"firstResult={first_result}; "
                f"maxResults={max_results}; "
                f"respuesta={body[:1000]}"
            )

            if error.code not in {
                429,
                500,
                502,
                503,
                504,
            }:
                raise latest_error from error

        except (
            urllib.error.URLError,
            json.JSONDecodeError,
        ) as error:
            latest_error = RuntimeError(
                "Error al consultar GreenMile; "
                f"firstResult={first_result}; "
                f"maxResults={max_results}; "
                f"error={error}"
            )

        if attempt < HTTP_RETRIES:
            wait_seconds = attempt * 2

            print(
                f"Reintento en {wait_seconds}s..."
            )

            time.sleep(wait_seconds)

    if latest_error is not None:
        raise latest_error

    raise RuntimeError(
        "Error no identificado al consultar GreenMile."
    )


def get_route_ids(
    routes: list[dict[str, Any]],
) -> set[str\]:
    return {
        clean_text(route.get("id"))
        for route in routes
        if clean_text(route.get("id")) != ""
    }


# =============================================================================
# BÚSQUEDA DE SHIPMENTS EN LAS RUTAS
# =============================================================================

def get_order_numbers_in_route(
    route: dict[str, Any],
) -> set[str\]:
    order_numbers: set[str] = set()

    for stop in route.get("stops") or [\]:
        if not isinstance(stop, dict):
            continue

        for order in stop.get("orders") or [\]:
            if not isinstance(order, dict):
                continue

            shipment_number = normalise_shipment_number(
                order.get("number")
            )

            if shipment_number != "":
                order_numbers.add(shipment_number)

    return order_numbers


def get_programmed_shipments_in_route(
    route: dict[str, Any],
    programmed_by_number: dict[str, dict[str, Any]],
) -> set[str\]:
    return {
        shipment_number
        for shipment_number in get_order_numbers_in_route(
            route
        )
        if shipment_number in programmed_by_number
    }


# =============================================================================
# EXTRACCIÓN DE MOTIVOS
# =============================================================================

def scalar_from_value(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""

    if isinstance(value, (str, int, float)):
        text = clean_text(value)

        if normalise_status(text) in TECHNICAL_VALUES:
            return ""

        return text

    if isinstance(value, dict):
        normalised = {
            normalise_key(key): child
            for key, child in value.items()
        }

        for preferred_key in PREFERRED_TEXT_KEYS:
            text = scalar_from_value(
                normalised.get(
                    normalise_key(preferred_key)
                )
            )

            if text != "":
                return text

        for child in value.values():
            text = scalar_from_value(child)

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


def is_reason_path(path: str) -> bool:
    key = normalise_key(path)

    return any(
        token in key
        for token in REASON_KEY_TOKENS
    )


def is_technical_path(path: str) -> bool:
    key = normalise_key(path)

    return any(
        token in key
        for token in TECHNICAL_KEY_TOKENS
    )


def discover_reason_candidates(
    value: Any,
    path: str = "",
) -> list[tuple[str, str]\]:
    candidates: list[tuple[str, str]] = []

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (
                f"{path}.{key}"
                if path
                else key
            )

            if (
                is_reason_path(child_path)
                and not is_technical_path(child_path)
            ):
                text = scalar_from_value(child)

                if text != "":
                    candidates.append(
                        (child_path, text)
                    )

            candidates.extend(
                discover_reason_candidates(
                    child,
                    child_path,
                )
            )

    elif isinstance(value, list):
        for index, child in enumerate(value):
            candidates.extend(
                discover_reason_candidates(
                    child,
                    f"{path}[{index}]",
                )
            )

    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

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
) -> tuple[
    str,
    str,
    list[tuple[str, str]],
\]:
    candidates = (
        discover_reason_candidates(
            order,
            "order",
        )
        + discover_reason_candidates(
            stop,
            "stop",
        )
    )

    motivo_no_entrega = ""
    motivo_cancelacion = ""
    motivo_generico = ""

    for path, text in candidates:
        category = classify_reason_path(path)

        if (
            category == "CANCELACION"
            and motivo_cancelacion == ""
        ):
            motivo_cancelacion = text

        elif (
            category == "NO_ENTREGA"
            and motivo_no_entrega == ""
        ):
            motivo_no_entrega = text

        elif motivo_generico == "":
            motivo_generico = text

    if (
        motivo_no_entrega == ""
        and motivo_generico != ""
    ):
        motivo_no_entrega = motivo_generico

    return (
        motivo_no_entrega,
        motivo_cancelacion,
        candidates,
    )


# =============================================================================
# DIAGNÓSTICO DE RECHAZOS
# =============================================================================

def dump_rejected_objects(
    shipment_number: str,
    delivery_status_raw: str,
    stop: dict[str, Any],
    order: dict[str, Any],
) -> None:
    global DEBUG_REJECTED_COUNT

    if (
        delivery_status_raw
        not in REJECTED_DELIVERY_STATUSES
    ):
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

    print(
        "DEBUG_RECHAZO_INICIO "
        f"{DEBUG_REJECTED_COUNT}/"
        f"{DEBUG_REJECTED_LIMIT}"
    )

    print(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )

    print("DEBUG_RECHAZO_FIN")
    print("=" * 100 + "\n")


# =============================================================================
# MAPEO DE ESTADOS
# =============================================================================

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
        or motivo
