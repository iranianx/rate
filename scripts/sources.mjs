// scripts/sources.mjs
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PROVIDERS_PATH = path.join(DATA_DIR, "providers.json");
const OUT_PATH = path.join(DATA_DIR, "sources.json");
const SNAPS_DIR = path.join(ROOT, "docs", "snaps"); // محل ذخیرهٔ اسکرین‌شات‌ها
fs.mkdirSync(SNAPS_DIR, { recursive: true });

const TZ = "Europe/Istanbul"; // نمایش ساعت محلی

const providers = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf-8"));
const headers = { "user-agent": "IranianX/1.0 (+https://github.com/iranianx/rate)" };
const dlog = (...args) => console.log("[SRC]", ...args);

// --- نگاشت کاننیکال برای هم‌خوانی با state/ewma.json
const CANON = {
  dollar_tehran3bze: "Dollar_Tehran3bze",
  dollar_sulaymaniyah: "Dollar_Sulaymaniyah",
  bonbast: "Bonbast_USD",
};
const canonKey = (k) => CANON[k] || k;

// --- ابزارهای کمکی ارقام/متن
const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
function toLatinDigits(s) {
  if (!s) return "";
  return String(s)
    .replace(/[۰-۹]/g, d => String(persianDigits.indexOf(d)))
    .replace(/[\u066B\u066C]/g, ",") // Arabic decimal/group separators → commas
    .replace(/\u200c/g, "");         // ZWNJ
}

function stripHtml(s) {
  return toLatinDigits(
    String(s)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
  ).trim();
}

