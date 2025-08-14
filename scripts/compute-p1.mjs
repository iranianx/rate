// [S1] Imports, Paths & Config IO — مسیرها، بارگذاری baseline/thresholds
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const STATE_DIR = path.join(ROOT, "state");
const DATA_DIR = path.join(ROOT, "data");

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "baseline.json"), "utf-8"));
const TH = JSON.parse(fs.readFileSync(path.join(ROOT, "thresholds.json"), "utf-8"));

const INPUT_SOURCES = path.join(DATA_DIR, "sources.json");
const STATE_EWMA = path.join(STATE_DIR, "ewma.json");
const RATES_PATH = path.join(DOCS, "rates.json");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// [S2] Debug Output Setup — تنظیم خروجی تست در docs/debug/compute-report.json
const DEBUG_DIR  = path.join(DOCS, "debug");
const DEBUG_FILE = path.join(DEBUG_DIR, "compute-report.json");
fs.mkdirSync(DEBUG_DIR, { recursive: true });

function pick(obj, keys){
  const o = {};
  for (const k of keys) if (k in obj) o[k] = obj[k];
  return o;
}

// [S3] Small Utils — readJSON, writeJSON, nowISO, roundInt
function readJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function nowISO() {
  return new Date().toISOString();
}

function roundInt(n) {
  return Math.round(Number(n) || 0);
}
// [S4] EWMA & Stats Helpers — ALPHA, updateEWMA, pctDelta, median
// EWMA با پنجره‌ی مؤثر ~60 دقیقه (گام‌های 10 دقیقه‌ای) → alpha ≈ 2/7
const ALPHA = 2 / 7;

function updateEWMA(prev, value) {
  return (prev == null || !isFinite(prev))
    ? value
    : (ALPHA * value + (1 - ALPHA) * prev);
}

function pctDelta(x, ref) {
  return (!isFinite(x) || !isFinite(ref) || ref === 0)
    ? 0
    : 100 * (x / ref - 1);
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// [S4.1] Outlier filter (±5% from others' min/max)
function filterOutliers5pct(items, pct = 5) {
  if (!Array.isArray(items) || items.length <= 1) {
    return { kept: items.slice(), outliers: [] };
  }
  const kept = [];
  const outliers = [];
  const lo = 1 - pct / 100;
  const hi = 1 + pct / 100;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // سایر منابع (به‌جز خودش)
    const others = [];
    for (let j = 0; j < items.length; j++) {
      if (j !== i && isFinite(items[j].val)) others.push(items[j].val);
    }
    if (others.length === 0) { kept.push(it); continue; }

    const minO = Math.min(...others);
    const maxO = Math.max(...others);

    const tooLow  = it.val < lo * minO;
    const tooHigh = it.val > hi * maxO;

    if (tooLow || tooHigh) {
      outliers.push({ ...it, reason: "outlier±5%" });
    } else {
      kept.push(it);
    }
  }
  return { kept, outliers };
}

