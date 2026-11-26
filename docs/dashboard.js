/* ============================================================
   RRTS Static Dashboard — dashboard.js
   AI-GEN: Claude   AI-DATE: 2026-09-08   AI-REVIEW: Pending human review.

   Loads the build-time JSON produced by src/dashboard/ and drives every
   page: Overview, Station Map, Station Detail, Compare, Download.

   DESIGN CONSTRAINTS (deliberate — see RRTS_Static_Dashboard_Feasibility.md)
   -------------------------------------------------------------------------
   * No external JavaScript. No Leaflet, no Plotly, no Chart.js, no CDN.
     Every chart and the map itself are hand-drawn SVG, so a strict
     `script-src 'self'` CSP holds with no exceptions.
   * The ONLY optional outbound requests are basemap tile IMAGES from Esri /
     ArcGIS. Set DASHBOARD_CONFIG.basemap = "none" to make the page fully
     self-contained (zero external requests), which is what the security
     model in the feasibility doc assumes. If tiles are blocked or fail, the
     map degrades on its own to an offline graticule — it never breaks.
   * The browser never aggregates the full measurement set. All headline
     numbers come pre-computed from dashboard_stats.py.
   ============================================================ */

"use strict";

/* ============================================================
   THEME (light / dark)
   -------------------------------------------------------------------------
   Applied immediately (before DOMContentLoaded) to avoid a flash of the
   wrong theme. Precedence: an explicit user choice saved in localStorage
   always wins; otherwise the dashboard defaults to light, regardless of
   OS-level prefers-color-scheme (intentional: light is the baseline brand
   experience; dark is opt-in only, via the toggle).
   ============================================================ */
const THEME_STORAGE_KEY = "rrts-dashboard-theme";

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch (e) {
    return null;
  }
}
function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (e) {
    /* localStorage unavailable (e.g. private mode) -- theme still applies
       for this page view, it just won't persist across visits. */
  }
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themetoggle");
  if (btn) {
    const isDark = theme === "dark";
    btn.setAttribute("aria-pressed", String(isDark));
    const label = isDark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }
}
(function initThemeEarly() {
  applyTheme(getStoredTheme() || "light");
})();
function initThemeToggle() {
  const btn = document.getElementById("themetoggle");
  if (!btn) return;
  applyTheme(document.documentElement.getAttribute("data-theme") || "light");
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    setStoredTheme(next);
  });
}

/* ============================================================
   CONFIGURATION — the bits an operator is expected to change
   ============================================================ */
const DASHBOARD_CONFIG = {
  // "esri-topo" | "esri-imagery" | "esri-light" | "esri-street" | "none"
  //
  // A real basemap means the published page requests tile images from
  // services.arcgisonline.com. That needs an `img-src` allowance in the
  // page's Content-Security-Policy and is a deviation from the strict
  // `default-src 'none'` posture — confirm before deploying publicly.
  // Set to "none" for a fully self-contained, zero-external-request build.
  basemap: "esri-topo",

  // If your ArcGIS Online organisation issues an API key, put it here and it
  // is appended to tile requests. Keys embedded in a public page MUST be
  // referrer-restricted in the ArcGIS developer console.
  arcgisApiKey: null,

  // Initial view. Overridden by the actual station extent once data loads.
  defaultCenter: { lat: 38.85, lon: -122.95 },
  defaultZoom: 9,

  minZoom: 6,
  maxZoom: 15,
};

const BASEMAPS = {
  "esri-topo": {
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attr: "Esri, USGS, NOAA",
  },
  "esri-imagery": {
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr: "Esri, Maxar, Earthstar Geographics",
  },
  "esri-light": {
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attr: "Esri, HERE, Garmin",
  },
  "esri-street": {
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attr: "Esri, HERE, Garmin, USGS",
  },
  none: { url: null, attr: "" },
};

/* ============================================================
   STATE
   ============================================================ */
const STATE = {
  data: null,          // dashboard_data.json
  dataBase: "",        // "" or "data/" — whichever layout was found
  stationCache: {},    // site_key -> station JSON
  map: {
    center: { ...DASHBOARD_CONFIG.defaultCenter },
    zoom: DASHBOARD_CONFIG.defaultZoom,
    basemap: DASHBOARD_CONFIG.basemap,
    tilesFailed: false,
    tileErrors: 0,
  },
  mapFilters: { source: "", param: "", maxDays: 99999, search: "" },
  stationSort: { key: "records", dir: -1 },
  floodFilters: { search: "", tier: "", source: "" },
  floodSort: { key: "tier", dir: 1 },
  maintFilters: { search: "", flag: "" },
  maintSort: { key: "flag", dir: 1 },
  selectedSite: null,  // site_key
  detail: { station: null, param: null, days: 14, from: "", to: "" },  // from/to: YYYY-MM-DD, UTC
  compare: { param: null, days: 30, sites: [], search: "", from: "", to: "" },
  aquarius: { index: null, site: null, param: null, days: 30, cache: {}, hidden: new Set() },
  explore: { index: null, site: null, param: null, stages: new Set(["S1","S2","S3","S4","S5"]),
    group: null, cache: {}, hidden: new Set(), groupBy: "stages", markers: "overlap",
    sensor: "", telem: "", equip: "", days: 365, from: "", to: "", tableView: false },
  download: { station: null, rows: [], format: "standard" },
};

/* Colour by the role a source system plays in the study. */
const ROLE_COLOR = {
  study: "var(--s1)",
  ref: "var(--s2)",
  wq: "var(--s3)",
};

const STATUS_PILL = {
  live: ["p-live", "Reporting"],
  recent: ["p-recent", "Last 30 d"],
  dormant: ["p-dormant", "Dormant"],
  limited: ["p-limited", "Limited by policy"],
  restricted: ["p-restricted", "Restricted by policy"],
  unknown: ["p-unknown", "No data"],
  setup_pending: ["p-setup-pending", "Station Setup Pending"],
};

const COMPARE_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "#8250c8"];
const AQUARIUS_TIERS = [1, 2, 3, 4, 5];
const TIER_COLORS = { 1: "var(--s1)", 2: "var(--s2)", 3: "var(--s3)", 4: "#8250c8", 5: "#9a6a00" };
// WCAG 1.4.1: every plotted series also differs by line pattern, not colour alone.
const SERIES_DASHES = ["", "7 4", "2 3", "9 3 2 3", "13 4"];
const TIER_DASHES = { 1: "", 2: "7 4", 3: "2 3", 4: "9 3 2 3", 5: "13 4" };
// Explore Study Stations tab: stages keyed by their "S1".."S5" string labels
// (distinct from AQUARIUS_TIERS, which are the numeric general-tier keys).
const EXPLORE_STAGES = ["S1", "S2", "S3", "S4", "S5"];
const STAGE_COLORS = { S1: "var(--s1)", S2: "var(--s2)", S3: "var(--s3)", S4: "#8250c8", S5: "#9a6a00" };
const STAGE_DASHES = { S1: "", S2: "7 4", S3: "2 3", S4: "9 3 2 3", S5: "13 4" };
/* Palette for sensor-combo series on the Explore tab, drawn from the same
   tokens as the stage colours. Each entry pairs a colour with a distinct
   dash so the series stay separable without relying on colour (1.4.1). */
const COMBO_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "#8250c8", "#9a6a00", "var(--neutral)"];
const COMBO_DASHES = ["", "7 4", "2 3", "9 3 2 3", "13 4", "4 2 1 2"];
/** Legend swatch showing a series' colour AND line pattern (decorative; the text names it). */
function lineSwatch(color, dash) {
  return `<svg class="lsw" width="24" height="10" aria-hidden="true" focusable="false">` +
    `<line x1="1" y1="5" x2="23" y2="5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"` +
    `${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg>`;
}

/* Friendly display names for the Aquarius source systems. The raw
   source_system value (e.g. AQUARIUS_S1) is kept intact in the data,
   filters, color roles, and CSV keys — this only changes what the
   user sees. Unknown sources fall through to the raw name. */
const SOURCE_DISPLAY_NAMES = {
  AQUARIUS_S1: "Aquarius Raw Data",
  AQUARIUS_S2: "Aquarius Auto-Calculated",
  AQUARIUS_S3: "Aquarius Auto QA/QC",
  AQUARIUS_S4: "Aquarius Auto+Manual Corrections",
  AQUARIUS_S5: "Aquarius Finalized",
  // The general tabs publish Aquarius as one source (tier S4 plus
  // non-tier history); the build relabels both AQUARIUS.
  AQUARIUS: "Aquarius",
  SONOMA: "Sonoma OneRain",
};
function displayName(src) {
  const key = String(src === null || src === undefined ? "" : src).toUpperCase();
  return SOURCE_DISPLAY_NAMES[key] || src || "—";
}

/* ============================================================
   SMALL HELPERS
   ============================================================ */
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  (kids || []).forEach((c) => e.appendChild(c));
  return e;
}
function txt(t) { return document.createTextNode(String(t)); }

/** Compact number: 1.2M / 12k / 431 */
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  n = Number(n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(n);
}
/** Comma-grouped number */
function cm(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US");
}
/** Fixed to 2 decimal places (hundredths), no grouping/compacting */
function fmt2(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toFixed(2);
}
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
/** Lowercase, ASCII-fold, and collapse to snake_case (used for downloaded file/folder names). */
function slugSnake(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

/** Trigger a same-origin CSV download for `content` at `path` (may include "/" for a subfolder, honored by Chromium-based browsers). */
function saveCsv(path, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
/** "2026-05-04T22:44:00+00:00" -> "2026-05-04 22:44" */
function tsLabel(s) {
  if (!s) return "—";
  return String(s).replace("T", " ").slice(0, 16);
}
function dateOnly(s) { return s ? String(s).slice(0, 10) : "—"; }

/** Which visual family a source system belongs to. */
function role(src) {
  const s = String(src || "").toUpperCase();
  if (s.startsWith("AQUARIUS")) return "study";
  if (["USGS", "CDEC", "NOAA", "SONOMAONERAIN", "SONOMA", "CNRA"].includes(s)) return "ref";
  return "wq";
}
function stationColor(st) {
  return ROLE_COLOR[role(st.source_system)];
}

/** Human-readable label for the location precision.
 *  Driven SOLELY by access_location, the actual data-access policy value
 *  that was applied to this station's coordinates (1 = exact, 2-4 =
 *  Constrained Geomasking to HUC12/10/8, 5 = hidden). Non-Aquarius sources
 *  (USGS, CDEC, NOAA, Sonoma OneRain, CNRA, and so on) are public agency
 *  data and default to access_location = 1 via COALESCE (see
 *  conformed_privacy_view.sql), so they correctly resolve to "Precise"
 *  without any source-specific branching here.
 *  huc_level is NOT used: it is merely "which HUC polygon this point's
 *  coordinates physically fall inside," a spatial-join fact computed for
 *  every station regardless of source or policy (every point sits inside
 *  some HUC polygon), so it can never be trusted to reflect what masking,
 *  if any, was actually applied. (A prior version of this function
 *  preferred huc_level over access_location, which caused precise,
 *  publicly-sourced stations to misleadingly show "In HUC10"/"In HUC12" —
 *  do not reintroduce that.) */
function locationStatusLabel(st) {
  const al = Number(st.access_location);
  if (al === 1) return "Precise";
  if (al === 2) return "In HUC12";
  if (al === 3) return "In HUC10";
  if (al === 4) return "In HUC8";
  if (al === 5) return "Hidden";
  return "—";
}
/** CSS class for the location status pill. See locationStatusLabel for why
 *  this is driven solely by access_location. */
function locationStatusClass(st) {
  const al = Number(st.access_location);
  if (al === 1) return "p-loc-precise";
  if (al >= 2 && al <= 4) return "p-loc-huc";
  if (al === 5) return "p-loc-hidden";
  return "p-loc";
}

function setNote(msg, isError) {
  const n = $("#pagenote");
  if (!msg) { n.classList.add("hidden"); return; }
  n.className = "note" + (isError ? " error" : "");
  n.innerHTML = msg;
}
/** Like setNote(), but scoped to the Download tab's own status region
 * (#dl-page-note) instead of the global #pagenote, so messages about a
 * download only appear while the user is on the Download page. */
function setDownloadNote(msg, isError) {
  const n = $("#dl-page-note");
  if (!n) return;
  if (!msg) { n.classList.add("hidden"); return; }
  n.className = "note compact" + (isError ? " error" : "");
  n.innerHTML = msg;
}
function showLoading(on) {
  $("#loading").classList.toggle("on", !!on);
  const sr = $("#sr-status");
  if (sr) sr.textContent = on ? "Loading…" : "";
}

/* ============================================================
   SCROLL REVEAL (Home / Help & Resources narrative content only)
   -------------------------------------------------------------------------
   Elements marked data-reveal="fade-up|fade-in|scale-in|wipe" in index.html
   fade/slide/scale/wipe into view the first time they cross into the
   viewport. One shared IntersectionObserver drives every element; each one
   is unobserved after its first reveal so re-scrolling never replays it and
   distracts from reading data. Deliberately not applied to any data table,
   chart, or the map, so it can't interfere with live content. Honors
   prefers-reduced-motion via the CSS rule in styles.css (which shows the
   end state immediately with no transition), and also skips entirely if
   IntersectionObserver isn't available, simply leaving content visible.

   The "Scroll down further to view more…" hint is tracked per page (per
   enclosing <section id="p-...">) rather than as one page-wide count, since
   only one section is visible (others are display:none via .hidden) and a
   global unrevealed count could never reach zero while any other tab still
   has un-animated cards. showPage() calls updateScrollHint() on every tab
   switch so the hint re-evaluates for whichever page just became active.
   The hint itself is positioned (not fixed) just under the last revealed
   card on the active page, in the empty space above the next hidden one,
   via updateScrollHint(). */
let _scrollHintState = null;
function initScrollReveal() {
  const els = $$("[data-reveal]");
  const hint = document.getElementById("scrollhint");
  if (!els.length) { _scrollHintState = null; return; }
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-revealed"));
    _scrollHintState = null;
    return;
  }
  // Small stagger within each card group (siblings sharing a parent) so a
  // row of items animates in sequence rather than all at once.
  const groups = new Map();
  els.forEach((el) => {
    const key = el.parentElement;
    const i = groups.get(key) || 0;
    el.style.transitionDelay = (i * 80) + "ms";
    groups.set(key, i + 1);
  });
  const pageOf = (el) => (el.closest("section[id^='p-']") || {}).id || "";
  // initScrollReveal() is re-run after dynamic cards render; only observe
  // cards that have not been revealed yet.
  const pending = els.filter((el) => !el.classList.contains("is-revealed"));
  if (_scrollHintState && _scrollHintState.timer) clearTimeout(_scrollHintState.timer);
  _scrollHintState = { hint, pageOf, els, anchor: null, timer: null };
  updateScrollHint();
  const io = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
      updateScrollHint();
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -5% 0px" });
  pending.forEach((el) => io.observe(el));
  if (!initScrollReveal._wired) {
    initScrollReveal._wired = true;
    window.addEventListener("scroll", () => updateScrollHint(), { passive: true });
    window.addEventListener("resize", () => updateScrollHint());
  }
}

/** Active page name, e.g. "home", derived from the one visible section. */
function activePageName() {
  const s = $$("section[id^='p-']").find((sec) => !sec.classList.contains("hidden"));
  return s ? s.id.slice(2) : null;
}

// Must match the opacity transition on .scroll-hint (base state) in styles.css.
const SCROLL_HINT_FADE_MS = 1400;

/** Remaining (rendered, unrevealed) cards on the active page, plus the card
 *  the hint should sit under. Cards inside a closed panel (display:none, e.g.
 *  the Download Data Preview) can never intersect the viewport, so they are
 *  ignored until the panel opens. */
function scrollHintTarget(st) {
  const active = "p-" + (activePageName() || "");
  const onPage = st.els.filter((el) => st.pageOf(el) === active && el.getClientRects().length > 0);
  const remaining = onPage.filter((el) => !el.classList.contains("is-revealed")).length;
  const revealed = onPage.filter((el) => el.classList.contains("is-revealed"));
  // Under the last revealed card; before any is revealed, under the first.
  const anchor = revealed.length ? revealed[revealed.length - 1] : (onPage[0] || null);
  return { remaining, anchor };
}

function placeScrollHint(st, anchor) {
  if (!anchor) return;
  st.hint.style.top = (window.scrollY + anchor.getBoundingClientRect().bottom + 14) + "px";
}

/** Hides instantly with no fade, used when the active tab changes. */
function resetScrollHint() {
  const st = _scrollHintState;
  if (!st || !st.hint) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  st.anchor = null;
  st.hint.style.transition = "none";
  st.hint.classList.remove("on");
  void st.hint.offsetWidth;
  st.hint.style.transition = "";
}

/** Shows, moves or hides the scroll hint. Every departure (moving on to the
 *  next card, or finishing the page) uses the same slow fade-out: when the
 *  anchor card changes the pill fades out in place, then reappears under the
 *  new card once the fade has finished. */
function updateScrollHint() {
  const st = _scrollHintState;
  if (!st || !st.hint) return;
  const { remaining, anchor } = scrollHintTarget(st);
  if (!remaining) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.anchor = null;
    st.hint.classList.remove("on");
    return;
  }
  if (st.timer) return; // a fade cycle is running; it re-evaluates when done
  const isOn = st.hint.classList.contains("on");
  if (!isOn) {
    placeScrollHint(st, anchor);
    st.anchor = anchor;
    st.hint.classList.add("on");
    return;
  }
  if (anchor !== st.anchor) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      placeScrollHint(st, anchor);
      st.anchor = anchor;
      return;
    }
    st.hint.classList.remove("on");
    st.timer = setTimeout(() => { st.timer = null; updateScrollHint(); }, SCROLL_HINT_FADE_MS);
    return;
  }
  placeScrollHint(st, anchor); // same card: just keep it aligned on layout shifts
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  initThemeToggle();
  initTabs();
  initScrollReveal();
  // Wired up before the data fetch so Help & Resources navigation still
  // works even if loadDashboardData() fails below (it only touches static
  // DOM nodes, not STATE.data).
  initHelpNav();
  try {
    await loadDashboardData();
  } catch (err) {
    setNote(
      `<b>Couldn't load dashboard data.</b> ${esc(err.message)}<br>` +
      `If you're opening <code>index.html</code> straight from disk, browsers block ` +
      `<code>fetch()</code> on <code>file://</code> URLs — serve the folder over HTTP instead, ` +
      `e.g. <code>python -m http.server 8000</code> from this directory, then open ` +
      `<code>http://localhost:8000</code>.`,
      true
    );
    $("#freshtxt").textContent = "No data";
    $("#freshdot").classList.add("stale");
    return;
  }

  renderFreshness();
  renderOverview();
  initMapPage();
  initMaintenancePage();
  initFloodPage();
  initDetailPage();
  initComparePage();
  // Aquarius Tiers tab is archived for now (button + panel commented out in
  // index.html); skip wiring it up so it doesn't touch missing DOM nodes.
  // initAquariusPage();
  initExploreSubnav();
  initExploreFiltersToggle();
  initExplorePage();
  initDownloadPage();
  initDefaultStation();
  initCardKeyboardNav();
}

/**
 * Pre-select a station so that Station Detail and Download tabs show
 * meaningful content immediately instead of an empty "Choose a station"
 * placeholder.
 *
 * Preferred default: the CDEC "RUSSIAN R NR UKIAH" gage (station id "RRU"),
 * a central reference station for the study. If it isn't present in this
 * build's station list (e.g. filtered out by access policy), fall back to
 * the station with the most records, as before.
 */
function initDefaultStation() {
  const stations = (STATE.data.stations || []).slice();
  if (!stations.length) return;

  const preferred = stations.find((s) => {
    const src = String(s.source_system || "").toUpperCase();
    const siteNo = String(s.site_no || "").toUpperCase();
    const siteKey = String(s.site_key || "").toUpperCase();
    const name = String(s.station_name || "").toUpperCase();
    return src === "CDEC" &&
      (siteNo === "RRU" || siteKey === "RRU" || siteKey.includes("RRU") ||
       name.includes("RUSSIAN R NR UKIAH"));
  });

  stations.sort((a, b) => (b.record_count || 0) - (a.record_count || 0));
  const top = preferred || stations[0];
  if (!top || !top.site_key) return;

  // Station Detail: pre-select the preferred (or most-measured) station
  const dSel = $("#detail-station");
  if (dSel) {
    dSel.value = top.site_key;
    if (dSel.value !== top.site_key) {
      dSel.appendChild(new Option(top.station_name || top.site_key, top.site_key));
      dSel.value = top.site_key;
    }
    loadDetail(top.site_key);
  }
}

/**
 * WCAG 2.1.1 / 2.4.3: make card groups (KPI row, etc.) keyboard navigable.
 * Each card gets tabindex="0" and arrow keys move focus between siblings.
 */
function initCardKeyboardNav() {
  // KPI cards
  const kpiRow = $("#kpirow");
  if (kpiRow) {
    const cards = $$(".kpi", kpiRow);
    cards.forEach((c, i) => {
      c.setAttribute("tabindex", "0");
      c.setAttribute("role", "group");
      c.setAttribute("aria-label", c.querySelector(".eyebrow") ? c.querySelector(".eyebrow").textContent + " card" : "Card " + (i + 1));
      c.addEventListener("keydown", (e) => {
        let j = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % cards.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + cards.length) % cards.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = cards.length - 1;
        if (j !== null) { e.preventDefault(); cards[j].focus(); }
      });
    });
  }
}

/**
 * Fetch dashboard_data.json, tolerating both output layouts:
 * the pipeline build writes it at the root, the earlier POC bundle put it
 * under data/. Whichever answers first becomes the base for station files.
 */
