// ===== بخش ۱ =====
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

// --- ابزارهای فایل (لازم برای main) ---
function readJSON(p, fb){
  if (!fs.existsSync(p)) return fb;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fb; }
}
function writeJSON(p, o){
  fs.writeFileSync(p, JSON.stringify(o, null, 2));
}

// ---------- پیکربندی نمایشی ----------
const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];
const LABELS = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", TRY: "Turkish Lira",
  JPY: "Japanese Yen", CNY: "Chinese Yuan", GEL: "Georgian Lari", AMD: "Armenian Dram"
};
const FLAGS = { USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", TRY:"🇹🇷", JPY:"🇯🇵", CNY:"🇨🇳", GEL:"🇬🇪", AMD:"🇦🇲" };

const COLORS = {
  text: "#22303a",
  link: "#1976d2",
  headBg: "#e9eef5",
  headText: "#2c3e50",
  rowBg: "#ffffff",
  rowDivider: "#d9e2ef",
  // منطق مثلث‌ها: +۱٪ قرمز▲ ، −۱٪ آبی▼ ، مابقی سبز▶
  up:   "#c62828", // قرمز
  down: "#1e88e5", // آبی
  flat: "#2e7d32", // سبز
  // caret دیگر استفاده نمی‌شود؛ می‌تونی حذفش کنی
  caret: "#1e88e5"
};

const THEME = { enableLeftStripe: false };
const STRIPE = {
  USD: "#3b82f6", EUR: "#1e40af", GBP: "#ef4444", TRY: "#dc2626",
  JPY: "#f43f5e", CNY: "#b91c1c", GEL: "#7c3aed", AMD: "#f97316"
};

// ---------- ابعاد و جای ستون‌ها ----------
const W=1100, PAD=16, HEADER_TOP=12, TITLE_H=36, SUB_H=20;
const TABLE_Y = HEADER_TOP + TITLE_H + SUB_H + 12;
const ROW_H = 44, ROW_GAP=2;
const COL = { flag: PAD+6, code: PAD+46, curr: PAD+110, sell: PAD+700, buy: PAD+900 };

// ---------- کمکی‌های اعداد ----------
function fmt(n){ const v=Number(n); return isFinite(v)?v.toLocaleString("en-US"):"-"; }

// جهت با آستانه درصدی (برای مثلث‌ها)
function percentDir(cur, prev, thresholdPct = 1){
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p) || p === 0) return 0;
  const pct = ((c - p) / p) * 100;
  if (pct >=  thresholdPct) return 1;   // +1% یا بیشتر ⇒ قرمز ▲
  if (pct <= -thresholdPct) return -1;  // −1% یا کمتر ⇒ آبی ▼
  return 0;                              // بین این دو ⇒ سبز ▶
}
// ===== پایان بخش ۱ =====

// ===== بخش 2: توابع رسم =====

