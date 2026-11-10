import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as engine from '../prototype/engine.mjs';
import * as decisions from '../prototype/decision_tools.mjs';
import * as routePlanning from '../prototype/route_planning.mjs';
import { buildPowerPointReport, reportScenarioAttachment } from '../prototype/report_exports.mjs';
import { IMPORT_FIELDS, IMPORT_TEMPLATE, parseImportNumber, parseDelimited,
  importRowsToCandidates, importTextToCandidate, extractImportDocument, validateImportArchive, importedScenarioAttachment } from '../prototype/document_import.mjs';

const field = key => IMPORT_FIELDS.find(item => item.key === key);
const file = (name, text, size = Buffer.byteLength(text)) => ({ name, size, text: async () => text });

test('CSV reader handles UTF-8 BOM, quoted delimiters, escaped quotes, CRLF and quoted newlines', () => {
  assert.deepEqual(parseDelimited('\uFEFFCountry,Month,Note\r\nIndia,December,"One, two; \"\"quoted\"\"\nnext line"\r\n'), [
    ['Country', 'Month', 'Note'], ['India', 'December', 'One, two; "quoted"\nnext line'],
  ]);
  assert.deepEqual(parseDelimited('Country;Month;Extra flights per week\nFrance;January;3'), [['Country', 'Month', 'Extra flights per week'], ['France', 'January', '3']]);
  assert.deepEqual(parseDelimited('Country\tMonth\tSeats per flight\nFrance\tDecember\t220'), [['Country', 'Month', 'Seats per flight'], ['France', 'December', '220']]);
  assert.throws(() => parseDelimited('Country,Month\n"India,December'), /unfinished quoted/);
});

test('provided import template produces two valid scenarios with proportions in engine units', async () => {
  const result = await extractImportDocument(file('template.csv', IMPORT_TEMPLATE));
  assert.equal(result.candidates.length, 2);
  const india = result.candidates[0];
  assert.deepEqual(india.errors, []);
  assert.equal(india.values.originKey, 'India');
  assert.equal(india.values.month, 12);
  assert.equal(india.values.extraFlights, 3);
  assert.equal(india.values.seatsPerFlight, 196);
  assert.ok(Math.abs(india.values.loadFactor - .881) < 1e-12);
  assert.ok(Math.abs(india.values.p2pShare - .654) < 1e-12);
  assert.equal(india.values.conversionRate, .42);
  assert.equal(india.values.averageStay, 3.32);
  assert.equal(india.values.eventUplift, 0);
  assert.match(india.locations.loadFactor, /template.csv, row 2, column 5/);
});

test('fractions, explicit percentages and percentage-point headers yield the same proportion', () => {
  assert.equal(parseImportNumber(.85, field('loadFactor'), 'feature_flight_load_fraction'), .85);
  assert.equal(parseImportNumber('85%', field('loadFactor'), 'load factor'), .85);
  assert.equal(parseImportNumber('85', field('loadFactor'), 'Flight fullness (%)'), .85);
  assert.equal(parseImportNumber('.85', field('loadFactor'), 'loadFactor'), .85);
  assert.equal(parseImportNumber('8.5e-1', field('loadFactor'), 'loadFactor'), .85);
  assert.equal(parseImportNumber('0.5', field('eventUplift'), 'Event uplift (%)'), .005);
  assert.equal(parseImportNumber('−3', field('extraFlights')), -3);
  assert.equal(parseImportNumber('Dec', field('month')), 12);
});

test('labeled document text extracts only recognized assumptions and retains source locations', () => {
  const [candidate] = importTextToCandidate('Plan note\nDeparture country: Greece\nMonth = November\nExtra flights per week: 4\nFlight fullness (%): 85\nAverage hotel stay: 3.5\nUnrelated figure: 999', 'Deck, slide 3');
  assert.deepEqual(candidate.errors, []);
  assert.deepEqual(candidate.values, { originKey: 'Greece', month: 11, extraFlights: 4, loadFactor: .85, averageStay: 3.5 });
  assert.match(candidate.locations.averageStay, /Deck, slide 3/);
  assert.equal(importTextToCandidate('Nothing resembling a scenario')[0].values.constructor, Object);
});

