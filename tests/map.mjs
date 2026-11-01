import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const svg = fs.readFileSync(new URL('../prototype/data/admin0-countries.svg',import.meta.url),'utf8');
const source = fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8')
  .replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const map = {innerHTML:''};
const context = vm.createContext({locations,document:{querySelector(selector){return selector === '#routeMap' ? map : null;}}});
vm.runInContext(source+'\ncountryLocationLookup=buildCountryLocationLookup(locations); state={month:12}; applyOverlayScale=()=>{}; animateMapViewBox=()=>{};',context);
const close = (actual,expected,label) => assert.ok(Math.abs(actual-expected)<1e-7,label);

// Reconstruct the basemap's own rendered coordinates from its viewBox.
// The native paths were created for latitude75N..60S, rather than90N..90S.
const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const basemapPoint = (lon,lat) => [
  (((lon+180)/360*1000)-viewBox[0])/viewBox[2]*1000,
  (((75-lat)/135*500)-viewBox[1])/viewBox[3]*500,
];
for (const [lon,lat] of [[54.37,24.45],[103.81692,1.36659],[-97.4826,39.53848],[0,90],[0,-90]]) {
  context.lon=lon; context.lat=lat;
  const actual=vm.runInContext('projectMapPoint(lon,lat)',context);
  const underlying=basemapPoint(lon,lat);
  close(actual[0],underlying[0],'Map and overlay longitudes align');
  close(actual[1],underlying[1],'Map and overlay latitudes align');
}
// A long horizontal path border in the supplied geometry is49N (US/Canada).
assert.ok(svg.includes('158.78,96.30'));
close((96.30-viewBox[1])/viewBox[3]*500, (90-48.999)/180*500,'Known49N boundary aligns within source rounding');

for (const country of locations.countries) {
  context.result={route:{originKey:country.name.toUpperCase(),origin:country.name,knownMarket:false,proxyOriginKey:'INDIA'},scenario:{p2p:100}};
  vm.runInContext('lastRenderedRouteKey=null; renderRouteMap(result);',context);
  const origin=map.innerHTML.match(/class="origin-dot" cx="([^"]+)" cy="([^"]+)"/);
  const destination=map.innerHTML.match(/class="destination-dot" cx="([^"]+)" cy="([^"]+)"/);
  assert.ok(origin && destination,country.name+' renders both route endpoints');
  close(Number(origin[1]),(country.coordinates[0]+180)/360*1000,country.name+' longitude uses canonical record');
  close(Number(origin[2]),(90-country.coordinates[1])/180*500,country.name+' latitude uses canonical record');
  close(Number(destination[1]),(54.37+180)/360*1000,'Abu Dhabi longitude');
  close(Number(destination[2]),(90-24.45)/180*500,'Abu Dhabi uses the identical latitude projection');
  assert.ok(Number(origin[1])>=0 && Number(origin[1])<=1000 && Number(origin[2])>=0 && Number(origin[2])<=500,country.name+' endpoint lies inside the world');
  assert.ok(map.innerHTML.includes('not airport locations'));
}
context.result={route:{originKey:'NOT A COUNTRY',origin:'Not a country',knownMarket:false,proxyOriginKey:'INDIA'},scenario:{p2p:100}};
vm.runInContext('lastRenderedRouteKey=null; renderRouteMap(result);',context);
assert.ok(map.innerHTML.includes('No verified country location'));
assert.ok(!map.innerHTML.includes('origin-dot'),'An unavailable location must not borrow the comparison-country marker');
console.log(`PASS: all ${locations.countries.length} country endpoints use canonical locations; basemap and Abu Dhabi share one projection; polar endpoints fit; unavailable locations do not fake a comparison-country position.`);
