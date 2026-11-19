// nabeel-inbox — temp-email inbox viewer API for nabeelali.is-a.dev.
// Netlify serverless function. Ported from the Vercel version
// (~/workspace/nabeel-inbox-vercel/api/index.js); the provider logic is
// unchanged — only the entry point differs (Netlify event adapter around
// the same fetch handler).
// The function is served at /.netlify/functions/index — the site calls it
// with the route appended, e.g. /.netlify/functions/index/inbox?email=...
// (no redirects needed: the adapter strips the function prefix).
// Ported from the fakemailbot tgcloud code (~/workspace/tgcloud-fakemail):
//   lib/mail.js  (provider clients, inbox routing, normalization)
//   lib/smart.js (OTP-code + activation-link extraction)
//   lib/email_clean.js (HTML -> text cleaning)
// Inbox viewing ONLY — no address creation, no persistence of message
// bodies, codes, or activation URLs. Inboxes are public by design.
// Visible domains — the ONLY visibility gate. These are the bot's live
// visible domains (read from the bot DB 2026-11-19). Hidden domains must
// never appear here; a future unhide = update this list + redeploy.
const VISIBLE_DOMAINS = ["gmail10p.com","oegmail.com","oemails.com","oletters.com","rommiui.com","suiemail.com","tempmail.edu.pl","voewo.com","yanemail.com"];

// ---------------------------------------------------------------------------
// Providers (mail.js). No auth needed for any mail provider.
// ---------------------------------------------------------------------------
const USMAIL_BASE = 'https://usmail.my.id';
const TM_BASE = 'https://api.internal.temp-mail.io/api';
const MS_BASES = [
  'https://mail-server.1timetech.com/api',
  'https://mail-server-2.1timetech.com/api'
];
const ENATOR_BASE = 'https://www.emailnator.com/api';

const TM_DOMAINS = [
  'yzcalo.com', 'lnovic.com', 'ruutukf.com', 'gmeenramy.com',
  'olipii.com', 'ooynib.com', 'tanpony.com'
];
const HD_DOMAINS = [
  'voewo.com', 'yanemail.com', 'gmail10p.com', 'oletters.com',
  'oemails.com', 'oegmail.com', 'suiemail.com', 'rommiui.com', 'tempmail.edu.pl'
];

const USMAIL_TIMEOUT_MS = 4000;
const PROVIDER_TIMEOUT_MS = 6000;

const domainOf = email => String(email || '').split('@').pop()?.toLowerCase() || '';

// ---------------------------------------------------------------------------
// Bounded fetch + JSON call (mail.js fetchBounded / callJson)
// ---------------------------------------------------------------------------
async function fetchBounded(url, options, timeoutMs, fetchFn) {
  let controller;
  try { if (typeof AbortController !== 'undefined') controller = new AbortController(); } catch {}
  const requestOptions = { ...options, ...(controller ? { signal: controller.signal } : {}) };
  if (typeof setTimeout !== 'function') {
    const response = await fetchFn(url, requestOptions);
    return { response, text: await response.text() };
  }
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch {}
      reject(new Error('UPSTREAM_TIMEOUT'));
    }, timeoutMs);
  });
  const pending = (async () => {
    const response = await fetchFn(url, requestOptions);
    return { response, text: await response.text() };
  })();
  pending.catch(() => {});
  try { return await Promise.race([pending, timed]); }
  finally { try { clearTimeout(timer); } catch {} }
}

async function callJson(method, url, body, fetchFn) {
  try {
    const { response, text } = await fetchBounded(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }, PROVIDER_TIMEOUT_MS, fetchFn);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, json, text,
      errorCode: response.ok ? (json == null ? 'INVALID_JSON' : '') : `HTTP_${response.status}` };
  } catch (e) {
    const timeout = String(e?.message ?? e) === 'UPSTREAM_TIMEOUT';
    return { ok: false, status: 0, json: null, text: '',
      errorCode: timeout ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR' };
  }
}

// usmail.my.id client (mail.js request) — non-throwing variant for API use.
async function usmailRequest(method, path, body, fetchFn) {
  try {
    const { response, text } = await fetchBounded(USMAIL_BASE + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }, USMAIL_TIMEOUT_MS, fetchFn);
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, payload };
  } catch (e) {
    const timeout = String(e?.message ?? e) === 'UPSTREAM_TIMEOUT';
    return { ok: false, status: timeout ? 522 : 0, payload: null,
      errorCode: timeout ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR' };
  }
}

