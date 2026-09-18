import csv
import json
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path


SOURCE_FILE = Path("RoadMap.csv")
OUTPUT_FILE = Path("RoadMap_Shipment.json")


SOURCE_COLUMNS = {
    "Delivery Date": "DeliveryDate",
    "Location": "Location",
    "Vehicle Key": "VehicleKey",
    "Customer Account #": "CustomerAccount",
    "Customer Name": "CustomerName",
    "Customer Name2": "CustomerName2",
    "RUTA VENTA": "RutaVenta",
    "Shipment Custom": "ShipmentCustom",
    "Driver Name": "DriverName",
    "Driver Badge #": "DriverBadge",
    "City": "City",
    "Address": "Address",
    "Latitude": "Latitude",
    "Longitude": "Longitude",
    "Time Window": "TimeWindow",
    "CANAL": "Canal",
}


EMPTY_VALUES = {
    "",
    "none",
    "null",
    "#n/a",
    "#n/d",
    "#na",
}


def clean_text(value):
    if value is None:
        return ""

    clean_value = value.strip()

    if clean_value.lower() in EMPTY_VALUES:
        return ""

    return clean_value


def parse_decimal(value):
    clean_value = clean_text(value).replace(" ", "")

    if clean_value == "":
        return Decimal("0")

    try:
        return Decimal(clean_value)
    except InvalidOperation:
        try:
            return Decimal(clean_value.replace(",", "."))
        except InvalidOperation as exc:
            raise ValueError(
                f"Weight inválido: {value!r}"
            ) from exc


def parse_coordinate(value):
    clean_value = clean_text(value).replace(" ", "")

    if clean_value == "":
        return None

    try:
        return float(clean_value)
    except ValueError:
        try:
            return float(clean_value.replace(",", "."))
        except ValueError as exc:
            raise ValueError(
                f"Coordenada inválida: {value!r}"
            ) from exc


def normalize_date(value):
    clean_value = clean_text(value)

    if clean_value == "":
        return ""

accepted_formats = [
    "%d/%m/%Y",
    "%d/%m/%y",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%Y-%m-%d",
]


    for date_format in accepted_formats:
        try:
            return datetime.strptime(
                clean_value,
                date_format
            ).date().isoformat()
        except ValueError:
            continue

    raise ValueError(
        f"Delivery Date inválida: {value!r}"
    )


def validate_headers(fieldnames):
    existing_headers = set(fieldnames or [])

    required_headers = set(SOURCE_COLUMNS.keys()) | {"Weight"}

    missing_headers = sorted(
        required_headers - existing_headers
    )

    if missing_headers:
        raise ValueError(
            "Faltan columnas obligatorias: "
            + ", ".join(missing_headers)
        )


def build_base_record(row):
    record = {}

    for source_name, output_name in SOURCE_COLUMNS.items():
        record[output_name] = clean_text(
            row.get(source_name)
        )

    record["DeliveryDate"] = normalize_date(
        row.get("Delivery Date")
    )

    record["Latitude"] = parse_coordinate(
        row.get("Latitude")
    )

    record["Longitude"] = parse_coordinate(
        row.get("Longitude")
    )

    # Shipment, cuentas y credenciales se conservan como texto.
    record["ShipmentCustom"] = clean_text(
        row.get("Shipment Custom")
    )

    record["CustomerAccount"] = clean_text(
        row.get("Customer Account #")
    )

    record["DriverBadge"] = clean_text(
        row.get("Driver Badge #")
    )

    record["KgPlanificados"] = Decimal("0")

    return record


def validate_same_shipment(existing, current, row_number):
    ignored_fields = {
        "KgPlanificados",
    }

    for field_name in existing:
        if field_name in ignored_fields:
            continue

        existing_value = existing[field_name]
        current_value = current[field_name]

        # Un vacío no reemplaza una información ya disponible.
        if current_value in ("", None):
            continue

        if existing_value in ("", None):
            existing[field_name] = current_value
            continue

        if existing_value != current_value:
            shipment = existing["ShipmentCustom"]

            raise ValueError(
                f"El Shipment {shipment} presenta valores distintos "
                f"en {field_name}. Fila del CSV: {row_number}. "
                f"Valores: {existing_value!r} y {current_value!r}"
            )


def main():
    if not SOURCE_FILE.exists():
        raise FileNotFoundError(
            f"No existe {SOURCE_FILE}"
        )

    shipments = {}

    with SOURCE_FILE.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as csv_file:

        reader = csv.DictReader(csv_file)

        validate_headers(reader.fieldnames)

        for row_number, row in enumerate(reader, start=2):
            shipment = clean_text(
                row.get("Shipment Custom")
            )

            if shipment == "":
                continue

            current_record = build_base_record(row)
            current_weight = parse_decimal(
                row.get("Weight")
            )

            if shipment not in shipments:
                shipments[shipment] = current_record
            else:
                validate_same_shipment(
                    shipments[shipment],
                    current_record,
                    row_number
                )

            shipments[shipment]["KgPlanificados"] += current_weight

    output = []

    for shipment in sorted(shipments):
        record = shipments[shipment]

        rounded_weight = record[
            "KgPlanificados"
        ].quantize(
            Decimal("0.001"),
            rounding=ROUND_HALF_UP
        )

        record["KgPlanificados"] = float(
            rounded_weight
        )

        output.append(record)

    with OUTPUT_FILE.open(
        "w",
        encoding="utf-8",
        newline=""
    ) as json_file:

        json.dump(
            output,
            json_file,
            ensure_ascii=False,
            indent=2
        )

    print(
        f"Archivo generado: {OUTPUT_FILE} "
        f"con {len(output)} shipments."
    )


if __name__ == "__main__":
    main()