// [S5] Delta Combiner — فیلترها/وزن‌دهی منابع و به‌روزرسانی state/ewma.json
// خروجی: { delta, used, removed, newState, details }
function computeCombinedDelta(kind, sources, ewmaState) {
  const ttl_ms = (TH.ttl_minutes ?? 45) * 60_000;
  const now = Date.now();
  const anchor = BASELINE[(kind === "usd" ? "USD_TMN" : "USDT_TMN")].anchor;

  // آیتم‌های خام با prev/ewmaNew/age
  const items = (sources[kind] || []).map(s => {
    const key = `${kind}:${s.source}`;
    const prev = ewmaState[key]?.ewma ?? anchor;
    const ewmaNew = updateEWMA(prev, s.val);
    const delta = pctDelta(s.val, prev);
    const age = now - new Date(s.ts || nowISO()).getTime();
    return { source: s.source, val: s.val, prev, delta, ewmaNew, age, ts: s.ts };
  });

  // فیلتر سنی (TTL)
  let active = items.filter(it => it.age <= ttl_ms);
  if (active.length === 0 && items.length) active = items.slice();
  if (active.length === 0) {
    return {
      delta: 0, used: [], removed: [], newState: ewmaState,
      details: {
        items, active: [], filtered: [], outliers: [],
        medAbs: 0, m: 0,
        params: {
          marketMin: TH.market_min_median ?? 0.15, // ٪
          flatCut:   TH.flat_cut_abs_pct ?? 0.02,  // ٪
          halfGap:   TH.half_weight_gap_pct ?? 5.0,
          dropGap:   TH.drop_gap_pct ?? 10.0,
          ttl_minutes: TH.ttl_minutes ?? 45,
          outlier_pct: 5
        },
        note: "no-active"
      }
    };
  }

  // --- حذف پرت‌های ±۵٪ نسبت به بازهٔ سایر منابع
  const { kept: activeNoOutliers, outliers } = filterOutliers5pct(active, 5);
  active = activeNoOutliers;

  // حذف منابع فلت وقتی بازار واقعاً حرکت دارد
  const medAbs = median(active.map(it => Math.abs(it.delta)));
  const marketMin = TH.market_min_median ?? 0.15; // ٪
  const flatCut   = TH.flat_cut_abs_pct ?? 0.02;  // ٪
  let filtered = (medAbs >= marketMin)
    ? active.filter(it => Math.abs(it.delta) >= flatCut)
    : active.slice();

  // مدین دلتاها، و اعمال وزن/حذف براساس فاصله از مدین
  const m = median(filtered.map(it => it.delta));
  const halfGap = TH.half_weight_gap_pct ?? 5.0;
  const dropGap = TH.drop_gap_pct ?? 10.0;

  const used = [];
  const removed = [...outliers]; // ابتدا پرت‌ها را در removed بگذاریم
  for (const it of filtered) {
    const gap = Math.abs(it.delta - m);
    if (gap > dropGap) { removed.push({ ...it, reason: "drop>10%" }); continue; }
    const w = gap > halfGap ? 0.5 : 1.0;
    used.push({ ...it, w });
  }

  // میانگین وزنی دلتاها (اگر چیزی نماند، همان مدین)
  const comb = used.length
    ? used.reduce((a, b) => a + b.w * b.delta, 0) / used.reduce((a, b) => a + b.w, 0)
    : (m || 0);

  // جزئیات برای گزارش تست
  const details = {
    items,
    active,
    filtered,
    outliers, // پرت‌ها برای دیباگ
    medAbs, m,
    params: { marketMin, flatCut, halfGap, dropGap, ttl_minutes: TH.ttl_minutes ?? 45, outlier_pct: 5 }
  };

  // به‌روزرسانی EWMA state
  const newState = { ...ewmaState };
  for (const it of items) {
    const key = `${kind}:${it.source}`;
    newState[key] = { ewma: it.ewmaNew, ts: nowISO() };
  }

  return { delta: comb, used, removed, newState, details };
}

// [S6] Baseline Apply Helper — اعمال delta روی anchor/offset
function applyBaseline(deltaPct, { anchor, offset_pct = 0 }) {
  return roundInt(
    anchor *
    (1 + deltaPct / 100) *
    (1 + (offset_pct || 0) / 100)
  );
}

// [S7] FX Setup & Fetchers — گرفتن USD→X از APIها
// اگر در baseline.symbols_fx تعریف نشده بود، این لیست پیش‌فرض استفاده می‌شود
const FX_SYMBOLS = BASELINE.symbols_fx || [
  "EUR","GBP","TRY","JPY","CNY","GEL","AMD",
  "CAD","AUD","RUB","AED","KWD","IQD","SAR","AZN","AFN"
];

async function fetchJson(url){
  const r = await fetch(url, { headers: { "user-agent": "IranianX/1.0" }});
  if (!r.ok) throw new Error("HTTP "+r.status);
  return r.json();
}

