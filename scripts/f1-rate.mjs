// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "data";
const OUTFILE = path.join(OUTDIR, "f1-rate.json");

// ————— Utilities —————
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

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

// نرمال‌سازی فارسی/عربی: ی/ي، ک/ك، تبدیل اعراب به فاصله، حذف کشیده و ZWNJ
function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")          // ZWNJ → فاصله
    .replace(/\u0640/g, "")           // کشیده
    .replace(/[\u064B-\u0652]/g, " ") // همه اعراب → فاصله (نه حذف)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
}

// تبدیل همه گونه ارقام فارسی/عربی به لاتین + نرمال‌سازی جداکننده‌ها
function faToEnDigits(str) {
  if (!str) return str;
  const map = {
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "٫":".","٬":",","،":","
  };
  return str.replace(/[۰-۹٠-٩٫٬،]/g, ch => map[ch] ?? ch);
}

// همه اعداد موجود در رشته (به ترتیب ظهور)
function pickIntegersAll(s) {
  if (!s) return [];
  const t = faToEnDigits(s);
  const list = [];
  const re = /([0-9][0-9.,\s]*)/g;
  let m;
  while ((m = re.exec(t))) {
    const clean = m[1].replace(/[^\d]/g, "");
    if (clean) list.push(Number(clean));
  }
  return list;
}

// اولین عدد صحیح
function pickInteger(s) {
  const arr = pickIntegersAll(s);
  return arr.length ? arr[0] : null;
}

function extractBlocks(html) {
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}

function extractMessageText(block) {
  const m = block.match(
    /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  if (!m) return null;
  return htmlToText(m[1]);
}

function extractMessageMeta(block) {
  const m = block.match(
    /<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  );
  let link = null;
  let dateText = null;
  let id = null;
  if (m) {
    link = m[1].startsWith("http") ? m[1] : `https://t.me${m[1]}`;
    const title = m[0].match(/title="([^"]+)"/);
    dateText = title ? title[1] : htmlToText(m[2] || "");
    // ID عددی پیام از انتهای لینک
    const idm = link.match(/\/(\d+)(?:\?.*)?$/);
    if (idm) id = Number(idm[1]);
  }
  return { link, dateText, id };
}

// ————— Currency extraction —————
function extractCurrenciesFromText(fullText) {
  const normText = normalizeFa(fullText);
  const lines = normText.split(/\n+/).map(l => l.trim()).filter(Boolean);

  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);
  const isUSD = (l) =>
    /(\bUSD\b|\$|دلار(?!\s*(استرالیا|کانادا))|دلار\s*امریکا|دلار\s*آمریکا)/i.test(l);

  let usd = null;
  let eur = null;

  // اول: خطی که «کف مشهد» دارد را پیدا کن
  const floorLine = lines.find(l => l.includes("کف مشهد"));
  if (floorLine) {
    // اگر همین خط «یورو» داشت، آن را یورو حساب کن، وگرنه دلار
    const isEuroLine = isEUR(floorLine);
    const nums = pickIntegersAll(floorLine);
    if (isEuroLine && nums.length) {
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      eur = { value: min, min, max, unit: "تومان", raw_line: floorLine };
    } else {
      const val = nums.length ? nums[0] : null;
      if (val) usd = { value: val, unit: "تومان", raw_line: floorLine };
    }
  }

  // سپس، اگر یورو هنوز خالی بود، به‌دنبال خطوط دارای «یورو» بگرد
  if (!eur) {
    for (const line of lines) {
      if (isEUR(line)) {
        const nums = pickIntegersAll(line);
        if (nums.length) {
          const min = Math.min(...nums);
          const max = Math.max(...nums);
          eur = { value: min, min, max, unit: "تومان", raw_line: line };
          break;
        }
      }
    }
  }

  // اگر دلار هنوز خالی بود، خطوط دارای «دلار» را بررسی کن
  if (!usd) {
    for (const line of lines) {
      if (isUSD(line)) {
        const val = pickInteger(line);
        if (val) {
          usd = { value: val, unit: "تومان", raw_line: line };
          break;
        }
      }
    }
  }

  return { usd, eur };
}

// ————— Main —————
async function main() {
  const res = await fetch(URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();
  const blocks = extractBlocks(html);

  const needleNorm = normalizeFa(NEEDLE);
  const candidates = [];

  for (const block of blocks) {
    const text = extractMessageText(block);
    if (!text) continue;
    const meta = extractMessageMeta(block);
    const textNorm = normalizeFa(text);
    if (textNorm.includes(needleNorm)) {
      // جمع کردن همهٔ تطبیق‌ها
      const { usd, eur } = extractCurrenciesFromText(text);
      candidates.push({
        id: meta.id ?? 0,
        link: meta.link || null,
        date_text: meta.dateText || null,
        text,
        usd,
        eur,
      });
    }
  }

  // انتخاب «جدیدترین» بر اساس بالاترین ID
  let latest = null;
  if (candidates.length) {
    candidates.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    const top = candidates[0];
    latest = {
      status: "ok",
      found: true,
      source: URL,
      needle: NEEDLE,
      link: top.link,
      date_text: top.date_text,
      scraped_at: new Date().toISOString(),
      text: top.text,
      usd_floor_mashhad: top.usd || null,
      eur_floor_mashhad: top.eur || null,
      message_id: top.id || null
    };
  }

  const payload =
    latest ||
    {
      status: "ok",
      found: false,
      message: `No message containing "${NEEDLE}" was found on first page.`,
      source: URL,
      needle: NEEDLE,
      scraped_at: new Date().toISOString(),
    };

  ensureDir(OUTDIR);
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const lines = [];
    lines.push(`found=${payload.found}`);
    if (payload.found) {
      if (payload.usd_floor_mashhad?.value)
        lines.push(`usd=${payload.usd_floor_mashhad.value}`);
      if (payload.eur_floor_mashhad?.value)
        lines.push(`eur=${payload.er_floor_mashhad.value}`);
      lines.push(`link=${payload.link || ""}`);
      lines.push(`date_text=${payload.date_text || ""}`);
      if (payload.message_id) lines.push(`message_id=${payload.message_id}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
