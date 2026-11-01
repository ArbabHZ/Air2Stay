import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planningChatReply } from '../prototype/planning_chat.mjs';
import { findRoute, getBridge, runScenario, validateScenarioInputs } from '../prototype/engine.mjs';
const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const route = findRoute(data, 'FRANCE', 12);
const current = {originKey:'FRANCE',month:12,extraFlights:5,seatsPerFlight:360,loadFactor:route.loadFactor,p2pShare:route.p2pShare,conversionRate:data.defaults.captureRate,averageStay:getBridge(data,'FRANCE',12).reduce((sum,row)=>sum+row.weight*row.averageStay,0),eventUplift:0,bridgeOverride:null};
const result = runScenario(data, current);
const before = JSON.stringify(current);
function reply(prompt, summary) { return planningChatReply(data,prompt,current,result,summary); }
const count = value => Math.round(value).toLocaleString('en-US');
const nights = reply('How did you calculate hotel nights?');
assert.equal(nights.type,'answer');
assert.ok(nights.text.includes(count(result.scenario.guestNights)));
assert.ok(nights.text.includes(count(result.scenario.hotelCheckins)));
assert.ok(nights.text.includes('multiplied by average nights'));
assert.ok(reply('What assumptions did we use?').text.includes('360 seats'));
assert.ok(reply('What should I do next?').text.includes('Check'));
const priority = reply('Who can help with the priority?',{recommended:{title:'Check December bookings',why:'No airline response yet',owner:'Airline planner'}});
assert.ok(priority.text.includes('No airline response yet'));
assert.ok(priority.text.includes('Airline planner'));
assert.ok(reply('How accurate is this estimate?').text.includes('not this individual route'));
assert.ok(reply('What does green mean?').text.includes('not forecast accuracy'));
assert.ok(reply('What should I check next?',{checks:[{status:'green'}]}).text.includes('All listed checks'));
assert.ok(reply('Why is demand red?',{checks:[{title:'Demand',status:'red',reason:'One overdue airline check'}]}).text.includes('One overdue airline check'));
for (const prompt of ['Is France better than India?', 'What happens if I reset?', 'Does France have 100 seats?', 'What if we use 5 flights?', 'Would changing to January help?', 'Can you compare France with India?', 'Tell me about France']) {
  const answer = reply(prompt);
  assert.notEqual(answer.type, 'reset', prompt);
  assert.ok(answer.type !== 'apply' || !answer.parsed.understood, prompt);
}
const commands = [
  ['Set flight occupancy to 80%', 'loadFactor',0.8],
  ['Set hotel use to 40%', 'conversionRate',0.4],
  ['Use 35% of visitors staying in hotels','conversionRate',0.35],
  ['Set average stay to 4 nights','averageStay',4],
  ['Set seats per flight to 320','seatsPerFlight',320],
  ['Set extra flights to 7','extraFlights',7],
  ['Make flights 85% full','loadFactor',0.85],
  ['Set passengers ending their trip in Abu Dhabi to 55%','p2pShare',0.55],
  ['Set event boost to 10%','eventUplift',0.1],
  ['Can you set flight occupancy to 70%?', 'loadFactor',0.7],
  ['Add 3 flights from India in May','originKey','INDIA'],
  ['And in February','month',2],
  ['Add 3 flights and reduce hotel use to 35%', 'extraFlights',3],
  ['Reduce hotel use to 35% and add 3 flights', 'extraFlights',3],
  ['Reduce extra flights to 5', 'extraFlights',5],
  ['Remove 3 flights', 'extraFlights',-3],
  ['Move to February','month',2],
];
for(const [prompt,key,value] of commands) {
  const answer=reply(prompt);
  assert.equal(answer.type,'apply',prompt+': '+answer.text);
  assert.equal(answer.parsed.understood,true,prompt);
  assert.equal(answer.parsed.changes[key],value,prompt);
}
const both = reply('Set hotel use to 40% and average stay to 4 nights');
assert.equal(both.parsed.changes.conversionRate,0.4);
assert.equal(both.parsed.changes.averageStay,4);
for (const prompt of ['Set hotel use to 140%', 'Set average stay to -2 nights', 'Set average stay to .5 nights', 'Set average stay to minus 2 nights', 'Set p2p to -5%', 'Set seats per flight to -100']) {
  const answer = reply(prompt);
  assert.equal(answer.type,'apply',prompt);
  assert.ok(validateScenarioInputs(answer.parsed.inputs),prompt);
}
for(const prompt of ['Add 3 or 4 flights from France','Set load factor to 80% but do not change to India','Add five flights from France','Set hotel occupancy to 60%','Add 3 flights from Atlantis','Increase occupancy by 5%','Add 3 more flights','Set hotel use to 40% and average stay to banana','Switch to Greece and add 3 flights','Switch to UK and France','Set average stay to 4 nights and make route business','Change to Greece and set hotel use to 40%','Add 3 flights to Greece','Add 2 flights from France in June and July']) {
  const answer=reply(prompt);
  assert.equal(answer.type,'answer',prompt);
  assert.ok(/not changed|nothing has changed/i.test(answer.text),prompt);
}
assert.equal(reply('Reset the plan').type,'reset');
assert.equal(reply('Clear chat').type,'apply');
assert.equal(reply('Clear chat').parsed.understood,false);
assert.equal(reply('How can I coordinate our work?').parsed?.understood,false);
assert.equal(JSON.stringify(current),before,'No reply may mutate the current plan');
console.log('PASS: local chat explains actual hotel nights, uses proposal priorities, interprets explicit commands, rejects partial/ambiguous changes, preserves invalid inputs for controller validation, and does not turn questions into changes.');