async function loadDashboardData() {
  const candidates = ["", "data/"];
  let lastErr = null;
  for (const base of candidates) {
    try {
      const resp = await fetch(base + "dashboard_data.json", { cache: "no-cache" });
      if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status} for ${base || "./"}dashboard_data.json`); continue; }
      STATE.data = await resp.json();
      STATE.dataBase = base;
      return;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("dashboard_data.json not found");
}

async function fetchStation(siteKey) {
  if (STATE.stationCache[siteKey]) return STATE.stationCache[siteKey];
  const safe = String(siteKey).replace(/[^\w\-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const resp = await fetch(`${STATE.dataBase}stations/${encodeURIComponent(safe)}.json`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  STATE.stationCache[siteKey] = data;
  return data;
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function initTabs() {
  const tabs = $$(".tab");
  tabs.forEach((t) => {
    t.addEventListener("click", () => showPage(t.dataset.p));
  });
  wireTabKeys(tabs, (t) => showPage(t.dataset.p));
  syncTabIndex(tabs);
  // WCAG 1.4.13: hover tooltips can be dismissed with Escape. Info-icon
  // tooltips are CSS-only, so dismissal is a class that stays until the
  // pointer or focus leaves that icon.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hideMapTip();
    $$(".tip").forEach((t) => { t.style.opacity = 0; t.classList.remove("on"); });
    $$(".info-icon").forEach((i) => i.classList.add("tip-dismissed"));
    $$(".tab[data-tip]").forEach((t) => t.classList.add("tip-dismissed"));
  });
  const undismiss = (e) => {
    const icon = e.target.closest && e.target.closest(".info-icon");
    if (icon && !icon.contains(e.relatedTarget)) icon.classList.remove("tip-dismissed");
    const tab = e.target.closest && e.target.closest(".tab[data-tip]");
    if (tab && !tab.contains(e.relatedTarget)) tab.classList.remove("tip-dismissed");
  };
  document.addEventListener("pointerout", undismiss);
  document.addEventListener("focusout", undismiss);
}

/** Left/Right/Home/End move between tabs and activate them (ARIA tabs pattern). */
function wireTabKeys(tabs, activate) {
  tabs.forEach((t, i) => t.addEventListener("keydown", (e) => {
    const last = tabs.length - 1;
    const j = e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (j === null) return;
    e.preventDefault();
    tabs[j].focus();
    activate(tabs[j]);
  }));
}

/** Only the selected tab is in the Tab order; arrows move within the tablist. */
/**
 * Explore Study Stations sub-toggle: three sections share the tab. The
 * Aquarius study stations overview is shown by default; the other two
 * (station pump status, explore study stations data) appear on demand.
 */
/** Collapse or expand the Explore "Choose what to compare" filters card. Title and subtitle stay visible. */
function initExploreFiltersToggle() {
  const btn = $("#exp-filters-toggle");
  const body = $("#exp-filters-body");
  if (!btn || !body) return;
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    body.classList.toggle("hidden", !open);
  });
}

function showExploreSub(name) {
  $$("#exp-sub-seg .seg").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sub === name)));
  $$("[data-sub-panel]").forEach((el) => el.classList.toggle("hidden", el.dataset.subPanel !== name));
  // Charts drawn while their container was hidden have no width, so redraw
  // the stage comparison once its section is visible.
  if (name === "data" && STATE.explore.index) renderExplore();
}

function initExploreSubnav() {
  $$("#exp-sub-seg .seg").forEach((b) => b.addEventListener("click", () => showExploreSub(b.dataset.sub)));
  showExploreSub("overview");
}

/* ============================================================
   STATION LINKS AND STATION COMBOBOX
   ============================================================ */
/**
 * Link that opens Station Detail for a station. List rows only carry
 * site_no and source_system, so the station is looked up in STATE.data.stations.
 * Falls back to plain text when no matching station exists.
 * `label` is the visible text; `ariaName` names the station for screen readers.
 */
function stationLink(siteNo, sourceSystem, label, ariaName) {
  const stations = STATE.data.stations || [];
  const src = String(sourceSystem || "").toUpperCase();
  const st = stations.find((s) => String(s.site_no) === String(siteNo) &&
      (!src || String(s.source_system || "").toUpperCase() === src)) ||
    stations.find((s) => String(s.site_no) === String(siteNo));
  if (!st || !st.site_key) return esc(label);
  const aria = ariaName ? ` aria-label="${esc(`${label}: ${ariaName}`)}"` : "";
  return `<a href="#station-detail" class="stlink" data-site-key="${esc(st.site_key)}"${aria}>${esc(label)}</a>`;
}

/* Capture phase, so a link inside a clickable table row opens the detail page
   without also triggering the row's own select handler. */
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a.stlink");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  STATE.selectedSite = a.dataset.siteKey;
  goToStationDetail();
}, true);

/**
 * Typeable station picker (ARIA 1.2 combobox with a listbox popup) layered
 * over a <select>. The select stays in the DOM, hidden, as the source of
 * truth, so existing change handlers keep working: choosing an item sets
 * select.value and dispatches a bubbling "change" event.
 * Keys: ArrowDown/ArrowUp move, Enter chooses, Escape closes (a second Escape
 * restores the current station), Tab leaves.
 */
function makeStationCombo(sel) {
  if (!sel || sel._combo) return;
  const id = sel.id;
  const MAX_SHOWN = 100;
  const wrap = document.createElement("div");
  wrap.className = "combo";
  const input = document.createElement("input");
  input.type = "text";
  input.id = `${id}-combo`;
  input.className = "txt combo-input";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", `${id}-list`);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.placeholder = "Type to search stations\u2026";
  const list = document.createElement("ul");
  list.id = `${id}-list`;
  list.className = "combo-list hidden";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Matching stations");
  const status = document.createElement("div");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  wrap.append(input, list, status);
  sel.parentNode.insertBefore(wrap, sel);
  sel.classList.add("hidden");
  sel.setAttribute("aria-hidden", "true");
  sel.tabIndex = -1;
  const lab = document.querySelector(`label[for="${id}"]`);
  if (lab) lab.setAttribute("for", input.id);

  let matches = [];
  let active = -1;

  const items = () => [...sel.options].filter((o) => o.value).map((o) => ({ value: o.value, label: o.text }));
  const currentLabel = () => {
    const o = sel.selectedOptions && sel.selectedOptions[0];
    return o && o.value ? o.text : "";
  };
  const isOpen = () => !list.classList.contains("hidden");
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute("aria-selected", String(n === i)));
    if (i >= 0 && list.children[i]) {
      input.setAttribute("aria-activedescendant", list.children[i].id);
      list.children[i].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };
  const close = () => {
    list.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const render = (query) => {
    const q = query.trim().toLowerCase();
    const all = items();
    const found = q ? all.filter((it) => it.label.toLowerCase().includes(q)) : all;
    matches = found.slice(0, MAX_SHOWN);
    list.innerHTML = matches.length
      ? matches.map((it, n) => `<li role="option" id="${id}-opt-${n}" aria-selected="false" data-value="${esc(it.value)}">${esc(it.label)}</li>`).join("")
      : '<li class="combo-empty" role="presentation">No stations match.</li>';
    list.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    setActive(matches.length && q ? 0 : -1);
    status.textContent = matches.length
      ? `${found.length} station${found.length === 1 ? "" : "s"} found${found.length > MAX_SHOWN ? `, showing the first ${MAX_SHOWN}` : ""}.`
      : "No stations match.";
  };
  const choose = (it) => {
    if (!it) return;
    sel.value = it.value;
    input.value = it.label;
    close();
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const sync = () => { input.value = currentLabel(); };

  input.addEventListener("focus", () => { input.select(); });
  input.addEventListener("click", () => { if (!isOpen()) render(""); });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen()) { render(input.value === currentLabel() ? "" : input.value); }
      if (matches.length) setActive((active + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) { render(input.value === currentLabel() ? "" : input.value); }
      if (matches.length) setActive(active <= 0 ? matches.length - 1 : active - 1);
    } else if (e.key === "Enter") {
      if (isOpen() && matches.length) {
        e.preventDefault();
        choose(matches[active >= 0 ? active : 0]);
      }
    } else if (e.key === "Escape") {
      if (isOpen()) { e.preventDefault(); close(); } else { sync(); }
    } else if (e.key === "Tab") {
      close();
    }
  });
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-value]");
    if (li) choose(matches.find((it) => it.value === li.dataset.value));
  });
  wrap.addEventListener("focusout", (e) => {
    if (wrap.contains(e.relatedTarget)) return;
    close();
    sync();
  });

  sel._combo = { sync };
  sync();
}

function syncStationCombo(sel) {
  if (sel && sel._combo) sel._combo.sync();
}

function syncTabIndex(tabs) {
  tabs.forEach((t) => { t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1; });
}
function showPage(name) {
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.p === name)));
  syncTabIndex($$(".tab"));
  $$("section").forEach((s) => s.classList.toggle("hidden", s.id !== "p-" + name));
  window.scrollTo(0, 0);
  resetScrollHint();
  updateScrollHint();
  if (name === "map") requestAnimationFrame(renderMap);
  // Preselect the station clicked on the Station Map page in the Compare picker.
  if (name === "compare" && STATE.selectedSite) {
    const key = STATE.selectedSite;
    const station = (STATE.data.stations || []).find((s) => s.site_key === key);
    if (station && (!STATE.compare.param || (station.parameters || []).includes(STATE.compare.param))) {
      if (!STATE.compare.sites.includes(key) && STATE.compare.sites.length < 4) {
        STATE.compare.sites.push(key);
        renderComparePicker();
        renderCompare();
        updateCompareDownloadBtn();
      }
    }
  }
  // Aquarius Tiers tab is archived; STATE.aquarius.index is never populated
  // while initAquariusPage() is not called, so this is a no-op guard.
  if (name === "aquarius" && STATE.aquarius.index) renderAquarius();
  if (name === "explore" && STATE.explore.index && !$("#exp-sub-data").classList.contains("hidden")) renderExplore();
}

/**
 * Help & Resources "Dashboard Guide" entries and the Home page's overlay
 * shortcut buttons both jump to another tab; keep the tablist's
 * aria-selected/roving-tabindex state in sync when they're used.
 */
function initHelpNav() {
  $$(".help-nav-item, .home-action").forEach((el) => {
    const go = () => {
      const target = $(`.tab[data-p="${el.dataset.p}"]`);
      showPage(el.dataset.p);
      if (target) target.focus();
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

function renderFreshness() {
  const meta = STATE.data.build_metadata || {};
  const ov = STATE.data.overview || {};
  const built = meta.build_timestamp_utc;
  $("#freshtxt").textContent = built ? `Last build ${tsLabel(built)} UTC` : "Build time unknown";

  // Flag a stale build (>48 h) rather than quietly showing old numbers.
  if (built) {
    const age = (Date.now() - new Date(built).getTime()) / 86400000;
    if (age > 2) {
      $("#freshdot").classList.add("stale");
      $("#freshtxt").textContent += ` · ${Math.round(age)} d old`;
    }
  }
  const internalNote = $("#internalnote");
  if (meta.fallback_reason) {
    setNote(`<b>Fallback source used for this build.</b> ${esc(meta.fallback_reason)}`);
  }
  const dbEnv = (meta.db_env || "").toUpperCase();
  if (meta.build_mode === "internal" && dbEnv !== "PROD") {
    internalNote.innerHTML =
      `<b>Internal built.</b> (<code>${esc(meta.db_env || "—")}</code>); ` +
      `features subject to change.`;
    internalNote.classList.toggle("testenv", dbEnv === "TEST");
    internalNote.classList.remove("hidden");
  } else if (internalNote) {
    internalNote.classList.add("hidden");
  }
  if (ov.station_count) $("#statussub").textContent = `All ${cm(ov.station_count)} station records`;
}

/* ============================================================
   OVERVIEW
   ============================================================ */
function renderOverview() {
  const ov = STATE.data.overview || {};
  const stations = STATE.data.stations || [];
  const meta = STATE.data.build_metadata || {};

  const stationCount = ov.station_count || stations.length;
  const reporting = ov.reporting_30d || 0;
  const pct = stationCount ? Math.round((reporting / stationCount) * 100) : 0;
  const start = ov.period_start_utc, end = ov.period_end_utc;
  const period = start && end ? `${start.slice(0, 4)}–${end.slice(0, 4)}` : "—";

  const KPI_TIPS = {
    "Monitoring stations": "Total number of stations in the study network across all source systems",
    "Reporting in last 30 d": "Stations with at least one reading in the past 30 days, as a percentage of the full network",
    "Measurements": "Total number of parameter readings collected across all stations and the full period of record",
    "Parameters tracked": "Number of distinct measurement parameter codes (e.g., streamflow, water level, temperature)",
    "Period of record": "Date range from the first reading to the most recent reading in the dataset",
  };
  $("#kpirow").innerHTML = [
    ["Monitoring stations", cm(stationCount),
      `${cm(ov.source_count || 0)} source system${(ov.source_count || 0) === 1 ? "" : "s"}`],
    ["Reporting in last 30 d", cm(reporting), `${pct}% of the network`],
    ["Measurements", fmt(ov.measurement_count || 0), ov.withheld_count
      ? `${cm(ov.withheld_count)} more withheld by data-sharing agreements`
      : "All parameters, full record"],
    ["Parameters tracked", cm(ov.parameter_count || 0), "Distinct parameter codes"],
    ["Period of record", period, start ? `First reading ${dateOnly(start)}` : "No readings"],
  ].map(([l, v, c]) => {
    const tip = KPI_TIPS[l] || l;
    return `<div class="kpi"><span class="info-icon" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">i</span><div class="eyebrow">${esc(l)}</div><div class="v">${v}</div><div class="c">${esc(c)}</div></div>`;
  }).join("");

  // ---- reporting activity by source ----
  const bySource = (ov.by_source || []).slice();
  if (bySource.length) {
    hbars($("#srcchart"), bySource.map((s) => ({
      l: displayName(s.source_system),
      v: s.station_count,
      t: `${cm(s.station_count)} stations · ${cm(s.reporting_30d)} reporting`,
      c: ROLE_COLOR[role(s.source_system)],
    })), "Reporting activity by source");
  } else {
    $("#srcchart").innerHTML = '<div class="placeholder">No source breakdown in this build.</div>';
  }

  // ---- network status ----
  const bs = ov.by_status || {};
  const statusRows = [
    { l: "Reporting (24 h)", v: bs.live || 0, c: "var(--good)" },
    { l: "Last 30 days", v: bs.recent || 0, c: "var(--warn-mark)" },
    { l: "Dormant (>30 d)", v: bs.dormant || 0, c: "var(--neutral)" },
    { l: "Limited by policy", v: bs.limited || 0, c: "var(--policy-mark)" },
    { l: "Restricted by policy", v: bs.restricted || 0, c: "var(--crit)" },
  ];
  if (bs.setup_pending) statusRows.push({ l: "Setup pending", v: bs.setup_pending, c: "#6b7b8d" });
  if (bs.unknown) statusRows.push({ l: "No readings", v: bs.unknown, c: "var(--nodata-mark)" });
  hbars($("#statuschart"), statusRows, "Network status");

  renderPumpingStatus();
  initAquariusAccessSearch();
  renderAquariusAccess();

  // ---- most-measured parameters ----
  const params = ov.top_parameters || [];
  if (params.length) {
    hbars($("#paramchart"), params.map((p) => ({
      l: (p.parameter_desc || p.parameter_cd || "") + (p.unit ? " (" + p.unit + ")" : ""),
      v: p.measurement_count,
      t: `${cm(p.measurement_count)} (records)`,
      c: "var(--s1)",
    })), "Top 4 most-measured parameters");
  } else {
    $("#paramchart").innerHTML = '<div class="placeholder">No parameter totals in this build.</div>';
  }
}

/* Diversions and underflow wells by pumping state (dashboard_stats.pumping_status).
   Pumping is a white disc and not pumping a black one, each outlined and
   always labelled in text (WCAG 1.4.1); no recent data is a dashed ring. */
const PUMP_STATE = {
  pumping: ["on", "p-pump-on", "Pumping"],
  not_pumping: ["off", "p-pump-off", "Not pumping"],
  no_data: ["nodata", "p-unknown", "No recent data"],
};
const PUMP_TYPE_LABEL = { diversion: "Diversion", underflow_well: "Underflow well" };

/** The build decides the state, but a page can be viewed long after its
 *  build: a reading that has since gone stale is shown as no recent data. */
function pumpState(p) {
  const staleHours = (STATE.data.overview || {}).pumping_status?.stale_after_hours || 3;
  const latest = p.latest_reading_utc ? new Date(p.latest_reading_utc).getTime() : NaN;
  if (!isFinite(latest) || (Date.now() - latest) / 3600000 > staleHours) return "no_data";
  return p.state;
}

/** Pumping entry for a station, or null if it has none. */
function pumpingFor(siteNo) {
  const list = ((STATE.data.overview || {}).pumping_status || {}).stations || [];
  return list.find((p) => p.site_no === siteNo) || null;
}

/** "35 min" / "5 h" / "3 d" for a span in milliseconds (non-breaking, so it never wraps mid-span). */
function spanLabel(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

function renderPumpingStatus() {
  const ps = (STATE.data.overview || {}).pumping_status;
  const grid = $("#pumpgrid");
  if (!grid) return;
  if (!ps) {
    grid.innerHTML = '<div class="placeholder">No pumping status in this build.</div>';
    $("#pumpnote").textContent = "";
    return;
  }
  const list = (ps.stations || []).map((p) => ({ ...p, shown: pumpState(p) }));
  const counts = { pumping: 0, not_pumping: 0, no_data: 0 };
  list.forEach((p) => { counts[p.shown] += 1; });
  $("#pumpsub").textContent = list.length
    ? `${cm(counts.pumping)} pumping · ${cm(counts.not_pumping)} not pumping · ${cm(counts.no_data)} no recent data`
    : "Latest published flow reading at each station";

  const now = Date.now();
  grid.innerHTML = list.length ? list.map((p) => {
    const [dot, , label] = PUMP_STATE[p.shown] || PUMP_STATE.no_data;
    const name = p.station_name || p.site_no;
    // "for 20 h (since 2026-11-09 23:25 UTC)"; "at least" when the run reaches
    // back to the first reading or to a gap, so its true start isn't known.
    const since = p.since_utc
      ? `for ${p.since_is_lower_bound ? "at least " : ""}${spanLabel(now - new Date(p.since_utc).getTime())}` +
        ` (since ${tsLabel(p.since_utc)} UTC)`
      : "";
    const lines = [];
    if (p.shown === "pumping") lines.push(`Pumping ${since}`);
    if (p.shown === "not_pumping") lines.push(`Off ${since}`);
    if (p.shown !== "pumping") {
      lines.push(p.last_pumped_utc ? `Last pumped ${tsLabel(p.last_pumped_utc)} UTC` : "No pumping in the published record");
    }
    lines.push(`Latest reading ${tsLabel(p.latest_reading_utc)} UTC · ${num(p.latest_flow_cfs) === null ? "—" : num(p.latest_flow_cfs).toFixed(2)} cfs`);
    if (num(p.water_year_volume_af) !== null) {
      const cov = num(p.water_year_coverage_pct);
      lines.push(`Water year to date ≈ ${num(p.water_year_volume_af).toFixed(2)} AF` +
        (cov !== null && cov < 95 ? ` (readings cover ${cov.toFixed(0)}% of the water year)` : ""));
    }
    return `<div role="listitem"><button type="button" class="pumptile" data-key="${esc(p.site_key || "")}"
        aria-label="${esc(`${name} (${p.site_no}): ${label}. ${lines.join(". ")}. Open station detail.`)}">
      <i class="pumpdot ${dot}" aria-hidden="true"></i>
      <span class="pt-body">
        <span class="pt-name">${esc(name)}</span>
        <span class="sid">${esc(p.site_no)} · ${esc(PUMP_TYPE_LABEL[p.station_type] || "")}</span>
        <span class="pt-state">${esc(label)}</span>
        ${lines.map((l) => `<span class="pt-meta">${esc(l)}</span>`).join("")}
      </span>
    </button></div>`;
  }).join("") : '<div class="placeholder">No diversion or underflow well is publishing flow readings yet.</div>';

  $$("#pumpgrid .pumptile").forEach((b) => b.addEventListener("click", () => {
    if (!b.dataset.key) return;
    STATE.selectedSite = b.dataset.key;
    goToStationDetail();
  }));

  const notes = [];
  if (ps.withheld_count) notes.push(`${cm(ps.withheld_count)} station${ps.withheld_count === 1 ? "" : "s"} not shown under data-sharing agreements.`);
  if (ps.not_reporting_count) notes.push(`${cm(ps.not_reporting_count)} more will appear as their flow telemetry comes online.`);
  notes.push(`A station with no flow reading in the last ${cm(ps.stale_after_hours || 3)} hours shows as no recent data.`);
  notes.push("Water-year volume is an estimate from telemetered flow since October 1, in acre-feet (AF); it is not an official diversion report.");
  $("#pumpnote").textContent = notes.join(" ");
}

/* Aquarius stations by what the data access policy lets the dashboard
   publish (dashboard_stats._aquarius_access). */
const AQ_ACCESS = [
  ["reporting", "Live reporting", "var(--good)"],
  ["partial", "Partially published", "var(--warn-mark)"],
  ["restricted", "Data not published", "var(--crit)"],
  ["setup_pending", "Setup pending", "#6b7b8d"],
];
function renderAquariusAccess() {
  const aq = (STATE.data.overview || {}).aquarius_access || {};
  const list = aq.stations || [];
  if (!list.length) {
    $("#aqaccesschart").innerHTML = '<div class="placeholder">No Aquarius stations in this build.</div>';
    $("#aqaccesslist").innerHTML = "";
    $("#aq-station-count").textContent = "";
    return;
  }
  // "Partially published" and "Setup pending" only appear when their count is non-zero.
  hbars($("#aqaccesschart"), AQ_ACCESS.filter(([key]) => (key !== "partial" && key !== "setup_pending") || aq[key])
    .map(([key, l, c]) => ({
      l, v: aq[key] || 0, t: `${cm(aq[key] || 0)} station${aq[key] === 1 ? "" : "s"}`, c,
    })), "Aquarius stations by data access");
  const label = Object.fromEntries(AQ_ACCESS.map(([key, l]) => [key, l]));
  const pillClass = { reporting: "p-live", partial: "p-limited", restricted: "p-restricted", setup_pending: "p-setup-pending" };

  const searchEl = $("#aq-station-search");
  const search = ((searchEl && searchEl.value) || "").trim().toLowerCase();
  const filtered = search
    ? list.filter((s) => `${s.station_name || ""} ${s.site_no || ""}`.toLowerCase().includes(search))
    : list;

  $("#aq-station-count").textContent = search
    ? `(${cm(filtered.length)} of ${cm(list.length)})`
    : `(${cm(list.length)})`;

  $("#aqaccesslist").innerHTML = `<table>
    <thead><tr><th class="num">#</th><th>Station</th><th>Publication</th><th>Readings published</th><th>Restrictions</th></tr></thead>
    <tbody>${filtered.length ? filtered.map((s, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><b>${stationLink(s.site_no, "AQUARIUS", s.station_name || s.site_no)}</b><br><span class="sid">${esc(s.site_no)}</span></td>
      <td><span class="pill ${pillClass[s.category] || ""}">${esc(label[s.category] || s.category)}</span></td>
      <td>${cm(s.visible_count)}</td>
      <td>${(s.reasons || []).length ? esc(s.reasons.join("; ")) : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="5"><div class="placeholder">No stations match${search ? ` "${esc(search)}"` : ""}.</div></td></tr>`}</tbody>
  </table>`;
}

/* Wires the Aquarius station-list search box once; re-renders just the
   table/count (not the chart) as the user types. Safe to call multiple
   times — guarded so the listener is only attached once. */
let _aqSearchWired = false;
function initAquariusAccessSearch() {
  if (_aqSearchWired) return;
  const searchEl = $("#aq-station-search");
  if (!searchEl) return;
  searchEl.addEventListener("input", renderAquariusAccess);
  _aqSearchWired = true;
}

/**
 * "Current conditions" cards — the latest actual reading of each headline
 * parameter, from the most recently reporting station carrying it.
 *
 * Unlike the mockup, which hard-coded Hopland gage height and friends, the
 * parameters and the lead station are chosen at build time from the data, so
 * the cards stay meaningful as the network changes. Values come pre-selected
 * from dashboard_stats.latest_conditions — the browser never scans the
 * measurement set to find them.
 */
function renderConditionCards() {
  const ov = STATE.data.overview || {};
  const conditions = ov.latest_conditions || [];
  const box = $("#condrow");

  if (!conditions.length) { box.innerHTML = ""; return; }

  const colors = ["var(--s1)", "var(--s2)", "var(--s3)"];
  box.innerHTML = conditions.map((c, i) => {
    const color = colors[i % colors.length];
    const v = num(c.value);
    const shown = v === null ? "—" : Math.abs(v) >= 100 ? cm(Math.round(v)) : v.toFixed(2);
    const where = c.anonymized ? "location-restricted station" : (c.station_name || c.site_no || "—");
    return `<div class="condcard">
      <div class="chipline"><i class="swatch" style="background:${color}"></i>${esc(c.parameter_desc || c.parameter_cd)}</div>
      <div class="condtop"><span class="n">${shown}</span><span class="u">${esc(c.unit || "")}</span></div>
      <div class="condmeta">
        ${esc(where)} · ${esc(tsLabel(c.timestamp_utc))} UTC<br>
        ${cm(c.reporting_station_count)} station${c.reporting_station_count === 1 ? "" : "s"} reporting this parameter
      </div>
      ${(c.series || []).length > 1 ? `<div style="margin-top:9px">${spark(c.series.map(num), color)}</div>` : ""}
    </div>`;
  }).join("");
}

/** Horizontal bar chart (SVG). rows: {l, v, t?, c?} */
function hbars(mount, rows, label) {
  if (!mount) return;
  if (!rows || !rows.length) { mount.innerHTML = '<div class="placeholder">No data.</div>'; return; }
  const W = 560, rowH = 30, H = rows.length * rowH + 8, LB = 150;
  const mx = Math.max(...rows.map((r) => r.v), 1);
  // WCAG 1.1.1: the chart is announced as one image whose name lists every bar.
  const summary = `${label || "Bar chart"}: ` + rows.map((r) => `${r.l}, ${r.t || cm(r.v)}`).join("; ");
  const s = el("svg", { viewBox: `0 0 ${W} ${H}`, style: `height:${H}px`, role: "img", "aria-label": summary });
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const bw = Math.max(2, (r.v / mx) * (W - LB - 96));
    const label = String(r.l).length > 24 ? String(r.l).slice(0, 23) + "…" : String(r.l);
    const lbl = el("text", { x: LB - 9, y: y + 15, "text-anchor": "end", class: "tick" }, [txt(label)]);
    lbl.appendChild(el("title", {}, [txt(String(r.l))]));
    s.appendChild(lbl);
    s.appendChild(el("rect", { x: LB, y: y + 3.5, width: bw.toFixed(1), height: 15, rx: 4, fill: r.c || "var(--s1)" }));
    s.appendChild(el("text", { x: LB + bw + 7, y: y + 15, class: "tick" }, [txt(r.t || cm(r.v))]));
  });
  mount.innerHTML = "";
  mount.appendChild(s);
}

/** Sparkline for a numeric series. */
function spark(values, color) {
  const v = values.filter((x) => x !== null && isFinite(x));
  if (v.length < 2) return "";
  const w = 250, h = 34, mn = Math.min(...v), mx = Math.max(...v), r = (mx - mn) || 1;
  const p = v.map((y, i) => [i / (v.length - 1) * w, h - 2 - (y - mn) / r * (h - 6)]);
  const d = p.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
  const area = `M0 ${h} ` + d.slice(1).replace(/^M/, "L") + ` L${w} ${h} Z`;
  const lastPt = p[p.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:34px" aria-hidden="true" focusable="false">
    <path d="${area}" fill="${color}" opacity=".10"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="3.2" fill="${color}" stroke="#fff" stroke-width="1.6"/>
  </svg>`;
}

