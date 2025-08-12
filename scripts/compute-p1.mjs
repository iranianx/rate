// scripts/compute-p1.mjs
// محاسبات صفحه 1 (Fiat): قواعد 1–5 + تبدیل سایر ارزها با USD→X از FX API

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

function readJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function nowISO(){ return new Date().toISOString(); }

// --- EWMA (60 دقیقه با گام 10 دقیقه => alpha≈0.2857)
const ALPHA = 2 / 7;
function updateEWMA(prev, value) { return (prev==null||!isFinite(prev)) ? value : (ALPHA*value + (1-ALPHA)*prev); }
function pctDelta(x, ref) { return (!isFinite(x)||!isFinite(ref)||ref===0)?0:100*(x/ref-1); }
function median(arr){ const a=arr.slice().sort((x,y)=>x-y); const n=a.length; if(!n) return 0; const m=Math.floor(n/2); return n%2?a[m]:(a[m-1]+a[m])/2; }
function roundInt(n){ return Math.round(Number(n)||0); }

function computeCombinedDelta(kind, sources, ewmaState) {
  const ttl_ms = (TH.ttl_minutes ?? 45) * 60_000;
  const now = Date.now();
  const anchor = BASELINE[(kind==="usd"?"USD_TMN":"USDT_TMN")].anchor;

  const items = (sources[kind]||[]).map(s=>{
    const key = `${kind}:${s.source}`;
    const prev = ewmaState[key]?.ewma ?? anchor;
    const ewmaNew = updateEWMA(prev, s.val);
    const delta = pctDelta(s.val, prev);
    const age = now - new Date(s.ts || nowISO()).getTime();
    return { source:s.source, val:s.val, prev, delta, ewmaNew, age };
  });

  let active = items.filter(it => it.age <= ttl_ms);
  if (active.length===0 && items.length) active = items.slice();
  if (active.length===0) return { delta:0, used:[], removed:[], newState:ewmaState };

  // حذف منبع ثابت وقتی بازار حرکت دارد
  const medAbs = median(active.map(it=>Math.abs(it.delta)));
  const marketMin = TH.market_min_median ?? 0.15; // %
  const flatCut = TH.flat_cut_abs_pct ?? 0.02;    // %
  let filtered = (medAbs >= marketMin)
    ? active.filter(it => Math.abs(it.delta) >= flatCut)
    : active.slice();

  const m = median(filtered.map(it=>it.delta));
  const halfGap = TH.half_weight_gap_pct ?? 5.0;
  const dropGap = TH.drop_gap_pct ?? 10.0;

  const used = [], removed = [];
  for (const it of filtered){
    const gap = Math.abs(it.delta - m);
    if (gap > dropGap) { removed.push({...it, reason:"drop>10%"}); continue; }
    const w = gap > halfGap ? 0.5 : 1.0;
    used.push({ ...it, w });
  }

  const comb = used.length
    ? used.reduce((a,b)=>a+b.w*b.delta,0) / used.reduce((a,b)=>a+b.w,0)
    : (m||0);

  const newState = { ...ewmaState };
  for (const it of items){
    const key = `${kind}:${it.source}`;
    newState[key] = { ewma: it.ewmaNew, ts: nowISO() };
  }
  return { delta: comb, used, removed, newState };
}

function applyBaseline(deltaPct, {anchor, offset_pct=0}){
  return roundInt( anchor * (1 + deltaPct/100) * (1 + (offset_pct||0)/100) );
}

// ---- FX: گرفتن USD→{EUR,GBP,TRY,JPY,CNY,GEL,AMD} با fallback
const FX_SYMBOLS = BASELINE.symbols_fx || ["EUR","GBP","TRY","JPY","CNY","GEL","AMD"];

async function fetchJson(url){
  const r = await fetch(url, { headers: { "user-agent": "IranianX/1.0" }});
  if (!r.ok) throw new Error("HTTP "+r.status);
  return r.json();
}
async function getUsdRates(){
  // 1) exchangerate.host
  const syms = FX_SYMBOLS.join(",");
  try {
    const j = await fetchJson(`https://api.exchangerate.host/latest?base=USD&symbols=${syms}`);
    if (j && j.rates) return j.rates; // {EUR:1.09,...}
  } catch {}
  // 2) frankfurter.app
  try {
    const j = await fetchJson(`https://api.frankfurter.app/latest?from=USD&to=${syms}`);
    if (j && j.rates) return j.rates;
  } catch {}
  // 3) در بدترین حالت، بازگشت نرخ 1 (تا صفحه نخوابد)
  const fallback = {}; for (const s of FX_SYMBOLS) fallback[s]=1;
  return fallback;
}

async function main(){
  const sources = readJSON(INPUT_SOURCES, { usd:[], usdt:[] });
  const ewmaState = readJSON(STATE_EWMA, {});

  const cUSD  = computeCombinedDelta("usd",  sources, ewmaState);
  const cUSDT = computeCombinedDelta("usdt", sources, cUSD.newState ?? ewmaState);

  const USD_TMN  = applyBaseline(cUSD.delta,  BASELINE.USD_TMN);
  const USDT_TMN = applyBaseline(cUSDT.delta, BASELINE.USDT_TMN);

  // نرخ‌های بین‌المللی USD→X
  const usdRates = await getUsdRates(); // مثال: {EUR: 0.91, ...} یا بالعکس بسته به API

  // به تومان: 1 X = (USD_TMN) / (USD→X)
  const spot = {
    USD_TMN: USD_TMN,
    USDT_TMN: USDT_TMN
  };
  for (const sym of FX_SYMBOLS){
    const r = Number(usdRates[sym]);        // 1 USD = r X
    const x_tmn = r && isFinite(r) ? USD_TMN / r : USD_TMN; // safe fallback
    spot[`${sym}_TMN`] = roundInt(x_tmn);
  }

  // بروزرسانی rates.json
  const rates = readJSON(RATES_PATH, { updated_at: nowISO(), delta:{usd_pct:0,usdt_pct:0,quality:{usd:{active:0},usdt:{active:0}}}, spot:{}, sources:{} });
  rates.updated_at = nowISO();
  rates.delta.usd_pct  = +cUSD.delta.toFixed(3);
  rates.delta.usdt_pct = +cUSDT.delta.toFixed(3);
  rates.delta.quality = {
    usd:  { active: cUSD.used?.length  ?? 0 },
    usdt: { active: cUSDT.used?.length ?? 0 }
  };

  rates.spot = { ...rates.spot, ...spot };

  rates.sources = {
    usd_used:  (cUSD.used||[]).map(({source,val,delta,w})=>({source,val,delta:+delta.toFixed(3),w})),
    usd_drop:  (cUSD.removed||[]).map(({source,val,delta,reason})=>({source,val,delta:+delta.toFixed(3),reason})),
    usdt_used: (cUSDT.used||[]).map(({source,val,delta,w})=>({source,val,delta:+delta.toFixed(3),w})),
    usdt_drop: (cUSDT.removed||[]).map(({source,val,delta,reason})=>({source,val,delta:+delta.toFixed(3),reason}))
  };

  writeJSON(RATES_PATH, rates);
  writeJSON(STATE_EWMA, cUSDT.newState ?? ewmaState);

  console.log("OK • USD_TMN=%s, USDT_TMN=%s, FX done for: %s",
    USD_TMN, USDT_TMN, FX_SYMBOLS.join(","));
}

main().catch(e=>{ console.error(e); process.exit(1); });
