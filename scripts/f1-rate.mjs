// rate/scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "rate/data";
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

// تبدیل اعداد فارسی به لاتین
function faToEnDigits(str) {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  return str.replace(/[۰-۹]/g, d => String(fa.indexOf(d)));
}

// استخراج اولین عدد صحیح از یک رشته
function pickInteger(s) {
  if (!s) return null;
  const t = faToEnDigits(s);
  const m = t.match(/([0-9][0-9.,\s]*)/);
  if (!m) return null;
  // حذف جداکننده‌ها و هرچیز غیر عدد
  const clean = m[1].replace(/[^\d]/g, "");
  if (!clean) return null;
  return Number(clean);
}

function extractCurrencies(text) {
  // کل پیام را خط‌به‌خط می‌خوانیم و به دنبال خطوط حاوی «دلار» و «یورو» می‌گردیم
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  // کلیدواژه‌ها
  const isUSD = (l) =>
    /(\bUSD\b|\$|دلار(?! استرالیا| کانادا)|دلار امریکا|دلار آمریکا)/i.test(l);
  const isEUR = (l) => /(\bEUR\b|€|یورو)/i.test(l);

  let usd = null;
  let eur = null;

  for (const line of lines) {
    // فقط خطوط مرتبط با «کف مشهد» یا همان پیام را بررسی می‌کنیم
    if (!usd && isUSD(line)) {
      const val = pickInteger(line);
      if (val) usd = { value: val, unit: "تومان", raw_line: line };
    }
    if (!eur && isEUR(line)) {
      const val = pickInteger(line);
      if (val) eur = { value: val, unit: "تومان", raw_line: line };
    }
    if (usd && eur) break;
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

  let latest = null;

  for (const block of blocks) {
    const text = extractMessageText(block);
    if (!text) continue;
    if (text.includes(NEEDLE)) {
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
        // متن کامل برای دیباگ باقی می‌ماند
        text,
        // خروجی‌های هدف
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
      // در صورت نیاز، متن کامل برای دیباگ:
      // lines.push(`text<<EOF\n${payload.text}\nEOF`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
