// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");
const TZ = "Europe/Istanbul";
const MAX_PAGES = 16;

// ——— Channels ———
const HERAT = {
  URL: "https://t.me/s/Herat_Tomen",
  INCLUDE: ["نقدی","نقـدی","نـقدی","نقـدی","نـقـدی","نــقـدی","امروزی","نـــقـدی"],
  EXCLUDE: ["فردا","فردایی","آتی"],
};

const SULI = {
  URL: "https://t.me/s/dollar_sulaymaniyah",
  NEEDLE: "کف مشهد",
};

// ——— FS util ———
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ——— HTML → text ———
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

// ——— FA normalize ———
function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")          // ZWNJ → space
    .replace(/\u0640/g, "")           // keshideh
    .replace(/[\u064B-\u0652]/g, " ") // harakat → space
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
}

// ——— digits & numbers ———
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

// ——— Telegram parse ———
function extractBlocks(html) {
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}
function extractMessageText(block) {
  const m = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? htmlToText(m[1]) : null;
}
function extractMessageMeta(block) {
  // Prefer data-post for id
  let id = null;
  const dp = block.match(/data-post="[^"]+\/(\d+)"/);
  if (dp) id = Number(dp[1]);

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

async function fetchPage(url, beforeId = null) {
  const u = beforeId ? `${url}?before=${beforeId}` : url;
  const res = await fetch(u, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  const html = await res.text();
  return extractBlocks(html);
}

// ——— time helpers ———
function dateKeyInTZ(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function hoursBetween(a, b) { return Math.abs((a.getTime() - b.getTime()) / 36e5); }

// ——— HERAT: match logic ———
function buildMatcher(includeArr, excludeArr) {
  const inc = includeArr.map(x => normalizeFa(x));
  const exc = excludeArr.map(x => normalizeFa(x));
  return (text) => {
    const t = normalizeFa(text);
    const hasInc = inc.some(k => t.includes(k));
    const hasExc = exc.some(k => t.includes(k));
    return hasInc && !hasExc;
  };
}
function extractHeratValue(fullText) {
  // از خطوطی که عبارت‌های include دارند عددها را جمع کن
  const norm = normalizeFa(fullText);
  const lines = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const inc = buildMatcher(HERAT.INCLUDE, []).bind(null);

  // ابتدا فقط خطوطی که شامل یکی از کلیدهای include هستند
  const candLines = lines.filter(ln => inc(ln));

  // اگر چیزی پیدا نشد، از کل پیام اعداد را بردار
  const targetLines = candLines.length ? candLines : lines;

  // همه اعداد این خطوط
  let nums = [];
  for (const ln of targetLines) nums.push(...pickIntegersAll(ln));
  nums = nums.filter(Boolean);

  if (!nums.length) return null;

  // اگر دو عدد یا بیشتر وجود داشت، میانگین کمترین و بیشترین، در غیر این صورت همان تک‌عدد
  if (nums.length >= 2) {
    const min = Math.min(...nums), max = Math.max(...nums);
    const avg = Math.round((min + max) / 2);
    return { value: avg, min, max, unit: "تومان", raw_line: targetLines.join(" | ") };
  } else {
    return { value: nums[0], unit: "تومان", raw_line: targetLines[0] };
  }
}

// ——— SULI: currency extraction ———
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

// ——— Scanners ———
async function scanHeratToday() {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);
  const matchOk = buildMatcher(HERAT.INCLUDE, HERAT.EXCLUDE);

  let before = null, pages = 0;
  const picks = []; // candidates for today

  while (pages < MAX_PAGES) {
    const blocks = await fetchPage(HERAT.URL, before);
    if (!blocks.length) break;
    let pageMinId = Infinity;
    let sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      if (!matchOk(text)) continue;

      let isToday = false, timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) {
          isToday = true;
          timeISO = dt.toISOString();
        }
      }
      if (!isToday) continue;
      sawAnyToday = true;

      const val = extractHeratValue(text);
      if (val) {
        const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;
        picks.push({ ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
      }
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  if (!picks.length) return { pick: null, foundToday: false };
  picks.sort((a, b) => b.id - a.id);
  return { pick: picks[0], foundToday: true };
}

async function scanSuliToday() {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0;
  const usdToday = [], eurToday = [];

  while (pages < MAX_PAGES) {
    const blocks = await fetchPage(SULI.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const textNorm = normalizeFa(text);
      if (!textNorm.includes(normalizeFa(SULI.NEEDLE))) continue;

      let isToday = false, timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) {
          isToday = true;
          timeISO = dt.toISOString();
        }
      }
      if (!isToday) continue;
      sawAnyToday = true;

      const { usd, eur } = extractCurrenciesFromText(text);
      const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;
      if (usd) usdToday.push({ ...usd, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
      if (eur) eurToday.push({ ...eur, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  const pickLatest = (arr) => arr.length ? arr.sort((a, b) => b.id - a.id)[0] : null;

  return {
    usdPick: pickLatest(usdToday),
    eurPick: pickLatest(eurToday),
    usdFoundToday: Boolean(usdToday.length),
    eurFoundToday: Boolean(eurToday.length),
  };
}

// ——— Main ———
async function main() {
  const herat = await scanHeratToday();         // اول هرات
  const suli  = await scanSuliToday();          // بعد سلیمانیه

  const payload = {
    status: "ok",
    scraped_at: new Date().toISOString(),
    // Herat
    source_herat: HERAT.URL,
    usd_herat_cash: herat.pick || null,
    herat_found_today: herat.foundToday,
    // Sulaymaniyah
    source_sulaymaniyah: SULI.URL,
    needle: SULI.NEEDLE,
    usd_floor_mashhad: suli.usdPick || null,
    eur_floor_mashhad: suli.eurPick || null,
    usd_found_today: suli.usdFoundToday,
    eur_found_today: suli.eurFoundToday,
  };

  ensureDir(OUTDIR);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  if (process.env.GITHUB_OUTPUT) {
    const lines = [];
    lines.push(`herat_found_today=${payload.herat_found_today}`);
    if (payload.usd_herat_cash?.value) {
      lines.push(`herat_usd=${payload.usd_herat_cash.value}`);
      if (payload.usd_herat_cash.id) lines.push(`herat_msg=${payload.usd_herat_cash.id}`);
    }
    lines.push(`usd_found_today=${payload.usd_found_today}`);
    if (payload.usd_floor_mashhad?.value) {
      lines.push(`usd=${payload.usd_floor_mashhad.value}`);
      if (payload.usd_floor_mashhad.id) lines.push(`usd_msg=${payload.usd_floor_mashhad.id}`);
    }
    lines.push(`eur_found_today=${payload.eur_found_today}`);
    if (payload.eur_floor_mashhad?.value) {
      lines.push(`eur=${payload.eur_floor_mashhad.value}`);
      if (payload.eur_floor_mashhad.id) lines.push(`eur_msg=${payload.eur_floor_mashhad.id}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch(err => { console.error("ERROR:", err); process.exit(1); });
