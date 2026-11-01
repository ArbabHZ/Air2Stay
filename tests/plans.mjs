import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRoute, getBridge, weeksInMonth, runScenario, validateScenarioInputs, parseScenarioPrompt } from '../prototype/engine.mjs';
import { buildPeerProfile } from '../prototype/route_planning.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json', import.meta.url)));
const source = fs.readFileSync(new URL('../prototype/app.mjs', import.meta.url), 'utf8')
  .replace(/^\s*import[^;]+;/gm, '').replace(/\binit\(\);\s*$/, '');
const context = vm.createContext({ inputData: data, locations, findRoute, getBridge, weeksInMonth, runScenario, validateScenarioInputs, buildPeerProfile, parseScenarioPrompt });
vm.runInContext(source + '\ndata = inputData; countryLocationLookup = buildCountryLocationLookup(locations);', context);
let count = 0;
for (const route of data.routes) {
  context.origin = route.originKey; context.month = route.month;
  const saved = vm.runInContext('state = defaultState(origin,month); planSnapshot();', context);
  context.snapshot = JSON.parse(JSON.stringify(saved));
  const restored = vm.runInContext('validatedPlan(snapshot)', context);
  assert.deepEqual(runScenario(data,restored.inputs),runScenario(data,saved.inputs));
  count++;
}
const newPlan = vm.runInContext('state=defaultState("GREECE",12,"ITALY"); planSnapshot();',context);
const peerPlan = vm.runInContext('bridgeOverride=null; state=defaultState("GREECE",12,"__PEERS__"); planSnapshot();',context);
context.snapshot=JSON.parse(JSON.stringify(peerPlan));
const peerRestore=vm.runInContext('validatedPlan(snapshot)',context);
assert.deepEqual(JSON.parse(JSON.stringify(runScenario(data,peerRestore.inputs))),JSON.parse(JSON.stringify(runScenario(data,peerPlan.inputs))));
vm.runInContext('state=defaultState("GREECE",12,"__PEERS__"); state=resolveChatPlan(parseScenarioPrompt(data,"January with 5 flights",state),state);',context);
const january=vm.runInContext('runScenario(data,state)',context);
assert.equal(january.route.month,1);assert.equal(january.route.peerProfile.month,1);
assert.equal(vm.runInContext('state.extraFlights',context),5);
vm.runInContext('state=resolveChatPlan(parseScenarioPrompt(data,"France in December",state),state);',context);
assert.equal(vm.runInContext('state.peerProfile',context),null);
assert.equal(vm.runInContext('state.routePurpose',context),'mixed');
assert.equal(vm.runInContext('runScenario(data,state).route.knownMarket',context),true);
const mixedPlan = vm.runInContext('state=defaultState("FRANCE",12); bridgeOverride=getBridge(data,"FRANCE",12).map((row,index)=>({...row,weight:index===0 ? 0.8 : row.weight})); planSnapshot();',context);
context.snapshot=JSON.parse(JSON.stringify(mixedPlan));
const mixedRestore=vm.runInContext('validatedPlan(snapshot)',context);
assert.deepEqual(JSON.parse(JSON.stringify(runScenario(data,mixedRestore.inputs))),JSON.parse(JSON.stringify(runScenario(data,mixedPlan.inputs))));
context.snapshot = newPlan;
assert.equal(vm.runInContext('validatedPlan(snapshot).inputs.proxyOriginKey',context),'ITALY');
for (const [key,value] of [['month',0],['month',13],['month',1.5],['loadFactor',-1],['averageStay',100],['originKey','not a country'],['proxyOriginKey','not a country']]) {
  context.snapshot = JSON.parse(JSON.stringify(newPlan)); context.snapshot.inputs[key]=value;
  assert.throws(() => vm.runInContext('validatedPlan(snapshot)',context));
}
context.snapshot = JSON.parse(JSON.stringify(newPlan)); context.snapshot.version=99;
assert.throws(() => vm.runInContext('validatedPlan(snapshot)',context));
context.snapshot = JSON.parse(JSON.stringify(newPlan)); context.snapshot.inputs.bridgeOverride=[];
assert.throws(() => vm.runInContext('validatedPlan(snapshot)',context));
console.log(`PASS: ${count} plan round trips preserve results; new routes restore; 9 invalid shared plans rejected.`);