// --- نرمال‌سازی فارسی برای تطبیق کلیدواژه‌ها
function normFa(s) {
  if (!s) return "";
  return toLatinDigits(String(s))
    .replace(/[\u0640\u200c\u200d\u200f]/g, "")   // کشیده و ZWJ/ZWNJ و RTL mark
    .replace(/[\u064B-\u0652]/g, "")              // اعراب
    .replace(/[إأآ]/g, "ا")                       // همسان‌سازی الف‌ها
    .replace(/ي/g, "ی").replace(/ك/g, "ک")       // عربی→فارسی
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTelegramUrl(url) {
  if (!url) return url;
  // t.me/channel → t.me/s/channel  (نسخهٔ قابل خزش)
  if (/t\.me\/(?!s\/)/.test(url)) return url.replace("t.me/", "t.me/s/");
  return url;
}

// ISO محلی (بدون آفست) برای نمایش: YYYY-MM-DDTHH:MM:SS به وقت tz
function toTZISO(iso, tz = TZ) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// --- یافتن عدد: ترجیحاً نزدیک به کلمات کلیدی «نقدی/USDT/…»، در غیر این صورت اولین عدد منطقی
function extractPricePreferKeywords(text, includeWords) {
  const t = toLatinDigits(text);
  const numRe = /(\d{1,3}(?:[,\.\s٬]\d{3})+|\d{4,6})/g;

  // 1) تلاش: نزدیک به کلمات کلیدی
  const tn = normFa(t);
  for (const wRaw of includeWords || []) {
    const w = normFa(wRaw);
    if (!w) continue;
    const idx = tn.indexOf(w);
    if (idx === -1) continue;
    // پنجرهٔ اطراف کلید (±60 کاراکتر روی متن اصلیِ غیرنرمال)
    const lo = Math.max(0, idx - 60);
    const hi = Math.min(t.length, idx + w.length + 60);
    const win = t.slice(lo, hi);
    let m;
    while ((m = numRe.exec(win)) !== null) {
      const n = Number(m[1].replace(/[,\.\s٬]/g, ""));
      if (n >= 1000 && n <= 200000) return n;
    }
  }

  // 2) fallback: اولین عدد منطقی در کل متن
  let m;
  while ((m = numRe.exec(t)) !== null) {
    const n = Number(m[1].replace(/[,\.\s٬]/g, ""));
    if (n >= 1000 && n <= 200000) return n;
  }
  return null;
}

async function fetchText(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return await r.text();
}

// --- قوانین تلگرام (بر اساس فهرستِ شما)
const TG_RULES = {
  Herat_Tomen:         { include: ["نقدی", "نقـدی", "نـقدی", "نقـدی", "نـقـدی", "نــقـدی", "امروزی", "نـــقـدی"], exclude: ["فردا", "فردایی", "آتی"] },
  Dollar_Tehran3bze:   { include: ["نقدی", "نقـدی", "نـقدی", "نقـدی", "نـقـدی", "نــقـدی", "نـــقـدی"], exclude: ["فردا", "فردایی", "آتی"] },
  Dollar_Sulaymaniyah: { include: ["نقدی", "مشهد", "کف مشهد", "کف"], exclude: ["فردا", "فردایی", "آتی"] },
  AbanTetherPrice:     { include: ["فروش", "تتر", "فروش:", "خرید:", "خرید"], exclude: ["فردا", "فردایی", "آتی"] },
  TetherLand:          { include: ["نرخ", "تتر:", "تتر"], exclude: ["فردا", "فردایی", "آتی"] },
};

function passRules(text, key) {
  const cfg = TG_RULES[key] || TG_RULES.Herat_Tomen;
  const t = normFa(text);
  const incWords = (cfg.include || []).map(normFa);
  const excWords = (cfg.exclude || []).map(normFa);

  const hasInc = incWords.some(w => w && t.includes(w));
  const hasExc = excWords.some(w => w && t.includes(w));
  return hasInc && !hasExc;
}

// --- پارس تلگرام: جدیدترین پیامِ «مجاز» + استخراج عدد نزدیک به کلمهٔ کلیدی
async function pickFromTelegram(key, url) {
  const html = await fetchText(normalizeTelegramUrl(url));
  const parts = html.split("tgme_widget_message_wrap").slice(1);
  dlog(`TG ${key}: blocks=${parts.length}`);

  const cfg = TG_RULES[key] || TG_RULES.Herat_Tomen;
  const candidates = [];

  for (const raw of parts) {
    const textHtmlMatch = raw.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    if (!textHtmlMatch) continue;
    const text = stripHtml(textHtmlMatch[1]);

    if (!passRules(text, key)) continue;

    // زمان از <time datetime="...">
    const timeMatch = raw.match(/<time[^>]+datetime="([^"]+)"/i);
    const tsUTC = timeMatch ? new Date(timeMatch[1]).toISOString() : new Date().toISOString();
    const tsLocal = toTZISO(tsUTC, TZ);

    // عدد (ترجیحاً نزدیک به کلیدواژه‌ها)
    const val = extractPricePreferKeywords(text, (cfg.include || []).map(normFa));
    if (val != null) {
      candidates.push({ source: key, val, ts: tsUTC, ts_local: tsLocal, tz: TZ, msg: text });
    }
  }

  if (candidates.length === 0) return null;

  // جدیدترین پیام
  candidates.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const pick = candidates[0];
  dlog(`TG ${key} PICK: ts=${pick.ts} (local=${pick.ts_local}) val=${pick.val} msg="${(pick.msg || "").slice(0, 80)}..."`);
  return pick;
}

// --- پارس Bonbast: ستون Sell برای USD (+ زمان در حد امکان)
async function pickFromBonbast(url) {
  const html = await fetchText(url);

  // سطر USD و ستون Sell
  const rowMatch =
    html.match(/>USD<\/td>[\s\S]*?Sell[^0-9]*([\d,.\s٬]+)[\s\S]*?Buy/i) ||
    html.match(/>USD<\/td>[\s\S]*?Buy[\s\S]*?Sell[^0-9]*([\d,.\s٬]+)/i);

  const val = rowMatch ? Number(rowMatch[1].replace(/[,\.\s٬]/g, "")) : null;

  // زمان (Last Update ... UTC) — اگر یافت نشد، now
  let tsUTC = new Date().toISOString();
  const lastUpd =
    html.match(/Last\s*Update[^<]*?(\w+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*UTC)/i) ||
    html.match(/Updated[^<]*?(\w+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*UTC)/i);
  if (lastUpd && lastUpd[1]) {
    const maybe = new Date(lastUpd[1] + ""); // مرورگر معمولاً متوجه فرمت انگلیسی می‌شود
    if (!isNaN(maybe)) tsUTC = maybe.toISOString();
  }
  const tsLocal = toTZISO(tsUTC, TZ);

  if (val) {
    dlog(`BB USD SELL: ${val} (ts=${tsUTC}, local=${tsLocal})`);
    return { source: "Bonbast_USD", val, ts: tsUTC, ts_local: tsLocal, tz: TZ, msg: "Bonbast USD Sell" };
  }
  return null;
}

