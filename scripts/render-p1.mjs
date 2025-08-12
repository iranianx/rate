// ===== بخش ۱: ایمپورت، مسیرها، ابزار فایل، پیکربندی ظاهر، ابعاد =====
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

// --- فهرست و برچسب ارزها ---
const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];
const LABELS = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", TRY: "Turkish Lira",
  JPY: "Japanese Yen", CNY: "Chinese Yuan", GEL: "Georgian Lari", AMD: "Armenian Dram"
};

// --- پرچم‌ها (ایموجی رنگی) ---
const FLAGS = {
  USD:"🇺🇸", EUR:"🇪🇺", GBP:"🇬🇧", TRY:"🇹🇷",
  JPY:"🇯🇵", CNY:"🇨🇳", GEL:"🇬🇪", AMD:"🇦🇲"
};

// --- پالت رنگ مطابق تصویری که فرستادی ---
const COLORS = {
  text: "#22303a",     // متن و اعداد
  link: "#1976d2",     // کُد ارز (USD…)
  headBg: "#e9eef5",   // پس‌زمینه سرستون
  headText: "#2c3e50", // متن سرستون
  rowBg: "#ffffff",    // زمینه ردیف‌ها
  rowDivider: "#d9e2ef", // خط جداکننده
  up: "#2e7d32",       // فلش افزایش
  down: "#c62828",     // فلش کاهش
  flat: "#1e88e5",     // فلش بدون تغییر
  caret: "#1e88e5"     // مثلث کوچک قبل از اعداد
};

// --- کنترل «لاین» کناری ردیف‌ها (در تصویر خاموش است) ---
const THEME = { enableLeftStripe: false };
const STRIPE = {
  USD: "#3b82f6", EUR: "#1e40af", GBP: "#ef4444", TRY: "#dc2626",
  JPY: "#f43f5e", CNY: "#b91c1c", GEL: "#7c3aed", AMD: "#f97316"
};

// --- ابعاد و جای ستون‌ها ---
const W=1100, PAD=16, HEADER_TOP=12, TITLE_H=36, SUB_H=20;
const TABLE_Y = HEADER_TOP + TITLE_H + SUB_H + 12;
const ROW_H = 44, ROW_GAP=2;
const COL = {
  flag: PAD+6,    // پرچم
  code: PAD+46,   // کُد ارز
  curr: PAD+110,  // نام ارز
  sell: PAD+700,  // ستون Sell
  buy : PAD+900   // ستون Buy
};

// --- کمکی‌های عدد و تشخیص جهت ---
function fmt(n){ const v=Number(n); return isFinite(v)?v.toLocaleString("en-US"):"-"; }
function signDir(cur, prev){
  if(!isFinite(prev)) return 0;
  const d=cur-prev;
  return Math.abs(d)<1 ? 0 : (d>0?1:-1);
}
// ===== پایان بخش ۱ =====

// ===== بخش ۲: ساخت ردیف‌ها، بوم، رندر، خروجی =====
async function main(){
  // ورودی‌ها
  const rates = readJSON(RATES_PATH, null);
  if (!rates) throw new Error("docs/rates.json not found");
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
    const dir = signDir(sell, prev[code]); // جهت برای فلش‌ها (هم Sell هم Buy)
    rows.push({ sym, label: LABELS[sym] || sym, sell, buy, dir, code });
  }

  // بوم
  const H = TABLE_Y + rows.length*(ROW_H+ROW_GAP) + PAD + 12;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  // هدر جدول (مطابق پالت بخش ۱)
  header(ctx, rates.updated_at);

  // بدنه جدول
  rows.forEach((r,i)=> row(ctx, i, r));

  // فوتر کم‌رنگ
  ctx.textAlign="left";
  ctx.fillStyle="#9aa0a6";
  ctx.font="400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • © " + new Date().getFullYear(), PAD, H-8);

  // خروجی + ذخیره‌ی prev برای جهت حرکت بعدی
  fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
  const nextPrev = { ...prev };
  rows.forEach(r => { nextPrev[r.code] = r.sell; });
  writeJSON(PREV_SPOT_PATH, nextPrev);

  console.log("Wrote", OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
