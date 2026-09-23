import csv
import json
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any


SOURCE_FILE = Path("RoadMap.csv")
OUTPUT_FILE = Path("RoadMap_Shipment.json")


COLUMN_MAPPING = {
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


NULL_VALUES = {
    "",
    "none",
    "null",
    "#n/a",
    "#n/d",
    "#na",
    "nan",
}


# Los registros asociados a estos Vehicle Key
# no se incluirán en RoadMap_Shipment.json.
EXCLUDED_VEHICLES = {
    "FRT-001",
    "RES-CLI",
}


def clean_text(value: Any) -> str:
    if value is None:
        return ""

    result = str(value).strip()

    if result.lower() in NULL_VALUES:
        return ""

    return result


def normalize_header(value: Any) -> str:
    return (
        clean_text(value)
        .replace("\ufeff", "")
        .replace("\r", "")
        .replace("\n", "")
        .strip()
    )


def normalize_vehicle_key(value: Any) -> str:
    return clean_text(value).upper()


def parse_decimal(
    value: Any,
    field_name: str,
) -> Decimal:
    cleaned = clean_text(value)

    if cleaned == "":
        return Decimal("0")

    cleaned = cleaned.replace(" ", "")

    # Formato habitual del raw: 1234.56
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        pass

    # Formato alternativo: 1234,56
    try:
        return Decimal(cleaned.replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(
            f"Valor numérico inválido en {field_name}: "
            f"{value!r}"
        ) from exc


def parse_coordinate(
    value: Any,
    field_name: str,
):
    cleaned = clean_text(value)

    if cleaned == "":
        return None

    cleaned = cleaned.replace(" ", "")

    try:
        return float(cleaned)
    except ValueError:
        pass

    try:
        return float(cleaned.replace(",", "."))
    except ValueError as exc:
        raise ValueError(
            f"Coordenada inválida en {field_name}: "
            f"{value!r}"
        ) from exc


def normalize_date(value: Any) -> str:
    cleaned = clean_text(value)

    if cleaned == "":
        return ""

    # El raw utiliza principalmente día/mes/año.
    # También se aceptan formatos alternativos
    # para evitar fallos futuros.
    accepted_formats = [
        "%d/%m/%Y",
        "%d/%m/%y",
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m/%d/%y",
    ]

    for date_format in accepted_formats:
        try:
            parsed_date = datetime.strptime(
                cleaned,
                date_format,
            ).date()

            return parsed_date.isoformat()
        except ValueError:
            continue

    raise ValueError(
        f"Delivery Date inválida: {value!r}"
    )


def validate_headers(fieldnames):
    actual_headers = {
        normalize_header(header)
        for header in (fieldnames or [])
    }

    required_headers = set(COLUMN_MAPPING.keys())
    required_headers.add("Weight")

    missing_headers = sorted(
        required_headers - actual_headers
    )

    if missing_headers:
        raise ValueError(
            "Faltan columnas obligatorias en RoadMap.csv: "
            + ", ".join(missing_headers)
        )


def normalize_row_keys(row):
    return {
        normalize_header(key): value
        for key, value in row.items()
        if key is not None
    }


def build_base_record(row):
    record = {}

    for source_column, output_column in COLUMN_MAPPING.items():
        record[output_column] = clean_text(
            row.get(source_column)
        )

    record["DeliveryDate"] = normalize_date(
        row.get("Delivery Date")
    )

    record["Latitude"] = parse_coordinate(
        row.get("Latitude"),
        "Latitude",
    )

    record["Longitude"] = parse_coordinate(
        row.get("Longitude"),
        "Longitude",
    )

    # Los identificadores se conservan como texto.
    record["VehicleKey"] = clean_text(
        row.get("Vehicle Key")
    )

    record["CustomerAccount"] = clean_text(
        row.get("Customer Account #")
    )

    record["ShipmentCustom"] = clean_text(
        row.get("Shipment Custom")
    )

    record["DriverBadge"] = clean_text(
        row.get("Driver Badge #")
    )

    record["KgPlanificados"] = Decimal("0")

    return record


def values_are_empty(value):
    return value is None or value == ""


def validate_and_merge_attributes(
    stored_record,
    new_record,
    row_number,
):
    ignored_fields = {
        "KgPlanificados",
    }

    for field_name, new_value in new_record.items():
        if field_name in ignored_fields:
            continue

        stored_value = stored_record.get(field_name)

        # Si la nueva línea SKU no tiene información,
        # mantenemos el valor ya obtenido.
        if values_are_empty(new_value):
            continue

        # Si el registro almacenado estaba vacío,
        # completamos con el nuevo valor.
        if values_are_empty(stored_value):
            stored_record[field_name] = new_value
            continue

        if stored_value != new_value:
            shipment = stored_record.get(
                "ShipmentCustom",
                "",
            )

            raise ValueError(
                f"El Shipment {shipment} presenta valores "
                f"distintos en la columna {field_name}. "
                f"Fila del CSV: {row_number}. "
                f"Valor inicial: {stored_value!r}. "
                f"Valor encontrado: {new_value!r}."
            )


def create_json_record(record):
    output_record = dict(record)

    rounded_weight = record[
        "KgPlanificados"
    ].quantize(
        Decimal("0.001"),
        rounding=ROUND_HALF_UP,
    )

    output_record["KgPlanificados"] = float(
        rounded_weight
    )

    return output_record


def main():
    if not SOURCE_FILE.exists():
        raise FileNotFoundError(
            f"No existe el archivo {SOURCE_FILE} "
            "en la raíz del repositorio."
        )

    shipments = {}

    source_row_count = 0
    skipped_without_shipment = 0
    skipped_excluded_vehicle = 0

    with SOURCE_FILE.open(
        mode="r",
        encoding="utf-8-sig",
        newline="",
    ) as csv_file:
        reader = csv.DictReader(csv_file)

        validate_headers(reader.fieldnames)

        for row_number, original_row in enumerate(
            reader,
            start=2,
        ):
            source_row_count += 1

            row = normalize_row_keys(original_row)

            vehicle_key = normalize_vehicle_key(
                row.get("Vehicle Key")
            )

            # Excluir completamente estos vehículos.
            # Las filas excluidas no generan shipments
            # ni participan en la suma de KgPlanificados.
            if vehicle_key in EXCLUDED_VEHICLES:
                skipped_excluded_vehicle += 1
                continue

            shipment = clean_text(
                row.get("Shipment Custom")
            )

            if shipment == "":
                skipped_without_shipment += 1
                continue

            current_record = build_base_record(row)

            current_weight = parse_decimal(
                row.get("Weight"),
                "Weight",
            )

            if shipment not in shipments:
                shipments[shipment] = current_record
            else:
                validate_and_merge_attributes(
                    shipments[shipment],
                    current_record,
                    row_number,
                )

            shipments[shipment][
                "KgPlanificados"
            ] += current_weight

    output_records = [
        create_json_record(shipments[shipment])
        for shipment in sorted(shipments.keys())
    ]

    with OUTPUT_FILE.open(
        mode="w",
        encoding="utf-8",
        newline="",
    ) as json_file:
        json.dump(
            output_records,
            json_file,
            ensure_ascii=False,
            indent=2,
        )

        json_file.write("\n")

    print(
        f"Filas leídas del CSV: "
        f"{source_row_count}"
    )

    print(
        f"Filas omitidas sin Shipment Custom: "
        f"{skipped_without_shipment}"
    )

    print(
        f"Filas excluidas por Vehicle Key "
        f"(FRT-001 / RES-CLI): "
        f"{skipped_excluded_vehicle}"
    )

    print(
        f"Shipments únicos generados: "
        f"{len(output_records)}"
    )

    print(
        f"Archivo generado correctamente: "
        f"{OUTPUT_FILE}"
    )


if __name__ == "__main__":
    main()
