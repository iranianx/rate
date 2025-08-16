// ===================================
// SECTION 1 — Config & IO (paths, env)
// ===================================
import fs from "fs";
import path from "path";

const ROOT    = process.cwd();
const TZ      = "Europe/Istanbul";
const OUTDIR  = path.join("data");
const OUTFILE = path.join(OUTDIR, "f1-real.json");

// منابع عمومی تلگرام (نسخه‌ی کمینه؛ قابل گسترش)
const SOURCES = [
  "https://t.me/s/RealRate2000",
  // "https://t.me/s/AnotherPublicChannel",
];

// پارامترها (ENV)
const TTL_MINUTES       = Number(process.env.REALRATE_TTL_MIN    || 60);    // عمر مجاز پست
const NEED_MIN_SAMPLES  = Number(process.env.REALRATE_MIN_N      || 5);     // حداقل نمونه
const TRIM_FRAC         = Number(process.env.REALRATE_TRIM_FRAC  || 0.20);  // نسبت تریم از دو سر
const PCT_SPREAD_MAX    = Number(process.env.REALRATE_SPREAD_PCT || 1.0);   // بیشینه‌ی پراکندگی
const SOFT_GUARD_PCT    = Number(process.env.REALRATE_GUARD_PCT  || 20);    // قفل نرم ±٪ نسبت به مرجع
const FETCH_TIMEOUT_MS  = Number(process.env.REALRATE_TIMEOUT_MS || 20000); // timeout شبکه
const REF_ENV           = Number(process.env.REALRATE_REF || NaN);          // مرجع دستی (اختیاری)

// مسیرهای مرجع برای قفل نرم
const BASELINE_PATH = path.join(ROOT, "baseline.json");            // { USD_TMN:{anchor,...} }
const DAILY_REF     = path.join("data", "daily", "f1dx-manage.json");
const YEARLY_REF    = path.join("data", "y2025", "f1yx-manage.json");

fs.mkdirSync(OUTDIR, { recursive: true });

// ===================================
// SECTION 2 — Utils (time, text, digits)
// ===================================
const now = () => new Date();
const toISO = (d) => d.toISOString();
const minutesAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

function htmlToText(html) {
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function normalizeFa(s) {
  return String(s || "")
    .replace(/\u200c/g, " ").replace(/\u0640/g, "")
    .replace(/[\u064B-\u0652]/g, " ")
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/\s+/g, " ").trim();
}
function faToEnDigits(str) {
  const map = {"۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
               "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
               "٫":".","٬":",","،":","};
  return String(str||"").replace(/[۰-۹٠-٩٫٬،]/g, ch => map[ch] ?? ch);
}
function toTZISO(iso, tz = TZ) {
  if (!iso) return null;
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit"
  }).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// ===================================
// SECTION 3 — Telegram HTML parse + fetch
// ===================================
function extractBlocks(html) {
  const parts = String(html).split('tgme_widget_message_wrap');
  return parts.slice(1).map(b => 'tgme_widget_message_wrap' + b);
}
function extractMessageText(block) {
  const m = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
  return m ? htmlToText(m[1]) : null;
}
function extractMessageMeta(block) {
  let id = null;
  const dp = block.match(/data-post="[^"]+\/(\d+)"/); if (dp) id = Number(dp[1]);

  let link = null, datetimeISO = null;
  const a = block.match(/<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"/i);
  if (a) link = a[1].startsWith("http") ? a[1] : `https://t.me${a[1]}`;
  const t = block.match(/<time[^>]*datetime="([^"]+)"/i);
  if (t) datetimeISO = t[1];

  if (!id && link) { const m = link.match(/\/(\d+)(?:\?.*)?$/); if (m) id = Number(m[1]); }
  return { id, link, time_iso: datetimeISO || null, time_local: datetimeISO ? toTZISO(datetimeISO, TZ) : null };
}
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent":"F1-Real/1.0" }});
  clearTimeout(timer);
  if (!r.ok) throw new Error("HTTP "+r.status);
  return r.text();
}

// ===================================
// SECTION 4 — Numbers & keyword window
// ===================================
const KEYWORDS_SALE = ["فروش","فروشی","میفروشم","می‌فروشم","می فروشم","نقدی"];
const KEYWORDS_CCY  = ["دلار","USD","$","تتر","USDT"];