// ---------------------------------------------------------------------------
// 1TimeTech obfuscated envelope (mail.js decodeEnvelope / msCall)
// Outer JSON {data: "<reversed base64url>"} — reverse, -_/ -> +/ swapped,
// base64-decode, JSON-parse.
// ---------------------------------------------------------------------------
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64ToBytes(b64) {
  const bytes = [];
  let acc = 0, bits = 0;
  for (const ch of b64) {
    if (ch === '=') break;
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(bytes);
}
function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i++; }
    else if (b < 0xe0) {
      s += String.fromCharCode(((b & 31) << 6) | ((bytes[i + 1] ?? 0) & 63)); i += 2;
    } else if (b < 0xf0) {
      s += String.fromCharCode(((b & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) |
        ((bytes[i + 2] ?? 0) & 63)); i += 3;
    } else {
      const cp = ((b & 7) << 18) | (((bytes[i + 1] ?? 0) & 63) << 12) |
        (((bytes[i + 2] ?? 0) & 63) << 6) | ((bytes[i + 3] ?? 0) & 63);
      const c = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)); i += 4;
    }
  }
  return s;
}
export function decodeEnvelope(text) {
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer.data === 'string') {
      const b64 = outer.data.split('').reverse().join('').replaceAll('-', '+').replaceAll('_', '/');
      return JSON.parse(utf8Decode(b64ToBytes(b64)));
    }
    return outer;
  } catch { return null; }
}
async function msCall(method, path, body, fetchFn) {
  let last = { ok: false, status: 0, json: null, errorCode: 'UPSTREAM_UNAVAILABLE' };
  for (const base of MS_BASES) {
    const r = await callJson(method, base + path, body, fetchFn);
    if (r.status === 200) {
      const decoded = decodeEnvelope(r.text);
      if (decoded != null) return { ok: true, status: 200, json: decoded, errorCode: '' };
      last = { ok: false, status: 502, json: null, errorCode: 'INVALID_ENVELOPE' };
    } else {
      last = { ok: false, status: r.status, json: null, errorCode: r.errorCode };
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Message normalization (mail.js). All providers yield the same visible
// keys: from, subject, text, html, receivedAt.
// ---------------------------------------------------------------------------
function scalar(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function firstValue(...values) {
  for (const value of values) {
    const s = scalar(value).trim();
    if (s) return s;
  }
  return '';
}
function addressOf(value) {
  if (Array.isArray(value)) return value.map(addressOf).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const name = firstValue(value.name, value.displayName, value.display_name);
    const address = firstValue(value.address, value.email, value.mail, value.value);
    return name && address && !name.includes(address) ? `${name} <${address}>` : name || address;
  }
  return scalar(value);
}
export function messageId(value) {
  return value?.id ?? value?._id ?? value?.messageId ?? value?.message_id ?? null;
}
function isHtml(value) { return /<\s*\/?[a-z][^>]*>/iu.test(value); }
function addSource(list, value, forceHtml) {
  if (Array.isArray(value)) { for (const v of value) addSource(list, v, forceHtml); return; }
  if (value && typeof value === 'object') {
    const htmlHint = /html/i.test(String(value.type ?? value.mimeType ?? ''));
    addSource(list, value.text ?? value.plain ?? value.bodyText, false);
    addSource(list, value.html ?? value.bodyHtml, true);
    addSource(list, value.content ?? value.body ?? value.value, htmlHint ? true : forceHtml);
    return;
  }
  const s = scalar(value);
  if (!s.trim()) return;
  list.push({ html: forceHtml === true || (forceHtml == null && isHtml(s)), value: s });
}
function collectMessageSources(raw) {
  const sources = [];
  if (!raw || typeof raw !== 'object') return sources;
  for (const key of ['text', 'bodyText', 'plain', 'textBody', 'body_text', 'text_body',
    'messageText', 'message_text']) addSource(sources, raw[key], false);
  for (const key of ['body', 'message']) addSource(sources, raw[key], null);
  for (const key of ['html', 'bodyHtml', 'htmlBody', 'body_html', 'html_body',
    'contentHtml', 'content_html']) addSource(sources, raw[key], true);
  addSource(sources, raw.content, null);
  return sources;
}
function uniqueSources(sources) {
  const seen = new Set();
  const distinct = [];
  for (const part of sources) {
    const normalized = part.value.replace(/\s+/gu, ' ').trim();
    const key = `${part.html ? 'h' : 't'}|${normalized}`;
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    distinct.push({ ...part, normalized });
  }
  // Drop a preview only when its entire content is preserved in a bigger source.
  return distinct.filter((part, i) => !distinct.some((other, j) => j !== i &&
    other.html === part.html && other.normalized.length > part.normalized.length &&
    other.normalized.includes(part.normalized)));
}
export function normItem(raw, summary = null) {
  if (!raw || typeof raw !== 'object') raw = {};
  const base = summary && typeof summary === 'object' ? summary : {};
  const sources = uniqueSources([
    ...collectMessageSources(raw), ...collectMessageSources(base)
  ]);
  const texts = sources.filter(part => !part.html).map(part => part.value);
  const htmls = sources.filter(part => part.html).map(part => part.value);
  const from = addressOf(raw.fromText || raw.from || raw.fromAddress || raw.sender ||
    raw.senderAddress || raw.from_address) ||
    addressOf(base.fromText || base.from || base.fromAddress || base.sender ||
      base.senderAddress || base.from_address);
  const at = raw.receivedAt ?? raw.createdAt ?? raw.date ?? raw.timestamp ??
    raw.received_at ?? raw.created_at ?? base.receivedAt ?? base.createdAt ??
    base.date ?? base.timestamp ?? base.received_at ?? base.created_at;
  const merged = {
    ...base, ...raw,
    ...(messageId(base) != null ? { id: messageId(base) } : {}),
    from, sender: from,
    subject: firstValue(raw.subject, raw.title, base.subject, base.title),
    text: texts[0] ?? '',
    html: htmls[0] ?? '',
    textBody: texts.slice(1).join('\n\n[Alternative text source]\n'),
    htmlBody: htmls.slice(1).join('\n<hr>\n'),
    ...(at != null ? { receivedAt: at } : {}),
    detailSourceCount: sources.length
  };
  merged.detailBodyChars = sources.reduce((sum, part) => sum + part.value.length, 0);
  return merged;
}
// Some provider detail APIs wrap the message under data/message/result.
// Unwrap only objects, never assume a success envelope is itself a message.
function detailObject(payload) {
  let value = payload;
  for (let depth = 0; depth < 4 && value && typeof value === 'object' &&
    !Array.isArray(value); depth++) {
    const hasMessageFields = ['text', 'html', 'body', 'content', 'bodyText',
      'bodyHtml', 'subject', 'from', 'fromText', 'sender'].some(key =>
      value[key] != null && value[key] !== '');
    if (hasMessageFields) break;
    const next = [value.data, value.message, value.result, value.payload]
      .find(part => part && typeof part === 'object' && !Array.isArray(part));
    if (!next || next === value) break;
    value = next;
  }
  return value;
}
function hasBody(item) { return Boolean(item?.text?.trim() || item?.html?.trim() ||
  item?.textBody?.trim() || item?.htmlBody?.trim()); }
function annotate(item, status, errorCode = '') {
  return { ...item, detailStatus: status, enrichStatus: status,
    detailErrorCode: errorCode, detailSourceCount: item.detailSourceCount ?? 0,
    detailBodyChars: item.detailBodyChars ?? 0 };
}

export function decodeMessages(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of ['emails', 'messages', 'inbox', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ['data', 'result', 'payload']) {
    if (value[key] != null) {
      const nested = decodeMessages(value[key], depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML -> text cleaning (email_clean.js, verbatim)
// ---------------------------------------------------------------------------
const NAMED = {
  amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',
  ndash:'–',mdash:'—',hellip:'…',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',
  zwnj:'',zwj:'',zwsp:'',shy:'',lrm:'',rlm:'',thinsp:' ',ensp:' ',emsp:' ',
  hairsp:' ',numsp:' ',bull:'•',lbrack:'[',rbrack:']',newline:'\n'
};
export function decodeEntities(value){
  let text=String(value??'');
  for(let i=0;i<4;i++){
    const next=text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]{1,30});?/gi,(whole,key)=>{
      const k=key.toLowerCase();
      if(Object.hasOwn(NAMED,k))return NAMED[k];
      if(k.startsWith('#')){
        const hex=k.startsWith('#x');
        const num=Number.parseInt(k.slice(hex?2:1),hex?16:10);
        if(Number.isInteger(num)&&num>0&&num<=0x10ffff && !(num>=0xd800&&num<=0xdfff))return String.fromCodePoint(num);
      }
      return whole;
    });
    if(next===text)break;
    text=next;
  }
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad\u034f]/g,'');
}
export function cleanEmailBody(input){
  return decodeEntities(decodeEntities(input)
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<(script|style|head|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<img\b[^>]*>/gi,' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi,'\n')
    .replace(/<\/(?:p|div|table|tr|li|ul|ol|h[1-6]|section|article|blockquote)\s*>/gi,'\n')
    .replace(/<\/(?:td|th)\s*>/gi,' ')
    .replace(/<[^>]+>/g,' '))
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+\.(?:png|jpg|jpeg|gif|svg|webp|ico)(?:\?[^\s<>"']*)?/gi,' ')
    .replace(/[ \t\u00a0\u2000-\u200a\u202f]+/g,' ')
    .replace(/\r\n?|\u2028|\u2029/g,'\n')
    .replace(/ *\n */g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
// Body segments: like cleanEmailBody, but <a href> anchors survive as
// {t:'link', v:label, u:url} segments so the detail view can render
// inline links tappable ("تعرف على المزيد" etc.). Only http(s) hrefs
// with a non-empty label become links; everything else is plain text.
// No HTML is ever returned — the frontend escapes text and validates
// URLs itself, so a malicious email cannot inject markup.
export function bodySegments(htmlSource) {
  const raw = String(htmlSource || '');
  if (!raw) return null;
  const html = decodeEntities(decodeEntities(raw)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' '));
  const cleanChunk = s => s
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|table|tr|li|ul|ol|h[1-6]|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+\.(?:png|jpg|jpeg|gif|svg|webp|ico)(?:\?[^\s<>"']*)?/gi, ' ')
    .replace(/[ \t\u00a0\u2000-\u200a\u202f]+/g, ' ')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  const segs = [];
  const pushText = s => {
    const v = cleanChunk(s);
    if (!v) return;
    if (segs.length && segs[segs.length - 1].t === 'text') segs[segs.length - 1].v += v;
    else segs.push({ t: 'text', v });
  };
  const anchorRe = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let last = 0, m;
  while ((m = anchorRe.exec(html))) {
    if (m.index > last) pushText(html.slice(last, m.index));
    const href = (m[1] || m[2] || m[3] || '').trim();
    const label = decodeEntities(m[4].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/^https?:\/\//i.test(href) && label) segs.push({ t: 'link', v: label, u: href });
    else if (label) pushText(label);
    last = anchorRe.lastIndex;
  }
  if (last < html.length) pushText(html.slice(last));
  if (segs.length && segs[0].t === 'text') segs[0].v = segs[0].v.replace(/^\s+/, '');
  if (segs.length && segs[segs.length - 1].t === 'text') segs[segs.length - 1].v = segs[segs.length - 1].v.replace(/\s+$/, '');
  const out = segs.filter(s => s.t === 'link' || s.v);
  return out.length ? out : null;
}
export function bodyCandidates(mail){
  const m=mail&&typeof mail==='object'?mail:{text:String(mail??'')};
  const plain=[],html=[];
  function add(value,target,depth=0){
    if(depth>2||value==null)return;
    if(typeof value==='string')target.push(value);
    else if(Array.isArray(value))for(const item of value)add(item,target,depth+1);
    else if(typeof value==='object')for(const key of ['text','plain','body','content','html']){
      if(key in value)add(value[key],key==='html'?html:target,depth+1);
    }
  }
  for(const key of ['body_text','plain_text','text','textBody','body','content','message','data'])add(m[key],plain);
  for(const key of ['html','body_html','html_body','htmlBody'])add(m[key],html);
  if(!plain.length&&!html.length){add(m.snippet,plain);add(m.preview,plain);}
  return {plain,html,all:[...plain,...html]};
}

// ---------------------------------------------------------------------------
// Read-only mailbox analysis (smart.js, verbatim)
// ---------------------------------------------------------------------------
const S = value => {
  if(typeof value==='string')return value;
  if(value==null)return '';
  if(typeof value==='object')return String(value.address||value.email||value.name||value.text||'');
  return String(value);
};
const unescapeHTML=decodeEntities;
function info(mail){
  const m=mail&&typeof mail==='object'?mail:{text:S(mail)};
  const sender=S(m.from_address||m.from||m.sender)||'غير معروف';
  const subject=S(m.subject||m.title);
  const all=bodyCandidates(mail).all;
  const unique=[];
  const seen=new Set();
  for(const source of all){
    const cleaned=cleanEmailBody(source);
    if(!cleaned || seen.has(cleaned))continue;
    unique.push(cleaned);
    seen.add(cleaned);
  }
  // Choose a single source for display: don't concatenate HTML+plain duplicates.
  const rank=text=>Math.min(100000,text.length)-Math.min(2000,(text.match(/https?:\/\//g)||[]).length*12);
  const fullText=unique.slice().sort((a,b)=>rank(b)-rank(a))[0]||'محتوى الرسالة غير متاح من مزود البريد.';
  const raw=unescapeHTML(all.join('\n').slice(0,100000));
  const searchText=unique.join('\n').slice(0,120000);
  return {sender,subject,raw,plain:fullText,fullText,compact:fullText,searchText,
    hasBody:unique.length>0};
}
const ACTION_WORD=/verify|verification|confirm|activation|activate|magic[-_]?link|one[-_]?time|sign.?in|login|auth|validate|password|reset|invite|approve|secure|token|\bepr\b|التحقق|التأكيد|التفعيل|تأكيد|دخول|إنشاء حساب|حسابك|verifikasi/i;
const MEDIA=/\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|mp4|webm|pdf)(?:[?#]|$)/i;
const BAD_LINK=/unsubscribe|opt.?out|preferences|privacy|pixel|tracking|\bassets?\b|cdn|static|images|\/help|\/support|\/contact|\/terms|\/legal/i;
function actionLinks(content) {
  const src=content.raw+'\n'+content.plain;
  const rx=/(?:https?:\/\/|www\.)[^\s<>"'`\\\]\[\u00a0]+/gi;
  const best=new Map(); let m;
  while((m=rx.exec(src)) && best.size<100) {
    let url=unescapeHTML(m[0]).replace(/[.,;!?،؛"'<>]+$/g,'').replace(/[\]}]+$/g,'');
    while(url.endsWith(')') && (url.match(/\(/g)||[]).length < (url.match(/\)/g)||[]).length) url=url.slice(0,-1);
    if(/^www\./i.test(url)) url='https://'+url;
    if(url.length>2500 || !/^https?:\/\//i.test(url)) continue;
    const parsed=url.match(/^(https?):\/\/([^\/\?#]+)([^?#]*)(\?[^#]*)?/i);
    if(!parsed) continue;
    const hostname=parsed[2].split(':')[0];
    if(!hostname.includes('.')) continue;
    const pathname=parsed[3]||'/';
    const search=parsed[4]||'';
    if(MEDIA.test(pathname+search) || MEDIA.test(url)) continue;
    const path=pathname.toLowerCase();
    const params=search.slice(1).split('&').filter(Boolean)
      .map(p=>{ try { return decodeURIComponent(p.split('=')[0]||''); } catch { return p.split('=')[0]||''; } })
      .join(' ').toLowerCase();
    const around=src.slice(Math.max(0,m.index-160),m.index+m[0].length+160);
    let score=0;
    if(ACTION_WORD.test(path+' '+params)) score+=12;
    if(/^(code|verification_code|verification-code|token|auth|otp|ticket|key|confirmation|confirm|verification|invite)$/i.test(params.trim()))score+=5;
    if(/(?:[?&](?:code|token|auth|otp|verification[_-]?code|ticket|key|confirmation|verify)=)/i.test(url)) score+=14;
    if(ACTION_WORD.test(around)) score+=3;
    if(ACTION_WORD.test(content.subject)) score+=1;
    if(/^https:\/\//i.test(url)) score+=1;
    if(BAD_LINK.test(url)) score-=24;
    if(/\.nflxext\.com|\/assets[_/]|\/images[_/]/i.test(url))score-=25;
    // No link just because the email is about signing up; link itself needs action characteristics.
    if(score<9) continue;
    const prev=best.get(url);
    if(prev==null || score>prev)best.set(url,score);
  }
  return [...best].sort((a,b)=>b[1]-a[1]).slice(0,2).map(x=>x[0]);
}
const MARKER=/(?:verification|confirmation|security|authentication|activation|login|sign[ -]?in|access|recovery|reset)\s*(?:code|pin|passcode|password|token)|(?:one[- ]?time\s*(?:password|code|pin)|(?:otp|2fa|mfa)\s*(?:code|is)?|(?:code|passcode|pin|token)\s*(?:is|:|=))|(?:رمز|كود|شفرة)\s*(?:التحقق|التأكيد|التفعيل|الدخول|الأمان|المصادقة|الخاص\s*بك)?|كلمة\s*المرور\s*لمرة\s*واحدة|kode\s*(?:verifikasi|otp|aktivasi|konfirmasi)?/gi;
const IGNORE=new Set('the this your code verify verification confirm confirmation security create created meta platforms netflix account email use enter please following below above next number text otp login password token click here sent from thanks team expires valid code is are was and for with to a an our we of or that he she it new hi hello dear minutes minute hours hour you user pin use only never not if were will create creating berikut adalah kode verifikasi anda mengkonfirmasi التالي ادخل الرمز رمز التأكيد التحقق كود'.split(/\s+/));
function validToken(value, adjacent) {
  const token=String(value||'').replace(/^[\s:='"`]+|[\s.,:;!?،؛'"`]+$/g,'');
  if(token.length<4 || token.length>40 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token) || IGNORE.has(token.toLowerCase()))return null;
  const numeric=/^\d+$/.test(token), hasDigit=/\d/.test(token), caps=/^[A-Z]{4,16}$/.test(token);
  if(numeric && (token.length>10 || /^20\d\d$/.test(token)))return null;
  // Plain proper nouns MUST NEVER be treated as codes, e.g. Meta or Platforms.
  if(!hasDigit && !caps && !adjacent) return null;
  // Accept lowercase and genuinely mixed-case letter codes; exclude Title Case proper nouns.
  if(!hasDigit && !caps && adjacent && (!/^[A-Za-z]{4,16}$/.test(token) || /^[A-Z][a-z]+$/.test(token)))return null;
  return token;
}
function verificationCodes(content) {
  const clean=(content.subject+'\n'+(content.searchText||content.plain))
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'`\]]+/gi,' ')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,' ');
  // A brand word from the subject/sender is never a code, even when it
  // is mixed-case (ChatGPT) and sits after a verification marker in a
  // subject like "رمز التحقق ... لتطبيق ChatGPT".
  const brandWords=new Set(String((content.sender||'')+' '+(content.subject||''))
    .toLowerCase().split(/[^a-z0-9]+/i).filter(w=>w.length>=3));
  const found=new Map();
  const put=(c,score)=>{ if(!c)return;
    if(!/\d/.test(c) && brandWords.has(String(c).toLowerCase()))return;
    if(score>(found.get(c)||0))found.set(c,score); };
  // Many Instagram emails put the code BEFORE the words "is your Instagram code".
  const leadingCode=/(?:^|[\s.!?])([A-Za-z0-9]{4,14}(?:[-_][A-Za-z0-9]{2,10})?)\s+(?:is|was)\s+(?:your|the|a)\s+(?:[A-Za-z]{2,24}\s+){0,5}(?:code|otp|pin)\b/gi;
  let lead;
  while((lead=leadingCode.exec(clean))) {
    const value=validToken(lead[1],true);
    if(value)put(value,45);
  }
  function putFollowing(value,score) {
    const v=validToken(value,true);
    if(!v)return;
    // A lowercase word after "code" is a sentence word, not a code.
    if(/^[a-z]+$/.test(v) && new Set(['expires','valid','minutes','minute','hours','hour','days','day','with','anyone','someone','share','enter','official','website','could','scam','team','from','your','you','are','this','that','please','thanks','hello','dear','after','before','until','only','never','should','will','can','for','and','or','but','not','if','when','where','which','what','how','all','any','some','no','yes','do','does','did','have','has','had','been','being','the','of','in','on','at','by','without','about','over','under','between','through','during','above','below','up','down','out','off','again','further','then','once','here','there','both','each','few','more','most','other','such','nor','own','same','so','than','too','very','just','now']).has(v)) return;
    const numeric=/^\d{4,10}$/.test(v);
    const mixed=/[A-Za-z]/.test(v)&&/\d/.test(v);
    const uppercase=/^[A-Z]{4,16}$/.test(v);
    const camel=/^[A-Za-z]{5,24}$/.test(v)&&/[A-Z]/.test(v)&&/[a-z]/.test(v)&&
      !/^[A-Z][a-z]+$/.test(v);
    if(numeric||mixed||uppercase||camel||/^[a-z]{5,16}$/.test(v))put(v,score);
  }
  MARKER.lastIndex=0; let m;
  while((m=MARKER.exec(clean))) {
    const tail=clean.slice(m.index+m[0].length,m.index+m[0].length+175);
    // Explicit colon anchor: "confirmation code to continue:\ntqTxqHCs".
    const afterColon=tail.match(/^[^:\n]{0,70}[:：]\s*([A-Za-z0-9]{4,30}(?:[-_][A-Za-z0-9]{2,20}){0,2})\b/);
    if(afterColon)putFollowing(afterColon[1],55);
    // Code placed directly after a marker: "رمز التأكيد 676077".
    const immediate=tail.match(/^\s*(?:(?:is|your|the|following|below|التالي)\s+)?[:：=\-]?\s*([A-Za-z0-9]{4,30}(?:[-_][A-Za-z0-9]{2,20}){0,2})\b/i);
    if(immediate)putFollowing(immediate[1],30);
    const nextMarker=tail.search(MARKER);
    const scope=nextMarker>0 ? tail.slice(0,nextMarker) : tail;
    const candidates=/(?:^|[^A-Za-z0-9@])([A-Za-z0-9]{4,30}(?:[-_][A-Za-z0-9]{2,20}){0,2})(?=$|[^A-Za-z0-9@])/g;
    let c; let count=0;
    while((c=candidates.exec(scope)) && count++<10) {
      const value=validToken(c[1], true);
      if(!value)continue;
      const hasDigit=/\d/.test(value);
      const allUpper=/^[A-Z]{4,16}$/.test(value);
      const camel=/^[A-Za-z]{5,24}$/.test(value)&&/[A-Z]/.test(value)&&
        /[a-z]/.test(value)&&!/^[A-Z][a-z]+$/.test(value);
      if(!hasDigit&&!allUpper&&!camel)continue;
      put(value,20+(hasDigit?8:0)+(allUpper?2:0)+(camel?5:0)-Math.floor(c.index/25));
      break;
    }
  }
  // If the message is unequivocally about a code, allow a lone 4-10 digit number.
  if(/رمز\s*(?:التأكيد|التحقق)|verification\s*code|confirmation\s*code|security\s*code|one[- ]time\s*(?:password|code)|\botp\b|كود\s*(?:التأكيد|التحقق)/i.test(content.subject+'\n'+clean.slice(0,500))) {
    const unique=new Set((clean.match(/(?:^|[^0-9])([0-9]{4,10})(?=$|[^0-9])/g)||[]).map(x=>x.match(/\d{4,10}/)?.[0]).filter(Boolean));
    if(unique.size===1) for(const n of unique) put(validToken(n,false),12);
  }
  // Detect spaced numeric codes used by HTML templates (e.g. 1 8 9 6 0 5).
  const isVerification=/\b(?:otp|verification|confirmation|security|authentication|passcode|code|pin)\b|رمز|كود|شفرة|verifikasi|doğrulama|código|code de|bestätigungs|подтверждени/i;
  const context=(content.subject+'\n'+clean);
  const codeMail=isVerification.test(context.slice(0,2000));
  const spaced=/(?:^|[^A-Za-z0-9])((?:[0-9][ \t\n\u00a0]{1,15}){5,8}[0-9])(?=$|[^A-Za-z0-9])/g;
  let match;
  while((match=spaced.exec(clean))){
    const digits=match[1].replace(/\D/g,'');
    if(digits.length<6||digits.length>9)continue;
    const near=context.slice(Math.max(0,match.index-450),match.index+450);
    if(isVerification.test(near)||codeMail)put(validToken(digits,true),60);
  }
  // The HTML may include the OTP as a standalone six digits rather than a sentence.
  if(codeMail){
    const standalone=[...clean.matchAll(/(?:^|[^A-Za-z0-9])([0-9]{6,8})(?=$|[^A-Za-z0-9])/g)]
      .map(x=>x[1]);
    const candidates=[...new Set(standalone)].filter(v=>!/^20\d{4}$/.test(v));
    if(candidates.length===1)put(validToken(candidates[0],true),35);
  }
  // Keep high-confidence results: show every distinct code found (up to 3).
  return [...found].filter(([,score])=>score>=12).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);
}
export function analyzeMessage(mail) {
  const c=info(mail);
  // No body at all (list-only item, detail never fetched) means no
  // code can be trusted: the subject alone is a label plus a brand
  // name, not a code. Showing nothing is honest.
  if(!c.hasBody) return {
    sender:c.sender, subject:c.subject, preview:c.compact.slice(0,260), fullText:c.fullText,
    codes:[], links:[]
  };
  const action=actionLinks(c);
  const codes=verificationCodes(c);
  const distinct=[...new Set(codes)].slice(0,3);
  // Inline-link segments for the detail view, from the HTML body — but
  // only when they cover the displayed text, so the detail never loses
  // content vs the plain-text fallback.
  let segments = null;
  const htmlSources = bodyCandidates(mail).html;
  if (htmlSources.length) {
    const segs = bodySegments(htmlSources.slice().sort((a, b) => b.length - a.length)[0]);
    if (segs) {
      // Whitespace-stripped: tag-stripping inserts spaces around anchors
      // ("word ." vs "word."), which must not fail the match.
      const segText = segs.map(s => s.v).join('').replace(/\s+/g, '');
      const full = c.fullText.replace(/\s+/g, '');
      if (segText && full && (segText === full || segText.includes(full))) segments = segs;
    }
  }
  return {
    sender:c.sender, subject:c.subject, preview:c.compact.slice(0,260), fullText:c.fullText,
    codes:distinct,
    links:action,
    segments
  };
}
export function mailDate(mail) {
  const v=mail?.receivedAt??mail?.createdAt??mail?.date??mail?.timestamp??mail?.received_at;
  if(typeof v==='number')return v<1e12?v*1000:v;
  const time=Date.parse(String(v||''));return Number.isFinite(time)?time:0;
}

// ---------------------------------------------------------------------------
// Inbox fetching (mail.js inbox/tmInbox/msInbox/enatorInbox), LIST-ONLY:
// no detail enrichment, no DB audit — the bot's list views pass
// messageId '__LIST_ONLY__' for exactly this reason.
// ---------------------------------------------------------------------------
async function msInbox(email, fetchFn) {
  const r = await msCall('GET', `/email/${encodeURIComponent(email)}/messages`, undefined, fetchFn);
  if (!r.ok) return { ok: false, status: r.status, payload: null };
  const list = decodeMessages(r.json);
  if (!Array.isArray(list)) return { ok: false, status: 502, payload: null };
  return { ok: true, status: 200, payload: list.map(raw => normItem(raw)) };
}
async function tmInbox(email, fetchFn) {
  const r = await callJson('GET', `${TM_BASE}/v3/email/${encodeURIComponent(email)}/messages`, undefined, fetchFn);
  if (r.status === 404 || (r.status === 400 && r.json?.code === 101)) {
    return { ok: false, status: 404, payload: null };
  }
  if (r.status !== 200 || !Array.isArray(r.json)) {
    return { ok: false, status: r.status, payload: null };
  }
  return { ok: true, status: 200, payload: r.json.map(raw => normItem(raw)) };
}
async function enatorInbox(email, fetchFn) {
  const r = await callJson('POST', `${ENATOR_BASE}/message-list`, { email, limit: 20 }, fetchFn);
  if (r.status !== 200 || !Array.isArray(r.json?.messages)) return null;
  const items = r.json.messages.filter(m => m && !m.locked);
  return { ok: true, status: 200, payload: items.map(raw => normItem(raw)) };
}
async function usmailInbox(email, fetchFn) {
  const result = await usmailRequest('GET', '/api/emails/' + encodeURIComponent(email), undefined, fetchFn);
  if (!result.ok) return { ok: false, status: result.status, payload: null };
  const seen = new WeakSet();
  function normalizePayload(value, depth = 0) {
    if (Array.isArray(value)) {
      return value.map(item => {
        const normalized = normItem(item);
        const uncertain = Boolean(item?.snippet || item?.preview || item?.bodyPreview);
        return annotate(normalized, uncertain ? 'partial' : 'listed',
          uncertain ? 'LIST_PREVIEW_ONLY' : '');
      });
    }
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return value;
    seen.add(value);
    let changed = false;
    const out = { ...value };
    for (const key of ['emails', 'messages', 'inbox', 'items', 'results', 'data', 'result', 'payload']) {
      if (out[key] == null) continue;
      const next = normalizePayload(out[key], depth + 1);
      if (next !== out[key]) { out[key] = next; changed = true; }
    }
    return changed ? out : value;
  }
  const payload = normalizePayload(result.payload);
  return { ok: true, status: 200, payload: decodeMessages(payload) || [] };
}

export async function inbox(email, fetchFn = globalThis.fetch) {
  const domain = domainOf(email);
  if (TM_DOMAINS.includes(domain)) return tmInbox(email, fetchFn);
  if (HD_DOMAINS.includes(domain)) return msInbox(email, fetchFn);
  if (domain === 'gmail.com') {
    const [viaMs, viaEn] = await Promise.all([
      msInbox(email, fetchFn).catch(() => ({ ok: false, status: 0, payload: null })),
      enatorInbox(email, fetchFn).catch(() => null)
    ]);
    if (viaMs.ok && viaEn?.ok) {
      const seen = new Map();
      const merged = [];
      for (const item of [...viaMs.payload, ...viaEn.payload]) {
        const key = `${item?.id ?? ''}|${item?.from ?? ''}|${item?.subject ?? ''}|${item?.receivedAt ?? ''}`;
        if (seen.has(key)) {
          const index = seen.get(key);
          const previous = merged[index];
          const combined = normItem(item, previous);
          const complete = item.detailStatus === 'details_fetched' &&
            previous.detailStatus === 'details_fetched';
          merged[index] = annotate(combined, complete ? 'details_fetched' : 'partial',
            complete ? '' : 'PROVIDER_PARTIAL');
        } else {
          seen.set(key, merged.length);
          merged.push(item);
        }
      }
      return { ok: true, status: 200, payload: merged };
    }
    if (viaMs.ok) return viaMs;
    if (viaEn?.ok) return viaEn;
    return { ok: false, status: viaMs.status || 0, payload: null };
  }
  if (domain === 'googlemail.com') {
    return (await enatorInbox(email, fetchFn)) ?? { ok: false, status: 0, payload: null };
  }
  return usmailInbox(email, fetchFn);
}

// Direct detail fetch for one already-listed message, without re-listing.
//
// Why: some providers rotate the message id on every list call.
// Emailnator is the proven case — two list calls seconds apart return
// the same messages with completely different ids, so a detail call
// that first re-lists and then matches by id can never find the opened
// message. Fetching the detail with the id from the ORIGINAL list
// call works.
export async function detailFor(email, id, fetchFn = globalThis.fetch) {
  if (id == null || id === '') return null;
  const item = { id };
  const domain = domainOf(email);
  const attempts = [];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    attempts.push({ provider: 'emailnator', call: () => callJson('GET',
      `${ENATOR_BASE}/message/${encodeURIComponent(String(id))}`, undefined, fetchFn) });
  }
  if (domain === 'gmail.com' || HD_DOMAINS.includes(domain)) {
    attempts.push({ provider: 'mail-server', call: () => msCall('GET',
      `/email/${encodeURIComponent(email)}/messages/${encodeURIComponent(String(id))}`, undefined, fetchFn) });
  }
  if (TM_DOMAINS.includes(domain)) {
    attempts.push({ provider: 'temp-mail', call: () => callJson('GET',
      `${TM_BASE}/v3/message/${encodeURIComponent(String(id))}`, undefined, fetchFn) });
  }
  if (!attempts.length) return null;
  for (const attempt of attempts) {
    let result;
    try { result = await attempt.call(); }
    catch { result = { ok: false, status: 0, errorCode: 'NETWORK_ERROR' }; }
    const object = detailObject(result?.json);
    if (result?.ok && object && typeof object === 'object' && !Array.isArray(object)) {
      const merged = normItem(object, item);
      if (hasBody(merged)) return annotate(merged, 'details_fetched', '');
    }
  }
  return annotate(item, 'failed', 'DETAIL_FETCH_FAILED');
}

// ---------------------------------------------------------------------------
// Email validation — mail.js parsePublicEmail MINUS the min local-part
// length (any existing address must be viewable) and WITHOUT the domain
// list check (visibility is a separate step, against domains.json).
// ---------------------------------------------------------------------------
export function parseEmailShape(input) {
  const raw = String(input || '').trim().replace(/^mailto:/i, '').toLowerCase();
  if (raw.length > 254 || !raw.includes('@')) return null;
  const at = raw.lastIndexOf('@');
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!local || !domain) return null;
  if (!/^[a-z0-9][a-z0-9._+-]{0,62}$/.test(local) || local.endsWith('.') || local.includes('..')) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.includes('..')) return null;
  return { local, domain, email: `${local}@${domain}` };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}
function errorResponse(code, status, message) {
  return jsonResponse({ error: code, ...(message ? { message } : {}) }, status);
}

function listItemView(item) {
  const analysis = analyzeMessage(item);
  const view = {
    id: messageId(item) ?? null,
    from: analysis.sender,
    subject: analysis.subject,
    receivedAt: mailDate(item) || null,
    codes: analysis.codes,
    links: analysis.links
  };
  // Only include a text preview when the list item actually carries a body.
  if (hasBody(item)) view.text = analysis.preview;
  return view;
}

export function createHandler({ fetchFn = globalThis.fetch, domains = VISIBLE_DOMAINS } = {}) {
  const visible = new Set(domains);
  return {
    async fetch(request) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== 'GET') {
        return errorResponse('METHOD_NOT_ALLOWED', 405, 'Only GET is supported.');
      }
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/' || path === '') {
        return jsonResponse({
          name: 'nabeel-inbox',
          description: 'Temp-email inbox viewer (read-only).',
          routes: ['GET /inbox?email=<email>', 'GET /message?email=<email>&id=<id>', 'GET /domains']
        });
      }

      if (path === '/domains') {
        return jsonResponse({ domains: [...visible] });
      }

      if (path === '/inbox' || path === '/message') {
        const parsed = parseEmailShape(url.searchParams.get('email'));
        if (!parsed) {
          return errorResponse('INVALID_EMAIL', 400, 'Malformed email address.');
        }
        if (!visible.has(parsed.domain)) {
          return errorResponse('DOMAIN_NOT_AVAILABLE', 404, 'This domain is not available on the site.');
        }
        const { email } = parsed;

        if (path === '/inbox') {
          const result = await inbox(email, fetchFn);
          if (!result.ok) {
            // Provider says the address was never created: an empty inbox.
            if (result.status === 404) return jsonResponse({ email, messages: [] });
            return errorResponse('UPSTREAM_ERROR', 502, 'The mail provider could not be reached.');
          }
          const messages = result.payload
            .map(listItemView)
            .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));
          return jsonResponse({ email, messages });
        }

        // /message
        const id = url.searchParams.get('id');
        if (id == null || id === '') {
          return errorResponse('MISSING_ID', 400, 'Query parameter id is required.');
        }
        const detail = await detailFor(email, id, fetchFn);
        if (detail === null) {
          return errorResponse('MESSAGE_NOT_FOUND', 404, 'No detail endpoint for this message.');
        }
        if (detail.detailStatus === 'failed') {
          return errorResponse('UPSTREAM_ERROR', 502, 'The full message could not be fetched.');
        }
        const analysis = analyzeMessage(detail);
        return jsonResponse({
          email,
          id: detail.id ?? id,
          from: analysis.sender,
          subject: analysis.subject,
          receivedAt: mailDate(detail) || null,
          text: analysis.fullText,
          codes: analysis.codes,
          links: analysis.links,
          segments: analysis.segments ?? null
        });
      }

      return errorResponse('NOT_FOUND', 404, 'Unknown route.');
    }
  };
}

// Netlify event adapter around the fetch handler above — this is the
// Netlify serverless entry point. The fetch handler stays fully testable
// (see test.mjs) via the named export.
export const webHandler = createHandler();

const FUNCTION_PREFIX = '/.netlify/functions/index';

export async function handler(event) {
  const headers = event.headers || {};
  const host = headers.host || headers.Host || 'localhost';
  let path = event.path || '/';
  if (path.startsWith(FUNCTION_PREFIX)) path = path.slice(FUNCTION_PREFIX.length) || '/';
  const qs = event.rawQuery ||
    (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : '');
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  const request = new Request(url, { method: event.httpMethod || 'GET', headers });
  const response = await webHandler.fetch(request);
  const outHeaders = {};
  response.headers.forEach((value, key) => { outHeaders[key] = value; });
  return { statusCode: response.status, headers: outHeaders, body: await response.text() };
}
