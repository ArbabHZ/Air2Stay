"""Reproduce aggregate hotel-conversion calibration without changing source files.

Run from any directory using the project's Python environment:
    .venv/bin/python src/build_conversion_evidence.py
    .venv/bin/python src/build_conversion_evidence.py --output /tmp/conversion-evidence.json

By default the project root is resolved relative to this script. Use --root to
point at another copy containing flight_data.xlsx and data international_train.xlsx.
The result is printed as JSON unless --output is supplied. Only openpyxl and the
Python standard library are needed. No workbook or application asset is rewritten.

Calibration follows src/build_model.py: train on common calendar months before
2025-01 and check on the later common months. A seasonal rate combines 70% of the
calendar-month aggregate ratio with 30% of the overall training ratio. Comparison
scores use the same capacity-consistent recorded P2P inputs at full precision.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime
import hashlib
import json
import math
from pathlib import Path

from openpyxl import load_workbook


TRAINING_CUTOFF = "2025-01"


def aggregate_source(path: Path, value_column: str, country_column: str):
    """Read the three needed fields and return monthly sums and source coverage."""
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook["Export"]
        rows = sheet.iter_rows(values_only=True)
        headers = next(rows)
        required = ["Date", value_column, country_column]
        missing = [name for name in required if name not in headers]
        if missing:
            raise ValueError(f"{path.name}: missing columns {', '.join(missing)}")
        date_index, value_index, country_index = [headers.index(name) for name in required]
        flight_indices = [headers.index(name) for name in ["Total PAX", "Total Seats"]] if value_column == "Total P2P" else None
        flight_groups = defaultdict(lambda: [0.0, 0.0, 0.0])
        monthly: dict[str, float] = defaultdict(float)
        countries: set[str] = set()
        row_count = 0
        for row_number, row in enumerate(rows, start=2):
            if not any(value is not None for value in row):
                continue
            row_count += 1
            observed = row[date_index]
            if isinstance(observed, str):
                observed = datetime.fromisoformat(observed)
            if not isinstance(observed, (date, datetime)):
                raise ValueError(f"{path.name}, Export row {row_number}: invalid date")
            value = row[value_index]
            # The original groupby sum excludes missing numeric observations.
            if value is None:
                value = 0
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{path.name}, Export row {row_number}: invalid {value_column}")
            monthly[f"{observed.year:04d}-{observed.month:02d}"] += float(value)
            country = row[country_index]
            if flight_indices:
                group = flight_groups[(f"{observed.year:04d}-{observed.month:02d}", str(country))]
                for index, amount in enumerate([value, row[flight_indices[0]], row[flight_indices[1]]]):
                    if amount is not None and (not isinstance(amount, (int, float)) or not math.isfinite(amount)):
                        raise ValueError(f"{path.name}, Export row {row_number}: invalid flight count")
                    group[index] += float(amount or 0)
            if country is not None:
                countries.add(str(country))
        if flight_indices:
            monthly = defaultdict(float)
            for (period, _), (p2p, pax, seats) in flight_groups.items():
                monthly[period] += max(0.0, min(p2p, max(0.0, min(pax, seats))))
        return dict(monthly), row_count, len(countries)
    finally:
        workbook.close()


def derive_evidence(root: Path) -> dict:
    flight_path = root / "flight_data.xlsx"
    hotel_path = root / "data international_train.xlsx"
    flight, flight_rows, flight_countries = aggregate_source(
        flight_path, "Total P2P", "Departure Country Name"
    )
    hotel, hotel_rows, hotel_nationalities = aggregate_source(
        hotel_path, "New Arrivals", "Nationality"
    )
    common = sorted(set(flight).intersection(hotel))
    train = [month for month in common if month < TRAINING_CUTOFF]
    check = [month for month in common if month >= TRAINING_CUTOFF]
    if not train or not check:
        raise ValueError("Both training and held-out common months are required.")
    training_p2p = sum(flight[month] for month in train)
    training_arrivals = sum(hotel[month] for month in train)
    if training_p2p <= 0:
        raise ValueError("The training P2P total must be positive.")
    global_rate = training_arrivals / training_p2p
    monthly_rates: dict[str, float] = {}
    monthly_evidence: dict[str, dict] = {}
    for month in range(1, 13):
        observations = [period for period in train if int(period[-2:]) == month]
        p2p = sum(flight[period] for period in observations)
        arrivals = sum(hotel[period] for period in observations)
        if not observations or p2p <= 0:
            raise ValueError(f"Month {month} lacks a positive training P2P denominator.")
        raw_rate = arrivals / p2p
        rate = 0.7 * raw_rate + 0.3 * global_rate
        monthly_rates[str(month)] = rate
        monthly_evidence[str(month)] = {
            "months": len(observations), "hotelArrivals": arrivals,
            "p2pPassengers": p2p, "rawRate": raw_rate, "startingRate": rate,
        }
    validation_rows = []
    errors = 0
    constant_errors = 0
    actual_total = sum(hotel[month] for month in check)
    if actual_total <= 0:
        raise ValueError("The held-out hotel-arrival total must be positive.")
    for period in check:
        actual = hotel[period]
        p2p = flight[period]
        predicted = p2p * monthly_rates[str(int(period[-2:]))]
        constant_prediction = p2p * global_rate
        errors += abs(actual - predicted)
        constant_errors += abs(actual - constant_prediction)
        validation_rows.append({"month": period, "actual": actual,
                                "predicted": predicted, "p2pPassengers": p2p})
    return {
        "trainingPeriod": f"{train[0]} to {train[-1]}",
        "checkPeriod": f"{check[0]} to {check[-1]}",
        "trainingMonths": len(train), "checkMonths": len(check),
        "commonMonths": len(common), "globalRate": global_rate,
        "trainingP2pPassengers": training_p2p,
        "trainingHotelArrivals": training_arrivals,
        "monthlyRates": monthly_rates, "monthlyEvidence": monthly_evidence,
        "countryRatesAvailable": False,
        "conclusion": "Compare the seasonal and constant training-only scores. These aggregate checks do not establish route-level demand accuracy or a benefit from seasonal conversion.",
        "method": "Seasonal rate = 70% of the training month-of-year aggregate hotel-arrivals / P2P ratio + 30% of the overall training aggregate ratio. Ratios use only common months before 2025-01.",
        "scope": "All included markets combined. This is an aggregate planning calibration, not an observed route-specific or person-level hotel-choice probability.",
        "validation": {
            "wmape": errors / actual_total, "absoluteErrorSum": errors,
            "actualSum": actual_total,
            "constantTrainingGlobalWmape": constant_errors / actual_total,
            "rows": validation_rows,
        },
        "sourceRows": {"flight": flight_rows, "hotel": hotel_rows},
        "flightCountries": flight_countries, "hotelNationalities": hotel_nationalities,
        "limitations": [
            "Flight country is departure country; hotel country is passport nationality. The sources do not directly identify hotel arrivals by flight departure market.",
            "Month-of-year rates have limited training observations. Check-period calendar-month coverage must be read from the validation rows; missing seasons are not validated.",
            "This check uses recorded P2P totals for the same months. It does not validate future demand, new routes, purpose presets, event effects, nationality allocation, or route guest nights.",
            "Compare both reported WMAPE scores before claiming improvement. A seasonal method is not automatically more accurate.",
        ],
        "sources": [
            {"file": path.name, "sheet": "Export", "columns": columns,
             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path, columns in [
                (flight_path, ["Date", "Total P2P", "Total PAX", "Total Seats", "Departure Country Name"]),
                (hotel_path, ["Date", "New Arrivals", "Nationality"]),
            ]
        ],
    }


def write_evidence_module(evidence: dict, path: Path) -> None:
    path.write_text("// Generated from supplied workbooks by src/build_conversion_evidence.py.\n"
                    "// Training-only calibration; scores retain full precision.\n"
                    "export const CONVERSION_EVIDENCE = " + json.dumps(evidence, indent=2, allow_nan=False) + ";\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Optional JSON output file; omit to print JSON.")
    args = parser.parse_args()
    text = json.dumps(derive_evidence(args.root.resolve()), indent=2, allow_nan=False)
    if args.output:
        if args.output.suffix.lower() != ".json":
            parser.error("--output must name a .json file; source workbooks are read-only.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
