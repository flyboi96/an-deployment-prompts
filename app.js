/* ============================
FIREBASE (Auth + Firestore + Storage)
============================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getStorage,
  ref as storageRef,
  uploadString,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCi65Wuu7q-B0E2kO9uaMCnuiwETRJ8CN8",
  authDomain: "an-deployment-app.firebaseapp.com",
  projectId: "an-deployment-app",
  storageBucket: "an-deployment-app.firebasestorage.app",
  messagingSenderId: "543422525101",
  appId: "1:543422525101:web:7141b29a99580a30efa024",
  measurementId: "G-DFCRPHJ9ER",
};


const ALLOWED_EMAILS = new Set([
  "corbin.xela@gmail.com",
  "sharolgarzon11@gmail.com",
]);

function whoFromEmail(email) {
  const e = (email || "").toLowerCase().trim();
  if (e === "corbin.xela@gmail.com") return "Alex";
  if (e === "sharolgarzon11@gmail.com") return "Nathalia";
  return "";
}

// Use a fixed timezone so Alex and Nathalia see the same “Today/Yesterday” groupings
const APP_TIMEZONE = "America/Chicago";

function entryTimeMs(entry) {
  // Prefer server timestamp if present; fall back to client timestamp
  if (entry && entry.createdAt && typeof entry.createdAt.toMillis === "function") {
    return entry.createdAt.toMillis();
  }
  return typeof entry?.createdAtClient === "number" ? entry.createdAtClient : 0;
}

function dayKeyForMs(ms) {
  // YYYY-MM-DD in APP_TIMEZONE (en-CA formats as 2026-03-05)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function prettyDayLabelFromMs(ms, todayKey, yesterdayKey) {
  const key = dayKeyForMs(ms);
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function timeLabelFromMs(ms, isToday) {
  if (isToday) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: APP_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  }
  return new Intl.DateTimeFormat(undefined, {
    timeZone: APP_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let activeTab = "home";
let unseenFromPartner = 0;
let lastPartnerWho = "";
let toastTimer = null;
let lastSeenTs = 0;

function lastSeenStorageKey(email) {
  return `an_lastSeenTs_${String(email || "").toLowerCase().trim()}`;
}

function loadLastSeenTs(email) {
  const raw = localStorage.getItem(lastSeenStorageKey(email));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function saveLastSeenTs(email, ts) {
  const n = Number(ts) || 0;
  localStorage.setItem(lastSeenStorageKey(email), String(n));
  lastSeenTs = n;
}

// Tracks the last "final" prompt shown so we can save it with an answer
let currentPromptCategory = "";
let currentPromptText = "";

function setCurrentPrompt(category, text) {
  currentPromptCategory = category || "";
  currentPromptText = text || "";
  refreshReplyPill();
}

function showTab(tab) {
  activeTab = tab;
  const sections = {
    signin: "sectionSignIn",
    home: "sectionHome",
    prompts: "sectionPrompts",
    memory: "sectionMemory",
    entries: "sectionEntries",
  };

  const tabs = {
    signin: "tabSignIn",
    home: "tabHome",
    prompts: "tabPrompts",
    memory: "tabMemory",
    entries: "tabEntries",
  };

  for (const k of Object.keys(sections)) {
    document.getElementById(sections[k]).classList.toggle("active", k === tab);
  }

  for (const k of Object.keys(tabs)) {
    document.getElementById(tabs[k]).classList.toggle("active", k === tab);
  }

  // When the user opens Entries, mark partner updates as “seen” based on real entry timestamps (done in listener)
  if (tab === "entries") {
    unseenFromPartner = 0;
    lastPartnerWho = "";
    updateEntriesBadge();

    // Persist a provisional "seen" time immediately; the feed listener will refine it
    // to the newest actual partner entry timestamp once it runs.
    const u = auth.currentUser;
    if (u && ALLOWED_EMAILS.has(u.email || "")) {
      saveLastSeenTs(u.email, Math.max(lastSeenTs || 0, Date.now()));
    }
  }
}

function updateEntriesBadge() {
  const badge = document.getElementById("entriesBadge");
  if (!badge) return;

  if (unseenFromPartner <= 0) {
    badge.classList.remove("show");
    badge.textContent = "❤️";
    return;
  }

  badge.classList.add("show");
  badge.textContent = unseenFromPartner === 1 ? "❤️" : `❤️ ${unseenFromPartner}`;
}

function showToast(title, subtitle = "") {
  const el = document.getElementById("toast");
  if (!el) return;

  el.textContent = title;
  if (subtitle) {
    const sub = document.createElement("span");
    sub.className = "toastSub";
    sub.textContent = subtitle;
    el.appendChild(sub);
  }
  el.style.display = "block";

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, 3200);
}

let isUploading = false;

function setUploadingState(isOn, title = "Uploading…", sub = "Please wait") {
  isUploading = isOn;

  const overlay = document.getElementById("uploadOverlay");
  const titleEl = document.getElementById("uploadTitle");
  const subEl = document.getElementById("uploadSub");
  const promptBtn = document.getElementById("savePromptBtn");
  const memoryBtn = document.getElementById("saveMemoryBtn");

  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;

  if (overlay) {
    overlay.style.display = isOn ? "flex" : "none";
    overlay.setAttribute("aria-hidden", isOn ? "false" : "true");
  }

  if (promptBtn) promptBtn.classList.toggle("isBusy", isOn);
  if (memoryBtn) memoryBtn.classList.toggle("isBusy", isOn);

  if (promptBtn) promptBtn.disabled = isOn;
  if (memoryBtn) memoryBtn.disabled = isOn;
}

function refreshReplyPill() {
  const pill = document.getElementById("replyPill");
  const textEl = document.getElementById("replyText");

  if (!pill || !textEl) return;

  if (!currentPromptText) {
    pill.classList.remove("show");
    textEl.textContent = "Spin a prompt first.";
    return;
  }

  pill.classList.add("show");
  const cat = currentPromptCategory ? `${currentPromptCategory}: ` : "";
  textEl.textContent = cat + currentPromptText;
}

function openPromptLibrary(){
  const el = document.getElementById("promptAnswerImageLibrary");
  if (el) el.click();
}
function openMemoryLibrary(){
  const el = document.getElementById("memoryImageLibrary");
  if (el) el.click();
}

function setPhotoStatus(kind, file) {
  const statusEl = document.getElementById(kind === "prompt" ? "promptPhotoStatus" : "memoryPhotoStatus");
  const thumbEl = document.getElementById(kind === "prompt" ? "promptPhotoThumb" : "memoryPhotoThumb");

  if (!statusEl || !thumbEl) return;

  if (!file) {
    statusEl.innerHTML = "No photo selected";
    thumbEl.style.display = "none";
    thumbEl.src = "";
    return;
  }

  const mb = (file.size / (1024 * 1024)).toFixed(1);
  statusEl.innerHTML = `Selected: <strong>${escapeHtml(file.name || "photo")}</strong> (${mb} MB)`;

  // Thumbnail preview
  try {
    const url = URL.createObjectURL(file);
    thumbEl.src = url;
    thumbEl.style.display = "block";
    // Release the old object URL after the image loads
    thumbEl.onload = () => {
      try { URL.revokeObjectURL(url); } catch (_) {}
    };
  } catch (_) {
    // If preview fails, keep status only.
    thumbEl.style.display = "none";
  }
}

/* ============================
PROMPT SYSTEM
============================ */

