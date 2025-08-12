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

function readJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function fmt(n){
  const v = Number(n);
  if (!isFinite(v)) return "-";
  return v.toLocaleString("en-US");
}

// نقشهٔ نام‌ها
const LABELS = {
  USD: "US Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  TRY: "Turkish Lira",
  JPY: "Japanese Yen",
  CNY: "Chinese Yuan",
  GEL: "Georgian Lari",
  AMD: "Armenian Dram"
};

// ترتیب نمایش صفحه ۱
const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];

// پارامترهای ظاهر
const W = 1000;
const PAD = 24;
const HEADER_H = 82;
const ROW_H = 60;
const GAP = 10;

// جدول
const COLS = {
  code:   { x: PAD + 10, width: 90, align: "left" },
  curr:   { x: PAD + 120, width: 290, align: "left" },
  sell:   { x: PAD + 540, width: 180, align: "right" },
  buy:    { x: PAD + 760, width: 180, align: "right" }
};

function drawHeader(ctx, updatedAt) {
  ctx.fillStyle = "#111";
  ctx.font = "700 30px system-ui, Arial";
  ctx.fillText("IranianX — Fiat", PAD, PAD + 34);

  ctx.fillStyle = "#d00";
  ctx.font = "700 16px system-ui, Arial";
  const d = updatedAt ? new Date(updatedAt) : new Date();
  const line = "Updated: " + d.toLocaleString();
  ctx.fillText(line, PAD, PAD + 60);
}

function roundedRect(ctx, x, y, w, h, r=10) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r);
  ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h);
  ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

function drawTableHeader(ctx, y){
  const x = PAD, w = W - PAD*2, h = 42;
  ctx.fillStyle = "#e8f1fb";
  roundedRect(ctx, x, y, w, h, 8);
  ctx.fill();

  ctx.fillStyle = "#34495e";
  ctx.font = "700 15px system-ui, Arial";
  ctx.textAlign = "left";
  ctx.fillText("Code", COLS.code.x, y + 27);
  ctx.fillText("Currency", COLS.curr.x, y + 27);

  ctx.textAlign = "right";
  ctx.fillText("Sell", COLS.sell.x + COLS.sell.width, y + 27);
  ctx.fillText("Buy",  COLS.buy.x  + COLS.buy.width,  y + 27);
}

function arrow(ctx, dir, x, y) {
  // dir: 1 up (green), -1 down (red), 0 flat (grey)
  if (dir > 0) ctx.fillStyle = "#2e7d32";
  else if (dir < 0) ctx.fillStyle = "#c62828";
  else ctx.fillStyle = "#607d8b";

  // مثلث کوچک
  ctx.beginPath();
  if (dir >= 0) {
    ctx.moveTo(x, y+10); ctx.lineTo(x+10, y+10); ctx.lineTo(x+5, y); // ▲
  } else {
    ctx.moveTo(x, y); ctx.lineTo(x+10, y); ctx.lineTo(x+5, y+10);   // ▼
  }
  ctx.closePath(); ctx.fill();
}

function drawRow(ctx, i, code, sell, buy, dir){
  const y = HEADER_H + 42 + PAD + i*(ROW_H+GAP);
  const x = PAD, w = W - PAD*2, h = ROW_H;

  ctx.fillStyle = "#f6f8fb";
  roundedRect(ctx, x, y, w, h, 10);
  ctx.fill();

  const sym = code.replace("_TMN","");
  const label = LABELS[sym] || sym;

  // Code
  ctx.fillStyle = "#1f2a39";
  ctx.textAlign = "left";
  ctx.font = "700 18px system-ui, Arial";
  ctx.fillText(sym, COLS.code.x, y + 24 + 6);

  // Currency
  ctx.font = "600 18px system-ui, Arial";
  ctx.fillText(label, COLS.curr.x, y + 24 + 6);

  // Sell
  ctx.textAlign = "right";
  ctx.font = "600 20px system-ui, Arial";
  ctx.fillText(fmt(sell), COLS.sell.x + COLS.sell.width, y + 24 + 6);

  // Buy
  ctx.fillText(fmt(buy),  COLS.buy.x  + COLS.buy.width,  y + 24 + 6);

  // Arrow (کنار ستون Sell)
  arrow(ctx, dir, COLS.sell.x + COLS.sell.width - 26, y + 11);
}

function signDir(cur, prev){
  if (!isFinite(prev)) return 0;
  const d = cur - prev;
  if (Math.abs(d) < 1) return 0;
  return d > 0 ? 1 : -1;
}

async function main(){
  const rates = readJSON(RATES_PATH, null);
  if (!rates) throw new Error("docs/rates.json not found");
  const base = readJSON(BASELINE_PATH, {});
  const prevSpot = readJSON(PREV_SPOT_PATH, {});

  const spreadPct = Number(base.spread_pct ?? 0.6); // پیش‌فرض 0.6٪

  // ردیف‌ها
  const rows = [];
  for (const k of ORDER){
    const sell = rates.spot?.[k];
    if (sell == null) continue;
    const buy = Math.round(sell * (1 - spreadPct/100));
    const dir = signDir(sell, prevSpot[k]);
    rows.push({ code:k, sell, buy, dir });
  }

  // ارتفاع تصویر بر اساس تعداد ردیف‌ها
  const H = HEADER_H + 42 + PAD + rows.length*(ROW_H+GAP) + PAD + 8;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // هدر + جدول
  drawHeader(ctx, rates.updated_at);
  drawTableHeader(ctx, HEADER_H);

  // ردیف‌ها
  rows.forEach((r, i) => drawRow(ctx, i, r.code, r.sell, r.buy, r.dir));

  // فوتر
  ctx.fillStyle = "#9aa0a6";
  ctx.textAlign = "left";
  ctx.font = "400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • " + new Date().getFullYear(), PAD, H - 10);

  // خروجی
  const buf = canvas.toBuffer("image/png");
  fs.writeFileSync(OUT, buf);
  console.log("Wrote", OUT);

  // به‌روزکردن prev_spot برای دفعه بعد (برای جهت فلش‌ها)
  const nextPrev = readJSON(PREV_SPOT_PATH, {});
  for (const r of rows) nextPrev[r.code] = r.sell;
  writeJSON(PREV_SPOT_PATH, nextPrev);
}

main().catch(e=>{ console.error(e); process.exit(1); });