function stripNoiseNumbers(s) {
  const t = faToEnDigits(normalizeFa(s||""));
  let u = t
    .replace(/\+?98[-\s]?\d{2,3}[-\s]?\d{3}[-\s]?\d{4}/g, " ") // موبایل
    .replace(/\b0?9\d{9}\b/g, " ")
    .replace(/\b\d{1,2}\s*[:٫\.]\s*\d{2}\b/g, " ")            // ساعت
    .replace(/\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/g, " ")      // تاریخ
    .replace(/\b\d{1,2}[\/\-]\d{1,2}\b/g, " ");
  return u.replace(/\s+/g, " ").trim();
}
function parseNumbersFrom(text) {
  // 92,750 | 92750 | 92.7k | 92k
  const re = /(\d{1,3}(?:[,\s]\d{3})+|\d{4,6}|(?:\d{2,3}(?:\.\d{1,2})?)\s*[kK])/g;
  const out = [];
  let m;
  while ((m = re.exec(stripNoiseNumbers(text)))) {
    const raw = m[1].replace(/\s+/g,"");
    if (/[kK]$/.test(raw)) out.push(Number(raw.replace(/[kK]/i,""))*1000);
    else out.push(Number(raw.replace(/[^\d]/g,"")));
  }
  return out;
}
function hasAny(text, words) {
  const T = normalizeFa(text);
  return words.some(w => T.includes(normalizeFa(w)));
}
function valueNearKeywords(fullText) {
  const raw = faToEnDigits(normalizeFa(fullText||""));
  const numsAll = parseNumbersFrom(raw);
  if (!numsAll.length) return null;

  // پنجره‌ی ±۶۰ دور هر کلمه‌ی فروش/ارز
  const keys = [...KEYWORDS_SALE, ...KEYWORDS_CCY];
  for (const w of keys) {
    const idx = raw.indexOf(normalizeFa(w));
    if (idx === -1) continue;
    const lo = Math.max(0, idx - 60), hi = Math.min(raw.length, idx + 60);
    const winNums = parseNumbersFrom(raw.slice(lo, hi));
    if (winNums.length) return winNums[0];
  }
  return numsAll[0];
}

// ===================================
// SECTION 5 — Soft guard (±% ref) loader
// ===================================
function readJSON(p){ try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } }
function pickRefFromDaily(j){
  if (!j || typeof j!=="object") return null;
  // تلاش‌های مختلف برای یافتن نرخ مرجع دلار
  if (typeof j.USD_TMN === "number") return j.USD_TMN;
  if (j.spot && typeof j.spot.USD_TMN === "number") return j.spot.USD_TMN;
  if (j.outputs && typeof j.outputs.USD_TMN === "number") return j.outputs.USD_TMN;
  return null;
}
function pickRefFromYearly(j){
  if (!j || typeof j!=="object") return null;
  // فرض: لیست مقادیر انتهای روز؛ آخرین مقدار
  const arr = j?.USD_TMN_list || j?.usd_list || j?.list || null;
  if (Array.isArray(arr) && arr.length) {
    const last = arr[arr.length-1];
    if (typeof last === "number") return last;
    if (last && typeof last.value === "number") return last.value;
  }
  return null;
}
function pickRefFromBaseline(){
  const b = readJSON(BASELINE_PATH);
  const a = b?.USD_TMN?.anchor;
  return (typeof a === "number" && isFinite(a)) ? a : null;
}
function getSoftGuardRef(){
  if (isFinite(REF_ENV)) return { ref: REF_ENV, source: "env" };
  const d = readJSON(DAILY_REF);
  const r1 = pickRefFromDaily(d); if (isFinite(r1)) return { ref: r1, source: "daily" };
  const y = readJSON(YEARLY_REF);
  const r2 = pickRefFromYearly(y); if (isFinite(r2)) return { ref: r2, source: "yearly" };
  const r3 = pickRefFromBaseline(); if (isFinite(r3)) return { ref: r3, source: "baseline" };
  return { ref: null, source: null };
}
function inSoftGuard(n, ref, pct){
  if (!isFinite(ref) || !isFinite(n)) return true; // اگر مرجع نداریم، قفل نرم غیرفعال
  const lo = ref * (1 - pct/100), hi = ref * (1 + pct/100);
  return n >= lo && n <= hi;
}

// ===================================
// SECTION 6 — Scan one source (TTL + guard)
// ===================================
async function scanSource(url, guardRef) {
  const html = await fetchText(url);
  const blocks = extractBlocks(html);

  const candidates = [];
  let removedCount = 0;

  for (const b of blocks) {
    const meta = extractMessageMeta(b);
    if (!meta?.time_iso) { removedCount++; continue; }     // بدون زمان
    const ageMin = minutesAgo(meta.time_iso);
    if (ageMin > TTL_MINUTES) { removedCount++; continue; } // کهنه

    const text = extractMessageText(b);
    if (!text) { removedCount++; continue; }

    // باید حداقل یکی از کلیدواژه‌های فروش و یکی از ارزی حاضر باشد
    const okSale = hasAny(text, KEYWORDS_SALE);
    const okCcy  = hasAny(text, KEYWORDS_CCY);
    if (!(okSale && okCcy)) { removedCount++; continue; }

    const val = valueNearKeywords(text);
    if (!isFinite(val)) { removedCount++; continue; }

    // قفل نرم ±٪ نسبت به مرجع
    if (!inSoftGuard(val, guardRef, SOFT_GUARD_PCT)) {
      removedCount++; 
      continue;
    }

    candidates.push({
      source: url,
      id: meta.id || 0,
      link: meta.link || null,
      time_iso: meta.time_iso,
      time_local: meta.time_local,
      age_minutes: +ageMin.toFixed(1),
      value: val,
      sample: text.slice(0, 200)
    });
  }

  return {
    source: url,
    raw_blocks: blocks.length,
    candidates,
    removed: removedCount
  };
}

