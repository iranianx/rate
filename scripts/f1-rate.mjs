// ================================
// SECTION 1 — Config & Constants
// ================================
import fs from "fs";
import path from "path";

const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");
const TZ = "Europe/Istanbul";

// چند صفحه برای «امروز» و چند صفحه برای جستجوی «last»
const MAX_PAGES_TODAY = 16;
const MAX_PAGES_HISTORY = 60;

// آستانه برای double-check: اگر پیام جدیدتر کمتر از این فاصله با پیک قبلی داشته باشد، نادیده بگیر
const MIN_GAP_MINUTES_FOR_DOUBLECHECK = 10;

// تعریف کانال‌ها
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
  Bonbast: {
    URL: "https://www.bon-bast.com/",
  }
};

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// --- Logging کم‌حجم (فعال با DEBUG=1)
const DEBUG = process.env.DEBUG === "1";
const dlog = (...args) => { if (DEBUG) console.log("[F1]", ...args); };

// --- پارامترهای شبکه (ENV قابل‌تنظیم)
const FETCH_TIMEOUT_MS = Number(process.env.F1_TIMEOUT_MS || 20000); // 20s
const FETCH_RETRIES    = Number(process.env.F1_RETRIES    || 2);     // 2 بار تلاش مجدد

// --- TTL (حداکثر سنِ داده برای «امروز»)
const TTL_USD_HOURS      = Number(process.env.F1_TTL_USD_HRS  || 24);
const TTL_USDT_HOURS     = Number(process.env.F1_TTL_USDT_HRS || 12);
const TTL_BONBAST_HOURS  = Number(process.env.F1_TTL_BB_HRS   || 6);

// --- بازهٔ منطقی با امکان override از ENV
const PLAUSIBLE = {
  USD: {
    min: Number(process.env.F1_PLAUSIBLE_USD_MIN  || 80000),
    max: Number(process.env.F1_PLAUSIBLE_USD_MAX  || 130000),
  },
  EUR: {
    min: Number(process.env.F1_PLAUSIBLE_EUR_MIN  || 100000),
    max: Number(process.env.F1_PLAUSIBLE_EUR_MAX  || 140000),
  },
  USDT: {
    min: Number(process.env.F1_PLAUSIBLE_USDT_MIN || 80000),
    max: Number(process.env.F1_PLAUSIBLE_USDT_MAX || 130000),
  },
};

export {
  OUTDIR, OUTFILE, TZ,
  MAX_PAGES_TODAY, MAX_PAGES_HISTORY,
  MIN_GAP_MINUTES_FOR_DOUBLECHECK,
  CH, ensureDir, DEBUG, dlog,
  FETCH_TIMEOUT_MS, FETCH_RETRIES,
  TTL_USD_HOURS, TTL_USDT_HOURS, TTL_BONBAST_HOURS,
  PLAUSIBLE
};

// ==========================================
// SECTION 2 — Text Normalization & Numbers
// ==========================================
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

function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")          // ZWNJ → space
    .replace(/\u0640/g, "")           // کشیده
    .replace(/[\u064B-\u0652]/g, " ") // اعراب → space
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
}

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

const hasAny = (text, list) => {
  const t = normalizeFa(text);
  const arr = list.map(x => normalizeFa(x));
  return arr.some(k => t.includes(k));
};

function minutesBetween(a, b) {
  return Math.abs((a.getTime() - b.getTime()) / 60000);
}

function dateKeyInTZ(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d); // YYYY-MM-DD
}