/* ============================================================
   MAP — Web Mercator, hand-rolled
   ------------------------------------------------------------
   A minimal slippy-map: basemap tiles are positioned <img> elements and
   stations are an SVG overlay. No mapping library, so the page loads no
   third-party script; if tiles are blocked the graticule takes over.
   ============================================================ */

function project(lat, lon, z) {
  const scale = 256 * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin((lat * Math.PI) / 180)));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}
function unproject(x, y, z) {
  const scale = 256 * Math.pow(2, z);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

/**
 * Populate the map parameter dropdown based on the selected source.
 * If a specific source is selected, only parameters available at stations
 * of that source are shown. If "All sources" is selected, all parameters
 * from the overview are shown. Preserves the current selection if still valid.
 */
function populateMapParamOptions(source) {
  const paramSel = $("#map-param");
  if (!paramSel) return;
  const prevValue = paramSel.value;

  // Build the parameter list
  let paramList;
  if (source) {
    // Union of parameters across all stations of the selected source
    const stations = (STATE.data.stations || []).filter((s) => s.source_system === source);
    const byCode = new Map();
    stations.forEach((s) => (s.parameters || []).forEach((code) => {
      if (!code) return;
      const key = String(code);
      if (!byCode.has(key)) byCode.set(key, { parameter_cd: key, parameter_desc: key });
    }));
    // Resolve descriptions from the global parameter dimension
    const dimByCode = new Map((STATE.data.parameters || []).map((p) => [String(p.parameter_cd), p]));
    paramList = [...byCode.values()].map((p) => {
      const dim = dimByCode.get(p.parameter_cd);
      return dim || p;
    });
  } else {
    // All parameters from the overview
    const ovp = STATE.data.overview || {};
    paramList = ovp.parameters || ovp.top_parameters || [];
  }

  // Rebuild the dropdown
  paramSel.innerHTML = "";
  paramSel.appendChild(new Option("All parameters", ""));
  paramList.forEach((p) => {
    paramSel.appendChild(new Option(p.parameter_desc || p.parameter_cd, p.parameter_cd));
  });

  // Restore previous selection if still valid
  if (prevValue && [...paramSel.options].some((o) => o.value === prevValue)) {
    paramSel.value = prevValue;
  } else {
    paramSel.value = "";
    STATE.mapFilters.param = "";
  }
}

function initMapPage() {
  const stations = STATE.data.stations || [];

  // Source + parameter filters
  const srcSel = $("#map-source");
  [...new Set(stations.map((s) => s.source_system).filter(Boolean))].sort().forEach((s) => {
    srcSel.appendChild(new Option(displayName(s), s));
  });
  const paramSel = $("#map-param");
  // Populate the parameter dropdown dynamically based on the selected source.
  populateMapParamOptions("");

  srcSel.addEventListener("change", () => {
    STATE.mapFilters.source = srcSel.value;
    populateMapParamOptions(srcSel.value);
    renderMap(); renderStationTable();
  });
  paramSel.addEventListener("change", () => { STATE.mapFilters.param = paramSel.value; renderMap(); renderStationTable(); });
  $("#map-search").addEventListener("input", (e) => {
    STATE.mapFilters.search = e.target.value.trim().toLowerCase();
    renderMap(); renderStationTable();
  });
  $$("#recencyseg .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#recencyseg .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    STATE.mapFilters.maxDays = Number(b.dataset.d);
    renderMap(); renderStationTable();
  }));

  const bmSel = $("#basemap-select");
  bmSel.value = STATE.map.basemap;
  bmSel.addEventListener("change", () => {
    STATE.map.basemap = bmSel.value;
    STATE.map.tilesFailed = false;
    STATE.map.tileErrors = 0;
    renderMap();
  });

  $("#zoomin").addEventListener("click", () => zoomBy(1));
  $("#zoomout").addEventListener("click", () => zoomBy(-1));
  $("#zoomfit").addEventListener("click", () => { fitToStations(); renderMap(); });
  // WCAG 2.5.7: a single-pointer, non-drag way to pan.
  $$(".mappan button").forEach((b) => b.addEventListener("click", () => {
    const [x, y] = b.dataset.pan.split(",").map(Number);
    panBy(x * PAN_STEP, y * PAN_STEP);
  }));
  initMapTip();

  $$("th.sortable", $("#p-map")).forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    STATE.stationSort = {
      key,
      dir: STATE.stationSort.key === key ? -STATE.stationSort.dir : (key === "name" ? 1 : -1),
    };
    renderStationTable();
  }));

  // Green "View Selected in Station Detail Page" button
  const viewBtn = $("#view-selected-btn");
  if (viewBtn) viewBtn.addEventListener("click", goToStationDetail);

  initMapInteraction();
  fitToStations();
  renderMap();
  renderStationTable();
  updateViewSelectedBtn();
}

function mappableStations() {
  return (STATE.data.stations || []).filter(
    (s) => num(s.latitude) !== null && num(s.longitude) !== null
  );
}

function fitToStations() {
  const pts = mappableStations().filter(inStudyArea);
  if (!pts.length) return;
  const lats = pts.map((s) => num(s.latitude)), lons = pts.map((s) => num(s.longitude));
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const area = $("#maparea");
  const w = area ? area.clientWidth || 760 : 760;
  const h = area ? area.clientHeight || 620 : 620;

  // Fractional zoom: the largest zoom at which the station extent plus a fixed
  // pixel margin still fits the map. The margin is in pixels (not a percentage)
  // because pins and halos are a fixed pixel size at every zoom; it keeps the
  // largest halo (16.9 px) and its pin fully visible at the edges.
  const FIT_MARGIN_PX = 40;
  const z0 = DASHBOARD_CONFIG.maxZoom;
  const a = project(maxLat, minLon, z0), b = project(minLat, maxLon, z0);
  const spanX = Math.max(1, Math.abs(b.x - a.x)), spanY = Math.max(1, Math.abs(b.y - a.y));
  const k = Math.min(Math.max(1, w - 2 * FIT_MARGIN_PX) / spanX, Math.max(1, h - 2 * FIT_MARGIN_PX) / spanY);
  const z = z0 + Math.log2(k);
  STATE.map.zoom = Math.max(DASHBOARD_CONFIG.minZoom, Math.min(DASHBOARD_CONFIG.maxZoom, z));

  // Center on the midpoint of the extent in projected (screen) space.
  const mid = unproject((a.x + b.x) / 2, (a.y + b.y) / 2, z0);
  STATE.map.center = { lat: mid.lat, lon: mid.lon };
}

/**
 * Bounding box for the Russian + Eel study watersheds. Stations outside it —
 * coordinate sentinels like -88,-88, bench-test rigs, and the NOAA Bay Area
 * tide gages — are excluded from the map and counted in the footnote rather
 * than silently dropped, so they don't stretch the default view.
 *
 * The bounds are deliberately padded by ~0.5° beyond the true watershed
 * extent so that ACCESS_LOCATION = 4 stations (coordinates displaced up to
 * 146 km via Constrained Geomasking, ~HUC8) near the boundary are not
 * silently excluded. A station at lat 38.3 could be displaced to 38.0,
 * which would fall outside a tight 38.2 lower bound.
 */
const STUDY_BOUNDS = { minLat: 37.5, maxLat: 41.0, minLon: -125.0, maxLon: -121.9 };

function inStudyArea(s) {
  const lat = num(s.latitude), lon = num(s.longitude);
  if (lat === null || lon === null) return false;
  return lat >= STUDY_BOUNDS.minLat && lat <= STUDY_BOUNDS.maxLat
      && lon >= STUDY_BOUNDS.minLon && lon <= STUDY_BOUNDS.maxLon;
}

const PAN_STEP = 100; // px, per arrow key or pan button press

function panBy(dx, dy) {
  const c = project(STATE.map.center.lat, STATE.map.center.lon, STATE.map.zoom);
  const p = unproject(c.x + dx, c.y + dy, STATE.map.zoom);
  STATE.map.center = { lat: p.lat, lon: p.lon };
  renderMap();
}

/* ------------------------------------------------------------
   Animated re-centering (e.g. when a station is selected from the
   table). Straight-line interpolation in projected pixel space, so
   the motion looks like a pan at the current zoom rather than a
   jump in lat/lon space (which would curve/skew near the poles —
   irrelevant here, but pixel space is also just cheaper to ease).

   WCAG 2.3.3 (AAA) / general motion-sensitivity consideration:
   honour prefers-reduced-motion by snapping instantly instead of
   animating.
   ------------------------------------------------------------ */
let panAnimationId = null;

function animateMapCenterTo(lat, lon, duration = 450) {
  if (panAnimationId !== null) {
    cancelAnimationFrame(panAnimationId);
    panAnimationId = null;
  }

  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    STATE.map.center = { lat, lon };
    renderMap();
    return;
  }

  const z = STATE.map.zoom;
  const start = project(STATE.map.center.lat, STATE.map.center.lon, z);
  const end = project(lat, lon, z);
  // Already (near enough) centered — skip the animation entirely.
  if (Math.abs(end.x - start.x) < 0.5 && Math.abs(end.y - start.y) < 0.5) {
    STATE.map.center = { lat, lon };
    renderMap();
    return;
  }

  const startTime = performance.now();
  // Ease-out cubic: fast start, gentle settle — reads as a deliberate
  // "fly to" rather than a linear slide.
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const k = ease(t);
    const x = start.x + (end.x - start.x) * k;
    const y = start.y + (end.y - start.y) * k;
    const p = unproject(x, y, z);
    STATE.map.center = { lat: p.lat, lon: p.lon };
    renderMap();
    if (t < 1) {
      panAnimationId = requestAnimationFrame(step);
    } else {
      panAnimationId = null;
    }
  };
  panAnimationId = requestAnimationFrame(step);
}

function zoomBy(delta) {
  STATE.map.zoom = Math.max(
    DASHBOARD_CONFIG.minZoom,
    Math.min(DASHBOARD_CONFIG.maxZoom, STATE.map.zoom + delta)
  );
  renderMap();
}

function initMapInteraction() {
  const area = $("#maparea");
  // A press only becomes a drag once the pointer has actually moved.
  //
  // Capturing the pointer on pointerdown (the obvious implementation) routes
  // every later pointer event to the container, so the browser never delivers
  // a click to the station circle underneath — every click on a pin was being
  // swallowed as the start of a drag. So: arm on pointerdown, but don't
  // capture or pan until movement passes DRAG_THRESHOLD, which leaves a plain
  // click free to reach the pin.
  // Straight-line distance, not |dx|+|dy|: summing the axes over-triggers on
  // diagonal movement, where a 3x2px hand wobble reads as 5px of "drag". 8px
  // comfortably absorbs hand jitter while a deliberate pan travels far further.
  const DRAG_THRESHOLD = 8; // px
  let armed = false, dragging = false, captured = false;
  let lastX = 0, lastY = 0, startX = 0, startY = 0;
  let pressedSite = null;   // station pressed on, resolved at pointerdown

  area.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".mapzoom") || e.target.closest(".mapctl") || e.target.closest(".tip")) return;
    armed = true; dragging = false; captured = false;
    lastX = startX = e.clientX;
    lastY = startY = e.clientY;

    // Remember the station under the pointer NOW. By the time the press ends
    // the overlay may have been re-rendered and this element replaced, so the
    // key has to be captured up front rather than read from the release target.
    const pin = e.target.closest ? e.target.closest(".pin, .pin-hit") : null;
    pressedSite = pin ? pin.getAttribute("data-site") : null;
  });

  area.addEventListener("pointermove", (e) => {
    if (!armed) return;

    if (!dragging) {
      const far = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (far < DRAG_THRESHOLD) return;   // still could be a click — leave it alone
      dragging = true;
      area.classList.add("dragging");
      try { area.setPointerCapture(e.pointerId); captured = true; } catch (_) { /* capture unsupported */ }
    }

    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const c = project(STATE.map.center.lat, STATE.map.center.lon, STATE.map.zoom);
    const p = unproject(c.x - dx, c.y - dy, STATE.map.zoom);
    STATE.map.center = { lat: p.lat, lon: p.lon };
    renderMap();
  });

  const end = (e, cancelled) => {
    if (!armed) return;
    const wasDragging = dragging;
    const site = pressedSite;
    armed = false; dragging = false; pressedSite = null;
    area.classList.remove("dragging");
    if (captured) {
      try { area.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      captured = false;
    }
    // A press that never became a pan, on a station pin, is a selection.
    if (!cancelled && !wasDragging && site) selectStation(site);
  };
  area.addEventListener("pointerup", (e) => end(e, false));
  area.addEventListener("pointercancel", (e) => end(e, true));

  area.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // WCAG 2.1.1: everything the pointer does, the keyboard does too. With the
  // map or a pin focused: arrows pan, + / - zoom, 0 fits all stations.
  // Controls inside the map (zoom buttons) keep their own keys.
  area.addEventListener("keydown", (e) => {
    const onPin = e.target.classList && e.target.classList.contains("pin");
    if (e.target !== area && !onPin) return;
    const pans = { ArrowLeft: [-PAN_STEP, 0], ArrowRight: [PAN_STEP, 0], ArrowUp: [0, -PAN_STEP], ArrowDown: [0, PAN_STEP] };
    let act = null;
    if (pans[e.key]) act = () => panBy(...pans[e.key]);
    else if (e.key === "+" || e.key === "=") act = () => zoomBy(1);
    else if (e.key === "-" || e.key === "_") act = () => zoomBy(-1);
    else if (e.key === "0") act = () => { fitToStations(); renderMap(); };
    if (!act) return;
    e.preventDefault();
    // The overlay is rebuilt on every render; put focus back on the same pin.
    const site = onPin ? e.target.getAttribute("data-site") : null;
    act();
    if (site) {
      const again = $(`#mapoverlay .pin[data-site="${CSS.escape(site)}"]`);
      (again || area).focus();
    }
  });

  window.addEventListener("resize", () => {
    if (!$("#p-map").classList.contains("hidden")) renderMap();
  });
}

function filteredStations() {
  const f = STATE.mapFilters;
  return mappableStations().filter((s) => {
    if (f.source && s.source_system !== f.source) return false;
    if (f.param && !(s.parameters || []).includes(f.param)) return false;
    if (f.maxDays < 99999) {
      const d = s.days_since_last_reading;
      if (d === null || d === undefined || d > f.maxDays) return false;
    }
    if (f.search) {
      const hay = `${s.station_name || ""} ${s.site_no || ""} ${s.site_key || ""}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
}

function renderMap() {
  const area = $("#maparea");
  if (!area) return;
  const W = area.clientWidth || 760;
  const H = area.clientHeight || 620;
  const z = STATE.map.zoom;
  const c = project(STATE.map.center.lat, STATE.map.center.lon, z);
  const originX = c.x - W / 2;
  const originY = c.y - H / 2;

  renderTiles(originX, originY, W, H, z);
  renderMapOverlay(originX, originY, W, H, z);
}

function renderTiles(originX, originY, W, H, z) {
  const layer = $("#tilelayer");
  const conf = BASEMAPS[STATE.map.basemap] || BASEMAPS.none;
  const attr = $("#mapattr");

  if (!conf.url || STATE.map.tilesFailed) {
    layer.innerHTML = "";
    attr.textContent = STATE.map.tilesFailed ? "Basemap unavailable — offline grid" : "";
    return;
  }
  attr.textContent = conf.attr ? `Basemap: ${conf.attr}` : "";

  // The map zoom can be fractional. Request tiles at the nearest whole level
  // and scale them (about 0.71x to 1.41x) so they stay reasonably sharp.
  const zt = Math.max(DASHBOARD_CONFIG.minZoom, Math.min(DASHBOARD_CONFIG.maxZoom, Math.round(z)));
  const n = Math.pow(2, zt);
  const ts = 256 * Math.pow(2, z - zt);           // rendered tile size, px
  const x0 = Math.floor(originX / ts), x1 = Math.floor((originX + W) / ts);
  const y0 = Math.floor(originY / ts), y1 = Math.floor((originY + H) / ts);

  const frag = document.createDocumentFragment();
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wrapped = ((tx % n) + n) % n;
      let url = conf.url.replace("{z}", zt).replace("{x}", wrapped).replace("{y}", ty);
      if (DASHBOARD_CONFIG.arcgisApiKey) url += `?token=${encodeURIComponent(DASHBOARD_CONFIG.arcgisApiKey)}`;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      img.style.left = (tx * ts - originX) + "px";
      img.style.top = (ty * ts - originY) + "px";
      // +1px overlap avoids hairline seams between scaled tiles.
      img.style.width = (ts + 1) + "px";
      img.style.height = (ts + 1) + "px";
      img.addEventListener("error", onTileError);
      frag.appendChild(img);
    }
  }
  layer.innerHTML = "";
  layer.appendChild(frag);
}

/**
 * If several tiles fail — offline agent, blocked host, CSP without an
 * img-src allowance — stop requesting them and fall back to the offline
 * graticule rather than showing an empty grey box.
 */
function onTileError() {
  STATE.map.tileErrors++;
  if (STATE.map.tileErrors >= 4 && !STATE.map.tilesFailed) {
    STATE.map.tilesFailed = true;
    renderMap();
  }
}

// One radius (px) for every station pin on the map.
const MAP_PIN_RADIUS = 6;

function renderMapOverlay(originX, originY, W, H, z) {
  const mount = $("#mapoverlay");
  // Not aria-hidden: the pins are focusable buttons. Decoration (grid,
  // approximate-location bubbles) is hidden individually instead.
  const s = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "Station pins" });

  const offline = !BASEMAPS[STATE.map.basemap].url || STATE.map.tilesFailed;
  if (offline) drawGraticule(s, originX, originY, W, H, z);

  const shownStations = filteredStations();
  const all = mappableStations();
  let plotted = 0, approximate = 0, offArea = 0;

  // ── Layer 1: semi-transparent visual bubbles for approximate locations ──
  // ACCESS_LOCATION 2-4 stations get a larger, semi-transparent circle behind
  // the interactive pin to communicate "this is not the exact spot."
  // These are non-interactive (pointer-events: none) so they never block
  // hover on the small dots underneath.
  const bubbleLayer = el("g", { "aria-hidden": "true", style: "pointer-events:none" });
  shownStations.forEach((st) => {
    if (!inStudyArea(st)) return;
    const al = Number(st.access_location);
    if (al < 2 || al > 4) return; // only levels 2-4 get a bubble
    const p = project(num(st.latitude), num(st.longitude), z);
    const cx = p.x - originX, cy = p.y - originY;
    if (cx < -40 || cy < -40 || cx > W + 40 || cy > H + 40) return;
    // Bubble radius scales with the coarseness of the location masking:
    //   level 2 (HUC12, 3-19 km displacement)   → 10.1 px
    //   level 3 (HUC10, 8-40 km displacement)   → 13.5 px
    //   level 4 (HUC8,  19-146 km displacement) → 16.9 px
    // Fill is darker than before but well below the pin's 0.65, so the halo
    // and the center pin stay visually distinct.
    const br = al === 2 ? 10.1 : al === 3 ? 13.5 : 16.9;
    bubbleLayer.appendChild(el("circle", {
      cx: cx.toFixed(1), cy: cy.toFixed(1), r: br,
      fill: stationColor(st), "fill-opacity": 0.26,
      stroke: stationColor(st), "stroke-opacity": 0.55, "stroke-width": 1.2,
    }));
  });
  s.appendChild(bubbleLayer);

  // ── Layer 2: interactive pins (uniform hit-target size) ──
  // Every station gets the same small interactive circle regardless of
  // access level, so hover/click targets are fair and consistent.
  // Rendered after the bubble layer so they sit on top in SVG z-order.
  shownStations.forEach((st) => {
    if (!inStudyArea(st)) { offArea++; return; }
    const al = Number(st.access_location);
    if (al >= 2 && al <= 4) approximate++;

    const p = project(num(st.latitude), num(st.longitude), z);
    const cx = p.x - originX, cy = p.y - originY;
    if (cx < -20 || cy < -20 || cx > W + 20 || cy > H + 20) return;

    // Every pin is the same size regardless of source or recency; colour
    // always shows the source at full strength. Recency is in the tooltip and
    // the Stations list status. Only the halos vary in size (location precision).
    const r = MAP_PIN_RADIUS;
    const op = 0.65;

    const circle = el("circle", {
      cx: cx.toFixed(1), cy: cy.toFixed(1), r,
      class: "pin" + (STATE.selectedSite === st.site_key ? " selected" : ""),
      fill: stationColor(st), "fill-opacity": op,
      stroke: "#fff", "stroke-width": 1.3,
    });
    // The pins are small, so an invisible circle a few pixels larger than the
    // drawn pin takes the mouse hover and click. The visible pin keeps focus,
    // ARIA and keyboard behavior. Halos stay non-interactive.
    const hit = el("circle", {
      cx: cx.toFixed(1), cy: cy.toFixed(1), r: r + 4,
      class: "pin-hit", fill: "transparent", "aria-hidden": "true",
      "data-site": st.site_key,
    });
    attachPinEvents(circle, st, hit);
    s.appendChild(circle);
    s.appendChild(hit);
    plotted++;
  });

  mount.innerHTML = "";
  mount.appendChild(s);

  // ── Footnote ──
  const noCoords = (STATE.data.stations || []).length - all.length;
  const parts = [`${cm(plotted)} station${plotted === 1 ? "" : "s"} plotted`];
  if (approximate) parts.push(`<b>${cm(approximate)}</b> at masked location (Constrained Geomasking, HUC12/10/8)`);
  if (noCoords > 0) parts.push(`<b>${cm(noCoords)}</b> hidden (location withheld by volunteer)`);
  if (offArea > 0) parts.push(`<b>${cm(offArea)}</b> outside the study watersheds`);
  if (noCoords > 0 || offArea > 0) parts.push("every excluded case is counted here rather than silently dropped.");
  $("#mapfoot").innerHTML = parts.join(" · ");
}

/** Offline fallback: lat/lon graticule with degree labels. */
function drawGraticule(s, originX, originY, W, H, z) {
  const tl = unproject(originX, originY, z);
  const br = unproject(originX + W, originY + H, z);
  const step = z >= 11 ? 0.1 : z >= 9 ? 0.25 : 0.5;

  for (let lon = Math.ceil(tl.lon / step) * step; lon <= br.lon; lon += step) {
    const x = project(0, lon, z).x - originX;
    s.appendChild(el("line", {
      x1: x.toFixed(1), x2: x.toFixed(1), y1: 0, y2: H,
      stroke: "#c7d7e1", "stroke-width": 0.7, "stroke-dasharray": "2 6",
    }));
    s.appendChild(el("text", { x: (x + 4).toFixed(1), y: H - 8, class: "maplbl", "aria-hidden": "true" },
      [txt(lon.toFixed(2) + "°")]));
  }
  for (let lat = Math.floor(tl.lat / step) * step; lat >= br.lat; lat -= step) {
    const y = project(lat, 0, z).y - originY;
    s.appendChild(el("line", {
      x1: 0, x2: W, y1: y.toFixed(1), y2: y.toFixed(1),
      stroke: "#c7d7e1", "stroke-width": 0.7, "stroke-dasharray": "2 6",
    }));
    s.appendChild(el("text", { x: 6, y: (y - 4).toFixed(1), class: "maplbl", "aria-hidden": "true" },
      [txt(lat.toFixed(2) + "°")]));
  }
  s.appendChild(el("text", { x: 8, y: 16, class: "maplbl" },
    [txt("Offline grid — no basemap tiles loaded")]));
}

/* The map tooltip is shared by every pin. Leaving a pin hides it after a short
   grace period, and entering the tooltip cancels that, so the pointer can move
   onto it (WCAG 1.4.13 hoverable). */
const MAP_TIP_GRACE = 300; // ms
let mapTipHideTimer = null;
let mapTipDetailTimer = null;

function hideMapTip() {
  clearTimeout(mapTipHideTimer);
  clearTimeout(mapTipDetailTimer);
  const tip = $("#maptip");
  tip.style.opacity = 0;
  tip.classList.remove("on");
}
function scheduleHideMapTip() {
  clearTimeout(mapTipHideTimer);
  mapTipHideTimer = setTimeout(hideMapTip, MAP_TIP_GRACE);
}
function initMapTip() {
  const tip = $("#maptip");
  tip.addEventListener("mouseenter", () => clearTimeout(mapTipHideTimer));
  tip.addEventListener("mouseleave", scheduleHideMapTip);
}

function attachPinEvents(circle, st, hit) {
  const area = $("#maparea"), tip = $("#maptip");
  let detailsLoaded = false;

  const seen = st.days_since_last_reading === null || st.days_since_last_reading === undefined
    ? "no readings" : `last seen ${st.days_since_last_reading} d ago`;

  const statusLabel = (STATUS_PILL[st.status] || STATUS_PILL.unknown)[1];
  const statusCls = "s-" + (st.status || "unknown");

  const lat = num(st.latitude), lon = num(st.longitude);
  const latStr = lat !== null ? `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}` : "—";
  const lonStr = lon !== null ? `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}` : "—";

  const params = st.parameters || [];
  const paramStr = params.length
    ? params.length <= 3 ? params.join(", ") : `${params.length} parameters`
    : "—";

  function buildInstantTip() {
    return `<div class="tip-name">${esc(st.station_name || st.site_key)}</div>` +
      `<div class="tip-row"><span class="tip-label">Source</span><span class="tip-val">${esc(displayName(st.source_system))} · ${esc(st.site_no || "")}</span></div>` +
      `<div class="tip-row"><span class="tip-label">Location</span><span class="tip-val">${latStr}, ${lonStr}</span></div>` +
      (st.watershed || st.huc_name ? `<div class="tip-row"><span class="tip-label">Watershed</span><span class="tip-val">${esc(st.watershed || st.huc_name)}</span></div>` : "") +
      (st.huc_code ? `<div class="tip-row"><span class="tip-label">HUC</span><span class="tip-val">${esc(st.huc_code)}</span></div>` : "") +
      `<div class="tip-row"><span class="tip-label">Params</span><span class="tip-val">${esc(paramStr)}</span></div>` +
      `<div class="tip-row"><span class="tip-label">Records</span><span class="tip-val">${cm(st.record_count)} · ${seen}</span></div>` +
      `<span class="tip-status ${statusCls}">${esc(statusLabel)}</span>` +
      `<hr class="tip-divider"><div class="tip-details" id="tip-details-${esc(st.site_key)}"></div>`;
  }

  function positionTip(x, y) {
    const b = area.getBoundingClientRect();
    clearTimeout(mapTipHideTimer);
    tip.style.opacity = 1;
    tip.classList.add("on");
    tip.style.left = Math.min(b.width - 290, x - b.left + 13) + "px";
    tip.style.top = (y - b.top + 13) + "px";
  }

  function showTip(x, y) {
    tip.classList.add("rich");
    tip.innerHTML = buildInstantTip();
    positionTip(x, y);
    detailsLoaded = false;
    // Progressive: after 800ms of sustained hover, fetch equipment details
    clearTimeout(mapTipDetailTimer);
    mapTipDetailTimer = setTimeout(async () => {
      try {
        const detail = await fetchStation(st.site_key);
        const detEl = tip.querySelector(`#tip-details-${CSS.escape(st.site_key)}`);
        if (!detEl) return; // tooltip was dismissed
        const rows = [];
        if (detail.equipment_description) rows.push(["Equipment", detail.equipment_description]);
        if (detail.elevation_ft !== null && detail.elevation_ft !== undefined) rows.push(["Elevation", `${detail.elevation_ft} ft`]);
        if (detail.location_type) rows.push(["Type", detail.location_type]);
        const al = Number(st.access_location);
        const hucLevelLabel = al === 2 ? "HUC12" : al === 3 ? "HUC10" : al === 4 ? "HUC8" : null;
        if (hucLevelLabel) rows.push(["HUC level", hucLevelLabel]);
        if (detail.first_reading_utc) rows.push(["First reading", tsLabel(detail.first_reading_utc) + " UTC"]);
        if (rows.length) {
          detEl.innerHTML = rows.map(([l, v]) =>
            `<div class="tip-row"><span class="tip-label">${esc(l)}</span><span class="tip-val">${esc(v)}</span></div>`
          ).join("");
          detEl.classList.add("loaded");
        } else {
          detEl.innerHTML = `<div class="tip-row"><span class="tip-val" style="color:rgba(255,255,255,.5)">No additional details</span></div>`;
          detEl.classList.add("loaded");
        }
      } catch (_) { /* fetch failed — tooltip stays with instant data only */ }
    }, 800);
  }

  // Mouse events go to the larger invisible hit circle when there is one.
  const mouseTarget = hit || circle;
  mouseTarget.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY));
  mouseTarget.addEventListener("mouseleave", scheduleHideMapTip);
  if (hit) {
    hit.addEventListener("mouseenter", () => circle.classList.add("hover"));
    hit.addEventListener("mouseleave", () => circle.classList.remove("hover"));
  }

  // Keyboard (WCAG 2.1.1): each pin is a focusable button showing the same
  // tooltip on focus; Enter or Space selects the station.
  circle.setAttribute("tabindex", "0");
  circle.setAttribute("role", "button");
  circle.setAttribute("aria-label",
    `${st.station_name || st.site_key}, ${displayName(st.source_system)} ${st.site_no || ""}, ` +
    `${lat !== null ? lat.toFixed(4) + ", " + lon.toFixed(4) : "no coordinates"}, ` +
    `${cm(st.record_count)} records, ${seen}, ${statusLabel}. Press Enter to select.`);
  circle.addEventListener("focus", () => {
    const r = circle.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top + r.height / 2);
  });
  circle.addEventListener("blur", hideMapTip);
  circle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectStation(st.site_key);
    }
  });

  // Selection is NOT wired to this element's "click" event. A few pixels of
  // hand jitter between press and release starts a pan, which re-renders the
  // overlay and destroys this very circle — press and release then land on
  // different elements and the browser never fires a click at all. The map's
  // pointerdown/pointerup handlers own selection instead, reading the site
  // key off the element below; see initMapInteraction().
  circle.setAttribute("data-site", st.site_key);
}

