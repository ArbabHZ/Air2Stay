import { IMPORT_FIELDS, IMPORT_TEMPLATE, extractImportDocument, parseImportNumber } from './document_import.mjs';

export function createImportWorkspace({getCurrent,makeStartingPlan,previewPlan,applyPlan,countries,download}) {
  const dialog=document.createElement('dialog');
  dialog.id='importDialog';dialog.className='import-dialog';dialog.setAttribute('data-i18n-ignore','');dialog.setAttribute('aria-labelledby','importTitle');
  document.body.append(dialog);
  let extracted=null,chosen=null,form=null,busy=false;
  const ar=()=>document.documentElement.lang==='ar';
  const say=(en,arabic)=>ar()?arabic:en;
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const fieldLabel=f=>ar()?({originKey:'بلد المغادرة',month:'الشهر',extraFlights:'الرحلات الإضافية أسبوعياً',seatsPerFlight:'المقاعد لكل رحلة',loadFactor:'إشغال الرحلات (%)',p2pShare:'من تنتهي رحلتهم هنا (%)',conversionRate:'من يقيمون في فندق (%)',averageStay:'متوسط الإقامة (ليالٍ)',eventUplift:'أثر الفعالية (%)'})[f.key]:f.label;
  function button(label,action,className='') {const b=el('button',label,className);b.type='button';b.addEventListener('click',action);return b;}
  function close() {if(!busy)dialog.close();}
  function status(message,error=false) {const n=dialog.querySelector('#importStatus');n.textContent=message;n.classList.toggle('import-error',error);}
  function currentValues() {
    const values={};
    for(const f of IMPORT_FIELDS) {
      const field=form.elements.namedItem(f.key);
      const value=parseImportNumber(field.value,f,f.percent?'%':'');
      if(value===undefined)throw new Error(`${fieldLabel(f)}: ${say('enter a value.','أدخل قيمة.')}`);
      values[f.key]=value;
    }
    const country=countries.find(c=>[c.name,c.key,...(c.aliases||[])].some(a=>String(a).toLowerCase()===values.originKey.trim().toLowerCase()));
    if(!country)throw new Error(say('Choose a recognised country from the suggestions.','اختر دولة من الاقتراحات.'));
    values.originKey=country.key;
    return values;
  }
  function refreshPreview() {
    const pane=dialog.querySelector('#importImpact'),apply=dialog.querySelector('#applyImportedInputs');pane.replaceChildren();
    try {
      const values=currentValues();const base=makeStartingPlan(values.originKey,values.month);
      const result=previewPlan({...base,...values});
      const fmt=n=>Math.round(n).toLocaleString('en-US');
      pane.append(el('strong',say('Preview after applying these inputs','معاينة بعد تطبيق هذه القيم')));
      const metrics=el('div',undefined,'import-metrics');
      for(const [label,value] of [[say('Hotel check-ins','التسجيلات الفندقية'),result.scenario.hotelCheckins],[say('Guest nights','الليالي الفندقية'),result.scenario.guestNights],[say('Change in guest nights','التغير في الليالي الفندقية'),result.delta.guestNights]]) {
        const item=el('div');item.append(el('span',label),el('strong',fmt(value)));metrics.append(item);
      }
      pane.append(metrics);apply.disabled=busy||Boolean(chosen?.errors?.length);
      if(chosen?.errors?.length) pane.append(el('p',say('This source row has errors. Choose a valid row or correct the source file.','يحتوي الصف على أخطاء. اختر صفاً صالحاً أو صحح الملف.')));
    } catch(e) {pane.append(el('p',e.message,'import-error'));apply.disabled=true;}
  }
  function showCandidate(index) {
    chosen=extracted.candidates[index];
    const current=getCurrent();
    const matchedCountry=countries.find(c=>[c.name,c.key,...(c.aliases||[])].some(a=>String(a).toLowerCase()===String(chosen.values.originKey||current.originKey).toLowerCase()));
    const country=matchedCountry?.key||chosen.values.originKey||current.originKey;
    let baseline;
    try {baseline=makeStartingPlan(country,chosen.values.month||current.month);}catch{baseline=current;}
    const values={...baseline,...chosen.values};
    form.replaceChildren();
    for(const f of IMPORT_FIELDS) {
      const label=el('label');label.append(el('span',fieldLabel(f)));
      const input=el('input');input.name=f.key;input.required=true;input.dir='ltr';
      if(f.key==='originKey'){input.type='text';input.setAttribute('list','importCountries');input.value=countries.find(c=>c.key===values[f.key])?.name||values[f.key];}
      else {input.type='number';input.min=f.key==='month'?1:f.min;input.max=f.key==='month'?12:f.max;input.step=['month','extraFlights'].includes(f.key)?'1':'any';input.value=String(values[f.key]*(f.percent?100:1));}
      input.addEventListener('input',()=>{label.querySelector('small').textContent=say('Edited in this review','تم التعديل في هذه المراجعة');refreshPreview();});
      const supplied=Object.prototype.hasOwnProperty.call(chosen.values,f.key);
      label.append(input,el('small',supplied?(chosen.locations[f.key]||chosen.source):say('Not found in document — starting assumption; review it.','غير موجود في المستند — افتراض أولي؛ راجعه.')));form.append(label);
    }
    status(chosen.errors.join(' '),chosen.errors.length>0);refreshPreview();
  }
  async function read(file) {
    if(!file||busy)return;busy=true;status(say('Reading the document locally…','تتم قراءة المستند محلياً…'));dialog.querySelector('#importFile').disabled=true;
    const old=dialog.querySelector('#importReview');old.hidden=true;
    try {
      extracted=await extractImportDocument(file);
      const useful=extracted.candidates.filter(c=>Object.keys(c.values).length||c.errors.length);
      extracted.candidates=useful.length?useful:[{values:{},errors:[],locations:{},source:file.name}];
      const picker=dialog.querySelector('#importCandidate');picker.replaceChildren();
      extracted.candidates.forEach((candidate,i)=>{const option=el('option',`${i+1}. ${candidate.values.originKey||say('Review values','مراجعة القيم')} · ${candidate.values.month||'—'} · ${candidate.source}`);option.value=String(i);picker.append(option);});
      dialog.querySelector('#importSourceName').textContent=file.name;
      dialog.querySelector('#importExtractedText').textContent=extracted.text;
      const warnings=dialog.querySelector('#importWarnings');warnings.replaceChildren();
      for(const warning of extracted.warnings)warnings.append(el('p',warning));
      if(!useful.length)warnings.append(el('p',say('No labelled model inputs were recognised. Use the extracted text to enter verified values below, or use the template. Nothing has been applied.','لم يتم التعرف على مدخلات مسماة. أدخل القيم الموثقة من النص أدناه أو استخدم القالب. لم يتم تطبيق أي شيء.')));
      old.hidden=false;busy=false;showCandidate(0);
    } catch(e) {status(e.message,true);}
    finally {busy=false;dialog.querySelector('#importFile').disabled=false;}
  }
  function build() {
    extracted=null;chosen=null;dialog.replaceChildren();dialog.dir=ar()?'rtl':'ltr';
    const header=el('header',undefined,'import-heading');const title=el('h2',say('Import model inputs','استيراد مدخلات النموذج'));title.id='importTitle';header.append(title,button(say('Close','إغلاق'),close));
    dialog.append(header,el('p',say('Bring flight and visitor assumptions into a scenario. Review the extracted values before applying them. Files stay in this browser.','أضف افتراضات الرحلات والزوار إلى السيناريو. راجع القيم قبل تطبيقها. تبقى الملفات في هذا المتصفح.')));
    const controls=el('div',undefined,'import-file-controls');
    const label=el('label',say('Choose a document','اختر مستنداً'));const input=el('input');input.id='importFile';input.type='file';input.accept='.csv,.tsv,.xlsx,.json,.pdf,.pptx,.txt';input.addEventListener('change',()=>read(input.files[0]));label.append(input);
    controls.append(label,button(say('Download input template','تنزيل قالب المدخلات'),()=>download(new Blob([IMPORT_TEMPLATE],{type:'text/csv;charset=utf-8'}),'Air2Stay-input-template.csv')));dialog.append(controls);
    dialog.append(el('p',say('CSV / XLSX / JSON · selectable-text PDF · PPTX text and tables. Maximum 20 MB. This updates scenario assumptions; it does not retrain the historical model.','CSV / XLSX / JSON · نص PDF قابل للتحديد · نصوص وجداول PPTX. الحد الأقصى 20 ميغابايت. يتم تحديث افتراضات السيناريو، وليس إعادة تدريب النموذج التاريخي.'),'import-help'));
    const state=el('p');state.id='importStatus';state.setAttribute('role','status');dialog.append(state);
    const review=el('section');review.id='importReview';review.hidden=true;
    const source=el('h3');source.id='importSourceName';review.append(source);
    const selectLabel=el('label',say('Scenario or document section','السيناريو أو قسم المستند'));const select=el('select');select.id='importCandidate';select.addEventListener('change',()=>showCandidate(Number(select.value)));selectLabel.append(select);review.append(selectLabel);
    const warning=el('div');warning.id='importWarnings';review.append(warning);
    const details=el('details');details.append(el('summary',say('See extracted source text','عرض النص المستخرج')));const pre=el('pre');pre.id='importExtractedText';details.append(pre);review.append(details);
    form=el('form',undefined,'import-fields');form.addEventListener('submit',e=>e.preventDefault());review.append(form);
    const datalist=el('datalist');datalist.id='importCountries';countries.forEach(c=>{const option=el('option');option.value=c.name;datalist.append(option);});review.append(datalist);
    const impact=el('div',undefined,'import-impact');impact.id='importImpact';impact.setAttribute('aria-live','polite');review.append(impact);
    const apply=button(say('Apply reviewed inputs to the model','تطبيق المدخلات المراجعة على النموذج'),()=>{
      if(busy||!chosen||chosen.errors.length)return;
      try {const values=currentValues();applyPlan(values,{filename:extracted.title,location:chosen.source,importedAt:new Date().toISOString(),fields:Object.keys(chosen.values)});dialog.close();}catch(e){status(e.message,true);}
    },'import-apply');apply.id='applyImportedInputs';apply.disabled=true;review.append(apply);
    dialog.append(review);
  }
  document.querySelector('#openModelImport')?.addEventListener('click',()=>{build();dialog.showModal();});
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  return {open(){build();dialog.showModal();},destroy(){dialog.remove();}};
}
