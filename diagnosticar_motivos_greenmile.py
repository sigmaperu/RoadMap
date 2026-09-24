#!/usr/bin/env python3
"""Diagnostica campos de motivo de rechazo/cancelación en GreenMile."""
import base64, json, os, sys, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Optional

ROADMAP_FILE = Path("RoadMap_Shipment.json")
GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"
TARGET_DATE = os.getenv("GREENMILE_TARGET_DATE", "2026-09-23").strip()
SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
MAX_SAMPLES = int(os.getenv("GREENMILE_MAX_SAMPLES_PER_PATH", "5"))
ONLY_PROGRAMMED = os.getenv("GREENMILE_ONLY_PROGRAMMED", "true").lower() in {"1","true","yes"}
OUTPUT_JSON = Path(f"GreenMile_Diagnostico_Motivos_{TARGET_DATE}.json")
OUTPUT_TXT = Path(f"GreenMile_Diagnostico_Motivos_{TARGET_DATE}.txt")

LIGHT_FIELDS = ["id", "organization.key", "date", "key", "status"]
DETAIL_FIELDS = [
    "id", "organization.*", "date", "key", "status",
    "canceledStops", "undeliveredStops", "redeliveredStops",
    "stops.*", "stops.orders.*",
]
REJECTED = {"REJECTED","UNDELIVERED","NOT_DELIVERED","CANCELED","CANCELLED","FAILED"}
REASON_TOKENS = (
    "reason","razon","motivo","undeliver","notdeliver","noentreg","reject",
    "rechaz","failure","failed","refusal","refused","exception","occurrence",
    "incident","returnreason","cancelreason","cancellationreason","cancel",
    "deliveryfailure","nondelivery"
)
TECHNICAL_TOKENS = (
    "latitude","longitude","accuracy","distance","provider","gps","quality",
    "conformity","timestamp","datetime"
)

def text(value: Any) -> str:
    if value is None: return ""
    if isinstance(value, bool): return "TRUE" if value else "FALSE"
    return str(value).strip()

def status(value: Any) -> str:
    return text(value).upper()

def norm(value: Any) -> str:
    value = unicodedata.normalize("NFKD", text(value))
    value = "".join(c for c in value if not unicodedata.combining(c))
    return "".join(c.lower() for c in value if c.isalnum())

