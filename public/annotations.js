// Model output is data, never HTML. Only unambiguous, non-overlapping source spans
// can receive a gloss; a whole expression may have one meaning.
export function validateGlosses(text, items) {
  if (!Array.isArray(items)) return [];
  const result = [], units=sourceUnits(text);
  for (const item of items.slice(0, 3000)) {
    const indexed = units[item?.index];
    if (Number.isInteger(item?.index) && indexed && (!item.source || item.source===indexed.source) && typeof item.meaning === 'string' && item.meaning.trim() && item.meaning.length <= 120) {
      if (!result.some(span => indexed.start < span.end && indexed.end > span.start)) result.push({...indexed,meaning:item.meaning.trim()});
      continue;
    }
    if (typeof item?.source !== 'string' || typeof item?.meaning !== 'string') continue;
    const source = item.source.trim(), meaning = item.meaning.trim();
    if (!source || source.length > 80 || !meaning || meaning.length > 80) continue;
    const start = text.indexOf(source), end = start + source.length;
    if (start < 0 || text.indexOf(source, start + 1) !== -1) continue;
    // Do not attach a Latin/Cyrillic fragment to the middle of a word.
    if (/^[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(source) && /[\p{L}\p{N}]$/u.test(text.slice(0,start))) continue;
    if (/[\p{Script=Latin}\p{Script=Cyrillic}]$/u.test(source) && /^[\p{L}\p{N}]/u.test(text.slice(end))) continue;
    if (result.some(span => start < span.end && end > span.start)) continue;
    result.push({start,end,source,meaning});
  }
  return result.sort((a,b) => a.start-b.start);
}

export function compatibleSource(current, snapshot) {
  return current===snapshot || (current.startsWith(snapshot) && /\s/u.test(current[snapshot.length] || ''));
}

export function renderAnnotated(container, text, glosses, targetLanguage, options = {}) {
  container.replaceChildren();
  const spans = validateGlosses(text, glosses);
  for (const unit of sourceUnits(text)) {
    const span = spans.find(span => span.start <= unit.start && span.end >= unit.end);
    const group = document.createElement('span'); group.className = 'word-hint';
    const original = document.createElement(options.onPeek ? 'button' : 'span'); original.className = 'word-source'; original.textContent = unit.source;
    if(options.onPeek){original.type='button';original.setAttribute('aria-label',unit.source+': посмотреть значение');original.onclick=()=>options.onPeek(unit.index);}
    const meaning = document.createElement('button'); meaning.type='button'; meaning.className = 'word-meaning'; meaning.textContent = span?.meaning || ''; meaning.lang = targetLanguage; meaning.dir = 'auto';
    meaning.hidden=Boolean(options.concealed);meaning.disabled = !span; meaning.setAttribute('aria-label',span ? `${unit.source}: ${span.meaning}` : `${unit.source}: перевод ожидается`);
    if (span) {meaning.title=span.meaning;meaning.onclick=()=>{
      const dialog=document.getElementById('wordDialog');
      if (dialog) {document.getElementById('wordOriginal').textContent=span.source;document.getElementById('wordMeaning').textContent=span.meaning;dialog.showModal();}
    };}
    group.append(original,meaning); container.append(group);
  }
}

// Unit identities depend only on the source, independently of translated meanings.
export function sourceUnits(text) {
  return [...text.matchAll(/\S+/gu)].map((match,index)=>({index,source:match[0],start:match.index,end:match.index+match[0].length}));
}

export function validateInterlinear(text, items, complete = false) {
  const units=sourceUnits(text), byIndex=new Map();
  for(const item of items || []) {
    if (!Number.isInteger(item?.index) || !units[item.index] || typeof item.meaning !== 'string' || !item.meaning.trim() || item.meaning.length>120 || byIndex.has(item.index)) continue;
    if (/[\p{L}\p{N}]/u.test(units[item.index].source) && !/[\p{L}\p{N}]/u.test(item.meaning)) continue;
    byIndex.set(item.index,{...units[item.index],meaning:item.meaning.trim()});
  }
  const result=[...byIndex.values()].sort((a,b)=>a.index-b.index);
  if(complete && result.length!==units.length) throw new Error('Подстрочный перевод покрывает не все слова.');
  return result;
}

// Compact model wire format: one meaning per source unit in the supplied order.
// Only closed JSON strings are exposed while the model is still streaming.
export function parseMeaningPrefix(content) {
  const match=/"meanings"\s*:\s*\[/.exec(content);if(!match)return [];
  const items=[];let start=-1,escaped=false;
  for(let i=match.index+match[0].length;i<content.length;i++) {
    const ch=content[i];
    if(start>=0){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"'){try{items.push(JSON.parse(content.slice(start,i+1)));}catch{return items;}start=-1;}}
    else if(ch==='"')start=i;else if(ch===']')break;else if(!/[\s,]/.test(ch))break;
  }
  return items;
}

// Read only complete objects from a streaming JSON gloss array. Braces inside
// quoted strings and escaped quotes must not terminate an object early.
export function parseGlossPrefix(content) {
  const match=/"glosses"\s*:\s*\[/.exec(content);
  if (!match) return [];
  const items=[];let depth=0,start=-1,quoted=false,escaped=false;
  for(let i=match.index+match[0].length;i<content.length;i++) {
    const ch=content[i];
    if (quoted) {if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;continue;}
    if(ch==='{'){if(depth++===0)start=i;}
    else if(ch==='}' && depth>0 && --depth===0) {
      try{items.push(JSON.parse(content.slice(start,i+1)));}catch{}
      if(items.length===600)return items;
    } else if(ch===']' && depth===0)break;
  }
  return items;
}
