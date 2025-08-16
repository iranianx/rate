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

// ⬇️ جدید: نسبت جهانی EUR/USD و تلورانس درصدی
const EURUSD_RATIO      = Number(process.env.REALRATE_EURUSD || 1.18);      // نسبت جهانی EUR/USD (مثلاً ~1.18)
const RATIO_TOLERANCE_P = Number(process.env.REALRATE_RATIO_TOL_PCT || 7);  // تلورانس ±٪ برای نسبت

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

// کلمات فروش (بازتر)
const KEYWORDS_SALE = [
  "فروش","فروشی","میفروشم","می‌فروشم","می فروشم",
  "نقدی","نقد","آماده","حضوری"
];

// توکن‌های ارزی: USD و EUR جداگانه
const CCY_USD = ["دلار","usd","$","دلار آبی","آبی دلار","دلار ابی","ابی"];
const CCY_EUR = ["یورو","eur","€","يورو"];
const KEYWORDS_CCY = [...CCY_USD, ...CCY_EUR];

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

// حذف نویزهای عددی رایج (موبایل/ساعت/تاریخ)
function stripNoiseNumbers(s) {
  const t = faToEnDigits(normalizeFa(s||""));
  let u = t
    // موبایل ایران (+98 یا 09 با فاصله/خط‌تیره اختیاری)
    .replace(/(?:\+?98[-\s]?)?9[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{4}\b/gi, " ")
    // ساعت 08:30 یا 8.05 یا 8:05:12
    .replace(/\b\d{1,2}[:٫\.]\d{2}(?::\d{2})?\b/g, " ")
    // تاریخ‌های yyyy-mm-dd و yyyy/mm/dd و mm/dd
    .replace(/\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}\b/g, " ");
  return u.replace(/\s+/g, " ").trim();
}

// اعداد خام: هزارگان/۵–۶ رقمی یا ۲–۳ رقمی ×۱۰۰۰ (k هم پشتیبانی می‌شود)
function parseNumbersFrom(text) {
  const re = /(\d{1,3}(?:[,\s]\d{3})+|\d{2,6}|(?:\d{2,3}(?:\.\d{1,2})?)\s*[kK])/g;
  const out = [];
  let m;
  const cleaned = stripNoiseNumbers(text);
  while ((m = re.exec(cleaned))) {
    const raw = m[1].replace(/\s+/g,"");
    if (/[kK]$/.test(raw)) out.push(Number(raw.replace(/[kK]/i,""))*1000);
    else out.push(Number(raw.replace(/[^\d]/g,"")));
  }
  return out;
}

function hasAny(text, words) {
  const T = normalizeFa(text || "");
  return words.some(w => T.includes(normalizeFa(w)));
}

// اعدادِ «تعداد واحد» کنار ارز (برای حذف از قیمت)
function findQuantitiesNextToCurrency(win) {
  const q = [];
  const w = normalizeFa(faToEnDigits(win || ""));
  const re = /(\d{1,4})\s*(?:تا\s*)?(?:دلار|یورو|usd|eur|\$|€)\b/gi;
  let m;
  while ((m = re.exec(w))) {
    const n = Number((m[1]||"").replace(/[^\d]/g,""));
    if (Number.isFinite(n)) q.push(n);
  }
  return new Set(q);
}

// تشخیص زوج USD/EUR با نسبت جهانی
function disambiguateUsdEur(nums) {
  if (!Array.isArray(nums) || nums.length < 2) return null;
  const a = Array.from(new Set(nums)).sort((x,y)=>x-y);
  const targetPct = (EURUSD_RATIO - 1) * 100; // مثلاً ~18%
  for (let i=0; i<a.length; i++) {
    for (let j=i+1; j<a.length; j++) {
      const small = a[i], big = a[j];
      if (!small || !big) continue;
      const pct = ((big / small) - 1) * 100;
      if (Math.abs(pct - targetPct) <= RATIO_TOLERANCE_P) {
        return { usd: small, eur: big }; // کوچکتر دلار، بزرگتر یورو
      }
    }
  }
  return null;
}

