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

// نرمال‌سازی فارسی/عربی: ی/ي، ک/ك، حذف اعراب/کِشیده/ZWNJ
function normalizeFa(s) {
  if (!s) return s;
  return s
    .replace(/\u200c/g, " ")          // ZWNJ → فاصله
    .replace(/\u0640/g, "")           // کشیده
    .replace(/[\u064B-\u0652]/g, "")  // اعراب
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
    "٫":".","٬":","
  };
  return str.replace(/[۰-۹٠-٩٫٬]/g, ch => map[ch] ?? ch);
}

// استخراج اولین عدد صحیح از یک رشته
function pickInteger(s) {
  if (!s) return null;
  const t = faToEnDigits(s);
  const m = t.match(/([0-9][0-9.,\s]*)/);
  if (!m) return null;
  const clean = m[1].replace(/[^\d]/g, "");
  if (!clean) return null;
  return Number(clean);
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
  if (m) {
    link = m[1].startsWith("http") ? m[1] : `https://t.me${m[1]}`;
    const title = m[0].match(/title="([^"]+)"/);
    dateText = title ? title[1] : htmlToText(m[2] || "");
  }
  return { link, dateText };
}

// ————— Currency extraction —————
function extractCurrencies(fullText) {
  // متن اصلی را نگه می‌داریم، ولی روی نسخه نرمال‌شده تحلیل می‌کنیم
  const normText = normalizeFa(fullText);

  // 1) اگر خود «کف مشهد <عدد>» آمده باشد، همان را به‌عنوان دلار در نظر بگیر
  //   (کانال معمولاً کف مشهد را برای دلار می‌نویسد)
  let usd = null;
  const usdFromFloor = (() => {
    const t = faToEnDigits(normText);
    const m = t.match(/کف\s*مشهد[^0-9]*([0-9][0-9.,\s]*)/i);
    if (!m) return null;
    const val = pickInteger(m[1]);
    if (!val) return null;
    return { value: val, unit: "تومان", raw_line: fullText };
  })();
  if (usdFromFloor) usd = usdFromFloor;

  // 2) اگر خطوط «یورو» جداگانه داشت، استخراج کن
  const lines = normText.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const isUSD = (l) =>
    /(\bUSD\b|\$|دلار(?!\s*(استرالیا|کانادا))|دلار\s*امریکا|دلار\s*آمریکا)/i.test(l);
  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);

  let eur = null;

  for (const line of lines) {
    if (!eur && isEUR(line)) {
      const val = pickInteger(line);
      if (val) eur = { value: val, unit: "تومان", raw_line: line };
    }
    // اگر پیام شکل «یورو کف مشهد 99xxx» داشت
    if (!eur) {
      const t = faToEnDigits(line);
      const m = t.match(/یورو[^0-9]*([0-9][0-9.,\s]*)/i);
      if (m) {
        const val = pickInteger(m[1]);
        if (val) eur = { value: val, unit: "تومان", raw_line: line };
      }
    }
    if (usd && eur) break;
  }

  // 3) اگر پیام برای دلار هم خطی با «دلار …» داشت و قبلاً از کف نگرفتیم، از آن استفاده کن
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
  let latest = null;

  for (const block of blocks) {
    const text = extractMessageText(block);
    if (!text) continue;

    const textNorm = normalizeFa(text);
    if (textNorm.includes(needleNorm)) {
      const meta = extractMessageMeta(block);
      const { usd, eur } = extractCurrencies(text);

      latest = {
        status: "ok",
        found: true,
        source: URL,
        needle: NEEDLE,
        link: meta.link || null,
        date_text: meta.dateText || null,
        scraped_at: new Date().toISOString(),
        text, // متن خام برای دیباگ
        usd_floor_mashhad: usd || null,
        eur_floor_mashhad: eur || null,
      };
      break; // جدید به قدیم است، اولین تطبیق کافی است
    }
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
        lines.push(`eur=${payload.eur_floor_mashhad.value}`);
      lines.push(`link=${payload.link || ""}`);
      lines.push(`date_text=${payload.date_text || ""}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
