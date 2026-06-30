#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const APP_TIMEZONE = "America/Chicago";
const BLEED_IN = 0.125;
const OUTER_SAFE_IN = 0.625;

function usage() {
  return `
Build a Lulu-ready scrapbook interior PDF from the app archive JSON.

Usage:
  npm run scrapbook:pdf -- --archive ~/Downloads/an-deployment-scrapbook-archive-YYYY-MM-DD.json
  node tools/build-scrapbook-pdf.mjs --archive path/to/archive.json

Options:
  --archive <path>          Archive JSON from the app. Defaults to latest matching file in Downloads.
  --out <path>              PDF output path. Defaults to dist/A-N-Deployment-Scrapbook-interior-lulu-6x9.pdf.
  --html-out <path>         HTML output path. Defaults to dist/scrapbook-lulu/book.html.
  --chrome <path>           Chrome/Chromium executable path.
  --no-pdf                  Only build the HTML package.
  --skip-image-download     Use original remote image URLs instead of local image copies.
  --help                    Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    archive: "",
    out: path.join(repoRoot, "dist", "A-N-Deployment-Scrapbook-interior-lulu-6x9.pdf"),
    htmlOut: path.join(repoRoot, "dist", "scrapbook-lulu", "book.html"),
    chrome: "",
    makePdf: true,
    downloadImages: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage().trim());
      process.exit(0);
    } else if (arg === "--archive") {
      args.archive = argv[++i] || "";
    } else if (arg === "--out") {
      args.out = argv[++i] || "";
    } else if (arg === "--html-out") {
      args.htmlOut = argv[++i] || "";
    } else if (arg === "--chrome") {
      args.chrome = argv[++i] || "";
    } else if (arg === "--no-pdf") {
      args.makePdf = false;
    } else if (arg === "--skip-image-download") {
      args.downloadImages = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  args.archive = expandHome(args.archive);
  args.out = path.resolve(expandHome(args.out));
  args.htmlOut = path.resolve(expandHome(args.htmlOut));
  args.chrome = expandHome(args.chrome);
  return args;
}

function expandHome(input) {
  if (!input) return "";
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function findLatestArchive() {
  const dirs = [path.join(os.homedir(), "Downloads"), repoRoot];
  const matches = [];

  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (/^an-deployment-scrapbook-archive-.*\.json$/i.test(file)) {
          const fullPath = path.join(dir, file);
          const stat = await fs.stat(fullPath);
          matches.push({ fullPath, mtimeMs: stat.mtimeMs });
        }
      }
    } catch (_) {
      // Keep searching other likely locations.
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.fullPath || "";
}

async function loadArchive(archivePath) {
  const raw = await fs.readFile(archivePath, "utf8");
  const archive = JSON.parse(raw);
  const entries = Array.isArray(archive.entries) ? archive.entries : [];
  return {
    ...archive,
    entries: entries.map(normalizeEntry).filter(Boolean).sort((a, b) => a.ms - b.ms),
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const createdAtIso = entry.createdAtIso || "";
  const createdAtClient = Number(entry.createdAtClient || 0);
  const isoMs = createdAtIso ? Date.parse(createdAtIso) : 0;
  const ms = Number.isFinite(isoMs) && isoMs > 0 ? isoMs : createdAtClient || 0;

  return {
    id: String(entry.id || stableId(entry)),
    who: String(entry.who || "A+N"),
    text: String(entry.text || ""),
    link: safeUrl(entry.link),
    entryType: String(entry.entryType || ""),
    promptCategory: String(entry.promptCategory || ""),
    promptText: String(entry.promptText || ""),
    imageUrl: safeUrl(entry.imageUrl),
    reactions: entry.reactions && typeof entry.reactions === "object" ? entry.reactions : {},
    ms,
  };
}

function stableId(entry) {
  return createHash("sha1").update(JSON.stringify(entry)).digest("hex").slice(0, 12);
}

function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(ms, options) {
  if (!ms) return "Date unknown";
  return new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, ...options }).format(new Date(ms));
}

function monthKey(ms) {
  return formatDate(ms, { year: "numeric", month: "2-digit" });
}

function monthLabel(ms) {
  return formatDate(ms, { month: "long", year: "numeric" });
}

function dateTimeLabel(ms) {
  return formatDate(ms, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function whoClass(who) {
  return String(who).toLowerCase().trim() === "nathalia" ? "nathalia" : "alex";
}

function locationFromWho(who) {
  const normalized = String(who || "").trim().toLowerCase();
  if (normalized === "alex") return "Djibouti";
  if (normalized === "nathalia") return "Destin";
  return "Across the distance";
}

function lovedText(reactions) {
  const names = [];
  for (const value of Object.values(reactions || {})) {
    if (value && typeof value === "object" && value.who) names.push(String(value.who));
  }
  const unique = Array.from(new Set(names)).sort((a, b) => {
    const order = { Alex: 0, Nathalia: 1 };
    return (order[a] ?? 9) - (order[b] ?? 9) || a.localeCompare(b);
  });
  if (unique.length === 0) return "";
  if (unique.length === 1) return `Loved by ${unique[0]}`;
  return `Loved by ${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

function shortText(value, max = 110) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function groupByMonth(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = monthKey(entry.ms);
    if (!groups.has(key)) {
      groups.set(key, { key, ms: entry.ms, label: monthLabel(entry.ms), entries: [] });
    }
    groups.get(key).entries.push(entry);
  }
  return Array.from(groups.values());
}

function entryWeight(entry) {
  const textLength = entry.text.length + entry.promptText.length;
  let weight = 1;
  if (entry.localImage || entry.imageUrl) weight += 2.5;
  if (entry.entryType === "promptAnswer" || entry.promptText) weight += 0.7;
  if (entry.link) weight += 0.4;
  if (textLength > 260) weight += 0.9;
  if (textLength > 650) weight += 1.4;
  return weight;
}

function chunkEntriesForSpreads(entries) {
  const pages = [];
  let current = [];
  let currentWeight = 0;
  const maxWeight = 4.35;
  const maxItems = 3;

  for (const entry of entries) {
    const weight = entryWeight(entry);
    if (current.length > 0 && (currentWeight + weight > maxWeight || current.length >= maxItems)) {
      pages.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(entry);
    currentWeight += weight;
    if (weight >= maxWeight) {
      pages.push(current);
      current = [];
      currentWeight = 0;
    }
  }

  if (current.length > 0) pages.push(current);
  return pages;
}

async function prepareImages(entries, htmlOut, downloadImages) {
  const htmlDir = path.dirname(htmlOut);
  const assetsDir = path.join(htmlDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  let count = 0;
  for (const entry of entries) {
    if (!entry.imageUrl) continue;
    count += 1;
    if (!downloadImages) {
      entry.localImage = entry.imageUrl;
      continue;
    }

    try {
      const response = await fetch(entry.imageUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const ext = imageExtension(contentType, entry.imageUrl);
      const name = `photo-${String(count).padStart(4, "0")}-${entry.id}.${ext}`;
      const imagePath = path.join(assetsDir, name);
      const bytes = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(imagePath, bytes);
      entry.localImage = `assets/${name}`;
    } catch (error) {
      console.warn(`Image download failed for entry ${entry.id}; using remote URL. ${error.message}`);
      entry.localImage = entry.imageUrl;
    }
  }
}

function imageExtension(contentType, imageUrl) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  try {
    const ext = path.extname(new URL(imageUrl).pathname).replace(".", "").toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  } catch (_) {
    // Fall through.
  }
  return "jpg";
}

function statsFor(entries) {
  const first = entries[0]?.ms || 0;
  const last = entries.at(-1)?.ms || 0;
  return {
    total: entries.length,
    memories: entries.filter((entry) => entry.entryType !== "promptAnswer").length,
    prompts: entries.filter((entry) => entry.entryType === "promptAnswer").length,
    photos: entries.filter((entry) => entry.localImage || entry.imageUrl).length,
    links: entries.filter((entry) => entry.link).length,
    loves: entries.reduce((sum, entry) => sum + Object.keys(entry.reactions || {}).length, 0),
    first,
    last,
  };
}

function buildPages(entries) {
  const pages = [];
  const stats = statsFor(entries);

  pages.push({ type: "title", html: titlePage(stats) });
  pages.push({ type: "letter", html: letterPage(stats) });
  pages.push({ type: "stats", html: statsPage(stats) });

  for (const group of groupByMonth(entries)) {
    pages.push({ type: "month", html: monthIntroPage(group) });
    const spreads = chunkEntriesForSpreads(group.entries);
    spreads.forEach((spreadEntries, index) => {
      pages.push({
        type: "spread",
        html: spreadPage(group, spreadEntries, index + 1, spreads.length),
      });
    });
  }

  const photos = entries.filter((entry) => entry.localImage || entry.imageUrl);
  chunkArray(photos, 4).forEach((chunk, index, chunks) => {
    pages.push({ type: "gallery", html: galleryPage(chunk, index + 1, chunks.length) });
  });

  pages.push({ type: "closingPage", html: closingPage() });
  return pages.map((page, index) => ({ ...page, number: index + 1, side: index % 2 === 0 ? "right" : "left" }));
}

function titlePage(stats) {
  return `
    <div class="sticker">Djibouti to Destin</div>
    <div class="titleBlock">
      <div class="eyebrow">Deployment Love Book</div>
      <h1>A&amp;N Deployment Scrapbook</h1>
      <p>A printed record of loving each other from Djibouti to Destin.</p>
      <div class="route"><span>Alex in Djibouti</span><strong>+</strong><span>Nathalia in Destin</span></div>
    </div>
    <div class="meta">${dateRange(stats)}<br>Interior file for Lulu 6 x 9 print</div>
  `;
}

function letterPage(stats) {
  return `
    <div class="paper">
      <div class="sticker">Kept for always</div>
      <div class="eyebrow">For us</div>
      <h2>The little things became the story.</h2>
      <p>This book is made from the messages, photos, answers, links, and quiet check-ins we left for each other while Alex was deployed to Djibouti and Nathalia was in Destin.</p>
      <p>Some entries are tiny. Some are funny. Some are tender. Together, they are proof that distance did not stop us from showing up, remembering each other, and keeping love present in ordinary days.</p>
      <p>We made ${escapeHtml(stats.total)} little records of us. This is where they live now.</p>
      <div class="signature">A + N</div>
    </div>
  `;
}

function statsPage(stats) {
  const items = [
    ["Entries", stats.total],
    ["Memories", stats.memories],
    ["Prompt answers", stats.prompts],
    ["Photos", stats.photos],
    ["Links", stats.links],
    ["Hearts saved", stats.loves],
  ];
  return `
    <div class="sticker">Our paper trail</div>
    <div class="eyebrow">The record we kept</div>
    <h2>By the numbers</h2>
    <div class="statsGrid">
      ${items.map(([label, value]) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("")}
    </div>
    <div class="dateBand">
      <div><span>First entry</span><strong>${escapeHtml(formatDate(stats.first, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</strong></div>
      <div><span>Last entry</span><strong>${escapeHtml(formatDate(stats.last, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</strong></div>
    </div>
  `;
}

function monthIntroPage(group) {
  const photos = group.entries.filter((entry) => entry.localImage || entry.imageUrl).length;
  const prompts = group.entries.filter((entry) => entry.entryType === "promptAnswer").length;
  return `
    <div class="ribbon">Djibouti <span></span> Destin</div>
    <div class="monthTitle">
      <div class="eyebrow">Chapter</div>
      <h2>${escapeHtml(group.label)}</h2>
      <p>${group.entries.length} pieces of us, ${photos} photos, ${prompts} prompt answers</p>
    </div>
    <div class="keepsake">
      <strong>What this chapter holds</strong>
      <span>Messages sent across time zones, small proof of care, and the ordinary moments that made the distance feel smaller.</span>
    </div>
  `;
}

function spreadPage(group, entries, pageNumber, totalPages) {
  const hasPhoto = entries.some((entry) => entry.localImage || entry.imageUrl);
  const single = entries.length === 1;
  return `
    <div class="ribbon">Djibouti <span></span> Destin</div>
    <div class="spreadHeader">
      <div><div class="eyebrow">${escapeHtml(group.label)}</div><h2>Love note spread</h2></div>
      <div class="spreadCount">${pageNumber} / ${totalPages}</div>
    </div>
    <div class="entryGrid ${hasPhoto ? "photoGrid" : ""} ${single ? "singleGrid" : ""}">
      ${entries.map(entryCard).join("")}
    </div>
  `;
}

function entryCard(entry, index) {
  const image = entry.localImage || entry.imageUrl;
  const classes = [
    "entry",
    whoClass(entry.who),
    image ? "hasPhoto" : "",
    entry.text.length + entry.promptText.length > 650 ? "longEntry" : "",
    image && !entry.text ? "photoOnly" : "",
  ].filter(Boolean).join(" ");

  return `
    <article class="${classes}">
      <div class="corner"></div>
      <div class="tape ${index % 2 === 0 ? "left" : "right"}"></div>
      <header>
        <div class="identity"><span class="who">${escapeHtml(entry.who)}</span><span class="place">${escapeHtml(locationFromWho(entry.who))}</span></div>
        <time>${escapeHtml(dateTimeLabel(entry.ms))}</time>
      </header>
      ${entry.promptText ? `<div class="prompt"><span>${escapeHtml(entry.promptCategory || "Prompt")}</span><p>${escapeHtml(entry.promptText)}</p></div>` : ""}
      ${entry.text ? `<div class="text">${escapeHtml(entry.text)}</div>` : ""}
      ${image ? `<figure class="photo"><img src="${escapeHtml(image)}" alt="${escapeHtml(entry.who)} memory photo"></figure>` : ""}
      ${entry.link ? `<div class="link">${escapeHtml(linkLabel(entry.link))}</div>` : ""}
      ${lovedText(entry.reactions) ? `<div class="loved">${escapeHtml(lovedText(entry.reactions))}</div>` : ""}
    </article>
  `;
}

function galleryPage(entries, pageNumber, totalPages) {
  return `
    <div class="sticker">Look what we kept</div>
    <div class="eyebrow">Photo roll ${pageNumber} of ${totalPages}</div>
    <h2>Little windows into us</h2>
    <div class="galleryGrid">
      ${entries.map((entry) => {
        const image = entry.localImage || entry.imageUrl;
        return `
          <figure class="galleryTile">
            <img src="${escapeHtml(image)}" alt="Scrapbook photo">
            <figcaption><strong>${escapeHtml(entry.who)}</strong><span>${escapeHtml(shortText(entry.text || entry.promptText || dateTimeLabel(entry.ms)))}</span></figcaption>
          </figure>
        `;
      }).join("")}
    </div>
  `;
}

function closingPage() {
  return `
    <div class="closingContent">
      <div class="sticker">Always</div>
      <div class="eyebrow">Still us</div>
      <h2>Distance was part of the story.</h2>
      <p>Djibouti and Destin were far apart. Love was the record we kept.</p>
      <div class="signature">Alex + Nathalia</div>
    </div>
  `;
}

function linkLabel(link) {
  try {
    const url = new URL(link);
    const pathText = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return shortText(`${url.hostname.replace(/^www\./, "")}${pathText}`, 76);
  } catch (_) {
    return shortText(link, 76);
  }
}

function dateRange(stats) {
  if (!stats.first || !stats.last) return "A deployment story";
  return `${formatDate(stats.first, { month: "long", day: "numeric", year: "numeric" })} to ${formatDate(stats.last, { month: "long", day: "numeric", year: "numeric" })}`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function gutterForPageCount(pageCount) {
  if (pageCount <= 60) return BLEED_IN + 0.5;
  if (pageCount <= 150) return BLEED_IN + 0.625;
  if (pageCount <= 400) return BLEED_IN + 1;
  if (pageCount <= 600) return BLEED_IN + 1.125;
  return BLEED_IN + 1.25;
}

function buildHtml(archive, pages) {
  const pageCount = pages.length;
  const inner = gutterForPageCount(pageCount);
  const css = buildCss(inner);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>A&N Deployment Scrapbook Interior</title>
  <style>${css}</style>
</head>
<body>
  ${pages.map((page) => `<section class="page ${page.type} ${page.side}" data-page="${page.number}">${page.html}</section>`).join("\n")}
  <script>
    window.__SCRAPBOOK_READY__ = Promise.all(Array.from(document.images).map(function(img) {
      if (img.complete) return img.decode ? img.decode().catch(function(){}) : Promise.resolve();
      return new Promise(function(resolve) {
        img.addEventListener("load", function(){ (img.decode ? img.decode().catch(function(){}) : Promise.resolve()).then(resolve); }, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }));
  </script>
</body>
</html>`;
}

function buildCss(inner) {
  return `
@page { size: 6.25in 9.25in; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #2b2522; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.page { position: relative; width: 6.25in; min-height: 9.25in; page-break-after: always; break-after: page; overflow: hidden; padding-top: .625in; padding-bottom: .72in; background: #fffaf2; }
.page.left { padding-left: .625in; padding-right: ${inner}in; }
.page.right { padding-left: ${inner}in; padding-right: .625in; }
.page:last-child { page-break-after: auto; break-after: auto; }
.page::before { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, #f2e8dd 0 1px, transparent 1px 100%), linear-gradient(180deg, #e7efec 0 1px, transparent 1px 100%); background-size: .25in .25in; opacity: 1; }
.page::after { content: "A + N / Djibouti - Destin"; position: absolute; left: .5in; right: .5in; bottom: .28in; color: #7e9790; font-size: 9px; font-weight: 900; letter-spacing: .08em; text-align: center; text-transform: uppercase; }
.page > * { position: relative; z-index: 1; }
.title { display: flex; flex-direction: column; justify-content: space-between; background: #fff3e3; }
.letter { background: #edf6f4; }
.stats { background: #fff1f5; }
.month, .spread { background: #fffaf2; }
.gallery { background: #f1f6ef; }
.closingPage { background: #f6f0fb; }
.sticker { display: inline-flex; width: max-content; max-width: 100%; padding: 8px 12px; border-radius: 999px; background: #fff; border: 1px solid #cbbbae; color: #b5485b; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .06em; transform: rotate(-2deg); }
.eyebrow { color: #2f6f75; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
h1, h2 { margin: 0; color: #321f24; line-height: 1.07; }
h1 { font-size: 36px; }
h2 { font-size: 26px; }
p { line-height: 1.48; }
.titleBlock { margin: .65in 0; }
.titleBlock p { max-width: 3.7in; margin: 14px 0 0; color: #6f3f4c; font-size: 17px; }
.route { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 18px; }
.route span { padding: 8px 11px; border-radius: 999px; background: #fff; border: 1px solid #d5c8bb; color: #2f6f75; font-size: 12px; font-weight: 900; }
.route strong { color: #b5485b; font-size: 18px; }
.meta { color: #3e4f4d; font-size: 13px; font-weight: 900; line-height: 1.5; }
.paper, .keepsake { padding: .24in; border-radius: 18px; background: rgba(255,255,255,.86); border: 1px dashed #d0a3ad; }
.paper p { font-size: 15px; line-height: 1.52; }
.signature { margin-top: .25in; color: #b5485b; font-size: 24px; font-weight: 900; }
.statsGrid { display: grid; grid-template-columns: 1fr 1fr; gap: .12in; margin-top: .2in; }
.stat { min-height: .75in; padding: .12in; border-radius: 16px; background: #fff; border: 1px solid #d8cbbd; }
.stat strong { display: block; color: #b5485b; font-size: 25px; line-height: 1; }
.stat span { display: block; margin-top: 7px; color: #4d5d5b; font-size: 12px; font-weight: 900; }
.dateBand { margin-top: .18in; padding: .16in; border-radius: 16px; background: #e8f0ed; border: 1px solid #c0d3ce; display: grid; gap: .12in; }
.dateBand span { display: block; color: #2f6f75; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .06em; }
.dateBand strong { display: block; margin-top: 4px; }
.ribbon { display: flex; align-items: center; gap: 10px; margin-bottom: .16in; color: #2f6f75; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
.ribbon span { flex: 1; height: 2px; border-radius: 999px; background: linear-gradient(90deg, #9bbdb6, #d69aa8); }
.monthTitle { padding-bottom: .12in; border-bottom: 2px dashed #d9a8b3; }
.monthTitle p { margin: 8px 0 0; color: #5d625d; font-weight: 900; }
.keepsake { margin-top: .38in; }
.keepsake strong { display: block; margin-bottom: 8px; color: #b5485b; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; }
.keepsake span { display: block; font-size: 16px; line-height: 1.5; }
.spreadHeader { display: flex; justify-content: space-between; gap: .18in; margin-bottom: .16in; padding-bottom: .12in; border-bottom: 2px dashed #bed4ce; }
.spreadHeader h2 { margin-top: 6px; font-size: 24px; }
.spreadCount { height: max-content; padding: 7px 10px; border-radius: 999px; background: #fff; border: 1px solid #d8cbbd; color: #b5485b; font-size: 11px; font-weight: 900; }
.entryGrid { display: grid; grid-template-columns: 1fr 1fr; gap: .16in; align-items: start; }
.entryGrid.photoGrid, .entryGrid.singleGrid { display: block; }
.entry { position: relative; margin-bottom: .14in; padding: .14in; border-radius: 16px; background: rgba(255,255,255,.9); border: 1px solid #d8cbbd; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
.entry.alex { border-left: 6px solid #3178c6; }
.entry.nathalia { border-left: 6px solid #b5488d; }
.corner { position: absolute; right: -.28in; bottom: -.28in; width: .75in; height: .75in; border-radius: 50%; background: #f7e4e9; border: 1px solid #e3b9c4; }
.tape { position: absolute; top: -.08in; width: .72in; height: .2in; border-radius: 3px; background: #f4d17e; border: 1px solid #d2a94e; opacity: .72; }
.tape.left { left: .22in; transform: rotate(-4deg); }
.tape.right { right: .22in; transform: rotate(4deg); }
.entry header { display: flex; justify-content: space-between; gap: .12in; margin-bottom: .1in; }
.identity { display: flex; gap: 6px; flex-wrap: wrap; }
.who, .place { display: inline-flex; padding: 6px 9px; border-radius: 999px; font-size: 11px; font-weight: 900; border: 1px solid #d8cbbd; }
.who { background: #e8f0ed; color: #235a60; }
.nathalia .who { background: #f4e3ec; color: #8b2f62; }
.place { background: #fbefd1; color: #7d5717; }
.nathalia .place { background: #f4e3ec; color: #8b2f62; }
time { max-width: 1.25in; color: #7a706b; font-size: 10px; font-weight: 900; line-height: 1.3; text-align: right; }
.prompt { margin: .1in 0; padding: .1in; border-radius: 12px; background: #fff8e8; border-left: 4px solid #d4a13d; font-size: 12px; }
.prompt span { display: block; margin-bottom: 5px; color: #8c611b; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: .05em; }
.prompt p { margin: 0; }
.text { color: #332925; font-size: 12.8px; line-height: 1.38; white-space: pre-wrap; }
.photo { margin: .12in 0 0; padding: .08in .08in .13in; border-radius: 9px; background: #fff; border: 1px solid #dacfc4; }
.photo img, .galleryTile img { display: block; width: 100%; height: auto; max-height: 2.75in; object-fit: contain; background: #f7f2ec; border-radius: 4px; }
.photoOnly .photo img { max-height: 4.15in; }
.longEntry .photo img { max-height: 2in; }
.link { margin-top: .1in; padding: .09in; border-radius: 12px; background: #e8f0ed; color: #235a60; font-size: 11px; font-weight: 900; }
.loved { margin-top: .1in; padding-top: .09in; border-top: 1px dashed #d9a8b3; color: #b5485b; font-size: 11px; font-weight: 900; }
.galleryGrid { display: grid; grid-template-columns: 1fr 1fr; gap: .16in; margin-top: .18in; }
.galleryTile { margin: 0; padding: .1in; border-radius: 14px; background: #fff; border: 1px solid #d8cbbd; break-inside: avoid; page-break-inside: avoid; }
.galleryTile img { max-height: 2.18in; }
.galleryTile figcaption { margin-top: 7px; color: #3d332f; font-size: 10.5px; line-height: 1.35; }
.galleryTile strong { display: block; color: #b5485b; }
.closingContent { height: 7.2in; display: flex; flex-direction: column; justify-content: center; }
.closingContent h2 { font-size: 32px; }
.closingContent p { color: #6f3f4c; font-size: 19px; line-height: 1.35; }
`;
}

function chromeCandidates() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ];
}

function findChrome(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Chrome executable not found: ${explicit}`);
    return explicit;
  }
  for (const candidate of chromeCandidates()) {
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }
  return "google-chrome";
}

async function renderPdf(chromePath, htmlPath, pdfPath) {
  await fs.mkdir(path.dirname(pdfPath), { recursive: true });
  const profileDir = path.join(path.dirname(htmlPath), ".chrome-profile");
  await fs.mkdir(profileDir, { recursive: true });

  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=MediaRouter",
    "--disable-sync",
    "--allow-file-access-from-files",
    "--run-all-compositor-stages-before-draw",
    "--no-pdf-header-footer",
    "--print-to-pdf-no-header",
    `--user-data-dir=${profileDir}`,
    "--virtual-time-budget=30000",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let pdfComplete = false;
    let timeoutError = null;
    let stopTimer = null;
    let lastSize = 0;
    let stableChecks = 0;
    let logs = "";

    const appendLog = (chunk) => {
      logs = `${logs}${chunk.toString()}`.slice(-12000);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      if (error) reject(error);
      else resolve();
    };

    const isRunning = () => child.exitCode === null && child.signalCode === null;

    const stopLingeringChrome = () => {
      if (!isRunning()) return;
      child.kill("SIGTERM");
      if (!stopTimer) {
        stopTimer = setTimeout(() => {
          if (isRunning()) child.kill("SIGKILL");
        }, 1500);
      }
    };

    const watchdog = setInterval(async () => {
      try {
        const stat = await fs.stat(pdfPath);
        if (stat.size > 1024 && stat.size === lastSize) stableChecks += 1;
        else stableChecks = 0;
        lastSize = stat.size;

        if (stableChecks >= 2) {
          pdfComplete = true;
          stopLingeringChrome();
        }
      } catch (_) {
        stableChecks = 0;
      }
    }, 1000);

    const timeout = setTimeout(() => {
      timeoutError = new Error(`Chrome PDF export timed out.${logs ? `\n${logs}` : ""}`);
      stopLingeringChrome();
    }, 120000);

    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (settled) return;
      if (timeoutError) finish(timeoutError);
      else if (pdfComplete || code === 0) finish();
      else finish(new Error(`Chrome PDF export failed with exit code ${code}.${logs ? `\n${logs}` : ""}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const archivePath = args.archive || await findLatestArchive();
  if (!archivePath) {
    throw new Error("No archive JSON found. In the app, click Scrapbook > Download Archive, then rerun with --archive <path>.");
  }

  const archive = await loadArchive(path.resolve(archivePath));
  if (archive.entries.length === 0) throw new Error("Archive has no entries.");

  await fs.mkdir(path.dirname(args.htmlOut), { recursive: true });
  await prepareImages(archive.entries, args.htmlOut, args.downloadImages);

  const pages = buildPages(archive.entries);
  const html = buildHtml(archive, pages);
  await fs.writeFile(args.htmlOut, html, "utf8");

  console.log(`Archive: ${archivePath}`);
  console.log(`Entries: ${archive.entries.length}`);
  console.log(`Book pages: ${pages.length}`);
  console.log(`HTML: ${args.htmlOut}`);
  console.log("Lulu interior: 6 x 9 trim, 6.25 x 9.25 PDF page size with bleed.");

  if (args.makePdf) {
    const chromePath = findChrome(args.chrome);
    await renderPdf(chromePath, args.htmlOut, args.out);
    console.log(`PDF: ${args.out}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