// ——— افزوده‌ها: زمان محلی + چک بازه + استخراج نزدیک کلیدواژه ———
function toTZISO(iso, tz = TZ) {
  if (!iso) return null;
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function inRange(n, lo, hi) { return typeof n === "number" && n >= lo && n <= hi; }
function plausible(code, n) {
  const r = PLAUSIBLE[code];
  return r ? inRange(n, r.min, r.max) : true;
}

function extractNearKeywords(fullText, includeWords, codeForPlausibility = null) {
  const raw = faToEnDigits(fullText || "");
  const numRe = /(\d{1,3}(?:[,\.\s٬]\d{3})+|\d{4,6})/g;
  const norm = normalizeFa(raw);

  // 1) پنجرهٔ ±60 کاراکتر اطراف هر کلیدواژه
  for (const w of (includeWords || [])) {
    const key = normalizeFa(w);
    const idx = norm.indexOf(key);
    if (idx === -1) continue;
    const lo = Math.max(0, idx - 60);
    const hi = Math.min(raw.length, idx + key.length + 60);
    const win = raw.slice(lo, hi);
    let m;
    while ((m = numRe.exec(win))) {
      const n = Number((m[1] || "").replace(/[^\d]/g, ""));
      if (n >= 1000 && n <= 200000 && (!codeForPlausibility || plausible(codeForPlausibility, n))) {
        return n;
      }
    }
  }

  // 2) fallback: اولین عدد منطقی در کل متن
  let m2;
  while ((m2 = numRe.exec(raw))) {
    const n = Number((m2[1] || "").replace(/[^\d]/g, ""));
    if (n >= 1000 && n <= 200000 && (!codeForPlausibility || plausible(codeForPlausibility, n))) {
      return n;
    }
  }
  return null;
}

// =====================================
// SECTION 3 — Telegram Fetch & Parsing
// =====================================
function extractBlocks(html) {
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}

function extractMessageText(block) {
  const m = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? htmlToText(m[1]) : null;
}

function extractMessageMeta(block) {
  // ID: ترجیحاً از data-post
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

// --- fetch با timeout+retry (از بخش 1 پیکربندی می‌گیرد)
async function fetchTextWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= (1 + FETCH_RETRIES); attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      dlog("GET OK", url, `${Date.now() - t0}ms`);
      return html;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      dlog("GET FAIL", url, `(try ${attempt}/${1 + FETCH_RETRIES}) →`, e?.name || "", e?.message || e);
      if (attempt < (1 + FETCH_RETRIES)) await new Promise(res => setTimeout(res, 500));
    }
  }
  throw lastErr || new Error("Network failed");
}

async function fetchPage(url, beforeId = null) {
  const u = beforeId ? `${url}?before=${beforeId}` : url;
  const html = await fetchTextWithRetry(u);
  return extractBlocks(html);
}

// =======================================
// SECTION 4.1 — SULI parser (کف مشهد) — with IQD filter
// =======================================

function extractCurrenciesFromSuli(fullText) {
  const norm = normalizeFa(fullText);
  const linesAll = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);

  // ⛔️ فیلتر خطوط مربوط به دینار عراق (IQD)
  const lines = linesAll.filter(l => !/(^|\s)(دینار|عراق|\bIQD\b|د\.ع)(\s|$)/i.test(l));

  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);
  const isUSD = (l) => /(\bUSD\b|\$|دلار(?!\s*(استرالیا|کانادا))|دلار\s*امریکا|دلار\s*آمریکا)/i.test(l);

  let usd = null, eur = null;

  // اولویت: خطی که «کف مشهد» دارد
  const floorLine = lines.find(l => l.includes("کف مشهد"));
  if (floorLine) {
    const nums = pickIntegersAll(floorLine);
    if (isEUR(floorLine) && nums.length) {
      const min = Math.min(...nums), max = Math.max(...nums);
      const avg = Math.round((min + max) / 2);
      if (plausible("EUR", avg)) eur = { value: avg, min, max, unit: "تومان", raw_line: floorLine };
    } else if (nums.length) {
      const v = nums[0];
      if (plausible("USD", v)) usd = { value: v, unit: "تومان", raw_line: floorLine };
    }
  }

  // اگر یورو هنوز پیدا نشده، از خطوط حاوی یورو میانگین بازه را بگیر
  if (!eur) {
    for (const line of lines) {
      if (isEUR(line)) {
        const nums = pickIntegersAll(line);
        if (nums.length) {
          const min = Math.min(...nums), max = Math.max(...nums);
          const avg = Math.round((min + max) / 2);
          if (plausible("EUR", avg)) {
            eur = { value: avg, min, max, unit: "تومان", raw_line: line };
            break;
          }
        }
      }
    }
  }

  // اگر دلار هنوز پیدا نشده، از خطوطی که نشانه‌های USD دارند اولین عدد را بگیر
  if (!usd) {
    for (const line of lines) {
      if (isUSD(line)) {
        const nums = pickIntegersAll(line);
        if (nums.length) {
          const v = nums[0];
          if (plausible("USD", v)) {
            usd = { value: v, unit: "تومان", raw_line: line };
            break;
          }
        }
      }
    }
  }

  return { usd, eur };
}

