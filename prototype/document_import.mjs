// Local, deterministic document extraction. No document text is executed or sent to an AI service.
export const IMPORT_FIELDS = [
  {key:'originKey', label:'Departure country', aliases:['country','origin','departure country','originKey','meta_departure_country']},
  {key:'month', label:'Month', aliases:['month','calendar month','feature_calendar_month']},
  {key:'extraFlights', label:'Extra flights per week', min:-20,max:20, aliases:['extraFlights','extra flights per week','weekly flight change','feature_weekly_flight_change']},
  {key:'seatsPerFlight', label:'Seats per flight', min:30,max:600, aliases:['seatsPerFlight','seats per flight','seats on each flight','feature_seats_per_flight']},
  {key:'loadFactor', label:'Flight fullness (%)', percent:true,min:30,max:100, aliases:['loadFactor','load factor','flight fullness','flight fullness %','how full flights are','feature_flight_load_fraction']},
  {key:'p2pShare', label:'Passengers ending their trip here (%)', percent:true,min:5,max:100, aliases:['p2pShare','p2p share','passengers ending their trip here','passengers ending their trip fraction','feature_passengers_ending_trip_fraction']},
  {key:'conversionRate', label:'Share checking into a hotel (%)', percent:true,min:5,max:90, aliases:['conversionRate','hotel conversion','hotel capture rate','share checking into a hotel','feature_hotel_checkin_fraction']},
  {key:'averageStay', label:'Average hotel stay (nights)', min:1,max:10, aliases:['averageStay','average stay','average hotel stay','nights per stay','feature_nights_per_stay']},
  {key:'eventUplift', label:'Event uplift (%)', percent:true,min:0,max:50, aliases:['eventUplift','event uplift','event impact','feature_event_uplift_fraction']},
];
const importNormalize = value => String(value ?? '').trim().toLowerCase().replace(/[()%_\s-]+/g,'');
const importField = value => IMPORT_FIELDS.find(f => [f.label,...f.aliases].some(a=>importNormalize(a)===importNormalize(value)));
const importMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export function parseImportNumber(value, field, header='') {
  if(value!==null && value!==undefined && !['string','number'].includes(typeof value))throw new Error(`${field.label}: use a text or numeric cell value.`);
  if (value === null || value === undefined || String(value).trim()==='') return undefined;
  if (field.key==='originKey') return String(value).trim();
  if (field.key==='month') {
    if(typeof value==='boolean'||! /^(?:\d{1,2}|[A-Za-z]+)$/.test(String(value).trim()))throw new Error('Month must be 1–12 or a month name.');
    const found=importMonths.findIndex(m=>m.toLowerCase()===String(value).trim().toLowerCase() || m.slice(0,3).toLowerCase()===String(value).trim().toLowerCase());
    const n=found>=0?found+1:Number(value);
    if (!Number.isInteger(n)||n<1||n>12) throw new Error('Month must be 1–12 or a month name.');
    return n;
  }
  const text=String(value).trim().replace(/−/g,'-');
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*%?$/.test(text) && !/^[+-]?\.\d+(?:[eE][+-]?\d+)?\s*%?$/.test(text)) throw new Error(`${field.label}: use a number, not a formula or sentence.`);
  let n=Number(text.replace(/[,%\s]/g,''));
  if (field.percent) {
    const percentage = /%/.test(text+header) || /percent/i.test(header);
    const fraction = /fraction/i.test(header) || (!percentage && n>=0 && n<=1);
    if (!fraction) n/=100;
  }
  const shown=n*(field.percent?100:1);
  if (!Number.isFinite(n) || shown<field.min || shown>field.max || (field.key==='extraFlights' && !Number.isInteger(n))) throw new Error(`${field.label}: use ${field.min}–${field.max}${field.key==='extraFlights'?' whole flights':''}.`);
  return n;
}

export function parseDelimited(text) {
  text=String(text).replace(/^\uFEFF/,'');
  const first=text.split(/\r?\n/)[0] || '';
  const delimiter=first.includes('\t')?'\t':((first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',');
  const rows=[]; let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') { if(quoted && text[i+1]==='"') {value+='"';i++;} else quoted=!quoted; }
    else if(c===delimiter&&!quoted) {row.push(value);value='';}
    else if((c==='\n'||c==='\r')&&!quoted) {if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.trim()))rows.push(row);row=[];value='';}
    else value+=c;
  }
  if(quoted)throw new Error('The CSV contains an unfinished quoted value.');
  row.push(value);if(row.some(x=>x.trim()))rows.push(row);
  if(rows.length>2001)throw new Error('Import up to 2,000 rows at a time.');
  return rows;
}

