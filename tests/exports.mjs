import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRoute, getBridge, weeksInMonth, runScenario, validateScenarioInputs } from '../prototype/engine.mjs';
import { planningMetrics, decisionNote, solveCapacityTarget } from '../prototype/decision_tools.mjs';
import { buildPeerProfile } from '../prototype/route_planning.mjs';

const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
const locations=JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const source=fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8').replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const nodes=new Map(); let exported;
const node = () => ({ hidden:true, value:'FRANCE', textContent:'', dataset:{}, checked:false, handlers:{}, addEventListener(type,handler){this.handlers[type]=handler;}, replaceChildren(...items){this.items=items;} });
const context=vm.createContext({inputData:data,inputLocations:locations,Blob,findRoute,getBridge,weeksInMonth,runScenario,validateScenarioInputs,planningMetrics,decisionNote,solveCapacityTarget,buildPeerProfile,
  URL:{createObjectURL(blob){exported=blob;return 'blob:test';},revokeObjectURL(){}},
  document:{addEventListener(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},
    createElement(){return {click(){}};},createTextNode(text){return {textContent:text};}}
});
vm.runInContext(source+'\ndata=inputData; countryLocationLookup=buildCountryLocationLookup(inputLocations); readForm=()=>{}; setupPlanActions(); setupDecisionTools();',context);
for (const [origin,proxy,flights] of [['FRANCE','',0],['INDIA','',3],['GREECE','ITALY',5]]) {
  context.origin=origin;context.proxy=proxy;context.flights=flights;
  vm.runInContext('state=defaultState(origin,12,proxy); state.extraFlights=flights;',context);
  nodes.get('#exportScenario').handlers.click();
  const payload=JSON.parse(await exported.text());
  const result=runScenario(data,payload.inputs);
  assert.deepEqual(payload.baseline,result.baseline);
  assert.deepEqual(payload.scenario,result.scenario);
  assert.deepEqual(payload.change,result.delta);
  assert.ok(payload.notes.join(' ').includes('starting assumptions'));
  nodes.get('#exportCsv').handlers.click();
  const csv=await exported.text();
  assert.ok(csv.includes('"Guest nights","count","'+result.baseline.guestNights+'","'+result.scenario.guestNights+'"'));
  assert.ok(csv.includes('User assumption; not measured event impact'));
  assert.ok(!/undefined|NaN|GEMINI_API_KEY|assistantToken/.test(csv));
}
nodes.get('#inputError').hidden=false;exported=null;
nodes.get('#exportScenario').handlers.click();assert.equal(exported,null);

// Exercise the actual decision-note click handler, including its separate peer
// appendix and target text, rather than testing only the pure note builder.
nodes.get('#inputError').hidden=true;
vm.runInContext('state=defaultState("GREECE",12,"__PEERS__"); state.extraFlights=4; state.conversionRate=0.23456789; state.averageStay=4.87654321; state.routePurpose="holiday"; bridgeOverride=null;',context);
nodes.get('#alternativeOrigin').value='FRANCE';
nodes.get('#sameComparisonAssumptions').checked=false;
nodes.get('#exportDecisionNote').handlers.click();
let decisionText=await exported.text();
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

nodes.get('#targetGuestNights').value='5000';
nodes.get('#calculateTarget').handlers.click();
const targetText=nodes.get('#targetResult').textContent;
const target=solveCapacityTarget(data,currentState,5000);
assert.ok(targetText.includes(target.met ? target.requiredWeeklyFlights+' extra flights' : 'not reached within 20'));
nodes.get('#exportDecisionNote').handlers.click();
decisionText=await exported.text();
assert.ok(decisionText.includes('Capacity target check\n'+targetText));
assert.ok(decisionText.includes('not proof of passenger demand') || decisionText.includes('not reached within 20'));
assert.ok(!/undefined|NaN|GEMINI_API_KEY|assistantToken/.test(decisionText));

// Editing the target invalidates the solved target, so its old answer must not
// silently remain in a newly exported decision note.
nodes.get('#targetGuestNights').value='7000';
nodes.get('#targetGuestNights').handlers.input();
nodes.get('#exportDecisionNote').handlers.click();
assert.ok(!(await exported.text()).includes('Capacity target check'));
nodes.get('#targetGuestNights').value='100000000';
nodes.get('#calculateTarget').handlers.click();
assert.ok(nodes.get('#targetResult').textContent.includes('not reached within 20'));
nodes.get('#exportDecisionNote').handlers.click();
assert.ok((await exported.text()).includes('Capacity target check\n'+nodes.get('#targetResult').textContent));
nodes.get('#inputError').hidden=false;exported=null;
nodes.get('#exportDecisionNote').handlers.click();assert.equal(exported,null);
console.log('PASS: actual JSON/CSV and decision-note export handlers preserve exact results and both alternatives; peer weights and solved targets included; edited targets clear stale answers; invalid plans block export.');