function renderStationTable() {
  const rows = filteredStations().slice();
  const { key, dir } = STATE.stationSort;
  rows.sort((a, b) => {
    let va, vb;
    if (key === "name") { va = (a.station_name || a.site_no || "").toLowerCase(); vb = (b.station_name || b.site_no || "").toLowerCase(); }
    else if (key === "records") { va = a.record_count || 0; vb = b.record_count || 0; }
    else { va = Number(a.access_location) || 9; vb = Number(b.access_location) || 9; }
    return va < vb ? -dir : va > vb ? dir : 0;
  });

  $$("th.sortable", $("#p-map")).forEach((th) => th.setAttribute("aria-sort",
    th.dataset.sort === key ? (dir > 0 ? "ascending" : "descending") : "none"));

  $("#stationcount").textContent =
    `${cm(rows.length)} of ${cm((STATE.data.stations || []).length)} station records`;

  $("#stationrows").innerHTML = rows.map((s) => {
    const locLabel = locationStatusLabel(s);
    const locCls = locationStatusClass(s);
    return `<tr class="selectable${STATE.selectedSite === s.site_key ? " selected" : ""}" data-key="${esc(s.site_key)}">
      <td><button type="button" class="rowbtn"><span class="stationcell">
        <i class="swatch" style="background:${stationColor(s)}" aria-hidden="true"></i>
        <span><span class="nm">${esc(s.station_name || s.site_key)}</span>
        <span class="sid">${esc(displayName(s.source_system))} · ${esc(s.site_no || "")}</span></span>
      </span></button>${stationLink(s.site_no, s.source_system, "Open station detail", s.station_name || s.site_key)}</td>
      <td class="num">${cm(s.record_count)}</td>
      <td><span class="pill ${locCls}">${esc(locLabel)}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="3"><div class="placeholder">No stations match these filters.</div></td></tr>`;

  $$("#stationrows tr.selectable").forEach((tr) => {
    tr.addEventListener("click", () => selectStation(tr.dataset.key));
  });
}

/**
 * Select a station: highlights the map pin and the list row, scrolls the
 * row into view with a brief flash, and shows the green "View Selected"
 * button. Does NOT navigate to the Station Detail page — that is the
 * button's job.
 */
function selectStation(siteKey) {
  STATE.selectedSite = siteKey;

  // Re-center the map on the selected station so its pin is always brought
  // into view (not just highlighted), animating the pan for a smoother
  // transition when the point is off-screen or near an edge.
  const st = (STATE.data.stations || []).find((s) => s.site_key === siteKey);
  const lat = st ? num(st.latitude) : null;
  const lon = st ? num(st.longitude) : null;
  if (lat !== null && lon !== null) {
    animateMapCenterTo(lat, lon);
  } else {
    renderMap();
  }

  renderStationTable();
  // Scroll the selected row into view and flash it to draw the eye.
  const row = $(`#stationrows tr[data-key="${CSS.escape(siteKey)}"]`);
  if (row) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("flash");
    row.addEventListener("animationend", () => row.classList.remove("flash"), { once: true });
  }
  updateViewSelectedBtn();
}

/** Navigate to the Station Detail page for the currently selected station. */
function goToStationDetail() {
  const siteKey = STATE.selectedSite;
  if (!siteKey) return;
  const sel = $("#detail-station");
  if (sel) {
    sel.value = siteKey;
    if (sel.value !== siteKey) {
      sel.appendChild(new Option(siteKey, siteKey));
      sel.value = siteKey;
    }
  }
  syncStationCombo(sel);
  showPage("detail");
  loadDetail(siteKey);
  const h = $("#dtitle");
  if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
}

/** Show or hide the green "View Selected" button based on selection state. */
function updateViewSelectedBtn() {
  const btn = $("#view-selected-btn");
  if (!btn) return;
  btn.classList.toggle("visible", !!STATE.selectedSite);
}

/* ============================================================
   FLOOD WATCH
   ============================================================ */
const FLOOD_TIER_PILL = {
  near_record: ["p-flood-near", "Near record high"],
  elevated: ["p-flood-elevated", "Elevated"],
  normal: ["p-flood-normal", "Normal"],
};

function initFloodPage() {
  const search = $("#flood-search");
  const tierSel = $("#flood-tier");
  if (search) search.addEventListener("input", (e) => {
    STATE.floodFilters.search = e.target.value.trim().toLowerCase();
    renderFloodWatch();
  });
  if (tierSel) tierSel.addEventListener("change", () => {
    STATE.floodFilters.tier = tierSel.value;
    renderFloodWatch();
  });
  const sourceSel = $("#flood-source");
  if (sourceSel) sourceSel.addEventListener("change", () => {
    STATE.floodFilters.source = sourceSel.value;
    renderFloodWatch();
  });

  const wrap = $("#p-flood");
  if (wrap) $$("th.sortable", wrap).forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    STATE.floodSort = {
      key,
      dir: STATE.floodSort.key === key ? -STATE.floodSort.dir : (key === "name" ? 1 : -1),
    };
    renderFloodWatch();
  }));

  renderFloodWatch();
}

function filteredFlood() {
  const ov = STATE.data.overview || {};
  const rows = ov.flood_watch || [];
  const { search, tier, source } = STATE.floodFilters;
  return rows.filter((r) => {
    if (tier && r.tier !== tier) return false;
    if (source && (r.threshold_source || "self_referential") !== source) return false;
    if (search) {
      const hay = `${r.station_name || ""} ${r.site_no || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderFloodWatch() {
  const ov = STATE.data.overview || {};
  const summary = ov.flood_watch_summary || { near_record: 0, elevated: 0, normal: 0, eligible_count: 0 };

  // "this dataset starts in YYYY": year comes from the build (earliest reading).
  const startYear = summary.data_start_year;
  document.querySelectorAll(".flood-start-note").forEach((el) => {
    const yr = el.querySelector(".flood-start-year");
    if (yr) yr.textContent = startYear || "";
    el.classList.toggle("hidden", !startYear);
  });
  const methodTip = document.getElementById("floodmethod-tip");
  if (methodTip && startYear && !methodTip.dataset.startYearSet) {
    methodTip.setAttribute(
      "data-tip",
      methodTip.getAttribute("data-tip").replace(
        "their own highest reading in this dataset:",
        `their own highest reading in this dataset (this dataset starts in ${startYear}):`
      )
    );
    methodTip.dataset.startYearSet = "1";
  }

  const FLOOD_KPI_TIPS = {
    "Near record high": "Stations whose most recent reading is at or above 90% of their own highest reading in this dataset.",
    "Elevated": "Stations whose most recent reading is between 75% and 90% of their own highest reading in this dataset.",
    "Normal": "Stations whose most recent reading is below 75% of their own highest reading in this dataset.",
    "Stations scored": "Station/parameter pairs with at least 30 historical readings, the minimum needed to establish a period-of-record maximum.",
  };
  const FLOOD_KPI_PILL = {
    "Near record high": "p-flood-near",
    "Elevated": "p-flood-elevated",
    "Normal": "p-flood-normal",
  };
  $("#floodkpirow").innerHTML = [
    ["Near record high", cm(summary.near_record || 0), "\u226590% of own historic max"],
    ["Elevated", cm(summary.elevated || 0), "75\u201390% of own historic max"],
    ["Normal", cm(summary.normal || 0), "<75% of own historic max"],
    ["Stations scored", cm(summary.eligible_count || 0), "Flow + gage-height pairs with enough history"],
  ].map(([l, v, c]) => {
    const tip = FLOOD_KPI_TIPS[l] || l;
    const pillCls = FLOOD_KPI_PILL[l];
    const title = pillCls
      ? `<span class="pill ${pillCls} eyebrow">${esc(l)}</span>`
      : `<div class="eyebrow">${esc(l)}</div>`;
    return `<div class="kpi"><span class="info-icon" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">i</span>${title}<div class="v">${v}</div><div class="c">${esc(c)}</div></div>`;
  }).join("");

  const rows = filteredFlood().slice();
  const { key, dir } = STATE.floodSort;
  const tierRank = { near_record: 0, elevated: 1, normal: 2 };
  const sourceRank = (r) => (r.threshold_source === "official" ? 0 : 1);
  rows.sort((a, b) => {
    let va, vb;
    if (key === "name") { va = (a.station_name || a.site_no || "").toLowerCase(); vb = (b.station_name || b.site_no || "").toLowerCase(); }
    else if (key === "parameter") { va = (a.parameter_desc || a.parameter_cd || "").toLowerCase(); vb = (b.parameter_desc || b.parameter_cd || "").toLowerCase(); }
    else if (key === "current") { va = a.current_value || 0; vb = b.current_value || 0; }
    else if (key === "historic") { va = a.historic_max || 0; vb = b.historic_max || 0; }
    else if (key === "tier") { va = tierRank[a.tier] ?? 9; vb = tierRank[b.tier] ?? 9; }
    else if (key === "records") { va = a.observation_count || 0; vb = b.observation_count || 0; }
    else { va = a.pct_of_record || 0; vb = b.pct_of_record || 0; }
    if (va < vb) return -dir;
    if (va > vb) return dir;
    // Tie-break: sort by condition (near record high -> elevated -> normal),
    // then by threshold source (Official NWS stage before Dataset-relative).
    const ta = tierRank[a.tier] ?? 9, tb = tierRank[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    return sourceRank(a) - sourceRank(b);
  });

  const wrap = $("#p-flood");
  if (wrap) $$("th.sortable", wrap).forEach((th) => th.setAttribute("aria-sort",
    th.dataset.sort === key ? (dir > 0 ? "ascending" : "descending") : "none"));

  const total = (STATE.data.overview || {}).flood_watch ? STATE.data.overview.flood_watch.length : 0;
  $("#floodcount").textContent = `${cm(rows.length)} of ${cm(total)} station/parameter records`;

  $("#floodrows").innerHTML = rows.map((r) => {
    const [cls, label] = FLOOD_TIER_PILL[r.tier] || ["p-unknown", "Unknown"];
    const name = r.anonymized ? "Location withheld by data-sharing policy" : (r.station_name || r.site_no);
    const idBit = r.anonymized ? "" : ` · ${esc(r.site_no || "")}`;
    const isOfficial = r.threshold_source === "official";
    const ot = r.official_thresholds || {};
    const sourceTip = isOfficial
      ? `NWS AHPS gauge ${esc(ot.nws_lid || "")}: action stage ${fmt(ot.action_stage_ft)} ft, flood stage ${fmt(ot.minor_flood_stage_ft)} ft (as of ${esc(ot.as_of_date || "unknown date")}).`
      : "Dataset-relative: compared only to this station's own historic max in RRTS data.";
    const sourceCell = isOfficial
      ? `<span class="pill p-flood-official" title="${sourceTip}">Official NWS stage</span>`
      : `<span class="pill p-flood-selfref" title="${sourceTip}">Dataset-relative</span>`;
    return `<tr>
      <td><span class="nm">${r.anonymized ? esc(name) : stationLink(r.site_no, r.source_system, name)}</span> <span class="sid">${esc(displayName(r.source_system))}${idBit}</span></td>
      <td>${esc(r.parameter_desc || r.parameter_cd)}</td>
      <td class="num">${fmt2(r.current_value)} ${esc(r.unit || "")}</td>
      <td class="num">${fmt2(r.historic_max)} ${esc(r.unit || "")}</td>
      <td class="num">${r.pct_of_record}%</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td>${sourceCell}</td>
      <td class="num">${cm(r.observation_count)}</td>
      <td>${r.current_timestamp_utc ? esc(r.current_timestamp_utc.replace("T", " ").slice(0, 16)) : "—"}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9"><div class="placeholder">No stations match these filters.</div></td></tr>`;
}

/* ============================================================
   STATION MAINTENANCE
   ============================================================ */
const MAINT_TIER_PILL = {
  near_high: ["p-maint-high", "Near top of range"],
  near_low: ["p-maint-low", "Near bottom of range"],
  continuous_flow: ["p-maint-continuous", "Flowing 24+ hours"],
};

function initMaintenancePage() {
  const search = $("#maint-search");
  const flagSel = $("#maint-flag");
  if (search) search.addEventListener("input", (e) => {
    STATE.maintFilters.search = e.target.value.trim().toLowerCase();
    renderMaintenanceFlags();
  });
  if (flagSel) flagSel.addEventListener("change", () => {
    STATE.maintFilters.flag = flagSel.value;
    renderMaintenanceFlags();
  });

  const wrap = $("#p-maintenance");
  if (wrap) $$("th.sortable", wrap).forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    STATE.maintSort = {
      key,
      dir: STATE.maintSort.key === key ? -STATE.maintSort.dir : (key === "name" ? 1 : -1),
    };
    renderMaintenanceFlags();
  }));

  renderMaintenanceFlags();
}

function filteredMaintenance() {
  const ov = STATE.data.overview || {};
  const rows = ov.station_maintenance || [];
  const { search, flag } = STATE.maintFilters;
  return rows.filter((r) => {
    if (flag && r.flag_type !== flag) return false;
    if (search) {
      const hay = `${r.station_name || ""} ${r.site_no || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderMaintenanceFlags() {
  const ov = STATE.data.overview || {};
  const summary = ov.station_maintenance_summary || { near_high: 0, near_low: 0, continuous_flow: 0, eligible_count: 0 };

  const MAINT_KPI_TIPS = {
    "Near top of range": "Stations whose most recent reading falls in the top 10% of their own historic range (highest minus lowest reading) in this dataset.",
    "Near bottom of range": "Stations whose most recent reading falls in the bottom 10% of their own historic range in this dataset.",
    "Flowing 24+ hours": "Diversions and underflow wells that have been pumping without a break for at least 24 hours.",
    "Stations flagged": "Total station/parameter and station rows flagged on this page.",
  };
  const MAINT_KPI_PILL = {
    "Near top of range": "p-maint-high",
    "Near bottom of range": "p-maint-low",
    "Flowing 24+ hours": "p-maint-continuous",
  };
  $("#maintkpirow").innerHTML = [
    ["Near top of range", cm(summary.near_high || 0), "\u226590% of own historic range"],
    ["Near bottom of range", cm(summary.near_low || 0), "\u226410% of own historic range"],
    ["Flowing 24+ hours", cm(summary.continuous_flow || 0), "Diversions + underflow wells"],
    ["Stations flagged", cm(summary.eligible_count || 0), "Total rows on this page"],
  ].map(([l, v, c]) => {
    const tip = MAINT_KPI_TIPS[l] || l;
    const pillCls = MAINT_KPI_PILL[l];
    const title = pillCls
      ? `<span class="pill ${pillCls} eyebrow">${esc(l)}</span>`
      : `<div class="eyebrow">${esc(l)}</div>`;
    return `<div class="kpi"><span class="info-icon" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">i</span>${title}<div class="v">${v}</div><div class="c">${esc(c)}</div></div>`;
  }).join("");

  const rows = filteredMaintenance().slice();
  const { key, dir } = STATE.maintSort;
  const flagRank = { near_high: 0, near_low: 1, continuous_flow: 2 };
  rows.sort((a, b) => {
    let va, vb;
    if (key === "name") { va = (a.station_name || a.site_no || "").toLowerCase(); vb = (b.station_name || b.site_no || "").toLowerCase(); }
    else if (key === "type") { va = (a.parameter_desc || a.station_type || "").toLowerCase(); vb = (b.parameter_desc || b.station_type || "").toLowerCase(); }
    else if (key === "current") { va = a.current_value || 0; vb = b.current_value || 0; }
    else if (key === "historic") { va = a.pct_of_range || 0; vb = b.pct_of_range || 0; }
    else if (key === "duration") { va = a.hours_running || 0; vb = b.hours_running || 0; }
    else { va = flagRank[a.flag_type] ?? 9; vb = flagRank[b.flag_type] ?? 9; }
    if (va < vb) return -dir;
    if (va > vb) return dir;
    const fa = flagRank[a.flag_type] ?? 9, fb = flagRank[b.flag_type] ?? 9;
    return fa - fb;
  });

  const wrap = $("#p-maintenance");
  if (wrap) $$("th.sortable", wrap).forEach((th) => th.setAttribute("aria-sort",
    th.dataset.sort === key ? (dir > 0 ? "ascending" : "descending") : "none"));

  const total = (STATE.data.overview || {}).station_maintenance ? STATE.data.overview.station_maintenance.length : 0;
  $("#maintcount").textContent = `${cm(rows.length)} of ${cm(total)} flagged rows`;

  $("#maintrows").innerHTML = rows.map((r) => {
    const [cls, label] = MAINT_TIER_PILL[r.flag_type] || ["p-unknown", "Unknown"];
    const name = r.anonymized ? "Location withheld by data-sharing policy" : (r.station_name || r.site_no);
    const idBit = r.anonymized ? "" : ` · ${esc(r.site_no || "")}`;
    const isContinuous = r.flag_type === "continuous_flow";
    const typeCell = isContinuous
      ? esc(r.station_type === "underflow_well" ? "Underflow well" : "Diversion")
      : esc(r.parameter_desc || r.parameter_cd || "");
    const currentCell = isContinuous
      ? `${fmt2(r.latest_flow_cfs)} cfs`
      : `${fmt2(r.current_value)} ${esc(r.unit || "")}`;
    const historicCell = isContinuous
      ? "—"
      : `${fmt2(r.historic_min)}\u2013${fmt2(r.historic_max)} ${esc(r.unit || "")}`;
    const since = isContinuous
      ? `for ${r.since_is_lower_bound ? "at least " : ""}${spanLabel(Date.now() - new Date(r.since_utc).getTime())}`
      : (r.pct_of_range !== undefined && r.pct_of_range !== null ? `${r.pct_of_range}% of range` : "—");
    const lastReadingUtc = isContinuous ? r.latest_reading_utc : r.current_timestamp_utc;
    return `<tr>
      <td><span class="nm">${r.anonymized ? esc(name) : stationLink(r.site_no, r.source_system, name)}</span> <span class="sid">${esc(displayName(r.source_system))}${idBit}</span></td>
      <td>${typeCell}</td>
      <td><span class="pill ${cls}">${esc(label)}</span></td>
      <td class="num">${currentCell}</td>
      <td class="num">${historicCell}</td>
      <td class="num">${esc(since)}</td>
      <td>${lastReadingUtc ? esc(lastReadingUtc.replace("T", " ").slice(0, 16)) : "—"}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7"><div class="placeholder">No stations match these filters.</div></td></tr>`;
}

/* ============================================================
   STATION DETAIL
   ============================================================ */
function initDetailPage() {
  const sel = $("#detail-station");
  // Group by source (Aquarius first) and show the site number, so Aquarius
  // stations — whose names don't say "Aquarius" — are easy to find among
  // the USGS / CDEC / CNRA gages.
  const groupOf = (s) => (String(s.source_system || "").toUpperCase().startsWith("AQUARIUS")
    ? "Aquarius" : displayName(s.source_system) || "Other");
  const groups = new Map();
  (STATE.data.stations || [])
    .slice()
    .sort((a, b) => (a.station_name || a.site_key).localeCompare(b.station_name || b.site_key))
    .forEach((s) => {
      const g = groupOf(s);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    });
  [...groups.keys()]
    .sort((a, b) => (a === "Aquarius" ? -1 : b === "Aquarius" ? 1 : a.localeCompare(b)))
    .forEach((g) => {
      const og = document.createElement("optgroup");
      og.label = `${g} (${groups.get(g).length})`;
      groups.get(g).forEach((s) => {
        const name = s.station_name || s.site_key;
        const label = s.site_no && s.site_no !== name ? `${name} (${s.site_no})` : name;
        og.appendChild(new Option(label, s.site_key));
      });
      sel.appendChild(og);
    });

  makeStationCombo(sel);
  sel.addEventListener("change", () => sel.value && loadDetail(sel.value));
  $("#backtomap").addEventListener("click", () => showPage("map"));
  $("#detail-download").addEventListener("click", downloadStationFiles);
  // F2: disable the download button when the selected station is restricted.
  syncDetailDownloadBtn();

  wireTabKeys($$(".subtab"), (b) => b.click());
  syncTabIndex($$(".subtab"));
  $$(".subtab").forEach((b) => b.addEventListener("click", () => {
    $$(".subtab").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    syncTabIndex($$(".subtab"));
    ["series", "info", "access"].forEach((n) =>
      $("#sub-" + n).classList.toggle("hidden", n !== b.dataset.s));
  }));

  $("#detail-param").addEventListener("change", (e) => {
    STATE.detail.param = e.target.value;
    renderSeries();
  });
  $$("#detailrange .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#detailrange .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    STATE.detail.days = Number(b.dataset.d);
    // A quick range replaces any From / To dates.
    STATE.detail.from = STATE.detail.to = "";
    $("#detail-from").value = $("#detail-to").value = "";
    renderSeries();
  }));

  // From / To (UTC dates). Either end may be left open. Setting a date turns
  // the quick-range buttons off, so the chart has one window at a time.
  const onDates = () => {
    STATE.detail.from = $("#detail-from").value;
    STATE.detail.to = $("#detail-to").value;
    const custom = !!(STATE.detail.from || STATE.detail.to);
    $$("#detailrange .seg").forEach((x) =>
      x.setAttribute("aria-pressed", String(!custom && Number(x.dataset.d) === STATE.detail.days)));
    renderSeries();
  };
  $("#detail-from").addEventListener("change", onDates);
  $("#detail-to").addEventListener("change", onDates);
  $("#detail-dates-clear").addEventListener("click", () => {
    $("#detail-from").value = $("#detail-to").value = "";
    onDates();
  });

  // Chart / table / both toggle for the time series view.
  $$("#seriesview .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#seriesview .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const split = $("#seriessplit");
    split.classList.toggle("chart-only", b.dataset.v === "chart");
    split.classList.toggle("table-only", b.dataset.v === "table");
  }));
}