export function importRowsToCandidates(rows, source='Document') {
  const candidates=[];
  // A normal table has a row containing recognised field names.
  const headerIndex=rows.findIndex(row=>row.filter(cell=>importField(cell)).length>=2 && !row.slice(1).some(cell=>/^[\d.+-]/.test(String(cell))));
  if(headerIndex>=0) {
    const headers=rows[headerIndex];
    for(let i=headerIndex+1;i<rows.length;i++) {
      const values={},errors=[],locations={};
      headers.forEach((h,j)=>{const f=importField(h);if(!f||String(rows[i][j]??'').trim()==='')return;try{if(f.key in values)throw new Error(`Duplicate column for ${f.label}.`);values[f.key]=parseImportNumber(rows[i][j],f,String(h));locations[f.key]=`${source}, row ${i+1}, column ${j+1}`;}catch(e){errors.push(e.message);}});
      if(Object.keys(values).length||errors.length)candidates.push({values,errors,locations,source:`${source}, row ${i+1}`});
    }
  } else {
    // Labeled values are also supported (for example an exported Assumptions sheet).
    const values={},errors=[],locations={};
    // Air2Stay's own report puts the current plan beside the starting value.
    const planHeader=rows.find(row=>row.some(v=>/^your plan(?: value)?$/i.test(String(v).trim())));
    const valueColumn=planHeader?planHeader.findIndex(v=>/^your plan(?: value)?$/i.test(String(v).trim())):1;
    rows.forEach((row,i)=>{const f=importField(row[0]);if(!f)return;const cell=row[valueColumn];if(String(cell??'').trim()==='')return;try{if(f.key in values)throw new Error(`More than one ${f.label} found. Select a single scenario.`);values[f.key]=parseImportNumber(cell,f,String(row[0]));locations[f.key]=`${source}, row ${i+1}, column ${valueColumn+1}`;}catch(e){errors.push(e.message);}});
    if(Object.keys(values).length||errors.length)candidates.push({values,errors,locations,source});
  }
  return candidates.slice(0,2000);
}

export function importTextToCandidate(text, source='Document text') {
  const rows=[];
  for(const line of String(text).split(/\r?\n/)) {
    const match=line.trim().match(/^(.{2,85}?)\s*[:=]\s*(.+)$/);
    if(match&&importField(match[1]))rows.push([match[1],match[2]]);
  }
  const candidates=importRowsToCandidates(rows,source);
  return candidates.length?candidates:[{values:{},errors:[],locations:{},source}];
}