// از یک پنجره‌ی کوچک اطراف کلیدواژه، «بهترین قیمت دلار» را انتخاب کن
function pickPriceFromWindow(win, guardRef = null) {
  const qtySet = findQuantitiesNextToCurrency(win);
  const rawNums = parseNumbersFrom(win);

  // نگاشت به کاندیدا: ۵–۶ رقمی مستقیم؛ ۲–۳ رقمی ×۱۰۰۰
  const cands = [];
  for (const n of rawNums) {
    if (qtySet.has(n)) continue;            // عددِ تعداد واحد
    if (n >= 10000)              cands.push(n);
    else if (n >= 10 && n <= 999) cands.push(n * 1000);
  }
  if (!cands.length) return null;

  // 1) تلاش برای زوج USD/EUR
  if (cands.length >= 2) {
    const duo = disambiguateUsdEur(cands);
    if (duo?.usd) return duo.usd; // خروجی این اسکریپت دلار است
  }

  // 2) اگر مرجع داریم، نزدیک‌ترین به مرجع
  if (Number.isFinite(guardRef)) {
    cands.sort((a,b)=> Math.abs(a-guardRef) - Math.abs(b-guardRef));
    return cands[0];
  }

  // 3) در نهایت قاعدهٔ طول رقم (۵.۵ رقمی نزدیک‌تر)
  const score = (x) => Math.abs(String(x).length - 5.5);
  cands.sort((a,b)=> score(a) - score(b) || b - a);
  return cands[0];
}

// مقدار دلار نزدیک به کلیدواژه‌ها، با پشتیبانی از نسبت EUR/USD
function valueNearKeywords(fullText, guardRef = null) {
  const raw = faToEnDigits(normalizeFa(fullText || ""));

  // 1) پنجره‌های اطراف توکن‌های USD
  for (const w of CCY_USD) {
    const key = normalizeFa(w);
    let idx = raw.indexOf(key);
    while (idx !== -1) {
      const lo = Math.max(0, idx - 60);
      const hi = Math.min(raw.length, idx + key.length + 60);
      const win = fullText.slice(lo, hi);
      const cand = pickPriceFromWindow(win, guardRef);
      if (Number.isFinite(cand)) return cand;
      idx = raw.indexOf(key, idx + key.length);
    }
  }

  // 2) اگر نشانهٔ EUR هم هست و چند عدد داریم، زوج USD/EUR را حدس بزن
  if (hasAny(raw, CCY_EUR)) {
    const qtySet = findQuantitiesNextToCurrency(fullText);
    const allNums = parseNumbersFrom(fullText)
      .map(n => (n >= 10000 ? n : (n>=10 && n<=999 ? n*1000 : NaN)))
      .filter(n => Number.isFinite(n) && !qtySet.has(n));
    if (allNums.length >= 2) {
      const duo = disambiguateUsdEur(allNums);
      if (duo?.usd) return duo.usd;
    }
  }

  // 3) fallback: کل متن
  const fallback = pickPriceFromWindow(fullText, guardRef);
  return Number.isFinite(fallback) ? fallback : null;
}

// ===================================
// SECTION 5 — Soft guard (±% ref) loader
// ===================================
function readJSON(p){ try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } }

// از فایل مدیریت روزانه (ساختار جدید):
// {
//   "meta": { ... , "spread_pct_window": 7 },
//   "ref": { "usd_cash": 92000, "eur_cash": 108500, "usdt_mid": 91900 }
// }
function pickFromDailyManage(j){
  if (!j || typeof j!=="object") return { ref:null, pct:null };
  const pct = Number(j?.meta?.spread_pct_window);
  const ref = Number(j?.ref?.usd_cash);
  return {
    ref: Number.isFinite(ref) ? ref : null,
    pct: Number.isFinite(pct) ? pct : null
  };
}

// نسخه‌های قدیمی/جایگزین
function pickRefFromBaseline(){
  const b = readJSON(BASELINE_PATH);
  const a = b?.USD_TMN?.anchor;
  return (typeof a === "number" && isFinite(a)) ? a : null;
}

