"""Regression checks for calibration, capacity cleaning and Python/browser parity.
Run: .venv/bin/python tests/pipeline.py [--from-source]
The source option reads confidential workbooks locally; temporary cases are removed.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import build_model as model

FROM_SOURCE = '--from-source' in sys.argv
if FROM_SOURCE:
    sys.argv.remove('--from-source')


def synthetic():
    rows = []
    for i, month in enumerate(pd.period_range('2022-01', '2025-07', freq='M')):
        for country, pax, p2p in [('CANADA', 1050, 150), ('INDIA', 800, 500)]:
            rows.append({'Date': month.start_time, 'Departure Country Name': country,
                         'Total Seats': 1000 + i * 3, 'Total PAX': pax + i,
                         'Total P2P': p2p + i, 'Total Transfer': 0, 'Total Transit': 0,
                         'Average Weekly Frequency': 2})
    flight, seasonal = model.aggregate_flights(pd.DataFrame(rows))
    hotels = flight.groupby('Month')[['Total_P2P']].sum().reset_index()
    hotels['New_Arrivals'] = hotels.Total_P2P * .4 * (1 + .08 * np.sin(np.arange(len(hotels))))
    hotels['Guests'] = hotels.New_Arrivals * 3.4
    return flight, seasonal, hotels


class PipelineChecks(unittest.TestCase):
    def test_occupancy_cap_preserves_p2p_and_source_counts(self):
        flight, seasonal, _ = synthetic()
        canada = flight[flight.Country == 'CANADA']
        self.assertTrue((canada.Total_PAX > canada['Planning PAX']).any())
        self.assertTrue((flight['Load Factor'] <= 1).all())
        np.testing.assert_allclose(flight.Total_Seats * flight['Load Factor'] * flight['P2P Share'], flight.Total_P2P)
        self.assertTrue((seasonal.load_factor <= 1).all())
        self.assertTrue((seasonal.p2p_share <= 1).all())

    def test_held_out_outcomes_cannot_change_conversion(self):
        flight, _, hotels = synthetic()
        before, _ = model.validate_flight_chain(flight, hotels)
        changed = hotels.copy()
        changed.loc[changed.Month >= pd.Period('2025-01'), 'New_Arrivals'] *= 10
        after, _ = model.validate_flight_chain(flight, changed)
        for field in ['global_capture_rate', 'weighted_load_factor', 'p2p_share']:
            self.assertEqual(before[field], after[field])
        self.assertNotEqual(before['live_chain_wmape'], after['live_chain_wmape'])
        train = hotels[hotels.Month < pd.Period('2025-01')]
        self.assertEqual(before['global_capture_rate'], train.New_Arrivals.sum() / train.Total_P2P.sum())

    def test_live_score_uses_unrounded_chain_not_comparison_model(self):
        flight, _, hotels = synthetic()
        metrics, rows = model.validate_flight_chain(flight, hotels)
        expected = flight[flight.Month >= pd.Period('2025-01')].copy()
        expected['checkins'] = expected.Total_P2P * metrics['global_capture_rate']
        actual = rows.New_Arrivals.to_numpy()
        forecast = expected.groupby('Month').checkins.sum().to_numpy()
        np.testing.assert_allclose(rows['Live Prediction'], forecast, rtol=1e-14)
        self.assertAlmostEqual(metrics['live_chain_wmape'], np.abs(actual-forecast).sum()/np.abs(actual).sum(), places=14)
        self.assertTrue((rows['Live Prediction'] % 1 != 0).any())
        self.assertNotEqual(metrics['live_chain_wmape'], metrics['flight_to_checkins_wmape'])
        ratios = actual / forecast
        self.assertAlmostEqual(metrics['uncertainty_low_multiplier'], max(.5, np.quantile(ratios,.1)))
        self.assertAlmostEqual(metrics['uncertainty_high_multiplier'], min(1.8, np.quantile(ratios,.9)))

    @unittest.skipUnless(FROM_SOURCE, 'Use --from-source to reproduce the supplied workbooks')
    def test_source_rebuild_and_browser_parity(self):
        flight, seasonal = model.aggregate_flights(model.read_excel('flight_data.xlsx'))
        hotel, stays, _ = model.aggregate_hotels(model.read_excel('international_train.xlsx'))
        metrics, rows = model.validate_flight_chain(flight, hotel)
        data = json.loads((ROOT/'prototype/data/scenario_data.json').read_text())
        report = json.loads((ROOT/'outputs/model/model_report.json').read_text())
        rebuilt = model.scenario_payload(seasonal, model.build_bridge(flight,hotel), stays,
                                         metrics, report['international_stay_model'], rows)
        for field in ['routes','bridge','fallbackBridge','defaults','validation','metrics']:
            self.assertEqual(data[field], rebuilt[field], field)
        cases = []
        days = [31,28.25,31,30,31,30,31,31,30,31,30,31]
        for route in data['routes']:
            bridge = data['bridge'][route['originKey']][str(route['month'])]
            stay = sum(r['weight']*r['averageStay'] for r in bridge)/sum(r['weight'] for r in bridge)
            base = model.planning_chain(route['baselineSeats'], route['loadFactor'], route['p2pShare'], data['defaults']['captureRate'], stay)
            for extra in [-3,0,3]:
                inputs = dict(originKey=route['originKey'],month=route['month'],extraFlights=extra,
                              seatsPerFlight=route['seatsPerFlight'],loadFactor=route['loadFactor'],
                              p2pShare=route['p2pShare'],conversionRate=data['defaults']['captureRate'],averageStay=stay)
                seats = max(0,route['baselineSeats']+extra*route['seatsPerFlight']*days[route['month']-1]/7)
                plan = model.planning_chain(seats,route['loadFactor'],route['p2pShare'],data['defaults']['captureRate'],stay)
                cases.append(dict(inputs=inputs,baseline=base,scenario=plan))
        # Exercise the engine on each held-out country's actual seats and cleaned
        # passenger ratios, then reconcile the sum to the reported monthly score.
        held = []
        for _, r in flight[flight.Month >= pd.Period('2025-01')].iterrows():
            if str(r.Month) not in set(rows.Month):
                continue
            held.append(dict(period=str(r.Month),origin=r.Country,month=int(r.Month.month),
                             seats=float(r.Total_Seats),load=float(r['Load Factor']),share=float(r['P2P Share'])))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'parity.json'
            path.write_text(json.dumps(dict(cases=cases,held=held)))
            js = '''import fs from 'node:fs';import assert from 'node:assert/strict';
import {runScenario} from './prototype/engine.mjs';
const data=JSON.parse(fs.readFileSync('prototype/data/scenario_data.json'));
const fixture=JSON.parse(fs.readFileSync(process.argv[2]));let compared=0;
for(const c of fixture.cases){const actual=runScenario(data,c.inputs);
 for(const section of ['baseline','scenario'])for(const key of Object.keys(c[section])){
  assert.ok(Math.abs(actual[section][key]-c[section][key])<1e-7,section+'.'+key);compared++;
 }if(c.inputs.extraFlights===0)assert.equal(actual.delta.guestNights,0);
}
const sums={};for(const r of fixture.held){
 const route={origin:r.origin,originKey:r.origin,month:r.month,baselineSeats:r.seats,loadFactor:r.load,p2pShare:r.share,seatsPerFlight:200,yearsObserved:1};
 const result=runScenario({...data,routes:[route]}, {originKey:r.origin,month:r.month,extraFlights:0});
 sums[r.period]=(sums[r.period]||0)+result.scenario.hotelCheckins;
}
for(const r of data.validation)assert.ok(Math.abs(sums[r.month]-r.transparent)<1e-7,r.month);
const errors=data.validation.reduce((s,r)=>s+Math.abs(r.actual-r.transparent),0);
const total=data.validation.reduce((s,r)=>s+r.actual,0);
assert.ok(Math.abs(errors/total-data.metrics.liveChainWmape)<1e-14);
console.log(`PASS: ${fixture.cases.length} Python/browser scenarios, ${compared} values, ${fixture.held.length} held-out country-month chains and live WMAPE reproduce.`);
'''
            subprocess.run(['node','--input-type=module','-',str(path)],input=js,text=True,cwd=ROOT,check=True)


if __name__ == '__main__':
    unittest.main()