test('exported model CSV headers import exact engine fractions and ignore result columns', () => {
  const candidates = importRowsToCandidates([
    ['meta_departure_country', 'feature_calendar_month', 'feature_weekly_flight_change', 'feature_flight_load_fraction', 'feature_passengers_ending_trip_fraction', 'feature_hotel_checkin_fraction', 'feature_nights_per_stay', 'feature_event_uplift_fraction', 'target_guest_nights'],
    ['India', '12', '3', '.881', '.654', '.419648', '3.32', '.1', '500000'],
  ]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].errors, []);
  assert.deepEqual(candidates[0].values, { originKey: 'India', month: 12, extraFlights: 3, loadFactor: .881, p2pShare: .654, conversionRate: .419648, averageStay: 3.32, eventUplift: .1 });
});

test('formulas, sentences, non-finite values, out-of-range and fractional flight counts are rejected', () => {
  for (const value of ['=SUM(3,4)', '=HYPERLINK("https://example.com")', '85 passengers', 'NaN', 'Infinity', '1e309', '0x55', true, {}, []]) {
    assert.throws(() => parseImportNumber(value, field('loadFactor')), Error, String(value));
  }
  for (const [key, value] of [['extraFlights', 3.5], ['extraFlights', 21], ['seatsPerFlight', 601], ['loadFactor', '101%'], ['p2pShare', '4%'], ['conversionRate', '91%'], ['averageStay', 11], ['eventUplift', '51%']]) {
    assert.throws(() => parseImportNumber(value, field(key)), Error, `${key}: ${value}`);
  }
  assert.equal(parseImportNumber(' ', field('loadFactor')), undefined);
});

test('ambiguous duplicate fields produce explicit errors instead of silently replacing values', () => {
  const [table] = importRowsToCandidates([['Country', 'Month', 'loadFactor', 'Flight fullness (%)'], ['India', '12', '.85', '90']]);
  assert.match(table.errors.join(' '), /Duplicate column/);
  assert.equal(table.values.loadFactor, .85);
  const [labeled] = importRowsToCandidates([['Country', 'India'], ['Month', 'December'], ['Month', 'November']]);
  assert.match(labeled.errors.join(' '), /More than one Month/);
});

test('JSON plan inputs preserve precision and formula strings remain invalid', async () => {
  const inputs = { originKey: 'INDIA', month: 12, extraFlights: 3, seatsPerFlight: 196.123, loadFactor: .88123456789, eventUplift: .1 };
  const result = await extractImportDocument(file('plan.json', JSON.stringify({ version: 1, inputs })));
  assert.deepEqual(result.candidates[0].values, inputs);
  assert.deepEqual(result.candidates[0].errors, []);
  const bad = await extractImportDocument(file('plan.json', JSON.stringify({ loadFactor: '=1/2' })));
  assert.equal(bad.candidates[0].values.loadFactor, undefined);
  assert.match(bad.candidates[0].errors[0], /not a formula/);
});

test('document and row limits reject oversized input before attempting parsing', async () => {
  let read = false;
  await assert.rejects(() => extractImportDocument({ name: 'large.csv', size: 21 * 1024 * 1024, text() { read = true; return ''; } }), /20 MB/);
  assert.equal(read, false);
  assert.throws(() => parseDelimited('Country,Month\n' + 'India,12\n'.repeat(2001)), /2,000 rows/);
  assert.throws(() => validateImportArchive(new ArrayBuffer(8)), /supported Office document/);
  await assert.rejects(() => extractImportDocument(file('macro.xlsm', '')), /Use CSV/);
});

