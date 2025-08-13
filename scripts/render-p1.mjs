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
const ORDER = ["USD_TMN","USDT_TMN","EUR_TMN","GBP_TMN","CAD_TMN","AUD_TMN","RUB_TMN","AED_TMN","KWD_TMN","IQD_TMN","SAR_TMN","TRY_TMN","GEL_TMN","AZN_TMN","AMD_TMN","JPY_TMN","CNY_TMN","AFN_TMN"];

const LABELS = {
  USD:  "US Dollar", USDT: "Tether (USDT)", EUR:  "Euro", GBP:  "British Pound", CAD:  "Canadian Dollar", AUD:  "Australian Dollar", RUB:  "Russian Ruble", AED:  "UAE Dirham", KWD:  "Kuwaiti Dinar",
  IQD:  "Iraqi Dinar", SAR:  "Saudi Riyal", TRY:  "Turkish Lira", GEL:  "Georgian Lari", AZN:  "Azerbaijani Manat", AMD:  "Armenian Dram", JPY:  "Japanese Yen", CNY:  "Chinese Yuan", AFN:  "Afghan Afghani"
};

const COLORS = {
  text: "#22303a",
  link: "#1976d2",
  headBg: "#d9e5f3",   // بین #cfe8ff و #e3e9f1
  headText: "#2c3e50",
  rowBg: "#ffffff",
  rowAltBg: "#f2f2f2",
  rowDivider: "#c8cdd4",
  // مثلث‌های فسفری/نئونی
  up:   "#ff3366",     // قرمز نئونی
  down: "#33b5ff",     // آبی نئونی
  flat: "#00e676"      // سبز نئونی
};

// ---------- ابعاد و جای ستون‌ها ----------
const W = 1100, PAD = 16;         // W فعلاً برای هماهنگی‌های بعدی نگه داشته شده
const TABLE_Y = 32;               // هدر از پیکسل 0 شروع شود
const ROW_H = 44, ROW_GAP = 2;

// شیفت افقی (حدود دو کاراکتر) برای جا گذاشتن محل برش
const SHIFT = 20;

const COL = {
  flag: PAD + 6   + SHIFT,
  code: PAD + 40  + SHIFT,
  curr: PAD + 100 + SHIFT,
  buy : PAD + 300 + SHIFT,
  sell: PAD + 400 + SHIFT
};

// ---------- کمکی‌های اعداد ----------
function fmt(n){ const v = Number(n); return isFinite(v) ? v.toLocaleString("en-US") : "-"; }

// جهت با آستانه درصدی (برای مثلث‌ها)
function percentDir(cur, prev, thresholdPct = 1){
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p) || p === 0) return 0;
  const pct = ((c - p) / p) * 100;
  if (pct >=  thresholdPct) return 1;   // +1% یا بیشتر ⇒ قرمز ▲
  if (pct <= -thresholdPct) return -1;  // −1% یا کمتر ⇒ آبی ▼
  return 0;                             // بین این دو ⇒ سبز ▶
}
// ===== پایان بخش ۱ =====
// ===== بخش 2: توابع پایه‌ی رسم =====

// مستطیل با شعاعِ مستقل برای هر گوشه (الان استفاده نمی‌کنیم؛ برای آینده نگه داشته می‌شود)
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
  const NUM_W = Number(globalThis.NUM_W_EST ?? 96);   // برآورد پهنای عدد با اندازه‌گیری پویا
  const TRI_W = 10;                                   // پهنای مثلث
  const GAP   = 6;                                    // فاصله‌ی مثلث تا عدد
  const RIGHT_PAD = 20;
  const rightMostCol = Math.max(COL.buy, COL.sell);
  return (rightMostCol + TRI_W + GAP + NUM_W) - PAD + RIGHT_PAD;
}

// هدر: بدون گوشهٔ گرد + خط زیرین سرتاسری
function header(ctx, updatedAt){
  const y = TABLE_Y - 32, x = PAD, w = tableWidth(), h = 32;

  // باکس ساده بدون گردی
  ctx.fillStyle = COLORS.headBg;
  ctx.fillRect(x, y, w, h);

  // خط زیر هدر: سرتاسری و کمی تیره‌تر
  ctx.fillStyle = "#b9c1cc";
  ctx.fillRect(x, y + h - 1, w, 1);

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

// عدد + مثلث چپِ عدد
function drawValueWithTriangle(ctx, value, colX, baseY, dir){
  const txt = fmt(value);
  const triW = 10, gap = 6;
  const triX = colX - (triW + gap);

  trendArrow(ctx, dir, triX, baseY + 12);

  ctx.textAlign = "left";
  ctx.font = "600 18px system-ui, Arial";
  ctx.fillStyle = COLORS.text;
  ctx.fillText(txt, colX, baseY + 27);
}
// ===== پایان بخش 2 =====
// ===== بخش 3: ردیف جدول =====
function row(ctx, i, { sym, label, sell, buy, dir, flagImg }){
  const y = TABLE_Y + i*(ROW_H + ROW_GAP);
  const x = PAD, w = tableWidth(), h = ROW_H;

  // پس‌زمینه ردیف: بدون گوشه گرد + زبرا
  ctx.fillStyle = (i % 2 === 0) ? COLORS.rowBg : COLORS.rowAltBg;
  ctx.fillRect(x, y, w, h);

  // خط جداکنندهٔ پایین ردیف (سرتاسری)
  ctx.strokeStyle = COLORS.rowDivider; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();

  // پرچم: فقط اگر PNG داریم (fallback ایموجی حذف شده)
  // پرچم: 28x24 با حفظ نسبت تصویر (برای لوگوهای گرد مثل USDT)
  if (flagImg){
    const boxW = 28, boxH = 24;
    const boxY = y + Math.round((ROW_H - boxH)/2);

    const iw = flagImg.width  || boxW;
    const ih = flagImg.height || boxH;
    const scale = Math.min(boxW/iw, boxH/ih);
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = COL.flag + Math.round((boxW - dw)/2);
    const dy = boxY + Math.round((boxH - dh)/2);

  // (اختیاری) پس‌زمینه سفید پشت آیکن:
  // ctx.fillStyle = "#fff"; ctx.fillRect(COL.flag, boxY, boxW, boxH);

  ctx.drawImage(flagImg, dx, dy, dw, dh);
}


  // کُد ارز (آبی) و نام ارز
  ctx.textAlign = "left";
  ctx.font = "700 16px system-ui, Arial"; ctx.fillStyle = COLORS.link;
  ctx.fillText(sym, COL.code, y + 27);

  ctx.font = "600 16px system-ui, Arial"; ctx.fillStyle = COLORS.text;
  ctx.fillText(label, COL.curr, y + 27);

  // Buy و Sell با مثلث
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

  // پرچم‌ها از docs/flags/
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
