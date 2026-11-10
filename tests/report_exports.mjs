import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import * as engine from '../prototype/engine.mjs';
import * as decisions from '../prototype/decision_tools.mjs';
import * as routes from '../prototype/route_planning.mjs';
import { CONVERSION_EVIDENCE } from '../prototype/conversion_evidence.mjs';
import { buildReportSlides, buildPowerPointReport, buildImagePdf, reportScenarioAttachment } from '../prototype/report_exports.mjs';

const data=JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json',import.meta.url)));
const locations=JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json',import.meta.url)));
const source=fs.readFileSync(new URL('../prototype/app.mjs',import.meta.url),'utf8').replace(/^\s*import[^;]+;/gm,'').replace(/\binit\(\);\s*$/,'');
const ctx=vm.createContext({inputData:data,inputLocations:locations,Blob,...engine,...decisions,...routes,CONVERSION_EVIDENCE,
  document:{querySelector(){return {checked:false};}}
});
vm.runInContext(source+'\ndata=inputData;countryLocationLookup=buildCountryLocationLookup(inputLocations);',ctx);

function unzipStored(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),entries=new Map();let offset=0;
  while(view.getUint32(offset,true)===0x04034b50){
    assert.equal(view.getUint16(offset+8,true),0);
    const size=view.getUint32(offset+18,true),length=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
    const name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+length));
    const start=offset+30+length+extra;
    entries.set(name,new TextDecoder().decode(bytes.slice(start,start+size)));offset=start+size;
  }
  assert.equal(view.getUint32(offset,true),0x02014b50);return entries;
}
let count=0;
for(const [origin,month,flights,proxy] of [['INDIA',12,3,''],['UNITED KINGDOM',1,-1,''],['GREECE',7,5,'__PEERS__'],['FRANCE',6,0,'']]){
  Object.assign(ctx,{origin,month,flights,proxy});
  const report=JSON.parse(JSON.stringify(vm.runInContext('state=defaultState(origin,month,proxy);state.extraFlights=flights;buildPlanReport(state,"","11 November 2026")',ctx)));
  for(const lang of ['en','ar']){
    const translate=lang==='ar'?vm.runInContext('(value)=>withLanguage("ar",()=>translateUiString(value))',ctx):value=>value;
    const slides=buildReportSlides(report,{lang,translate});assert.equal(slides.length,6);
    for(const slide of slides)for(const item of slide.items){
      assert.ok(item.x>=0&&item.y>=0&&item.w>=0&&item.h>=0);
      assert.ok(item.x+item.w<=1200.01,`${slide.title}: width overflow ${item.text}`);
      assert.ok(item.y+item.h<=675.01,`${slide.title}: height overflow ${item.text}`);
      if(item.kind==='text'){
        assert.ok(item.lines.length*item.size*1.2<=item.h+5,`${slide.title}: text box too short ${item.text}`);
        assert.ok(!/NaN|undefined|Infinity|GEMINI_API_KEY/.test(item.text));
      }
    }
    const text=slides.flatMap(s=>s.items.filter(i=>i.kind==='text').map(i=>i.text)).join('\n');
    assert.ok(text.includes(Math.round(report.result.scenario.guestNights).toLocaleString('en-US')));
    assert.ok(text.includes(Math.round(Math.abs(report.result.delta.hotelCheckins)).toLocaleString('en-US')));
    if(lang==='ar')assert.ok(/[\u0600-\u06ff]/.test(text));
    const blob=buildPowerPointReport(report,{lang,translate});
    assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const bytes=new Uint8Array(await blob.arrayBuffer()),entries=unzipStored(bytes);
    assert.equal([...entries.keys()].filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).length,6);
    assert.match(entries.get('ppt/presentation.xml'),/type="screen16x9"/);
    assert.match(entries.get('ppt/slides/slide1.xml'),/<a:t>/); // Editable text, not a flattened slide image.
    assert.ok(![...entries.keys()].some(name=>/^ppt\/media\//.test(name)));
    const xml=entries.get('ppt/slides/slide1.xml');assert.ok(xml.includes(Math.round(report.result.scenario.guestNights).toLocaleString('en-US')));
    const metadata=entries.get('customXml/item1.xml');assert.match(metadata,/urn:air2stay:scenario:v1/);
    assert.match(metadata,/scenario_assumptions/);
    assert.match(entries.get('ppt/_rels/presentation.xml.rels'),/customXml\/item1.xml/);
    const attachment=reportScenarioAttachment(report);
    assert.equal(attachment.inputs.originKey,report.result.route.originKey);
    assert.equal(attachment.inputs.month,month);
    assert.equal(attachment.inputs.extraFlights,flights);
    if(lang==='ar')assert.ok(xml.includes('rtl="1"'));
    const outputIndex=process.argv.indexOf('--output-dir');
    if(outputIndex>=0&&origin==='INDIA'){
      const folder=path.resolve(process.argv[outputIndex+1]);fs.mkdirSync(folder,{recursive:true});
      fs.writeFileSync(path.join(folder,`report-${lang}.pptx`),bytes);
      fs.writeFileSync(path.join(folder,`report-${lang}.json`),JSON.stringify(slides,null,2));
      fs.writeFileSync(path.join(folder,`scenario-${lang}.json`),JSON.stringify(attachment,null,2));
    }
    count++;
  }
}
const bad=vm.runInContext('buildPlanReport(defaultState("INDIA",12),"","")',ctx);
bad.result.scenario.guestNights=NaN;
assert.throws(()=>buildPowerPointReport(bad),/invalid result/);
assert.throws(()=>buildReportSlides({}),/incomplete/);
assert.throws(()=>buildImagePdf([]),/No report pages/);
const imported=vm.runInContext('buildPlanReport(defaultState("INDIA",12),"","")',ctx);
imported.notes.push('Imported scenario inputs: reviewed-flight-plan.csv; sheet December, row 2. Reviewed before application. Historical calibration is unchanged.');
const importedSlides=buildReportSlides(imported);
assert.equal(importedSlides.length,7);
assert.ok(importedSlides.at(-1).items.some(item=>item.text?.includes('reviewed-flight-plan.csv')));
assert.ok(importedSlides[0].items.some(item=>item.pageCounter&&item.text.endsWith('1/7')));
const safe=reportScenarioAttachment(imported);
imported.inputs={...safe.inputs,privateNote:'SECRET',apiKey:'NOT_FOR_EXPORT'};
assert.ok(!JSON.stringify(reportScenarioAttachment(imported)).includes('SECRET'));
assert.ok(!JSON.stringify(reportScenarioAttachment(imported)).includes('NOT_FOR_EXPORT'));
// Verify byte offsets, not only the header, so a malformed xref cannot pass.
const pdf=buildImagePdf([{bytes:Uint8Array.of(255,216,255,217),width:1,height:1}],safe);
const pdfBytes=new Uint8Array(await pdf.arrayBuffer()),pdfText=new TextDecoder().decode(pdfBytes);
assert.equal(pdf.type,'application/pdf');assert.match(pdfText,/\/Count 1/);
assert.match(pdfText,/\/EmbeddedFiles/);assert.match(pdfText,/air2stay-scenario\.json/);assert.match(pdfText,/scenario_assumptions/);
const xref=Number(pdfText.match(/startxref\n(\d+)/)[1]);assert.equal(new TextDecoder().decode(pdfBytes.slice(xref,xref+4)),'xref');
console.log(`PASS: ${count} English/Arabic report packages; editable slides, visible import provenance, allowlisted scenario attachments, bounded layouts, real results, PDF cross-reference offsets and invalid-input blocking.`);
