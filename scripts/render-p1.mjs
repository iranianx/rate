// ===== بخش ۱ =====
import fs from "fs";
import path from "path";
import { createCanvas, loadImage } from "canvas";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const STATE = path.join(ROOT, "state");

// ورودی/خروجی‌ها
const RATES_PATH     = path.join(DOCS, "rates.json");
const OUT            = path.join(DOCS, "p1.png");
const BASELINE_PATH  = path.join(ROOT, "baseline.json");
const PREV_SPOT_PATH = path.join(STATE, "prev_spot.json");

// پوشه‌ی پرچم‌های رنگی (PNG). نام فایل‌ها: USD.png, EUR.png, ...
const FLAGS_DIR = path.join(DOCS, "flags");

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(FLAGS_DIR, { recursive: true });

// --- ابزارهای فایل ---
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
// ایموجی‌ها فقط «fallback» هستند؛ اگر PNG بود همان را استفاده می‌کنیم
const FLAGS = { USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", TRY:"🇹🇷", JPY:"🇯🇵", CNY:"🇨🇳", GEL:"🇬🇪", AMD:"🇦🇲" };

const COLORS = {
  text: "#22303a",
  link: "#1976d2",
  headBg: "#cfe8ff",
  headText: "#2c3e50",
  rowBg: "#ffffff",
  rowDivider: "#d9e2ef",
  // منطق مثلث‌ها: +۱٪ قرمز▲ ، −۱٪ آبی▼ ، مابقی سبز▶
  up:   "#c62828", // قرمز
  down: "#1e88e5", // آبی
  flat: "#2e7d32", // سبز
  // caret فعلاً استفاده نمی‌شود
  caret: "#1e88e5"
};

const THEME = { enableLeftStripe: false };
const STRIPE = {
  USD: "#3b82f6", EUR: "#1e40af", GBP: "#ef4444", TRY: "#dc2626",
  JPY: "#f43f5e", CNY: "#b91c1c", GEL: "#7c3aed", AMD: "#f97316"
};

// ---------- ابعاد و جای ستون‌ها ----------
const W = 1100, PAD = 16;
// بدون فاصله‌ی اضافی بالا
const HEADER_TOP = 0, TITLE_H = 0, SUB_H = 0;
// هدر از پیکسل 0 شروع شود
const TABLE_Y = 32;

const ROW_H = 44, ROW_GAP = 2;

// ستون‌ها: Buy نزدیکِ Currency؛ Sell بعد از آن
const COL = {
  flag: PAD + 6,
  code: PAD + 46,
  curr: PAD + 150,
  buy : PAD + 400,  // نزدیک‌تر شد
  sell: PAD + 520   // کمی بعد از Buy
};

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

// ===== بخش 2: توابع پایه‌ی رسم =====

// مستطیل با شعاعِ مستقل برای هر گوشه
function roundedRectCorners(ctx, x, y, w, h, r){
  const tl = (r?.tl ?? r) || 0;
  const tr = (r?.tr ?? r) || 0;
  const br = (r?.br ?? r) || 0;
  const bl = (r?.bl ?? r) || 0;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

// پهنای لازمِ جدول بر اساس جای ستون آخر + حاشیه کوچک
function tableWidth(){
  const NUM_W = Number(globalThis.NUM_W_EST ?? 96);   // برآورد پهنای عدد ۶رقمی با اندازه‌گیری پویا
  const TRI_W = 10;   // پهنای مثلث
  const GAP   = 6;    // فاصله‌ی مثلث تا عدد (باید با drawValueWithTriangle یکی باشد)
  const RIGHT_PAD = 20;
  const rightMostCol = Math.max(COL.buy, COL.sell);
  return (rightMostCol + TRI_W + GAP + NUM_W) - PAD + RIGHT_PAD;
}

// نوار عنوان جدول (آبی آسمانی، گوشه‌های نرم، بدون تیتر)
function header(ctx, updatedAt){
  const y = TABLE_Y - 32, x = PAD, w = tableWidth(), h = 32;

  // خود باکس
  ctx.fillStyle = COLORS.headBg; // مثلاً #cfe8ff
  roundedRectCorners(ctx, x, y, w, h, { tl: 10, tr: 10, br: 8, bl: 8 });
  ctx.fill();

  // خطِ جداکننده‌ی خیلی کم‌رنگ در پایین باکس
  ctx.fillStyle = "#b7cff5"; // یک تون تیره‌تر از headBg
  ctx.fillRect(x + 1, y + h - 1, w - 2, 1);

  // برچسب ستون‌ها
  ctx.fillStyle = COLORS.headText;
  ctx.font = "700 14px system-ui, Arial";
  ctx.textAlign = "left";
  ctx.fillText("Code",     COL.code, y + 22);
  ctx.fillText("Currency", COL.curr, y + 22);
  ctx.fillText("Buy",      COL.buy,  y + 22);
  ctx.fillText("Sell",     COL.sell, y + 22);
}

// مثلث روند: +۱٪ قرمزِ رو به بالا، −۱٪ آبیِ رو به پایین، غیر از این سبزِ رو به عدد
function trendArrow(ctx, dir, x, y){
  if (dir > 0) ctx.fillStyle = COLORS.up;        // قرمز
  else if (dir < 0) ctx.fillStyle = COLORS.down; // آبی
  else ctx.fillStyle = COLORS.flat;              // سبز

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

// عدد را چپ‌چین می‌نویسد و مثلث را چپِ عدد می‌گذارد؛ رنگ عدد تیره
function drawValueWithTriangle(ctx, value, colX, baseY, dir){
  const txt = fmt(value);

  // مثلث
  const triW = 10, gap = 6;           // حتماً با tableWidth هماهنگ باشد
  const triX = colX - (triW + gap);
  ctx.save();
  trendArrow(ctx, dir, triX, baseY + 12);
  ctx.restore();

  // عدد
  ctx.textAlign = "left";
  ctx.font = "600 18px system-ui, Arial";
  ctx.fillStyle = COLORS.text;        // اگر خواستی: "#000"
  ctx.fillText(txt, colX, baseY + 27);
}
// ===== پایان بخش 2 =====
// ===== بخش 3: ردیف جدول =====
function row(ctx, i, { sym, label, sell, buy, dir, flagImg }){
  const y = TABLE_Y + i*(ROW_H+ROW_GAP);
  const x = PAD, w = W - PAD*2, h = ROW_H;

  // پس‌زمینه ردیف و خط جداکننده
  ctx.fillStyle = COLORS.rowBg;
  roundedRectCorners(ctx, x, y, w, h, { tl: 10, tr: 10, br: 10, bl: 10 });
  ctx.fill();
  ctx.strokeStyle = COLORS.rowDivider; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x+10, y+h); ctx.lineTo(x+w-10, y+h); ctx.stroke();

  // (اختیاری) لاین رنگی کناری
  if (THEME.enableLeftStripe){
    const stripe = STRIPE[sym] || "#93c5fd";
    ctx.fillStyle = stripe; ctx.fillRect(x+1, y+2, 6, h-4);
  }

  // پرچم: اگر PNG داده شده بود، همان؛ وگرنه ایموجی (fallback)
  if (flagImg){
    const fw = 24, fh = 16;
    const fy = y + Math.round((h - fh)/2);
    ctx.drawImage(flagImg, COL.flag, fy, fw, fh);
  } else {
    ctx.textAlign = "left"; ctx.fillStyle = COLORS.text;
    ctx.font = "700 20px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Arial";
    const flag = FLAGS[sym] || "";
    if (flag) ctx.fillText(flag, COL.flag, y+27);
  }

  // کُد ارز (آبی) و نام ارز
  ctx.textAlign = "left";
  ctx.font = "700 16px system-ui, Arial"; ctx.fillStyle = COLORS.link;
  ctx.fillText(sym, COL.code, y+27);

  ctx.font = "600 16px system-ui, Arial"; ctx.fillStyle = COLORS.text;
  ctx.fillText(label, COL.curr, y+27);

  // Sell و Buy: یک مثلث کنار عدد (بدون هم‌پوشانی)
  drawValueWithTriangle(ctx, buy,  COL.buy,  y, dir);
  drawValueWithTriangle(ctx, sell, COL.sell, y, dir);
}
// ===== پایان بخش 3 =====

// ===== بخش 4: ساخت ردیف‌ها، بوم، رندر، خروجی =====
async function main(){
  // ورودی‌ها
  const rates = readJSON(RATES_PATH, null);
  if (!rates || typeof rates !== "object" || !rates.spot) {
    throw new Error("docs/rates.json not found or malformed");
  }
  const base  = readJSON(BASELINE_PATH, {});
  const prev  = readJSON(PREV_SPOT_PATH, {});

  // اسپرد معتبر (۰ تا ۱۰۰)، پیش‌فرض ۰.۶٪
  let spreadPct = Number(base.spread_pct ?? 0.6);
  if (!isFinite(spreadPct)) spreadPct = 0.6;
  spreadPct = Math.max(0, Math.min(100, spreadPct));

  // ردیف‌ها (فقط ارزی که در rates.spot موجود است)
  const rows = [];
  for (const code of ORDER){
    const sell = rates.spot?.[code];
    if (sell == null) continue;

    const sym = code.replace("_TMN", "");
    const buy = Math.max(0, Math.round(Number(sell) * (1 - spreadPct/100)));
    const dir = percentDir(sell, prev[code], 1); // ±1%

    rows.push({ sym, label: LABELS[sym] || sym, sell: Number(sell), buy, dir, code });
  }
  if (rows.length === 0) throw new Error("No rows to render (check ORDER or rates.spot)");

  // پرچم‌ها از docs/flags/ (اگر نبود: fallback ایموجی)
  const flagEntries = await Promise.all(rows.map(async (r) => {
    const fp = path.join(FLAGS_DIR, `${r.sym}.png`);
    if (fs.existsSync(fp)) {
      try { return [r.sym, await loadImage(fp)]; } catch { /* ignore */ }
    }
    return [r.sym, null];
  }));
  const flagImgs = Object.fromEntries(flagEntries);

  // --- اندازه‌گیری پویا برای حذف فضای خالی سمت راست (بعدِ Buy) ---
  const measureCtx = createCanvas(10, 10).getContext("2d");
  measureCtx.font = "600 18px system-ui, Arial";
  let maxNumW = 0;
  for (const r of rows){
    maxNumW = Math.max(
      maxNumW,
      measureCtx.measureText(fmt(r.buy)).width,
      measureCtx.measureText(fmt(r.sell)).width
    );
  }
  // برای tableWidth() در بخش 2
  globalThis.NUM_W_EST = Math.ceil(maxNumW);

  // بوم با عرض دقیق جدول
  const BOTTOM_PAD = 6;
  const H  = TABLE_Y + rows.length*(ROW_H + ROW_GAP) + BOTTOM_PAD;
  const CW = PAD + tableWidth() + PAD; // عرض کل تصویر = چپ PAD + عرض جدول + راست PAD
  const canvas = createCanvas(CW, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CW, H);

  // هدر جدول
  header(ctx, rates.updated_at);

  // بدنه جدول
  rows.forEach((r,i) => row(ctx, i, { ...r, flagImg: flagImgs[r.sym] || null }));

  // خروجی + ذخیره prev برای نوبت بعد
  fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
  const nextPrev = { ...prev };
  rows.forEach(r => { nextPrev[r.code] = r.sell; });
  writeJSON(PREV_SPOT_PATH, nextPrev);

  console.log("Wrote", OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
