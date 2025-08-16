// Real-time crowd sell-rate estimator from Telegram groups
// Output: data/realrate.json

import fs from "fs";
import path from "path";

// ============= Config =============
const OUTFILE = path.join("data", "realrate.json");
const DEBUG   = process.env.DEBUG === "1";

// چند منبع: کاما-جدا. نکته: خود اسکریپت /s/ را اجبار می‌کند.
const REALRATE_SOURCES = (process.env.REALRATE_SOURCES || "https://t.me/ParsianSarafi")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(u => u.replace("https://t.me/", "https://t.me/s/"));

const TTL_MIN            = Number(process.env.REALRATE_TTL_MIN || 60);   // فقط ۶۰ دقیقهٔ اخیر
const NEED_MIN_SAMPLES   = Number(process.env.REALRATE_MIN_N || 5);      // حداقل نمونهٔ معتبر
const TRIM_FRAC          = Number(process.env.REALRATE_TRIM_FRAC || 0.2);// برش ۲۰٪ دو سر
const PCT_SPREAD_MAX     = Number(process.env.REALRATE_SPREAD_MAX || 1.0);// پراکندگی <= ۱٪
const PLAUS_LO           = Number(process.env.REALRATE_MIN || 80000);
const PLAUS_HI           = Number(process.env.REALRATE_MAX || 130000);
const FETCH_TIMEOUT_MS   = Number(process.env.REALRATE_TIMEOUT_MS || 20000);
const FETCH_RETRIES      = Number(process.env.REALRATE_RETRIES || 2);
const HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "accept": "text/html,application/xhtml+xml"
};
const dlog = (...a)=>{ if (DEBUG) console.log("[REALRATE]", ...a); };
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ============= Text utils =============
function htmlToText(html){
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}
function normalizeFa(s){
  if (!s) return "";
  return String(s).replace(/\u200c/g," ").replace(/\u0640/g,"")
    .replace(/[\u064B-\u0652]/g,"").replace(/ي/g,"ی").replace(/ك/g,"ک")
    .replace(/\s+/g," ").trim();
}
function faToEnDigits(str){
  if (!str) return "";
  const map={"۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9","٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9","٫":".","٬":",","،":","};
  return String(str).replace(/[۰-۹٠-٩٫٬،]/g, ch => map[ch] ?? ch);
}
function minutesBetween(a,b){ return Math.abs((a.getTime()-b.getTime())/60000); }

// ============= Telegram parsing =============
async function fetchTextWithRetry(url){
  let lastErr=null;
  for (let a=1; a<=1+FETCH_RETRIES; a++){
    const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(), FETCH_TIMEOUT_MS);
    try{
      const r=await fetch(url,{headers:HEADERS,signal:ctl.signal});
      clearTimeout(to); if(!r.ok) throw new Error("HTTP "+r.status);
      const t=await r.text(); dlog("GET OK", url); return t;
    }catch(e){ clearTimeout(to); lastErr=e; dlog("GET FAIL", url, `try ${a}/${1+FETCH_RETRIES}`, e?.message||e); if(a<1+FETCH_RETRIES) await new Promise(res=>setTimeout(res,500)); }
  }
  throw lastErr||new Error("net-fail");
}
function extractBlocks(html){
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}
function extractMessageText(block){
  const m = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? htmlToText(m[1]) : "";
}
function extractMessageMeta(block){
  let id=null; const dp=block.match(/data-post="[^"]+\/(\d+)"/); if(dp) id = Number(dp[1]);
  let link=null, datetimeISO=null;
  const a=block.match(/<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"/);
  if(a) link = a[1].startsWith("http") ? a[1] : `https://t.me${a[1]}`;
  const t=block.match(/<time[^>]*datetime="([^"]+)"/); if(t) datetimeISO = t[1];
  return { id, link, datetimeISO };
}

// ============= Domain filters =============
// فروش واقعی دلار اسکناس با ادبیات متنوع
const SELL_WORDS = ["فروش","فروشی","میفروشم","می‌فروشم","قیمت","فی"];
const USD_WORDS  = ["دلار","USD","$","آبی","اسکناس"];
const EXCLUDE_WORDS = ["خرید","میخرم","خریدار","یورو","درهم","تتر","ریال","سکه","چک","پوند"];

const LOC_THR_POS = ["تهران","منوچهری","آزادی","ونک","مجیدی","ولیعصر","جمهوری","صادقیه","تجریش","میرداماد","شریعتی","پاساژ"];
const LOC_THR_NEG = ["مشهد","شیراز","اصفهان","تبریز","قم","رشت","کیش","اراک","اهواز","کرج","یزد","کرمان","قزوین"];

