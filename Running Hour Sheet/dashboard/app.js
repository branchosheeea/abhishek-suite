'use strict';
const $ = id => document.getElementById(id);
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n == null ? '—' : Number(n).toLocaleString(undefined,{maximumFractionDigits:1});
let state, year = '2026', month = 9, isDemo = false, view = 'overview';
const empty = text => `<div class="empty">${text}</div>`;
function message(text){$('message').textContent=text;$('message').hidden=!text;}
async function request(url, options){
 const response=await fetch(url,options),contentType=response.headers.get('content-type')||'';
 if(!contentType.includes('application/json')){
  if(window.location.protocol==='file:')throw Error('Dashboard opened as a file, not through its server. Double-click Start_Dashboard.bat, then open http://127.0.0.1:8765/.');
  throw Error(`Dashboard API returned ${response.status} ${response.statusText} instead of JSON. Reopen the app with Start_Dashboard.bat at http://127.0.0.1:8765/.`);
 }
 const body=await response.json();
 if(!response.ok)throw Error(body.error||'Request failed');
 return body;
}
async function load(){try{state=await request(isDemo?'/api/demo':'/api/state');if(!state.data.years[year])year=Object.keys(state.data.years).sort().at(-1);render();}catch(e){message(e.message);}}
async function mutate(action){if(isDemo){message('Demo is read-only. Return to vessel records to make changes.');return false;}try{state=await request('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...action,year,revision:state.data.revision})});message('Saved locally. A backup of the previous records was retained.');render();return true;}catch(e){message(e.message);return false;}}
function records(){return state.data.machines.filter(m=>state.data.years[year][m.id]&&($('inactive').checked||m.active)).sort((a,b)=>a.name.localeCompare(b.name));}
function info(m){return state.analytics[year][m.id];}
function sourceReports(id){return state.data.source_reports?.[year]?.[id];}
function valid(h){return typeof h==='number'&&h>=0;}
function status(m){const i=info(m),h=i.hours[month];if(h!=null&&h<0)return 'error';return i.alerts[month];}
function hist(m){return info(m).hours.slice(0,month-1).filter(valid);}
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function render(){
 if(!state.data.years[year])year=Object.keys(state.data.years).sort().at(-1);
 const data=state.data, rows=records();
 $('vessel').textContent=data.vessel;
 let importNotice=$('importNotice');if(!importNotice){importNotice=document.createElement('div');importNotice.id='importNotice';importNotice.className='empty';$('overview').before(importNotice);}
 importNotice.hidden=!data.import_info;
 if(data.import_info)importNotice.textContent='Imported vessel reports · Readings retained as reported · March covers only three generators · SPERRE August–September continuity gap: 745 RH · Readings are provisional. Select a machine to inspect its source meters.';
 $('year').innerHTML=Object.keys(data.years).sort().map(y=>`<option ${y===year?'selected':''}>${y}</option>`).join('');
 $('month').innerHTML=months.map((m,i)=>`<option value="${i}" ${i===month?'selected':''}>${m} ${year}</option>`).join('');
 $('demo').textContent=isDemo?'Return to vessel records':'Explore demo';$('demoBanner').hidden=!isDemo;
 $('saveState').textContent=isDemo?'DEMO · not saved to vessel records':'Stored locally · automatic backups on save';
 ['enter','editReadings','add','renameVessel','rollover','restore'].forEach(id=>$(id).disabled=isDemo);
 renderOperations(rows);
 $('heatmap').innerHTML=rows.length?`<table><thead><tr><th>Machinery</th>${months.map(m=>`<th>${m}</th>`).join('')}<th>YTD</th></tr></thead><tbody>${rows.map(m=>`<tr data-id="${esc(m.id)}"><td>${esc(m.name)} ${m.active?'':'<span class="badge">Inactive</span>'}</td>${info(m).hours.map((h,n)=>`<td><span class="cell ${h==null?'blank':h<0?'error':info(m).alerts[n]||''}" title="${h==null?'Missing readings':h<0?'Negative RH: check meter':info(m).alerts[n]==='amber'?'Low utilisation':info(m).alerts[n]==='red'?'No utilisation':'Recorded RH'}">${fmt(h)}</span></td>`).join('')}<td><strong>${fmt(info(m).hours.slice(0,month+1).filter(valid).reduce((a,b)=>a+b,0))}</strong></td></tr>`).join('')}</tbody></table>`:empty('No machinery in this reporting year. Add a machine in the register.');
 renderReview(rows);
 renderWorkflow();
 $('meterTable').innerHTML=rows.length?`<table><thead><tr><th>Machinery</th><th>Previous Dec</th>${months.map(m=>`<th>${m}</th>`).join('')}</tr></thead><tbody>${rows.map(m=>`<tr data-id="${esc(m.id)}"><td>${esc(m.name)}</td>${data.years[year][m.id].map(v=>`<td>${fmt(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:empty('No machinery records yet.');
 $('register').innerHTML=[...data.machines].sort((a,b)=>a.name.localeCompare(b.name)).map(m=>`<div class="register-row"><strong>${esc(m.name)}</strong><span class="badge">${m.active?'Active':'Inactive'}</span><button data-rename="${esc(m.id)}" ${isDemo?'disabled':''}>Rename</button><button data-toggle="${esc(m.id)}" ${isDemo?'disabled':''}>${m.active?'Deactivate':'Activate'}</button></div>`).join('');
 document.querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>openEditor(el.dataset.id));
 document.querySelectorAll('[data-edit]').forEach(el=>el.onclick=()=>openEditor(el.dataset.edit));
 document.querySelectorAll('[data-rename]').forEach(el=>el.onclick=()=>{const m=data.machines.find(m=>m.id===el.dataset.rename);const name=prompt('Machinery name',m.name);if(name!==null)mutate({type:'rename',id:m.id,name});});
 document.querySelectorAll('[data-toggle]').forEach(el=>el.onclick=()=>{const m=data.machines.find(m=>m.id===el.dataset.toggle);mutate({type:'active',id:m.id,active:!m.active});});
}
function selectView(v){view=v;['overview','readings','machinery','history'].forEach(n=>{const id=n==='overview'?'overview':n+'View';$(id).hidden=n!==v;});document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===v));$('pageTitle').textContent={overview:'Machinery review',readings:'Monthly entry',machinery:'Machinery register',history:'Historical imports'}[v];}
function fillEditor(){const id=$('editMachine').value,readings=state.data.years[year][id];if(!readings)return;const sources=sourceReports(id),manual=manualReports(id);$('meterForm').querySelector('[type=submit]').disabled=true;let detail=$('sourceDetail');if(!detail){detail=document.createElement('div');detail.id='sourceDetail';detail.className='table-scroll';$('meterInputs').after(detail);}detail.hidden=false;$('meterInputs').hidden=true;
const record=n=>sources?.[n]||manual?.[n];
detail.innerHTML=`<p class="footnote">Excel history is retained unchanged. Add or correct manual readings through Monthly entry.</p><table><thead><tr><th>Month</th><th>Origin</th><th>Opening</th><th>Closing</th><th>Monthly RH</th></tr></thead><tbody>${months.map((name,n)=>{const r=record(n);return `<tr><td>${name}</td><td>${sources?.[n]?'Excel':manual?.[n]?'Manual':'?'}</td><td>${fmt(r?r.begin:readings[n])}</td><td>${fmt(r?r.end:readings[n+1])}</td><td>${fmt(state.analytics[year][id].hours[n])}</td></tr>`;}).join('')}</tbody></table>${months.map((name,n)=>{const r=record(n);if(!r)return '';return `<p class="footnote"><strong>${name}:</strong> ${sources?.[n]?esc(r.file)+' ? '+esc(r.sheet)+' ? row '+r.row:'Entered by '+esc(r.engineer)+' ? '+esc(r.updated_at)+(r.note?'<br>'+esc(r.note):'')}${(state.analytics[year][id].issues?.[n]||[]).map(i=>'<br><span class="purple-text">'+esc(i)+'</span>').join('')}</p>`;}).join('')}`;
}
function openEditor(id){const rows=records();if(!rows.length){message('Add machinery to this year before entering readings.');return;}$('editMachine').innerHTML=rows.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');if(id)$('editMachine').value=id;$('editYear').textContent=`Reporting year ${year}${isDemo?' · read-only demo':''}`;$('meterForm').querySelector('[type=submit]').disabled=isDemo;fillEditor();$('editor').showModal();}
$('meterForm').onsubmit=async e=>{e.preventDefault();const readings=[...document.querySelectorAll('[data-index]')].map(el=>el.value===''?null:Number(el.value));if(await mutate({type:'readings',id:$('editMachine').value,readings}))$('editor').close();};
$('editMachine').onchange=fillEditor;
$('closeEditor').onclick=$('cancelEditor').onclick=()=>$('editor').close();
$('enter').onclick=()=>selectView('readings');$('editReadings').onclick=()=>openEditor();
$('monthlyForm').onsubmit=saveMonthly;
$('discardMonth').onclick=()=>{entryDrafts.delete(draftKey());renderWorkflow();};
$('scanHistory').onclick=previewHistory;$('applyHistory').onclick=applyHistory;
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>selectView(b.dataset.view));
$('year').onchange=e=>{year=e.target.value;entryMonth=null;render();};$('month').onchange=e=>{month=Number(e.target.value);render();};$('inactive').onchange=render;
$('demo').onclick=()=>{isDemo=!isDemo;message('');load();};
$('add').onclick=()=>{const name=prompt('Name of the new machinery');if(name!==null)mutate({type:'add',name});};
$('renameVessel').onclick=()=>{const name=prompt('Vessel name',state.data.vessel);if(name!==null)mutate({type:'vessel',name});};
$('rollover').onclick=async()=>{if(confirm(`Create ${Number(year)+1}? December meters will become baselines; all previous years remain available.`)){if(await mutate({type:'rollover'})){year=String(Number(year)+1);render();}}};
$('backup').onclick=()=>download(`machinery-${isDemo?'DEMO-':''}${year}-backup.json`,JSON.stringify(state.data,null,2),'application/json');
$('pmsRecord').onclick=()=>{
 if(entryDrafts.size){message('Save or discard the unsaved monthly entry before creating a PMS attachment.');return;}
 const report=window.open('','_blank');
 if(!report){message('Allow pop-ups for this local dashboard to create the PMS attachment.');return;}
 const machines=[...state.data.machines].sort((a,b)=>a.name.localeCompare(b.name));
 const reportRows=machines.map(machine=>{
  const meters=state.data.years[year]?.[machine.id]||[];
  const imported=sourceReports(machine.id)?.[month];
  const manual=manualReports(machine.id)?.[month];
  const opening=imported?.begin??manual?.begin??meters[month]??null;
  const closing=imported?.end??manual?.end??meters[month+1]??null;
  const item=state.analytics[year]?.[machine.id];
  const hours=item?.hours[month]??null;
  const issues=item?.issues?.[month]||[];
  const alert=item?.alerts[month];
  const status=issues.length?'Review meter':hours==null?'Missing RH':alert?`${alert==='amber'?'Low utilisation':'No utilisation'} · review`:'Recorded';
  const provenance=imported
   ? `${imported.file||'Excel source'} · ${imported.sheet||''}${imported.row?` · row ${imported.row}`:''}`
   : manual?`Manual · ${manual.engineer} · ${manual.updated_at}`
   : hours==null?'Not recorded':'Register';
  const notes=[...issues];
  if(alert)notes.push(`Utilisation screening: ${alert}. Review operational context.`);
  if(!machine.active)notes.push('Inactive machinery.');
  return `<tr><td>${esc(machine.name)}${machine.active?'':' <span class="inactive">Inactive</span>'}</td><td>${fmt(opening)}</td><td>${fmt(closing)}</td><td>${fmt(hours)}</td><td>${esc(status)}</td><td>${esc(provenance)}</td><td>${notes.length?notes.map(esc).join('<br>'):'—'}</td></tr>`;
 }).join('');
 const enteredBy=[...new Set(machines.map(machine=>manualReports(machine.id)?.[month]?.engineer).filter(Boolean))].join(', ')||'Not recorded';
 const title=`${state.data.vessel} - Monthly RH - ${year}-${String(month+1).padStart(2,'0')}`;
 report.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;color:#18323f;font:12px/1.45 Arial,sans-serif}header{display:flex;justify-content:space-between;align-items:start;border-bottom:2px solid #183f4d;padding-bottom:14px;margin-bottom:16px}h1{font-size:21px;margin:4px 0}h2{font-size:13px;margin:0 0 7px}.eyebrow{font-size:9px;letter-spacing:1.6px;color:#087f82;font-weight:bold}.meta{display:grid;grid-template-columns:repeat(3,minmax(130px,1fr));gap:8px;margin:12px 0 18px}.meta div{padding:9px;background:#f2f6f7;border:1px solid #e1eaec;border-radius:5px}.label{display:block;color:#637986;font-size:9px;text-transform:uppercase;letter-spacing:.6px}.value{display:block;margin-top:3px;font-weight:bold}.note{margin:8px 0 14px;padding:9px 11px;background:#fff8e9;border-left:3px solid #bf9145;color:#685936;font-size:10px}table{width:100%;border-collapse:collapse;font-size:9px}th{text-align:left;background:#183f4d;color:#fff;padding:8px 6px}td{padding:7px 6px;border-bottom:1px solid #dfe7ea;vertical-align:top}td:nth-child(2),td:nth-child(3),td:nth-child(4){white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}.inactive{display:inline-block;margin-left:4px;color:#6d7980;font-size:8px}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:35px}.signature{min-height:48px;border-top:1px solid #80919a;padding-top:5px;color:#667983;font-size:9px}.disclaimer{margin-top:18px;color:#647984;font-size:9px}.actions{display:flex;justify-content:flex-end;margin-bottom:14px}button{padding:8px 14px;border:0;border-radius:5px;background:#087f82;color:white;cursor:pointer}@page{size:A4 landscape;margin:12mm}@media print{body{padding:0}.actions{display:none}tr{break-inside:avoid}header,.meta,.note{break-inside:avoid}}
</style></head><body><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div><header><div><span class="eyebrow">MONTH-END PMS ATTACHMENT</span><h1>${esc(state.data.vessel)}</h1><h2>Machinery running-hours record · ${esc(months[month])} ${esc(year)}</h2></div><div class="label">Generated ${esc(new Date().toLocaleString())}</div></header><section class="meta"><div><span class="label">PMS job reference</span><span class="value">${esc($('pmsRef').value.trim()||'Not provided')}</span></div><div><span class="label">Recorded by</span><span class="value">${esc(enteredBy)}</span></div><div><span class="label">Machinery listed</span><span class="value">${machines.length} items</span></div></section><p class="note">Attach this month-specific record to the corresponding PMS job for office review and retention. RH is calculated from the recorded opening and closing meters where available. Missing values are not treated as zero. Screening notes require engineering review and are not a fault diagnosis or compliance certification.</p><table><thead><tr><th>Machinery</th><th>Opening meter</th><th>Closing meter</th><th>Monthly RH</th><th>Record status</th><th>Record source</th><th>Review notes</th></tr></thead><tbody>${reportRows}</tbody></table><section class="signatures"><div class="signature">Prepared by / Engine-room engineer · signature / date</div><div class="signature">Checked by / Chief Engineer · signature / date</div><div class="signature">Office review · name / date / remarks</div></section><p class="disclaimer">Generated from the local vessel dashboard. Source records and missing readings are shown as held; no unsupported hours have been inferred.</p></body></html>`);
 report.document.close();
 report.focus();
};
$('restore').onclick=()=>$('backupFile').click();
$('backupFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>5_000_000)throw Error('Backup exceeds 5 MB');const data=JSON.parse(await file.text());if(confirm('Restore this backup as the working dataset? Current data will be backed up automatically.')){if(await mutate({type:'import',data})){year=Object.keys(state.data.years).sort().at(-1);render();}}}catch(err){message(err.message);}finally{e.target.value='';}};
$('csv').onclick=()=>{const cell=x=>'"'+String(x??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';const lines=[['Machinery','Year','Month','Opening meter','Closing meter','Monthly RH','Screening','Data review','Source']];records().forEach(m=>{const r=state.data.years[year][m.id],reports=sourceReports(m.id),source=reports?.[month]||manualReports(m.id)?.[month];lines.push([m.name,year,months[month],source?source.begin:r[month],source?source.end:r[month+1],info(m).hours[month],status(m)|| (info(m).hours[month]==null?'Missing readings':'No alert'),(info(m).issues?.[month]||[]).join(' | '),source?(source.file?`${source.file} / ${source.sheet} / row ${source.row}`:`Manual / ${source.engineer} / ${source.updated_at}`):'']);});download(`machinery-${isDemo?'DEMO-':''}${year}-${months[month]}.csv`,'\ufeff'+lines.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');};
load();
