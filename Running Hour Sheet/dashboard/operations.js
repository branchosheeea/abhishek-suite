'use strict';
let reviewFilter = 'all';
let selectedMachine = null;
const reviewLabels = {all:'All review items',utilisation:'Utilisation alerts',idle:'No operation · 2+ months',exceptions:'Meter exceptions',missing:'Missing readings'};
function observation(m,n=month){return info(m).review[n];}
function needs(m,filter){const o=observation(m);return filter==='utilisation'?!!info(m).alerts[month]:filter==='idle'?o.zero_months>=2:filter==='exceptions'?o.exception:filter==='missing'?o.missing:!!info(m).alerts[month]||o.zero_months>=2||o.exception||o.missing;}
function comparisonText(o){return o.change_pct==null?'Comparison unavailable':`${fmt(Math.abs(o.change_pct))}% ${o.change_pct<0?'below':o.change_pct>0?'above':'change from'} recent average`;}
function baselineText(o){return o.baseline==null?'Needs three earlier usable months':`${fmt(o.baseline)} RH average · ${(o.baseline_labels||o.baseline_months.map(i=>months[i])).join(', ')}`;}
function renderOperations(rows){
 const counts={};Object.keys(reviewLabels).forEach(key=>counts[key]=rows.filter(m=>needs(m,key)).length);
 const usable=rows.filter(m=>observation(m).recorded&&!observation(m).exception).length;
 const cards=[
  ['utilisation','Utilisation alerts',counts.utilisation,'machines','Low or zero use against historical behaviour.'],
  ['idle','No operation · 2+ months',counts.idle,'machines','Consecutive recorded zeros; missing months break the sequence.'],
  ['exceptions','Meter exceptions',counts.exceptions,'machines','Continuity gaps, negative RH or calendar-hour exceptions.'],
  ['missing','Missing readings',counts.missing,'machines',`${usable} of ${rows.length} machines have usable RH without meter exceptions.`]
 ];
 $('metrics').innerHTML=cards.map(([key,label,value,unit,note])=>`<button class="metric metric-action ${reviewFilter===key?'chosen':''}" data-filter="${key}"><div class="metric-label">${label}</div><div class="metric-value">${value}<small>${unit}</small></div><p>${note}</p><span class="metric-link">Review machines →</span></button>`).join('');
 document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{reviewFilter=button.dataset.filter;render();$('engineeringPanel').scrollIntoView({behavior:'smooth',block:'start'});});
 if(!rows.some(m=>m.id===selectedMachine))selectedMachine=(rows.find(m=>needs(m,'utilisation'))||rows.find(m=>needs(m,'exceptions'))||rows[0])?.id;
 $('trendMachine').innerHTML=rows.map(m=>`<option value="${esc(m.id)}" ${m.id===selectedMachine?'selected':''}>${esc(m.name)}</option>`).join('');
 renderEquipmentTrend(rows);
 const ranked=rows.filter(m=>observation(m).change_pct!=null&&observation(m).change_pct<0).sort((a,b)=>observation(a).change_pct-observation(b).change_pct).slice(0,6);
 $('rankSubtitle').textContent=`${months[month]} ${year} · compared with each machine’s own previous three usable months`;
 $('ranking').innerHTML=ranked.length?ranked.map(m=>{const o=observation(m);return `<button class="reduction-row" data-trend="${esc(m.id)}"><div><strong>${esc(m.name)}</strong><span>${fmt(info(m).hours[month])} RH this month · ${baselineText(o)}</span></div><b>${fmt(Math.abs(o.change_pct))}%<small>reduction</small></b></button>`;}).join('')+`<p class="footnote">A reduction can reflect port/sea duty or standby allocation. It is not a fault diagnosis. Missing or questioned readings are excluded from this comparison.</p>`:empty('No reductions with sufficient usable history in this selection.');
 document.querySelectorAll('[data-trend]').forEach(b=>b.onclick=()=>{selectedMachine=b.dataset.trend;$('trendMachine').value=selectedMachine;renderEquipmentTrend(rows);});
 $('trendMachine').onchange=e=>{selectedMachine=e.target.value;renderEquipmentTrend(rows);};
 $('reviewContext').textContent=`${months[month]} ${year} · ${counts.all} distinct machines with review items. Categories can overlap; counts are not additive.`;
}
function renderEquipmentTrend(rows){
 const machine=rows.find(m=>m.id===selectedMachine);
 if(!machine){$('trend').innerHTML=empty('No machinery in this reporting year.');return;}
 const data=info(machine),o=observation(machine),peak=Math.max(1,...data.hours.filter(valid));
 $('trend').innerHTML=`<div class="equipment-summary"><div><span>${months[month]} running hours</span><strong>${fmt(data.hours[month])}<small> RH</small></strong></div><div><span>Previous three usable months</span><strong>${o.baseline==null?'—':fmt(o.baseline)}<small> RH average</small></strong></div></div><div class="bars">${data.hours.map((h,n)=>`<div class="bar-wrap" title="${months[n]}: ${h==null?'Missing':fmt(h)+' RH'}${data.issues?.[n]?.length?' · review meter':''}"><span class="bar-number">${fmt(h)}</span><div class="bar ${n===month?'selected':''} ${data.issues?.[n]?.length||h<0?'questioned':''}" style="height:${valid(h)?Math.max(2,h/peak*150):0}px"></div><span class="bar-label">${months[n]}</span></div>`).join('')}</div><div class="trend-summary"><span>${o.exception?'Meter exception — comparison withheld':comparisonText(o)}</span><button id="inspectTrend">Inspect source →</button></div><p class="footnote">${baselineText(o)}. Last positive reading in the repository: ${o.last_run_label||'not established'}. ${o.zero_months?o.zero_months+' consecutive zero month(s) recorded. ':''}Purple bars need meter review.</p>`;
 $('inspectTrend').onclick=()=>openEditor(machine.id);
}
function renderReview(rows){
 $('reviewFilters').innerHTML=Object.entries(reviewLabels).map(([key,label])=>`<button class="filter-pill ${reviewFilter===key?'selected':''}" aria-pressed="${reviewFilter===key}" data-review-filter="${key}">${label} <b>${rows.filter(m=>needs(m,key)).length}</b></button>`).join('');
 document.querySelectorAll('[data-review-filter]').forEach(b=>b.onclick=()=>{reviewFilter=b.dataset.reviewFilter;render();});
 const priority=m=>observation(m).exception?0:observation(m).zero_months>=2?1:info(m).alerts[month]?2:3;
 const list=rows.filter(m=>needs(m,reviewFilter)).sort((a,b)=>priority(a)-priority(b)||observation(b).zero_months-observation(a).zero_months||a.name.localeCompare(b.name));
 $('reviewCount').textContent=`${list.length} MACHINES`;
 $('reviews').innerHTML=list.length?list.map(m=>{
  const i=info(m),o=observation(m),tags=[],notes=[];
  if(o.exception){tags.push('<span class="badge error">Verify meter</span>');notes.push(...(i.issues?.[month]||[]));if(i.hours[month]<0)notes.push('Negative RH: verify the entry or document a meter reset.');}
  if(o.zero_months>=2){tags.push(`<span class="badge red">${o.zero_months} zero months</span>`);notes.push(`No recorded operation from ${o.zero_since||months[month-o.zero_months+1]} through ${months[month]} ${year}. Check duty/standby arrangements and operation records.`);}
  if(i.alerts[month]){tags.push(`<span class="badge ${i.alerts[month]}">${i.alerts[month]==='amber'?'Low utilisation':'No utilisation'}</span>`);notes.push(`${fmt(i.hours[month-1]+i.hours[month])} RH over ${months[month-1]}–${months[month]}; adaptive historical screening triggered.`);}
  if(o.missing){tags.push('<span class="badge">Missing RH</span>');notes.push(...(i.issues?.[month]||[]));notes.push('Obtain the missing opening/closing readings, or confirm whether this equipment should be monitored.');}
  return `<div class="review"><div class="review-content"><strong>${esc(m.name)}</strong><div class="review-tags">${tags.join(' ')}</div>${notes.map(n=>`<p>${esc(n)}</p>`).join('')}</div><div class="review-value">${fmt(i.hours[month])}<small>${months[month]} RH</small></div><button data-edit="${esc(m.id)}">Inspect →</button></div>`;
 }).join(''):empty(`No machines in “${esc(reviewLabels[reviewFilter])}” for ${months[month]}. This is not confirmation of changeover compliance.`);
}
