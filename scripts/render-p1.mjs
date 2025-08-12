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

// 1) ترتیب و برچسب‌ها (همان قبلی است؛ اگر rates.json ارزهای بیشتری دارد می‌افزایی)
const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];
const LABELS = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", TRY: "Turkish Lira",
  JPY: "Japanese Yen", CNY: "Chinese Yuan", GEL: "Georgian Lari", AMD: "Armenian Dram"
};

// 2) پرچم‌ها (ایموجی رنگی)
const FLAGS = {
  USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", TRY:"🇹🇷",
  JPY:"🇯🇵", CNY:"🇨🇳", GEL:"🇬🇪", AMD:"🇦🇲"
};

// 3) تم رنگی مطابق تصویر
const COLORS = {
  text: "#22303a",        // رنگ متن‌ها و اعداد
  link: "#1976d2",        // رنگ کُد ارز (USD…)
  headBg: "#e9eef5",      // پس‌زمینه سرستون
  headText: "#2c3e50",    // متن سرستون
  rowBg: "#ffffff",       // زمینه ردیف‌ها (سفید مثل عکس)
  rowDivider: "#d9e2ef",  // خط جداکننده‌ی کم‌رنگ
  up: "#2e7d32",          // فلشِ افزایش
  down: "#c62828",        // فلشِ کاهش
  flat: "#1e88e5",        // فلشِ ثابت (▶ آبی)
  caret: "#1e88e5"        // مثلث کوچکِ قبل از اعداد (آبی)
};

// 4) نوار کناریِ ردیف‌ها (در تصویر وجود ندارد) ⇒ غیرفعال
const THEME = {
  enableLeftStripe: false // بعداً در تابع row از این استفاده می‌کنیم
};
// اگر بخواهی بعداً فعالش کنی، true کن و این پالت را بده:
const STRIPE = {
  USD: "#3b82f6", EUR: "#1e40af", GBP: "#ef4444", TRY: "#dc2626",
  JPY: "#f43f5e", CNY: "#b91c1c", GEL: "#7c3aed", AMD: "#f97316"
};

// 5) ابعاد و جای ستون‌ها برای چیدمان شبیه عکس
const W=1100, PAD=16, HEADER_TOP=12, TITLE_H=36, SUB_H=20;
const TABLE_Y = HEADER_TOP + TITLE_H + SUB_H + 12;
const ROW_H = 44, ROW_GAP=2;
const COL = {
  flag: PAD+6,    // پرچم
  code: PAD+46,   // کُد ارز آبی
  curr: PAD+110,  // نام ارز
  sell: PAD+700,  // ستون Sell
  buy : PAD+900   // ستون Buy
};

// 6) فرمت عدد و جهت روند (بدون تغییر نسبت به قبل)
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
  ctx.fillStyle=COLORS.headBg; roundedRect(ctx,x,y,w,h,8); ctx.fill();
  ctx.fillStyle=COLORS.headText; ctx.font="700 14px system-ui, Arial";
  ctx.textAlign="left";
  ctx.fillText("Code", COL.code, y+22);
  ctx.fillText("Currency", COL.curr, y+22);
  ctx.textAlign="right";
  ctx.fillText("Sell", COL.sell, y+22);
  ctx.fillText("Buy",  COL.buy,  y+22);
}

function trendArrow(ctx, dir, x, y){ // ▲▼▶ رنگی
  if(dir>0) ctx.fillStyle=COLORS.up; else if(dir<0) ctx.fillStyle=COLORS.down; else ctx.fillStyle=COLORS.flat;
  ctx.beginPath();
  if(dir>0){ ctx.moveTo(x, y+10); ctx.lineTo(x+10,y+10); ctx.lineTo(x+5,y); }
  else if(dir<0){ ctx.moveTo(x, y); ctx.lineTo(x+10,y); ctx.lineTo(x+5,y+10); }
  else { ctx.moveTo(x, y); ctx.lineTo(x+10,y+5); ctx.lineTo(x, y+10); }
  ctx.closePath(); ctx.fill();
}

// مثلث آبی کوچک شبیه آیکونِ لیست قیمت (قبل از اعداد)
function caret(ctx, x, y){
  ctx.fillStyle = COLORS.caret;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x+8, y+5);
  ctx.lineTo(x, y+10);
  ctx.closePath();
  ctx.fill();
}

function row(ctx,i,{sym,label,sell,buy,dir}){
  const y = TABLE_Y + i*(ROW_H+ROW_GAP);
  const x = PAD, w = W-PAD*2, h = ROW_H;

  // پس‌زمینه ردیف
  ctx.fillStyle=COLORS.rowBg; roundedRect(ctx,x,y,w,h,10); ctx.fill();

  // نوار رنگی باریکِ سمت چپ (حس لاین رنگی عکس 2)
  const stripe = STRIPE[sym] || "#93c5fd";
  ctx.fillStyle = stripe;
  ctx.fillRect(x+1, y+2, 6, h-4);

  // خط تقسیم پایین هر ردیف (آبی خیلی روشن)
  ctx.strokeStyle = COLORS.rowDivider;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x+10, y+h); ctx.lineTo(x+w-10, y+h); ctx.stroke();

  // پرچم
  ctx.textAlign="left"; ctx.font="700 18px system-ui, Arial"; ctx.fillStyle=COLORS.text;
  const flag = FLAGS[sym] || "";
  if(flag){
    ctx.font="700 20px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Arial";
    ctx.fillText(flag, COL.flag, y+27);
  }

  // Code (آبی شبیه لینک)
  ctx.font="700 16px system-ui, Arial"; ctx.fillStyle=COLORS.link;
  ctx.fillText(sym, COL.code, y+27);

  // Currency
  ctx.font="600 16px system-ui, Arial"; ctx.fillStyle=COLORS.text;
  ctx.fillText(label, COL.curr, y+27);

  // Sell + caret آبی + فلش روند
  ctx.textAlign="right"; ctx.font="600 18px system-ui, Arial"; ctx.fillStyle=COLORS.text;
  caret(ctx, COL.sell-46, y+12);
  ctx.fillText(fmt(sell), COL.sell, y+27);
  trendArrow(ctx, dir, COL.sell-26, y+12);

  // Buy + caret آبی
  ctx.fillStyle=COLORS.text;
  caret(ctx, COL.buy-46, y+12);
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