// ===================================
// SECTION 7 — Stats helpers (dedup, med)
// ===================================
function dedupBySourceId(arr){
  const seen = new Set(); const out = [];
  for (const x of arr) {
    const key = `${x.source}#${x.id}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(x);
  }
  return out;
}
function median(vals){
  if (!vals.length) return null;
  const a = vals.slice().sort((x,y)=>x-y);
  const n=a.length, m=Math.floor(n/2);
  return n%2? a[m] : (a[m-1]+a[m])/2;
}
function trimmedMedian(values, trimFrac){
  const a = values.slice().sort((x,y)=>x-y);
  const n = a.length;
  const t = Math.min(Math.floor(n*trimFrac), Math.floor((n-1)/2));
  const trimmed = a.slice(t, n - t);
  return { med: median(trimmed), trimmedCount: t*2, n };
}

// ===================================
// SECTION 8 — Summarize & payload build
// ===================================
function summarize(allCandidates){
  const dedup = dedupBySourceId(allCandidates);
  const vals  = dedup.map(x=>x.value);
  const n     = vals.length;

  if (n === 0) {
    return { used:[], min:null,max:null,median:null,spread:null,estimate:null,method:null };
  }
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const med  = median(vals);
  const spreadPct = med ? ((maxV - minV) / med) * 100 : null;

  let estimate = null, method = null, used = [];
  if (n >= NEED_MIN_SAMPLES && spreadPct != null && spreadPct <= PCT_SPREAD_MAX) {
    const { med:tm, trimmedCount } = trimmedMedian(vals, TRIM_FRAC);
    estimate = Math.round(tm ?? med);
    method   = trimmedCount > 0 ? "trimmed_median" : "median";
    used     = dedup.slice().sort((a,b)=>a.value-b.value);
  }
  return {
    used, min:minV, max:maxV, median:med,
    spread: spreadPct != null ? +spreadPct.toFixed(3) : null,
    estimate, method
  };
}
function buildPayload(perSource, summary, guardInfo){
  const perSrcCounts = perSource.map(r => ({
    source: r.source,
    raw_blocks: r.raw_blocks,
    candidates: r.candidates.length,
    removed: r.removed
  }));
  const samples_used = (summary.used || []).map(x => ({
    source: x.source, id: x.id, link: x.link,
    time_iso: x.time_iso, time_local: x.time_local,
    age_minutes: x.age_minutes, value: x.value, sample: x.sample
  }));
  return {
    status: "ok",
    scraped_at: toISO(now()),
    sources: SOURCES,
    ttl_minutes: TTL_MINUTES,
    config: {
      need_min_samples: NEED_MIN_SAMPLES,
      trim_frac: TRIM_FRAC,
      pct_spread_max: PCT_SPREAD_MAX,
      soft_guard_pct: SOFT_GUARD_PCT,
      soft_guard_ref_source: guardInfo.source,
      soft_guard_ref_value: guardInfo.ref
    },
    counts: {
      per_source: perSrcCounts,
      candidates_all: perSource.reduce((a,b)=>a+b.candidates.length,0),
      deduped: (new Set((summary.used||[]).map(u=>`${u.source}#${u.id}`))).size,
      removed_all: perSource.reduce((a,b)=>a+b.removed,0)
    },
    summary: {
      used_n: summary.used.length,
      min: summary.min ?? null,
      max: summary.max ?? null,
      median: summary.median ?? null,
      spread_pct: summary.spread ?? null,
      estimate: summary.estimate ?? null,
      method: summary.method ?? null
    },
    samples_used,
    removed_examples: [] // در صورت نیاز می‌توان چند نمونه‌ی حذف‌شده را لاگ کرد
  };
}

// ===================================
// SECTION 9 — Main
// ===================================
async function main(){
  const guardInfo = getSoftGuardRef(); // {ref, source}
  const results = [];
  for (const url of SOURCES) {
    try { results.push(await scanSource(url, guardInfo.ref)); }
    catch(e){ results.push({ source:url, raw_blocks:0, candidates:[], removed:0, error:String(e) }); }
  }
  const all = results.flatMap(r => r.candidates);
  const sum = summarize(all);

  const payload = buildPayload(results, sum, guardInfo);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);
}
main().catch(e => { console.error(e); process.exit(1); });
