// scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const OUTDIR = "rate/data";
const OUTFILE = path.join(OUTDIR, "f1-exit.json");

// --- utils (همان سبک نسخه‌ی قبلی که جواب می‌داد) ---
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
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// --- فقط افزودنِ استخراج دلار/یورو ---
function normalizeDigits(s) {
  const map = { "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
                "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
  return s.replace(/[۰-۹٠-٩]/g, d => map[d] || d);
}
function sanitizeNumbersArea(s) {
  let t = normalizeDigits(s);
  t = t.replace(/[,\u066C\u066B\u060C]/g, ""); // ، و جداکننده‌های عربی
  t = t.replace(/\./g, "");                     // نقطه به‌عنوان هزارگان
  return t;
}
function parseCurrencies(text) {
  const t = sanitizeNumbersArea(text);
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

  // حالت هم‌خط
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
  // حالت ارز در یک خط و اعداد در خط بعد
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const N = lines[i + 1] || "";
    const m = N.match(rxPair);
    if (m) {
      for (const { key, rx } of labels) {
        if (!out[`${key}_raw`] && rx.test(L)) {
          const [, a, b] = m;
          const n1 = Number(a), n2 = Number(b);
          out[`${key}_raw`]  = `${a}_${b}`;
          out[`${key}_high`] = Math.max(n1, n2);
          out[`${]()