async function loadDetail(siteKey) {
  showLoading(true);
  try {
    const station = await fetchStation(siteKey);
    STATE.detail.station = station;
    STATE.selectedSite = siteKey;
    syncStationCombo($("#detail-station"));
    renderDetailHeader(station);
    renderDetailParams(station);
    renderSeries();
    renderStationInfo(station);
    renderAccessPolicy(station);
    syncDetailDownloadBtn();
  } catch (err) {
    $("#dtitle").textContent = "Could not load station";
    $("#dmeta").innerHTML = `<span class="meta">${esc(err.message)}</span>`;
    $("#serieschart").innerHTML =
      `<div class="placeholder">No station file for <code>${esc(siteKey)}</code>.</div>`;
  } finally {
    showLoading(false);
  }
}

function renderDetailHeader(st) {
  const meta = (STATE.data.stations || []).find((s) => s.site_key === st.site_key) || {};
  const roleLabel = { study: "Study station", ref: "Public reference gage", wq: "Water-quality program" };
  $("#deyebrow").textContent =
    `${roleLabel[role(st.source_system)]} · ${displayName(st.source_system)}`;
  $("#dtitle").textContent = `${st.station_name || st.site_key} (${st.site_no || "—"})`;

  const lat = num(st.latitude), lon = num(st.longitude);
  const [cls, label] = STATUS_PILL[st.status || meta.status] || STATUS_PILL.unknown;
  $("#dmeta").innerHTML = [
    `Source: ${esc(displayName(st.source_system))}`,
    Number(st.access_location) === 5
      ? "Location restricted — coordinates withheld"
      : lat !== null && lon !== null ? `Lat ${lat.toFixed(4)}, Lon ${lon.toFixed(4)}` : "No coordinates",
    st.watershed || st.huc_name ? `Watershed: ${esc(st.watershed || st.huc_name)}` : null,
    st.huc_code ? `HUC ${esc(st.huc_code)}` : null,
    `${cm(st.record_count)} measurements`,
    st.last_reading_utc ? `Last reading ${tsLabel(st.last_reading_utc)} UTC` : "No readings",
  ].filter(Boolean).map((m) => `<span class="meta">${m}</span>`).join("")
    + `<span class="pill ${cls}" style="margin-left:4px">${label}</span>`;

  // Diversions and underflow wells also show whether they are pumping.
  const pump = pumpingFor(st.site_no);
  if (pump) {
    const [, pumpCls, pumpLabel] = PUMP_STATE[pumpState(pump)] || PUMP_STATE.no_data;
    $("#dmeta").innerHTML += `<span class="pill ${pumpCls}" style="margin-left:4px">${esc(pumpLabel)}</span>`;
  }

}

function groupByParam(measurements) {
  const by = {};
  measurements.forEach((r) => {
    const key = r.parameter_desc || r.parameter_cd || "Value";
    (by[key] = by[key] || []).push(r);
  });
  Object.values(by).forEach((rows) =>
    rows.sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc))));
  // Most-measured parameter first.
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1].length - a[1].length));
}

/**
 * WCAG/F5 remediation: a station's full measurement array can be very large
 * (whole period of record, every parameter). Switching the quick-range
 * buttons or the From/To pickers re-renders the chart often, and before this
 * cache every one of those renders re-grouped and re-sorted the full array
 * from scratch. groupByParamCached() does that grouping/sort once per station
 * object and reuses it for the life of that station's detail-page visit —
 * the visible date window is still applied on top (inDateRange / cutoff
 * filtering in renderSeries), so this only removes redundant re-scanning,
 * not the one-time network fetch of the whole station file (see
 * fetchStation() for the remaining, larger network-payload item — tracked
 * separately as a backend sharding/windowing enhancement).
 */
const _groupByParamCache = new WeakMap();
function groupByParamCached(station) {
  if (!station) return {};
  if (!_groupByParamCache.has(station)) {
    _groupByParamCache.set(station, groupByParam(station.measurements || []));
  }
  return _groupByParamCache.get(station);
}

/** True if an ISO timestamp's UTC date falls within [from, to]; either end may be "". */
function inDateRange(ts, from, to) {
  const d = String(ts || "").slice(0, 10);
  if (!d) return false;
  return (!from || d >= from) && (!to || d <= to);
}

function renderDetailParams(st) {
  const sel = $("#detail-param");
  sel.innerHTML = "";
  const by = groupByParamCached(st);
  Object.entries(by).forEach(([name, rows]) => {
    const unit = rows[0].unit ? ` (${rows[0].unit})` : "";
    sel.appendChild(new Option(name + unit, name));
  });
  STATE.detail.param = sel.value || null;

  // Limit the date pickers to the station's period of record.
  const days = (st.measurements || []).map((r) => String(r.timestamp_utc || "").slice(0, 10)).filter(Boolean).sort();
  ["#detail-from", "#detail-to"].forEach((id) => {
    $(id).min = days[0] || "";
    $(id).max = days[days.length - 1] || "";
  });
}

/** Mirrors values_withheld_by_policy() in dashboard_stats.py: the public view
    blanks a station's readings when any of these access codes is 2. */
function valuesWithheld(st) {
  return [st.access_events, st.access_download, st.access_parameters].some((v) => Number(v) === 2);
}

function renderSeries() {
  const st = STATE.detail.station;
  const mount = $("#serieschart");
  const table = $("#seriestable");
  if (!st) {
    mount.innerHTML = '<div class="placeholder">Select a station.</div>';
    table.innerHTML = "";
    return;
  }

  const by = groupByParamCached(st);
  const rows = by[STATE.detail.param] || [];
  if (!rows.length) {
    mount.innerHTML = !Object.keys(by).length && valuesWithheld(st)
      ? '<div class="placeholder">Readings from this station are withheld under its data-sharing agreement.</div>'
      : '<div class="placeholder">No measurements for this parameter.</div>';
    table.innerHTML = "";
    $("#serieslegend").innerHTML = "";
    $("#seriesfoot").textContent = "";
    return;
  }

  const { from, to } = STATE.detail;
  const custom = !!(from || to);
  if (custom && from && to && from > to) {
    mount.innerHTML = '<div class="placeholder">The From date is after the To date.</div>';
    table.innerHTML = "";
    $("#serieslegend").innerHTML = "";
    $("#seriesfoot").textContent = "";
    return;
  }
  const cutoff = custom || STATE.detail.days >= 99999
    ? null
    : Date.now() - STATE.detail.days * 86400000;
  const windowed = custom
    ? rows.filter((r) => inDateRange(r.timestamp_utc, from, to))
    : cutoff
      ? rows.filter((r) => new Date(r.timestamp_utc).getTime() >= cutoff)
      : rows;
  if (custom && !windowed.length) {
    mount.innerHTML = `<div class="placeholder">No readings between ${esc(from || "the start")} and ${esc(to || "the end")}.</div>`;
    table.innerHTML = "";
    $("#serieslegend").innerHTML = "";
    $("#seriesfoot").textContent = "";
    return;
  }
  // A quick range with under two readings falls back to the full record;
  // explicit dates are shown as asked.
  const use = custom || windowed.length >= 2 ? windowed : rows;

  const labels = use.map((r) => r.timestamp_utc);
  const values = use.map((r) => num(r.value ?? r.value_mean));
  const unit = use[0].unit || "";

  // Optional min–max band when build-time aggregation produced one.
  const hasBand = use.some((r) => r.value_min !== undefined && r.value_max !== undefined);
  const band = hasBand
    ? { lo: use.map((r) => num(r.value_min)), hi: use.map((r) => num(r.value_max)) }
    : null;

  $("#serieslegend").innerHTML =
    `<span class="l"><i class="swatch" style="background:var(--s1)"></i>${esc(STATE.detail.param)}</span>` +
    (hasBand ? `<span class="l"><i class="swatch" style="background:rgba(42,120,214,.18);border:1px solid rgba(42,120,214,.4)"></i>min–max range</span>` : "");

  lineChart(mount, [{ n: STATE.detail.param, v: values, c: "var(--s1)" }], { labels, unit, band, tableHint: "inline",
    label: `${STATE.detail.param} at ${(STATE.detail.station || {}).station_name || ""}` });

  // Same rows the chart plots, shown as a table (WCAG 1.1.1: text alternative
  // for the chart's visual data).
  const tblCols = [["Timestamp (UTC)", (r) => tsLabel(r.timestamp_utc)]]
    .concat(hasBand
      ? [["Min", (r) => (num(r.value_min) === null ? "—" : num(r.value_min).toLocaleString())],
         ["Value", (r) => (num(r.value ?? r.value_mean) === null ? "—" : num(r.value ?? r.value_mean).toLocaleString())],
         ["Max", (r) => (num(r.value_max) === null ? "—" : num(r.value_max).toLocaleString())]]
      : [["Value", (r) => (num(r.value ?? r.value_mean) === null ? "—" : num(r.value ?? r.value_mean).toLocaleString())]]);
  table.innerHTML =
    `<table><thead><tr>${tblCols.map(([h]) => `<th${h === "Timestamp (UTC)" ? "" : ' class="num"'}>${esc(h)}${h === "Value" && unit ? ` (${esc(unit)})` : ""}</th>`).join("")}</tr></thead>` +
    `<tbody>${use.map((r) => `<tr>${tblCols.map(([h, fn], i) => `<td${i ? ' class="num"' : ""}>${esc(fn(r))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  $("#seriesfoot").innerHTML =
    `${cm(use.length)} points shown` +
    (!custom && windowed.length < 2 && cutoff ? " — no readings in the selected window, showing the full record instead" : "") +
    ` · ${esc(dateOnly(labels[0]))} → ${esc(dateOnly(labels[labels.length - 1]))} UTC`;
}

/**
 * "Download this station" (Station Detail page): exports the currently
 * selected parameter/date-range as a time-series CSV, plus a second CSV of
 * station metadata, named and grouped in a shared snake_case folder built
 * from the data source and station name, e.g.
 *   aquarius_diversion_at_orrs_creek/aquarius_diversion_at_orrs_creek_time_series.csv
 *   aquarius_diversion_at_orrs_creek/aquarius_diversion_at_orrs_creek_station_info.csv
 * The subfolder in `a.download` is honored by Chromium-based browsers; other
 * browsers save both files flat using that full name.
 */
function downloadStationFiles() {
  const st = STATE.detail.station;
  if (!st) return;
  // F2: block download for stations restricted by data access policy.
  if (downloadRestricted(st)) {
    setNote("Download is restricted for this station under its data-sharing agreement.", true);
    return;
  }

  const folder = slugSnake(`${displayName(st.source_system)}_${st.station_name || st.site_key}`);

  // Same parameter + date-range filtering as renderSeries().
  const by = groupByParamCached(st);
  const rows = by[STATE.detail.param] || [];
  const { from, to, days } = STATE.detail;
  const custom = !!(from || to);
  let windowed = rows;
  if (custom) {
    windowed = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
  } else if (days < 99999) {
    const cutoff = Date.now() - days * 86400000;
    const inWindow = rows.filter((r) => new Date(r.timestamp_utc).getTime() >= cutoff);
    if (inWindow.length >= 2) windowed = inWindow;
  }

  const seriesCols = ["timestamp_utc", "parameter_desc", "parameter_cd", "unit", "value", "value_min", "value_max"]
    .filter((c) => windowed.length && windowed[0][c] !== undefined);
  const seriesCsv = [seriesCols.join(",")]
    .concat(windowed.map((r) => seriesCols.map((c) => csvCell(r[c])).join(",")))
    .join("\n");
  saveCsv(`${folder}/${folder}_time_series.csv`, seriesCsv);

  const isAquarius = String(st.source_system || "").toUpperCase().startsWith("AQUARIUS");
  const equipmentWithheld = [st.access_equipment, st.access_events, st.access_download]
    .some((code) => Number(code) === 2);
  const equipment = st.equipment_description
    || (!isAquarius ? null
      : equipmentWithheld ? "withheld (data access policy)"
      : "not recorded in Aquarius");
  const infoFields = [
    ["Site key", st.site_key],
    ["Site number", st.site_no],
    ["Station name", st.station_name],
    ["Source system", displayName(st.source_system)],
    ["Location type", st.location_type],
    ["Equipment", equipment],
    ["Latitude", Number(st.access_location) === 5 ? "withheld" : num(st.latitude)],
    ["Longitude", Number(st.access_location) === 5 ? "withheld" : num(st.longitude)],
    ["Elevation (ft)", st.elevation_ft],
    ["Watershed", st.watershed],
    ["HUC name", st.huc_name],
    ["HUC code", st.huc_code],
    ["HUC level", st.huc_level],
    ["First reading (UTC)", st.first_reading_utc],
    ["Last reading (UTC)", st.last_reading_utc],
    ["Measurements", st.record_count],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");
  const infoCsv = ["field,value"]
    .concat(infoFields.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`))
    .join("\n");

  // A short delay keeps browsers from dropping the second of two downloads
  // fired in the same tick.
  setTimeout(() => saveCsv(`${folder}/${folder}_station_info.csv`, infoCsv), 150);
}

