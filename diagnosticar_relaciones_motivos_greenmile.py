#!/usr/bin/env python3
"""Segundo diagnóstico: descubre relaciones/campos secundarios de motivos GreenMile."""
import base64, json, os, sys, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Optional

GREENMILE_URL = "https://sigmaperu.greenmile.com/Route/restrictions"
TARGET_DATE = os.getenv("GREENMILE_TARGET_DATE", "2026-09-23").strip()
SCAN_PAGE_SIZE = int(os.getenv("GREENMILE_SCAN_PAGE_SIZE", "100"))
DETAIL_PAGE_SIZE = int(os.getenv("GREENMILE_DETAIL_PAGE_SIZE", "5"))
MAX_PAGES = int(os.getenv("GREENMILE_MAX_PAGES", "2000"))
HTTP_RETRIES = int(os.getenv("GREENMILE_HTTP_RETRIES", "3"))
MAX_REJECTED_STOPS = int(os.getenv("GREENMILE_MAX_REJECTED_STOPS", "100"))
OUTPUT_JSON = Path(f"GreenMile_Diagnostico_Relaciones_Motivos_{TARGET_DATE}.json")
OUTPUT_TXT = Path(f"GreenMile_Diagnostico_Relaciones_Motivos_{TARGET_DATE}.txt")

LIGHT_FIELDS = ["id", "organization.key", "date", "key", "status"]
# Variantes deliberadas: el API puede ignorar campos inexistentes o devolverlos si están autorizados.
PROBE_GROUPS = {
    "exceptions": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.exceptions.*"],
    "occurrences": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.occurrences.*"],
    "events": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.events.*"],
    "deliveryFailures": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.deliveryFailures.*"],
    "statusHistory": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.statusHistory.*"],
    "cancelReason": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.cancelReason.*", "stops.cancellationReason.*"],
    "undeliveryReason": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.number", "stops.undeliveryReason.*", "stops.undeliveredReason.*"],
    "orderRelations": ["stops.id", "stops.key", "stops.deliveryStatus", "stops.orders.*", "stops.orders.exceptions.*", "stops.orders.occurrences.*", "stops.orders.events.*", "stops.orders.cancelReason.*", "stops.orders.undeliveryReason.*"],
}
REJECTED = {"REJECTED", "UNDELIVERED", "NOT_DELIVERED", "CANCELED", "CANCELLED", "FAILED"}
TECHNICAL = {"id", "key", "number", "deliverystatus", "status"}

def text(v: Any) -> str:
    if v is None: return ""
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    return str(v).strip()

def status(v: Any) -> str: return text(v).upper()

def norm(v: Any) -> str:
    s=unicodedata.normalize("NFKD",text(v)); s="".join(c for c in s if not unicodedata.combining(c))
    return "".join(c.lower() for c in s if c.isalnum())

def secret(name: str) -> str:
    value=os.getenv(name,"").strip()
    if not value: raise RuntimeError(f"Falta el secret {name}")
    return value

def auth_header() -> str:
    raw=f"{secret('GREENMILE_USERNAME')}:{secret('GREENMILE_PASSWORD')}".encode()
    return "Basic "+base64.b64encode(raw).decode("ascii")

def request_page(fields: list[str], first: int, size: int, auth: str) -> list[dict[str,Any]]:
    criteria={"filters":fields,"firstResult":first,"maxResults":size}
    encoded=urllib.parse.quote(json.dumps(criteria,separators=(",",":")),safe="")
    latest: Optional[Exception]=None
    for attempt in range(1,HTTP_RETRIES+1):
        req=urllib.request.Request(f"{GREENMILE_URL}?criteria={encoded}",data=b"{}",method="POST",
            headers={"Authorization":auth,"Content-Type":"application/json","Accept":"application/json"})
        try:
            with urllib.request.urlopen(req,timeout=120) as response:
                data=json.loads(response.read().decode("utf-8"))
            if not isinstance(data,list): raise RuntimeError("Respuesta no matricial")
            return data
        except urllib.error.HTTPError as e:
            body=e.read().decode("utf-8",errors="replace")
            latest=RuntimeError(f"HTTP {e.code}; first={first}; fields={fields[-3:]}; {body[:500]}")
            if e.code not in {429,500,502,503,504}: raise latest from e
        except (urllib.error.URLError,json.JSONDecodeError) as e:
            latest=RuntimeError(str(e))
        if attempt<HTTP_RETRIES: time.sleep(attempt*2)
    raise latest or RuntimeError("Error API")

