"""Measure how past events changed Abu Dhabi hotel guest nights and check-ins.

Run from the project root with the project's Python environment:
    .venv/Scripts/python.exe src/build_event_evidence.py            (Windows)
    .venv/bin/python src/build_event_evidence.py                    (macOS / Linux)
Add --check to compare with the committed module instead of writing it.

Inputs (read-only):
  * prototype/news_events.mjs: event dates and holiday periods (team-edited).
  * dct Data/data {international,domestic}_{train,test}.xlsx: daily hotel data.
Output:
  * prototype/event_evidence.mjs: EVENT_EVIDENCE, inlined by the app.

Method, per past edition and per segment (international, domestic):
  * Main measure: hotel guests staying on each event night ("Guests"; summed
    Guests are guest nights, as in src/build_model.py). Check-ins ("New
    Arrivals") are measured over the event plus the two days before, as detail:
    when hotels fill up during an event, check-ins can fall while guests stay.
  * Days inside a holiday period are left out.
  * Normal level for a day: the median of the same weekday 1, 2 and 3 weeks
    before and after, using only matched before/after pairs (so a steady
    seasonal trend cancels) and skipping holidays and every event period
    (two days before to two days after each edition). At least one pair is
    needed, otherwise that day is left out.
  * The supplied files have Guests only up to 31 July 2025. Later editions are
    not measured on guest nights; nothing is estimated in their place.
Only openpyxl and the standard library are used.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, timedelta
import hashlib
import json
import statistics
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
CALENDAR_PATH = ROOT / "prototype" / "news_events.mjs"
OUTPUT_PATH = ROOT / "prototype" / "event_evidence.mjs"
DATA_DIR = ROOT / "dct Data"
FILES = {
    "international_train": "data international_train.xlsx",
    "international_test": "data international_test.xlsx",
    "domestic_train": "data domestic_train.xlsx",
    "domestic_test": "data domestic_test.xlsx",
}
SEGMENTS = ("international", "domestic")
LEAD_DAYS = 2
LAG_DAYS = 2
OFFSETS = (7, 14, 21)
MIN_NATIONALITY_NORMAL_NIGHTS = 500
PREFIX = "export const NEWS_EVENTS = "


def read_calendar(path: Path = CALENDAR_PATH) -> dict:
    text = path.read_text(encoding="utf-8")
    start = text.index(PREFIX) + len(PREFIX)
    end = text.rindex(";")
    return json.loads(text[start:end])


def to_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def days_between(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


class Series:
    """Daily values for one segment: check-ins on every supplied day, guests where supplied."""

    def __init__(self):
        self.checkins = defaultdict(float)
        self.guests = defaultdict(float)
        self.guest_days = set()
        self.days = set()


def read_hotels(data_dir: Path = DATA_DIR):
    segments = {name: Series() for name in SEGMENTS}
    nationality_guests = defaultdict(lambda: defaultdict(float))
    sources = []
    for key, name in FILES.items():
        segment = segments[key.split("_")[0]]
        path = data_dir / name
        sources.append({"file": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            rows = workbook["Export"].iter_rows(values_only=True)
            headers = [str(h).strip() if h is not None else "" for h in next(rows)]
            col = {h: i for i, h in enumerate(headers)}
            guest_col = col.get("Guests")
            nationality_col = col.get("Nationality")
            for row in rows:
                if row[col["Date"]] is None:
                    continue
                day = to_date(row[col["Date"]])
                segment.days.add(day)
                segment.checkins[day] += float(row[col["New Arrivals"]] or 0)
                if guest_col is not None:
                    value = float(row[guest_col] or 0)
                    segment.guests[day] += value
                    segment.guest_days.add(day)
                    if nationality_col is not None:
                        nationality_guests[str(row[nationality_col]).strip().upper()][day] += value
        finally:
            workbook.close()
    return segments, nationality_guests, sources


def holiday_days(calendar: dict) -> set:
    found = set()
    for holiday in calendar["holidays"]:
        found.update(days_between(to_date(holiday["start"]), to_date(holiday["end"])))
    return found


def event_period_days(calendar: dict) -> set:
    found = set()
    for event in calendar["events"]:
        for edition in event["editions"]:
            found.update(days_between(to_date(edition["start"]) - timedelta(days=LEAD_DAYS),
                                      to_date(edition["end"]) + timedelta(days=LAG_DAYS)))
    return found


def normal_days(day: date, available: set, excluded: set) -> list:
    """Matched before/after pairs of the same weekday."""
    picks = []
    for offset in OFFSETS:
        before, after = day - timedelta(days=offset), day + timedelta(days=offset)
        if before in available and after in available and before not in excluded and after not in excluded:
            picks.extend([before, after])
    return picks


def compare(days: list, values: dict, available: set, excluded: set) -> dict | None:
    used = [(day, normal_days(day, available, excluded)) for day in days]
    used = [(day, picks) for day, picks in used if picks]
    if not used:
        return None
    actual = sum(values[day] for day, _ in used)
    normal = sum(statistics.median(values[p] for p in picks) for _, picks in used)
    by_month = defaultdict(float)
    for day, picks in used:
        by_month[day.strftime("%Y-%m")] += values[day] - statistics.median(values[p] for p in picks)
    return {"days": [day.isoformat() for day, _ in used], "actual": round(actual, 2), "normal": round(normal, 2),
            "extra": round(actual - normal, 2), "pct": (actual - normal) / normal if normal else None,
            "extraByMonth": {month: round(value, 2) for month, value in sorted(by_month.items())}}


def measure_edition(edition: dict, segments: dict, nationality_guests: dict, holidays: set, excluded: set) -> dict:
    start, end = to_date(edition["start"]), to_date(edition["end"])
    nights = [day for day in days_between(start, end) if day not in holidays]
    lead = [day for day in days_between(start - timedelta(days=LEAD_DAYS), end) if day not in holidays]
    international = segments["international"]
    first, last = min(international.days), max(international.days)
    record = {"start": edition["start"], "end": edition["end"], "eventNights": (end - start).days + 1,
              "holidayDays": [d.isoformat() for d in days_between(start - timedelta(days=LEAD_DAYS), end) if d in holidays]}
    if start - timedelta(days=LEAD_DAYS) > last:
        record["status"] = "after_data"
        return record
    if end < first:
        record["status"] = "before_data"
        return record
    checkins = {}
    for name, series in segments.items():
        if all(day in series.days for day in lead):
            checkins[name] = compare(lead, series.checkins, series.days, excluded)
    nights_result = {}
    if nights and all(day in segments[name].guest_days for name in SEGMENTS for day in nights):
        for name, series in segments.items():
            nights_result[name] = compare(nights, series.guests, series.guest_days, excluded)
    record["checkins"] = {name: value for name, value in checkins.items() if value}
    if not nights_result:
        record["status"] = "no_guest_nights"
        return record
    if not nights_result.get("international"):
        record["status"] = "too_few_days"
        return record
    record["status"] = "measured"
    record["nights"] = {name: value for name, value in nights_result.items() if value}
    used = record["nights"]["international"]["days"]
    # Nationalities: the same nights and comparison days as the international total.
    picks_by_day = [(day, normal_days(day, segments["international"].guest_days, excluded))
                    for day in (date.fromisoformat(value) for value in used)]
    rows = []
    for country, series in nationality_guests.items():
        normal = sum(statistics.median(series.get(p, 0.0) for p in picks) for _, picks in picks_by_day)
        if normal < MIN_NATIONALITY_NORMAL_NIGHTS:
            continue
        actual = sum(series.get(day, 0.0) for day, _ in picks_by_day)
        rows.append({"country": country, "extra": round(actual - normal, 2), "pct": (actual - normal) / normal})
    rows.sort(key=lambda row: (-row["extra"], row["country"]))
    record["topNationalities"] = [row for row in rows if row["extra"] > 0][:3]
    return record


def reference_normal(edition: dict, segments: dict, holidays: set, excluded: set) -> dict | None:
    """Normal international guests per night for an edition's dates, read from the
    latest year with guest-night data: the dates move back in steps of 52 weeks
    (keeping weekdays) until they fall inside the data, then use the same pairs."""
    series = segments["international"]
    last = max(series.guest_days)
    nights = list(days_between(to_date(edition["start"]), to_date(edition["end"])))
    weeks = 0
    while nights[-1] - timedelta(weeks=weeks) > last:
        weeks += 52
    shifted = [day - timedelta(weeks=weeks) for day in nights]
    usable = [day for day in shifted if day in series.guest_days and day not in holidays]
    result = compare(usable, series.guests, series.guest_days, excluded) if usable else None
    if not result:
        return None
    return {"shiftedWeeks": weeks, "days": result["days"], "perNight": result["normal"] / len(result["days"])}


def monthly_nights(segments: dict) -> dict:
    """International and domestic guest nights for calendar months fully covered by Guests."""
    out = {}
    months = sorted({day.strftime("%Y-%m") for day in segments["international"].guest_days})
    for month in months:
        year, number = map(int, month.split("-"))
        first = date(year, number, 1)
        following = date(year + (number == 12), number % 12 + 1, 1)
        days = list(days_between(first, following - timedelta(days=1)))
        if all(day in segments[name].guest_days for name in SEGMENTS for day in days):
            out[month] = {name: round(sum(segments[name].guests[day] for day in days), 2) for name in SEGMENTS}
    return out


def derive(calendar: dict, data_dir: Path = DATA_DIR) -> dict:
    segments, nationality_guests, sources = read_hotels(data_dir)
    holidays = holiday_days(calendar)
    excluded = holidays | event_period_days(calendar)
    editions = {}
    for event in calendar["events"]:
        for edition in event["editions"]:
            record = {"eventId": event["id"], **measure_edition(edition, segments, nationality_guests, holidays, excluded)}
            # Editions without measured guest nights (later or future) get the normal
            # level for their dates, for forecasts.
            if record["status"] != "measured":
                reference = reference_normal(edition, segments, holidays, excluded)
                if reference:
                    record["referenceNormal"] = reference
            editions[edition["id"]] = record
    international = segments["international"]
    return {
        "dataPeriod": {"start": min(international.days).isoformat(), "end": max(international.days).isoformat()},
        "guestsPeriod": {"start": min(international.guest_days).isoformat(), "end": max(international.guest_days).isoformat()},
        "method": {"leadDays": LEAD_DAYS, "lagDays": LAG_DAYS, "offsetsDays": list(OFFSETS),
                   "minNationalityNormalNights": MIN_NATIONALITY_NORMAL_NIGHTS},
        "calendar": {event["id"]: [[e["id"], e["start"], e["end"]] for e in event["editions"]] for event in calendar["events"]},
        "holidays": [[h["start"], h["end"]] for h in calendar["holidays"]],
        "monthlyNights": monthly_nights(segments),
        "editions": editions,
        "sources": sources,
    }


def module_text(evidence: dict) -> str:
    return ("// Generated by src/build_event_evidence.py from the daily DCT hotel files and\n"
            "// prototype/news_events.mjs. Do not edit by hand; rerun the script instead.\n"
            "export const EVENT_EVIDENCE = " + json.dumps(evidence, indent=1, allow_nan=False, ensure_ascii=False) + ";\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="Compare with the committed module; do not write.")
    args = parser.parse_args()
    text = module_text(derive(read_calendar()))
    if args.check:
        current = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.exists() else ""
        if current.replace("\r\n", "\n") != text:
            raise SystemExit("prototype/event_evidence.mjs is out of date: run src/build_event_evidence.py")
        print("event evidence is up to date")
        return
    OUTPUT_PATH.write_text(text, encoding="utf-8", newline="\n")
    print("wrote", OUTPUT_PATH.relative_to(ROOT))


if __name__ == "__main__":
    main()