test('exported Assumptions sheet imports Your plan value, not the historical starting value', () => {
  const [candidate] = importRowsToCandidates([
    ['Assumptions'], ['Starting values are the defaults for this route and month.'],
    ['Assumption', 'Starting value', 'Your plan value', 'Changed?', 'Note'],
    ['Extra flights per week', 0, 5, 'Yes'],
    ['Seats per flight', 196, 280, 'Yes'],
    ['Flight fullness', .881, .85, 'Yes'],
    ['Average hotel stay', 3.32, 4.1, 'Yes'],
  ], 'Air2Stay report, Assumptions');
  assert.deepEqual(candidate.errors, []);
  assert.equal(candidate.values.extraFlights, 5);
  assert.equal(candidate.values.seatsPerFlight, 280);
  assert.equal(candidate.values.loadFactor, .85);
  assert.equal(candidate.values.averageStay, 4.1);
});

test('month rejects booleans, arrays, scientific notation and hexadecimal strings', () => {
  for (const value of [true, [12], '1e1', '0xC', 12.5, 13, 0]) {
    assert.throws(() => parseImportNumber(value, field('month')), Error, JSON.stringify(value));
  }
});

test('the app-generated XLSX Assumptions sheet round-trips current plan inputs', async () => {
  const JSZip = createRequire(import.meta.url)('../prototype/vendor/jszip.min.js');
  const source = fs.readFileSync(new URL('../prototype/app.mjs', import.meta.url), 'utf8')
    .replace(/^\s*import[^;]+;/gm, '').replace(/\binit\(\);\s*$/, '');
  const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
  const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json', import.meta.url)));
  const ctx = vm.createContext({ ...engine, ...decisions, ...routePlanning, Blob, TextEncoder, dataInput: data, locationInput: locations,
    document: { querySelector() { return { checked: false, dataset: {} }; } } });
  const blob = vm.runInContext(source + '\ndata=dataInput;countryLocationLookup=buildCountryLocationLookup(locationInput);state=defaultState("INDIA",12);Object.assign(state,{extraFlights:5,seatsPerFlight:280,loadFactor:.85,averageStay:4.1,eventUplift:.15});buildPlanWorkbook(buildPlanReport(state,"Review","11 November 2026"),"en");', ctx);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const sheetId = workbook.match(/<sheet name="Assumptions" sheetId="(\d+)"/)[1];
  const xml = await zip.file(`xl/worksheets/sheet${sheetId}.xml`).async('string');
  // Decode only the app's own inline-string worksheet writer, not arbitrary Office XML.
  const unescape = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const rows = [...xml.matchAll(/<row\b[^>]*>([^]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b([^>]*)>([^]*?)<\/c>/g)].map(cell => {
    const number = cell[2].match(/<v>([^]*?)<\/v>/);
    return number ? Number(number[1]) : unescape(cell[2].match(/<t\b[^>]*>([^]*?)<\/t>/)?.[1] || '');
  }));
  const [candidate] = importRowsToCandidates(rows, 'actual exported workbook, Assumptions');
  assert.deepEqual(candidate.errors, []);
  for (const [key, value] of Object.entries({ extraFlights: 5, seatsPerFlight: 280, loadFactor: .85, averageStay: 4.1, eventUplift: .15 })) {
    assert.equal(candidate.values[key], value, key);
  }
});

