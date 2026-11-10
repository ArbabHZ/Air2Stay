/* Offline report exports. No network, application state, or third-party code.
 * PowerPoint uses editable DrawingML shapes/text. PDF renders the same layout
 * at 180 dpi with browser text shaping, including Arabic, then embeds the pages.
 */
const WIDTH = 1200, HEIGHT = 675, EMU = 10160;
const C = { ink: '172238', muted: '49576A', navy: '172238', paper: 'FFFFFF', pale: 'F1F5F9', border: 'CBD5E1', teal: '087F83', tealPale: 'E7F5F3', rose: 'A6324E', gold: 'B2760B' };
const AR = {
  'Your flight plan, explained': 'خطة رحلاتك بالأرقام', 'From seats to guest nights': 'من المقاعد إلى الليالي الفندقية',
  'Assumptions behind this plan': 'الافتراضات التي تقوم عليها الخطة', 'Extra guest nights by month': 'التغير في الليالي الفندقية حسب الشهر',
  'Estimated visitor mix': 'التوزيع التقديري للزوار', 'Evidence and next steps': 'الأدلة والخطوات التالية',
  'Plan report': 'تقرير الخطة', 'Scenario estimates': 'تقديرات السيناريو', 'Extra hotel check-ins': 'التغير في التسجيلات الفندقية',
  'Extra guest nights': 'التغير في الليالي الفندقية', 'Total guest nights': 'إجمالي الليالي الفندقية',
  'Possible range': 'النطاق المحتمل', 'Baseline': 'خط الأساس', 'Plan': 'الخطة', 'Change': 'التغير',
  'Assumption': 'الافتراض', 'Starting value': 'القيمة الأصلية', 'Your plan': 'خطتك', 'Changed': 'تم التغيير',
  'Yes': 'نعم', 'No': 'لا', 'nights': 'ليلة', 'Nationality': 'الجنسية', 'Share': 'النسبة', 'Plan guest nights': 'ليالي الخطة الفندقية',
  'Source and assumptions': 'المصدر والافتراضات', 'What to check before acting': 'ما الذي يجب التحقق منه قبل التنفيذ',
  'Confirm expected flight bookings and hotel capacity with the responsible teams.': 'تحقق من الحجوزات المتوقعة للرحلات والطاقة الاستيعابية للفنادق مع الفرق المسؤولة.',
  'Guest nights count people staying overnight, not hotel rooms.': 'الليالي الفندقية تحسب ليالي إقامة الأشخاص، ولا تحسب عدد الغرف.',
  'The baseline uses flight history and hotel assumptions. It is not an observed route-level hotel total.': 'يستخدم خط الأساس سجلات الرحلات وافتراضات الإقامة الفندقية، ولا يمثل إجماليات فندقية مسجلة لكل مسار.',
  'No route history: the baseline is zero. Comparison countries supply starting assumptions only.': 'لا توجد سجلات لهذا المسار: خط الأساس صفر، وتوفر بلدان المقارنة افتراضات أولية فقط.',
  'Same selected plan inputs across the year; each month keeps its own starting flight supply.': 'تُستخدم المدخلات المختارة نفسها عبر السنة، مع الاحتفاظ بمعروض الرحلات الأصلي لكل شهر.',
  'Nationality shares are estimated allocations, not measured passenger nationalities.': 'نسب الجنسيات توزيع تقديري، وليست جنسيات مسجلة لركاب الرحلات.',
  'Top eight groups are shown. Other groups remain included in the total.': 'تُعرض أكبر ثماني مجموعات. وتظل المجموعات الأخرى مشمولة في الإجمالي.',
  'History-based guide, not a guaranteed probability interval.': 'دليل يستند إلى السجلات السابقة، وليس نطاق احتمالات مضمونًا.',
  'Flight seats': 'مقاعد الرحلات', 'Passengers': 'الركاب', 'Passengers ending their trip in Abu Dhabi': 'الركاب الذين تنتهي رحلتهم في أبوظبي',
  'Hotel check-ins': 'التسجيلات الفندقية', 'Guest nights': 'الليالي الفندقية',
  'Extra flights per week': 'الرحلات الإضافية أسبوعيًا', 'Seats per flight': 'المقاعد لكل رحلة', 'Flight fullness': 'نسبة امتلاء الرحلات',
  'Passengers ending their trip here': 'نسبة الركاب الذين تنتهي رحلتهم هنا', 'Share checking into a hotel': 'نسبة الإقامة في فندق',
  'Average hotel stay': 'متوسط مدة الإقامة', 'Event impact': 'أثر الفعالية',
  'Document input trail': 'مصدر مدخلات المستند',
  'Reviewed scenario inputs': 'مدخلات السيناريو المراجعة',
  'These inputs can be imported back into Air2Stay for review. Historical calibration is unchanged.': 'يمكن إعادة استيراد هذه المدخلات إلى Air2Stay لمراجعتها. تظل المعايرة التاريخية دون تغيير.',
};
const esc = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[ch]));
const num = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
const signed = value => Math.abs(value) < 0.5 ? '0' : `${value > 0 ? '+' : '−'}${num(Math.abs(value))}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validateReport(report) {
  if (!report || !report.result || !Array.isArray(report.steps) || !Array.isArray(report.annual) || !Array.isArray(report.assumptions) || !Array.isArray(report.visitors)) throw new Error('The report is incomplete. Recalculate the plan and try again.');
  for (const key of ['baseline', 'scenario', 'delta']) for (const field of ['hotelCheckins', 'guestNights']) {
    if (!finite(report.result[key]?.[field])) throw new Error('The report contains an invalid result.');
  }
  for (const row of [...report.steps, ...report.annual, ...report.visitors]) {
    if (!['usual', 'plan', 'change'].every(key => finite(row[key]))) throw new Error('The report contains an invalid chart value.');
  }
  for (const row of report.assumptions) if (!finite(row.usual) || !finite(row.plan)) throw new Error('The report contains an invalid assumption.');
  for (const row of report.visitors) if (!finite(row.share) || row.share < 0 || row.share > 1) throw new Error('The report contains an invalid visitor share.');
  if (report.annual.length !== 12 || report.steps.length !== 5) throw new Error('The report is missing monthly or calculation records.');
}

// Conservative wrapping shared by editable PowerPoint and the PDF canvas.
// Arabic is drawn as complete lines so the browser performs joining and bidi.
function wrap(text, width, size) {
  const limit = Math.max(8, width / (size * 0.56));
  return String(text).split('\n').flatMap(paragraph => {
    const words = paragraph.split(/\s+/); const lines = []; let line = '';
    for (const word of words) {
      if (line && `${line} ${word}`.length > limit) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line); return lines;
  });
}

/** The same scene data drives the two file formats. Values remain auditable. */
export function buildReportSlides(report, { lang = 'en', translate = value => value } = {}) {
  validateReport(report);
  const rtl = lang === 'ar';
  const t = value => rtl ? (AR[value] || String(translate(String(value)))) : String(value ?? '');
  const slides = [];
  const rect = (slide, x, y, w, h, fill, stroke) => slide.items.push({ kind:'rect', x,y,w,h,fill,stroke });
  const line = (slide, x1,y1,x2,y2,color=C.border,width=1) => slide.items.push({ kind:'line',x:x1,y:y1,w:x2-x1,h:y2-y1,color,width });
  const text = (slide, value, x,y,w,h,size=22,options={}) => {
    const raw = options.literal ? String(value) : t(value);
    const item = { kind:'text', text:raw, x,y,w,h,size,color:C.ink,bold:false,align:rtl?'right':'left',rtl,...options };
    if (/^[+\-−\d,.\s%–]+$/.test(raw)) item.rtl=false;
    item.lines = wrap(raw, w, size);
    // Never let translated prose silently spill into another region.
    while (item.lines.length * item.size * 1.2 > h && item.size > 14) { item.size -= 1; item.lines = wrap(raw,w,item.size); }
    slide.items.push(item); return item;
  };
  function page(title) {
    const slide={ title:t(title), width:WIDTH,height:HEIGHT,lang:rtl?'ar':'en',items:[] }; slides.push(slide);
    rect(slide,0,0,WIDTH,HEIGHT,C.paper); rect(slide,0,0,WIDTH,104,C.navy);
    text(slide,title,44,25,1112,54,38,{color:C.paper,bold:true});
    line(slide,44,631,1156,631);
    text(slide,`Air2Stay · ${t('Scenario estimates')}`,44,642,760,22,15,{literal:true,color:C.muted});
    text(slide,`${report.date || ''}    ${slides.length}/6`,820,642,336,22,15,{literal:true,align:'right',color:C.muted,pageCounter:true});
    return slide;
  }

  const summary=page('Your flight plan, explained');
  text(summary,`${t(report.country)} · ${t(report.month)}`,44,131,1112,70,45,{literal:true,bold:true});
  text(summary,report.schedule,44,202,1112,42,25);
  const cards=[['Extra hotel check-ins',signed(report.result.delta.hotelCheckins)],['Extra guest nights',signed(report.result.delta.guestNights)],['Total guest nights',num(report.result.scenario.guestNights)]];
  cards.forEach(([label,value],i)=>{
    const x=44+i*378;rect(summary,x,268,356,132,C.pale);
    text(summary,label,x+18,283,320,48,22,{color:C.muted});
    text(summary,value,x+18,335,320,55,46,{literal:true,bold:true,color:C.teal,align:rtl?'right':'left'});
  });
  text(summary,report.plain,44,425,1112,77,28,{bold:true});
  text(summary,report.result.route?.knownMarket ? 'The baseline uses flight history and hotel assumptions. It is not an observed route-level hotel total.' : 'No route history: the baseline is zero. Comparison countries supply starting assumptions only.',44,512,1112,65,22,{color:C.muted});
  if (finite(report.result.p10) && finite(report.result.p90)) text(summary,`${t('Possible range')}: ${num(report.result.p10)} – ${num(report.result.p90)}. ${t('History-based guide, not a guaranteed probability interval.')}`,44,582,1112,39,18,{literal:true,color:C.muted});

  const chain=page('From seats to guest nights');
  report.steps.forEach((row,i)=>{
    const x=44+i*226;rect(chain,x,163,208,251,i===4?C.tealPale:C.pale);
    text(chain,row.label,x+14,180,180,80,22,{bold:true});
    text(chain,num(row.plan),x+14,275,180,49,36,{literal:true,bold:true,color:C.teal});
    text(chain,`${t('Baseline')}: ${num(row.usual)}`,x+14,340,180,32,18,{literal:true,color:C.muted});
    text(chain,`${t('Change')}: ${signed(row.change)}`,x+14,377,180,30,18,{literal:true,bold:true});
    if(i<4)text(chain,rtl?'‹':'›',x+209,264,17,47,32,{literal:true,align:'center',color:C.teal,bold:true});
  });
  text(chain,'Guest nights count people staying overnight, not hotel rooms.',44,451,1112,67,28,{bold:true});
  text(chain,report.source,44,535,1112,70,22,{color:C.muted});

  const assumptions=page('Assumptions behind this plan');
  const cols=[44,590,815,1038];
  rect(assumptions,44,143,1112,48,C.navy);
  ['Assumption','Starting value','Your plan','Changed'].forEach((label,i)=>text(assumptions,label,cols[i]+12,151,[534,213,211,106][i],34,20,{bold:true,color:C.paper}));
  report.assumptions.forEach((row,i)=>{
    const y=191+i*49;rect(assumptions,44,y,1112,49,row.changed?C.tealPale:(i%2?C.pale:C.paper));
    const f=value=>row.format==='percent'?`${(value*100).toFixed(1)}%`:row.format==='stay'?`${value.toFixed(2)} ${t('nights')}`:num(value);
    [t(row.label),f(row.usual),f(row.plan),t(row.changed?'Yes':'No')].forEach((value,j)=>text(assumptions,value,cols[j]+12,y+9,[534,213,211,106][j],35,j?21:20,{literal:true,bold:j===2}));
  });
  text(assumptions,report.source,44,556,1112,62,20,{color:C.muted});

  const monthly=page('Extra guest nights by month');
  text(monthly,'Same selected plan inputs across the year; each month keeps its own starting flight supply.',44,123,1112,61,22,{color:C.muted});
  const vals=report.annual.map(row=>row.change), high=Math.max(0,...vals), low=Math.min(0,...vals), span=Math.max(1,high-low);
  const chartTop=219,chartBottom=501,zero=chartTop+high/span*(chartBottom-chartTop);
  line(monthly,82,zero,1145,zero,C.muted,1.5);
  [high,low].filter((v,i,a)=>a.indexOf(v)===i).forEach(v=>text(monthly,num(v),42,chartTop+(high-v)/span*(chartBottom-chartTop)-12,64,24,14,{literal:true,align:'right',color:C.muted}));
  report.annual.forEach((row,i)=>{
    const x=114+i*86,y=chartTop+(high-row.change)/span*(chartBottom-chartTop),barHeight=Math.abs(zero-y);
    if(barHeight>0)rect(monthly,x,Math.min(y,zero),48,Math.max(1,barHeight),row.change<0?C.rose:(row.selected?C.teal:C.gold));
    text(monthly,signed(row.change),x-18,row.change>=0?y-30:y+5,84,25,16,{literal:true,align:'center',bold:row.selected});
    text(monthly,t(row.label),x-18,548,84,41,17,{literal:true,align:'center',bold:row.selected});
  });
  text(monthly,`${t(report.month)}: ${signed(report.result.delta.guestNights)} ${t('Extra guest nights')}`,44,592,1112,28,20,{literal:true,bold:true,color:C.teal});

  const visitors=page('Estimated visitor mix');
  text(visitors,'Nationality shares are estimated allocations, not measured passenger nationalities.',44,120,1112,54,22,{color:C.muted});
  rect(visitors,44,181,1112,42,C.navy);
  [['Nationality',56,450],['Share',535,150],['Plan guest nights',735,400]].forEach(([label,x,w])=>text(visitors,label,x,188,w,30,20,{color:C.paper,bold:true}));
  const largest=Math.max(1,...report.visitors.slice(0,8).map(row=>row.plan));
  report.visitors.slice(0,8).forEach((row,i)=>{
    const y=223+i*44;rect(visitors,44,y,1112,44,i%2?C.pale:C.paper);
    text(visitors,row.label,56,y+5,450,36,20);
    text(visitors,`${(row.share*100).toFixed(1)}%`,535,y+5,150,36,21,{literal:true});
    rect(visitors,735,y+11,230*(row.plan/largest),22,C.tealPale);
    text(visitors,num(row.plan),977,y+5,160,36,21,{literal:true,bold:true,align:'right'});
  });
  text(visitors,'Top eight groups are shown. Other groups remain included in the total.',44,589,1112,31,19,{color:C.muted});

  const evidence=page('Evidence and next steps');
  rect(evidence,44,129,1112,86,C.tealPale);
  text(evidence,'Confirm expected flight bookings and hotel capacity with the responsible teams.',62,146,1076,53,26,{bold:true});
  let y=235;
  const notes=Array.isArray(report.notes)?report.notes:[];
  let noteSize=20;
  const translatedNotes=notes.slice(0,6).map(t);
  const notesHeight=size=>translatedNotes.reduce((total,note)=>total+Math.max(38,wrap(note,1038,size).length*size*1.2+7)+7,0);
  while(notesHeight(noteSize)>382 && noteSize>16)noteSize--;
  for(const [i,note] of notes.slice(0,6).entries()){
    const content=t(note); const lines=wrap(content,1038,noteSize); const h=Math.max(38,lines.length*noteSize*1.2+7);
    text(evidence,String(i+1).padStart(2,'0'),44,y,56,h,22,{literal:true,bold:true,color:C.teal});
    text(evidence,content,112,y,1044,h,noteSize,{literal:true,color:C.muted}); y+=h+7;
  }
  // Imports must remain visible in exported material, including long file names.
  // A separate source page keeps the evidence page legible instead of hiding or
  // squeezing an additional provenance note into a small footer.
  if(notes.length>6){
    const provenance=page('Document input trail');
    text(provenance,'Reviewed scenario inputs',44,135,1112,54,32,{bold:true});
    text(provenance,notes.slice(6).map(t).join('\n\n'),44,217,1112,266,24,{literal:true,color:C.muted});
    rect(provenance,44,516,1112,94,C.tealPale);
    text(provenance,'These inputs can be imported back into Air2Stay for review. Historical calibration is unchanged.',62,534,1076,64,23,{bold:true});
  }
  slides.forEach((slide,i)=>{const counter=slide.items.find(item=>item.pageCounter);counter.text=`${report.date || ''}    ${i+1}/${slides.length}`;counter.lines=[counter.text];});
  return slides;
}

const scenarioKeys=['originKey','month','extraFlights','seatsPerFlight','loadFactor','p2pShare','conversionRate','averageStay','eventUplift'];
/** Allowlisted numerical assumptions only. No notes, personal data or secrets. */
export function reportScenarioAttachment(report){
  const raw=report.inputs || {};
  const fallback={originKey:report.result?.route?.originKey || report.country,month:report.result?.route?.month};
  const assumptionKeys=['extraFlights','seatsPerFlight','loadFactor','p2pShare','conversionRate','averageStay','eventUplift'];
  assumptionKeys.forEach((key,i)=>fallback[key]=report.assumptions?.[i]?.plan);
  const inputs={};
  for(const key of scenarioKeys){
    const value=raw[key]??fallback[key];
    if(key==='originKey'){
      if(typeof value!=='string'||!value.trim()||value.length>150)throw new Error('The report country is invalid.');
      inputs[key]=value;
    }else{
      if(!finite(value))throw new Error('The report is missing a scenario input.');
      inputs[key]=value;
    }
  }
  return {version:1,dataKind:'scenario_assumptions',inputs};
}

const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const A='http://schemas.openxmlformats.org/drawingml/2006/main', P='http://schemas.openxmlformats.org/presentationml/2006/main', R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels=rows=>XML+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rows.map(([id,type,target])=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${esc(target)}"/>`).join('')+'</Relationships>';
const group='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const fill=color=>`<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
const pos=item=>`<a:xfrm><a:off x="${Math.round(item.x*EMU)}" y="${Math.round(item.y*EMU)}"/><a:ext cx="${Math.max(1,Math.round(item.w*EMU))}" cy="${Math.max(1,Math.round(item.h*EMU))}"/></a:xfrm>`;

