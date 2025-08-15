// scripts/fetch-sulaymaniyah.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "data/sources";
const OUTFILE = path.join(OUTDIR, "sulaymaniyah_latest.json");

function htmlToText(html) {
  // حذف تگ‌ها و تبدیل <br> به \n
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

function extractBlocks(html) {
  // هر پیام در div با کلاس tgme_widget_message_wrap شروع می‌شود
  const parts = html.split('<div class="tgme_widget_message_wrap');
  // اولین part قبل از اولین پیام است، بقیه پیام‌ها هستند
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}

function extractMessageText(block) {
  // متن داخل div با کلاس tgme_widget_message_text
  const m = block.match(
    /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  if (!m) return null;
  return htmlToText(m[1]);
}

function extractMessageMeta(block) {
  // لینک و تاریخ از anchor با کلاس tgme_widget_message_date
  const m = block.match(
    /<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  );
  let link = null;
  let dateText = null;
  if (m) {
    link = m[1].startsWith("http") ? m[1] : `https://t.me${m[1]}`;
    // تاریخ معمولاً در title یا متن داخلی هست
    const title = m[0].match(/title="([^"]+)"/);
    if (title) {
      dateText = title[1];
    } else {
      dateText = htmlToText(m[2] || "");
    }
  }
  return { link, dateText };
}

// --- افزوده‌ها برای استخراج ارزها ---

// تبدیل ارقام فارسی/عربی به لاتین
function normalizeDigits(s) {
  const map = { "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
                "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  return s.replace(/[۰-۹٠-٩]/g, d => map[d] || d);
}

// حذف جداکننده‌ها از بخش اعداد
function sanitizeNumbers(s) {
  let t = normalizeDigits(s);
  t = t.replace(/[,\u066C\u066B\u060C]/g, ""); // کاماهای فارسی/عربی
  t = t.replace(/\./g, "");                     // نقطه هزارگان
  return t;
}

// خروجی: usd_raw, usd_high, usd_low, eur_raw, eur_high, eur_low
function parseCurrencies(text) {
  const t = sanitizeNumbers(text);
  const rxPair = /([0-9]{4,7})\s*[_\/\-]\s*([0-9]{4,7})/; // مثل 105300_104900
  const labels = [
    { key: "usd", rx: /(دلار|USD|\$)/i },
    { key: "eur", rx: /(یورو|EUR|€)/i },
  ];
  const out = {
    usd_raw: null, usd_high: null, usd_low: null,
    eur_raw: null, eur_high: null, eur_low: null,
  };

  const lines = t.split(/\n+/);

  // حالت هم‌خط: «دلار ... 123000_122500»
  for (const line of lines) {
    for (const { key, rx } of labels) {
      if (rx.test(line)) {
        const m = line.match(rxPair);
        if (m) {
          const [, a, b] = m;
          const n1 = Number(a), n2 = Number(b);
          out[`${key}_raw`]  = `${a}_${b}`;
          out[`${key}_high`] = Math.max(n1, n2);
          out[`${key}_low`]  = Math.min(n1, n2);
        }
      }
    }
  }

  // حالت دو خطی: «دلار» در یک خط، «123000_122500» در خط بعد
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const N = lines[i + 1] || "";
    const mNext = N.match(rxPair);
    if (mNext) {
      for (const { key, rx } of labels) {
        if (!out[`${key}_raw`] && rx.test(L)) {
          const [, a, b] = mNext;
          const n1 = Number(a), n2 = Number(b);
          out[`${key}_raw`]  = `${a}_${b}`;
          out[`${key}_high`] = Math.max(n1, n2);
          out[`${key}_low`]  = Math.min(n1, n2);
        }
      }
    }
  }

  return out;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const res = await fetch(URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();

  const blocks = extractBlocks(html);
  let latest = null;

  for (const block of blocks) {
    const text = extractMessageText(block);
    if (!text) continue;
    if (text.includes(NEEDLE)) {
      const meta = extractMessageMeta(block);
      latest = {
        text,
        link: meta.link,
        date_text: meta.dateText,
      };
      // چون HTML از جدید به قدیم لیست می‌شود، اولین تطبیق را برمی‌داریم
      break;
    }
  }

  ensureDir(OUTDIR);

  // پایه payload همان قبلی است، فقط فیلدهای ارز را هم اضافه می‌کنیم
  const currency = latest ? parseCurrencies(latest.text) : {
    usd_raw: null, usd_high: null, usd_low: null,
    eur_raw: null, eur_high: null, eur_low: null,
  };

  const payload = latest
    ? {
        status: "ok",
        found: true,
        ...latest,
        scraped_at: new Date().toISOString(),
        source: URL,
        needle: NEEDLE,
        ...currency,
      }
    : {
        status: "ok",
        found: false,
        message: `No message containing "${NEEDLE}" was found on first page.`,
        scraped_at: new Date().toISOString(),
        source: URL,
        needle: NEEDLE,
        ...currency,
      };

  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(payload);

  // اگر در GitHub Actions هستیم، نتیجه را در خروجی مرحله قرار بدهیم
  if (process.env.GITHUB_OUTPUT) {
    const lines = [];
    lines.push(`found=${payload.found}`);
    if (payload.found) {
      lines.push(`text<<EOF\n${payload.text}\nEOF`);
      lines.push(`link=${payload.link || ""}`);
      lines.push(`date_text=${payload.date_text || ""}`);
      lines.push(`usd_raw=${payload.usd_raw ?? ""}`);
      lines.push(`usd_high=${payload.usd_high ?? ""}`);
      lines.push(`usd_low=${pay_