/** Multi-series SVG line chart with crosshair tooltip. */
function lineChart(mount, series, opts) {
  opts = opts || {};
  const W = 880, H = opts.h || 300, M = { t: 30, r: 16, b: 34, l: 60 };
  const clean = (arr) => arr.filter((v) => v !== null && isFinite(v));

  let pool = series.flatMap((s) => clean(s.v));
  if (opts.band) pool = pool.concat(clean(opts.band.lo), clean(opts.band.hi));
  if (!pool.length) { mount.innerHTML = '<div class="placeholder">No numeric values to plot.</div>'; return; }

  let mn = Math.min(...pool), mx = Math.max(...pool);
  const pad = (mx - mn) * 0.12 || Math.abs(mx || 1) * 0.1 || 1;
  mx += pad; mn -= pad;

  const n = Math.max(...series.map((s) => s.v.length));
  const X = (i) => M.l + (n <= 1 ? 0.5 : i / (n - 1)) * (W - M.l - M.r);
  const Y = (v) => H - M.b - ((v - mn) / (mx - mn || 1)) * (H - M.t - M.b);

  // WCAG 1.1.1: one accessible name summarising the chart. Every value is
  // also available as a table on the Download tab.
  const fmtV = (v) => (v === null || v === undefined || !isFinite(v) ? "no value"
    : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
  const latest = series.map((se) => {
    const vs = se.v.filter((v) => v !== null && isFinite(v));
    return `${se.n} ${fmtV(vs[vs.length - 1])}${opts.unit ? " " + opts.unit : ""}`;
  }).join("; ");
  const lbl = opts.labels || [];
  const summary = `${opts.label || "Line chart"}. ${series.length} series, ${cm(n)} time steps` +
    (lbl.length ? ` from ${tsLabel(lbl[0])} to ${tsLabel(lbl[lbl.length - 1])} UTC` : "") +
    `, values ${fmtV(mn + pad)} to ${fmtV(mx - pad)}${opts.unit ? " " + opts.unit : ""}. Latest: ${latest}.` +
    (opts.tableHint === "inline"
      ? " Use the left and right arrow keys to read values; values are also listed in the table alongside this chart."
      : " Use the left and right arrow keys to read values; values are also listed in the Download tab.");
  // Focusable (WCAG 2.1.1) so the crosshair can be driven from the keyboard.
  const s = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": summary, tabindex: "0" });

  // ── Minor horizontal grid lines (4 subdivisions between each pair of major lines) ──
  for (let k = 0; k < 5; k++) {
    for (let m = 1; m <= 4; m++) {
      const v = mn + ((mx - mn) * (k + m / 5)) / 5;
      const y = Y(v);
      s.appendChild(el("line", { class: "gridline-minor", x1: M.l, x2: W - M.r, y1: y.toFixed(1), y2: y.toFixed(1) }));
    }
  }

  // ── Major horizontal grid lines + Y-axis value labels ──
  for (let k = 0; k <= 5; k++) {
    const v = mn + ((mx - mn) * k) / 5, y = Y(v);
    s.appendChild(el("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: y.toFixed(1), y2: y.toFixed(1) }));
    s.appendChild(el("text", { x: M.l - 9, y: (y + 3.5).toFixed(1), "text-anchor": "end", class: "tick" },
      [txt(Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2))]));
  }

  // ── X-axis tick positions (shared by vertical grid lines and labels) ──
  const lb = opts.labels || [];
  const xTicks = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]
    .filter((i, k, a) => i >= 0 && i < n && a.indexOf(i) === k);

  // ── Minor vertical grid lines (4 subdivisions between each pair of major vertical lines) ──
  for (let k = 0; k < xTicks.length - 1; k++) {
    const i0 = xTicks[k], i1 = xTicks[k + 1];
    for (let m = 1; m <= 4; m++) {
      const x = X(i0 + (i1 - i0) * m / 5);
      s.appendChild(el("line", { class: "gridline-minor-2", x1: x.toFixed(1), x2: x.toFixed(1), y1: M.t, y2: H - M.b }));
    }
  }

  // ── Major vertical grid lines at X-axis tick positions ──
  xTicks.forEach((i) => {
    const x = X(i);
    s.appendChild(el("line", { class: "gridline-minor", x1: x.toFixed(1), x2: x.toFixed(1), y1: M.t, y2: H - M.b }));
  });

  // ── Axis lines (Y-axis vertical + X-axis horizontal) ──
  s.appendChild(el("line", { class: "axis", x1: M.l, x2: M.l, y1: M.t, y2: H - M.b }));
  s.appendChild(el("line", { class: "axis", x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));

  // ── X-axis date labels ──
  xTicks.forEach((i) => {
    const raw = lb[i] ? String(lb[i]) : "";
    s.appendChild(el("text", {
      x: X(i).toFixed(1), y: H - M.b + 17,
      "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", class: "tick",
    }, [txt(raw.slice(5, 10) + " " + raw.slice(11, 16))]));
  });

  if (opts.unit) {
    s.appendChild(el("text", { x: M.l - 6, y: M.t - 12, "text-anchor": "end", class: "axlabel" }, [txt(opts.unit)]));
  }

  if (opts.band) {
    const up = opts.band.hi.map((v, i) => (v === null ? null : `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`))
      .filter(Boolean).join(" ");
    const dn = opts.band.lo.map((v, i) => [v, i]).reverse()
      .map(([v, i]) => (v === null ? null : `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`))
      .filter(Boolean).join(" ");
    if (up && dn) {
      s.appendChild(el("path", { d: `${up} ${dn} Z`, fill: "var(--s1)", "fill-opacity": ".16", stroke: "none" }));
    }
  }

  /* Optional vertical nudge so series that report identical values stay
     distinguishable instead of the upper line hiding the ones beneath it.
     Explore comparisons are frequently of the SAME parameter across
     different sensors/telemetry/equipment or stages, so exact overlap is
     the common case, not the edge case -- the step is a fixed pixel
     amount (not a fraction of plot height) so separation stays clearly
     visible regardless of chart size, capped so many series don't jitter
     off the plot area. This offsets DRAWN GEOMETRY ONLY (path + end dot).
     The axis scale, crosshair readout, tooltip, keyboard announcements
     and the table view all keep the exact recorded values, and every
     jittered chart carries a visible footnote saying the lines are
     nudged. */
  const plotH = H - M.t - M.b;
  const JITTER_STEP_PX = 9;
  const jitterStep = series.length > 1
    ? Math.min(JITTER_STEP_PX, (plotH * 0.4) / (series.length - 1))
    : 0;
  const jitterOf = (si) => (opts.jitter && series.length > 1
    ? (si - (series.length - 1) / 2) * jitterStep
    : 0);

  series.forEach((se, si) => {
    const dash = se.dash !== undefined ? se.dash : SERIES_DASHES[si % SERIES_DASHES.length];
    const dy = jitterOf(si);
    // Break the path at gaps so missing readings aren't drawn as a straight line.
    let d = "", pen = false;
    se.v.forEach((v, i) => {
      if (v === null || !isFinite(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${(Y(v) + dy).toFixed(1)} `;
      pen = true;
    });
    if (d) {
      s.appendChild(el("path", {
        d, fill: "none", stroke: se.c, "stroke-width": 2,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        ...(dash ? { "stroke-dasharray": dash } : {}),
      }));
    }
    const lastIdx = se.v.map((v, i) => (v !== null && isFinite(v) ? i : -1)).filter((i) => i >= 0).pop();
    if (lastIdx !== undefined) {
      s.appendChild(el("circle", {
        cx: X(lastIdx).toFixed(1), cy: (Y(se.v[lastIdx]) + dy).toFixed(1), r: 4,
        fill: se.c, stroke: "#fff", "stroke-width": 1.8,
      }));
    }
  });

  const ch = el("line", { class: "crosshair", y1: M.t, y2: H - M.b });
  s.appendChild(ch);

  mount.innerHTML = "";
  mount.appendChild(s);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("aria-hidden", "true");  // visual duplicate of the chart summary
  mount.appendChild(tip);
  // The tooltip is visual only; keyboard readings are announced here.
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  mount.appendChild(live);

  let cur = n - 1;
  const showAt = (i, announce) => {
    i = Math.max(0, Math.min(n - 1, i));
    cur = i;
    const b = s.getBoundingClientRect();
    ch.setAttribute("x1", X(i).toFixed(1));
    ch.setAttribute("x2", X(i).toFixed(1));
    ch.style.opacity = 0.6;
    tip.style.opacity = 1;
    tip.classList.add("on");
    tip.style.left = Math.min(b.width - 200, (X(i) / W) * b.width + 12) + "px";
    tip.style.top = "8px";
    const val = (v) => (v === null || !isFinite(v) ? "—" : v.toFixed(2));
    const hasRange = opts.band && opts.band.lo[i] !== null && opts.band.hi[i] !== null;
    tip.innerHTML =
      `<b>${esc(tsLabel(lb[i]))} UTC</b><br>` +
      series.map((se) => `<span style="color:${se.c}">&#9632;</span> ${esc(se.n)} ` +
        `<b>${val(se.v[i])}</b> ${esc(opts.unit || "")}`).join("<br>") +
      (hasRange ? `<br><span style="opacity:.7">range ${opts.band.lo[i].toFixed(2)}–${opts.band.hi[i].toFixed(2)}</span>` : "");
    if (announce) {
      live.textContent = `${tsLabel(lb[i])} UTC: ` +
        series.map((se) => `${se.n} ${val(se.v[i])} ${opts.unit || ""}`).join(", ") +
        (hasRange ? `, range ${opts.band.lo[i].toFixed(2)} to ${opts.band.hi[i].toFixed(2)}` : "") +
        `. Point ${i + 1} of ${n}.`;
    }
  };
  const hide = () => { ch.style.opacity = 0; tip.style.opacity = 0; tip.classList.remove("on"); };
  // WCAG 1.4.13 hoverable: moving between the chart and its tooltip keeps it.
  const within = (node, e) => e.relatedTarget && node.contains(e.relatedTarget);

  s.addEventListener("mousemove", (e) => {
    const b = s.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * W;
    showAt(Math.round(((px - M.l) / (W - M.l - M.r)) * (n - 1)), false);
  });
  s.addEventListener("mouseleave", (e) => { if (!within(tip, e) && document.activeElement !== s) hide(); });
  tip.addEventListener("mouseleave", (e) => { if (!within(s, e) && document.activeElement !== s) hide(); });

  // Left / Right step one reading, Page Up / Page Down a twentieth of the
  // series, Home / End jump to the first / latest reading.
  const big = Math.max(1, Math.round(n / 20));
  s.addEventListener("keydown", (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, PageUp: -big, PageDown: big };
    let i = null;
    if (moves[e.key] !== undefined) i = cur + moves[e.key];
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    if (i === null) return;
    e.preventDefault();
    showAt(i, true);
  });
  s.addEventListener("focus", () => showAt(cur, true));
  s.addEventListener("blur", hide);
}

// Plain language summary of what a station is monitoring and why, derived
// from LOCATION_TYPE (as reported by the originating data source) plus the
// source system. This helps a reader connect a station entry to the charts
// and tables shown elsewhere on the Station Detail tab, without requiring
// prior knowledge of Aquarius or hydrology terminology.
function stationPurpose(st) {
  const type = String(st.location_type || "").toLowerCase();
  const isAquarius = String(st.source_system || "").toUpperCase().startsWith("AQUARIUS");

  if (type.includes("diversion")) {
    return "Tracks water diverted from this site, such as a pump or intake, so the volume taken can be compared against what was reported.";
  }
  if (type.includes("reservoir") || type.includes("lake") || type.includes("impoundment") || type.includes("pond")) {
    return "Monitors water storage levels in a reservoir, pond, or impoundment, used to track how much water is being held or released over time.";
  }
  if (type.includes("well") || type.includes("groundwater") || type.includes("gw")) {
    return "Measures groundwater levels at a well, used to track how the water table rises and falls over time.";
  }
  if (type.includes("stream") || type.includes("river") || type.includes("creek")) {
    return "Measures streamflow and water level on a stream or river reach, used to track how much water is moving past this point over time.";
  }
  if (type.includes("spring")) {
    return "Monitors flow from a spring source, used to track natural discharge over time.";
  }
  if (isAquarius) {
    return "One of the study's own telemetered monitoring stations; see Location type above for the specific site category.";
  }
  return null;
}

function renderStationInfo(st) {
  // Equipment description comes from V_AQ_LOCATION_DATA (Aquarius only),
  // already nulled by the view where the landowner withholds it: the view
  // is most-restrictive-wins, so ACCESS_EQUIPMENT, ACCESS_EVENTS or
  // ACCESS_DOWNLOAD = 2 each hide it. Every Aquarius station shows the
  // line, so a missing description never looks like a missing feature: the
  // description, "withheld", or "not recorded in Aquarius". Other sources
  // have no equipment field, so the line is left off for them.
  const isAquarius = String(st.source_system || "").toUpperCase().startsWith("AQUARIUS");
  const equipmentWithheld = [st.access_equipment, st.access_events, st.access_download]
    .some((code) => Number(code) === 2);
  const equipment = st.equipment_description
    || (!isAquarius ? null
      : equipmentWithheld ? "withheld (data access policy)"
      : "not recorded in Aquarius");

  const fields = [
    ["Site key", st.site_key],
    ["Site number", st.site_no],
    ["Station name", st.station_name],
    ["Source system", displayName(st.source_system)],
    ["Location type", st.location_type],
    ["Purpose", stationPurpose(st)],
    ["Equipment", equipment],
    ["Latitude", Number(st.access_location) === 5 ? "withheld" : num(st.latitude)],
    ["Longitude", Number(st.access_location) === 5 ? "withheld" : num(st.longitude)],
    ["Elevation (ft)", st.elevation_ft],
    ["Watershed", st.watershed],
    ["HUC name", st.huc_name],
    ["HUC code", st.huc_code],
    ["HUC level", st.huc_level],
    ["First reading (UTC)", tsLabel(st.first_reading_utc)],
    ["Last reading (UTC)", tsLabel(st.last_reading_utc)],
    ["Measurements", cm(st.record_count)],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  $("#stationinfo").innerHTML =
    `<table><tbody>${fields.map(([k, v]) =>
      `<tr><td style="width:220px;color:var(--ink-3)">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`
    ).join("")}</tbody></table>`;
}

function renderAccessPolicy(st) {
  const codes = [
    ["Location", st.access_location, "Location coordinates (masked via Constrained Geomasking when restricted)"],
    // Equipment is all-or-nothing: 1 = description shown, 2 = withheld.
    ["Equipment", st.access_equipment, "Equipment description published", true],
    ["Events", st.access_events, "Diversion and site events published"],
    ["Parameters", st.access_parameters, "Measured parameters published"],
    ["Download", st.access_download, "Bulk CSV download offered for this station"],
  ];
  $("#accesslist").innerHTML = codes.map(([label, code, desc, binary]) => {
    const v = Number(code);
    const open = v === 1;
    const partial = !binary && (v === 2 || v === 3);
    const cls = open ? "acc-y" : partial ? "acc-p" : "acc-n";
    const glyph = open ? "✓" : partial ? "!" : "✕";
    const verdict = code === null || code === undefined
      ? "No access code recorded — treated as restricted."
      : open ? desc
      : partial ? `${desc} — generalized or partially masked (code ${esc(code)}).`
      : `${desc} — withheld (code ${esc(code)}).`;
    return `<div class="accrow">
      <div class="acci ${cls}">${glyph}</div>
      <div class="acctxt"><b>${esc(label)}</b>${esc(verdict)}</div>
    </div>`;
  }).join("");
}

/* ============================================================
   COMPARE
   ============================================================ */
function initComparePage() {
  const sel = $("#compare-param");
  const ovp = STATE.data.overview || {};
  const params = ovp.parameters || ovp.top_parameters || [];
  params.forEach((p) => sel.appendChild(new Option(
    (p.parameter_desc || p.parameter_cd) + (p.unit ? ` (${p.unit})` : ""), p.parameter_cd)));
  STATE.compare.param = sel.value || null;

  sel.addEventListener("change", () => {
    STATE.compare.param = sel.value;
    STATE.compare.sites = [];
    renderComparePicker();
    renderCompare();
    updateCompareDownloadBtn();
  });
  $$("#comparerange .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#comparerange .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    STATE.compare.days = Number(b.dataset.d);
    // A quick range replaces any From / To dates.
    STATE.compare.from = STATE.compare.to = "";
    $("#compare-from").value = $("#compare-to").value = "";
    renderCompare();
  }));

  // Search input: filter the station picker as the user types.
  $("#compare-search").addEventListener("input", (e) => {
    STATE.compare.search = e.target.value.trim().toLowerCase();
    renderComparePicker();
  });

  // From / To (UTC dates). Either end may be left open. Setting a date turns
  // the quick-range buttons off, so the chart has one window at a time.
  const onCompareDates = () => {
    STATE.compare.from = $("#compare-from").value;
    STATE.compare.to = $("#compare-to").value;
    const custom = !!(STATE.compare.from || STATE.compare.to);
    $$("#comparerange .seg").forEach((x) =>
      x.setAttribute("aria-pressed", String(!custom && Number(x.dataset.d) === STATE.compare.days)));
    renderCompare();
  };
  $("#compare-from").addEventListener("change", onCompareDates);
  $("#compare-to").addEventListener("change", onCompareDates);
  $("#compare-dates-clear").addEventListener("click", () => {
    $("#compare-from").value = $("#compare-to").value = "";
    onCompareDates();
  });

  // Download button
  $("#compare-download").addEventListener("click", downloadCompareData);

  renderComparePicker();
}

function updateCompareDownloadBtn() {
  const btn = $("#compare-download");
  if (btn) btn.disabled = STATE.compare.sites.length === 0;
}

function renderComparePicker() {
  const param = STATE.compare.param;
  const search = STATE.compare.search;
  let candidates = (STATE.data.stations || [])
    .filter((s) => !param || (s.parameters || []).includes(param));
  if (search) {
    candidates = candidates.filter((s) =>
      `${s.station_name || ""} ${s.site_no || ""} ${s.site_key || ""}`.toLowerCase().includes(search));
  }
  candidates.sort((a, b) => (b.record_count || 0) - (a.record_count || 0));

  $("#comparepicker").innerHTML = candidates.length
    ? `<table><tbody>${candidates.map((s) => {
        const on = STATE.compare.sites.includes(s.site_key);
        return `<tr class="selectable${on ? " selected" : ""}" data-key="${esc(s.site_key)}">
          <td><button type="button" class="rowbtn" aria-pressed="${on}"><span class="nm">${esc(s.station_name || s.site_key)}</span>
          <span class="sid">${esc(displayName(s.source_system))} · ${cm(s.record_count)} records</span></button></td>
        </tr>`;
      }).join("")}</tbody></table>`
    : `<div class="placeholder">${search ? `No stations match "${esc(search)}".` : "No stations report this parameter."}</div>`;

  $$("#comparepicker tr.selectable").forEach((tr) => tr.addEventListener("click", () => {
    const key = tr.dataset.key;
    const i = STATE.compare.sites.indexOf(key);
    if (i >= 0) STATE.compare.sites.splice(i, 1);
    else if (STATE.compare.sites.length < 4) STATE.compare.sites.push(key);
    // Clear the search bar so it's ready for the next search.
    STATE.compare.search = "";
    $("#compare-search").value = "";
    renderComparePicker();
    renderCompare();
    updateCompareDownloadBtn();
    const again = [...$$("#comparepicker tr.selectable")].find((r) => r.dataset.key === key);
    if (again) again.querySelector(".rowbtn").focus();
  }));
  updateCompareDownloadBtn();
}

async function renderCompare() {
  const mount = $("#comparechart");
  const keys = STATE.compare.sites;
  if (!keys.length) {
    mount.innerHTML = '<div class="placeholder">Choose one or more stations from the list.</div>';
    $("#comparelegend").innerHTML = "";
    $("#comparesub").textContent = "Select stations to overlay their series";
    return;
  }

  const { from, to } = STATE.compare;
  const custom = !!(from || to);
  if (custom && from && to && from > to) {
    mount.innerHTML = '<div class="placeholder">The From date is after the To date.</div>';
    $("#comparelegend").innerHTML = "";
    $("#comparesub").textContent = "";
    return;
  }

  showLoading(true);
  try {
    const loaded = [];
    for (const key of keys) {
      try { loaded.push(await fetchStation(key)); }
      catch (_) { /* a missing station file shouldn't break the whole overlay */ }
    }

    const cutoff = custom || STATE.compare.days >= 99999 ? null : Date.now() - STATE.compare.days * 86400000;

    // Union of timestamps across stations gives a shared x-axis.
    const perStation = loaded.map((st) => {
      const rows = (st.measurements || [])
        .filter((r) => String(r.parameter_cd) === String(STATE.compare.param))
        .filter((r) => custom ? inDateRange(r.timestamp_utc, from, to) : (!cutoff || new Date(r.timestamp_utc).getTime() >= cutoff))
        .sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));
      return { st, rows };
    }).filter((x) => x.rows.length);

    if (!perStation.length) {
      mount.innerHTML = '<div class="placeholder">No readings for this parameter in the selected window.</div>';
      $("#comparelegend").innerHTML = "";
      showLoading(false);
      return;
    }

    const stamps = [...new Set(perStation.flatMap((x) => x.rows.map((r) => r.timestamp_utc)))].sort();
    const series = perStation.map((x, i) => {
      const map = new Map(x.rows.map((r) => [r.timestamp_utc, num(r.value ?? r.value_mean)]));
      return {
        n: x.st.station_name || x.st.site_key,
        c: COMPARE_COLORS[i % COMPARE_COLORS.length],
        dash: SERIES_DASHES[i % SERIES_DASHES.length],
        v: stamps.map((t) => (map.has(t) ? map.get(t) : null)),
      };
    });

    const unit = perStation[0].rows[0].unit || "";
    $("#comparelegend").innerHTML = series.map((s) =>
      `<span class="l">${lineSwatch(s.c, s.dash)}${esc(s.n)}</span>`).join("");
    $("#comparetitle").textContent =
      `${perStation[0].rows[0].parameter_desc || STATE.compare.param}${unit ? ` (${unit})` : ""}`;

    // A selected station with no readings in the window would otherwise just
    // disappear from the chart — say so instead of dropping it silently.
    const plotted = new Set(perStation.map((x) => x.st.site_key));
    const skipped = loaded.filter((st) => !plotted.has(st.site_key));
    $("#comparesub").innerHTML =
      `${series.length} station${series.length === 1 ? "" : "s"} · ${cm(stamps.length)} time steps` +
      (skipped.length
        ? ` · <b>${skipped.length}</b> selected station${skipped.length === 1 ? " has" : "s have"} ` +
          `no readings of this parameter in the selected window ` +
          `(${skipped.map((s) => esc(s.station_name || s.site_key)).join(", ")})`
        : "");

    lineChart(mount, series, { labels: stamps, unit, h: 340,
      label: `Comparison of ${$("#comparetitle").textContent}` });
  } finally {
    showLoading(false);
  }
}

/**
 * "Download Selected Stations Data" (Compare page): exports the currently
 * selected stations' data for the active parameter and date range as a
 * combined CSV.
 */
async function downloadCompareData() {
  const keys = STATE.compare.sites;
  if (!keys.length) return;

  const { from, to } = STATE.compare;
  const custom = !!(from || to);
  if (custom && from && to && from > to) return;

  showLoading(true);
  try {
    const allRows = [];
    for (const key of keys) {
      try {
        const data = await fetchStation(key);
        let rows = (data.measurements || [])
          .filter((r) => String(r.parameter_cd) === String(STATE.compare.param));
        if (custom) {
          rows = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
        } else if (STATE.compare.days < 99999) {
          const cutoff = Date.now() - STATE.compare.days * 86400000;
          rows = rows.filter((r) => new Date(r.timestamp_utc).getTime() >= cutoff);
        }
        rows.forEach((r) => {
          if (!r.site_key) r.site_key = key;
          if (!r.station_name) r.station_name = data.station_name || "";
        });
        allRows.push(...rows);
      } catch (_) { /* skip stations that fail to load */ }
    }

    if (!allRows.length) {
      setNote("No data available for the selected stations, parameter, and date range.", true);
      return;
    }

    allRows.sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));

    const cols = ["timestamp_utc", "station_name", "site_key", "parameter_desc", "unit", "value", "source_system", "site_no"]
      .filter((c) => allRows[0][c] !== undefined);

    const csv = [cols.join(",")]
      .concat(allRows.map((r) => cols.map((c) => csvCell(c === "source_system" ? displayName(r[c]) : r[c])).join(",")))
      .join("\n");

    const paramSlug = slugSnake(STATE.compare.param || "data");
    const dateSlug = (from || to) ? `_${from || "start"}_${to || "end"}` : "";
    saveCsv(`rrts_compare_${paramSlug}${dateSlug}.csv`, csv);
  } finally {
    showLoading(false);
  }
}

/* ============================================================
   AQUARIUS TIERS
   Same layout as Compare: pick a parameter, pick an Aquarius station
   from the list, and its QC tiers S1..S5 are overlaid on one chart.
   Clicking a tier in the legend hides or shows it. Reads
   aquarius/index.json and aquarius/<site>.json, written separately from
   the general station files (which publish a single tier).
   ============================================================ */
async function initAquariusPage() {
  const paramSel = $("#aq-param");

  try {
    const resp = await fetch(`${STATE.dataBase}aquarius/index.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    STATE.aquarius.index = await resp.json();
  } catch (_) {
    // Builds made before this tab existed have no aquarius/ folder.
    $("#aqpicker").innerHTML = '<div class="placeholder">Aquarius tier data is not included in this build.</div>';
    $("#aqchart").innerHTML = '<div class="placeholder">Rebuild the dashboard to populate this tab.</div>';
    $("#aqsub").textContent = "";
    return;
  }

  // Parameter list across every Aquarius station, most readings first.
  const byParam = new Map();
  (STATE.aquarius.index.stations || []).forEach((s) => (s.parameters || []).forEach((p) => {
    const cur = byParam.get(p.parameter_cd) || { ...p, total: 0 };
    cur.total += tierCount(p);
    byParam.set(p.parameter_cd, cur);
  }));
  const params = [...byParam.values()].sort((a, b) => b.total - a.total);
  if (!params.length) {
    $("#aqpicker").innerHTML = '<div class="placeholder">No Aquarius tier readings in this build.</div>';
    $("#aqchart").innerHTML = '<div class="placeholder">No Aquarius tier readings in this build.</div>';
    $("#aqsub").textContent = "";
    return;
  }
  params.forEach((p) => paramSel.appendChild(new Option(
    (p.parameter_desc || p.parameter_cd) + (p.unit ? ` (${p.unit})` : ""), p.parameter_cd)));
  STATE.aquarius.param = paramSel.value;

  paramSel.addEventListener("change", () => {
    STATE.aquarius.param = paramSel.value;
    // Keep the selected station only if it reports the new parameter.
    const st = aquariusStation();
    if (st && !(st.parameters || []).some((p) => p.parameter_cd === STATE.aquarius.param)) {
      STATE.aquarius.site = null;
    }
    renderAquariusPicker();
    renderAquarius();
  });
  $$("#aqrange .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#aqrange .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    STATE.aquarius.days = Number(b.dataset.d);
    renderAquarius();
  }));

  renderAquariusPicker();
}

function aquariusStation() {
  return ((STATE.aquarius.index || {}).stations || []).find((s) => s.site_no === STATE.aquarius.site) || null;
}

function tierCount(p) {
  return Object.values(p.tiers || {}).reduce((n, t) => n + (t.count || 0), 0);
}

function renderAquariusPicker() {
  const param = STATE.aquarius.param;
  const candidates = ((STATE.aquarius.index || {}).stations || [])
    .map((s) => ({ s, p: (s.parameters || []).find((x) => x.parameter_cd === param) }))
    .filter((x) => x.p)
    .sort((a, b) => tierCount(b.p) - tierCount(a.p));

  $("#aqpicker").innerHTML = candidates.length
    ? `<table><tbody>${candidates.map(({ s, p }) => {
        const on = STATE.aquarius.site === s.site_no;
        const tiers = AQUARIUS_TIERS.filter((t) => (p.tiers || {})[t]).map((t) => `S${t}`).join(" · ");
        return `<tr class="selectable${on ? " selected" : ""}" data-site="${esc(s.site_no)}">
          <td><button type="button" class="rowbtn" aria-pressed="${on}"><span class="nm">${esc(s.station_name || s.site_no)}</span>
          <span class="sid">${esc(s.site_no)} · ${esc(tiers)} · ${cm(tierCount(p))} readings</span></button></td>
        </tr>`;
      }).join("")}</tbody></table>`
    : '<div class="placeholder">No Aquarius station reports this parameter.</div>';

  $$("#aqpicker tr.selectable").forEach((tr) => tr.addEventListener("click", () => {
    STATE.aquarius.site = tr.dataset.site;
    renderAquariusPicker();
    renderAquarius();
    const again = [...$$("#aqpicker tr.selectable")].find((r) => r.dataset.site === STATE.aquarius.site);
    if (again) again.querySelector(".rowbtn").focus();
  }));
}

function renderAquariusCoverage(st) {
  const p = st && (st.parameters || []).find((x) => x.parameter_cd === STATE.aquarius.param);
  $("#aqcoverage").innerHTML = p
    ? `<table>
        <thead><tr><th>Tier</th><th>Readings</th><th>First reading (UTC)</th><th>Last reading (UTC)</th></tr></thead>
        <tbody>${AQUARIUS_TIERS.map((t) => {
          const s = (p.tiers || {})[t];
          return `<tr>
            <td><i class="swatch" style="background:${TIER_COLORS[t]}"></i> <b>S${t}</b></td>
            <td>${s ? cm(s.count) : "—"}</td>
            <td>${s ? esc(tsLabel(s.first)) : "—"}</td>
            <td>${s ? esc(tsLabel(s.last)) : "—"}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`
    : "";

  // Privacy masking removes the parameter, so these can't be charted — say so.
  const withheld = (st && st.withheld) || {};
  const total = Object.values(withheld).reduce((n, v) => n + v, 0);
  $("#aqwithheld").innerHTML = total
    ? `<b>${cm(total)}</b> further readings at this station are withheld by the data access policy ` +
      `(${AQUARIUS_TIERS.filter((t) => withheld[t]).map((t) => `S${t}: ${cm(withheld[t])}`).join(", ")}).`
    : "";
}

async function fetchAquariusStation(st) {
  if (STATE.aquarius.cache[st.file]) return STATE.aquarius.cache[st.file];
  const resp = await fetch(`${STATE.dataBase}aquarius/${encodeURIComponent(st.file)}`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  STATE.aquarius.cache[st.file] = data;
  return data;
}

async function renderAquarius() {
  const mount = $("#aqchart");
  const st = aquariusStation();
  renderAquariusCoverage(st);

  if (!st) {
    mount.innerHTML = '<div class="placeholder">Choose a station from the list.</div>';
    $("#aqlegend").innerHTML = "";
    $("#aqtitle").textContent = "Tier comparison";
    $("#aqsub").textContent = "Choose a station from the list";
    return;
  }

  showLoading(true);
  try {
    let data;
    try { data = await fetchAquariusStation(st); }
    catch (err) {
      mount.innerHTML = `<div class="placeholder">Couldn't load this station's tier data (${esc(err.message)}).</div>`;
      return;
    }

    const ser = (data.series || {})[STATE.aquarius.param] || { tiers: {} };
    const cutoff = STATE.aquarius.days >= 99999 ? null : Date.now() - STATE.aquarius.days * 86400000;
    const perTier = AQUARIUS_TIERS.map((t) => {
      const raw = (ser.tiers || {})[t] || { t: [], v: [] };
      const pts = raw.t.map((ts, i) => [ts, num(raw.v[i])])
        .filter(([ts]) => !cutoff || new Date(ts).getTime() >= cutoff);
      return { tier: t, has: raw.t.length > 0, pts };
    });
    const unit = ser.unit || "";

    $("#aqtitle").textContent =
      `${ser.parameter_desc || STATE.aquarius.param}${unit ? ` (${unit})` : ""} — ${st.station_name || st.site_no}`;

    // Legend doubles as the tier picker (like choosing stations in Compare).
    $("#aqlegend").innerHTML = perTier.filter((x) => x.has).map((x) => {
      const off = STATE.aquarius.hidden.has(x.tier);
      return `<span class="l" data-tier="${x.tier}" role="button" tabindex="0" aria-pressed="${!off}" ` +
        `title="${off ? "Show" : "Hide"} S${x.tier}" style="cursor:pointer;opacity:${off ? 0.35 : 1}">` +
        `${lineSwatch(TIER_COLORS[x.tier], TIER_DASHES[x.tier])}S${x.tier}</span>`;
    }).join("");
    $$("#aqlegend span.l").forEach((el) => {
      const toggle = () => {
        const t = Number(el.dataset.tier);
        if (STATE.aquarius.hidden.has(t)) STATE.aquarius.hidden.delete(t); else STATE.aquarius.hidden.add(t);
        renderAquarius().then(() => {
          const back = $(`#aqlegend span.l[data-tier="${t}"]`);
          if (back) back.focus();
        });
      };
      el.addEventListener("click", toggle);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });

    const shown = perTier.filter((x) => x.pts.length && !STATE.aquarius.hidden.has(x.tier));
    if (!shown.length) {
      const anyInWindow = perTier.some((x) => x.pts.length);
      mount.innerHTML = `<div class="placeholder">${anyInWindow
        ? "All tiers are hidden — click a tier above to show it."
        : "No readings for this parameter in the selected window."}</div>`;
      $("#aqsub").textContent = anyInWindow ? "" : "Try a longer time range";
      return;
    }

    // Union of timestamps across tiers gives a shared x-axis.
    const stamps = [...new Set(shown.flatMap((x) => x.pts.map(([ts]) => ts)))].sort();
    const series = shown.map((x) => {
      const map = new Map(x.pts);
      return { n: `S${x.tier}`, c: TIER_COLORS[x.tier], dash: TIER_DASHES[x.tier],
        v: stamps.map((ts) => (map.has(ts) ? map.get(ts) : null)) };
    });

    const empty = perTier.filter((x) => x.has && !x.pts.length).map((x) => `S${x.tier}`);
    $("#aqsub").innerHTML =
      `${esc(st.site_no)} · ${series.length} tier${series.length === 1 ? "" : "s"} · ${cm(stamps.length)} time steps` +
      (empty.length ? ` · no readings in this window for ${empty.join(", ")}` : "");

    lineChart(mount, series, { labels: stamps, unit, h: 340,
      label: `Aquarius QC tiers, ${$("#aqtitle").textContent}` });
  } finally {
    showLoading(false);
  }
}

/* ============================================================
   EXPLORE STUDY STATIONS
   Pick a station and parameter, then narrow by stage, sensor type,
   telemetry type and equipment type.

   Results are split across two grouping dimensions, chosen by the
   "Group By" toggle. One dimension picks the chart, the other the lines
   drawn inside it:

     Stages -- one chart per Aquarius stage, one line per sensor combo
     Sensor -- one chart per sensor combo, one line per stage

   where a "sensor combo" is sensor_type + telemetry_type + equip_type,
   collapsing to "default" when a row carries none of the three.

   Charts stay as small multiples with their own y-axis rather than one
   shared axis, because the stages share a parameter but not a range and
   a single axis flattens whole stages into a straight line.
   Reads explore/index.json and explore/<site>.json, written by
   json_export.write_explore_study_stations_files(). Stations whose
   readings are withheld by data access policy are dropped at build time
   and never reach this tab.
   ============================================================ */

/* Aquarius reports "no reading" for some sensors as a hard 0 rather than
   a null. Plotting those sinks the trace to zero and crushes the real
   range, so a group that is entirely zero is treated as empty and zeros
   inside an otherwise live trace are treated as gaps. */
function exploreClean(values) {
  const nums = values.map(num);
  const live = nums.filter((v) => v !== null && isFinite(v));
  if (!live.length || live.every((v) => v === 0)) return null;
  return nums.map((v) => (v === 0 ? null : v));
}

function exploreSetBanner() {
  const b = $("#exp-banner");
  if (!b) return;
  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium", timeStyle: "short",
  });
  const withheld = (STATE.explore.index || {}).withheld_station_count || 0;
  b.innerHTML = `This section is in active development. Viewing live study station data as of ${esc(now)} PST.` +
    (withheld
      ? ` ${cm(withheld)} station${withheld === 1 ? " is" : "s are"} not shown here because their readings are withheld by data access policy.`
      : "");
}

async function initExplorePage() {
  const stationSel = $("#exp-station");

  try {
    const resp = await fetch(`${STATE.dataBase}explore/index.json`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    STATE.explore.index = await resp.json();
  } catch (_) {
    $("#expgrid").innerHTML = '<div class="card"><div class="body"><div class="placeholder">Explore Study Stations data is not included in this build. Rebuild the dashboard to populate this tab.</div></div></div>';
    $("#expsub").textContent = "";
    return;
  }

  exploreSetBanner();

  const stations = (STATE.explore.index.stations || [])
    .slice()
    .sort((a, b) => (a.station_name || a.site_no || "").localeCompare(b.station_name || b.site_no || ""));
  if (!stations.length) {
    $("#expgrid").innerHTML = '<div class="card"><div class="body"><div class="placeholder">No Explore Study Stations data in this build.</div></div></div>';
    return;
  }

  stationSel.innerHTML = stations
    .map((s) => `<option value="${esc(s.site_no)}">${esc(s.station_name || s.site_no)} (${esc(s.site_no)})</option>`)
    .join("");
  STATE.explore.site = stations[0].site_no;
  makeStationCombo(stationSel);

  $("#expstages").innerHTML = '<legend class="sr-only">Stages to show</legend>' +
    EXPLORE_STAGES.map((stg) =>
      `<label class="seg" style="cursor:pointer"><input type="checkbox" value="${stg}" checked style="margin-right:4px">${stg}</label>`
    ).join("");
  $$("#expstages input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const checked = $$("#expstages input[type=checkbox]:checked").map((x) => x.value);
      if (!checked.length) { cb.checked = true; return; }
      STATE.explore.stages = new Set(checked);
      exploreSyncFilters();
      renderExplore();
    });
  });

  stationSel.addEventListener("change", () => {
    STATE.explore.site = stationSel.value;
    STATE.explore.param = null;
    STATE.explore.sensor = STATE.explore.telem = STATE.explore.equip = "";
    exploreSyncFilters();
    renderExplore();
  });
  $("#exp-param").addEventListener("change", () => {
    STATE.explore.param = $("#exp-param").value;
    STATE.explore.sensor = STATE.explore.telem = STATE.explore.equip = "";
    exploreSyncFilters();
    renderExplore();
  });
  [["#exp-sensor", "sensor"], ["#exp-telem", "telem"], ["#exp-equip", "equip"]].forEach(([sel, key]) => {
    $(sel).addEventListener("change", () => {
      STATE.explore[key] = $(sel).value;
      exploreSyncFilters();
      renderExplore();
    });
  });

  $$("#exprange .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#exprange .seg").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      STATE.explore.days = +btn.dataset.d;
      STATE.explore.from = STATE.explore.to = "";
      $("#exp-from").value = ""; $("#exp-to").value = "";
      renderExplore();
    });
  });
  ["#exp-from", "#exp-to"].forEach((sel) => {
    $(sel).addEventListener("change", () => {
      STATE.explore.from = $("#exp-from").value;
      STATE.explore.to = $("#exp-to").value;
      if (STATE.explore.from || STATE.explore.to) {
        $$("#exprange .seg").forEach((b) => b.setAttribute("aria-pressed", "false"));
      }
      renderExplore();
    });
  });
  $("#exp-dates-clear").addEventListener("click", () => {
    STATE.explore.from = STATE.explore.to = "";
    $("#exp-from").value = ""; $("#exp-to").value = "";
    $$("#exprange .seg").forEach((b) => b.setAttribute("aria-pressed", b.dataset.d === String(STATE.explore.days) ? "true" : "false"));
    renderExplore();
  });

  $$("#exp-groupby .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (STATE.explore.groupBy === btn.dataset.g) return;
      $$("#exp-groupby .seg").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      STATE.explore.groupBy = btn.dataset.g;
      renderExplore();
    });
  });

  /* Overlap draws true positions; Jitter nudges overlapping lines apart so
     a hidden series is still visible. Overlap stays the default. */
  $$("#exp-markers .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (STATE.explore.markers === btn.dataset.m) return;
      $$("#exp-markers .seg").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      STATE.explore.markers = btn.dataset.m;
      renderExplore();
    });
  });

  $$("#exp-view-seg .seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wantTable = btn.dataset.v === "table";
      if (STATE.explore.tableView === wantTable) return;
      $$("#exp-view-seg .seg").forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      STATE.explore.tableView = wantTable;
      renderExplore();
    });
  });

  exploreSyncFilters();
  renderExplore();
}

