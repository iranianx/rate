// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");
const TZ = "Europe/Istanbul";
const MAX_PAGES = 12;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function htmlToText(html) {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .trim();
}

// نرمال‌سازی فارسی
function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")
    .replace(/\u0640/g, "")
    .replace(/[\u064B-\u0652]/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
}

// تبدیل ارقام فارسی/عربی و جداکننده‌ها
function faToEnDigits(str) {
  if (!str) return str;
  const map = {
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "٫":".","٬":",","،":","
  };
  return str.replace(/[۰-۹٠-٩٫٬،]/g, ch => map[ch] ?? ch);
}

function pickIntegersAll(s) {
  if (!s) return [];
  const t = faToEnDigits(s);
  const out = [];
  const re = /([0-9][0-9.,\s]*)/g;
  let m;
  while ((m = re.exec(t))) {
    const clean = m[1].replace(/[^\d]/g, "");
    if (clean) out.push(Number(clean));
  }
  return out;
}

function extractBlocks(html) {
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}

function extractMessageMeta(block) {
  const a = block.match(
    /<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  );
  let link = null, dateText = null, id = null, datetimeISO = null;
  if (a) {
    link = a[1].startsWith("http") ? a[1] : `https://t.me${a[1]}`;
    const title = a[0].match(/title="([^"]+)"/);
    dateText = title ? title[1] : htmlToText(a[2] || "");
    const idm = link.match(/\/(\d+)(?:\?.*)?$/);
    if (idm) id = Number(idm[1]);
  }
  const t = block.match(/<time[^>]*datetime="([^"]+)"/);
  if (t) datetimeISO = t[1];
  return { link, dateText, id, datetimeISO };
}

function extractMessageText(block) {
  const m = block.match(
    /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  return m ? htmlToText(m[1]) : null;
}

// ابزارهای زمانی
function dateKeyInTZ(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function hoursBetween(a, b) { return Math.abs((a.getTime() - b.getTime()) / 36e5); }

// تشخیص یورو/دلار و استخراج اعداد
function extractCurrenciesFromText(fullText) {
  const norm = normalizeFa(fullText);
  const lines = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);

  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);
  const isUSD = (l) => /(\bUSD\b|\$|دلار(?!\s*(استرالیا|کانادا))|دلار\s*امریکا|دلار\s*آمریکا)/i.test(l);

  let usd = null, eur = null;

  const floorLine = lines.find(l => l.includes("کف مشهد"));
  if (floorLine) {
    const nums = pickIntegersAll(floorLine);
    if (isEUR(floorLine) && nums.length) {
      const min = Math.min(...nums), max = Math.max(...nums);
      const avg = Math.round((min + max) / 2);
      eur = { value: avg, min, max, unit: "تومان", raw_line: floorLine };
    } else if (nums.length) {
      usd = { value: nums[0], unit: "تومان", raw_line: floorLine };
    }
  }
  if (!eur) {
    for (const line of lines) {
      if (isEUR(line)) {
        const nums = pickIntegersAll(line);
        if (nums.length) {
          const min = Math.min(...nums), max = Math.max(...nums);
          const avg = Math.round((min + max) / 2);
          eur = { value: avg, min, max, unit: "تومان", raw_line: line };
          break;
        }
      }
    }
  }
  if (!usd) {
    for (const line of lines) {
      if (isUSD(line)) {
        const nums = pickIntegersAll(line);
        if (nums.length) { usd = { value: nums[0], unit: "تومان", raw_line: line }; break; }
      }
    }
  }
  return { usd, eur };
}

async function fetchPage(beforeId = null) {
  const url = beforeId ? `${URL}?before=${beforeId}` : URL;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return extractBlocks(html);
}

async function main() {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null;
  let pages = 0;

  // همیشه «آخرینِ امروز» را انتخاب می‌کنیم، یعنی بالاترین ID در همان روز
  let usdPick = null; // {value, unit, raw_line, link, id, time_iso, age_hours}
  let eurPick = null;

  while (pages < MAX_PAGES) {
    const blocks = await fetchPage(before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyTodayOnThisPage = false;

    // همهٔ بلاک‌ها را پیمایش کن، هرجا «امروز» بود، کاندیداها را به‌روزرسانی کن
    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const textNorm = normalizeFa(text);
      if (!textNorm.includes(normalizeFa(NEEDLE))) continue;

      let isToday = false;
      let timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        isToday = dateKeyInTZ(dt) === todayKey;
        timeISO = dt.toISOString();
      }
      if (!isToday) continue;

      sawAnyTodayOnThisPage = true;

      const { usd, eur } = extractCurrenciesFromText(text);
      const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;

      // فقط اگر این پیام «جدیدتر» از قبلی است، جایگزین کن
      if (usd && (!usdPick || (meta.id ?? 0) > (usdPick.id ?? 0))) {
        usdPick = { ...usd, link: meta.link || null, id: meta.id || null, time_iso: timeISO, age_hours: age };
      }
      if (eur && (!eurPick || (meta.id ?? 0) > (eurPick.id ?? 0))) {
        eurPick = { ...eur, link: meta.link || null, id: meta.id || null, time_iso: timeISO, age_hours: age };
      }
    }

    // آمادهٔ صفحهٔ بعد، تا وقتی هنوز «امروز» را می‌بینیم پایین برو
    pages += 1;
    if (Number.isFinite(pageMinId)) before = pageMinId;
    // اگر این صفحه هیچ پیامِ «امروز» نداشت، یعنی از امروز عبور کرده‌ایم، توقف
    if (!sawAnyTodayOnThisPage) break;
    if (!before) break;
    // اگر هر دو مقدار امروز را گرفته‌ایم، می‌توانیم بایستیم
    if (usdPick && eurPick) break;
  }

  const payload = {
    status: "ok",
    source: URL,
    needle: NEEDLE,
    scraped_at: new Date().toISOString(),
    usd_floor_mashhad: usdPick || null,
    eur_floor_mashhad: eurPick || null,
    usd_found_today: Boolean(usdPick),
    eur_found_today: Boolean(eurPick),
  };

  ensureDir(OUTDIR);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  if (process.env.GITHUB_OUTPUT) {
    const lines = [];
    lines.push(`usd_found_today=${payload.usd_found_today}`);
    lines.push(`eur_found_today=${payload.eur_found_today}`);
    if (payload.usd_floor_mashhad?.value) {
      lines.push(`usd=${payload.usd_floor_mashhad.value}`);
      if (payload.usd_floor_mashhad.id) lines.push(`usd_msg=${payload.usd_floor_mashhad.id}`);
    }
    if (payload.eur_floor_mashhad?.value) {
      lines.push(`eur=${payload.eur_floor_mashhad.value}`);
      if (payload.eur_floor_mashhad.id) lines.push(`eur_msg=${payload.eur_floor_mashhad.id}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
