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

const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];
const LABELS = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", TRY: "Turkish Lira",
  JPY: "Japanese Yen", CNY: "Chinese Yuan", GEL: "Georgian Lari", AMD: "Armenian Dram"
};
const FLAGS = { // ایموجی پرچم؛ اگر روی runner رندر نشد، فقط code نشان داده می‌شود
  USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", TRY:"🇹🇷", JPY:"🇯🇵", CNY:"🇨🇳", GEL:"🇬🇪", AMD:"🇦🇲"
};

function readJSON(p, fb){ if(!fs.existsSync(p)) return fb; try{return JSON.parse(fs.readFileSync(p,"utf-8"))}catch{return fb} }
function writeJSON(p, o){ fs.writeFileSync(p, JSON.stringify(o,null,2)) }
function fmt(n){ const v=Number(n); return isFinite(v)?v.toLocaleString("en-US"):"-"; }
function signDir(cur, prev){ if(!isFinite(prev)) return 0; const d=cur-prev; return Math.abs(d)<1?0:(d>0?1:-1); }

const W=1100, PAD=16, HEADER_TOP=12, TITLE_H=36, SUB_H=20;
const TABLE_Y = HEADER_TOP + TITLE_H + SUB_H + 12;
const ROW_H = 44, ROW_GAP=2;
const COL = {
  flag: PAD+6,
  code: PAD+46,
  curr: PAD+110,
  sell: PAD+700,
  buy : PAD+900
};

function roundedRect(ctx,x,y,w,h,r=8){ ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

function header(ctx, updatedAt){
  ctx.fillStyle="#000"; ctx.font="700 26px system-ui, Arial";
  ctx.fillText("IranianX — Fiat", PAD, HEADER_TOP + 26);

  ctx.fillStyle="#c00"; ctx.font="700 14px system-ui, Arial";
  const ts = updatedAt? new Date(updatedAt).toLocaleString() : new Date().toLocaleString();
  ctx.fillText("Updated: "+ts, PAD, HEADER_TOP + 26 + 18);

  // نوار عنوان جدول
  const y = TABLE_Y - 32, x = PAD, w = W-PAD*2, h = 32;
  ctx.fillStyle="#dfeaf7"; roundedRect(ctx,x,y,w,h,8); ctx.fill();
  ctx.fillStyle="#2c3e50"; ctx.font="700 14px system-ui, Arial";
  ctx.textAlign="left";
  ctx.fillText("Code", COL.code, y+22);
  ctx.fillText("Currency", COL.curr, y+22);
  ctx.textAlign="right";
  ctx.fillText("Sell", COL.sell, y+22);
  ctx.fillText("Buy",  COL.buy,  y+22);
}

function arrow(ctx, dir, x, y){ // ▲▼▶
  if(dir>0) ctx.fillStyle="#2e7d32"; else if(dir<0) ctx.fillStyle="#c62828"; else ctx.fillStyle="#1e88e5";
  ctx.beginPath();
  if(dir>0){ ctx.moveTo(x, y+10); ctx.lineTo(x+10,y+10); ctx.lineTo(x+5,y); }
  else if(dir<0){ ctx.moveTo(x, y); ctx.lineTo(x+10,y); ctx.lineTo(x+5,y+10); }
  else { // ▶
    ctx.moveTo(x, y); ctx.lineTo(x+10,y+5); ctx.lineTo(x, y+10);
  }
  ctx.closePath(); ctx.fill();
}

function row(ctx,i,{sym,label,sell,buy,dir}){
  const y = TABLE_Y + i*(ROW_H+ROW_GAP);
  const x = PAD, w = W-PAD*2, h = ROW_H;

  // پس‌زمینه ردیف
  ctx.fillStyle="#f6f8fb"; roundedRect(ctx,x,y,w,h,10); ctx.fill();

  // پرچم
  ctx.textAlign="left"; ctx.font="700 18px system-ui, Arial"; ctx.fillStyle="#1f2a39";
  const flag = FLAGS[sym] || "";
  if(flag){
    ctx.font="700 20px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Arial";
    ctx.fillText(flag, COL.flag, y+27);
  }

  // Code
  ctx.font="700 16px system-ui, Arial"; ctx.fillStyle="#1f2a39";
  ctx.fillText(sym, COL.code, y+27);

  // Currency
  ctx.font="600 16px system-ui, Arial"; ctx.fillStyle="#1f2a39";
  ctx.fillText(label, COL.curr, y+27);

  // Sell + فلش
  ctx.textAlign="right"; ctx.font="600 18px system-ui, Arial"; ctx.fillStyle="#1f2a39";
  ctx.fillText(fmt(sell), COL.sell, y+27);
  arrow(ctx, dir, COL.sell-26, y+12);

  // Buy
  ctx.fillStyle="#1f2a39";
  ctx.fillText(fmt(buy), COL.buy, y+27);
}

async function main(){
  const rates = readJSON(RATES_PATH, null); if(!rates) throw new Error("docs/rates.json not found");
  const base  = readJSON(BASELINE_PATH, {});
  const prev  = readJSON(PREV_SPOT_PATH, {});
  const spreadPct = Number(base.spread_pct ?? 0.6);

  // ردیف‌ها
  const rows=[];
  for(const code of ORDER){
    const sell = rates.spot?.[code];
    if(sell==null) continue;
    const buy = Math.round(sell * (1 - spreadPct/100));
    const sym = code.replace("_TMN","");
    const dir = signDir(sell, prev[code]);
    rows.push({sym, label: LABELS[sym]||sym, sell, buy, dir, code});
  }

  const H = TABLE_Y + rows.length*(ROW_H+ROW_GAP) + PAD + 12;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه سفید
  ctx.fillStyle="#fff"; ctx.fillRect(0,0,W,H);

  // هدر
  header(ctx, rates.updated_at);

  // ردیف‌ها
  rows.forEach((r,i)=>row(ctx,i,r));

  // فوتر
  ctx.textAlign="left"; ctx.fillStyle="#9aa0a6"; ctx.font="400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • © "+new Date().getFullYear(), PAD, H-8);

  // خروجی
  fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
  const nextPrev = {...prev}; rows.forEach(r=>{ nextPrev[r.code]=r.sell; });
  writeJSON(PREV_SPOT_PATH, nextPrev);
  console.log("Wrote", OUT);
}

main().catch(e=>{ console.error(e); process.exit(1); });