const sheetURL =
  "https://opensheet.elk.sh/18Gxh6zCgx7bWifQCmn_HsxQGkXIMXzp2mKhvikl91OU/Prompts";

let sheetData = [];

async function loadSheet() {
  try {
    const response = await fetch(sheetURL);
    sheetData = await response.json();
    document.getElementById("prompt").innerText = "Tap a button to spin a prompt";
  } catch (err) {
    console.error("Prompt load error:", err);
    document.getElementById("prompt").innerText = "Could not load prompts";
  }
}

loadSheet();

function getHistory(type) {
  const saved = localStorage.getItem("promptHistory_" + type);
  return saved ? JSON.parse(saved) : [];
}

function saveHistory(type, history) {
  localStorage.setItem("promptHistory_" + type, JSON.stringify(history));
}

function spinPrompt(type) {
  if (sheetData.length === 0) {
    document.getElementById("prompt").innerText = "Prompts still loading...";
    return;
  }

  const allPrompts = sheetData
    .map((row) => row[type])
    .filter((p) => p && p.length > 0);

  if (allPrompts.length === 0) {
    document.getElementById("prompt").innerText = "No prompts found for: " + type;
    return;
  }

  let history = getHistory(type);
  if (history.length >= allPrompts.length) history = [];

  const availablePrompts = allPrompts.filter((p) => !history.includes(p));

  const promptElement = document.getElementById("prompt");
  let spins = 16;
  let speed = 60;
  let pendingSwap = null;

  function step() {
    const pool = availablePrompts.length ? availablePrompts : allPrompts;
    const randomPrompt = pool[Math.floor(Math.random() * pool.length)];

    promptElement.style.opacity = 0;
    if (pendingSwap) clearTimeout(pendingSwap);
    pendingSwap = setTimeout(() => {
      promptElement.innerText = randomPrompt;
      promptElement.style.opacity = 1;
    }, 60);

    spins--;
    speed += 8;

    if (spins <= 0) {
      const finalPool = availablePrompts.length ? availablePrompts : allPrompts;
      const finalPrompt = finalPool[Math.floor(Math.random() * finalPool.length)];

      if (pendingSwap) {
        clearTimeout(pendingSwap);
        pendingSwap = null;
      }

      promptElement.innerText = finalPrompt;
      promptElement.style.opacity = 1;
      setCurrentPrompt(type, finalPrompt);
      showTab("prompts");
      const ta = document.getElementById("promptAnswerText");
      if (ta) ta.focus();

      history.push(finalPrompt);
      saveHistory(type, history);

      if (navigator.vibrate) navigator.vibrate(40);
      return;
    }

    setTimeout(step, speed);
  }

  step();
}

