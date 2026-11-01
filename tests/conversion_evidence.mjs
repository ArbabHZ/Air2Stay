import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONVERSION_EVIDENCE as e } from '../prototype/conversion_evidence.mjs';

assert.equal(e.countryRatesAvailable,false);
assert.equal(Object.keys(e.monthlyRates).length,12);
assert.equal(e.trainingPeriod,'2022-01 to 2024-12');
assert.equal(e.checkPeriod,'2025-01 to 2025-07');
const groups=Object.values(e.monthlyEvidence);
assert.equal(groups.reduce((s,r)=>s+r.months,0),e.trainingMonths);
assert.equal(groups.reduce((s,r)=>s+r.hotelArrivals,0),e.trainingHotelArrivals);
assert.equal(groups.reduce((s,r)=>s+r.p2pPassengers,0),e.trainingP2pPassengers);
assert.equal(e.trainingHotelArrivals/e.trainingP2pPassengers,e.globalRate);
for (let month=1;month<=12;month++) {
  const row=e.monthlyEvidence[month];
  assert.equal(row.months,3);
  assert.ok(Math.abs(.7*row.hotelArrivals/row.p2pPassengers+.3*e.globalRate-e.monthlyRates[month])<1e-15);
  assert.ok(e.monthlyRates[month]>0 && e.monthlyRates[month]<1);
}
const exported=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
let errors=0, actuals=0, constantErrors=0;
for (const row of e.validation.rows) {
  const month=Number(row.month.slice(-2));
  assert.equal(Math.round(row.p2pPassengers*e.monthlyRates[month]),row.predicted);
  const original=exported.validation.find(r=>r.month===row.month);
  assert.equal(row.actual,original.actual);
  assert.equal(row.predicted,original.transparent);
  errors+=Math.abs(row.actual-row.predicted);actuals+=row.actual;
  constantErrors+=Math.abs(row.actual-Math.round(row.p2pPassengers*e.globalRate));
}
assert.equal(errors,e.validation.absoluteErrorSum);
assert.equal(actuals,e.validation.actualSum);
assert.equal(errors/actuals,e.validation.wmape);
assert.equal(constantErrors/actuals,e.validation.constantTrainingGlobalWmape);
assert.ok(e.validation.constantTrainingGlobalWmape<e.validation.wmape);
for (const source of e.sources) {
  const path=new URL('../'+source.file,import.meta.url);
  if (fs.existsSync(path)) assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'),source.sha256,'Source changed; regenerate calibration evidence.');
}
if (process.argv.includes('--from-source')) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const projectPython=fileURLToPath(new URL(process.platform==='win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python',import.meta.url));
  const python=process.env.AIR2STAY_PYTHON || (fs.existsSync(projectPython) ? projectPython : process.platform==='win32' ? 'python' : 'python3');
  const generated=JSON.parse(execFileSync(python,['src/build_conversion_evidence.py'],{cwd:root,encoding:'utf8'}));
  for (const field of ['globalRate','trainingMonths','checkMonths','trainingP2pPassengers','trainingHotelArrivals','monthlyRates','validation','sourceRows']) assert.deepEqual(generated[field],e[field],'Source reproduction differs: '+field);
  console.log('PASS: portable openpyxl generator independently reproduces all 12 rates and both held-out benchmark scores from source workbooks.');
}
console.log('PASS: 12 training-only seasonal rates reconcile to source totals; seven predictions and WMAPE reproduce exactly; constant-rate comparison reported; country-rate and seasonal-check limits explicit.');