// — HERAT/TEHRAN: نقدی (اولویت نزدیک به کلیدواژه‌ها + چک بازه)
function extractCashValue(fullText, include, exclude) {
  const norm = normalizeFa(fullText);
  const lines = norm.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const cand = lines.filter(ln => hasAny(ln, include) && !hasAny(ln, exclude));
  const target = cand.length ? cand : lines;

  // تلاش 1: عدد نزدیک به کلیدواژه‌ها (USD)
  const near = extractNearKeywords(fullText, include, "USD");
  if (near) return { value: near, unit: "تومان", raw_line: target.join(" | ") };

  // تلاش 2: همان منطق بازه/اولین عدد
  let nums = [];
  for (const ln of target) nums.push(...pickIntegersAll(ln));
  nums = nums.filter(Boolean);
  if (!nums.length) return null;

  if (nums.length >= 2) {
    const min = Math.min(...nums), max = Math.max(...nums);
    const avg = Math.round((min + max) / 2);
    if (!plausible("USD", avg)) return null;
    return { value: avg, min, max, unit: "تومان", raw_line: target.join(" | ") };
  } else {
    if (!plausible("USD", nums[0])) return null;
    return { value: nums[0], unit: "تومان", raw_line: target[0] };
  }
}

// — TEHRAN: خرید/فروش/میانگین
function extractTehranCash(fullText) {
  const norm = normalizeFa(fullText);
  const t = faToEnDigits(norm);

  const buyM  = t.match(/خرید\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);
  const sellM = t.match(/فروش\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);

  const buy  = buyM  ? Number((buyM[1]  || "").replace(/[^\d]/g, "")) : null;
  const sell = sellM ? Number((sellM[1] || "").replace(/[^\d]/g, "")) : null;

  if (!buy && !sell) {
    const base = extractCashValue(fullText, CH.Dollar_Tehran3bze.INCLUDE, CH.Dollar_Tehran3bze.EXCLUDE);
    if (!base) return null;
    return { buy: null, sell: null, mid: base.value, unit: "تومان", raw_line: base.raw_line };
  }

  let mid = null;
  if (buy && sell) mid = Math.round((buy + sell) / 2);
  else mid = buy || sell;

  if (mid && !plausible("USD", mid)) return null;
  return { buy: buy || null, sell: sell || null, mid, unit: "تومان", raw_line: fullText };
}

// =======================================
// SECTION 4.2 — TETHER parser (buy/sell normalization)
// =======================================

function extractTether(fullText) {
  // نرمال‌سازی: اعداد لاتین + یکنواخت‌سازی فاصله و حروف
  const t = faToEnDigits(normalizeFa(fullText || ""));

  // الگوهای استخراج
  const mBuy   = t.match(/(?:^|\s)خرید\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);
  const mSell  = t.match(/(?:^|\s)فروش\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);
  const mRate  = t.match(/نرخ\s*تتر[^0-9]*([0-9][0-9.,\s]*)/i) || t.match(/(?:^|\s)تتر\s*[:\-]?\s*([0-9][0-9.,\s]*)/i);

  const asNum = (m) => (m ? Number((m[1] || "").replace(/[^\d]/g, "")) : null);

  let buy  = asNum(mBuy);
  let sell = asNum(mSell);

  // اگر هر دو هست و فروش کوچکتر از خرید است، جابجا کن (خطای کانال)
  if (sell != null && buy != null && sell < buy) {
    const tmp = sell; sell = buy; buy = tmp;
  }

  // محاسبهٔ mid
  let mid = null;
  if (sell != null && buy != null) mid = Math.round((sell + buy) / 2);
  else if (sell != null)          mid = sell;
  else if (buy  != null)          mid = buy;

  // اگر buy/sell پیدا نشد، از «نرخ تتر/تتر: …» استفاده کن
  if (mid == null && mRate) {
    mid = asNum(mRate);
  }

  // هیچ عددی پیدا نشده؟
  if (sell == null && buy == null && mid == null) return null;

  // چک بازهٔ منطقی USDT
  if (mid != null && !plausible("USDT", mid)) return null;

  return {
    sell: sell ?? null,
    buy:  buy  ?? null,
    mid:  mid  ?? null,
    unit: "تومان",
    raw_line: fullText
  };
}

// =======================================
// SECTION 5.1 — Shared helpers for scanners
// =======================================

function isBlockToday(meta, todayKey) {
  if (!meta?.datetimeISO) return { ok: false, timeISO: null };
  const dt = new Date(meta.datetimeISO);
  return { ok: dateKeyInTZ(dt) === todayKey, timeISO: dt.toISOString() };
}