/* ============================
AUTH UI
============================ */

function setAuthUI(user) {
  const authStatus = document.getElementById("authStatus");
  const passInput = document.getElementById("authPassword");

  const isSignedIn = !!user && ALLOWED_EMAILS.has(user.email || "");

  if (user && !isSignedIn) {
    authStatus.textContent = `Signed in as ${user.email} (not authorized)`;
  } else {
    authStatus.textContent = isSignedIn
      ? `Signed in as ${user.email}`
      : "Not signed in";
  }

  // Enable/disable Memory Vault inputs when signed out / unauthorized
  document.getElementById("memoryText").disabled = !isSignedIn;
  document.getElementById("memoryLink").disabled = !isSignedIn;

  const memLib = document.getElementById("memoryImageLibrary");
  if (memLib) memLib.disabled = !isSignedIn;

  // Prompt answer composer
  const paText = document.getElementById("promptAnswerText");
  const paLink = document.getElementById("promptAnswerLink");
  if (paText) paText.disabled = !isSignedIn;
  if (paLink) paLink.disabled = !isSignedIn;

  const paLib = document.getElementById("promptAnswerImageLibrary");
  if (paLib) paLib.disabled = !isSignedIn;

  // Clear password after sign-in
  if (isSignedIn) passInput.value = "";
}

async function signIn() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);

    // Hard-stop if someone signs in with an unexpected account
    const u = auth.currentUser;
    if (u && !ALLOWED_EMAILS.has(u.email || "")) {
      await signOut(auth);
      alert("This account is not authorized for A&N Memory Vault.");
    }
  } catch (err) {
    console.error("Sign-in error:", err);
    alert("Sign in failed: " + (err?.message || "unknown error"));
  }
}

async function signOutUser() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Sign-out error:", err);
    alert("Sign out failed: " + (err?.message || "unknown error"));
  }
}

/* ============================
IMAGE COMPRESSION (client-side)
============================ */

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const padding = base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0);
  return Math.floor(base64.length * 0.75) - padding;
}

async function compressImageUnderBytes(file, maxBytes = 5 * 1024 * 1024) {
  // Try a few (maxW, quality) pairs until we get under maxBytes.
  const candidates = [
    { maxW: 2000, q: 0.78 },
    { maxW: 1600, q: 0.75 },
    { maxW: 1400, q: 0.72 },
    { maxW: 1200, q: 0.70 },
    { maxW: 1000, q: 0.68 },
    { maxW: 900,  q: 0.66 },
    { maxW: 800,  q: 0.64 },
    { maxW: 700,  q: 0.62 },
  ];

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });

  let lastDataUrl = "";

  for (const c of candidates) {
    const scale = Math.min(1, c.maxW / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/jpeg", c.q);
    lastDataUrl = dataUrl;

    if (dataUrlBytes(dataUrl) <= maxBytes) {
      try { URL.revokeObjectURL(img.src); } catch (_) {}
      return dataUrl;
    }
  }

  try { URL.revokeObjectURL(img.src); } catch (_) {}
  return lastDataUrl; // smallest attempt
}

/* ============================
MEMORY VAULT (Firestore + Storage)
============================ */

let unsubscribeFeed = null;
let entryFetchLimit = 75;
let latestEntryDocs = [];
let currentEntryGroups = [];
let entryControlsReady = false;
let entryScrubberFrame = null;

