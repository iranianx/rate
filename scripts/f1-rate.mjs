// rate/scripts/f1-rate.mjs
import fs from "fs";
import path from "path";

const URL = "https://t.me/s/dollar_sulaymaniyah";
const NEEDLE = "کف مشهد";
const EXCLUDE = [/فردا/g, /فردایی/g, /آتی/g];
const OUTDIR = "rate/data";
const OUTFILE = path.join(OUTDIR, "f1-exit.json");

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function writeExitJson(obj) {
  try { ensureDir(OUTDIR); fs.writeFileSync(OUTFILE, JSON.stringify(obj, null, 2), "utf8"); }
  catch (e) { console.error("FATAL: cannot write exit json:", e); }
}

function normalizeDigits(s) {
  const map = {"۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9","٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9"};
  return s.replace(/[۰-۹٠-٩]/g, d => map[d] || d);
}
function htmlToText(html) {
  return html.replace(/<\s*br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n")
    .replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+\n/g,"\n").trim();
}
function extractBlocks(html) {
  const parts = html.split('<div class="tgme_widget_message_wrap');
  return parts.slice(1).map(b => '<div class="tgme_widget_message_wrap' + b);
}
function extractMessageText(block) {
  const m = block.match(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? htmlToText(m[1]) : null;
}
function extractMessageMeta(block) {
  const m = block.match(/<a[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  let link = null, dateText = null;
  if (m) {
    link = m[1].startsWith("http") ? m[1] : `https://t.me${m[1]}`;
    const title = m[0].match(/title="([^"]+)"/);
    dateText = title ? title[1] : htmlToText(m[2] || "");
  }
  return { link, dateText };
}
function sanitizeNumbersArea(s) {
  let t = normalizeDigits(s);
  t = t.replace(/[,\u066C\u066B\u060C]/g,"").replace(/\./g,"");
  return t;
}
function parseCurrencies(text) {
  const t = sanitizeNumbersArea(text);
  const rxPair = /([0-9]{4,7})\s*[_\/\-]\s*([0-9]{4,7})/;
  const labels = [
    { key: "usd", rx: /(دلار|USD|\$)/i },
    { key: "eur", rx: /(یورو|EUR|€)/i },
  ];
  const out = { usd_raw:null, usd_high:null, usd_low:null, eur_raw:null, eur_high:null, eur_low:null };
  const lines = t.split(/\n+/);
  for (const line of lines) {
    for (const { key, rx } of labels) {
      if (rx.test(line)) {
        const m = line.match(rxPair);
        if (m) {
          const [ , a, b ] = m; const n1=+a, n2=+b;
          out[`${key}_raw`] = `${a}_${b}`;
          out[`${key}_high`] = Math.max(n1,n2);
          out[`${key}_low`]  = Math.min(n1,n2);
        }
      }
    }
  }
  for (let i=0;i<lines.length;i++){
    const L=lines[i], N=lines[i+1]||""; const mN=N.match(rxPair);
    if (mN){ for (const {key,rx} of labels){
      if (!out[`${key}_raw`] && rx.test(L)){
        const [,a,b]=mN; const n1=+a, n2=+b;
        out[`${key}_raw`]=`${a}_${b}`; out[`${key}_high`]=Math.max(n1,n2); out[`${key}_low`]=Math.min(n1,n2);
      }
    }}
  }
  return out;
}

async function run() {
  // درخواست با هِدر کامل و timeout
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(URL, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "fa-IR,fa;q=0.9,en;q=0.8",
      },
    });
  } finally { clearTimeout(t); }

  if (!res || !res.ok) {
    const payload = {
      status: "error",
      found: false,
      error: `HTTP ${res ? res.status : 'NO_RESPONSE'}`,
      scraped_at: new Date().toISOString(),
      source: URL,
      needle: NEEDLE,
      usd_raw:null, usd_high:null, usd_low:null,
      eur_raw:null, eur_high:null, eur_low:null,
    };
    writeExitJson(payload);
    console.error(payload);
    return;
  }

  const html = await res.text();
  const blocks = extractBlocks(html);
  let latest = null;

  for (const block of blocks) {
    const text = extractMessageText(block);
    if (!text) continue;
    if (!text.includes(NEEDLE)) continue;
    if (EXCLUDE.some(rx => rx.test(text))) continue;
    const meta = extractMessageMeta(block);
    latest = { text, link: meta.link, date_text: meta.dateText };
    break;
  }

  if (!latest) {
    const payload = {
      status: "ok",
      found: false,
      message: `No message containing "${NEEDLE}" on first page (non-future).`,
      scraped_at: new Date().toISOString(),
      source: URL, needle: NEEDLE,
      usd_raw:null, usd_high:null, usd_low:null,
      eur_raw:null, eur_high:null, eur_low:null,
    };
    writeExitJson(payload);
    console.log(payload);
    return;
  }

  const cur = parseCurrencies(latest.text);
  const payload = {
    status: "ok",
    found: true,
    text: latest.text,
    link: latest.link,
    date_text: latest.date_text || null,
    scraped_at: new Date().toISOString(),
    source: URL, needle: NEEDLE,
    ...cur,
  };
  writeExitJson(payload);
  console.log(payload);
}

run().catch(err => {
  const payload = {
    status: "error",
    found: false,
    error: String(err && err.message ? err.message : err),
    scraped_at: new Date().toISOString(),
    source: URL, needle: NEEDLE,
    usd_raw:null, usd_high:null, usd_low:null,
    eur_raw:null, eur_high:null, eur_low:null,
  };
  writeExitJson(payload);
  console.error("UNCAUGHT ERROR:", err);
  process.exitCode = 1; // فایل خروجی ایجاد شده، اما job می‌تواند fail شود تا خبردار شویم
});