function hasAny(txt, arr){ const t = normalizeFa(txt); return arr.map(normalizeFa).some(w => w && t.includes(w)); }

// عدد نزدیک به «فروش/قیمت/فی»، وگرنه اولین عدد منطقی در متن
function pickNearPrice(text){
  const raw = faToEnDigits(text||"");
  const norm = normalizeFa(raw);
  const numRe = /(\d{1,3}(?:[,\.\s]\d{3})+|\d{2,6}(?:\.\d{1,2})?)/g;

  function toToman(token){
    const s = String(token).replace(/[^\d\.]/g,"");
    if (!s) return null;
    if (s.includes(".")) { return Math.round(parseFloat(s)*1000); } // 93.2 → 93200
    const n = Number(s.replace(/[^\d]/g,"")); if (!isFinite(n)) return null;
    if (n <= 200) return Math.round(n*1000); // 93 → 93000
    return n;
  }

  for (const w of SELL_WORDS.concat(["فی"])){
    const idx = norm.indexOf(normalizeFa(w));
    if (idx === -1) continue;
    const lo = Math.max(0, idx - 50), hi = Math.min(raw.length, idx + w.length + 50);
    const win = raw.slice(lo, hi); let m;
    while ((m = numRe.exec(win))){ const v = toToman(m[1]); if (v && v>=PLAUS_LO && v<=PLAUS_HI) return v; }
  }

  // نگاه به انتهای متن (الگوی «... - 92700» رایج)
  const tail = raw.slice(Math.max(0, raw.length - 32));
  let mt; if ((mt = numRe.exec(tail))){ const v = toToman(mt[1]); if (v && v>=PLAUS_LO && v<=PLAUS_HI) return v; }

  // fallback: هر عدد منطقی در کل متن
  let m2; while ((m2 = numRe.exec(raw))){ const v = toToman(m2[1]); if (v && v>=PLAUS_LO && v<=PLAUS_HI) return v; }
  return null;
}

function inferQty(text){
  const t = faToEnDigits(normalizeFa(text));
  const k = t.match(/(\d+(?:\.\d+)?)\s*k\b/i); if (k){ const q=Number(k[1]); if (isFinite(q)) return Math.round(q*1000); }
  const m1 = t.match(/(\d{3,5})\s*(?:\$|دلار|دلاري|دلاری)\b/); if (m1){ const q=Number(m1[1]); if (isFinite(q)) return q; }
  const m2 = t.match(/(?:\$|دلار)\s*(\d{3,5})\b/); if (m2){ const q=Number(m2[1]); if (isFinite(q)) return q; }
  return null;
}
function phoneOf(text){
  const t = faToEnDigits(text); const m = t.match(/(?:^|\D)(09\d{9})(?:\D|$)/); return m ? m[1] : null;
}
function weightOfSample({ qty, text }){
  let w = 1.0;
  if (qty && isFinite(qty)) w *= Math.min(2, Math.sqrt(qty/1000)); // تا ×۲
  const t = normalizeFa(text);
  if (LOC_THR_POS.some(s => t.includes(normalizeFa(s)))) w *= 1.1;
  if (LOC_THR_NEG.some(s => t.includes(normalizeFa(s)))) w *= 0.5;
  if (t.includes("فوری")) w *= 1.05;
  return +w.toFixed(3);
}

// ============= Stats helpers =============
function median(arr){ const a=arr.slice().sort((x,y)=>x-y); const n=a.length; if(!n) return 0; const m=Math.floor(n/2); return (n%2)?a[m]:(a[m-1]+a[m])/2; }
function weightedMean(items){ if(!items.length) return 0; let s=0, sw=0; for(const it of items){ const w=it.w??1; s+=w*it.val; sw+=w; } return sw? s/sw : 0; }
function trimByFrac(items, frac){ if(!items.length||frac<=0) return items.slice(); const a=items.slice().sort((x,y)=>x.val-y.val); const k=Math.floor(a.length*frac); return a.slice(k, a.length-k); }