async function toggleHeart(entryId) {
  const user = auth.currentUser;
  if (!user || !ALLOWED_EMAILS.has(user.email || "")) {
    alert("Sign in first.");
    showTab("signin");
    return;
  }

  try {
    const entryRef = doc(db, "entries", entryId);
    const uid = user.uid;
    const key = `reactions.${uid}`;

    // Toggle based on DOM state (simple and reliable here)
    const btn = document.getElementById(`heart_${entryId}`);
    const isActive = btn && btn.classList.contains("active");

    if (isActive) {
      await updateDoc(entryRef, { [key]: deleteField() });
    } else {
      await updateDoc(entryRef, {
        [key]: {
          who: whoFromEmail(user.email),
          email: user.email || "",
          at: serverTimestamp(),
        },
      });
    }
  } catch (err) {
    console.error("Reaction error:", err);
    alert("Reaction failed: " + (err?.message || "unknown error"));
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function lovedNamesFromReactions(reactions, currentUser) {
  const r = reactions || {};
  const myUid = currentUser ? currentUser.uid : "";
  const myEmail = currentUser ? (currentUser.email || "") : "";

  const names = [];
  for (const [uid, val] of Object.entries(r)) {
    // New format: object with who/email
    if (val && typeof val === "object") {
      const who = (val.who || whoFromEmail(val.email) || "").trim();
      if (who) names.push(who);
      continue;
    }

    // Old format: boolean true
    if (val === true) {
      if (uid && uid === myUid) {
        const me = whoFromEmail(myEmail);
        if (me) names.push(me);
      } else {
        // Only two users; if it's not me, it's the partner
        names.push("Your person");
      }
    }
  }

  // De-dup + prefer stable, romantic ordering
  const uniq = Array.from(new Set(names));
  uniq.sort((a, b) => {
    const order = { "Alex": 0, "Nathalia": 1, "Your person": 2 };
    return (order[a] ?? 99) - (order[b] ?? 99) || a.localeCompare(b);
  });
  return uniq;
}

function lovedByText(names) {
  if (!names || names.length === 0) return "";
  if (names.length === 1) return `Loved by ${names[0]}`;
  if (names.length === 2) return `Loved by ${names[0]} and ${names[1]}`;
  return `Loved by ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function safeExternalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    return "";
  } catch (_) {
    return "";
  }
}

function reactionCount(reactions) {
  return Object.keys(reactions || {}).length;
}

function getEntryFilters() {
  const search = document.getElementById("entrySearch")?.value || "";
  const person = document.getElementById("entryPersonFilter")?.value || "";
  const kind = document.getElementById("entryKindFilter")?.value || "";

  return {
    search: search.toLowerCase().trim(),
    person,
    kind,
  };
}

function entryMatchesFilters(entry, filters) {
  const who = (entry.who || "").trim();
  const promptText = (entry.promptText || "").trim();
  const promptCategory = (entry.promptCategory || "").trim();
  const hasPrompt = !!promptText || entry.entryType === "promptAnswer";
  const hasLink = !!safeExternalUrl(entry.link);

  if (filters.person && who !== filters.person) return false;

  if (filters.kind === "prompt" && !hasPrompt) return false;
  if (filters.kind === "memory" && hasPrompt) return false;
  if (filters.kind === "photo" && !entry.imageUrl) return false;
  if (filters.kind === "link" && !hasLink) return false;
  if (filters.kind === "loved" && reactionCount(entry.reactions) === 0) return false;

  if (!filters.search) return true;

  const ms = entryTimeMs(entry);
  const dateText = ms ? new Intl.DateTimeFormat(undefined, {
    timeZone: APP_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(ms)) : "";

  const searchable = [
    who,
    entry.text || "",
    entry.link || "",
    promptText,
    promptCategory,
    dateText,
  ].join(" ").toLowerCase();

  return searchable.includes(filters.search);
}

function buildEntryGroups(entries) {
  const groups = new Map();

  for (const e of entries) {
    const ms = entryTimeMs(e);
    const key = ms ? dayKeyForMs(ms) : "unknown";
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { key, ms, items: [{ ...e, id: e.id, __ms: ms }] });
    } else {
      existing.ms = Math.max(existing.ms || 0, ms || 0);
      existing.items.push({ ...e, id: e.id, __ms: ms });
    }
  }

  return Array.from(groups.values()).sort((a, b) => (b.ms || 0) - (a.ms || 0));
}

function initEntryControls() {
  if (entryControlsReady) return;

  const search = document.getElementById("entrySearch");
  const person = document.getElementById("entryPersonFilter");
  const kind = document.getElementById("entryKindFilter");
  const dateJump = document.getElementById("entryDateJump");
  const scrubber = document.getElementById("entryScrubber");

  const rerender = () => renderEntryFeed();

  if (search) search.addEventListener("input", rerender);
  if (person) person.addEventListener("change", rerender);
  if (kind) kind.addEventListener("change", rerender);
  if (dateJump) {
    dateJump.addEventListener("change", () => {
      if (dateJump.value) jumpToEntryDay(dateJump.value);
    });
  }
  if (scrubber) {
    scrubber.addEventListener("input", () => jumpToEntryIndex(Number(scrubber.value)));
  }

  entryControlsReady = true;
}

function updateEntryControls(groups, visibleCount, loadedCount) {
  const dateJump = document.getElementById("entryDateJump");
  const summary = document.getElementById("entryFeedSummary");
  const loadBtn = document.getElementById("loadMoreEntriesBtn");

  if (dateJump) {
    const selected = dateJump.value;
    const todayKey = dayKeyForMs(Date.now());
    const yesterdayKey = dayKeyForMs(Date.now() - 24 * 60 * 60 * 1000);

    dateJump.innerHTML = `<option value="">Jump to date</option>`;

    for (const g of groups) {
      const option = document.createElement("option");
      option.value = g.key;
      option.textContent = `${prettyDayLabelFromMs(g.ms || 0, todayKey, yesterdayKey)} (${g.items.length})`;
      dateJump.appendChild(option);
    }

    dateJump.disabled = groups.length === 0;
    if (groups.some((g) => g.key === selected)) {
      dateJump.value = selected;
    }
  }

  if (summary) {
    if (loadedCount === 0) {
      summary.textContent = "No entries loaded yet.";
    } else if (visibleCount === loadedCount) {
      summary.textContent = `${loadedCount} entries loaded`;
    } else {
      summary.textContent = `${visibleCount} of ${loadedCount} entries shown`;
    }
  }

  if (loadBtn) {
    const canLoadMore = loadedCount >= entryFetchLimit;
    loadBtn.disabled = !canLoadMore;
    loadBtn.textContent = canLoadMore ? "Older" : "Done";
  }

  updateEntryScrubber(groups, 0);
}

function scrollEntriesTop() {
  if (currentEntryGroups.length > 0) {
    jumpToEntryIndex(0);
    return;
  }

  document.getElementById("sectionEntries")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollEntriesBottom() {
  if (currentEntryGroups.length > 0) {
    jumpToEntryIndex(currentEntryGroups.length - 1);
    return;
  }

  document.getElementById("memoryFeed")?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
}

function visibleEntryDayHeaders() {
  return Array.from(document.querySelectorAll("#memoryFeed .dayHeader[id^='entry-day-']"));
}

function currentEntryDayIndex(headers) {
  const anchorY = Math.max(96, window.innerHeight * 0.28);
  let currentIndex = 0;

  headers.forEach((header, index) => {
    if (header.getBoundingClientRect().top <= anchorY) {
      currentIndex = index;
    }
  });

  return currentIndex;
}

function scrollEntryDay(offset) {
  const headers = visibleEntryDayHeaders();
  if (headers.length === 0) return;

  const currentIndex = currentEntryDayIndex(headers);
  jumpToEntryIndex(currentIndex + offset);
}

function updateEntryScrubber(groups, index) {
  const scrubber = document.getElementById("entryScrubber");
  const label = document.getElementById("entryScrubLabel");
  const prev = document.getElementById("entryPrevDayBtn");
  const next = document.getElementById("entryNextDayBtn");
  const top = document.getElementById("scrollEntriesTopBtn");
  const bottom = document.getElementById("scrollEntriesBottomBtn");
  const hasGroups = groups.length > 0;
  const clamped = hasGroups ? Math.max(0, Math.min(groups.length - 1, index)) : 0;

  if (scrubber) {
    scrubber.min = "0";
    scrubber.max = String(Math.max(groups.length - 1, 0));
    scrubber.value = String(clamped);
    scrubber.disabled = groups.length <= 1;
  }

  if (label) {
    label.textContent = hasGroups ? `${clamped + 1}/${groups.length}` : "0/0";
  }

  for (const button of [prev, next, top, bottom]) {
    if (button) button.disabled = !hasGroups;
  }
}

function syncEntryScrubberToScroll() {
  const headers = visibleEntryDayHeaders();
  if (headers.length === 0) {
    updateEntryScrubber(currentEntryGroups, 0);
    return;
  }

  updateEntryScrubber(currentEntryGroups, currentEntryDayIndex(headers));
}

function scheduleEntryScrubberSync() {
  if (activeTab !== "entries" || entryScrubberFrame) return;
  entryScrubberFrame = requestAnimationFrame(() => {
    entryScrubberFrame = null;
    syncEntryScrubberToScroll();
  });
}

function jumpToEntryIndex(index) {
  if (currentEntryGroups.length === 0) return;

  const clamped = Math.max(0, Math.min(currentEntryGroups.length - 1, index));
  const target = document.getElementById(`entry-day-${currentEntryGroups[clamped].key}`);

  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  updateEntryScrubber(currentEntryGroups, clamped);
}

function jumpToEntryDay(dayKey) {
  const el = document.getElementById(`entry-day-${dayKey}`);
  if (!el) return;

  const index = currentEntryGroups.findIndex((group) => group.key === dayKey);
  if (index >= 0) updateEntryScrubber(currentEntryGroups, index);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function loadMoreEntries() {
  entryFetchLimit += 75;
  startFeedListener();
}

function entryWhoClass(who) {
  const normalized = who.toLowerCase();
  if (normalized === "alex") return "alex";
  if (normalized === "nathalia") return "nathalia";
  return "alex";
}

function renderEntryCard(entry, timeLabelForEntry) {
  const card = document.createElement("div");
  card.className = "entry";

  const who = (entry.who || "").trim();
  const whoClass = entryWhoClass(who);
  const ts = entry.__ms ? timeLabelForEntry(entry.__ms) : "";
  const promptText = (entry.promptText || "").trim();
  const promptCategory = (entry.promptCategory || "").trim();
  const safeLink = safeExternalUrl(entry.link);
  const safeImageUrl = safeExternalUrl(entry.imageUrl);
  const currentUid = auth.currentUser ? auth.currentUser.uid : "";
  const reacted = entry.reactions && currentUid && entry.reactions[currentUid];
  const lovedText = lovedByText(lovedNamesFromReactions(entry.reactions, auth.currentUser));

  card.innerHTML = `
    <div class="entryHeader">
      <div class="entryMeta">
        <span class="pill ${whoClass}">${escapeHtml(who || "")}</span>
        ${promptText ? `<span class="badge">${escapeHtml(promptCategory || "Prompt")}</span>` : ``}
      </div>
      <div class="timestamp">${escapeHtml(ts)}</div>
    </div>

    ${promptText ? `
      <div class="promptBlock">
        <div class="promptLabel">Prompt</div>
        <div>${escapeHtml(promptText)}</div>
      </div>
    ` : ``}

    ${entry.text ? `<div class="answerBlock">${escapeHtml(entry.text)}</div>` : ``}

    <div class="entryActions">
      ${safeLink ? `<a class="linkButton" href="${escapeHtml(safeLink)}" target="_blank" rel="noopener noreferrer">Open link</a>` : ``}
    </div>

    ${safeImageUrl ? `<img class="entryImage" src="${escapeHtml(safeImageUrl)}" alt="Memory photo">` : ``}

    <div class="reactionRow">
      <button
        class="heartBtn ${reacted ? "active" : ""}"
        id="heart_${escapeHtml(entry.id)}"
        data-entry-id="${escapeHtml(entry.id)}"
      >❤️ Love</button>

      <div class="heartCount">${escapeHtml(lovedText)}</div>
    </div>
  `;

  return card;
}

function renderEntryFeed() {
  initEntryControls();

  const feed = document.getElementById("memoryFeed");
  if (!feed) return;

  feed.innerHTML = "";

  const filters = getEntryFilters();
  const filteredDocs = latestEntryDocs.filter((entry) => entryMatchesFilters(entry, filters));

  // Helpers for grouping / formatting (timezone-safe)
  const nowMs = Date.now();
  const todayKey = dayKeyForMs(nowMs);
  const yesterdayKey = dayKeyForMs(nowMs - 24 * 60 * 60 * 1000);

  function timeLabelForEntry(entryMs) {
    const isToday = dayKeyForMs(entryMs) === todayKey;
    return timeLabelFromMs(entryMs, isToday);
  }

  const sortedGroups = buildEntryGroups(filteredDocs);
  currentEntryGroups = sortedGroups;
  updateEntryControls(sortedGroups, filteredDocs.length, latestEntryDocs.length);

  if (sortedGroups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyEntries";
    empty.textContent = latestEntryDocs.length === 0 ? "No entries yet." : "No matching entries.";
    feed.appendChild(empty);
    return;
  }

  for (const g of sortedGroups) {
    const h = document.createElement("div");
    h.className = "dayHeader";
    h.id = `entry-day-${g.key}`;
    h.textContent = prettyDayLabelFromMs(g.ms || 0, todayKey, yesterdayKey);
    feed.appendChild(h);

    g.items.sort((a, b) => (b.__ms || 0) - (a.__ms || 0));

    for (const entry of g.items) {
      feed.appendChild(renderEntryCard(entry, timeLabelForEntry));
    }
  }

  syncEntryScrubberToScroll();
}

function startFeedListener() {
  if (unsubscribeFeed) unsubscribeFeed();

  const entriesRef = collection(db, "entries");
  const q = query(entriesRef, orderBy("createdAtClient", "desc"), limit(entryFetchLimit));

  unsubscribeFeed = onSnapshot(
    q,
    (snap) => {
      const feed = document.getElementById("memoryFeed");
      feed.innerHTML = "";

      const docs = [];
      snap.forEach((d) => {
        docs.push({ id: d.id, ...d.data() });
      });

      const currentUserEmail = auth.currentUser?.email || "";
      if (lastSeenTs === 0 && currentUserEmail) {
        const storedSeen = loadLastSeenTs(currentUserEmail);
        if (storedSeen > 0) {
          lastSeenTs = storedSeen;
        } else if (docs.length > 0) {
          // First-ever session for this user: start from current snapshot so old entries
          // do not immediately count as “new”.
          const firstTs = entryTimeMs(docs[0]);
          if (firstTs > 0) {
            saveLastSeenTs(currentUserEmail, firstTs);
          }
        }
      }

      if (docs.length > 0 && auth.currentUser) {
        const myEmail = auth.currentUser.email || "";

        // Look for unseen partner entries in the recent window.
        // Important: the newest doc might be MY post, which would otherwise hide the partner post.
        const unseenPartner = [];

        for (const d of docs) {
          const ts = entryTimeMs(d);
          if (!ts) continue;

          const fromPartner = d.email && d.email !== myEmail;
          if (!fromPartner) continue;

          if (ts > lastSeenTs) unseenPartner.push({ d, ts });
        }

        // Keep them sorted newest -> oldest
        unseenPartner.sort((a, b) => b.ts - a.ts);

        if (unseenPartner.length > 0 && activeTab !== "entries") {
          // Badge count = number of unseen partner entries in this snapshot window
          unseenFromPartner = unseenPartner.length;
          lastPartnerWho = (unseenPartner[0].d.who || "").trim();
          updateEntriesBadge();
          console.log("A&N unseen partner entries:", unseenPartner.length, unseenPartner.map(x => ({ who: x.d.who, ts: x.ts, entryType: x.d.entryType })));

          // Toast only for the newest unseen partner entry
          const newest = unseenPartner[0].d;
          const whoName = lastPartnerWho || "Your person";
          const kind = newest.entryType === "promptAnswer" ? "answered a prompt" : "left you a memory";
          showToast(`❤️ ${whoName} ${kind}`, unseenPartner.length > 1 ? `+${unseenPartner.length - 1} more — tap Entries` : "Tap Entries to see it");

          if (navigator.vibrate) navigator.vibrate(35);

          // IMPORTANT: do NOT advance __lastSeenTs here; only advance when user actually views Entries.
          // This prevents losing notifications if the toast disappears.
        }

        if (activeTab === "entries") {
          // When viewing Entries, mark everything up to the newest partner entry as seen
          if (unseenPartner.length > 0) {
            const maxTs = unseenPartner[0].ts;
            const nextSeen = Math.max(lastSeenTs, maxTs);
            const u = auth.currentUser;
            if (u && ALLOWED_EMAILS.has(u.email || "")) {
              saveLastSeenTs(u.email, nextSeen);
            } else {
              lastSeenTs = nextSeen;
            }
          }

          // Clear the badge while on Entries
          unseenFromPartner = 0;
          lastPartnerWho = "";
          updateEntriesBadge();
        }
      }

      latestEntryDocs = docs;
      renderEntryFeed();
    },
    (err) => {
      console.error("Feed listener error:", err);
      alert("Feed error: " + (err?.message || "unknown error"));
    }
  );
}

function selectedImageFile(input) {
  return input && input.files && input.files[0] ? input.files[0] : null;
}

function userFacingError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

function alertSaveError(err) {
  console.error("Save entry error:", err);
  alert(err?.userMessage || "Save failed: " + (err?.message || "unknown error"));
}

async function uploadEntryImage(user, imageFile) {
  if (!imageFile) return "";

  try {
    if (imageFile.size > 40 * 1024 * 1024) {
      throw userFacingError("That photo is extremely large. Try a smaller one.");
    }

    const dataUrl = await compressImageUnderBytes(imageFile, 5 * 1024 * 1024);
    if (dataUrlBytes(dataUrl) > 5 * 1024 * 1024) {
      throw userFacingError("Could not compress this photo under 5 MB. Try cropping it or choosing a different photo.");
    }

    const path = `entries/${user.uid}/${Date.now()}.jpg`;
    const imgRef = storageRef(storage, path);
    await uploadString(imgRef, dataUrl, "data_url");
    return await getDownloadURL(imgRef);
  } catch (err) {
    console.error("Image upload error:", err);
    if (!err.userMessage) {
      err.userMessage = "Photo upload failed: " + (err?.message || "unknown error");
    }
    throw err;
  }
}

async function saveEntry({ user, text, link, imageFile, entryType, promptCategory = "", promptText = "" }) {
  const imageUrl = await uploadEntryImage(user, imageFile);

  await addDoc(collection(db, "entries"), {
    who: whoFromEmail(user.email),
    text,
    link,
    entryType,
    promptCategory,
    promptText,
    imageUrl,
    createdAt: serverTimestamp(),
    createdAtClient: Date.now(),
    uid: user.uid,
    email: user.email,
  });
}

async function savePromptAnswer() {
  if (isUploading) return;
  const user = auth.currentUser;
  if (!user || !ALLOWED_EMAILS.has(user.email || "")) {
    alert("Sign in first.");
    showTab("signin");
    return;
  }

  if (!currentPromptText) {
    alert("Spin a prompt first, then answer it.");
    return;
  }

  const text = document.getElementById("promptAnswerText").value.trim();
  const link = document.getElementById("promptAnswerLink").value.trim();
  const imageInputLib = document.getElementById("promptAnswerImageLibrary");
  const imageFile = selectedImageFile(imageInputLib);

  if (!text && !link && !imageFile) {
    alert("Add an answer, a link, or a photo first.");
    return;
  }

  setUploadingState(true, "Uploading your answer…", "Adding it to your journal");

  try {
    await saveEntry({
      user,
      text,
      link,
      entryType: "promptAnswer",
      promptCategory: currentPromptCategory,
      promptText: currentPromptText,
      imageFile,
    });

    document.getElementById("promptAnswerText").value = "";
    document.getElementById("promptAnswerLink").value = "";
    if (imageInputLib) imageInputLib.value = "";
    setPhotoStatus("prompt", null);

    // Keep the prompt visible for context but clear the stored prompt association
    setCurrentPrompt("", "");

    showTab("entries");
    setUploadingState(false);
  } catch (err) {
    setUploadingState(false);
    alertSaveError(err);
  }
}

async function saveMemory() {
  if (isUploading) return;
  const user = auth.currentUser;
  if (!user || !ALLOWED_EMAILS.has(user.email || "")) {
    alert("Sign in first.");
    return;
  }

  const text = document.getElementById("memoryText").value.trim();
  const link = document.getElementById("memoryLink").value.trim();
  const imageInputLib = document.getElementById("memoryImageLibrary");
  const imageFile = selectedImageFile(imageInputLib);

  if (!text && !link && !imageFile) {
    alert("Add text, a link, or a photo first.");
    return;
  }

  setUploadingState(true, "Uploading your memory…", "Adding it to your journal");

  try {
    await saveEntry({
      user,
      text,
      link,
      entryType: "memory",
      imageFile,
    });

    document.getElementById("memoryText").value = "";
    document.getElementById("memoryLink").value = "";
    if (imageInputLib) imageInputLib.value = "";
    setPhotoStatus("memory", null);
    setUploadingState(false);
  } catch (err) {
    setUploadingState(false);
    alertSaveError(err);
  }
}

/* ============================
BOOT
============================ */

function setupEventListeners() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });

  document.querySelectorAll("[data-prompt-type]").forEach((button) => {
    button.addEventListener("click", () => spinPrompt(button.dataset.promptType));
  });

  const clickHandlers = {
    openPromptLibraryBtn: openPromptLibrary,
    openMemoryLibraryBtn: openMemoryLibrary,
    savePromptBtn: savePromptAnswer,
    saveMemoryBtn: saveMemory,
    signInBtn: signIn,
    signOutBtn: signOutUser,
    scrollEntriesTopBtn: scrollEntriesTop,
    scrollEntriesBottomBtn: scrollEntriesBottom,
    entryPrevDayBtn: () => scrollEntryDay(-1),
    entryNextDayBtn: () => scrollEntryDay(1),
    loadMoreEntriesBtn: loadMoreEntries,
  };

  for (const [id, handler] of Object.entries(clickHandlers)) {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", handler);
  }

  const feed = document.getElementById("memoryFeed");
  if (feed) {
    feed.addEventListener("click", (event) => {
      const button = event.target.closest(".heartBtn[data-entry-id]");
      if (!button) return;
      toggleHeart(button.dataset.entryId);
    });
  }

  window.addEventListener("scroll", scheduleEntryScrubberSync, { passive: true });
}

onAuthStateChanged(auth, (user) => {
  setAuthUI(user);

  const isAllowed = !!user && ALLOWED_EMAILS.has(user.email || "");

  if (isAllowed) {
    lastSeenTs = loadLastSeenTs(user.email || "");
    startFeedListener();
    updateEntriesBadge();
  } else {
    unseenFromPartner = 0;
    lastPartnerWho = "";
    lastSeenTs = 0;
    updateEntriesBadge();
    if (unsubscribeFeed) unsubscribeFeed();
    unsubscribeFeed = null;
    latestEntryDocs = [];
    renderEntryFeed();
  }
});

setupEventListeners();

// Photo input status/preview
const paLibBoot = document.getElementById("promptAnswerImageLibrary");
if (paLibBoot) {
  paLibBoot.addEventListener("change", () => {
    const f = paLibBoot.files && paLibBoot.files[0] ? paLibBoot.files[0] : null;
    setPhotoStatus("prompt", f);
  });
}

const memLibBoot = document.getElementById("memoryImageLibrary");
if (memLibBoot) {
  memLibBoot.addEventListener("change", () => {
    const f = memLibBoot.files && memLibBoot.files[0] ? memLibBoot.files[0] : null;
    setPhotoStatus("memory", f);
  });
}

// Ensure status starts clean
setPhotoStatus("prompt", null);
setPhotoStatus("memory", null);

// Disable vault inputs until signed in
setAuthUI(null);
showTab("home");
updateEntriesBadge();