def flatten(value: Any,path: str="") -> list[tuple[str,str]]:
    out=[]
    if isinstance(value,dict):
        for k,v in value.items(): out.extend(flatten(v,f"{path}.{k}" if path else k))
    elif isinstance(value,list):
        for v in value: out.extend(flatten(v,f"{path}[]"))
    else: out.append((path,text(value)))
    return out

def interesting_path(path: str) -> bool:
    parts=[norm(p.replace("[]","")) for p in path.split(".")]
    return any(p and p not in TECHNICAL for p in parts[2:])

def rejected_stops(routes: list[dict[str,Any]]) -> list[dict[str,Any]]:
    rows=[]
    for route in routes:
        if text(route.get("date"))!=TARGET_DATE: continue
        org=route.get("organization") or {}
        for stop in route.get("stops") or []:
            if not isinstance(stop,dict) or status(stop.get("deliveryStatus")) not in REJECTED: continue
            rows.append({"routeKey":text(route.get("key")),"location":text(org.get("key")),"stop":stop})
    return rows

def main() -> None:
    auth=auth_header(); first=0; pages=0; reviewed=0; target_offsets=[]; previous=None
    while pages<MAX_PAGES:
        light=request_page(LIGHT_FIELDS,first,SCAN_PAGE_SIZE,auth); pages+=1
        if not light: break
        ids=frozenset(text(x.get("id")) for x in light if text(x.get("id")))
        if ids and ids==previous: raise RuntimeError(f"Página repetida firstResult={first}")
        previous=ids; reviewed+=len(light)
        if any(text(x.get("date"))==TARGET_DATE for x in light):
            target_offsets.extend((first+o,min(DETAIL_PAGE_SIZE,len(light)-o)) for o in range(0,len(light),DETAIL_PAGE_SIZE))
        print(f"Escaneo {pages}: first={first}, rutas={len(light)}, bloques_objetivo={len(target_offsets)}")
        first+=len(light)
    results={}; global_samples=[]
    for group,fields in PROBE_GROUPS.items():
        print(f"Probando grupo: {group}")
        path_counts=Counter(); samples={}; stopped=0; errors=[]
        for detail_first,size in target_offsets:
            try: routes=request_page(["id","organization.key","date","key"]+fields,detail_first,size,auth)
            except Exception as e:
                errors.append(str(e)); break
            for row in rejected_stops(routes):
                stopped+=1; stop=row["stop"]
                for path,value in flatten(stop,"stop"):
                    if not interesting_path(path): continue
                    path_counts[path]+=1
                    if value and path not in samples: samples[path]=value[:300]
                if stopped>=MAX_REJECTED_STOPS: break
            if stopped>=MAX_REJECTED_STOPS: break
        new_paths=[{"path":p,"occurrences":n,"sample":samples.get(p,"")} for p,n in path_counts.most_common()]
        results[group]={"fieldsRequested":fields,"rejectedStopsInspected":stopped,"errors":errors,"pathsReturned":new_paths}
        for item in new_paths:
            global_samples.append({"group":group,**item})
    output={"targetDate":TARGET_DATE,"routesReviewed":reviewed,"targetBlocks":len(target_offsets),"groups":results}
    OUTPUT_JSON.write_text(json.dumps(output,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    lines=["SEGUNDO DIAGNÓSTICO GREENMILE - RELACIONES DE MOTIVOS",f"Fecha: {TARGET_DATE}",f"Rutas revisadas: {reviewed}",""]
    for group,data in results.items():
        lines += [f"[{group}]",f"Paradas inspeccionadas: {data['rejectedStopsInspected']}"]
        if data["errors"]: lines.append("Error: "+data["errors"][0])
        if data["pathsReturned"]:
            for x in data["pathsReturned"][:30]: lines.append(f"- {x['path']} | {x['occurrences']} | {x['sample']}")
        else: lines.append("- Sin paths adicionales devueltos")
        lines.append("")
    OUTPUT_TXT.write_text("\n".join(lines),encoding="utf-8")
    print(f"Generado {OUTPUT_JSON}"); print(f"Generado {OUTPUT_TXT}")

if __name__=="__main__":
    try: main()
    except Exception as e: print(f"ERROR: {e}",file=sys.stderr); raise