// ============= Core =============
async function scrapeOne(sourceUrl){
  const html = await fetchTextWithRetry(sourceUrl);
  const blocks = extractBlocks(html);
  const now = new Date();
  const candidates = [], removed = [];

  for (const block of blocks){
    const meta = extractMessageMeta(block);
    if (!meta?.datetimeISO || !meta?.id) continue;
    const ts = new Date(meta.datetimeISO);
    const ageMin = minutesBetween(now, ts);
    if (ageMin > TTL_MIN) continue;

    const text = extractMessageText(block);
    if (!text) continue;

    // ردِ بدیهی‌ها
    if (hasAny(text, EXCLUDE_WORDS)) { removed.push({id:meta.id, reason:"exclude", source:sourceUrl}); continue; }
    if (!hasAny(text, USD_WORDS))    { removed.push({id:meta.id, reason:"no-usd", source:sourceUrl}); continue; }

    // لازم نیست حتماً «فروش» باشد؛ اگر شماره‌تماس/مقدار/… دارد هم می‌پذیریم
    const looksLikeSell = hasAny(text, SELL_WORDS) || !!phoneOf(text) || !!inferQty(text);
    if (!looksLikeSell) { removed.push({id:meta.id, reason:"not-sellish", source:sourceUrl}); continue; }

    const price = pickNearPrice(text);
    if (!price) { removed.push({id:meta.id, reason:"no-price", source:sourceUrl}); continue; }
    if (price < PLAUS_LO || price > PLAUS_HI) { removed.push({id:meta.id, reason:"out-of-range", price, source:sourceUrl}); continue; }

    const qty = inferQty(text);
    const ph  = phoneOf(text);

    candidates.push({
      source: sourceUrl,
      id: meta.id,
      link: meta.link || null,
      ts: ts.toISOString(),
      age_min: +ageMin.toFixed(1),
      text: text.slice(0, 160),
      price, qty, phone: ph
    });
  }

  return { source: sourceUrl, blocks: blocks.length, candidates, removed };
}

async function main(){
  ensureDir("data");

  // جمع‌آوری از تمام منابع
  const parts = [];
  for (const u of REALRATE_SOURCES){
    try { parts.push(await scrapeOne(u)); }
    catch(e){ console.error("ERR source:", u, e?.message||e); }
  }

  // سرجمع
  const allCandidates = parts.flatMap(p => p.candidates);
  const allRemoved    = parts.flatMap(p => p.removed);

  // Dedup by phone (سراسری)
  const byPhone = new Map();
  for (const c of allCandidates){
    if (c.phone){
      const prev = byPhone.get(c.phone);
      if (!prev || c.id > prev.id) byPhone.set(c.phone, c);
    }
  }
  const deduped = [];
  const usedPhone = new Set();
  for (const c of allCandidates){
    if (c.phone){
      if (usedPhone.has(c.phone)) continue;
      if (byPhone.get(c.phone)?.id !== c.id) continue;
      usedPhone.add(c.phone);
    }
    deduped.push(c);
  }

  // نمونه‌ها + وزن
  const samples = deduped.map(c => ({ ...c, w: weightOfSample({ qty: c.qty, text: c.text }) }));

  // برآورد
  const n = samples.length;
  let estimate=null, method=null, spreadPct=null, min=null, max=null, med=null;

  if (n >= NEED_MIN_SAMPLES){
    const arr = samples.map(s=>s.price);
    min = Math.min(...arr); max = Math.max(...arr); med = median(arr);
    spreadPct = med ? ((max-min)/med)*100 : null;

    if (spreadPct != null && spreadPct <= PCT_SPREAD_MAX){
      const trimmed = trimByFrac(samples.map(s=>({val:s.price, w:s.w})), TRIM_FRAC);
      estimate = Math.round(weightedMean(trimmed));
      method = `weighted_mean_trim${Math.round(TRIM_FRAC*100)}`;
    }
  }

  const payload = {
    status: "ok",
    scraped_at: new Date().toISOString(),
    sources: REALRATE_SOURCES,
    ttl_minutes: TTL_MIN,
    config: {
      need_min_samples: NEED_MIN_SAMPLES,
      trim_frac: TRIM_FRAC,
      pct_spread_max: PCT_SPREAD_MAX,
      plausible: { min: PLAUS_LO, max: PLAUS_HI }
    },
    counts: {
      per_source: parts.map(p => ({ source: p.source, raw_blocks: p.blocks, candidates: p.candidates.length, removed: p.removed.length })),
      candidates_all: allCandidates.length,
      deduped: samples.length,
      removed_all: allRemoved.length
    },
    summary: {
      used_n: (estimate ? samples.length : 0),
      min, max, median: med, spread_pct: spreadPct,
      estimate, method
    },
    samples_used: estimate ? samples.map(s => ({
      source: s.source, id: s.id, link: s.link, ts: s.ts,
      price: s.price, qty: s.qty ?? null, w: s.w,
      age_min: s.age_min, snippet: s.text
    })) : [],
    removed_examples: allRemoved.slice(0, 10)
  };

  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log("realrate:", JSON.stringify(payload.summary));
}

main().catch(e => { console.error(e); process.exit(1); });
