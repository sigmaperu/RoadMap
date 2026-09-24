#!/usr/bin/env python3
"""
Descubrimiento exhaustivo y controlado de campos GreenMile.

Alcance real:
- Descubre claves devueltas por consultas válidas con expansión amplia.
- Prueba individualmente nombres candidatos de campos para evitar que un campo
  inválido contamine toda la consulta.
- Prueba hojas concretas de relaciones (id/key/name/description/code/value/label)
  sin usar relation.*, que ya produjo QueryException en pruebas anteriores.
- Trabaja como máximo con rutas muestra que contengan CANCELED o UNDELIVERED.

No puede garantizar todos los campos internos del producto si no existe un esquema
OpenAPI/metadatos accesible, pero deja una matriz explícita 200/400/500 por campo.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Optional

GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"
TARGET_DATE = os.getenv("GREENMILE_TARGET_DATE", "2026-09-23").strip()
SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
PROBE_PAUSE_SECONDS = float(os.getenv("GREENMILE_PROBE_PAUSE_SECONDS", "0.15"))
MAX_SAMPLE_ROUTES = int(os.getenv("GREENMILE_MAX_SAMPLE_ROUTES", "3"))

OUTPUT_JSON = Path(f"GreenMile_Descubrimiento_Campos_{TARGET_DATE}.json")
OUTPUT_TXT = Path(f"GreenMile_Descubrimiento_Campos_{TARGET_DATE}.txt")

LIGHT_FIELDS = ["id", "organization.key", "date", "key", "status"]
KNOWN_DETAIL_FIELDS = [
    "id", "organization.key", "date", "key", "status",
    "stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number",
]
REJECTED = {"REJECTED", "UNDELIVERED", "NOT_DELIVERED", "CANCELED", "CANCELLED", "FAILED"}

# Campos escalares probados uno por uno. Son hipótesis de nombres, no campos confirmados.
DIRECT_STOP_NAMES = [
    "reason", "reasonCode", "reasonDescription", "reasonText", "reasonKey",
    "motive", "motivo", "motivoNoEntrega", "motivoCancelacion",
    "cancelReason", "cancelReasonCode", "cancelReasonDescription",
    "cancellationReason", "cancellationReasonCode", "cancellationReasonDescription",
    "undeliveryReason", "undeliveryReasonCode", "undeliveryReasonDescription",
    "undeliveredReason", "undeliveredReasonCode", "undeliveredReasonDescription",
    "nonDeliveryReason", "nonDeliveryReasonCode", "nonDeliveryReasonDescription",
    "rejectionReason", "rejectionReasonCode", "rejectionReasonDescription",
    "refusalReason", "refusalReasonCode", "refusalReasonDescription",
    "failureReason", "failureReasonCode", "failureReasonDescription",
    "returnReason", "returnReasonCode", "returnReasonDescription",
    "exceptionReason", "exceptionReasonCode", "exceptionReasonDescription",
    "incidentReason", "incidentReasonCode", "incidentReasonDescription",
    "occurrenceReason", "occurrenceReasonCode", "occurrenceReasonDescription",
    "comment", "comments", "note", "notes", "remark", "remarks",
    "observation", "observations", "description", "message", "detail", "details",
    "statusReason", "statusDescription", "deliveryStatusReason", "deliveryStatusDescription",
    "cancelType", "undeliveryType", "rejectionType", "failureType",
]
DIRECT_ORDER_NAMES = DIRECT_STOP_NAMES + [
    "deliveryReason", "deliveryReasonCode", "deliveryReasonDescription",
    "orderStatusReason", "orderStatusDescription",
]

RELATION_NAMES = [
    "reason", "cancelReason", "cancellationReason", "undeliveryReason",
    "undeliveredReason", "nonDeliveryReason", "rejectionReason", "refusalReason",
    "failureReason", "returnReason", "exception", "exceptions", "occurrence",
    "occurrences", "incident", "incidents", "event", "events", "deliveryFailure",
    "deliveryFailures", "statusHistory", "history", "result", "resolution",
]
RELATION_LEAVES = ["id", "key", "code", "name", "description", "label", "value", "type", "message", "text"]

PROBES: list[tuple[str, list[str]]] = [
    ("wildcard_route", ["*"]),
    ("wildcard_stop", ["stops.*"]),
    ("wildcard_order", ["stops.orders.*"]),
    ("wildcard_stop_order", ["stops.*", "stops.orders.*"]),
]
PROBES += [(f"stop_scalar:{name}", [f"stops.{name}"]) for name in DIRECT_STOP_NAMES]
PROBES += [(f"order_scalar:{name}", [f"stops.orders.{name}"]) for name in DIRECT_ORDER_NAMES]
for relation in RELATION_NAMES:
    for leaf in RELATION_LEAVES:
        PROBES.append((f"stop_relation:{relation}.{leaf}", [f"stops.{relation}.{leaf}"]))
        PROBES.append((f"order_relation:{relation}.{leaf}", [f"stops.orders.{relation}.{leaf}"]))


def text(value: Any) -> str:
    if value is None: return ""
    if isinstance(value, bool): return "TRUE" if value else "FALSE"
    return str(value).strip()


def status(value: Any) -> str:
    return text(value).upper()


def secret(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value: raise RuntimeError(f"Falta el secret {name}")
    return value


def basic_auth() -> str:
    raw = f"{secret('GREENMILE_USERNAME')}:{secret('GREENMILE_PASSWORD')}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def parse_http_error(error: urllib.error.HTTPError) -> dict[str, Any]:
    body = error.read().decode("utf-8", errors="replace")
    result: dict[str, Any] = {"httpStatus": error.code, "body": body[:1500]}
    try:
        payload = json.loads(body)
        messages = payload.get("errorMessages") or []
        if messages:
            params = ((messages[0].get("resource") or {}).get("parameters") or {})
            result.update({
                "errorClass": params.get("errorClass", ""),
                "traceId": params.get("traceId", ""),
                "serverVersion": params.get("Server-Version", ""),
            })
    except Exception:
        pass
    return result


def request_page(fields: list[str], first: int, size: int, auth: str, retries: bool = True) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    criteria = {"filters": fields, "firstResult": first, "maxResults": size}
    encoded = urllib.parse.quote(json.dumps(criteria, separators=(",", ":")), safe="")
    attempts = HTTP_RETRIES if retries else 1
    last_meta: dict[str, Any] = {}
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            f"{GREENMILE_URL}?criteria={encoded}", data=b"{}", method="POST",
            headers={"Authorization": auth, "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read().decode("utf-8")
                data = json.loads(raw)
                if not isinstance(data, list): raise RuntimeError("Respuesta no matricial")
                return data, {"httpStatus": response.status}
        except urllib.error.HTTPError as error:
            last_meta = parse_http_error(error)
            if error.code not in {429, 500, 502, 503, 504} or not retries:
                return [], last_meta
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            last_meta = {"httpStatus": 0, "error": str(error)}
            if not retries: return [], last_meta
        if attempt < attempts: time.sleep(attempt * 2)
    return [], last_meta


def flatten(value: Any, path: str = "") -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    if isinstance(value, dict):
        if not value: output.append((path, "{}"))
        for key, child in value.items():
            output.extend(flatten(child, f"{path}.{key}" if path else key))
    elif isinstance(value, list):
        if not value: output.append((path, "[]"))
        for child in value: output.extend(flatten(child, f"{path}[]"))
    else:
        sample = text(value)
        output.append((path, sample[:300] + ("…" if len(sample) > 300 else "")))
    return output


def leaf_inventory(routes: list[dict[str, Any]]) -> dict[str, Any]:
    counts = Counter(); samples: dict[str, list[str]] = {}
    for path, sample in flatten(routes):
        counts[path] += 1
        if sample not in {"", "[]", "{}"}:
            bucket = samples.setdefault(path, [])
            if sample not in bucket and len(bucket) < 3: bucket.append(sample)
    return {path: {"occurrences": counts[path], "samples": samples.get(path, [])} for path in sorted(counts)}


def find_sample_indices(auth: str) -> tuple[list[dict[str, Any]], int]:
    first = 0; pages = 0; reviewed = 0; previous: Optional[frozenset[str]] = None
    samples: list[dict[str, Any]] = []; seen_statuses: set[str] = set()
    while pages < MAX_PAGES and len(samples) < MAX_SAMPLE_ROUTES:
        light, meta = request_page(LIGHT_FIELDS, first, SCAN_PAGE_SIZE, auth)
        if meta.get("httpStatus") != 200: raise RuntimeError(f"Fallo escaneo: {meta}")
        pages += 1
        if not light: break
        ids = frozenset(text(route.get("id")) for route in light if text(route.get("id")))
        if ids and ids == previous: raise RuntimeError(f"Página repetida firstResult={first}")
        previous = ids; reviewed += len(light)
        if any(text(route.get("date")) == TARGET_DATE for route in light):
            for offset in range(0, len(light), DETAIL_PAGE_SIZE):
                size = min(DETAIL_PAGE_SIZE, len(light) - offset)
                detail, detail_meta = request_page(
                    ["id", "organization.key", "date", "key", "stops.id", "stops.deliveryStatus", "stops.orders.number"],
                    first + offset, size, auth,
                )
                if detail_meta.get("httpStatus") != 200: continue
                for position, route in enumerate(detail):
                    if text(route.get("date")) != TARGET_DATE: continue
                    statuses = {status(stop.get("deliveryStatus")) for stop in route.get("stops") or [] if isinstance(stop, dict)} & REJECTED
                    if not statuses: continue
                    novel = statuses - seen_statuses
                    if novel or len(samples) < MAX_SAMPLE_ROUTES:
                        samples.append({
                            "absoluteIndex": first + offset + position,
                            "routeId": text(route.get("id")),
                            "routeKey": text(route.get("key")),
                            "statuses": sorted(statuses),
                        })
                        seen_statuses |= statuses
                    if len(samples) >= MAX_SAMPLE_ROUTES: break
                if len(samples) >= MAX_SAMPLE_ROUTES: break
        print(f"Escaneo {pages}: first={first}, revisadas={reviewed}, muestras={len(samples)}")
        first += len(light)
    if not samples: raise RuntimeError(f"No se encontraron rutas con rechazo/cancelación para {TARGET_DATE}")
    return samples, reviewed


def main() -> None:
    auth = basic_auth()
    samples, reviewed = find_sample_indices(auth)
    print("Rutas muestra:", json.dumps(samples, ensure_ascii=False))

    # Base por muestra para comparar exactamente qué añadió cada campo.
    baseline: dict[int, dict[str, Any]] = {}
    for sample in samples:
        data, meta = request_page(KNOWN_DETAIL_FIELDS, sample["absoluteIndex"], 1, auth)
        baseline[sample["absoluteIndex"]] = {
            "meta": meta,
            "paths": leaf_inventory(data) if meta.get("httpStatus") == 200 else {},
        }

    results = []
    accepted = []; rejected = []
    for sequence, (name, extra_fields) in enumerate(PROBES, start=1):
        probe_result = {"probe": name, "extraFields": extra_fields, "samples": []}
        accepted_at_least_once = False
        for sample in samples:
            fields = extra_fields if name.startswith("wildcard_") else KNOWN_DETAIL_FIELDS + extra_fields
            data, meta = request_page(fields, sample["absoluteIndex"], 1, auth, retries=False)
            entry: dict[str, Any] = {"route": sample, **meta}
            if meta.get("httpStatus") == 200:
                accepted_at_least_once = True
                inventory = leaf_inventory(data)
                base_paths = baseline[sample["absoluteIndex"]]["paths"]
                added = {path: value for path, value in inventory.items() if path not in base_paths}
                entry["addedPaths"] = added
                entry["allReturnedPaths"] = inventory if name.startswith("wildcard_") else {}
            probe_result["samples"].append(entry)
            time.sleep(PROBE_PAUSE_SECONDS)
        if accepted_at_least_once:
            accepted.append(name)
        else:
            rejected.append(name)
        results.append(probe_result)
        if sequence % 50 == 0: print(f"Probes ejecutados: {sequence}/{len(PROBES)}")

    output = {
        "targetDate": TARGET_DATE,
        "routesReviewed": reviewed,
        "sampleRoutes": samples,
        "probeCount": len(PROBES),
        "acceptedProbeCount": len(accepted),
        "rejectedProbeCount": len(rejected),
        "acceptedProbes": accepted,
        "rejectedProbes": rejected,
        "baseline": baseline,
        "results": results,
    }
    OUTPUT_JSON.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "DESCUBRIMIENTO EXHAUSTIVO DE CAMPOS GREENMILE",
        f"Fecha: {TARGET_DATE}",
        f"Rutas revisadas: {reviewed}",
        f"Rutas muestra: {len(samples)}",
        f"Probes ejecutados: {len(PROBES)}",
        f"Probes aceptados: {len(accepted)}",
        f"Probes rechazados: {len(rejected)}",
        "",
        "PROBES ACEPTADOS:",
    ]
    lines += [f"- {name}" for name in accepted] or ["- Ninguno"]
    lines += ["", "CAMPOS NUEVOS DEVUELTOS:"]
    any_added = False
    for result in results:
        for sample in result["samples"]:
            for path, info in sample.get("addedPaths", {}).items():
                any_added = True
                lines.append(f"- {result['probe']} -> {path} | muestras={info['samples']}")
    if not any_added: lines.append("- Ningún probe añadió paths frente a la consulta base")
    lines += ["", "ERRORES (resumen):"]
    error_counts = Counter()
    for result in results:
        for sample in result["samples"]:
            if sample.get("httpStatus") != 200:
                key = f"HTTP {sample.get('httpStatus')} {sample.get('errorClass','')}"
                error_counts[key] += 1
    lines += [f"- {key}: {count}" for key, count in error_counts.most_common()] or ["- Ninguno"]
    OUTPUT_TXT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Generado: {OUTPUT_JSON}")
    print(f"Generado: {OUTPUT_TXT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise
