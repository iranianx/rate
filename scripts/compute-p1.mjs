// scripts/compute-p1.mjs
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const STATE_DIR = path.join(ROOT, "state");
const DATA_DIR = path.join(ROOT, "data");

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "baseline.json"), "utf-8"));
const TH = JSON.parse(fs.readFileSync(path.join(ROOT, "thresholds.json"), "utf-8"));

const INPUT_SOURCES = path.join(DATA_DIR, "sources.json");   // پر می‌شود توسط Reader
const STATE_EWMA = path.join(STATE_DIR, "ewma.json");
const RATES_PATH = path.join(DOCS, "rates.json");

// تضمین دایرکتوری‌ها
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function nowISO(){ return new Date().toISOString(); }

// EWMA با پنجره ~60 دقیقه و گام 10 دقیقه => N=6 => alpha≈2/(6+1)=0.2857
const ALPHA = 2 / 7;

function updateEWMA(prev, value) {
  if (prev == null || !isFinite(prev)) return value;
  return ALPHA * value + (1 - ALPHA) * prev;
}

function pctDelta(x, ref) {
  if (!isFinite(x) || !isFinite(ref) || ref === 0) return 0;
  return 100 * (x / ref - 1);
}

function median(arr) {
  const a = arr.slice().sort((x,y)=>x-y);
  const n = a.length;
  if (!n) return 0;
  const mid = Math.floor(n/2);
  return n%2 ? a[mid] : (a[mid-1]+a[mid])/2;
}

function computeCombinedDelta(kind, sources, ewmaState) {
  // kind: "usd" | "usdt"
  const ttl_ms = (TH.ttl_minutes ?? 45) * 60_000;
  const now = Date.now();

  // 1) محاسبه Δ هر منبع نسبت به EWMA خودش (یا anchor اگر EWMA نیست)
  const anchor = BASELINE[(kind==="usd"?"USD_TMN":"USDT_TMN")].anchor;
  const items = [];

  for (const s of (sources[kind] || [])) {
    const key = `${kind}:${s.source}`;
    const prev = ewmaState[key]?.ewma ?? anchor;  // شروع از anchor
    const ewmaNew = updateEWMA(prev, s.val);
    const delta = pctDelta(s.val, prev);
    const age = now - new Date(s.ts || nowISO()).getTime();
    items.push({ source: s.source, val: s.val, prev, delta, ewmaNew, age });
  }

  // TTL: اگر قدیمی‌تر از ttl_ms → حذف
  let active = items.filter(it => it.age <= ttl_ms);

  // اگر همه حذف شدند، از همه بدون TTL استفاده کنیم تا خروجی داشته باشیم
  if (active.length === 0 && items.length) active = items.slice();

  if (active.length === 0) {
    return { delta: 0, used: [], removed: [] };
  }

  // 2) حذف منبع «ثابت» طبق بند 1 شما
  const absD = active.map(it => Math.abs(it.delta));
  const medAbs = median(absD);
  const marketMin = TH.market_min_median ?? 0.15; // %
  const flatCut = TH.flat_cut_abs_pct ?? 0.02;    // %
  let filtered = active.slice();
  if (medAbs >= marketMin) {
    filtered = active.filter(it => Math.abs(it.delta) >= flatCut);
  }

  // 3) پرت‌ها نسبت به میانه
  const m = median(filtered.map(it => it.delta));
  const halfGap = TH.half_weight_gap_pct ?? 5.0;
  const dropGap = TH.drop_gap_pct ?? 10.0;

  const used = [];
  const removed = [];

  for (const it of filtered) {
    const gap = Math.abs(it.delta - m);
    if (gap > dropGap) { removed.push({...it, reason:"drop>10%"}); continue; }
    const w = gap > halfGap ? 0.5 : 1.0;
    used.push({ ...it, w });
  }

  if (used.length === 0) {
    // اگر همه حذف شدند، برگردیم به میانه خام
    const d = m || 0;
    return { delta: d, used: [], removed: filtered.map(x=>({...x, reason:"fallback"})) };
  }

  const sumW = used.reduce((a,b)=>a+b.w, 0);
  const comb = used.reduce((a,b)=>a + b.w*b.delta, 0) / sumW;

  // به‌روزرسانی EWMA state
  const newState = { ...ewmaState };
  for (const it of items) {
    const key = `${kind}:${it.source}`;
    newState[key] = { ewma: it.ewmaNew, ts: nowISO() };
  }

  return { delta: comb, used, removed, newState };
}

function applyBaseline(deltaPct, anchor, offsetPct=0){
  return Math.round(anchor * (1 + deltaPct/100) * (1 + (offsetPct||0)/100));
}

async function main(){
  const sources = readJSON(INPUT_SOURCES, { usd:[], usdt:[] });
  const ewmaState = readJSON(STATE_EWMA, {});

  const cUSD  = computeCombinedDelta("usd", sources, ewmaState);
  const cUSDT = computeCombinedDelta("usdt", sources, cUSD.newState ?? ewmaState);

  const baseUSD  = BASELINE.USD_TMN;
  const baseUSDT = BASELINE.USDT_TMN;

  const USD_TMN  = applyBaseline(cUSD.delta,  baseUSD.anchor,  baseUSD.offset_pct);
  const USDT_TMN = applyBaseline(cUSDT.delta, baseUSDT.anchor, baseUSDT.offset_pct);

  // خواندن rates.json فعلی و به‌روزرسانی فقط صفحه ۱
  const rates = readJSON(RATES_PATH, {
    updated_at: nowISO(),
    delta: { usd_pct: 0, usdt_pct: 0, quality: { usd:{active:0}, usdt:{active:0} } },
    spot: {},
    sources: {}
  });

  rates.updated_at = nowISO();
  rates.delta.usd_pct  = +cUSD.delta.toFixed(3);
  rates.delta.usdt_pct = +cUSDT.delta.toFixed(3);
  rates.delta.quality = {
    usd:  { active: cUSD.used?.length ?? 0 },
    usdt: { active: cUSDT.used?.length ?? 0 }
  };

  // فقط جفت‌های صفحه ۱
  rates.spot.USD_TMN  = USD_TMN;
  rates.spot.USDT_TMN = USDT_TMN; // فعلاً برای نمایش تست؛ بعداً p1.png فقط USD/EUR/… می‌خواند

  // NOTE: در این مرحله نرخ‌های EUR/GBP/TRY/… را هنوز از FX API نیاوردیم.
  // به‌زودی ماژول FX اضافه می‌شود تا:
  // X_TMN = USD_TMN / (USD→X)  (یا ضرب اگر API معکوس بدهد)
  // و سپس در rates.spot قرار می‌گیرند.

  rates.sources = {
    usd_used:  (cUSD.used||[]).map(({source,val,delta,w})=>({source,val,delta:+delta.toFixed(3),w})),
    usd_drop:  (cUSD.removed||[]).map(({source,val,delta,reason})=>({source,val,delta:+delta.toFixed(3),reason})),
    usdt_used: (cUSDT.used||[]).map(({source,val,delta,w})=>({source,val,delta:+delta.toFixed(3),w})),
    usdt_drop: (cUSDT.removed||[]).map(({source,val,delta,reason})=>({source,val,delta:+delta.toFixed(3),reason}))
  };

  writeJSON(RATES_PATH, rates);
  writeJSON(STATE_EWMA, cUSDT.newState ?? ewmaState);

  console.log("OK • USDΔ=%s%% USDTΔ=%s%% → USD_TMN=%s USDT_TMN=%s",
    rates.delta.usd_pct, rates.delta.usdt_pct, USD_TMN, USDT_TMN);
}

main().catch(err=>{ console.error(err); process.exit(1); });