export function validateImportArchive(buffer) {
  const view=new DataView(buffer);let end=-1;
  for(let i=view.byteLength-22;i>=Math.max(0,view.byteLength-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
  if(end<0)throw new Error('This is not a supported Office document. Use .xlsx or .pptx, not .xls or .ppt.');
  const count=view.getUint16(end+10,true);let cursor=view.getUint32(end+16,true),total=0;
  if(count>3000||count===65535)throw new Error('This document contains too many entries. Export a smaller copy.');
  for(let i=0;i<count;i++) {
    if(cursor+46>view.byteLength||view.getUint32(cursor,true)!==0x02014b50)throw new Error('The document archive is damaged.');
    if(view.getUint16(cursor+8,true)&1)throw new Error('Password-protected documents are not supported.');
    total+=view.getUint32(cursor+24,true);
    if(total>50*1024*1024)throw new Error('The expanded document exceeds 50 MB. Export a smaller copy.');
    cursor+=46+view.getUint16(cursor+28,true)+view.getUint16(cursor+30,true)+view.getUint16(cursor+32,true);
  }
  return total;
}

function importXml(text) {
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('Unsupported XML declarations in the document.');
  const xml=new DOMParser().parseFromString(text,'application/xml');
  if(xml.getElementsByTagName('parsererror').length)throw new Error('The document contains damaged XML.');
  return xml;
}
const importNodes=(xml,local)=>[...xml.getElementsByTagNameNS('*',local)];
const importTexts=xml=>importNodes(xml,'t').map(n=>n.textContent).join('');

export function importedScenarioAttachment(text,source) {
  if(text.length>50000)throw new Error('The embedded scenario is too large.');
  const content=JSON.parse(text);
  if(content?.version!==1||content?.dataKind!=='scenario_assumptions'||!content.inputs||typeof content.inputs!=='object'||Array.isArray(content.inputs))throw new Error('The embedded scenario format is not supported.');
  return importRowsToCandidates(Object.entries(content.inputs),source);
}

export async function extractImportDocument(file) {
  if(!file || file.size>IMPORT_MAX_BYTES)throw new Error('Choose a file no larger than 20 MB.');
  const extension=file.name.split('.').pop().toLowerCase();
  const title=file.name;
  if(['csv','tsv','txt'].includes(extension)) {
    const text=await file.text();
    const candidates=extension==='txt'?importTextToCandidate(text,title):importRowsToCandidates(parseDelimited(text),title);
    return {title,text:text.slice(0,60000),candidates,warnings:[]};
  }
  if(extension==='json') {
    const content=JSON.parse(await file.text());
    const objects=Array.isArray(content)?content:[content.inputs||content];
    if(objects.length>2000)throw new Error('Import up to 2,000 scenarios at a time.');
    const candidates=objects.flatMap((obj,i)=>importRowsToCandidates(Object.entries(obj),`${title}, record ${i+1}`));
    return {title,text:JSON.stringify(content,null,2).slice(0,60000),candidates,warnings:[]};
  }
  if(extension==='pdf') {
    const asset=globalThis.__AIR2STAY_IMPORT_ASSETS__ || {};
    const pdf=await import(asset.pdf || new URL('./vendor/pdf.min.mjs',document.baseURI).href);
    pdf.GlobalWorkerOptions.workerSrc=asset.worker || new URL('./vendor/pdf.worker.min.mjs',document.baseURI).href;
    const task=pdf.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true,disableFontFace:true});
    let doc;
    try {
      doc=await task.promise;
      if(doc.numPages>40)throw new Error('Import a PDF of up to 40 pages.');
      const attachments=await doc.getAttachments();
      const embedded=Object.values(attachments||{}).find(a=>a.filename==='air2stay-scenario.json');
      if(embedded) {
        const text=new TextDecoder().decode(embedded.content);
        return {title,text,candidates:importedScenarioAttachment(text,`${title}, embedded scenario inputs`),warnings:['This Air2Stay PDF contains the original numerical scenario inputs. Review them before applying. Nationality edits and historical calibration are not imported.']};
      }
      const pages=[];
      for(let p=1;p<=doc.numPages;p++) {
        const page=await doc.getPage(p),content=await page.getTextContent();
        const lines=[];let y=null,line=[];
        for(const item of content.items) {if(!('str'in item))continue;const nextY=item.transform?.[5];if(y!==null&&Math.abs(nextY-y)>3){lines.push(line.join(' '));line=[];}line.push(item.str);y=nextY;if(item.hasEOL){lines.push(line.join(' '));line=[];y=null;}}
        if(line.length)lines.push(line.join(' '));
        pages.push({text:lines.join('\n'),source:`${title}, page ${p}`});page.cleanup();
      }
      const text=pages.map((p,i)=>`Page ${i+1}\n${p.text}`).join('\n\n');
      if(!text.replace(/Page \d+/g,'').trim())throw new Error('No selectable text was found. Scanned PDFs need OCR first; use the CSV template or enter verified values manually.');
      return {title,text:text.slice(0,60000),candidates:pages.flatMap(p=>importTextToCandidate(p.text,p.source)),warnings:['Only selectable PDF text is read. Review extracted numbers; pictures and scanned tables are not interpreted.']};
    } finally { if(doc)await doc.destroy();else await task.destroy(); }
  }
  if(!['xlsx','pptx'].includes(extension))throw new Error('Use CSV, XLSX, JSON, a text-based PDF, or PPTX.');
  const buffer=await file.arrayBuffer();validateImportArchive(buffer);
  if(!globalThis.JSZip)throw new Error('The local Office document reader is missing. Refresh the app and try again.');
  const zip=await globalThis.JSZip.loadAsync(buffer);
  const get=async name=>{const entry=zip.file(name);return entry?await entry.async('string'):null;};
  const candidates=[],sections=[],warnings=[];
  if(extension==='pptx') {
    const metadata=await get('customXml/item1.xml');
    if(metadata) {
      const xml=importXml(metadata),root=xml.documentElement;
      if(root.localName==='scenario'&&root.namespaceURI==='urn:air2stay:scenario:v1')return {title,text:root.textContent,candidates:importedScenarioAttachment(root.textContent,`${title}, embedded scenario inputs`),warnings:['This Air2Stay presentation contains its exported numerical scenario inputs. Edits made to slide text after export do not update these stored inputs; check the figures before applying.']};
    }
    const slides=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
    if(!slides.length||slides.length>100)throw new Error('Use a PowerPoint presentation containing 1–100 slides.');
    for(const [index,name]of slides.entries()) {
      const xml=importXml(await get(name));
      const text=importNodes(xml,'p').map(importTexts).filter(Boolean).join('\n');
      const source=`${title}, slide ${index+1}`;
      sections.push(`${source}\n${text}`);candidates.push(...importTextToCandidate(text,source));
      for(const table of importNodes(xml,'tbl')) {
        const rows=importNodes(table,'tr').map(row=>importNodes(row,'tc').map(importTexts));
        candidates.push(...importRowsToCandidates(rows,`${source}, table`));
      }
    }
    warnings.push('Text boxes and tables are read; screenshots and chart images are not converted into data.');
  } else {
    const stringsText=await get('xl/sharedStrings.xml');
    const strings=stringsText?importNodes(importXml(stringsText),'si').map(importTexts):[];
    const workbookText=await get('xl/workbook.xml'),relationsText=await get('xl/_rels/workbook.xml.rels');
    if(!workbookText||!relationsText)throw new Error('This workbook is missing its worksheet index.');
    const relations=new Map(importNodes(importXml(relationsText),'Relationship').filter(n=>n.getAttribute('TargetMode')!=='External').map(n=>[n.getAttribute('Id'),n.getAttribute('Target')]));
    const sheets=importNodes(importXml(workbookText),'sheet');
    if(sheets.length>50)throw new Error('Use a workbook with up to 50 worksheets.');
    for(const sheet of sheets) {
      const target=relations.get(sheet.getAttribute('r:id'));if(!target)continue;
      const path=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
      const xmlText=await get(path);if(!xmlText)continue;
      const xml=importXml(xmlText),rows=[];
      for(const row of importNodes(xml,'row')) {
        if(rows.length>2000)throw new Error('A worksheet exceeds 2,000 rows. Filter to the scenarios you need.');
        const values=[];
        for(const cell of importNodes(row,'c')) {
          const ref=cell.getAttribute('r')||'',letters=ref.match(/^[A-Z]+/)?.[0];let column=0;
          for(const l of letters||'A')column=column*26+l.charCodeAt(0)-64;
          if(column>100)continue;
          const kind=cell.getAttribute('t'),raw=importNodes(cell,'v')[0]?.textContent;
          if(importNodes(cell,'f').length&&!raw)warnings.push(`Formula without a saved result in ${sheet.getAttribute('name')} ${ref}; recalculate and save in Excel first.`);
          values[column-1]=kind==='s'?(strings[Number(raw)]??''):kind==='inlineStr'?importTexts(cell):raw??'';
        }
        rows.push(Array.from(values,v=>v??''));
      }
      const source=`${title}, sheet ${sheet.getAttribute('name')}`;
      sections.push(`${source}\n${rows.map(r=>r.join('\t')).join('\n')}`);
      candidates.push(...importRowsToCandidates(rows,source));
    }
    warnings.push('Saved cell values are read. Formulas, macros and links are never executed.');
  }
  return {title,text:sections.join('\n\n').slice(0,60000),candidates:candidates.slice(0,2000),warnings:[...new Set(warnings)]};
}

export const IMPORT_TEMPLATE = 'Departure country,Month,Extra flights per week,Seats per flight,Flight fullness (%),Passengers ending their trip here (%),Share checking into a hotel (%),Average hotel stay (nights),Event uplift (%)\r\nIndia,December,3,196,88.1,65.4,42,3.32,0\r\nFrance,January,5,280,85,35,42,3.8,0\r\n';
