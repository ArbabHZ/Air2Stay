import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPeerProfile, validatePeerMethod } from '../prototype/route_planning.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json', import.meta.url)));
const original = JSON.stringify(data);
const close = (first, second, message) => assert.ok(Math.abs(first-second) < 1e-9, message);

let profiles = 0;
for (const country of locations.countries) {
  for (const month of [1,6,12]) {
    const profile = buildPeerProfile(data, locations, country.name, month);
    assert.equal(profile.available, true, country.name);
    assert.equal(profile.peers.length, 3);
    assert.equal(new Set(profile.peers.map((peer) => peer.originKey)).size, 3);
    close(profile.peers.reduce((sum, peer) => sum + peer.weight, 0),1,'Peer weights sum to 1');
    close(profile.bridge.reduce((sum, row) => sum + row.weight, 0),1,'Visitor shares sum to 1');
    close(profile.bridge.reduce((sum,row) => sum + row.weight*row.averageStay,0),profile.assumptions.averageStay,'Stay assumption reconciles to visitor bridge');
    assert.ok(profile.peers.every((peer) => peer.weight>0 && Number.isFinite(peer.distanceKm) && peer.origin.toLowerCase()!==country.name.toLowerCase()));
    assert.ok(profile.assumptions.seatsPerFlight >= 30 && profile.assumptions.seatsPerFlight <= 600);
    assert.ok(profile.assumptions.loadFactor >= .3 && profile.assumptions.loadFactor <= 1);
    assert.ok(profile.assumptions.p2pShare >= .05 && profile.assumptions.p2pShare <= 1);
    assert.ok(profile.assumptions.averageStay >= 1 && profile.assumptions.averageStay <= 10);
    assert.equal(profile.assumptions.conversionRate,data.defaults.captureRate);
    profiles++;
  }
}
assert.equal(JSON.stringify(data), original, 'Profiling never mutates supplied historical data');

const greece = buildPeerProfile(data, locations, 'Greece',12);
const asArray = buildPeerProfile(data, locations.countries, 'Greece',12);
const asLookup = buildPeerProfile(data, Object.fromEntries(locations.countries.map((country) => [country.name,country])), 'Greece',12);
assert.deepEqual(greece,asArray);
assert.deepEqual(greece,asLookup);
assert.notDeepEqual(buildPeerProfile(data,locations,'Singapore',12).assumptions,buildPeerProfile(data,locations,'Iran',12).assumptions);
assert.notEqual(buildPeerProfile(data,locations,'Finland',12).approximateRouteKm,buildPeerProfile(data,locations,'Aland',12).approximateRouteKm);
assert.equal(buildPeerProfile(data,locations,'not a country',12).available,false);
assert.equal(buildPeerProfile({...data,routes:[]},locations,'Greece',12).available,false);
assert.throws(()=>buildPeerProfile(data,locations,'Greece',13),RangeError);

// Holding a market out must exclude every part of that market's own records.
const heldOut = buildPeerProfile(data,locations,'Armenia',12);
const corrupted = structuredClone(data);
for (const route of corrupted.routes.filter((row) => row.originKey==='ARMENIA')) {
  route.seatsPerFlight=600; route.loadFactor=.3; route.p2pShare=.05;
}
corrupted.bridge.ARMENIA={12:[{nationality:'Synthetic excluded record',weight:1,averageStay:10}]};
assert.deepEqual(buildPeerProfile(corrupted,locations,'Armenia',12),heldOut,'Excluded market cannot leak into its estimated assumptions or visitor bridge');

const validation = validatePeerMethod(data,locations);
assert.equal(validation.caseCount,396);
assert.equal(validation.marketCount,33);
assert.ok(validation.rows.every((row)=>!row.peerKeys.includes(row.originKey)));
for (const [field, scale] of [['seatsPerFlight',1],['loadFactor',100],['p2pShare',100]]) {
  for (const method of ['blended','nearest']) {
    const independent = validation.rows.reduce((sum,row)=>sum+Math.abs(row[method][field]-row.actual[field]),0)/validation.rows.length*scale;
    close(independent,validation.metrics[field][method+'Mae'],'Reported mean error reproduces from available records');
  }
}
assert.ok(validation.limitations.some((line)=>line.includes('does not validate new-route demand')));
assert.equal(validatePeerMethod({...data,routes:[]},locations).metrics.loadFactor.blendedMae,null);
console.log(`PASS: ${profiles} supported country/month profiles; target-market exclusion; normalized peer/visitor weights; untouched source data; 396 reproducible flight-assumption checks with explicit hotel-demand limits.`);