// مستطیل با گوشه‌گرد برای ردیف‌ها و هدر
function roundedRect(ctx,x,y,w,h,r=8){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// نوار عنوان جدول + تیتر/زمان
function header(ctx, updatedAt){
  // تیتر و زمان (می‌تونی این دو خط را حذف کنی اگر نخواستی)
  ctx.fillStyle="#000"; ctx.font="700 26px system-ui, Arial";
  ctx.fillText("IranianX — Fiat", PAD, HEADER_TOP + 26);

  ctx.fillStyle="#c00"; ctx.font="700 14px system-ui, Arial";
  const ts = updatedAt ? new Date(updatedAt).toLocaleString() : new Date().toLocaleString();
  ctx.fillText("Updated: " + ts, PAD, HEADER_TOP + 26 + 18);

  // نوار عنوان ستون‌ها (Code / Currency / Sell / Buy)
  const y = TABLE_Y - 32, x = PAD, w = W - PAD*2, h = 32;
  ctx.fillStyle = COLORS.headBg; roundedRect(ctx, x, y, w, h, 8); ctx.fill();
  ctx.fillStyle = COLORS.headText; ctx.font = "700 14px system-ui, Arial";
  ctx.textAlign = "left";
  ctx.fillText("Code",     COL.code, y+22);
  ctx.fillText("Currency", COL.curr, y+22);
  ctx.textAlign = "right";
  ctx.fillText("Sell",     COL.sell, y+22);
  ctx.fillText("Buy",      COL.buy,  y+22);
}

// مثلث روند: +۱٪ قرمزِ رو به بالا، −۱٪ آبیِ رو به پایین، غیر از این سبزِ رو به عدد
function trendArrow(ctx, dir, x, y){
  if (dir > 0) ctx.fillStyle = COLORS.up;      // قرمز
  else if (dir < 0) ctx.fillStyle = COLORS.down; // آبی
  else ctx.fillStyle = COLORS.flat;            // سبز

  ctx.beginPath();
  if (dir > 0) {            // ▲
    ctx.moveTo(x, y+10); ctx.lineTo(x+10, y+10); ctx.lineTo(x+5, y);
  } else if (dir < 0) {     // ▼
    ctx.moveTo(x, y); ctx.lineTo(x+10, y); ctx.lineTo(x+5, y+10);
  } else {                  // ▶
    ctx.moveTo(x, y); ctx.lineTo(x+10, y+5); ctx.lineTo(x, y+10);
  }
  ctx.closePath(); ctx.fill();
}

// یک ردیف جدول با پرچم رنگی، کُد آبی، نام ارز و اعداد + یک مثلث
function row(ctx, i, { sym, label, sell, buy, dir }){
  const y = TABLE_Y + i*(ROW_H+ROW_GAP);
  const x = PAD, w = W - PAD*2, h = ROW_H;

  // پس‌زمینه ردیف و خط جداکننده
  ctx.fillStyle = COLORS.rowBg; roundedRect(ctx, x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = COLORS.rowDivider; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x+10, y+h); ctx.lineTo(x+w-10, y+h); ctx.stroke();

  // (اختیاری) لاین رنگی کناری
  if (THEME.enableLeftStripe){
    const stripe = STRIPE[sym] || "#93c5fd";
    ctx.fillStyle = stripe; ctx.fillRect(x+1, y+2, 6, h-4);
  }

  // پرچم
  ctx.textAlign = "left"; ctx.fillStyle = COLORS.text;
  ctx.font = "700 20px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Arial";
  const flag = FLAGS[sym] || "";
  if (flag) ctx.fillText(flag, COL.flag, y+27);

  // کُد ارز (آبی) و نام ارز
  ctx.font = "700 16px system-ui, Arial"; ctx.fillStyle = COLORS.link;
  ctx.fillText(sym, COL.code, y+27);

  ctx.font = "600 16px system-ui, Arial"; ctx.fillStyle = COLORS.text;
  ctx.fillText(label, COL.curr, y+27);

  // Sell: مثلث + عدد (فقط یک مثلث)
  ctx.textAlign = "right"; ctx.font = "600 18px system-ui, Arial"; ctx.fillStyle = COLORS.text;
  trendArrow(ctx, dir, COL.sell-26, y+12);
  ctx.fillText(fmt(sell), COL.sell, y+27);

  // Buy: همان جهت + عدد (بدون caret)
  trendArrow(ctx, dir, COL.buy-26, y+12);
  ctx.fillText(fmt(buy), COL.buy, y+27);
}

// ===== بخش 3: ساخت ردیف‌ها، بوم، رندر، خروجی =====
async function main(){
  // ورودی‌ها
  const rates = readJSON(RATES_PATH, null);
  if (!rates || !rates.spot) throw new Error("docs/rates.json not found or malformed");
  const base  = readJSON(BASELINE_PATH, {});
  const prev  = readJSON(PREV_SPOT_PATH, {});
  const spreadPct = Number(base.spread_pct ?? 0.6);

  // ردیف‌ها (فقط ارزی که در rates.spot موجود است)
  const rows = [];
  for (const code of ORDER){
    const sell = rates.spot?.[code];
    if (sell == null) continue;

    const buy = Math.round(sell * (1 - spreadPct/100));
    const sym = code.replace("_TMN","");

    // منطق جهت مثلث بر اساس تغییر درصدی نسبت به مقدار قبلی و آستانه ۱٪
    const dir = percentDir(sell, prev[code], 1);

    rows.push({ sym, label: LABELS[sym] || sym, sell, buy, dir, code });
  }

  // اگر هیچ ردیفی نبود، ورودی را بررسی کن
  if (rows.length === 0) throw new Error("No rows to render (check ORDER or rates.spot)");

  // بوم
  const H = TABLE_Y + rows.length*(ROW_H+ROW_GAP) + PAD + 12;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  // هدر جدول
  header(ctx, rates.updated_at);

  // بدنه جدول
  rows.forEach((r,i) => row(ctx, i, r));

  // فوتر کم‌رنگ
  ctx.textAlign = "left";
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • © " + new Date().getFullYear(), PAD, H-8);

  // خروجی + ذخیره‌ی prev برای جهت حرکت بعدی
  fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
  const nextPrev = { ...prev };
  rows.forEach(r => { nextPrev[r.code] = r.sell; });
  writeJSON(PREV_SPOT_PATH, nextPrev);

  console.log("Wrote", OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
