// ================================
// SECTION 1 — Config (sources, IO)
// ================================
import fs from "fs";
import path from "path";

const TZ = "Europe/Istanbul";
const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "realrate.json");

// فقط لینک‌های عمومیِ تلگرام با /s/ — برای افزودن منابع جدید این آرایه را گسترش بده
const SOURCES = [
  "https://t.me/s/RealRate2000",
  // "https://t.me/s/AnotherPublicChannel",
];

// پارامترها (قابل‌تنظیم با ENV)
const TTL_MINUTES     = Number(process.env.REALRATE_TTL_MIN   || 60);   // عمر مجاز پست
const NEED_MIN_SAMPLES= Number(process.env.REALRATE_MIN_N     || 5);    // حداقل نمونه
const TRIM_FRAC       = Number(process.env.REALRATE_TRIM_FRAC || 0.20); // نسبت تریم از دو سر
const PCT_SPREAD_MAX  = Number(process.env.REALRATE_SPREAD_PCT|| 1.00);  // بیشینه‌ی پراکندگی
const PLAUS_MIN       = Number(process.env.REALRATE_MIN       || 80000);
const PLAUS_MAX       = Number(process.env.REALRATE_MAX       || 130000);

fs.mkdirSync(OUTDIR, { recursive: true });

// ================================
// SECTION 2 — Tiny utils (time, text)
// ================================
const now = () => new Date();
const toISO = (d) => d.toISOString();
const minutesAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;

function htmlToText(html) {
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeFa(s) {
  return String(s || "")
    .replace(/\u200c/g, " ")
    .replace(/\u0640/g, "")
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

// ================================
// SECTION 3 — Telegram HTML parsing
// ================================
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
  return { id, link, time_iso: datetimeISO || null };
}
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.REALRATE_TIMEOUT_MS||20000));
  const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent":"RealRate/1.0" }});
  clearTimeout(timer);
  if (!r.ok) throw new Error("HTTP "+r.status);
  return r.text();
}

// ================================
// SECTION 4 — Value extraction rules
// ================================
const KEYWORDS = [
  // عمل فروش
  "فروش","فروشی","میفروشم","می‌فروشم","می فروشم",
  // نشانه‌های ارزی
  "تتر","USDT","دلار","USD","نقدی"
];
function plausible(n){ return Number.isFinite(n) && n>=PLAUS_MIN && n<=PLAUS_MAX; }

function parseNumbersFrom(text) {
  // 92,750 | 92750 | 92.7k | 92k
  const re = /(\d{1,3}(?:[,\s]\d{3})+|\d{4,6}|(?:\d{2,3}(?:\.\d{1,2})?)\s*[kK])/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/\s+/g,"");
    if (/[kK]$/.test(raw)) out.push(Number(raw.replace(/[kK]/i,""))*1000);
    else out.push(Number(raw.replace(/[^\d]/g,"")));
  }
  return out;
}
function extractValueNearKeywords(fullText) {
  const raw = faToEnDigits(normalizeFa(fullText||""));
  const nums = parseNumbersFrom(raw);
  if (!nums.length) return null;

  // اول تلاش: پنجره ±۶۰ کاراکتر دور کلمات کلیدی
  for (const w of KEYWORDS) {
    const idx = raw.indexOf(normalizeFa(w));
    if (idx === -1) continue;
    const lo = Math.max(0, idx-60), hi = Math.min(raw.length, idx+60);
    const win = raw.slice(lo, hi);
    const winNums = parseNumbersFrom(win).filter(plausible);
    if (winNums.length) return winNums[0];
  }
  // fallback: اولین عدد معقول
  const ok = nums.find(plausible);
  return ok ?? null;
}

