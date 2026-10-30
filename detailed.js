"use strict";
// Функция автономна: сериализуется браузером в изолированный мир каждого фрейма.
async function collectDetailed(options) {
 const started=performance.now(), limits={nodes:50000,text:20000000,ms:15000,css:2000000,resources:20000};
 const issues=[], counts={nodes:0,textChars:0,shadowRoots:0}, nodes=[];
 const error=(section,e)=>issues.push({section,reason:String(e?.message||e)});
 const secret=/password|passwd|secret|token|authorization|cookie|csrf|xsrf|nonce|api[-_]?key/i;
 const safeUrl=s=>{try{const u=new URL(s,location.href);if(!/^https?:$/.test(u.protocol))return u.protocol==='data:'?'[data URL]':u.protocol==='blob:'?'[blob URL]':s;u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(secret.test(k))u.searchParams.set(k,'[СКРЫТО]');if(u.hash)u.hash='[СКРЫТО]';return u.href;}catch{return String(s);}};
 const takeText=s=>{s=String(s||'');const left=Math.max(0,limits.text-counts.textChars);const t=s.slice(0,left);counts.textChars+=t.length;if(t.length<s.length&&!issues.some(x=>x.section==='text'))error('text','Достигнут общий лимит текста');return t;};
 let stable=false;
 if(options.wait){
  stable=await new Promise(resolve=>{let quiet,hard,done=false;const finish=v=>{if(done)return;done=true;observer.disconnect();clearTimeout(quiet);clearTimeout(hard);resolve(v);};const observer=new MutationObserver(()=>{clearTimeout(quiet);quiet=setTimeout(()=>finish(true),700);});observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});quiet=setTimeout(()=>finish(true),700);hard=setTimeout(()=>finish(false),4000);});
 }
 const stack=[{node:document.documentElement,parent:null,kind:'document'}];let remaining=0;
 while(stack.length){
  if(counts.nodes>=limits.nodes||performance.now()-started>limits.ms){remaining=stack.length;error('dom','Достигнут лимит узлов или времени; pending обозначает незавершенные ветви, а не число всех пропущенных узлов');break;}
  const {node:n,parent,kind}=stack.pop();if(!n)continue;
  const id=nodes.length;const rec={id,parent,kind,type:n.nodeType};nodes.push(rec);counts.nodes++;
  if(n.nodeType===3){rec.text=takeText(n.nodeValue);continue;}
  if(n.nodeType!==1&&n.nodeType!==11)continue;
  if(n.nodeType===1){
   rec.tag=n.localName;rec.attributes={};
   for(const a of n.attributes){rec.attributes[a.name]=secret.test(a.name)||a.name==='value'||a.name==='srcdoc'||a.name.startsWith('on')?'[СКРЫТО]':/^(href|src|action|poster)$/i.test(a.name)?safeUrl(a.value):takeText(a.value);}
   try{const r=n.getBoundingClientRect(),s=getComputedStyle(n);rec.rect={x:r.x,y:r.y,w:r.width,h:r.height};rec.style={display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,overflowX:s.overflowX,overflowY:s.overflowY};if(n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth)rec.scroll={top:n.scrollTop,left:n.scrollLeft,width:n.scrollWidth,height:n.scrollHeight};}catch(e){error('geometry',e);}
   if(n.matches('input,textarea,select'))rec.control={type:n.type,checked:n.checked,selectedIndex:n.selectedIndex,disabled:n.disabled,required:n.required,value:'[НЕ ЭКСПОРТИРУЕТСЯ]'};
   if(n.matches('details,dialog'))rec.open=n.open;
   if(n.matches('video,audio'))rec.media={currentTime:n.currentTime,duration:Number.isFinite(n.duration)?n.duration:null,paused:n.paused,muted:n.muted,readyState:n.readyState};
   if(n.matches('canvas'))rec.canvas={width:n.width,height:n.height,pixels:'не экспортируются'};
   if(n.matches('img'))rec.image={currentSrc:safeUrl(n.currentSrc),naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,complete:n.complete};
   if(n.matches('iframe,frame')){let accessible=false;try{accessible=!!n.contentDocument?.documentElement;}catch{}rec.frame={src:safeUrl(n.src),accessibleFromParent:accessible};}
   if(n.shadowRoot){counts.shadowRoots++;stack.push({node:n.shadowRoot,parent:id,kind:'shadowRoot'});}
   if(n.localName==='template')stack.push({node:n.content,parent:id,kind:'templateContent'});
  }
  // Не сохраняем исполняемые скрипты, значения форм и редактируемый пользователем текст.
  if(n.nodeType===1&&(n.matches('script,textarea')||n.isContentEditable)){rec.content='[ИСКЛЮЧЕНО]';continue;}
  for(let i=n.childNodes.length-1;i>=0;i--)stack.push({node:n.childNodes[i],parent:id,kind:'child'});
  if(counts.nodes%1000===0)await new Promise(r=>setTimeout(r,0));
 }
 const storage={};for(const name of ['localStorage','sessionStorage'])try{const st=window[name];storage[name]={count:st.length,keys:Array.from({length:st.length},(_,i)=>st.key(i)),values:'не экспортируются'};}catch(e){error(name,e);}
 try{storage.cookies={names:document.cookie.split(';').map(s=>s.trim().split('=')[0]).filter(Boolean),scope:'Только доступные document.cookie; без значений и HttpOnly. Это не полный список cookie браузера.'};}catch(e){error('cookies',e);}
 const sheets=[];let cssChars=0;
 const roots=[document];for(const n of document.querySelectorAll('*'))if(n.shadowRoot)roots.push(n.shadowRoot);
 for(const root of roots)for(const sheet of [...(root.styleSheets||[]),...(root.adoptedStyleSheets||[])]){
  const entry={href:sheet.href?safeUrl(sheet.href):null,disabled:sheet.disabled,rules:[]};sheets.push(entry);
  try{for(const rule of sheet.cssRules){if(cssChars+rule.cssText.length>limits.css){entry.truncated=true;break;}entry.rules.push(rule.cssText);cssChars+=rule.cssText.length;}}catch(e){entry.error=String(e.message);}
 }
 let resourceEntries=[];try{resourceEntries=performance.getEntriesByType('resource');}catch(e){error('performance',e);}
 const resources=resourceEntries.slice(0,limits.resources).map(r=>({name:safeUrl(r.name),type:r.initiatorType,duration:r.duration,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize}));
 if(resourceEntries.length>limits.resources)error('resources','Список ресурсов обрезан');
 let databases=[];try{if(indexedDB.databases)databases=(await indexedDB.databases()).map(d=>({name:d.name,version:d.version}));else error('indexedDB','Перечисление баз недоступно');}catch(e){error('indexedDB',e);}
 let cacheNames=[];try{if(window.caches)cacheNames=await caches.keys();}catch(e){error('cacheStorage',e);}
 return {schemaVersion:'3.0',capturedAt:new Date().toISOString(),url:safeUrl(location.href),title:document.title,readyState:document.readyState,doctype:document.doctype?.name||null,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY},documentSize:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},environment:{language:navigator.language,languages:navigator.languages,online:navigator.onLine,characterSet:document.characterSet,compatMode:document.compatMode},nodes,stylesheets:sheets,storage,indexedDB:databases,cacheNames,resources,coverage:{limits,counts,pendingBranches:remaining,waitRequested:options.wait,quietWindowObserved:stable,elapsedMs:Math.round(performance.now()-started),issues,limitations:['Снимок не атомарен: страница может изменяться во время обхода.','Закрытый Shadow DOM, память JavaScript, тела сетевых ответов и ранее выгруженные виртуализированные элементы не собираются.','Скрипты, значения полей, содержимое contenteditable, значения cookie и хранилищ исключены.','HTML/текст страницы, CSS и URL могут содержать персональные данные: автоматическое скрытие не гарантирует их полного удаления.','Ресурсы перечислены из доступного performance buffer, а не из полной истории сети.','Фреймы собираются только там, где браузер разрешает внедрение.']}};
}

