import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRoute, getBridge, weeksInMonth, runScenario, validateScenarioInputs, parseScenarioPrompt, appliedPlanConfirmation } from '../prototype/engine.mjs';
import { buildPeerProfile } from '../prototype/route_planning.mjs';

const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
const locations=JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const source=fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8').replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const nodes=new Map();
function field() { let value=''; return {get value(){return value;},set value(next){value=String(next);},dataset:{},hidden:false,textContent:''}; }
const context=vm.createContext({inputData:data,locations,findRoute,getBridge,weeksInMonth,runScenario,validateScenarioInputs,parseScenarioPrompt,appliedPlanConfirmation,buildPeerProfile,
  document:{querySelector(selector){if(!nodes.has(selector))nodes.set(selector,field());return nodes.get(selector);}}});
vm.runInContext(source+'\ndata=inputData; countryLocationLookup=buildCountryLocationLookup(locations); state=defaultState("FRANCE",12);',context);
function apply(prompt) { context.prompt=prompt;return vm.runInContext('applyAssistantPlan(parseScenarioPrompt(data,prompt,state))',context); }
for(const prompt of ['Add 7 flights from India in May','Load factor 77.3%','Hotel conversion 38.2%','Stay 4.27 nights','Event uplift 12.5%','244 seats']) {
  const confirmation=apply(prompt);
  const state=vm.runInContext('state',context);
  const parsed=parseScenarioPrompt(data,prompt,state);
  assert.equal(confirmation,appliedPlanConfirmation(data,state,parsed.changes));
  assert.equal(validateScenarioInputs(state),'');
  assert.equal(runScenario(data,state).route.month,state.month);
  if(parsed.changes.extraFlights !== undefined) assert.equal(Number(nodes.get('#extraFlights').value),state.extraFlights);
}
// Confirmations use read-back state, never an un-applied parser summary.
const state=vm.runInContext('state',context);
assert.ok(appliedPlanConfirmation(data,{...state,extraFlights:4},{extraFlights:99}).includes('4 extra flights'));
assert.ok(!appliedPlanConfirmation(data,{...state,extraFlights:4},{extraFlights:99}).includes('99'));
// Invalid requests must leave the previous valid state and results intact.
for(const prompt of ['Add 30 flights','Add 3.5 flights','1000 seats','244.5 seats','Load factor 110%','Load factor -5%','Hotel conversion 120%','Event uplift 80%','Event uplift 100%']) {
  const before=vm.runInContext('JSON.stringify(state)',context);
  assert.throws(()=>apply(prompt),undefined,prompt);
  assert.equal(vm.runInContext('JSON.stringify(state)',context),before,prompt);
}
vm.runInContext('state=defaultState("GREECE",12,"__PEERS__");',context);
assert.ok(apply('Add 5 flights in February').includes('Greece in February: 5 extra flights'));
assert.equal(vm.runInContext('state.peerProfile.month',context),2);
assert.ok(apply('Add 2 flights from France in May').includes('France in May: 2 extra flights'));
assert.equal(vm.runInContext('state.peerProfile',context),null);
console.log('PASS: assistant applies and reads back actual control values; invalid requests preserve state; route/month changes refresh assumptions before confirmation.');
