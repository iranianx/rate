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

  const payload = latest
    ? {
        status: "ok",
        found: true,
        ...latest,
        scraped_at: new Date().toISOString(),
        source: URL,
        needle: NEEDLE,
      }
    : {
        status: "ok",
        found: false,
        message: `No message containing "${NEEDLE}" was found on first page.`,
        scraped_at: new Date().toISOString(),
        source: URL,
        needle: NEEDLE,
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
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