// =======================================
// SECTION 5.2 — Generic "Cash Today" with Double-Check (Herat / custom parsers)
// =======================================
async function scanCashTodayGeneric(chan, parseFn) {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0, maxId = 0;
  const picks = [];
  let sawTodayOnPage = false;

  while (pages < MAX_PAGES_TODAY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;

    sawTodayOnPage = false;
    let pageMinId = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) { pageMinId = Math.min(pageMinId, meta.id); maxId = Math.max(maxId, meta.id); }

      const text = extractMessageText(block);
      if (!text) continue;

      const inc = hasAny(text, chan.INCLUDE);
      const exc = hasAny(text, chan.EXCLUDE);
      if (!inc || exc) continue;

      const { ok, timeISO } = isBlockToday(meta, todayKey);
      if (!ok) continue;

      sawTodayOnPage = true;

      const val = parseFn(text);
      if (val) {
        const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;
        picks.push({
          ...val,
          id: meta.id ?? 0,
          link: meta.link || null,
          time_iso: timeISO,
          time_local: timeISO ? toTZISO(timeISO, TZ) : null,
          age_hours: age
        });
      }
    }

    pages += 1;
    if (!sawTodayOnPage) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  // آخرین پیکِ امروز
  let pick = null;
  if (picks.length) { picks.sort((a, b) => b.id - a.id); pick = picks[0]; }

  // Double-check: صفحهٔ اول تا سقف 30 پست، بدون break روی id<=maxId
  const freshBlocks = await fetchPage(chan.URL, null);
  const candidates = [];
  let scanned = 0;

  for (const block of freshBlocks) {
    scanned++; if (scanned > 30) break;

    const meta = extractMessageMeta(block);
    if (!meta?.id) continue;
    if (maxId && meta.id <= maxId) continue;

    const text = extractMessageText(block);
    if (!text) continue;
    if (!hasAny(text, chan.INCLUDE) || hasAny(text, chan.EXCLUDE)) continue;

    const { ok, timeISO } = isBlockToday(meta, todayKey);
    if (!ok) continue;

    const val = parseFn(text);
    if (val) {
      const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;
      candidates.push({
        ...val,
        id: meta.id,
        link: meta.link || null,
        time_iso: timeISO,
        time_local: timeISO ? toTZISO(timeISO, TZ) : null,
        age_hours: age
      });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.id - a.id);
    const newest = candidates[0];
    if (!pick) pick = newest;
    else {
      const gap = minutesBetween(new Date(newest.time_iso || now), new Date(pick.time_iso || now));
      if (gap >= MIN_GAP_MINUTES_FOR_DOUBLECHECK) pick = newest;
    }
  }

  // TTL برای today (USD/نقدی)
  if (pick && typeof pick.age_hours === "number" && pick.age_hours > TTL_USD_HOURS) {
    pick = null;
  }

  return { pick, foundToday: Boolean(pick), nextBefore: before };
}

// =======================================
// SECTION 5.3 — Generic "Cash Last" (first valid past post)
// =======================================

