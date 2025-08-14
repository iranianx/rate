// scripts/sources.mjs
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PROVIDERS_PATH = path.join(DATA_DIR, "providers.json");
const OUT_PATH = path.join(DATA_DIR, "sources.json");

const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8"));
const headers = { "user-agent": "IranianX/1.0 (+https://github.com/iranianx/rate)" };

// --- ابزارهای کمکی
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
function toLatinDigits(s) {
  if (!s) return "";
  return String(s)
    .replace(/[۰-۹]/g, d => String(persianDigits.indexOf(d)))
    .replace(/[\u066B\u066C]/g, ",") // Arabic decimal/sep
    .replace(/\u200c/g, "");         // ZWNJ
}
function stripHtml(s) {
  return toLatinDigits(
    s.replace(/<br\s*\/?>/gi, "\n")
     .replace(/<\/?[^>]+>/g, " ")
     .replace(/&nbsp;/g, " ")
     .replace(/&amp;/g, "&")
     .replace(/\s+/g, " ")
  ).trim();
}
function firstPriceFrom(text) {
  const t = toLatinDigits(text).replace(/[\s,٬]/g, "");
  const m = t.match(/(\d{4,6})/); // چهار تا شش رقم (۹xxxx ~ ۱xxxxx)
  return m ? Number(m[1]) : null;
}
async function fetchText(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return await r.text();
}

// --- قوانین انتخاب پیام‌ها (فقط نقد/کف مشهد؛ حذف فردایی/آتی)
const TG_RULES = {
  Herat_Tomen:         { include: ["نقد", "نقدی", "کف مشهد", "اسکناس"], exclude: ["فردا", "فردایی", "آتی"] },
  Dollar_Tehran3bze:   { include: ["نقد", "کف مشهد", "اسکناس"],         exclude: ["فردا", "فردایی", "آتی"] },
  Dollar_Sulaymaniyah: { include: ["نقد", "کف مشهد", "اسکناس"],         exclude: ["فردا", "فردایی", "آتی"] },
  AbanTetherPrice:     { include: ["نقد", "USDT", "تتر", "اسکناس"],      exclude: ["فردا", "فردایی", "آتی"] },
  TetherLand:          { include: ["نقد", "USDT", "تتر", "اسکناس"],      exclude: ["فردا", "فردایی", "آتی"] },
};

function passRules(text, key) {
  const cfg = TG_RULES[key] || TG_RULES.Herat_Tomen;
  const t = toLatinDigits(text);
  const okInc = cfg.include.some(w => t.includes(w));
  const noExc = !cfg.exclude.some(w => t.includes(w));
  return okInc && noExc;
}

// --- پارس تلگرام: آخرین پیام «مجاز» + استخراج عدد و زمان
async function pickFromTelegram(key, url) {
  const html = await fetchText(url);
  // پیام‌ها را به بلوک‌ها بشکن
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  // از بالا به پایین می‌رویم (تلگرام معمولاً جدیدترین‌ها را بالاتر می‌گذارد)
  for (const raw of blocks) {
    const textHtmlMatch = raw.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    if (!textHtmlMatch) continue;
    const text = stripHtml(textHtmlMatch[1]);

    if (!passRules(text, key)) continue;

    // زمان
    const timeMatch = raw.match(/<time[^>]+datetime="([^"]+)"/i);
    const ts = timeMatch ? timeMatch[1] : new Date().toISOString();

    // عدد
    const val = firstPriceFrom(text);
    if (val) {
      return { source: key, val, ts, msg: text };
    }
  }
  return null; // چیزی مطابق قانون پیدا نشد
}

// --- پارس Bonbast: ستون Sell برای USD
async function pickFromBonbast(url) {
  const html = await fetchText(url);
  // زمان از هدر
  const tsMatch = html.match(/(\w+\s\d{1,2},\s\d{4}\s\d{2}:\d{2}\sUTC)/i);
  const ts = new Date().toISOString(); // اگر زمان صفحه پارس نشد
  // شماره‌ی USD Sell
  const rowMatch = html.match(/>USD<\/td>[\s\S]*?Sell[^0-9]*([\d,]+)[\s\S]*?Buy/i);
  const val = rowMatch ? Number(rowMatch[1].replace(/[,٬\s]/g, "")) : null;
  if (val) return { source: "Bonbast_USD", val, ts, msg: "Bonbast USD Sell" };
  return null;
}

async function main() {
  const out = { usd: [], usdt: [] };

  // USD: هرات، تهران۳باز، سلیمانی، بون‌بست
  for (const key of providers.groups.usd) {
    const meta = providers.providers[key] || {};
    try {
      if (key === "Bonbast_USD") {
        const r = await pickFromBonbast(meta.url);
        if (r) out.usd.push(r);
      } else {
        const r = await pickFromTelegram(key, meta.url);
        if (r) out.usd.push(r);
      }
    } catch (e) {
      console.error("[ERR]", key, e.message);
    }
  }

  // USDT: آبان تتر، تترلند
  for (const key of providers.groups.usdt) {
    const meta = providers.providers[key] || {};
    try {
      const r = await pickFromTelegram(key, meta.url);
      if (r) out.usdt.push(r);
    } catch (e) {
      console.error("[ERR]", key, e.message);
    }
  }

  // نوشتن خروجی
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote data/sources.json with", out.usd.length, "USD and", out.usdt.length, "USDT entries.");
  console.log("USD:", out.usd.map(x => `${x.source}=${x.val}`).join(", "));
  console.log("USDT:", out.usdt.map(x => `${x.source}=${x.val}`).join(", "));
}

main().catch(e => { console.error(e); process.exit(1); });
