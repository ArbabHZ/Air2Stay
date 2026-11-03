import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {findRoute,getBridge,weeksInMonth,runScenario,validateScenarioInputs} from '../prototype/engine.mjs';
import {buildPeerProfile} from '../prototype/route_planning.mjs';
const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
const locations=JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const source=fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8').replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const nodes=new Map();
function node(selector){
 if(!nodes.has(selector)){
  let value='';const events={};
  nodes.set(selector,{id:selector.slice(1),get value(){return value},set value(next){value=String(next)},dataset:{},
   hidden:false,textContent:'',innerHTML:'',classList:{toggle(){},add(){},remove(){}},
   addEventListener(name,fn){events[name]=fn},events});
 }
 return nodes.get(selector);
}
const ids=['extraFlights','seatsPerFlight','loadFactor','p2pShare','conversionRate','averageStay','eventUplift'];
const ctx=vm.createContext({inputData:data,locations,findRoute,getBridge,weeksInMonth,runScenario,validateScenarioInputs,buildPeerProfile,
 document:{querySelector:node,querySelectorAll(selector){return selector==='#scenarioForm input, #scenarioForm select'?ids.map(id=>node('#'+id)):[];}}});
vm.runInContext(source+'\ndata=inputData;countryLocationLookup=buildCountryLocationLookup(locations);state=defaultState();setupControls();scheduleRender=()=>readForm();',ctx);
for(const route of data.routes){
 ctx.origin=route.originKey;ctx.month=route.month;
 vm.runInContext('state=defaultState(origin,month);setFormFromState();',ctx);
 const before=JSON.stringify(vm.runInContext('state',ctx));
 vm.runInContext('readForm();',ctx);
 const after=vm.runInContext('state',ctx);
 const parsed=JSON.parse(before);
 for(const id of ids)assert.ok(Math.abs(after[id]-parsed[id])<1e-13,id);
 assert.equal(after.seatsPerFlight,route.seatsPerFlight,'Stored aircraft average must not be rounded to its displayed integer');
 assert.equal(after.conversionRate,data.defaults.captureRate);
 const zero=runScenario(data,{...after,extraFlights:0});assert.equal(zero.delta.guestNights,0);
}
vm.runInContext('state=defaultState("INDIA",12);setFormFromState();',ctx);
const seats=node('#seatsPerFlight');assert.notEqual(Number(seats.dataset.exact),Number(seats.value));
// An explicit edit to the displayed integer must mean that integer, not the
// hidden fractional historical average. Other controls keep their exact values.
const originalLoad=vm.runInContext('state.loadFactor',ctx);
seats.events.input();
assert.equal(vm.runInContext('state.seatsPerFlight',ctx),Number(seats.value));
assert.equal(vm.runInContext('state.loadFactor',ctx),originalLoad);
console.log('PASS: 396 control round trips retain precision; zero changes stay zero; explicit edits own their displayed values without rounding untouched assumptions.');