async function scanCashLast(chan, startBefore) {
  let before = startBefore || null, pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;
    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const inc = hasAny(text, chan.INCLUDE);
      const exc = hasAny(text, chan.EXCLUDE);
      if (inc && !exc) {
        const val = extractCashValue(text, chan.INCLUDE, chan.EXCLUDE);
        if (val) {
          const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
          const age = dtISO ? minutesBetween(new Date(), new Date(dtISO)) / 60 : null;
          const tloc = dtISO ? toTZISO(dtISO, TZ) : null;
          return {
            last: {
              ...val,
              id: meta.id ?? 0,
              link: meta.link || null,
              time_iso: dtISO,
              time_local: tloc,
              age_hours: age
            }
          };
        }
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { last: null };
}

// =======================================
// SECTION 5.3.1 — Tehran "Last" (schema-aligned with buy/sell/mid)
// =======================================

async function scanTehranLast(startBefore) {
  const chan = CH.Dollar_Tehran3bze;
  let before = startBefore || null, pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;
    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta?.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      if (!hasAny(text, chan.INCLUDE) || hasAny(text, chan.EXCLUDE)) continue;

      const parsed = extractTehranCash(text); // ← همان parser امروز
      if (parsed) {
        const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
        const age = dtISO ? minutesBetween(new Date(), new Date(dtISO)) / 60 : null;
        const tloc = dtISO ? toTZISO(dtISO, TZ) : null;
        return {
          last: {
            ...parsed,               // { buy, sell, mid, unit, raw_line }
            id: meta.id ?? 0,
            link: meta.link || null,
            time_iso: dtISO,
            time_local: tloc,
            age_hours: age
          }
        };
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { last: null };
}

// =======================================
// SECTION 5.4 — Sulaymaniyah (Today + Double-Check + Last)
// =======================================
async function scanSuliToday() {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  let before = null, pages = 0, maxId = 0;
  const usdToday = [], eurToday = [];

  while (pages < MAX_PAGES_TODAY) {
    const blocks = await fetchPage(CH.Dollar_Sulaymaniyah.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity, sawAnyToday = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) { pageMinId = Math.min(pageMinId, meta.id); maxId = Math.max(maxId, meta.id); }

      const text = extractMessageText(block);
      if (!text) continue;

      const norm = normalizeFa(text);
      if (!norm.includes(normalizeFa(CH.Dollar_Sulaymaniyah.NEEDLE))) continue;
      if (hasAny(text, CH.Dollar_Sulaymaniyah.EXCLUDE)) continue;

      const { ok, timeISO } = isBlockToday(meta, todayKey);
      if (!ok) continue;

      sawAnyToday = true;

      const { usd, eur } = extractCurrenciesFromSuli(text);
      const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;
      if (usd) usdToday.push({ ...usd, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, time_local: toTZISO(timeISO, TZ), age_hours: age });
      if (eur) eurToday.push({ ...eur, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, time_local: toTZISO(timeISO, TZ), age_hours: age });
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  const pickLatest = (arr) => arr.length ? arr.sort((a, b) => b.id - a.id)[0] : null;
  let usdPick = pickLatest(usdToday);
  let eurPick = pickLatest(eurToday);

  // Double-check: تا 30 پست اول صفحهٔ اول، بدون break روی id<=maxId
  const freshBlocks = await fetchPage(CH.Dollar_Sulaymaniyah.URL, null);
  const candUSD = [], candEUR = [];
  let scanned = 0;

  for (const block of freshBlocks) {
    scanned++; if (scanned > 30) break;

    const meta = extractMessageMeta(block);
    if (!meta?.id) continue;
    if (maxId && meta.id <= maxId) continue;

    const text = extractMessageText(block);
    if (!text) continue;

    const norm = normalizeFa(text);
    if (!norm.includes(normalizeFa(CH.Dollar_Sulaymaniyah.NEEDLE))) continue;
    if (hasAny(text, CH.Dollar_Sulaymaniyah.EXCLUDE)) continue;

    const { ok, timeISO } = isBlockToday(meta, todayKey);
    if (!ok) continue;

    const { usd, eur } = extractCurrenciesFromSuli(text);
    const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;

    if (usd) candUSD.push({ ...usd, id: meta.id, link: meta.link || null, time_iso: timeISO, time_local: toTZISO(timeISO, TZ), age_hours: age });
    if (eur) candEUR.push({ ...eur, id: meta.id, link: meta.link || null, time_iso: timeISO, time_local: toTZISO(timeISO, TZ), age_hours: age });
  }

  const maybeUpdateByGap = (oldPick, cands) => {
    if (!cands.length) return oldPick;
    cands.sort((a, b) => b.id - a.id);
    const newest = cands[0];
    if (!oldPick) return newest;
    const gap = minutesBetween(new Date(newest.time_iso || now), new Date(oldPick.time_iso || now));
    return gap >= MIN_GAP_MINUTES_FOR_DOUBLECHECK ? newest : oldPick;
  };

  usdPick = maybeUpdateByGap(usdPick, candUSD);
  eurPick = maybeUpdateByGap(eurPick, candEUR);

  // TTL for today
  if (usdPick && typeof usdPick.age_hours === "number" && usdPick.age_hours > TTL_USD_HOURS) usdPick = null;
  if (eurPick && typeof eurPick.age_hours === "number" && eurPick.age_hours > TTL_USD_HOURS) eurPick = null;

  return {
    usdPick, eurPick,
    usdFoundToday: Boolean(usdPick),
    eurFoundToday: Boolean(eurPick),
    nextBefore: before,
  };
}

async function scanSuliLast(startBefore) {
  let before = startBefore || null, pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(CH.Dollar_Sulaymaniyah.URL, before);
    if (!blocks.length) break;
    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      const norm = normalizeFa(text);
      if (!norm.includes(normalizeFa(CH.Dollar_Sulaymaniyah.NEEDLE))) continue;
      if (hasAny(text, CH.Dollar_Sulaymaniyah.EXCLUDE)) continue;

      const { usd, eur } = extractCurrenciesFromSuli(text);
      const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
      const age = dtISO ? minutesBetween(new Date(), new Date(dtISO)) / 60 : null;

      if (usd || eur) {
        return {
          usdLast: usd ? { ...usd, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, time_local: dtISO ? toTZISO(dtISO, TZ) : null, age_hours: age } : null,
          eurLast: eur ? { ...eur, id: meta.id ?? 0, link: meta.link || null, time_iso: dtISO, time_local: dtISO ? toTZISO(dtISO, TZ) : null, age_hours: age } : null,
        };
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { usdLast: null, eurLast: null };
}

// =======================================
// SECTION 5/5 — Tether Today (Aban lag 10m + Others no lag)
// =======================================

const ABAN_LAG_MINUTES = 10;
const ABAN_LAG_HOURS   = ABAN_LAG_MINUTES / 60;
const ABAN_MAX_PAGES_FOR_LAG = 12;   // ~تا 240 پست

async function scanTetherToday(chan) {
  const now = new Date();
  const todayKey = dateKeyInTZ(now);

  const isAban = /\/AbanTetherPrice(?:\/|$|\?)/i.test(chan.URL);
  if (!isAban) {
    return await scanTetherToday_Fallback(chan);
  }

  let before = null;
  let pages = 0;
  const candidates = [];

  while (pages < ABAN_MAX_PAGES_FOR_LAG) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;

    let pageMinId = Infinity;
    let sawAny = false;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta?.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      if (!hasAny(text, CH.AbanTetherPrice.INCLUDE) || hasAny(text, CH.AbanTetherPrice.EXCLUDE)) continue;

      const { ok, timeISO } = isBlockToday(meta, todayKey);
      if (!ok) continue;

      const val = extractTether(text);
      if (!val) continue;

      sawAny = true;

      const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;
      candidates.push({
        ...val,
        id: meta.id ?? 0,
        link: meta.link || null,
        time_iso: timeISO || null,
        time_local: timeISO ? toTZISO(timeISO, TZ) : null,
        age_hours: age,
      });
    }

    pages += 1;
    if (!sawAny) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  // فیلتر: ≥ 10 دقیقه
  const aged = candidates.filter(c => typeof c.age_hours === "number" && c.age_hours >= ABAN_LAG_HOURS);

  let pick = null;
  if (aged.length) {
    aged.sort((a, b) => (a.age_hours - b.age_hours) || (b.id - a.id));
    pick = aged[0];
  } else {
    pick = null;
  }

  // TTL USDT
  if (pick && typeof pick.age_hours === "number" && pick.age_hours > TTL_USDT_HOURS) {
    pick = null;
  }

  return { pick, foundToday: Boolean(pick), nextBefore: before };
}

async function scanTetherToday_Fallback(chan) {
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
      if (meta?.id) pageMinId = Math.min(pageMinId, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      if (!hasAny(text, chan.INCLUDE) || hasAny(text, chan.EXCLUDE)) continue;

      const { ok, timeISO } = isBlockToday(meta, todayKey);
      if (!ok) continue;

      sawAnyToday = true;

      const val = extractTether(text);
      if (val) {
        const age = timeISO ? minutesBetween(now, new Date(timeISO)) / 60 : null;
        picks.push({ ...val, id: meta.id ?? 0, link: meta.link || null, time_iso: timeISO, time_local: toTZISO(timeISO, TZ), age_hours: age });
      }
    }

    pages += 1;
    if (!sawAnyToday) break;
    if (Number.isFinite(pageMinId)) before = pageMinId; else break;
  }

  let pick = null;
  if (picks.length) {
    picks.sort((a, b) => {
      const ta = a?.time_iso ? new Date(a.time_iso).getTime() : 0;
      const tb = b?.time_iso ? new Date(b.time_iso).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return (b?.id || 0) - (a?.id || 0);
    });
    pick = picks[0];
  }

  // TTL USDT
  if (pick && typeof pick.age_hours === "number" && pick.age_hours > TTL_USDT_HOURS) {
    pick = null;
  }

  return { pick, foundToday: Boolean(pick), nextBefore: before };
}

// =======================================
// SECTION 5/6 — Tether Last & Tehran wrapper
// =======================================

async function scanTetherLast(chan, startBefore) {
  let before = startBefore || null, pages = 0;

  while (pages < MAX_PAGES_HISTORY) {
    const blocks = await fetchPage(chan.URL, before);
    if (!blocks.length) break;
    let nextBefore = Infinity;

    for (const block of blocks) {
      const meta = extractMessageMeta(block);
      if (meta.id) nextBefore = Math.min(nextBefore, meta.id);

      const text = extractMessageText(block);
      if (!text) continue;

      if (!hasAny(text, chan.INCLUDE) || hasAny(text, chan.EXCLUDE)) continue;

      const val = extractTether(text);
      if (val) {
        const dtISO = meta.datetimeISO ? new Date(meta.datetimeISO).toISOString() : null;
        const age = dtISO ? minutesBetween(new Date(), new Date(dtISO)) / 60 : null;
        const tloc = dtISO ? toTZISO(dtISO, TZ) : null;
        return {
          last: {
            ...val,
            id: meta.id ?? 0,
            link: meta.link || null,
            time_iso: dtISO,
            time_local: tloc,
            age_hours: age
          }
        };
      }
    }

    pages += 1;
    if (Number.isFinite(nextBefore)) before = nextBefore; else break;
  }
  return { last: null };
}

// Tehran3bze: today + last با parser اختصاصی (buy/sell/mid)
async function scanTehranTodayAndLast() {
  const resToday = await scanCashTodayGeneric(CH.Dollar_Tehran3bze, extractTehranCash);
  const resLast  = await scanTehranLast(resToday.nextBefore); // ← هم‌اسکیما با today
  return {
    pick: resToday.pick,            // { buy, sell, mid, ... }
    foundToday: resToday.foundToday,
    last: resLast.last              // { buy, sell, mid, ... }
  };
}

// ===================================
// SECTION 6 — Bon-Bast (Homepage)
// ===================================
async function scanBonbast() {
  const URL = CH.Bonbast.URL;
  const html = await fetchTextWithRetry(URL);
  const text = htmlToText(html);

  // as_of
  let as_of_text = null;
  const mAsOf = text.match(/Iranian Rial Exchange Rates\.\s*([^\n]+?)\s*All prices/i);
  if (mAsOf) as_of_text = mAsOf[1].trim();

  // تلاشی برای تشخیص "Last Update ..." اگر فرمت as_of_text قابل‌پارز نبود
  let alt_ts = null;
  const mUpd = text.match(/Last\s*Update[^A-Za-z0-9]*([A-Za-z]+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2})/i);
  if (mUpd) alt_ts = mUpd[1];

  // USD/EUR rows (Sell / Buy)
  function pickRow(code, name) {
    const re = new RegExp(
      String.raw`${code}\s+${name}\s+([0-9][\d,\s]*)\s+([0-9][\d,\s]*)`,
      "i"
    );
    const m = text.match(re);
    if (!m) return null;
    const sell = Number((m[1] || "").replace(/[^\d]/g, ""));
    const buy  = Number((m[2] || "").replace(/[^\d]/g, ""));
    if (!sell && !buy) return null;
    return { sell: sell || null, buy: buy || null, unit: "تومان" };
  }

  const usd = pickRow("USD", "US\\s+Dollar");
  const eur = pickRow("EUR", "Euro");

  // TTL: اگر زمان صفحه قدیمی‌تر از حد مجاز بود، خروجی Bonbast را خالی کن
  let usdOut = usd || null;
  let eurOut = eur || null;

  const tryParseDate = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };

  // اولویت با as_of_text؛ اگر نشد، از Last Update کمکی استفاده کن
  let asOfDate = tryParseDate(as_of_text) || tryParseDate(alt_ts);
  if (asOfDate) {
    const ageH = (Date.now() - asOfDate.getTime()) / 3600000;
    if (ageH > TTL_BONBAST_HOURS) {
      usdOut = null;
      eurOut = null;
    }
  }

  return {
    source_bonbast: URL,
    bonbast: { as_of_text, usd: usdOut, eur: eurOut },
  };
}

