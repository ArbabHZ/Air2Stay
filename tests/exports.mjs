import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRoute, getBridge, weeksInMonth, runScenario, validateScenarioInputs } from '../prototype/engine.mjs';
import { planningMetrics, decisionNote, launchOptions, stressTest } from '../prototype/decision_tools.mjs';
import { buildPeerProfile } from '../prototype/route_planning.mjs';

const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
const locations=JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const source=fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8').replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const nodes=new Map(); let exported;
const node = () => ({ hidden:true, value:'FRANCE', textContent:'', dataset:{}, checked:false, handlers:{}, addEventListener(type,handler){this.handlers[type]=handler;}, replaceChildren(...items){this.items=items;} });
const context=vm.createContext({inputData:data,inputLocations:locations,Blob,findRoute,getBridge,weeksInMonth,runScenario,validateScenarioInputs,planningMetrics,decisionNote,launchOptions,stressTest,buildPeerProfile,
  URL:{createObjectURL(blob){exported=blob;return 'blob:test';},revokeObjectURL(){}},
  document:{addEventListener(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},
    createElement(){return {click(){},setAttribute(){},append(){}};},createTextNode(text){return {textContent:text};}}
});
vm.runInContext(source+'\ndata=inputData; countryLocationLookup=buildCountryLocationLookup(inputLocations); readForm=()=>{}; setupPlanActions(); setupDecisionTools();',context);
for (const [origin, proxy, flights] of [['FRANCE', '', 0], ['INDIA', '', 3], ['INDIA', '', -5], ['GREECE', '__PEERS__', 5]]) {
  Object.assign(context, { origin, proxy, flights });
  vm.runInContext('state=defaultState(origin,12,proxy); state.extraFlights=flights;', context);
  nodes.get('#exportCsv').handlers.click();
  const csv = await exported.text();
  assert.equal(exported.type, 'text/csv;charset=utf-8');
  const [header, ...lines] = csv.trimEnd().split('\r\n').map(line => line.split(','));
  assert.equal(header[0], 'meta_data_kind');
  assert.ok(lines.every(row => row.length === header.length));
  assert.ok(!/undefined|NaN|Infinity|GEMINI_API_KEY|assistantToken/.test(csv));
  const records = lines.map(row => Object.fromEntries(header.map((name, i) => [name, row[i]])));
  assert.equal(new Set(records.map(row => row.feature_calendar_month)).size, 12);
  const featureNames = header.filter(name => name.startsWith('feature_'));
  const featureRows = records.map(row => featureNames.map(name => row[name]).join(','));
  assert.equal(new Set(featureRows).size, records.length);
  for (const row of records) {
    assert.equal(row.meta_data_kind, 'simulation');
    assert.ok(featureNames.every(name => row[name] !== '' && Number.isFinite(Number(row[name]))));
    context.month = Number(row.feature_calendar_month);
    const plan = vm.runInContext('planInputsForMonth(state, month)', context);
    const result = runScenario(data, {
      ...plan,
      extraFlights: Number(row.feature_weekly_flight_change),
      loadFactor: Number(row.feature_flight_load_fraction),
      conversionRate: Number(row.feature_hotel_checkin_fraction),
      averageStay: Number(row.feature_nights_per_stay),
    });
    assert.equal(Number(row.feature_usual_monthly_flight_seats), result.route.baselineSeats);
    assert.equal(Number(row.target_simulated_hotel_checkins), result.scenario.hotelCheckins);
    assert.equal(Number(row.target_simulated_guest_nights), result.scenario.guestNights);
  }
  const selected = records.filter(row => row.meta_is_current_plan === '1');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].feature_calendar_month, '12');
  assert.equal(Number(selected[0].feature_weekly_flight_change), flights);
  const activeResult = vm.runInContext('runScenario(data, state)', context);
  assert.equal(Number(selected[0].target_simulated_guest_nights), activeResult.scenario.guestNights);
  if (origin === 'GREECE') assert.equal(selected[0].meta_has_route_history, '0');
}
nodes.get('#inputError').hidden = false;
exported = null;
nodes.get('#exportCsv').handlers.click();
assert.equal(exported, null);

// Exercise the actual decision-note click handler, including its separate peer
// appendix, rather than testing only the pure note builder.
nodes.get('#inputError').hidden=true;
vm.runInContext('state=defaultState("GREECE",12,"__PEERS__"); state.extraFlights=4; state.conversionRate=0.23456789; state.averageStay=4.87654321; state.routePurpose="holiday"; bridgeOverride=null;',context);
nodes.get('#alternativeOrigin').value='FRANCE';
nodes.get('#exportDecisionNote').handlers.click();
const decisionText=await exported.text();
assert.equal(exported.type,'text/plain;charset=utf-8');
assert.ok(decisionText.includes('Current proposal · Greece'));
assert.ok(decisionText.includes('Extra flights · France'));
const comparedOptions=vm.runInContext('decisionOptions()',context);
const exactRows=decisionText.split('\n').filter((line)=>line.startsWith('Exact inputs and results: '))
  .map((line)=>JSON.parse(line.slice('Exact inputs and results: '.length)));
assert.equal(exactRows.length,2);
for(const [index,option] of comparedOptions.entries()) {
  for(const key of ['originKey','month','extraFlights','seatsPerFlight','loadFactor','p2pShare','conversionRate','averageStay','eventUplift']) {
    assert.equal(exactRows[index][key],option.inputs[key],option.label+': exported '+key);
  }
  const result=planningMetrics(data,option.inputs);
  assert.deepEqual(exactRows[index].incremental,JSON.parse(JSON.stringify(result.incremental)));
  assert.equal(exactRows[index].per1000AddedSeats,result.per1000AddedSeats);
}
assert.equal(exactRows[0].conversionRate,0.23456789);
assert.equal(exactRows[0].averageStay,4.87654321);
assert.ok(decisionText.includes('Comparison-country starting weights'));
const currentState=vm.runInContext('state',context);
assert.ok(currentState.peerProfile.peers.length>1);
for(const peer of currentState.peerProfile.peers) assert.ok(decisionText.includes(peer.origin+': '+(peer.weight*100).toFixed(1)+'%'));
assert.ok(!decisionText.includes('Capacity target check'));
assert.ok(!/undefined|NaN|GEMINI_API_KEY|assistantToken/.test(decisionText));

nodes.get('#inputError').hidden=false;exported=null;
nodes.get('#exportDecisionNote').handlers.click();assert.equal(exported,null);
console.log('PASS: model-ready CSV rows match the simulator across all months; decision-note exports preserve both alternatives, and peer weights; invalid plans block export.');