function exploreStation() {
  return ((STATE.explore.index || {}).stations || []).find((s) => s.site_no === STATE.explore.site) || null;
}

/* The sensor "combo" dimension: sensor + telemetry + equipment treated as
   one grouping. Rows carrying none of the three collapse to "Default"
   rather than being dropped, so they still get a chart. */
function exploreGroupLabel(g) {
  const parts = [g.sensor_type, g.telemetry_type, g.equip_type].filter(Boolean);
  return parts.length ? parts.join(" \u00b7 ") : "Default";
}
function exploreComboKey(g) {
  return [g.sensor_type || "", g.telemetry_type || "", g.equip_type || ""].join("\u0000");
}
/* All groups for the current station + parameter, before filtering. */
function exploreAllGroups() {
  const st = exploreStation();
  const p = st && (st.parameters || []).find((x) => x.parameter_cd === STATE.explore.param);
  return (p && p.groups) || [];
}

/* Groups surviving every active filter. Each dropdown is applied in turn
   so the remaining dropdowns can be repopulated from what is left,
   which is what makes the filters cascade instead of offering dead ends. */
function exploreGroups(skip) {
  return exploreAllGroups().filter((g) => {
    if (g.stage && !STATE.explore.stages.has(g.stage)) return false;
    if (skip !== "sensor" && STATE.explore.sensor && (g.sensor_type || "") !== STATE.explore.sensor) return false;
    if (skip !== "telem" && STATE.explore.telem && (g.telemetry_type || "") !== STATE.explore.telem) return false;
    if (skip !== "equip" && STATE.explore.equip && (g.equip_type || "") !== STATE.explore.equip) return false;
    return true;
  });
}

/* Repopulate parameter + the three metadata dropdowns from surviving rows.
   A selection that no longer exists is dropped rather than left dangling. */
function exploreSyncFilters() {
  const st = exploreStation();
  const params = (st && st.parameters) || [];
  const paramSel = $("#exp-param");
  if (!params.some((p) => p.parameter_cd === STATE.explore.param)) {
    STATE.explore.param = params.length ? params[0].parameter_cd : null;
  }
  paramSel.innerHTML = params
    .map((p) => `<option value="${esc(p.parameter_cd)}"${p.parameter_cd === STATE.explore.param ? " selected" : ""}>${esc(p.parameter_desc || p.parameter_cd)}</option>`)
    .join("");

  [["sensor", "#exp-sensor", "sensor_type", "All sensor types"],
   ["telem", "#exp-telem", "telemetry_type", "All telemetry types"],
   ["equip", "#exp-equip", "equip_type", "All equipment types"]].forEach(([key, sel, field, allLabel]) => {
    const opts = [...new Set(exploreGroups(key).map((g) => g[field] || "").filter(Boolean))].sort();
    if (STATE.explore[key] && !opts.includes(STATE.explore[key])) STATE.explore[key] = "";
    const node = $(sel);
    node.innerHTML = `<option value="">${allLabel}</option>` +
      opts.map((o) => `<option value="${esc(o)}"${o === STATE.explore[key] ? " selected" : ""}>${esc(o)}</option>`).join("");
    node.disabled = opts.length === 0;
  });
}

/* Inclusive UTC window from the active preset or the From/To boxes. */
function exploreWindow() {
  if (STATE.explore.from || STATE.explore.to) {
    return {
      lo: STATE.explore.from ? new Date(`${STATE.explore.from}T00:00:00Z`).getTime() : -Infinity,
      hi: STATE.explore.to ? new Date(`${STATE.explore.to}T23:59:59Z`).getTime() : Infinity,
    };
  }
  const d = STATE.explore.days;
  if (!d || d >= 99999) return { lo: -Infinity, hi: Infinity };
  return { lo: Date.now() - d * 86400000, hi: Infinity };
}

async function fetchExploreStation(st) {
  if (STATE.explore.cache[st.file]) return STATE.explore.cache[st.file];
  const resp = await fetch(`${STATE.dataBase}explore/${encodeURIComponent(st.file)}`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  STATE.explore.cache[st.file] = data;
  return data;
}

async function renderExplore() {
  const grid = $("#expgrid");
  const st = exploreStation();
  if (!st || !STATE.explore.param) {
    grid.innerHTML = '<div class="card"><div class="body"><div class="placeholder">Choose a station and parameter.</div></div></div>';
    $("#expsub").textContent = "Choose a station and parameter";
    return;
  }

  showLoading(true);
  try {
    let data;
    try { data = await fetchExploreStation(st); }
    catch (err) {
      grid.innerHTML = `<div class="card"><div class="body"><div class="placeholder">Couldn\u0027t load this station\u0027s data (${esc(err.message)}).</div></div></div>`;
      return;
    }

    const ser = (data.series || {})[STATE.explore.param] || { groups: {} };
    const unit = ser.unit || "";
    const win = exploreWindow();
    const groups = exploreGroups();
    const byStage = STATE.explore.groupBy === "stages";
    const jitter = STATE.explore.markers === "jitter";

    /* Clip to the window and drop sentinel zeros, keeping each group on its
       own native timestamps. Grouping happens afterwards. */
    const rows = [];
    let skippedEmpty = 0;
    groups.forEach((g) => {
      const raw = (ser.groups || {})[g.key];
      if (!raw || !raw.t || !raw.t.length) return;
      const cleaned = exploreClean(raw.v || []);
      if (!cleaned) { skippedEmpty++; return; }
      const t = [], v = [];
      raw.t.forEach((ts, i) => {
        const ms = Date.parse(ts);
        if (!isFinite(ms) || ms < win.lo || ms > win.hi) return;
        t.push(ts); v.push(cleaned[i]);
      });
      if (!v.some((x) => x !== null && isFinite(x))) return;
      rows.push({ g, t, v });
    });

    /* Two grouping dimensions: one picks the chart, the other the lines
       inside it. "Stages" draws a chart per stage with one line per sensor
       combo; "Sensor" draws a chart per combo with one line per stage. */
    const charts = new Map();
    rows.forEach((row) => {
      const chartKey = byStage ? (row.g.stage || "\u2014") : exploreComboKey(row.g);
      const chartName = byStage ? (row.g.stage || "\u2014") : exploreGroupLabel(row.g);
      const seriesName = byStage ? exploreGroupLabel(row.g) : (row.g.stage || "\u2014");
      if (!charts.has(chartKey)) charts.set(chartKey, { name: chartName, items: [] });
      charts.get(chartKey).items.push({ name: seriesName, stage: row.g.stage, t: row.t, v: row.v });
    });

    /* Series inside one chart do not share a time axis -- stages start and
       stop at different dates. lineChart plots by array index against a
       single label list, so project every series onto the sorted union of
       the chart's timestamps and leave gaps as null rather than letting
       the arrays silently misalign. */
    const panels = [];
    const comboOrder = [];
    charts.forEach((chart, key) => {
      const stamps = [...new Set(chart.items.flatMap((s) => s.t))]
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const slot = new Map(stamps.map((ts, i) => [ts, i]));
      const series = chart.items.map((s) => {
        const v = new Array(stamps.length).fill(null);
        s.t.forEach((ts, i) => {
          const at = slot.get(ts);
          if (at !== undefined) v[at] = s.v[i];
        });
        return { name: s.name, stage: s.stage, v };
      });
      series.forEach((s) => {
        if (!byStage) return;
        if (!comboOrder.includes(s.name)) comboOrder.push(s.name);
      });
      panels.push({ key, name: chart.name, labels: stamps, series });
    });

    /* Stage charts in S1..S5 order; combo charts alphabetically. */
    panels.sort((a, b) => (byStage
      ? EXPLORE_STAGES.indexOf(a.name) - EXPLORE_STAGES.indexOf(b.name)
      : a.name.localeCompare(b.name)));

    const styleFor = (s) => (byStage
      ? { c: COMBO_COLORS[comboOrder.indexOf(s.name) % COMBO_COLORS.length],
          dash: COMBO_DASHES[comboOrder.indexOf(s.name) % COMBO_DASHES.length] }
      : { c: STAGE_COLORS[s.stage] || "#999", dash: STAGE_DASHES[s.stage] || "" });

    const total = cm(rows.reduce((a, r) => a + r.v.filter((x) => x !== null && isFinite(x)).length, 0));
    $("#expsub").innerHTML = panels.length
      ? `${esc(st.station_name || st.site_no)} \u00b7 ${esc(ser.parameter_desc || STATE.explore.param)}${unit ? ` (${esc(unit)})` : ""} \u00b7 ${panels.length} chart${panels.length === 1 ? "" : "s"} \u00b7 ${total} readings` +
        (skippedEmpty ? ` \u00b7 ${skippedEmpty} group${skippedEmpty === 1 ? "" : "s"} hidden because the sensor reported no values` : "")
      : "";

    if (!panels.length) {
      grid.innerHTML = `<div class="card"><div class="body"><div class="placeholder">${groups.length
        ? "No readings in the selected date range. Try a wider range or different filters."
        : "No groups match the current filters."}</div></div></div>`;
      return;
    }

    grid.innerHTML = panels.map((p, i) => {
      const legend = p.series.map((s) => {
        const sty = styleFor(s);
        return `<span class="lgi">${lineSwatch(sty.c, sty.dash)}${esc(s.name)}</span>`;
      }).join("");
      const live = p.series.reduce((a, s) => a + s.v.filter((x) => x !== null && isFinite(x)).length, 0);
      return `<div class="card" data-reveal="fade-up">` +
        `<header><div><h3>${esc(p.name)}</h3>` +
        `<div class="sub">${p.series.length} series</div></div></header>` +
        `<div class="body"><div class="explegend">${legend}</div><div id="exppanel-${i}"></div>` +
        `<div class="footnote">${cm(live)} readings \u00b7 ${tsLabel(p.labels[0])} to ${tsLabel(p.labels[p.labels.length - 1])} UTC` +
        (jitter && p.series.length > 1
          ? ` \u00b7 Lines are nudged vertically so overlapping series stay visible. Values and tooltips are unchanged.`
          : "") +
        `</div>` +
        `</div></div>`;
    }).join("");

    panels.forEach((p, i) => {
      const mount = $(`#exppanel-${i}`);
      if (!mount) return;
      if (STATE.explore.tableView) {
        /* One column per series, so the same row lines the series up at a
           shared timestamp. Rows where every series is blank are dropped. */
        mount.innerHTML = `<div class="tblscroll" tabindex="0" role="region" aria-label="${esc(p.name)} readings"><table class="tbl"><caption class="sr-only">${esc(p.name)} readings</caption>` +
          `<thead><tr><th scope="col">Timestamp (UTC)</th>` +
          p.series.map((s) => `<th scope="col">${esc(s.name)}${unit ? ` (${esc(unit)})` : ""}</th>`).join("") +
          `</tr></thead><tbody>` +
          p.labels.map((ts, j) => {
            if (!p.series.some((s) => s.v[j] !== null && isFinite(s.v[j]))) return "";
            return `<tr><td>${tsLabel(ts)}</td>` +
              p.series.map((s) => `<td>${s.v[j] === null || !isFinite(s.v[j]) ? "" : esc(String(s.v[j]))}</td>`).join("") +
              `</tr>`;
          }).join("") +
          `</tbody></table></div>`;
      } else {
        lineChart(mount, p.series.map((s) => {
          const sty = styleFor(s);
          return { n: s.name, c: sty.c, dash: sty.dash, v: s.v };
        }), {
          labels: p.labels, unit, h: 240, tableHint: "inline", jitter,
          label: `${p.name}, ${ser.parameter_desc || STATE.explore.param} at ${st.station_name || st.site_no}`,
        });
      }
    });

    // Cards are built after page load, so re-run the observer to pick
    // up the new data-reveal nodes.
    if (typeof initScrollReveal === "function") initScrollReveal();
  } finally {
    showLoading(false);
  }
}
/* ============================================================
   DOWNLOAD
   Hierarchical selection: every data source is listed with a
   source-level checkbox (checked by default) that expands to show
   its individual stations (also checked by default). Unchecking a
   source unchecks its stations; the parameter list below recomputes
   as the union of parameters across every currently checked station,
   defaulting to all-checked.
   ============================================================ */
function initDownloadPage() {
  const searchInput = $("#dl-station-search");
  const goBtn = $("#dl-go");

  renderDownloadSourceFilter();
  renderDownloadSourceTree();
  searchInput.addEventListener("input", renderDownloadSourceTree);
  $("#dl-from").addEventListener("change", updateDownloadState);
  $("#dl-to").addEventListener("change", updateDownloadState);
  $("#dl-dates-clear").addEventListener("click", () => {
    $("#dl-from").value = $("#dl-to").value = "";
    updateDownloadState();
  });
  $("#dl-param-all").addEventListener("click", () => {
    $$("#dl-param-rows input[type=checkbox]").forEach((cb) => (cb.checked = true));
    updateDownloadState();
  });
  $("#dl-param-none").addEventListener("click", () => {
    $$("#dl-param-rows input[type=checkbox]").forEach((cb) => (cb.checked = false));
    updateDownloadState();
  });
  goBtn.addEventListener("click", downloadCSV);

  // Format toggle: "Regular CSV" (flat measurement export) vs "CalWATRS
  // format" (CalWATRS-shaped file for reporting upload; see the Help &
  // Resources "CalWATRS Reporting Format" card for why this exists).
  $$("#dl-format-seg .seg").forEach((b) => b.addEventListener("click", () => {
    $$("#dl-format-seg .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    STATE.download.format = b.dataset.fmt;
    goBtn.textContent = STATE.download.format === "calwatrs" ? "Download CalWATRS CSV" : "Download CSV";
    updateDownloadState();
  }));

  // Metadata CSVs sit beside the station downloads, under whichever data
  // layout loadDashboardData() found.
  $$("a[data-file]").forEach((a) => { a.href = `${STATE.dataBase}downloads/${a.dataset.file}`; });

  // Preview toggle: show/hide the side-by-side data preview panel.
  const previewToggle = $("#dl-preview-toggle");
  if (previewToggle) {
    previewToggle.addEventListener("click", () => {
      const on = !STATE.download.previewVisible;
      STATE.download.previewVisible = on;
      previewToggle.setAttribute("aria-pressed", String(on));
      previewToggle.classList.toggle("on", on);
      $("#dl-body").classList.toggle("preview-on", on);
      $("#dl-preview-panel").classList.toggle("hidden", !on);
      if (on) renderDownloadPreview();
    });
  }

  renderDownloadParamPicker();
  updateDownloadState();
}

/** USGS parameter code for instantaneous flow — the only telemetry parameter
 * CalWATRS reporting can use (directly as Flow Rate of Diversion, and as the
 * basis for the calculated Volume Diverted). See build_config.yaml. */
const CALWATRS_FLOW_PARAM_CD = "00060";

/** Return the list of station objects currently checked in the source tree (ignores date/parameter filters). */
/** Download is blocked for these stations; the tree disables them too. */
function downloadRestricted(s) {
  return Number(s.access_download) === 2 || Number(s.access_events) === 2;
}

/** F2: enable/disable the Station Detail download button based on restriction. */
function syncDetailDownloadBtn() {
  const st = STATE.detail.station;
  const btn = $("#detail-download");
  if (!btn) return;
  if (!st) { btn.disabled = true; return; }
  const restricted = downloadRestricted(st);
  btn.disabled = restricted;
  btn.title = restricted ? "Download restricted by data access policy" : "";
}

function getDownloadStations() {
  const stations = STATE.data.stations || [];
  const checked = $$("#dl-source-tree input.dl-station-cb:checked");
  const keys = new Set(checked.map((cb) => cb.value));
  return stations.filter((s) => keys.has(s.site_key) && !downloadRestricted(s));
}

/**
 * Render the "Select data source(s)" chip filter above the source tree.
 * All sources are enabled by default; toggling a chip shows/hides that
 * source's block in the tree below (station selections within it are
 * preserved, just hidden from view and excluded from the download scope).
 */
function renderDownloadSourceFilter() {
  const stations = STATE.data.stations || [];
  const sources = [...new Set(stations.map((s) => s.source_system || ""))]
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  if (!STATE.download) STATE.download = {};
  if (!STATE.download.enabledSources) {
    STATE.download.enabledSources = new Set(sources);
  } else {
    // Keep any newly-seen sources enabled by default.
    sources.forEach((src) => {
      if (![...STATE.download.enabledSources].some((s) => s === src) && !STATE.download.disabledOnce?.has(src)) {
        STATE.download.enabledSources.add(src);
      }
    });
  }
  const enabled = STATE.download.enabledSources;

  $("#dl-source-filter").innerHTML = sources.map((src) => {
    const on = enabled.has(src);
    return `<button type="button" class="chip${on ? " on" : ""}" data-source="${esc(src)}" aria-pressed="${on}">${esc(displayName(src))}</button>`;
  }).join("");

  $$("#dl-source-filter button.chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.source;
      if (enabled.has(src)) {
        enabled.delete(src);
        if (!STATE.download.disabledOnce) STATE.download.disabledOnce = new Set();
        STATE.download.disabledOnce.add(src);
      } else {
        enabled.add(src);
      }
      btn.classList.toggle("on", enabled.has(src));
      btn.setAttribute("aria-pressed", enabled.has(src) ? "true" : "false");
      renderDownloadSourceTree();
      renderDownloadParamPicker();
      updateDownloadState();
    });
  });
}

/**
 * Render the source -> station checkbox tree. Each source is a <details>
 * with a source-level checkbox in its <summary> and one checkbox per
 * station inside. All boxes default to checked. Re-renders preserve any
 * unchecked state so typing in the search box doesn't reset selections.
 * Only sources currently enabled in the "Select data source(s)" filter
 * are shown.
 */
