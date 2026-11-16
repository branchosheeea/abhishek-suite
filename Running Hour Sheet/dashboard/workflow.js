'use strict';
let entryMonth = null;
let importPreview = null;
let importRevision = null;
const entryDrafts = new Map();
function manualReports(id){return state.data.manual_reports?.[year]?.[id];}
function draftKey(){return year+'-'+entryMonth;}
function entryRows(){return state.data.machines.filter(m=>m.active&&state.data.years[year][m.id]).sort((a,b)=>a.name.localeCompare(b.name));}
function initialEntry(m){const old=manualReports(m.id)?.[entryMonth],workbook=state.data.workbook_sources?.[year]?.[m.id]?.[entryMonth+1];return {id:m.id,begin:old?old.begin:state.data.years[year][m.id][entryMonth],end:old?old.end:workbook?state.data.years[year][m.id][entryMonth+1]:null,note:old?.note||''};}
function captureEntry(){
 const entries=[...document.querySelectorAll('[data-entry-id]')].filter(el=>el.querySelector('[data-field="end"]')).map(el=>{
  const number=field=>{const value=el.querySelector(`[data-field="${field}"]`).value;return value===''?null:Number(value);};
  return {id:el.dataset.entryId,begin:number('begin'),end:number('end'),note:el.querySelector('[data-field="note"]').value};
 });
 entryDrafts.set(draftKey(),{engineer:$('engineerName').value,entries});
 $('entryStatus').textContent='Unsaved changes — save this month to retain them.';
}
function renderWorkflow(){
 const rows=entryRows();
 if(entryMonth===null){let last=-1;rows.forEach(m=>{for(let n=0;n<12;n++){if(sourceReports(m.id)?.[n]||manualReports(m.id)?.[n]||state.data.years[year][m.id][n+1]!=null)last=Math.max(last,n);}});entryMonth=Math.min(11,last+1);}
 $('entryMonth').innerHTML=months.map((m,n)=>`<option value="${n}" ${n===entryMonth?'selected':''}>${m} ${year}</option>`).join('');
 const draft=entryDrafts.get(draftKey());
 $('engineerName').value=draft?.engineer||'';
 $('entryStatus').textContent=draft?'Unsaved changes — save this month to retain them.':'Imported months are locked. Save any completed readings; unknown meters may remain blank.';
 let editable=0;
 $('monthlyEntryTable').innerHTML=`<table class="monthly-entry"><thead><tr><th>Machinery</th><th>Record</th><th>Opening meter</th><th>Closing meter</th><th>Monthly RH</th><th>Note / correction reason</th></tr></thead><tbody>${rows.map(m=>{
  const source=sourceReports(m.id)?.[entryMonth],old=manualReports(m.id)?.[entryMonth],workbook=state.data.workbook_sources?.[year]?.[m.id]?.[entryMonth+1],record=source||old;
  const legacy=!source&&!old&&!workbook&&state.data.years[year][m.id][entryMonth+1]!=null;
  if(source||legacy){return `<tr data-entry-id="${esc(m.id)}"><td>${esc(m.name)}</td><td><span class="badge">${source?'Excel · locked':'Existing · locked'}</span></td><td>${fmt(source?.begin??state.data.years[year][m.id][entryMonth])}</td><td>${fmt(source?.end??state.data.years[year][m.id][entryMonth+1])}</td><td>${fmt(info(m).hours[entryMonth])}</td><td><button type="button" data-entry-inspect="${esc(m.id)}">View record</button></td></tr>`;}
  editable++;
  const current=draft?.entries.find(e=>e.id===m.id)||initialEntry(m);
  const input=(field,value,type)=>`<input data-field="${field}" aria-label="${esc(m.name)} ${field}" type="${type}" ${type==='number'?'min="0" step="any"':'maxlength="1000"'} value="${esc(value??'')}" ${isDemo?'disabled':''}>`;
  const hours=current.begin==null||current.end==null?null:current.end-current.begin;
  return `<tr data-entry-id="${esc(m.id)}"><td>${esc(m.name)}</td><td><span class="badge">${old?'Manual':workbook?'Workbook import':'New entry'}</span></td><td>${input('begin',current.begin,'number')}</td><td>${input('end',current.end,'number')}</td><td data-entry-rh class="${hours<0?'purple-text':''}">${fmt(hours)}</td><td>${input('note',current.note,'text')}</td></tr>`;
 }).join('')}</tbody></table>`;
 $('saveMonth').disabled=isDemo||!editable;
 $('engineerName').disabled=isDemo||!editable;
 $('scanHistory').disabled=isDemo;
 $('sourceFolder').textContent=state.data.import_info?.source||'Configured vessel source folder';
 document.querySelectorAll('[data-entry-inspect]').forEach(b=>b.onclick=()=>openEditor(b.dataset.entryInspect));
 document.querySelectorAll('#monthlyEntryTable input').forEach(input=>input.oninput=()=>{
  const row=input.closest('tr'),a=row.querySelector('[data-field="begin"]').value,b=row.querySelector('[data-field="end"]').value,h=a===''||b===''?null:Number(b)-Number(a);
  row.querySelector('[data-entry-rh]').textContent=fmt(h);row.querySelector('[data-entry-rh]').classList.toggle('purple-text',h!=null&&h<0);captureEntry();
 });
 $('engineerName').oninput=captureEntry;
 $('entryMonth').onchange=e=>{entryMonth=Number(e.target.value);renderWorkflow();};
 renderImportPreview();
 renderWorkbookPreview();
}
async function saveMonthly(e){
 e.preventDefault();captureEntry();const draft=entryDrafts.get(draftKey());
 const changed=draft.entries.filter(entry=>{const machine=state.data.machines.find(m=>m.id===entry.id),old=initialEntry(machine);return entry.begin!==old.begin||entry.end!==old.end||entry.note!==old.note;});
 if(!changed.length){message('No changed readings to save.');return;}
 const key=draftKey();$('saveMonth').disabled=true;
 try{state=await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'monthly_entry',year,month:entryMonth,engineer:draft.engineer,entries:changed,revision:state.data.revision})});entryDrafts.delete(key);month=entryMonth;message(`Saved ${changed.length} machinery record(s) for ${months[month]} ${year}. History retained; analytics updated.`);render();}catch(error){message(error.message);$('saveMonth').disabled=false;}
}
async function previewHistory(){
 $('scanHistory').disabled=true;message('Scanning the configured vessel folder. Source workbooks will not be changed.');
 try{const response=await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'preview_import',revision:state.data.revision})});importPreview=response.preview;importRevision=state.data.revision;renderImportPreview();message('Import preview ready. Conflicting records will be retained unchanged.');}catch(error){message(error.message);}finally{$('scanHistory').disabled=isDemo;}
}
function renderImportPreview(){
 const p=importPreview;
 $('applyHistory').disabled=isDemo||!p||!p.new_records||entryDrafts.size>0;
 $('importPreview').innerHTML=p?`<div class="import-summary"><span><b>${p.new_records}</b> new records</span><span><b>${p.existing_records}</b> already present</span><span><b>${p.conflicts.length}</b> conflicts</span><span><b>${p.duplicate_files.length}</b> duplicate files</span><span><b>${p.errors.length}</b> files need review</span></div><p>${p.files} files scanned · ${p.new_machines} new machinery names. Only new records will be added; existing readings remain unchanged.</p>${p.conflicts.length?'<h3>Conflicts — retained for review</h3>'+p.conflicts.map(c=>`<p class="footnote">${esc(c.machine)} · ${c.year}-${String(c.month).padStart(2,'0')}: ${esc(c.reason)}<br>${c.files.map(esc).join(' · ')}</p>`).join(''):''}${p.errors.length?'<h3>Files not imported</h3>'+p.errors.map(c=>`<p class="footnote">${esc(c.file)}: ${esc(c.error)}</p>`).join(''):''}${entryDrafts.size?'<p class="footnote">Save your monthly-entry draft before applying an import.</p>':''}`:empty('Add Excel reports to the vessel’s YYYY-MM folders, then scan to preview new history.');
}
async function applyHistory(){
 if(!importPreview||isDemo)return;$('applyHistory').disabled=true;
 try{const response=await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'bulk_import',fingerprint:importPreview.fingerprint,revision:importRevision})});state=response;const added=response.import_summary.new_records;importPreview=response.import_summary;importPreview.new_records=0;entryMonth=null;message(`Imported ${added} new record(s); ${response.import_summary.existing_records} already-present record(s) skipped. Conflicts and unsupported files remain for review.`);render();}catch(error){message(error.message);renderImportPreview();}
}
let workbookPreview=null;
function renderWorkbookPreview(){
 const p=workbookPreview?.preview;
 $('annualWorkbook').disabled=isDemo;
 $('previewWorkbook').disabled=isDemo;
 $('applyWorkbook').disabled=isDemo||!p||(!p.new_values&&!p.new_machines.length)||entryDrafts.size>0;
 $('workbookPreview').innerHTML=p?`<div class="import-summary"><span><b>${p.years.map(y=>esc(y)).join(', ')}</b> reporting years</span><span><b>${p.machines}</b> machines</span><span><b>${p.new_values}</b> new meter values</span><span><b>${p.identical_values}</b> identical values</span><span><b>${p.total_conflicts}</b> conflicts retained</span></div><p>${esc(p.filename)} · ${p.new_machines.length} new machinery items. Existing readings are never overwritten.${p.total_conflicts>p.conflicts.length?` Showing first ${p.conflicts.length} conflicts.`:''}</p>${p.conflicts.length?'<h3>Conflicts — existing values retained</h3>'+p.conflicts.map(c=>`<p class="footnote">${esc(c.machine)} · ${esc(c.year)} · ${esc(c.field)}: app has ${fmt(c.existing)}; workbook has ${fmt(c.uploaded)}</p>`).join(''):''}${p.new_machines.length?`<p class="footnote">New machinery: ${p.new_machines.map(esc).join(', ')}</p>`:''}${entryDrafts.size?'<p class="footnote">Save or discard monthly-entry drafts before importing.</p>':''}`:empty('Choose an annual Running Hour Sheet .xlsx workbook, then preview it. No readings are changed until you confirm the import.');
}
async function uploadWorkbook(endpoint){
 const file=$('annualWorkbook').files[0];
 if(!file){message('Choose an annual .xlsx workbook first.');return;}
 if(file.size>15_000_000){message('Workbook exceeds the 15 MB upload limit.');return;}
 const button=endpoint==='/api/workbook-preview'?'previewWorkbook':'applyWorkbook';
 $(button).disabled=true;
 try{
  const headers={'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','X-Workbook-Name':encodeURIComponent(file.name),'X-Data-Revision':String(state.data.revision)};
  if(endpoint==='/api/workbook-import')headers['X-Workbook-Fingerprint']=workbookPreview.fingerprint;
  const response=await fetch(endpoint,{method:'POST',headers,body:await file.arrayBuffer()});
  const body=await response.json();
  if(!response.ok)throw Error(body.error||'Workbook upload failed');
  if(endpoint==='/api/workbook-preview'){
   workbookPreview=body;renderWorkbookPreview();message('Workbook preview ready. No records have been changed.');
  }else{
   state=body;const summary=body.import_summary;workbookPreview=null;$('annualWorkbook').value='';render();message(`Imported ${summary.new_values} new meter value(s). ${summary.total_conflicts} existing value(s) were retained as conflicts.`);
  }
 }catch(error){message(error.message);}
 finally{$(button).disabled=false;renderWorkbookPreview();}
}
function previewWorkbook(){uploadWorkbook('/api/workbook-preview');}
function applyWorkbook(){if(!workbookPreview||isDemo)return;if(entryDrafts.size){message('Save or discard monthly-entry drafts before importing.');return;}uploadWorkbook('/api/workbook-import');}
window.addEventListener('beforeunload',event=>{if(entryDrafts.size){event.preventDefault();event.returnValue='';}});