async function detailedExport(tab){
 const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  setStatus('Собираю подробный снимок доступных фреймов…');
  const options={wait:!!delayEl.checked};let results=[],warnings=[];
  try{results=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},world:'ISOLATED',func:collectDetailed,args:[options]});}
  catch(e){warnings.push('Сбор всех фреймов не выполнен: '+e.message+'; выполнена попытка только основного фрейма.');results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:collectDetailed,args:[options]});}
  const frames=results.map(r=>({frameId:r.frameId,documentId:r.documentId,data:r.result||null,error:r.error?String(r.error):r.result?null:'Нет результата'}));
  const report={extensionVersion:'3.0.0',capturedAt:new Date().toISOString(),warnings,frames,notice:'Локальный диагностический снимок, не резервная копия авторизации. Список ответивших фреймов не доказывает доступность всех фреймов.'};
  const name='inspector_detailed_'+safeHost(tab.url)+'_'+tsStamp()+'.json';
  await downloadText(JSON.stringify(report,null,2),name,'application/json');
  setStatus('Подробный JSON сохранен: '+name+'\nОтветивших фреймов: '+frames.length+'\nОграничения и ошибки: coverage в каждом фрейме.','ok');
 }finally{buttons.forEach(b=>b.disabled=false);}
}
bind('snapshotDetailed',detailedExport);