// ================================
// SECTION 5 — Scan one source (TTL + parse)
// ================================
async function scanSource(url) {
  const html = await fetchText(url);
  const blocks = extractBlocks(html);
  const nowISO = toISO(now());

  const candidates = [];
  let removedCount = 0;

  for (const b of blocks) {
    const meta = extractMessageMeta(b);
    if (!meta?.time_iso) { removedCount++; continue; } // بدون زمان
    const ageMin = minutesAgo(meta.time_iso);
    if (ageMin > TTL_MINUTES) { removedCount++; continue; } // کهنه

    const text = extractMessageText(b);
    if (!text) { removedCount++; continue; }

    const val = extractValueNearKeywords(text);
    if (!plausible(val)) { removedCount++; continue; }

    candidates.push({
      source: url, id: meta.id || 0, link: meta.link || null,
      time_iso: meta.time_iso, age_minutes: +ageMin.toFixed(1),
      value: val, sample: text.slice(0,180)
    });
  }

  return {
    source: url,
    raw_blocks: blocks.length,
    candidates,
    removed: removedCount,
    scanned_at: nowISO
  };
}

// ================================
// SECTION 6 — Aggregate all sources
// ================================
function dedupById(arr){
  const seen = new Set(); const out = [];
  for (const x of arr) {
    const key = `${x.source}#${x.id}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(x);
  }
  return out;
}
function sortedValues(arr){ return arr.slice().sort((a,b)=>a.value-b.value); }
function median(vals){
  if (!vals.length) return null;
  const a = vals.slice().sort((x,y)=>x-y);
  const n=a.length, m=Math.floor(n/2);
  return n%2? a[m] : (a[m-1]+a[m])/2;
}

// ================================
// SECTION 7 — Trimming & summary
// ================================
function trimmedMedian(values, trimFrac){
  const a = values.slice().sort((x,y)=>x-y);
  const n = a.length;
  const t = Math.min(Math.floor(n*trimFrac), Math.floor((n-1)/2));
  const trimmed = a.slice(t, n - t);
  return { med: median(trimmed), trimmedCount: t*2, n };
}
function summarize(allCandidates){
  const dedup = dedupById(allCandidates);
  const vals  = dedup.map(x=>x.value);
  const n     = vals.length;

  if (n === 0) return {used:[], min:null,max:null,median:null,spread:null,estimate:null,method:null};

  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const med  = median(vals);
  const spreadPct = med ? ((maxV - minV) / med) * 100 : null;

  let estimate = null, method = null, used = [];
  if (n >= NEED_MIN_SAMPLES && spreadPct != null && spreadPct <= PCT_SPREAD_MAX) {
    const { med:tm, trimmedCount } = trimmedMedian(vals, TRIM_FRAC);
    estimate = Math.round(tm ?? med);
    method = trimmedCount > 0 ? "trimmed_median" : "median";
    // برای نمایش نمونه‌های استفاده‌شده: نزدیک به میانه
    const sorted = sortedValues(dedup);
    used = sorted;
  }
  return {
    used, min:minV, max:maxV, median:med,
    spread: spreadPct != null ? +spreadPct.toFixed(3) : null,
    estimate, method
  };
}

// ================================
// SECTION 8 — Build output payload
// ================================
function buildPayload(resultPerSource, summary) {
  const perSrcCounts = resultPerSource.map(r => ({
    source: r.source,
    raw_blocks: r.raw_blocks,
    candidates: r.candidates.length,
    removed: r.removed
  }));
  const samples_used = (summary.used || []).map(x => ({
    source: x.source, id: x.id, link: x.link,
    time_iso: x.time_iso, age_minutes: x.age_minutes,
    value: x.value, sample: x.sample
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
      plausible: { min: PLAUS_MIN, max: PLAUS_MAX }
    },
    counts: {
      per_source: perSrcCounts,
      candidates_all: resultPerSource.reduce((a,b)=>a+b.candidates.length,0),
      deduped: (new Set(summary.used.map(u=>`${u.source}#${u.id}`))).size,
      removed_all: resultPerSource.reduce((a,b)=>a+b.removed,0)
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
    removed_examples: [] // فعلاً نمونه‌های ردشده را لاگ نمی‌کنیم
  };
}

// ================================
// SECTION 9 — Main
// ================================
async function main(){
  const results = [];
  for (const url of SOURCES) {
    try { results.push(await scanSource(url)); }
    catch(e){ results.push({ source:url, raw_blocks:0, candidates:[], removed:0, error:String(e) }); }
  }
  const all = results.flatMap(r => r.candidates);
  const sum = summarize(all);

  const payload = buildPayload(results, sum);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);
}
main().catch(e => { console.error(e); process.exit(1); });
