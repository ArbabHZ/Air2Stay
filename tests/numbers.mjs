import assert from 'node:assert/strict';
import fs from 'node:fs';
import {findRoute,getBridge,runScenario,sensitivity} from '../prototype/engine.mjs';
const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
let cases=0;
for(const source of data.routes){
 const route=findRoute(data,source.originKey,source.month),bridge=getBridge(data,route.originKey,route.month);
 const inputs={originKey:route.originKey,month:route.month,extraFlights:0,seatsPerFlight:Math.round(route.seatsPerFlight),loadFactor:route.loadFactor,p2pShare:route.p2pShare,conversionRate:data.defaults.captureRate,averageStay:bridge.reduce((s,r)=>s+r.weight*r.averageStay,0),eventUplift:0};
 const original=runScenario(data,inputs);
 assert.equal(original.delta.guestNights,0);
 for(const flights of [-3,0,3])for(const uplift of [0,.5]){
  const changed=runScenario(data,{...inputs,extraFlights:flights,eventUplift:uplift,bridgeOverride:bridge.map((r,i)=>({...r,weight:i===0?1:0}))});
  assert.deepEqual(changed.baseline,original.baseline);
  assert.ok(Math.abs(changed.contributions.reduce((s,r)=>s+r.deltaGuestNights,0)-changed.delta.guestNights)<1e-6);
  assert.ok(Object.values(changed.scenario).every(Number.isFinite));cases++;
 }
 const s=sensitivity(data,{...inputs,extraFlights:-3}).find(r=>r.label==='Extra flights each week');
 assert.ok(s.lowDelta<=0&&s.highDelta>=0);
 for(const bad of [{averageStay:''},{averageStay:100},{averageStay:-1},{seatsPerFlight:601},{loadFactor:1.1},{month:1.5},{p2pShare:NaN}])assert.throws(()=>runScenario(data,{...inputs,...bad}),RangeError);
}
console.log(`PASS: ${data.routes.length} zero-change routes, ${cases} mix/flight/event combinations, negative-flight sensitivity, and 7 invalid inputs per route.`);