function renderDownloadSourceTree() {
  const search = ($("#dl-station-search").value || "").trim().toLowerCase();
  const stations = STATE.data.stations || [];
  const enabledSources = STATE.download?.enabledSources;

  const prevUnchecked = new Set(
    $$("#dl-source-tree input.dl-station-cb").filter((cb) => !cb.checked).map((cb) => cb.value)
  );
  const isFirstRender = $$("#dl-source-tree input.dl-station-cb").length === 0;

  // Capture which <details> elements are currently open so re-renders
  // don't force collapsed groups back open.
  const prevOpenSources = new Set(
    $$("#dl-source-tree details[open] input.dl-source-cb").map((cb) => cb.dataset.source)
  );

  const bySource = new Map();
  stations.forEach((s) => {
    const src = s.source_system || "";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(s);
  });
  let sources = [...bySource.keys()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  if (enabledSources) sources = sources.filter((src) => enabledSources.has(src));

  $("#dl-source-tree").innerHTML = sources.map((src) => {
    const all = bySource.get(src).slice()
      .sort((a, b) => (a.station_name || a.site_key).localeCompare(b.station_name || b.site_key));
    const visible = search
      ? all.filter((s) => `${s.station_name || ""} ${s.site_no || ""} ${s.site_key || ""}`.toLowerCase().includes(search))
      : all;
    if (search && !visible.length) return "";

    const rows = visible.map((s) => {
      const restricted = downloadRestricted(s);
      const checked = restricted ? false : (isFirstRender ? true : !prevUnchecked.has(s.site_key));
      return `<label class="${restricted ? "restricted" : ""}">
        <input type="checkbox" class="dl-station-cb" value="${esc(s.site_key)}" data-source="${esc(src)}"${checked ? " checked" : ""}${restricted ? " disabled" : ""}>
        <span class="nm">${esc(s.station_name || s.site_key)}</span>
        <span class="sid">${esc(s.site_no || "")}</span>
        ${restricted ? '<span class="restricted-badge" title="Download restricted by data access policy">⊘</span>' : ""}
      </label>`;
    }).join("");

    const isOpen = isFirstRender || prevOpenSources.has(src);
    return `<details${isOpen ? " open" : ""}>
      <summary>
        <input type="checkbox" class="dl-source-cb" data-source="${esc(src)}">
        ${esc(displayName(src))}
        <span class="n countpill">${cm(visible.length)} station${visible.length === 1 ? "" : "s"} · click to expand or collapse</span>
        <button type="button" class="dl-group-clear" data-source="${esc(src)}" aria-label="Clear all ${esc(displayName(src))} station data">Clear all ${esc(displayName(src))} station data</button>
      </summary>
      <div class="stationlist">${rows || `<div class="placeholder">No stations match.</div>`}</div>
    </details>`;
  }).join("") || `<div class="placeholder">No stations match.</div>`;

  updateDownloadSourceTreeCount();

  const toggleOnEnter = (e, cb) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  };

  $$("#dl-source-tree input.dl-station-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      syncSourceCheckboxState(cb.dataset.source);
      renderDownloadParamPicker();
      updateDownloadState();
      updateDownloadSourceTreeCount();
    });
    cb.addEventListener("keydown", (e) => toggleOnEnter(e, cb));
  });

  $$("#dl-source-tree input.dl-source-cb").forEach((cb) => {
    syncSourceCheckboxState(cb.dataset.source);
    cb.addEventListener("change", () => {
      $$(`#dl-source-tree input.dl-station-cb[data-source="${CSS.escape(cb.dataset.source)}"]`)
        .filter((scb) => !scb.disabled)
        .forEach((scb) => (scb.checked = cb.checked));
      cb.indeterminate = false;
      renderDownloadParamPicker();
      updateDownloadState();
      updateDownloadSourceTreeCount();
    });
    cb.addEventListener("keydown", (e) => toggleOnEnter(e, cb));
  });

  $$("#dl-source-tree button.dl-group-clear").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      $$(`#dl-source-tree input.dl-station-cb[data-source="${CSS.escape(btn.dataset.source)}"]`)
        .forEach((scb) => (scb.checked = false));
      syncSourceCheckboxState(btn.dataset.source);
      renderDownloadParamPicker();
      updateDownloadState();
      updateDownloadSourceTreeCount();
    });
  });
}

/** Set a source checkbox to checked/unchecked/indeterminate based on its stations' state. */
function syncSourceCheckboxState(source) {
  const sourceCb = $(`#dl-source-tree input.dl-source-cb[data-source="${CSS.escape(source)}"]`);
  if (!sourceCb) return;
  const stationCbs = $$(`#dl-source-tree input.dl-station-cb[data-source="${CSS.escape(source)}"]`).filter((cb) => !cb.disabled);
  const checkedCount = stationCbs.filter((cb) => cb.checked).length;
  sourceCb.checked = stationCbs.length > 0 && checkedCount === stationCbs.length;
  sourceCb.indeterminate = checkedCount > 0 && checkedCount < stationCbs.length;
}

function updateDownloadSourceTreeCount() {
  const allCbs = $$("#dl-source-tree input.dl-station-cb");
  const totalStations = allCbs.filter((cb) => !cb.disabled).length;
  const checkedStations = allCbs.filter((cb) => !cb.disabled && cb.checked).length;
  const restrictedCount = allCbs.filter((cb) => cb.disabled).length;
  const restrictedNote = restrictedCount ? ` (${cm(restrictedCount)} restricted)` : "";
  $("#dl-station-count").textContent = totalStations
    ? `${cm(checkedStations)} of ${cm(totalStations)} stations selected${restrictedNote}`
    : "";
}


/**
 * Render the parameter checkbox list, limited to parameters actually available
 * across the stations currently in scope. Defaults to every parameter checked
 * (i.e. no filter). Re-run whenever scope/source/station selection changes.
 */
function renderDownloadParamPicker() {
  const stations = getDownloadStations();

  // Station.parameters is a plain list of parameter codes (strings); the
  // descriptive text/unit live in the global parameter dimension, so
  // resolve each code through that lookup (falling back to the bare code).
  const dimByCode = new Map((STATE.data.parameters || []).map((p) => [String(p.parameter_cd), p]));
  const byCode = new Map();
  stations.forEach((s) => (s.parameters || []).forEach((code) => {
    if (!code) return;
    const key = String(code);
    if (byCode.has(key)) return;
    byCode.set(key, dimByCode.get(key) || { parameter_cd: key, parameter_desc: key, unit: null });
  }));
  const params = [...byCode.values()]
    .sort((a, b) => (a.parameter_desc || a.parameter_cd).localeCompare(b.parameter_desc || b.parameter_cd));

  // Preserve any still-valid selections across a re-render.
  const prevChecked = new Set($$("#dl-param-rows input[type=checkbox]:checked").map((cb) => cb.value));
  const prevTotal = $$("#dl-param-rows input[type=checkbox]").length;
  const keepSelections = prevTotal > 0 && prevChecked.size > 0 && prevChecked.size < prevTotal;

  $("#dl-param-rows").innerHTML = params.map((p) => {
    const label = p.parameter_desc || p.parameter_cd;
    const unit = p.unit ? ` (${p.unit})` : "";
    const checked = keepSelections ? prevChecked.has(p.parameter_cd) : true;
    return `<label><input type="checkbox" value="${esc(p.parameter_cd)}"${checked ? " checked" : ""}>${esc(label)}${esc(unit)}</label>`;
  }).join("") || `<div class="placeholder">No parameters available for this scope.</div>`;

  $$("#dl-param-rows input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", updateDownloadState));

  const total = params.length;
  const checkedCount = keepSelections ? [...prevChecked].filter((c) => byCode.has(c)).length : total;
  $("#dl-param-count").textContent = total ? `${cm(checkedCount)} of ${cm(total)} selected` : "";
}

/** Return the set of selected parameter codes, or null when every checkbox is checked (no filter). */
function getDownloadParams() {
  const boxes = $$("#dl-param-rows input[type=checkbox]");
  if (!boxes.length) return null;
  const checked = boxes.filter((cb) => cb.checked);
  if (checked.length === boxes.length) return null;
  return new Set(checked.map((cb) => cb.value));
}

/** Update the Download button state and the info note. Date/parameter filters apply at download time. */
function updateDownloadState() {
  const stations = getDownloadStations();
  const goBtn = $("#dl-go");
  const from = $("#dl-from").value, to = $("#dl-to").value;
  const dateNote = from && to ? ` between <b>${esc(from)}</b> and <b>${esc(to)}</b>`
    : from ? ` from <b>${esc(from)}</b> onward`
    : to ? ` through <b>${esc(to)}</b>`
    : "";
  const badRange = from && to && from > to;

  const scopeOk = stations.length > 0;
  const scopeNote = stations.length
    ? `<b>${cm(stations.length)}</b> station${stations.length === 1 ? "" : "s"} selected for download`
    : "Select one or more stations to download";

  goBtn.disabled = !scopeOk || badRange;
  $("#dlnote").innerHTML = badRange
    ? "The From date is after the To date."
    : `${scopeNote}${dateNote}.`;

  // CalWATRS mode: warn when some (or all) selected stations have no flow
  // data, since only flow/diversion parameters are reportable to CalWATRS.
  const formatNote = $("#dl-format-note");
  if (formatNote) {
    if (STATE.download.format === "calwatrs" && stations.length) {
      const noFlow = stations.filter((s) => !(s.parameters || []).some((p) => String(p) === CALWATRS_FLOW_PARAM_CD));
      formatNote.innerHTML = noFlow.length
        ? `⚠ ${cm(noFlow.length)} of ${cm(stations.length)} selected station${stations.length === 1 ? "" : "s"} ` +
          `${noFlow.length === 1 ? "has" : "have"} no flow data and won't appear in the CalWATRS file. ` +
          `Only flow/diversion readings are included; Volume Diverted is calculated from flow, not directly measured.`
        : `CalWATRS format includes only flow/diversion readings. Volume Diverted is calculated from flow, not directly measured.`;
    } else {
      formatNote.innerHTML = "";
    }
  }

  // Refresh the preview panel if it is visible.
  if (STATE.download.previewVisible) renderDownloadPreview();
}

/**
 * Render the Download Data Preview panel:
 *  - Summary stats: data sources, station count, parameter count, date range,
 *    per-source breakdown (station count + record count).
 *  - When parameters are filtered, the sample data and record counts reflect
 *    the filtered scope.
 *  - Sample data: CSV column headers + up to 5 sample rows from the first
 *    selected station (fetched via fetchStation), filtered by selected params.
 */
async function renderDownloadPreview() {
  const mount = $("#dl-preview-content");
  if (!mount) return;

  const stations = getDownloadStations();
  if (!stations.length) {
    mount.innerHTML = '<div class="placeholder">Select stations to see a preview.</div>';
    return;
  }

  const from = $("#dl-from").value, to = $("#dl-to").value;
  const params = getDownloadParams();
  const paramCount = params ? params.size : null;
  const hasFilters = !!(params || from || to);

  // Inline loading state scoped to this card, shown while the fetches below
  // are in flight — distinct from the full-page #loading overlay used during
  // the actual CSV download.
  mount.innerHTML = '<div class="spinner-inline"><span class="spinner-dot"></span>Calculating preview…</div>';

  // Fetch all selected stations in parallel to compute filtered counts
  // and find a station with matching data for the sample display.
  const loaded = await Promise.all(
    stations.map(async (s) => {
      try {
        const data = await fetchStation(s.site_key);
        return { station: s, data };
      } catch (_) {
        return { station: s, data: null };
      }
    })
  );

  // Compute filtered record counts per station and per source
  const bySource = new Map();
  let totalFilteredRecords = 0;
  let totalUnfilteredRecords = 0;
  let sampleStation = null;
  let sampleMeasurements = [];

  for (const { station, data } of loaded) {
    const src = station.source_system || "";
    if (!bySource.has(src)) bySource.set(src, { count: 0, records: 0, filteredRecords: 0 });
    const entry = bySource.get(src);
    entry.count++;
    entry.records += (station.record_count || 0);
    totalUnfilteredRecords += (station.record_count || 0);

    if (data && data.measurements) {
      let filtered = data.measurements;
      if (params) filtered = filtered.filter((r) => params.has(r.parameter_cd));
      if (from || to) filtered = filtered.filter((r) => inDateRange(r.timestamp_utc, from, to));
      entry.filteredRecords += filtered.length;
      totalFilteredRecords += filtered.length;

      // Use the first station that has matching data for the sample
      if (!sampleStation && filtered.length) {
        sampleStation = station;
        sampleMeasurements = filtered;
      }
    }
  }

  const sourceRows = [...bySource.entries()]
    .sort((a, b) => displayName(a[0]).localeCompare(displayName(b[0])))
    .map(([src, { count, records, filteredRecords }]) => {
      const recLabel = hasFilters ? `${cm(filteredRecords)} rec (filtered)` : `${cm(records)} rec`;
      return `<div class="preview-src-row"><span class="nm">${esc(displayName(src))}</span><span class="meta">${cm(count)} stn · ${recLabel}</span></div>`;
    }).join("");

  const dateLabel = from && to ? `${esc(from)} to ${esc(to)}`
    : from ? `${esc(from)} onward`
    : to ? `through ${esc(to)}`
    : "Full record";

  // Build sample data HTML
  let sampleHtml = "";
  const isCalwatrs = STATE.download.format === "calwatrs";

  if (isCalwatrs) {
    // Find the first selected station (with loaded data) that has flow
    // readings, to show a CalWATRS-shaped sample.
    let calStation = null, calRows = [];
    for (const { station, data } of loaded) {
      if (!data || !data.measurements) continue;
      let rows = data.measurements;
      if (from || to) rows = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
      const rs = buildCalwatrsRows(station, rows);
      if (rs.length) { calStation = station; calRows = rs; break; }
    }
    const noFlowCount = loaded.filter(({ station, data }) => {
      let rows = (data && data.measurements) || [];
      if (from || to) rows = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
      return buildCalwatrsRows(station, rows).length === 0;
    }).length;

    if (calStation && calRows.length) {
      const header = ["Date", "Time", "Measured Value", "Units", "Volume Diverted", "Volume Units", "Flow Rate of Diversion", "Flow Rate Units"];
      const sample = calRows.slice(0, 5);
      const headerRow = header.map((c) => `<th>${esc(c)}</th>`).join("");
      const bodyRows = sample.map((r) => `<tr>
        <td>${esc(r.date)}</td><td>${esc(r.time)}</td>
        <td>${r.measured_value.toFixed(2)}</td><td>${esc(r.measured_value_units)}</td>
        <td>${r.volume_diverted.toFixed(2)}</td><td>${esc(r.volume_units)}</td>
        <td>${r.flow_rate.toFixed(2)}</td><td>${esc(r.flow_rate_units)}</td>
      </tr>`).join("");
      sampleHtml = `
        <div class="preview-section-title">CalWATRS sample data</div>
        <div class="preview-sample">
          <div class="tablescroll">
            <table><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>
          </div>
        </div>
        <div class="preview-note">Sample from: ${esc(calStation.station_name || calStation.site_key)} · ${cm(calRows.length)} daily row${calRows.length === 1 ? "" : "s"} ·
          Volume Diverted is calculated from flow, not directly measured.
          ${noFlowCount ? ` ⚠ ${cm(noFlowCount)} selected station${noFlowCount === 1 ? "" : "s"} with no flow data will be excluded.` : ""}
        </div>
      `;
    } else {
      sampleHtml = `
        <div class="preview-section-title">CalWATRS sample data</div>
        <div class="placeholder">None of the selected stations have flow data to report to CalWATRS.</div>
      `;
    }
  } else if (sampleStation && sampleMeasurements.length) {
    const cols = ["timestamp_utc", "parameter_desc", "unit", "value"];
    const sample = sampleMeasurements.slice(0, 5);
    const headerRow = cols.map((c) => `<th>${esc(c)}</th>`).join("");
    const bodyRows = sample.map((r) =>
      `<tr>${cols.map((c) => `<td>${esc(r[c] !== null && r[c] !== undefined ? r[c] : "—")}</td>`).join("")}</tr>`
    ).join("");
    sampleHtml = `
      <div class="preview-section-title">Sample data</div>
      <div class="preview-sample">
        <div class="tablescroll">
          <table><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>
        </div>
      </div>
      <div class="preview-note">Sample from: ${esc(sampleStation.station_name || sampleStation.site_key)} (${esc(displayName(sampleStation.source_system))}) · ${cm(sampleMeasurements.length)} matching record${sampleMeasurements.length === 1 ? "" : "s"}</div>
    `;
  } else {
    sampleHtml = `
      <div class="preview-section-title">Sample data</div>
      <div class="placeholder">No records match the current filters for any selected station.</div>
    `;
  }

  // Restricted stations are disabled in the tree, so count them there.
  const restrictedCount = $$("#dl-source-tree input.dl-station-cb:disabled").length;
  let restrictionNote = "";
  if (restrictedCount) {
    restrictionNote = `
      <div class="preview-note" style="color:var(--policy-mark)">
        ⚠ ${cm(restrictedCount)} station${restrictedCount === 1 ? " is" : "s are"} not available for download.
        Their readings are withheld under data-sharing agreements.
      </div>
    `;
  }

  // Build the stats section
  const recordsLabel = hasFilters
    ? `${cm(totalFilteredRecords)} <span style="font-weight:400;color:var(--ink-3)">(filtered)</span>`
    : cm(totalUnfilteredRecords);

  const statsHtml = `
    <div class="preview-stats">
      <div class="preview-stat"><span class="k">Data sources</span><span class="v">${bySource.size}</span></div>
      <div class="preview-stat"><span class="k">Stations</span><span class="v">${cm(stations.length)}</span></div>
      <div class="preview-stat"><span class="k">Parameters</span><span class="v">${paramCount !== null ? cm(paramCount) : "All"}</span></div>
      <div class="preview-stat"><span class="k">Date range</span><span class="v">${dateLabel}</span></div>
      <div class="preview-stat"><span class="k">Total records</span><span class="v">${recordsLabel}</span></div>
    </div>
    <div class="preview-section-title">By source</div>
    <div class="preview-src">${sourceRows}</div>
    ${restrictionNote}
  `;

  mount.innerHTML = statsHtml + sampleHtml;
}

/**
 * Group a station's flow (00060) measurements by calendar day (UTC) and
 * compute the CalWATRS columns for each day:
 *  - Flow Rate of Diversion: the day's mean instantaneous flow (ft3/s), the
 *    only value actually measured by telemetry.
 *  - Volume Diverted: *calculated*, not measured — the mean flow integrated
 *    over 24 hours and converted to acre-feet (mean_cfs * 86400s / 43560 ft2
 *    per acre-ft). See the "CalWATRS Reporting Format" Help & Resources card.
 * Returns one row per station-day. Stations with no flow readings contribute
 * no rows and should be reported separately as "no reportable data".
 */
function buildCalwatrsRows(station, measurements) {
  const flowRows = (measurements || []).filter((r) => String(r.parameter_cd) === CALWATRS_FLOW_PARAM_CD);
  if (!flowRows.length) return [];

  const byDay = new Map();
  for (const r of flowRows) {
    const v = Number(r.value);
    if (!isFinite(v)) continue;
    const day = String(r.timestamp_utc).slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v);
  }

  const rows = [];
  for (const [day, values] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const meanCfs = values.reduce((s, v) => s + v, 0) / values.length;
    const acreFt = (meanCfs * 86400) / 43560;
    rows.push({
      site_key: station.site_key,
      station_name: station.station_name || station.site_key,
      date: day,
      time: "00:00",
      measured_value: meanCfs,
      measured_value_units: "ft3/s",
      volume_diverted: acreFt,
      volume_units: "acre-ft",
      flow_rate: meanCfs,
      flow_rate_units: "ft3/s",
    });
  }
  return rows;
}

/** Fetch all stations in scope, merge measurements, filter, and download as CSV. */
async function downloadCSV() {
  const stations = getDownloadStations();
  if (!stations.length) return;

  const params = getDownloadParams();
  const from = $("#dl-from").value, to = $("#dl-to").value;
  if (from && to && from > to) return;

  if (STATE.download.format === "calwatrs") {
    await downloadCalwatrs(stations, from, to);
    return;
  }

  // Fast path: a single station, no date/parameter filters, and the station's
  // access code permits publishing a pre-built CSV — download that directly
  // instead of re-fetching and re-serializing its full record in the browser.
  if (stations.length === 1 && !params && !from && !to && Number(stations[0].access_download) === 1) {
    const siteKey = stations[0].site_key;
    const a = document.createElement("a");
    a.href = `${STATE.dataBase}downloads/${encodeURIComponent(siteKey)}.csv`;
    a.download = `${siteKey}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  showLoading(true);
  try {
    const allRows = [];
    for (const st of stations) {
      try {
        const data = await fetchStation(st.site_key);
        let rows = data.measurements || [];
        if (params) {
          const byParam = groupByParam(rows);
          rows = Object.entries(byParam)
            .filter(([, prows]) => prows.length && params.has(prows[0].parameter_cd))
            .flatMap(([, prows]) => prows);
        }
        if (from || to) rows = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
        rows.forEach((r) => {
          if (!r.site_key) r.site_key = st.site_key;
          if (!r.station_name) r.station_name = st.station_name || "";
        });
        allRows.push(...rows);
      } catch (_) { /* skip stations that fail to load */ }
    }

    if (!allRows.length) {
      setNote("No data available for the selected scope, dates, and parameters.", true);
      return;
    }

    allRows.sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));

    const cols = ["timestamp_utc", "station_name", "site_key", "parameter_desc", "unit", "value", "source_system", "site_no"]
      .filter((c) => allRows[0][c] !== undefined);

    const csv = [cols.join(",")]
      .concat(allRows.map((r) => cols.map((c) => csvCell(c === "source_system" ? displayName(r[c]) : r[c])).join(",")))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const totalStations = $$("#dl-source-tree input.dl-station-cb").length;
    const base = stations.length === totalStations && totalStations > 0
      ? "rrts_all_stations"
      : "rrts_selected_stations";
    a.download = `${base}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

  } finally {
    showLoading(false);
  }
}

/**
 * Build and download a CalWATRS-shaped CSV: one row per station-day of flow
 * data, with Date/Time/Measured Value/Volume Diverted/Flow Rate of Diversion
 * columns (plus units), matching the 2026 Measurement & Reporting Manual
 * layout. Stations with no flow (00060) readings are skipped and reported
 * to the user via setNote().
 */
async function downloadCalwatrs(stations, from, to) {
  showLoading(true);
  try {
    const allRows = [];
    const noFlowStations = [];

    for (const st of stations) {
      try {
        const data = await fetchStation(st.site_key);
        let rows = data.measurements || [];
        if (from || to) rows = rows.filter((r) => inDateRange(r.timestamp_utc, from, to));
        const calRows = buildCalwatrsRows(st, rows);
        if (!calRows.length) {
          noFlowStations.push(st.station_name || st.site_key);
        } else {
          allRows.push(...calRows);
        }
      } catch (_) {
        noFlowStations.push(st.station_name || st.site_key);
      }
    }

    if (!allRows.length) {
      setDownloadNote("None of the selected stations have flow data to report to CalWATRS.", true);
      return;
    }

    allRows.sort((a, b) => `${a.site_key}|${a.date}`.localeCompare(`${b.site_key}|${b.date}`));

    const cols = ["site_key", "station_name", "date", "time", "measured_value", "measured_value_units",
      "volume_diverted", "volume_units", "flow_rate", "flow_rate_units"];
    const header = ["Site Key", "Station Name", "Date", "Time", "Measured Value", "Measured Value Units",
      "Volume Diverted", "Volume Units", "Flow Rate of Diversion", "Flow Rate Units"];

    const csv = [header.join(",")]
      .concat(allRows.map((r) => cols.map((c) => csvCell(
        typeof r[c] === "number" ? Number(r[c].toFixed(4)) : r[c]
      )).join(","))).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const dateTag = from && to ? `${from}_to_${to}` : from ? `from_${from}` : to ? `through_${to}` : "all_dates";
    const scopeTag = stations.length === 1 ? stations[0].site_key : `${stations.length}_stations`;
    a.download = `calwatrs_${scopeTag}_${dateTag}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (noFlowStations.length) {
      setDownloadNote(`Downloaded. ${cm(noFlowStations.length)} station${noFlowStations.length === 1 ? "" : "s"} had no flow data ` +
        `and ${noFlowStations.length === 1 ? "was" : "were"} excluded: ${noFlowStations.slice(0, 5).map(esc).join(", ")}` +
        `${noFlowStations.length > 5 ? ", …" : ""}.`, true);
    } else {
      setDownloadNote("");
    }
  } finally {
    showLoading(false);
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Text starting with = + - @ (or tab/CR) runs as a formula when the CSV is
  // opened in Excel or Sheets; a leading quote keeps it text. Numbers such as
  // -0.4 are left alone. _csv_safe_cell() in json_export.py does the same.
  if (/^[=+\-@\t\r]/.test(s) && !isFinite(Number(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
