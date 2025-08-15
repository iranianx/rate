// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");
const TZ = "Europe/Istanbul";
const MAX_PAGES = 16; // کمی بیشتر برای اطمینان

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

// نرمال‌سازی فارسی/عربی
function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")
    .replace(/\u0640/g, "")
    .replace(/[\u064B-\u0652]/g, " ") // اعراب → فاصله تا چسبندگی از بین برود
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
  // id از data-post (مطمئن‌تر)
  let id = null;
  const dp = block.match(/data-post="[^"]+\/(\d+)"/);
  if (dp) id = Number(dp[1]);

  // لینک و تاریخ
  let link = null, dateText = null, datetimeISO = null;
  const a = block.match(/<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if (a) {
    link = a[1].startsWith("http") ? a[1] : `https://t.me${a[1]}`;
    const title = a[0].match(/title="([^"]+)"/);
    dateText = title ? title[1] : htmlToText(a[2] || "");
    if (!id) {
      const idm = link.match(/\/(\d+)(?:\?.*)?$/);
      if (idm) id = Number(idm[1]);
    }
  }
  const t = block.match(/<time[^>]*datetime="([^"]+)"/);
  if (t) datetimeISO = t[1];

  return { link, dateText, id, datetimeISO };
}

function extractMessageText(block) {
  const m = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? htmlToText(m[1]) : null;
}

// ابزارهای زمانی
function dateKeyInTZ(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function hoursBetween(a, b) { return Math.abs((a.getTime() - b.getTime()) / 36e5); }

// تشخیص یورو/دلار و استخراج
function extractCurrenciesFromText(fullText) {
  const norm = normalizeFa(fullText);
  const lines = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);

  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);
  const isUSD = (l) => /(\bUSD\b|\$|دلار(?!\s*(استرالیا|کانادا))|دلار\s*امریکا|دلار\s*آمریکا)/i.test(l);

  let usd = null, eur = null;

  // خطی که «کف مشهد» دارد
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

  // در صورت نبود یورو در همان خط، سایر خطوط یورو
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

  // در صورت نبود دلار در همان خط، سایر خطوط دلار
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

  // لیست کاندیداها برای امروز
  const usdToday = []; // {id, value, link, time_iso, age_hours, raw_line}
  const eurToday = [];

  while (pages < MAX_PAGES) {
    const blocks = await fetchPage(before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyTodayOnThisPage = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const textNorm = normalizeFa(text);
      if (!textNorm.includes(normalizeFa(NEEDLE))) continue;

      // فقط «امروز» به وقت استانبول
      let isToday = false;
      let timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) {
          isToday = true;
          timeISO = dt.toISOString();
        }
      }
      if (!isToday) continue;

      sawAnyTodayOnThisPage = true;

      const { usd, eur } = extractCurrenciesFromText(text);
      const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;

      if (usd) usdToday.push({ ...usd, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
      if (eur) eurToday.push({ ...eur, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
    }

    pages += 1;

    // اگر در این صفحه پیام امروز نبود، یعنی از امروز عبور کردیم
    if (!sawAnyTodayOnThisPage) break;

    // آمادهٔ صفحهٔ بعد
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;

    // اگر هر دو ارز را امروز داریم و می‌خواهیم فقط آخرین را بگیریم، می‌توانیم ادامه ندهیم
    // اما چون ممکن است پیام جدیدتری در همین روز در صفحات پایین‌تر باشد، ادامه می‌دهیم
  }

  // انتخاب «آخرینِ امروز» بر اساس بزرگ‌ترین ID
  const pickLatest = (arr) => {
    if (!arr.length) return null;
    arr.sort((a, b) => b.id - a.id);
    return arr[0];
  };

  const usdPick = pickLatest(usdToday);
  const eurPick = pickLatest(eurToday);

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
    if (usdPick?.value) { lines.push(`usd=${usdPick.value}`); lines.push(`usd_msg=${usdPick.id}`); }
    if (eurPick?.value) { lines.push(`eur=${eurPick.value}`); lines.push(`eur_msg=${eurPick.id}`); }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
