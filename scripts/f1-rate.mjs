// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");
const TZ = "Europe/Istanbul";
const MAX_PAGES_TODAY = 16;
const MAX_PAGES_HISTORY = 60;

// ——— Channels ———
const CH = {
  Herat_Tomen: {
    URL: "https://t.me/s/Herat_Tomen",
    INCLUDE: ["نقدی","نقـدی","نـقدی","نقـدی","نـقـدی","نــقـدی","امروزی","امروز","نـــقـدی"],
    EXCLUDE: ["فردا","فردایی","آتی"],
  },
  Dollar_Tehran3bze: {
    URL: "https://t.me/s/Dollar_Tehran3bze",
    INCLUDE: ["نقدی","نقـدی","نـقدی","نقـدی","نـقـدی","نــقـدی","نـــقـدی"],
    EXCLUDE: ["فردا","فردایی","آتی"],
  },
  Dollar_Sulaymaniyah: {
    URL: "https://t.me/s/dollar_sulaymaniyah",
    INCLUDE: ["نقدی","مشهد","کف مشهد","کف"],
    EXCLUDE: ["فردا","فردایی","آتی"],
    NEEDLE: "کف مشهد",
  },
  AbanTetherPrice: {
    URL: "https://t.me/s/AbanTetherPrice",
    INCLUDE: ["فروش","تتر","فروش:","خرید:","خرید","نرخ تتر"],
    EXCLUDE: ["فردا","فردایی","آتی"],
  },
  TetherLand: {
    URL: "https://t.me/s/TetherLand",
    INCLUDE: ["نرخ","تتر:","تتر","نرخ تتر"],
    EXCLUDE: ["فردا","فردایی","آتی"],
  },
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

// ——— tiny helpers ———
const hasAny = (text, list) => {
  const t = normalizeFa(text);
  const arr = list.map(x => normalizeFa(x));
  return arr.some(k => t.includes(k));
};

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

// ——— SULI (کف مشهد) ———
function extractCurrenciesFromSuli(fullText) {
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

// ——— HERAT/TEHRAN helpers ———
function extractCashValue(fullText, include, exclude) {
  const norm = normalizeFa(fullText);
  const lines = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const cand = lines.filter(ln => hasAny(ln, include) && !hasAny(ln, exclude));
  const target = cand.length ? cand : lines;

  let nums = [];
  for (const ln of target) nums.push(...pickIntegersAll(ln));
  nums = nums.filter(Boolean);
  if (!nums.length) return null;

  if (nums.length >= 2) {
    const min = Math.min(...nums), max = Math.max(...nums);
    const avg = Math.round((min + max) / 2);
    return { value: avg, min, max, unit: "تومان", raw_line: target.join(" | ") };
  } else {
    return { value: nums[0], unit: "تومان", raw_line: target[0] };
  }
}

// ——— TETHER helpers ———
function extractTether(fullText) {
  // پشتیبانی از: «فروش: ...»، «خرید: ...»، و «نرخ تتر ...»
  const norm = normalizeFa(fullText);
  const t = faToEnDigits(norm);

  const sellM = t.match(/فروش\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);
  const buyM  = t.match(/خرید\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);
  const rateM = t.match(/نرخ\s*تتر[^0-9]*([0-9][0-9.,\s]*)/i) || t.match(/تتر\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);

  const sell = sellM ? Number((sellM[1] || "").replace(/[^\d]/g, "")) : null;
  const buy  = buyM  ? Number((buyM[1]  || "").replace(/[^\d]/g, "")) : null;
  let mid = null;

  if (sell && buy) mid = Math.round((sell + buy) / 2);
  else if (sell) mid = sell;
  else if (buy)  mid = buy;
  else if (rateM) mid = Number((rateM[1] || "").replace(/[^\d]/g, ""));

  if (!sell && !buy && !rateM) return null;
  return { sell: sell || null, buy: buy || null, mid: mid || null, unit: "تومان", raw_line: fullText };
}

// ——— Scanners (generic) ———
async function scanCashToday(chan) {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0;
  const picks = [];

  while (pages < MAX_PAGES_TODAY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const hasInc = hasAny(text, chan.INCLUDE);
      const hasExc = hasAny(text, chan.EXCLUDE);
      if (!hasInc || hasExc) continue;

      let isToday = false, timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) { isToday = true; timeISO = dt.toISOString(); }
      }
      if (!isToday) continue;

      sawAnyToday = true;

      const val = extractCashValue(text, chan.INCLUDE, chan.EXCLUDE);
      if (val) {
        const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;
        picks.push({ ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
      }
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  if (!picks.length) return { pick: null, foundToday: false, nextBefore: before };
  picks.sort((a, b) => b.id - a.id);
  return { pick: picks[0], foundToday: true, nextBefore: before };
}

async function scanCashLast(chan, startBefore) {
  // اولین «نقدی معتبر» در گذشته
  let before = startBefore || null;
  let pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;
    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const hasInc = hasAny(text, chan.INCLUDE);
      const hasExc = hasAny(text, chan.EXCLUDE);
      if (hasInc && !hasExc) {
        const val = extractCashValue(text, chan.INCLUDE, chan.EXCLUDE);
        if (val) {
          const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
          const age = dtISO ? hoursBetween(new Date(), new Date(dtISO)) : null;
          return { last: { ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, age_hours: age } };
        }
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { last: null };
}

// ——— SULI scanners ———
async function scanSuliToday() {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0;
  const usdToday = [], eurToday = [];

  while (pages < MAX_PAGES_TODAY) {
    const blocks = await fetchPage(CH.Dollar_Sulaymaniyah.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const textNorm = normalizeFa(text);
      if (!textNorm.includes(normalizeFa(CH.Dollar_Sulaymaniyah.NEEDLE))) continue;
      if (hasAny(text, CH.Dollar_Sulaymaniyah.EXCLUDE)) continue;

      let isToday = false, timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) { isToday = true; timeISO = dt.toISOString(); }
      }
      if (!isToday) continue;

      sawAnyToday = true;

      const { usd, eur } = extractCurrenciesFromSuli(text);
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
    nextBefore: before,
  };
}

async function scanSuliLast(startBefore) {
  let before = startBefore || null;
  let pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(CH.Dollar_Sulaymaniyah.URL, before);
    if (!blocks.length) break;

    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const textNorm = normalizeFa(text);
      if (!textNorm.includes(normalizeFa(CH.Dollar_Sulaymaniyah.NEEDLE))) continue;
      if (hasAny(text, CH.Dollar_Sulaymaniyah.EXCLUDE)) continue;

      const { usd, eur } = extractCurrenciesFromSuli(text);
      const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
      const age = dtISO ? hoursBetween(new Date(), new Date(dtISO)) : null;

      // اولین مورد گذشته‌ای که نرخ دارد را برگردان
      if (usd || eur) {
        return {
          usdLast: usd ? { ...usd, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, age_hours: age } : null,
          eurLast: eur ? { ...eur, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, age_hours: age } : null,
        };
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { usdLast: null, eurLast: null };
}

// ——— TETHER scanners ———
async function scanTetherToday(chan) {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0;
  const picks = [];

  while (pages < MAX_PAGES_TODAY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const hasInc = hasAny(text, chan.INCLUDE);
      const hasExc = hasAny(text, chan.EXCLUDE);
      if (!hasInc || hasExc) continue;

      let isToday = false, timeISO = null;
      if (meta.datetimeISO) {
        const dt = new Date(meta.datetimeISO);
        if (dateKeyInTZ(dt) === todayKey) { isToday = true; timeISO = dt.toISOString(); }
      }
      if (!isToday) continue;

      sawAnyToday = true;

      const val = extractTether(text);
      if (val) {
        const age = timeISO ? hoursBetween(now, new Date(timeISO)) : null;
        picks.push({ ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, age_hours: age });
      }
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  if (!picks.length) return { pick: null, foundToday: false, nextBefore: before };
  picks.sort((a, b) => b.id - a.id);
  return { pick: picks[0], foundToday: true, nextBefore: before };
}

async function scanTetherLast(chan, startBefore) {
  let before = startBefore || null;
  let pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;

    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const hasInc = hasAny(text, chan.INCLUDE);
      const hasExc = hasAny(text, chan.EXCLUDE);
      if (!hasInc || hasExc) continue;

      const val = extractTether(text);
      if (val) {
        const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
        const age = dtISO ? hoursBetween(new Date(), new Date(dtISO)) : null;
        return { last: { ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, age_hours: age } };
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { last: null };
}

// ——— Bon-Bast (homepage table) ———
async function scanBonbast() {
  const URL = "https://www.bon-bast.com/";
  const res = await fetch(URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${URL}`);
  const html = await res.text();
  const text = htmlToText(html);

  // as_of
  let as_of_text = null;
  const mAsOf = text.match(/Iranian Rial Exchange Rates\.\s*([^\n]+?)\s*All prices/i);
  if (mAsOf) as_of_text = mAsOf[1].trim();

  // یک تکه از جدول: به سراغ خطوط USD/EUR می‌رویم
  function pickRow(codeRegex, nameRegex) {
    // نمونه: "USD  US Dollar  93,300   92,740"
    const re = new RegExp(`${codeRegex.source}[^\\n]*${nameRegex.source}[^\\n]*?([0-9][\\d,\\s]*)[^\\n]*?([0-9][\\d,\\s]*)`, "i");
    const m = text.match(re);
    if (!m) return null;
    const sell = Number((m[1] || "").replace(/[^\d]/g, ""));
    const buy  = Number((m[2] || "").replace(/[^\d]/g, ""));
    if (!sell && !buy) return null;
    return { sell: sell || null, buy: buy || null, unit: "تومان" };
  }

  const usd = pickRow(/\bUSD\b/, /\bUS Dollar\b/);
  const eur = pickRow(/\bEUR\b/, /\bEuro\b/);

  return {
    source_bonbast: URL,
    bonbast: { as_of_text, usd: usd || null, eur: eur || null },
  };
}

// ——— Main ———
async function main() {
  // Herat (full features: today, future_only, last)
  const heratToday = await scanCashToday(CH.Herat_Tomen);
  const heratLast  = await scanCashLast(CH.Herat_Tomen, heratToday.nextBefore);
  const herat = {
    usd_herat_cash: heratToday.pick || null,
    herat_found_today: heratToday.foundToday,
    herat_future_only: !heratToday.foundToday && heratToday.nextBefore !== null, // امروز پست هست ولی نقدی نبود → احتمالاً future-only
    herat_last_cash: heratLast.last || null,
  };

  // Tehran3bze (today + last)
  const tehranToday = await scanCashToday(CH.Dollar_Tehran3bze);
  const tehranLast  = await scanCashLast(CH.Dollar_Tehran3bze, tehranToday.nextBefore);
  const tehran = {
    usd_tehran_cash: tehranToday.pick || null,
    tehran_found_today: tehranToday.foundToday,
    tehran_last_cash: tehranLast.last || null,
  };

  // Suli (today + last for USD/EUR)
  const suliToday = await scanSuliToday();
  const suliLast  = await scanSuliLast(suliToday.nextBefore);
  const suli = {
    usd_floor_mashhad: suliToday.usdPick || null,
    eur_floor_mashhad: suliToday.eurPick || null,
    usd_found_today: suliToday.usdFoundToday,
    eur_found_today: suliToday.eurFoundToday,
    usd_floor_mashhad_last: suliLast.usdLast || null,
    eur_floor_mashhad_last: suliLast.eurLast || null,
  };

  // Tether (today + last)
  const abanToday  = await scanTetherToday(CH.AbanTetherPrice);
  const abanLast   = await scanTetherLast(CH.AbanTetherPrice, abanToday.nextBefore);
  const tlandToday = await scanTetherToday(CH.TetherLand);
  const tlandLast  = await scanTetherLast(CH.TetherLand, tlandToday.nextBefore);

  const usdt = {
    usdt_aban: abanToday.pick || null,
    aban_found_today: abanToday.foundToday,
    usdt_aban_last: abanLast.last || null,

    usdt_tetherland: tlandToday.pick || null,
    tetherland_found_today: tlandToday.foundToday,
    usdt_tetherland_last: tlandLast.last || null,
  };

  // Bon-bast (homepage)
  const bonbast = await scanBonbast();

  const payload = {
    status: "ok",
    scraped_at: new Date().toISOString(),

    // Herat
    source_herat: CH.Herat_Tomen.URL,
    ...herat,

    // Tehran3bze
    source_tehran3bze: CH.Dollar_Tehran3bze.URL,
    ...tehran,

    // Sulaymaniyah
    source_sulaymaniyah: CH.Dollar_Sulaymaniyah.URL,
    needle: CH.Dollar_Sulaymaniyah.NEEDLE,
    ...suli,

    // USDT
    source_aban: CH.AbanTetherPrice.URL,
    source_tetherland: CH.TetherLand.URL,
    ...usdt,

    // Bon-bast
    ...bonbast,
  };

  ensureDir(OUTDIR);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  // GitHub outputs (فقط امروزها را خروجی بده؛ last ها برای نمایش هستند)
  if (process.env.GITHUB_OUTPUT) {
    const L = [];

    // Herat
    L.push(`herat_found_today=${herat.herat_found_today}`);
    L.push(`herat_future_only=${herat.herat_future_only}`);
    if (herat.usd_herat_cash?.value) { L.push(`herat_usd=${herat.usd_herat_cash.value}`); L.push(`herat_msg=${herat.usd_herat_cash.id||""}`); }

    // Tehran
    L.push(`tehran_found_today=${tehran.tehran_found_today}`);
    if (tehran.usd_tehran_cash?.value) { L.push(`tehran_usd=${tehran.usd_tehran_cash.value}`); L.push(`tehran_msg=${tehran.usd_tehran_cash.id||""}`); }

    // Sulaymaniyah
    L.push(`usd_found_today=${suli.usd_found_today}`);
    if (suli.usd_floor_mashhad?.value) { L.push(`usd=${suli.usd_floor_mashhad.value}`); L.push(`usd_msg=${suli.usd_floor_mashhad.id||""}`); }
    L.push(`eur_found_today=${suli.eur_found_today}`);
    if (suli.eur_floor_mashhad?.value) { L.push(`eur=${suli.eur_floor_mashhad.value}`); L.push(`eur_msg=${suli.eur_floor_mashhad.id||""}`); }

    // USDT
    L.push(`aban_found_today=${usdt.aban_found_today}`);
    if (usdt.usdt_aban?.mid)  L.push(`aban_mid=${usdt.usdt_aban.mid}`);
    if (usdt.usdt_aban?.sell) L.push(`aban_sell=${usdt.usdt_aban.sell}`);
    if (usdt.usdt_aban?.buy)  L.push(`aban_buy=${usdt.usdt_aban.buy}`);

    L.push(`tetherland_found_today=${usdt.tetherland_found_today}`);
    if (usdt.usdt_tetherland?.mid)  L.push(`tetherland_mid=${usdt.usdt_tetherland.mid}`);
    if (usdt.usdt_tetherland?.sell) L.push(`tetherland_sell=${usdt.usdt_tetherland.sell}`);
    if (usdt.usdt_tetherland?.buy)  L.push(`tetherland_buy=${usdt.usdt_tetherland.buy}`);

    // Bon-bast: برای اطلاع
    if (bonbast?.bonbast?.usd?.sell) L.push(`bonbast_usd_sell=${bonbast.bonbast.usd.sell}`);
    if (bonbast?.bonbast?.usd?.buy)  L.push(`bonbast_usd_buy=${bonbast.bonbast.usd.buy}`);
    if (bonbast?.bonbast?.eur?.sell) L.push(`bonbast_eur_sell=${bonbast.bonbast.eur.sell}`);
    if (bonbast?.bonbast?.eur?.buy)  L.push(`bonbast_eur_buy=${bonbast.bonbast.eur.buy}`);

    fs.appendFileSync(process.env.GITHUB_OUTPUT, L.join("\n") + "\n");
  }
}

main().catch(err => { console.error("ERROR:", err); process.exit(1); });