// --- اسکرین‌شات: اختیاری با puppeteer (SRC_SCREENSHOT=1)
async function maybeScreenshotTelegram(key, url, price, tsLocal) {
  if (process.env.SRC_SCREENSHOT !== "1") return false;
  let puppeteer;
  try { puppeteer = await import("puppeteer"); } catch { dlog("puppeteer not installed"); return false; }

  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  const gotoUrl = normalizeTelegramUrl(url);
  await page.goto(gotoUrl, { waitUntil: "networkidle2", timeout: 60000 });

  // پیدا کردن پیامی که price داخل متنش هست
  const handle = await page.evaluateHandle((priceStr) => {
    const blocks = Array.from(document.querySelectorAll(".tgme_widget_message_wrap"));
    const target = blocks.find(b => (b.innerText || "").replace(/\s+/g, "").includes(String(priceStr)));
    return target || null;
  }, String(price));

  if (handle) {
    const el = handle.asElement();
    const file = path.join(SNAPS_DIR, `${key}-${tsLocal.replace(/[:]/g, "-")}-${price}.png`);
    await el.screenshot({ path: file });
    dlog(`SNAP TG ${key} → ${file}`);
  } else {
    dlog(`SNAP TG ${key} — target message not found for price=${price}`);
  }
  await browser.close();
  return true;
}

async function maybeScreenshotBonbast(url, tsLocal) {
  if (process.env.SRC_SCREENSHOT !== "1") return false;
  let puppeteer;
  try { puppeteer = await import("puppeteer"); } catch { dlog("puppeteer not installed"); return false; }

  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  const file = path.join(SNAPS_DIR, `Bonbast-${tsLocal.replace(/[:]/g, "-")}.png`);
  await page.screenshot({ path: file, fullPage: true });
  dlog(`SNAP Bonbast → ${file}`);
  await browser.close();
  return true;
}

async function main() {
  const out = { usd: [], usdt: [] };

  // USD: هرات، تهران۳بزه، سلیمانی، بون‌بست
  for (const key of providers.groups.usd) {
    const meta = providers.providers[key] || {};
    const srcKey = canonKey(key);
    try {
      let rec = null;
      if ((meta.type || "").toLowerCase() === "website") {
        rec = await pickFromBonbast(meta.url);
        if (rec) {
          rec.source = srcKey; // canon
          out.usd.push({ ...rec, url: meta.url });
          await maybeScreenshotBonbast(meta.url, rec.ts_local);
        }
      } else {
        // srcKey چون قوانین بر اساس کاننیکال تعریف شده‌اند
        rec = await pickFromTelegram(srcKey, meta.url);
        if (rec) {
          out.usd.push({ ...rec, url: normalizeTelegramUrl(meta.url) });
          await maybeScreenshotTelegram(srcKey, meta.url, rec.val, rec.ts_local);
        }
      }
    } catch (e) {
      console.error("[ERR][USD]", key, e.message);
    }
  }

  // USDT: آبان تتر، تترلند
  for (const key of providers.groups.usdt) {
    const meta = providers.providers[key] || {};
    const srcKey = canonKey(key);
    try {
      const rec = await pickFromTelegram(srcKey, meta.url);
      if (rec) {
        out.usdt.push({ ...rec, url: normalizeTelegramUrl(meta.url) });
        await maybeScreenshotTelegram(srcKey, meta.url, rec.val, rec.ts_local);
      }
    } catch (e) {
      console.error("[ERR][USDT]", key, e.message);
    }
  }

  // نوشتن خروجی
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote data/sources.json with", out.usd.length, "USD and", out.usdt.length, "USDT entries.");
  console.log("USD:", out.usd.map(x => `${x.source}=${x.val}`).join(", "));
  console.log("USDT:", out.usdt.map(x => `${x.source}=${x.val}`).join(", "));
}

main().catch(e => { console.error(e); process.exit(1); });