function getSoftGuardRef(){
  // ۱) فایل روزانه جدید
  const d = readJSON(DAILY_REF);
  const dm = pickFromDailyManage(d);
  if (Number.isFinite(dm.ref)) {
    return { ref: dm.ref, pct: Number.isFinite(dm.pct) ? dm.pct : SOFT_GUARD_PCT, source: "daily_manage" };
  }
  // ۲) ENV (مرجع دستی)
  if (isFinite(REF_ENV)) return { ref: REF_ENV, pct: SOFT_GUARD_PCT, source: "env" };
  // ۳) baseline قدیمی
  const r3 = pickRefFromBaseline(); 
  if (isFinite(r3)) return { ref: r3, pct: SOFT_GUARD_PCT, source: "baseline" };
  // ۴) بدون مرجع → قفل نرم غیرفعال (ولی pct را نگه می‌داریم برای گزارش)
  return { ref: null, pct: SOFT_GUARD_PCT, source: null };
}

function inSoftGuard(n, ref, pct){
  if (!isFinite(ref) || !isFinite(n) || !isFinite(pct)) return true; // بدون مرجع/درصد: عبور
  const lo = ref * (1 - pct/100), hi = ref * (1 + pct/100);
  return n >= lo && n <= hi;
}

// ===================================
// SECTION 6 — Scan one source (TTL + guard)
// ===================================
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent":"F1-Real/1.0" }});
  clearTimeout(timer);
  if (!r.ok) throw new Error("HTTP "+r.status);
  return r.text();
}

function extractBlocks(html) {
  const parts = String(html).split('tgme_widget_message_wrap');
  return parts.slice(1).map(b => 'tgme_widget_message_wrap' + b);
}
function extractMessageText(block) {
  const m = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
  return m ? htmlToText(m[1]) : null;
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
const now = () => new Date();
const toISO = (d) => d.toISOString();
const minutesAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

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

function inSoftGuard(n, ref, pct){
  if (!isFinite(ref) || !isFinite(n) || !isFinite(pct)) return true; // بدون مرجع/درصد: عبور
  const lo = ref * (1 - pct/100), hi = ref * (1 + pct/100);
  return n >= lo && n <= hi;
}

async function scanSource(url, guardInfo) {
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

    // الزام: حتماً نشانهٔ ارزی (USD یا EUR) وجود داشته باشد
    const hasCcy = hasAny(text, KEYWORDS_CCY);
    if (!hasCcy) { removedCount++; continue; }

    // مقدار دلار را بیرون بکش (با نسبت جهانی اگر هر دو ارز باشند)
    const val = valueNearKeywords(text, guardInfo?.ref ?? null);
    if (!isFinite(val)) { removedCount++; continue; }

    // قفل نرم ±pct
    if (!inSoftGuard(val, guardInfo?.ref ?? null, guardInfo?.pct ?? null)) {
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
  const guardInfo = getSoftGuardRef(); // { ref, pct, source }
  const results = [];
  for (const url of SOURCES) {
    try { results.push(await scanSource(url, guardInfo)); }
    catch(e){ results.push({ source:url, raw_blocks:0, candidates:[], removed:0, error:String(e) }); }
  }
  const all = results.flatMap(r => r.candidates);
  const sum = summarize(all);

  const payload = buildPayload(results, sum, guardInfo);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);
}

// ===================================
// SECTION 10 — Runner (always write OUTFILE)
// ===================================
(async () => {
  try {
    await main();
  } catch (e) {
    // حتی در خطا هم فایل خروجی بساز تا CI خالی نمونه
    fs.mkdirSync(OUTDIR, { recursive: true });
    const payload = {
      status: "error",
      scraped_at: new Date().toISOString(),
      message: String(e),
      stack: (e && e.stack) ? String(e.stack).split("\n").slice(0,3).join("\n") : undefined
    };
    fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
    console.error("F1-REAL ERROR:", e);
    process.exit(1);
  }
})();