test('embedded scenario metadata accepts supported numerical inputs and ignores every extraneous field', () => {
  const inputs = { originKey: 'INDIA', month: 12, extraFlights: 3, seatsPerFlight: 196.123456789,
    loadFactor: .88123456789, p2pShare: .6543210987, conversionRate: .4196481234, averageStay: 3.32123456789, eventUplift: .123456789 };
  const text = JSON.stringify({ version: 1, dataKind: 'scenario_assumptions', privateNote: 'OUTSIDE', inputs: {
    ...inputs, privateNote: 'PRIVATE', apiKey: 'SECRET', importedSource: { filename: 'untrusted' },
    bridgeOverride: [{ nationality: 'Untrusted', weight: 1 }], historicalCalibration: { captureRate: .99 },
  } });
  const [candidate] = importedScenarioAttachment(text, 'Report attachment');
  assert.deepEqual(candidate.errors, []);
  assert.deepEqual(candidate.values, inputs);
  assert.equal(candidate.source, 'Report attachment');
  assert.deepEqual(Object.keys(candidate.locations).sort(), Object.keys(inputs).sort());
  assert.ok(!JSON.stringify(candidate).includes('SECRET'));
  assert.ok(!JSON.stringify(candidate).includes('PRIVATE'));
  const [invalid] = importedScenarioAttachment(JSON.stringify({ version: 1, dataKind: 'scenario_assumptions', inputs: { ...inputs, loadFactor: '200%' } }), 'Invalid attachment');
  assert.equal(invalid.values.loadFactor, undefined);
  assert.match(invalid.errors.join(' '), /30–100/);
});

test('unsupported, malformed and oversized embedded metadata is rejected', () => {
  for (const content of [null, {}, { version: 2, dataKind: 'scenario_assumptions', inputs: {} },
    { version: 1, dataKind: 'observed_data', inputs: {} },
    ...[null, [], true, 12, 'hello'].map(inputs => ({ version: 1, dataKind: 'scenario_assumptions', inputs }))]) {
    assert.throws(() => importedScenarioAttachment(JSON.stringify(content), 'Invalid attachment'), /not supported/);
  }
  assert.throws(() => importedScenarioAttachment('{bad json', 'Invalid attachment'), SyntaxError);
  assert.throws(() => importedScenarioAttachment(' '.repeat(50001), 'Large attachment'), /too large/);
});

test('actual exported PowerPoint customXml restores exact report inputs, independent of rounded slide values', async () => {
  const JSZip = createRequire(import.meta.url)('../prototype/vendor/jszip.min.js');
  const source = fs.readFileSync(new URL('../prototype/app.mjs', import.meta.url), 'utf8')
    .replace(/^\s*import[^;]+;/gm, '').replace(/\binit\(\);\s*$/, '');
  const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
  const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json', import.meta.url)));
  const ctx = vm.createContext({ ...engine, ...decisions, ...routePlanning, Blob, dataInput: data, locationInput: locations,
    document: { querySelector() { return { checked: false, dataset: {} }; } } });
  const report = vm.runInContext(source + '\ndata=dataInput;countryLocationLookup=buildCountryLocationLookup(locationInput);state=defaultState("INDIA",12);Object.assign(state,{extraFlights:5,seatsPerFlight:280.123456789,loadFactor:.85123456789,averageStay:4.123456789,eventUplift:.123456789});buildPlanReport(state,"Review","11 November 2026");', ctx);
  const expected = JSON.parse(JSON.stringify(report.inputs));
  assert.equal(expected.loadFactor, .85123456789);
  assert.equal(expected.seatsPerFlight, 280.123456789);
  // Display values can be rounded; the attachment must use the explicit inputs.
  report.assumptions.forEach(row => { row.plan = Number(row.plan.toFixed(2)); });
  report.inputs.privateNote = 'MUST_NOT_LEAVE_THE_APP';
  assert.deepEqual(reportScenarioAttachment(report).inputs, expected);
  const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const lang of ['en', 'ar']) {
    const blob = buildPowerPointReport(report, { lang });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('customXml/item1.xml').async('string');
    assert.match(xml, /xmlns="urn:air2stay:scenario:v1"/);
    assert.ok(!xml.includes('MUST_NOT_LEAVE_THE_APP'));
    const payload = decode(xml.match(/<scenario\b[^>]*>([^]*?)<\/scenario>/)[1]);
    const [candidate] = importedScenarioAttachment(payload, `actual ${lang} presentation attachment`);
    assert.deepEqual(candidate.errors, []);
    assert.deepEqual(candidate.values, expected);
  }
});
