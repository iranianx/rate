import fs from "fs";
import path from "path";
import { createCanvas } from "canvas";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const STATE = path.join(ROOT, "state");
const RATES_PATH = path.join(DOCS, "rates.json");
const OUT = path.join(DOCS, "p1.png");
const BASELINE_PATH = path.join(ROOT, "baseline.json");
const PREV_SPOT_PATH = path.join(STATE, "prev_spot.json");

fs.mkdirSync(STATE, { recursive: true });

const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","CHF_TMN","CAD_TMN","AUD_TMN","SEK_TMN","NOK_TMN","RUB_TMN","THB_TMN","SGD_TMN","HKD_TMN","AZN_TMN","AMD_TMN"];
const LABELS = {
  USD:"US Dollar", EUR:"Euro", GBP:"British Pound", CHF:"Swiss Franc", CAD:"Canadian Dollar",
  AUD:"Australian Dollar", SEK:"Swedish Krona", NOK:"Norwegian Krone", RUB:"Russian Ruble",
  THB:"Thai Baht", SGD:"Singapore Dollar", HKD:"Hong Kong Dollar", AZN:"Azerbaijani Manat",
  AMD:"Armenian Dram"
};
const FLAGS = {
  USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", CHF:"🇨🇭", CAD:"🇨🇦", AUD:"🇦🇺", SEK:"🇸🇪", NOK:"🇳🇴",
  RUB:"🇷🇺", THB:"🇹🇭", SGD:"🇸🇬", HKD:"🇭🇰", AZN:"🇦🇿", AMD:"🇦🇲"
};

function readJSON(p, fb){ if(!fs.existsSync(p)) return fb; try{return JSON.parse(fs.readFileSync(p,"utf-8"))}catch{return fb} }
function writeJSON(p, o){ fs.writeFileSync(p, JSON.stringify(o,null,2)) }
function fmt(n){ const v=Number(n); return isFinite(v)?v.toLocaleString("en-US"):"-"; }
function signDir(cur, prev){ if(!isFinite(prev)) return 0; const d=Number(cur)-Number(prev); return Math.abs(d)<1?0:(d>0?1:-1); }

const W = 720, PAD = 14;
const HEADER_H = 42;
const COL = {  // شبیه چینش عکس 2
  flag:  PAD + 6,
  code:  PAD + 36,
  name:  PAD + 90,
  sell:  W - 220,
  buy:   W - 70
};
const ROW_H = 40;

function header(ctx, updatedAt){
  // پس‌زمینه سفید کل
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0,0,W,HEADER_H);

  // نوار عنوان جدول
  ctx.fillStyle = "#e8f2ff";
  ctx.fillRect(0, HEADER_H-28, W, 28);

  ctx.fillStyle = "#2c3e50";
  ctx.font = "600 16px system-ui, Arial";
  ctx.textAlign = "left";
  ctx.fillText("Code",  PAD + 16, HEADER_H-9);
  ctx.fillText("Currency", COL.name, HEADER_H-9);

  ctx.textAlign = "right";
  ctx.fillText("Sell", COL.sell, HEADER_H-9);
  ctx.fillText("Buy",  COL.buy,  HEADER_H-9);

  // عنوان بالای جدول (اختیاری و جمع‌وجور)
  ctx.fillStyle = "#111";
  ctx.font = "700 18px system-ui, Arial";
  ctx.textAlign = "left";
  ctx.fillText("IranianX — Fiat", PAD, 20);

  ctx.fillStyle="#c00";
  ctx.font="700 12px system-ui, Arial";
  const ts = updatedAt? new Date(updatedAt).toLocaleString() : new Date().toLocaleString();
  ctx.fillText("Updated: "+ts, PAD, 36);
}

function arrow(ctx, dir, x, yc){
  if(dir>0) ctx.fillStyle="#1f8f3a";
  else if(dir<0) ctx.fillStyle="#c62828";
  else ctx.fillStyle="#1e88e5";

  ctx.beginPath();
  if(dir>0){ // ▲
    ctx.moveTo(x-6, yc+5); ctx.lineTo(x+6, yc+5); ctx.lineTo(x, yc-5);
  }else if(dir<0){ // ▼
    ctx.moveTo(x-6, yc-5); ctx.lineTo(x+6, yc-5); ctx.lineTo(x, yc+5);
  }else{ // ▶
    ctx.moveTo(x-6, yc-6); ctx.lineTo(x+6, yc); ctx.lineTo(x-6, yc+6);
  }
  ctx.closePath(); ctx.fill();
}

function row(ctx, i, r){
  const y = HEADER_H + i*ROW_H;

  // زمینه سفید و خط جداکننده
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, y, W, ROW_H);
  ctx.fillStyle = "#e6e6e6";
  ctx.fillRect(0, y+ROW_H-1, W, 1);

  // Flag
  ctx.textAlign="left";
  ctx.font="700 18px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Arial";
  ctx.fillStyle="#1f2a39";
  const flag = FLAGS[r.sym] || "";
  if(flag) ctx.fillText(flag, COL.flag, y+26);

  // Code
  ctx.font="700 16px system-ui, Arial";
  ctx.fillText(r.sym, COL.code, y+26);

  // Currency name
  ctx.font="600 16px system-ui, Arial";
  ctx.fillText(r.label, COL.name, y+26);

  // Sell value + arrow
  ctx.textAlign="right";
  ctx.font="600 18px system-ui, Arial";
  ctx.fillStyle="#1f2a39";
  ctx.fillText(fmt(r.sell), COL.sell, y+26);
  arrow(ctx, r.dirSell, COL.sell-20, y+20);

  // Buy value + arrow (هم‌جهت با تغییر Sell؛ اگر مستقل داشتی، اینجا محاسبه کن)
  ctx.fillStyle="#1f2a39";
  ctx.fillText(fmt(r.buy), COL.buy, y+26);
  arrow(ctx, r.dirSell, COL.buy-20, y+20);
}

async function main(){
  const rates = readJSON(RATES_PATH, null); if(!rates) throw new Error("docs/rates.json not found");
  const base  = readJSON(BASELINE_PATH, {});
  const prev  = readJSON(PREV_SPOT_PATH, {});

  const spreadPct = Number(base.spread_pct ?? 0.6);

  const rows=[];
  for(const code of ORDER){
    const sell = rates.spot?.[code];
    if(sell==null) continue;
    const buy = Math.round(sell * (1 - spreadPct/100));
    const sym = code.replace("_TMN","");
    const dirSell = signDir(sell, prev[code]);
    rows.push({sym, label: LABELS[sym]||sym, sell, buy, dirSell, code});
  }

  const H = HEADER_H + rows.length*ROW_H + 18;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه
  ctx.fillStyle="#ffffff";
  ctx.fillRect(0,0,W,H);

  header(ctx, rates.updated_at);
  rows.forEach((r,i)=>row(ctx,i,r));

  // فوتر کوچک
  ctx.textAlign="left"; ctx.fillStyle="#9aa0a6"; ctx.font="400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • © "+new Date().getFullYear(), PAD, H-6);

  fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
  const nextPrev = {...prev}; rows.forEach(r=>{ nextPrev[r.code]=r.sell; });
  writeJSON(PREV_SPOT_PATH, nextPrev);
  console.log("Wrote", OUT, "size:", W, "x", H);
}

main().catch(e=>{ console.error(e); process.exit(1); });