// ===================================
// SECTION 7 — Main & Output
// ===================================
async function main() {
  // — Herat (امروز + last) — از parser عمومی
  const heratToday = await scanCashTodayGeneric(CH.Herat_Tomen, (t) => extractCashValue(t, CH.Herat_Tomen.INCLUDE, CH.Herat_Tomen.EXCLUDE));
  const heratLast  = await scanCashLast(CH.Herat_Tomen, heratToday.nextBefore);
  // تشخیص future-only: اگر امروز «پست هست ولی نقدی معتبر نیست» سخت است؛ ساده: اگر today.pick == null و nextBefore !== null
  const herat_future_only = (!heratToday.foundToday && heratToday.nextBefore !== null);

  // — Tehran (امروز + last) — با parser اختصاصی خرید/فروش/mid
  const tehran = await scanTehranTodayAndLast();

  // — Sulaymaniyah (USD/EUR امروز + last)
  const suliToday = await scanSuliToday();
  const suliLast  = await scanSuliLast(suliToday.nextBefore);

  // — Tether channels
  const abanToday  = await scanTetherToday(CH.AbanTetherPrice);
  const abanLast   = await scanTetherLast(CH.AbanTetherPrice, abanToday.nextBefore);
  const tlandToday = await scanTetherToday(CH.TetherLand);
  const tlandLast  = await scanTetherLast(CH.TetherLand, tlandToday.nextBefore);

  // — Bon-bast
  const bonbast = await scanBonbast();

  const payload = {
    status: "ok",
    scraped_at: new Date().toISOString(),

    // Herat
    source_herat: CH.Herat_Tomen.URL,
    usd_herat_cash: heratToday.pick || null,
    herat_found_today: heratToday.foundToday,
    herat_future_only,
    herat_last_cash: heratLast.last || null,

    // Tehran3bze
    source_tehran3bze: CH.Dollar_Tehran3bze.URL,
    usd_tehran_cash: tehran.pick || null,    // شامل buy/sell/mid
    tehran_found_today: tehran.foundToday,
    tehran_last_cash: tehran.last || null,

    // Sulaymaniyah
    source_sulaymaniyah: CH.Dollar_Sulaymaniyah.URL,
    needle: CH.Dollar_Sulaymaniyah.NEEDLE,
    usd_floor_mashhad: suliToday.usdPick || null,
    eur_floor_mashhad: suliToday.eurPick || null,
    usd_found_today: suliToday.usdFoundToday,
    eur_found_today: suliToday.eurFoundToday,
    usd_floor_mashhad_last: suliLast.usdLast || null,
    eur_floor_mashhad_last: suliLast.eurLast || null,

    // USDT
    source_aban: CH.AbanTetherPrice.URL,
    usdt_aban: abanToday.pick || null,
    aban_found_today: abanToday.foundToday,
    usdt_aban_last: abanLast.last || null,

    source_tetherland: CH.TetherLand.URL,
    usdt_tetherland: tlandToday.pick || null,
    tetherland_found_today: tlandToday.foundToday,
    usdt_tetherland_last: tlandLast.last || null,

    // Bon-bast
    ...bonbast,
  };

  ensureDir(OUTDIR);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  // فقط «امروز»‌ها را در GITHUB_OUTPUT بگذاریم (last ها برای نمایش‌اند)
  if (process.env.GITHUB_OUTPUT) {
    const L = [];

    // Herat
    L.push(`herat_found_today=${payload.herat_found_today}`);
    L.push(`herat_future_only=${payload.herat_future_only}`);
    if (payload.usd_herat_cash?.value) {
      L.push(`herat_usd=${payload.usd_herat_cash.value}`);
      if (payload.usd_herat_cash.id) L.push(`herat_msg=${payload.usd_herat_cash.id}`);
    }

    // Tehran
    L.push(`tehran_found_today=${payload.tehran_found_today}`);
    if (payload.usd_tehran_cash?.mid) {
      L.push(`tehran_mid=${payload.usd_tehran_cash.mid}`);
      if (payload.usd_tehran_cash.id) L.push(`tehran_msg=${payload.usd_tehran_cash.id}`);
    }

    // Sulaymaniyah
    L.push(`usd_found_today=${payload.usd_found_today}`);
    if (payload.usd_floor_mashhad?.value) {
      L.push(`usd=${payload.usd_floor_mashhad.value}`);
      if (payload.usd_floor_mashhad.id) L.push(`usd_msg=${payload.usd_floor_mashhad.id}`);
    }
    L.push(`eur_found_today=${payload.eur_found_today}`);
    if (payload.eur_floor_mashhad?.value) {
      L.push(`eur=${payload.eur_floor_mashhad.value}`);
      if (payload.eur_floor_mashhad.id) L.push(`eur_msg=${payload.eur_floor_mashhad.id}`);
    }

    // USDT
    L.push(`aban_found_today=${payload.aban_found_today}`);
    if (payload.usdt_aban?.mid)  L.push(`aban_mid=${payload.usdt_aban.mid}`);
    if (payload.usdt_aban?.sell) L.push(`aban_sell=${payload.usdt_aban.sell}`);
    if (payload.usdt_aban?.buy)  L.push(`aban_buy=${payload.usdt_aban.buy}`);

    L.push(`tetherland_found_today=${payload.tetherland_found_today}`);
    if (payload.usdt_tetherland?.mid)  L.push(`tetherland_mid=${payload.usdt_tetherland.mid}`);
    if (payload.usdt_tetherland?.sell) L.push(`tetherland_sell=${payload.usdt_tetherland.sell}`);
    if (payload.usdt_tetherland?.buy)  L.push(`tetherland_buy=${payload.usdt_tetherland.buy}`);

    // Bon-bast (اطلاع)
    if (payload?.bonbast?.usd?.sell) L.push(`bonbast_usd_sell=${payload.bonbast.usd.sell}`);
    if (payload?.bonbast?.usd?.buy)  L.push(`bonbast_usd_buy=${payload.bonbast.usd.buy}`);
    if (payload?.bonbast?.eur?.sell) L.push(`bonbast_eur_sell=${payload.bonbast.eur.sell}`);
    if (payload?.bonbast?.eur?.buy)  L.push(`bonbast_eur_buy=${payload.bonbast.eur.buy}`);

    fs.appendFileSync(process.env.GITHUB_OUTPUT, L.join("\n") + "\n");
  }
}

main().catch(err => { console.error("ERROR:", err); process.exit(1); });