async function getUsdRates(){
  const syms = FX_SYMBOLS.join(",");
  // 1) exchangerate.host
  try {
    const j = await fetchJson(`https://api.exchangerate.host/latest?base=USD&symbols=${syms}`);
    if (j && j.rates) return j.rates; // {EUR:1.09, TRY:33.1, ...}
  } catch {}
  // 2) frankfurter.app
  try {
    const j = await fetchJson(`https://api.frankfurter.app/latest?from=USD&to=${syms}`);
    if (j && j.rates) return j.rates;
  } catch {}
  // 3) fallback: نرخ 1 برای زنده‌ماندن محاسبه
  const fallback = {}; for (const s of FX_SYMBOLS) fallback[s] = 1;
  return fallback;
}

// [S8] main(): compute & write — خواندن ورودی‌ها، محاسبات، ساخت spot و rates
async function main(){
  // ورودی‌های خام و وضعیت EWMA
  const sources   = readJSON(INPUT_SOURCES, { usd:[], usdt:[] });
  const ewmaState = readJSON(STATE_EWMA, {});

  // ترکیب دلتاها برای USD/USDT
  const cUSD  = computeCombinedDelta("usd",  sources, ewmaState);
  const cUSDT = computeCombinedDelta("usdt", sources, cUSD.newState ?? ewmaState);

   // اعمال delta روی baseline ها (USD) و سپس منطق USDT⇄USD
  const USD_TMN = applyBaseline(cUSD.delta, BASELINE.USD_TMN);

  // 1) میانگین وزنی USDT از منابع معتبر (بعد از فیلترها)
  const avgUSDT_from_sources = (() => {
    const arr = cUSDT.used || [];
    if (!arr.length) return null;
    const num = arr.reduce((a, b) => a + ( (b.w ?? 1) * b.val ), 0);
    const den = arr.reduce((a, b) => a + ( (b.w ?? 1) ), 0) || 1;
    return num / den;
  })();

  // 2) USDT از USD (برابر می‌گیریم)
  const USDT_from_USD = USD_TMN;

  // 3) تصمیم‌گیر USDT نهایی
  let USDT_TMN = applyBaseline(cUSDT.delta, BASELINE.USDT_TMN); // fallback: همان روال قبلی
  let USDT_decision = { mode: "baseline", avg_sources: null, from_usd: USDT_from_USD, diff_pct: null };

  if (avgUSDT_from_sources != null && isFinite(avgUSDT_from_sources)) {
    const diff_pct = Math.abs(avgUSDT_from_sources / USDT_from_USD - 1) * 100;
    if (diff_pct <= 1.0) {
      // اختلاف ≤ ±۱٪ → نگه‌داشتن میانگین منابع
      USDT_TMN = roundInt(avgUSDT_from_sources);
      USDT_decision = { mode: "avg_sources", avg_sources: +avgUSDT_from_sources.toFixed(3), from_usd: USDT_from_USD, diff_pct: +diff_pct.toFixed(3) };
    } else {
      // اختلاف > ±۱٪ → میانگین دوبارهٔ این دو عدد
      USDT_TMN = roundInt( (avgUSDT_from_sources + USDT_from_USD) / 2 );
      USDT_decision = { mode: "avg_of(avg_sources,from_usd)", avg_sources: +avgUSDT_from_sources.toFixed(3), from_usd: USDT_from_USD, diff_pct: +diff_pct.toFixed(3) };
    }
  }

  // نرخ‌های بین‌المللی USD→X
  const usdRates = await getUsdRates();

  // ساخت spot: 1 X = USD_TMN / (USD→X)
  const spot = { USD_TMN, USDT_TMN };
  for (const sym of FX_SYMBOLS){
    const r = Number(usdRates[sym]); // 1 USD = r X
    const x_tmn = r && isFinite(r) ? USD_TMN / r : USD_TMN; // fallback امن
    spot[`${sym}_TMN`] = roundInt(x_tmn);
  }

  // به‌روزرسانی docs/rates.json
  const rates = readJSON(RATES_PATH, {
    updated_at: nowISO(),
    delta:{ usd_pct:0, usdt_pct:0, quality:{ usd:{active:0}, usdt:{active:0} } },
    spot:{}, sources:{}
  });

  rates.updated_at       = nowISO();
  rates.delta.usd_pct    = +cUSD.delta.toFixed(3);
  rates.delta.usdt_pct   = +cUSDT.delta.toFixed(3);
  rates.delta.quality    = {
    usd:  { active: cUSD.used?.length  ?? 0 },
    usdt: { active: cUSDT.used?.length ?? 0 }
  };
  rates.spot             = { ...rates.spot, ...spot };
  rates.sources          = {
    usd_used:  (cUSD.used   || []).map(({source,val,delta,w})   => ({ source, val, delta:+delta.toFixed(3), w })),
    usd_drop:  (cUSD.removed|| []).map(({source,val,delta,reason})=> ({ source, val, delta:+delta.toFixed(3), reason })),
    usdt_used: (cUSDT.used  || []).map(({source,val,delta,w})   => ({ source, val, delta:+delta.toFixed(3), w })),
    usdt_drop: (cUSDT.removed||[]).map(({source,val,delta,reason})=> ({ source, val, delta:+delta.toFixed(3), reason }))
  };

  // گزارش تست (docs/debug/compute-report.json)
  const fxKeysWanted = [
    "USD_TMN","USDT_TMN","EUR_TMN","GBP_TMN","CAD_TMN","AUD_TMN","RUB_TMN",
    "AED_TMN","KWD_TMN","IQD_TMN","SAR_TMN","TRY_TMN","GEL_TMN","AZN_TMN",
    "AMD_TMN","JPY_TMN","CNY_TMN","AFN_TMN"
  ];

  const debugReport = {
    updated_at: nowISO(),
    note: "Temporary compute report for manual verification",
    inputs: {
      sources,
      baseline: {
        USD_TMN:  pick(BASELINE.USD_TMN,  ["anchor","offset_pct"]),
        USDT_TMN: pick(BASELINE.USDT_TMN, ["anchor","offset_pct"]),
        symbols_fx: BASELINE.symbols_fx || FX_SYMBOLS
      },
      thresholds: TH
    },
    process: {
      usd: {
        anchor: BASELINE.USD_TMN.anchor,
        offset_pct: BASELINE.USD_TMN.offset_pct || 0,
        med_abs_delta_pct: cUSD.details.medAbs,
        median_delta_pct:   cUSD.details.m,
        params: cUSD.details.params,
        items_all:      cUSD.details.items,     // {source,val,prev,delta,ewmaNew,age,ts}
        items_active:   cUSD.details.active,
        items_filtered: cUSD.details.filtered,
        used:           cUSD.used,
        removed:        cUSD.removed,
        delta_combined_pct: cUSD.delta
      },
       usdt: {
        anchor: BASELINE.USDT_TMN.anchor,
        offset_pct: BASELINE.USDT_TMN.offset_pct || 0,
        med_abs_delta_pct: cUSDT.details.medAbs,
        median_delta_pct:   cUSDT.details.m,
        params: cUSDT.details.params,
        items_all:      cUSDT.details.items,
        items_active:   cUSDT.details.active,
        items_filtered: cUSDT.details.filtered,
        used:           cUSDT.used,
        removed:        cUSDT.removed,
        delta_combined_pct: cUSDT.delta,
        // NEW: سیاست نهایی‌سازی USDT
        avg_from_sources:  (avgUSDT_from_sources ?? null),
        from_usd:          USDT_from_USD,
        decision:          USDT_decision
      }
    },
    fx: {
      usd_to_x_rates: usdRates
    },
    outputs: {
      USD_TMN, USDT_TMN,
      spot_subset: Object.fromEntries(
        Object.entries({ ...spot }).filter(([k]) => fxKeysWanted.includes(k))
      )
    },
    ewma_after: cUSDT.newState
  };

  // نوشتن خروجی‌ها
  writeJSON(RATES_PATH, rates);
  writeJSON(STATE_EWMA, cUSDT.newState ?? ewmaState);
  writeJSON(DEBUG_FILE, debugReport);

  console.log("OK • USD_TMN=%s, USDT_TMN=%s, FX done for: %s",
    USD_TMN, USDT_TMN, FX_SYMBOLS.join(","));
}

// [S9] Entrypoint — اجرای main() و مدیریت خطا
main().catch(err => {
  console.error(err);
  process.exit(1);
});
