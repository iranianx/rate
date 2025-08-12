import fs from "fs";
import path from "path";
import { createCanvas, loadImage } from "canvas";

const DOCS = path.join(process.cwd(), "docs");
const INPUT = path.join(DOCS, "rates.json");
const OUT = path.join(DOCS, "p1.png");

// ارزهای صفحه ۱ (به همین ترتیب)
const ORDER = ["USD_TMN","EUR_TMN","GBP_TMN","TRY_TMN","JPY_TMN","CNY_TMN","GEL_TMN","AMD_TMN"];

// اندازه و استایل
const W = 900, H = 560, PAD = 24;
const ROW_H = 56, GAP = 6;
const HEADER_H = 74;

function fmt(n){
  const v = Number(n);
  if (!isFinite(v)) return "-";
  return v.toLocaleString("en-US");
}

function drawHeader(ctx, updatedAt){
  ctx.fillStyle = "#111";
  ctx.font = "700 24px system-ui, Arial";
  ctx.fillText("IranianX • Fiat (p1)", PAD, PAD + 28);

  ctx.fillStyle = "#666";
  ctx.font = "400 14px system-ui, Arial";
  const t = updatedAt ? new Date(updatedAt) : new Date();
  ctx.fillText("Updated: " + t.toLocaleString(), PAD, PAD + 52);
}

function drawRow(ctx, i, code, val){
  const y = HEADER_H + PAD + i*(ROW_H+GAP);
  // کادر
  ctx.fillStyle = "#f8f9fb";
  const r = 10;
  const x = PAD, w = W - PAD*2, h = ROW_H;
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
  ctx.fill();

  // نام جفت
  ctx.fillStyle = "#1f2a39";
  ctx.font = "700 18px system-ui, Arial";
  ctx.fillText(code.replace("_TMN"," / TMN"), x+16, y + 20 + 8);

  // مقدار
  ctx.textAlign = "right";
  ctx.font = "600 22px system-ui, Arial";
  ctx.fillText(fmt(val), x + w - 16, y + 22 + 8);
  ctx.textAlign = "left";
}

async function main(){
  if (!fs.existsSync(INPUT)) {
    throw new Error("docs/rates.json not found");
  }
  const data = JSON.parse(fs.readFileSync(INPUT,"utf-8"));
  const spot = data.spot || {};
  const updatedAt = data.updated_at;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // پس‌زمینه سفید
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // عنوان
  drawHeader(ctx, updatedAt);

  // ردیف‌ها
  let i = 0;
  for (const code of ORDER){
    if (spot[code] == null) continue;
    drawRow(ctx, i, code, spot[code]);
    i++;
  }

  // امضا ریز پایین
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "400 12px system-ui, Arial";
  ctx.fillText("IranianX.com • © "+new Date().getFullYear(), PAD, H - 12);

  const buf = canvas.toBuffer("image/png");
  fs.writeFileSync(OUT, buf);
  console.log("Wrote", OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