function shape(item,id){
  const common=`<p:nvSpPr><p:cNvPr id="${id}" name="${item.kind} ${id}"/><p:cNvSpPr${item.kind==='text'?' txBox="1"':''}/><p:nvPr/></p:nvSpPr>`;
  if(item.kind==='line')return `<p:sp>${common}<p:spPr>${pos(item)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${Math.round(item.width*EMU)}">${fill(item.color)}</a:ln></p:spPr></p:sp>`;
  const geom='<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  if(item.kind==='rect')return `<p:sp>${common}<p:spPr>${pos(item)}${geom}${fill(item.fill)}${item.stroke?`<a:ln>${fill(item.stroke)}</a:ln>`:'<a:ln><a:noFill/></a:ln>'}</p:spPr></p:sp>`;
  const font=Math.round(item.size*80),align={left:'l',center:'ctr',right:'r'}[item.align];
  const paragraphs=item.lines.map(value=>`<a:p><a:pPr algn="${align}" rtl="${item.rtl?'1':'0'}"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcAft><a:spcPts val="0"/></a:spcAft></a:pPr><a:r><a:rPr lang="${item.rtl?'ar-SA':'en-US'}" sz="${font}" b="${item.bold?'1':'0'}">${fill(item.color)}<a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${esc(value)}</a:t></a:r><a:endParaRPr lang="${item.rtl?'ar-SA':'en-US'}" sz="${font}"/></a:p>`).join('');
  return `<p:sp>${common}<p:spPr>${pos(item)}${geom}<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

/** Small uncompressed ZIP writer. Paths are fixed by this module. */
export function zipReportEntries(entries,mime='application/zip'){
  const enc=new TextEncoder(),files=[],central=[];let offset=0,size=0;
  for(const [path,content] of entries){
    const name=enc.encode(path),bytes=typeof content==='string'?enc.encode(content):content;
    let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const h=new DataView(new ArrayBuffer(30));h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,bytes.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,name.length,true);
    const c=new DataView(new ArrayBuffer(46));c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);
    files.push(h.buffer,name,bytes);central.push(c.buffer,name);offset+=30+name.length+bytes.length;size+=46+name.length;
  }
  const end=new DataView(new ArrayBuffer(22));end.setUint32(0,0x06054b50,true);end.setUint16(8,entries.length,true);end.setUint16(10,entries.length,true);end.setUint32(12,size,true);end.setUint32(16,offset,true);
  return new Blob([...files,...central,end.buffer],{type:mime});
}

/** Synchronous; safe to call directly inside a user-initiated export handler. */
export function buildPowerPointReport(report,options={}){
  const slides=buildReportSlides(report,options),entries=[];
  const content=[['/ppt/presentation.xml','presentation.main'],['/ppt/slideMasters/slideMaster1.xml','slideMaster'],['/ppt/slideLayouts/slideLayout1.xml','slideLayout'],...slides.map((_,i)=>[`/ppt/slides/slide${i+1}.xml`,'slide'])];
  entries.push(['[Content_Types].xml',XML+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+content.map(([p,t])=>`<Override PartName="${p}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${t}+xml"/>`).join('')+'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>']);
  entries.push(['_rels/.rels',rels([['rId1','officeDocument','ppt/presentation.xml']])]);
  entries.push(['ppt/presentation.xml',XML+`<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>`+slides.map((_,i)=>`<p:sldId id="${256+i}" r:id="rId${i+2}"/>`).join('')+`</p:sldIdLst><p:sldSz cx="${WIDTH*EMU}" cy="${HEIGHT*EMU}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`]);
  entries.push(['ppt/_rels/presentation.xml.rels',rels([['rId1','slideMaster','slideMasters/slideMaster1.xml'],...slides.map((_,i)=>[`rId${i+2}`,'slide',`slides/slide${i+1}.xml`]),['scenarioData','customXml','../customXml/item1.xml']])]);
  entries.push(['customXml/item1.xml',XML+`<scenario xmlns="urn:air2stay:scenario:v1">${esc(JSON.stringify(reportScenarioAttachment(report)))}</scenario>`]);
  entries.push(['ppt/slideMasters/slideMaster1.xml',XML+`<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`]);
  entries.push(['ppt/slideMasters/_rels/slideMaster1.xml.rels',rels([['rId1','slideLayout','../slideLayouts/slideLayout1.xml'],['rId2','theme','../theme/theme1.xml']])]);
  entries.push(['ppt/slideLayouts/slideLayout1.xml',XML+`<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`]);
  entries.push(['ppt/slideLayouts/_rels/slideLayout1.xml.rels',rels([['rId1','slideMaster','../slideMasters/slideMaster1.xml']])]);
  const clr=Object.entries({dk1:C.ink,lt1:C.paper,dk2:C.muted,lt2:C.pale,accent1:C.teal,accent2:C.gold,accent3:C.rose,accent4:'4263A0',accent5:'7452A5',accent6:'65833B',hlink:'0563C1',folHlink:'954F72'}).map(([k,v])=>`<a:${k}><a:srgbClr val="${v}"/></a:${k}>`).join('');
  entries.push(['ppt/theme/theme1.xml',XML+`<a:theme xmlns:a="${A}" name="Air2Stay"><a:themeElements><a:clrScheme name="Air2Stay">${clr}</a:clrScheme><a:fontScheme name="Air2Stay"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Air2Stay"><a:fillStyleLst>${[1,2,3].map(()=>'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>').join('')}</a:fillStyleLst><a:lnStyleLst>${[1,2,3].map(()=>'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>').join('')}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${[1,2,3].map(()=>'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>').join('')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`]);
  slides.forEach((slide,i)=>{
    entries.push([`ppt/slides/slide${i+1}.xml`,XML+`<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld name="${esc(slide.title)}"><p:spTree>${group}${slide.items.map((item,j)=>shape(item,j+2)).join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`]);
    entries.push([`ppt/slides/_rels/slide${i+1}.xml.rels`,rels([['rId1','slideLayout','../slideLayouts/slideLayout1.xml']])]);
  });
  return zipReportEntries(entries,'application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

export function renderReportSlide(slide,canvas,scale=2){
  canvas.width=WIDTH*scale;canvas.height=HEIGHT*scale;const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('This browser cannot create the PDF image. Use Print / Save PDF instead.');
  ctx.scale(scale,scale);
  for(const item of slide.items){
    if(item.kind==='rect'){ctx.fillStyle='#'+item.fill;ctx.fillRect(item.x,item.y,item.w,item.h);if(item.stroke){ctx.strokeStyle='#'+item.stroke;ctx.strokeRect(item.x,item.y,item.w,item.h);}continue;}
    if(item.kind==='line'){ctx.strokeStyle='#'+item.color;ctx.lineWidth=item.width;ctx.beginPath();ctx.moveTo(item.x,item.y);ctx.lineTo(item.x+item.w,item.y+item.h);ctx.stroke();continue;}
    ctx.font=`${item.bold?'bold ':''}${item.size}px Arial, sans-serif`;ctx.fillStyle='#'+item.color;ctx.textBaseline='top';ctx.textAlign=item.align;ctx.direction=item.rtl?'rtl':'ltr';
    const x=item.align==='right'?item.x+item.w:item.align==='center'?item.x+item.w/2:item.x;
    item.lines.forEach((value,i)=>ctx.fillText(value,x,item.y+i*item.size*1.2,item.w));
  }
  return canvas;
}

const bytesOf=text=>new TextEncoder().encode(text);
/** PDF 1.4, one JPEG image per page. UTF-8 never enters PDF text operators. */
export function buildImagePdf(images,scenarioData=null){
  if(!Array.isArray(images)||!images.length)throw new Error('No report pages were produced.');
  const objects=[];const add=value=>{objects.push(typeof value==='string'?bytesOf(value):value);return objects.length;};
  const attachmentId=3+images.length*3;
  const attachment=scenarioData===null?null:bytesOf(JSON.stringify(scenarioData));
  add(`<< /Type /Catalog /Pages 2 0 R${attachment?` /Names << /EmbeddedFiles << /Names [(air2stay-scenario.json) ${attachmentId+1} 0 R] >> >> /AF [${attachmentId+1} 0 R]`:''} >>`);
  add(`<< /Type /Pages /Kids [${images.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] /Count ${images.length} >>`);
  images.forEach(({bytes,width,height},i)=>{
    if(!(bytes instanceof Uint8Array)||!bytes.length||!Number.isInteger(width)||!Number.isInteger(height))throw new Error('Invalid report image.');
    const id=3+i*3;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /XObject << /Im${i+1} ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
    const head=bytesOf(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`),tail=bytesOf('\nendstream');
    const image=new Uint8Array(head.length+bytes.length+tail.length);image.set(head);image.set(bytes,head.length);image.set(tail,head.length+bytes.length);add(image);
    const commands=`q\n960 0 0 540 0 0 cm\n/Im${i+1} Do\nQ\n`;add(`<< /Length ${bytesOf(commands).length} >>\nstream\n${commands}endstream`);
  });
  if(attachment){
    const head=bytesOf(`<< /Type /EmbeddedFile /Subtype /application#2Fjson /Length ${attachment.length} >>\nstream\n`),tail=bytesOf('\nendstream');
    const stream=new Uint8Array(head.length+attachment.length+tail.length);stream.set(head);stream.set(attachment,head.length);stream.set(tail,head.length+attachment.length);add(stream);
    add(`<< /Type /Filespec /F (air2stay-scenario.json) /UF (air2stay-scenario.json) /Desc (Reviewed Air2Stay scenario assumptions) /AFRelationship /Data /EF << /F ${attachmentId} 0 R >> >>`);
  }
  const chunks=[bytesOf('%PDF-1.4\n%Air2Stay\n')],offsets=[0];let offset=chunks[0].length;
  objects.forEach((value,i)=>{const head=bytesOf(`${i+1} 0 obj\n`),tail=bytesOf('\nendobj\n');offsets.push(offset);chunks.push(head,value,tail);offset+=head.length+value.length+tail.length;});
  const xref=offset;chunks.push(bytesOf(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Blob(chunks,{type:'application/pdf'});
}

/** Direct PDF download content; browser fonts shape Arabic before rasterization. */
export async function buildPdfReport(report,options={}){
  const slides=buildReportSlides(report,options);
  if(typeof document==='undefined')throw new Error('PDF rendering needs a browser.');
  if(document.fonts?.ready)await document.fonts.ready;
  const images=[];
  for(const slide of slides){
    const canvas=renderReportSlide(slide,document.createElement('canvas'),2);
    const base64=canvas.toDataURL('image/jpeg',0.94).split(',')[1];
    if(!base64)throw new Error('The report image could not be prepared.');
    images.push({bytes:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),width:canvas.width,height:canvas.height});
    canvas.width=0;canvas.height=0;
  }
  return buildImagePdf(images,reportScenarioAttachment(report));
}
