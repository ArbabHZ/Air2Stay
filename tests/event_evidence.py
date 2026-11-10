"""Checks for src/build_event_evidence.py.
Run: .venv/Scripts/python.exe tests/event_evidence.py   (Windows)
     .venv/bin/python tests/event_evidence.py           (macOS / Linux)
The last test re-measures from the confidential workbooks when they are present
locally and is skipped otherwise.
"""
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import build_event_evidence as ev  # noqa: E402


def series_from(values: dict) -> "ev.Series":
    series = ev.Series()
    for day, value in values.items():
        series.days.add(day)
        series.guest_days.add(day)
        series.guests[day] = value
        series.checkins[day] = value / 3
    return series


class MeasurementChecks(unittest.TestCase):
    start = date(2024, 3, 1)

    def days(self, count=120):
        return [self.start + timedelta(days=i) for i in range(count)]

    def test_steady_trend_measures_zero(self):
        values = {day: 1000 + 7 * i for i, day in enumerate(self.days())}
        target = [self.start + timedelta(days=60 + i) for i in range(3)]
        result = ev.compare(target, values, set(values), set())
        self.assertAlmostEqual(result["extra"], 0, places=6)
        self.assertEqual(result["days"], [d.isoformat() for d in target])

    def test_spike_is_measured_exactly(self):
        values = {day: 1000.0 for day in self.days()}
        target = [self.start + timedelta(days=60 + i) for i in range(3)]
        for day in target:
            values[day] += 250
        result = ev.compare(target, values, set(values), set())
        self.assertAlmostEqual(result["extra"], 750)
        self.assertAlmostEqual(result["pct"], 0.25)
        self.assertEqual(sum(result["extraByMonth"].values()), 750)

    def test_pairs_need_both_sides_and_skip_excluded_days(self):
        day = self.start + timedelta(days=60)
        available = set(self.days())
        # Exclude the day one week after: the one-week pair is dropped, not half-used.
        picks = ev.normal_days(day, available, {day + timedelta(days=7)})
        self.assertEqual(sorted(picks), sorted([day - timedelta(days=14), day + timedelta(days=14), day - timedelta(days=21), day + timedelta(days=21)]))
        self.assertTrue(all(p.weekday() == day.weekday() for p in picks))
        everything = {day + timedelta(days=sign * k) for k in (7, 14, 21) for sign in (-1, 1)}
        self.assertEqual(ev.normal_days(day, available, everything), [])
        self.assertIsNone(ev.compare([day], {d: 1.0 for d in available}, available, everything))

    def test_edition_leaves_out_holidays_and_needs_guest_nights(self):
        values = {day: 1000.0 for day in self.days()}
        segments = {"international": series_from(values), "domestic": series_from(values)}
        edition = {"id": "x-2024", "start": "2024-05-01", "end": "2024-05-03"}
        holidays = {date(2024, 5, 2)}
        record = ev.measure_edition(edition, segments, {}, holidays, holidays)
        self.assertEqual(record["status"], "measured")
        self.assertEqual(record["nights"]["international"]["days"], ["2024-05-01", "2024-05-03"])
        self.assertEqual(record["holidayDays"], ["2024-05-02"])
        later = {"id": "x-2030", "start": "2030-05-01", "end": "2030-05-03"}
        self.assertEqual(ev.measure_edition(later, segments, {}, set(), set())["status"], "after_data")

    def test_reference_normal_shifts_whole_years_and_keeps_weekdays(self):
        days = [date(2024, 1, 1) + timedelta(days=i) for i in range(366)]
        values = {day: 500.0 for day in days}
        segments = {"international": series_from(values), "domestic": series_from(values)}
        edition = {"id": "x-2026", "start": "2026-06-10", "end": "2026-06-11"}
        reference = ev.reference_normal(edition, segments, set(), set())
        self.assertEqual(reference["shiftedWeeks"], 104)
        self.assertAlmostEqual(reference["perNight"], 500.0)
        first = date.fromisoformat(reference["days"][0])
        self.assertEqual(first.weekday(), date(2026, 6, 10).weekday())

    def test_calendar_reads_the_app_module(self):
        calendar = ev.read_calendar()
        self.assertTrue(any(event["id"] == "f1" for event in calendar["events"]))
        self.assertTrue(calendar["holidays"])

    @unittest.skipUnless((ev.DATA_DIR / ev.FILES["international_train"]).exists(), "confidential workbooks not present")
    def test_committed_evidence_matches_the_workbooks(self):
        expected = ev.module_text(ev.derive(ev.read_calendar()))
        current = ev.OUTPUT_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
        self.assertEqual(current, expected, "run src/build_event_evidence.py")


if __name__ == "__main__":
    unittest.main()