def required_secret(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value: raise RuntimeError(f"No se configuró el secreto: {name}")
    return value

def auth_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return f"Basic {token}"

def request_page(fields: list[str], first: int, size: int, auth: str) -> list[dict[str, Any]]:
    criteria = {"filters": fields, "firstResult": first, "maxResults": size}
    encoded = urllib.parse.quote(json.dumps(criteria, separators=(",",":")), safe="")
    last_error: Optional[Exception] = None
    for attempt in range(1, HTTP_RETRIES + 1):
        req = urllib.request.Request(
            f"{GREENMILE_URL}?criteria={encoded}", data=b"{}", method="POST",
            headers={"Authorization":auth,"Content-Type":"application/json","Accept":"application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, list): raise RuntimeError("La respuesta no es una matriz JSON")
            return result
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"HTTP {error.code}; first={first}; size={size}; {body[:500]}")
            if error.code not in {429,500,502,503,504}: raise last_error from error
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = RuntimeError(f"Error consultando GreenMile: {error}")
        if attempt < HTTP_RETRIES: time.sleep(attempt * 2)
    raise last_error or RuntimeError("Error no identificado")

def programmed_shipments() -> set[str]:
    if not ONLY_PROGRAMMED or not ROADMAP_FILE.exists(): return set()
    records = json.loads(ROADMAP_FILE.read_text(encoding="utf-8"))
    if not isinstance(records, list): raise ValueError("RoadMap_Shipment.json no es una matriz")
    return {
        text(r.get("ShipmentCustom")) for r in records if isinstance(r, dict)
        and text(r.get("DeliveryDate")) == TARGET_DATE and text(r.get("ShipmentCustom"))
    }

def leaf_paths(value: Any, path: str="") -> list[tuple[str,str,str]]:
    result=[]
    if isinstance(value, dict):
        if not value: result.append((path,"object","{}"))
        for key, child in value.items():
            result.extend(leaf_paths(child, f"{path}.{key}" if path else key))
    elif isinstance(value, list):
        if not value: result.append((path,"array","[]"))
        for child in value: result.extend(leaf_paths(child, f"{path}[]"))
    else:
        kind = "null" if value is None else type(value).__name__
        sample = text(value)
        result.append((path,kind,sample[:240] + ("…" if len(sample)>240 else "")))
    return result

def reason_like(path: str) -> bool:
    key=norm(path)
    return any(t in key for t in REASON_TOKENS) and not any(t in key for t in TECHNICAL_TOKENS)

def add_inventory(inventory: dict[str,dict[str,Any]], value: Any, root: str) -> None:
    for path, kind, sample in leaf_paths(value, root):
        item=inventory.setdefault(path,{"types":Counter(),"occurrences":0,"nonEmpty":0,"samples":[]})
        item["types"][kind]+=1; item["occurrences"]+=1
        if sample not in {"","null","[]","{}"}:
            item["nonEmpty"]+=1
            if sample not in item["samples"] and len(item["samples"])<MAX_SAMPLES:
                item["samples"].append(sample)

def serialise(inventory: dict[str,dict[str,Any]]) -> list[dict[str,Any]]:
    return [{"path":p,"types":dict(v["types"]),"occurrences":v["occurrences"],
             "nonEmpty":v["nonEmpty"],"samples":v["samples"],"looksLikeReason":reason_like(p)}
            for p,v in sorted(inventory.items())]

def process(routes, programmed, inventory, statuses, items) -> int:
    matched=0
    for route in routes:
        if text(route.get("date")) != TARGET_DATE: continue
        matched+=1
        org=route.get("organization") or {}
        for si, stop in enumerate(route.get("stops") or []):
            if not isinstance(stop,dict): continue
            stop_status=status(stop.get("deliveryStatus"))
            orders=stop.get("orders") or []
            if not isinstance(orders,list): orders=[]
            for oi, order in enumerate(orders):
                if not isinstance(order,dict): continue
                shipment=text(order.get("number"))
                if programmed and shipment not in programmed: continue
                effective=status(order.get("deliveryStatus") or order.get("status") or stop_status)
                if effective not in REJECTED: continue
                statuses[effective]+=1
                add_inventory(inventory,stop,"stop"); add_inventory(inventory,order,"order")
                candidates=[]
                for root,obj in (("stop",stop),("order",order)):
                    for path,kind,sample in leaf_paths(obj,root):
                        if reason_like(path): candidates.append({"path":path,"type":kind,"value":sample})
                items.append({"date":TARGET_DATE,"routeKey":text(route.get("key")),
                    "location":text(org.get("key")),"shipmentCustom":shipment,
                    "stopIndex":si,"orderIndex":oi,"deliveryStatus":effective,
                    "reasonCandidates":candidates})
    return matched

def main() -> None:
    auth=auth_header(required_secret("GREENMILE_USERNAME"),required_secret("GREENMILE_PASSWORD"))
    programmed=programmed_shipments()
    print(f"Fecha objetivo: {TARGET_DATE}")
    print(f"Shipments programados filtrados: {len(programmed)}" if programmed else "Sin filtro de shipments programados")
    inventory={}; statuses=Counter(); items=[]
    first=0; pages=0; reviewed=0; matched=0; previous=None
    while pages < MAX_PAGES:
        light=request_page(LIGHT_FIELDS,first,SCAN_PAGE_SIZE,auth); pages+=1
        if not light: break
        ids=frozenset(text(r.get("id")) for r in light if text(r.get("id")))
        if ids and ids==previous: raise RuntimeError(f"Página repetida en firstResult={first}")
        previous=ids; reviewed+=len(light)
        has_date=any(text(r.get("date"))==TARGET_DATE for r in light)
        print(f"Página {pages}: firstResult={first}, rutas={len(light)}, contiene_fecha={has_date}")
        if has_date:
            for offset in range(0,len(light),DETAIL_PAGE_SIZE):
                size=min(DETAIL_PAGE_SIZE,len(light)-offset)
                detail=request_page(DETAIL_FIELDS,first+offset,size,auth)
                matched+=process(detail,programmed,inventory,statuses,items)
        first+=len(light)
    else: raise RuntimeError(f"Se alcanzó MAX_PAGES={MAX_PAGES}")
    all_fields=serialise(inventory)
    candidates=[x for x in all_fields if x["looksLikeReason"]]
    output={"targetDate":TARGET_DATE,"onlyProgrammedShipments":bool(programmed),
        "programmedShipmentCount":len(programmed),"routesReviewed":reviewed,
        "matchingRouteObjectsFetched":matched,"rejectedOrCanceledOrderCount":len(items),
        "observedRejectedStatuses":dict(statuses),"reasonCandidatePaths":candidates,
        "allLeafPathsInRejectedObjects":all_fields,"rejectedOrCanceledItems":items}
    OUTPUT_JSON.write_text(json.dumps(output,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    lines=["DIAGNÓSTICO GREENMILE - MOTIVOS DE RECHAZO/CANCELACIÓN",
        f"Fecha objetivo: {TARGET_DATE}",f"Rutas revisadas: {reviewed}",
        f"Pedidos rechazados/cancelados: {len(items)}",f"Estados: {dict(statuses)}","",
        "PATHS CANDIDATOS A MOTIVO:"]
    if candidates:
        for x in candidates:
            lines.append(f'- {x["path"]} | apariciones={x["occurrences"]} | no_vacíos={x["nonEmpty"]} | muestras={" | ".join(x["samples"]) or "<vacío>"}')
    else: lines.append("- No se detectaron paths candidatos por nombre.")
    lines += ["","Si no hay candidatos, revisar allLeafPathsInRejectedObjects en el JSON."]
    OUTPUT_TXT.write_text("\n".join(lines)+"\n",encoding="utf-8")
    print(f"Generado: {OUTPUT_JSON}"); print(f"Generado: {OUTPUT_TXT}")

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"ERROR: {error}",file=sys.stderr); raise
