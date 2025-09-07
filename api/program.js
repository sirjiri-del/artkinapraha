// api/program.js
import * as cheerio from "cheerio";

/**
 * GET /api/program?cinema=<atlas|svetozor|lucerna|aero>&date=YYYY-MM-DD
 * Vrací: [{ title, shows: [{ time, hall }] }]
 */
export default async function handler(req, res) {
  try {
    const { cinema, date } = req.query || {};
    if (!cinema || !date) {
      res.status(400).json({ error: "chybí cinema nebo date" });
      return;
    }

    let out = { items: [] };

    if (cinema === "atlas") out = await safeScrapeAtlas(date);
    else if (cinema === "svetozor") out = await safeScrapeSvetozor(date);
    else if (cinema === "lucerna") out = await safeScrapeLucerna(date);
    else if (cinema === "aero") out = await safeScrapeAero(date);
    else {
      res.status(501).json({ error: "toto kino zatím neumím" });
      return;
    }

    if (out.error) {
      res.status(out.status || 502).json(out);
      return;
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(out.items);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e) });
  }
}

/* ----------------------- Atlas ----------------------- */
async function safeScrapeAtlas(dateISO) {
  try {
    const urls = [
      "https://www.kinoatlaspraha.cz/program/",
      "https://www.kinoatlas.cz/program/"
    ];
    const html = await fetchFirstHtml(urls);
    if (!html.ok) return { error: "Atlas: načtení selhalo", status: html.status, snippet: html.snippet };

    const $ = cheerio.load(html.text);
    const byTitle = new Map();

    $("div.line").each((_, el) => {
      const dt = $(el).attr("data-program-date");
      const title = $(el).attr("data-program-title") || "";
      if (!dt || !title) return;
      if (!dt.startsWith(dateISO + " ")) return;

      const time = dt.slice(11, 16);
      const hall =
        $(el).attr("data-program-hall") ||
        $(el).find(".hall,.program-hall").first().text().trim() ||
        "";

      pushShow(byTitle, title, { time, hall });
    });

    return { items: toItems(byTitle) };
  } catch (e) {
    return { error: "Atlas: výjimka", detail: String(e), status: 500 };
  }
}

/* --------------------- Světozor ---------------------- */
async function safeScrapeSvetozor(dateISO) {
  try {
    const urls = [
      "https://www.kinosvetozor.cz/cz/program/",
      "https://www.kinosvetozor.cz/program/",
      `https://www.kinosvetozor.cz/cz/program/?date=${dateISO}`,
      `https://www.kinosvetozor.cz/program/?date=${dateISO}`
    ];
    const html = await fetchFirstHtml(urls);
    if (!html.ok) return { error: "Světozor: načtení selhalo", status: html.status, snippet: html.snippet };

    const $ = cheerio.load(html.text);
    const byTitle = new Map();

    $("[data-program-date][data-program-title]").each((_, el) => {
      const dt = $(el).attr("data-program-date");
      const title = clean($(el).attr("data-program-title"));
      if (!dt || !title) return;
      if (!dt.startsWith(dateISO + " ")) return;

      const time = hhmm(dt.slice(11, 16));
      const hall =
        clean($(el).attr("data-program-hall")) ||
        clean($(el).find(".hall,.sál,.sal,.program-hall,.screen").first().text());
      pushShow(byTitle, title, { time, hall });
    });

    if (byTitle.size === 0) {
      $("script[type='application/ld+json']").each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          const arr = Array.isArray(data) ? data : [data];
          for (const node of arr) collectEventsFromLd(node, dateISO, byTitle);
        } catch {}
      });
    }

    if (byTitle.size === 0) {
      $("time").each((_, t) => {
        const dtAttr = $(t).attr("datetime") || "";
        const dateFromTime = dtAttr.slice(0, 10);
        const timeText = dtAttr || $(t).text();
        const time = extractHHMM(timeText);
        if (!time) return;
        if (dateFromTime && dateFromTime !== dateISO) return;

        const box = $(t).closest("article,li,div,section").first();
        const title =
          clean(
            box.find(".title,.film-title,h3,h2,a[href*='film'],a[href*='filmy']").first().text()
          ) ||
          clean(box.text()).split("\n").map(s => s.trim()).find(s => s.length > 3) ||
          "";

        if (!title) return;

        const hall = clean(box.find(".hall,.sál,.sal,.screen,.program-hall").first().text());
        pushShow(byTitle, title, { time: hhmm(time), hall });
      });
    }

    return { items: toItems(byTitle) };
  } catch (e) {
    return { error: "Světozor: výjimka", detail: String(e), status: 500 };
  }
}

/* ---------------------- Lucerna ---------------------- */
async function safeScrapeLucerna(dateISO) {
  try {
    const urls = [
      "https://www.kinolucerna.cz/cz/program/",
      "https://www.kinolucerna.cz/program/",
      `https://www.kinolucerna.cz/cz/program/?date=${dateISO}`,
      `https://www.kinolucerna.cz/program/?date=${dateISO}`,
      "https://www.lucerna.cz/cz/kino-lucerna/program/"
    ];
    const html = await fetchFirstHtml(urls);
    if (!html.ok) return { error: "Lucerna: načtení selhalo", status: html.status, snippet: html.snippet };

    const $ = cheerio.load(html.text);
    const byTitle = new Map();

    $("[data-program-date][data-program-title]").each((_, el) => {
      const dt = $(el).attr("data-program-date");
      const title = clean($(el).attr("data-program-title"));
      if (!dt || !title) return;
      if (!dt.startsWith(dateISO + " ")) return;

      const time = hhmm(dt.slice(11, 16));
      const hall =
        clean($(el).attr("data-program-hall")) ||
        clean($(el).find(".hall,.sál,.sal,.program-hall,.screen").first().text());
      pushShow(byTitle, title, { time, hall });
    });

    if (byTitle.size === 0) {
      $("script[type='application/ld+json']").each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          const arr = Array.isArray(data) ? data : [data];
          for (const node of arr) collectEventsFromLd(node, dateISO, byTitle);
        } catch {}
      });
    }

    if (byTitle.size === 0) {
      $("time").each((_, t) => {
        const dtAttr = $(t).attr("datetime") || "";
        const dateFromTime = dtAttr.slice(0, 10);
        const timeText = dtAttr || $(t).text();
        const time = extractHHMM(timeText);
        if (!time) return;
        if (dateFromTime && dateFromTime !== dateISO) return;

        const box = $(t).closest("article,li,div,section").first();
        const title =
          clean(
            box.find(".title,.film-title,h3,h2,a[href*='film'],a[href*='filmy']").first().text()
          ) ||
          clean(box.text()).split("\n").map(s => s.trim()).find(s => s.length > 3) ||
          "";

        if (!title) return;

        const hall = clean(box.find(".hall,.sál,.sal,.screen,.program-hall").first().text());
        pushShow(byTitle, title, { time: hhmm(time), hall });
      });
    }

    return { items: toItems(byTitle) };
  } catch (e) {
    return { error: "Lucerna: výjimka", detail: String(e), status: 500 };
  }
}

/* ------------------------ Aero ----------------------- */
async function safeScrapeAero(dateISO) {
  try {
    const urls = [
      "https://www.kinoaero.cz/cz/program/",
      "https://www.kinoaero.cz/program/",
      `https://www.kinoaero.cz/cz/program/?date=${dateISO}`,
      `https://www.kinoaero.cz/program/?date=${dateISO}`
    ];
    const html = await fetchFirstHtml(urls);
    if (!html.ok) return { error: "Aero: načtení selhalo", status: html.status, snippet: html.snippet };

    const $ = cheerio.load(html.text);
    const byTitle = new Map();

    // A) data atributy
    $("[data-program-date][data-program-title]").each((_, el) => {
      const dt = $(el).attr("data-program-date");
      const title = clean($(el).attr("data-program-title"));
      if (!dt || !title) return;
      if (!dt.startsWith(dateISO + " ")) return;

      const time = hhmm(dt.slice(11, 16));
      const hall =
        clean($(el).attr("data-program-hall")) ||
        clean($(el).find(".hall,.sál,.sal,.program-hall,.screen").first().text());
      pushShow(byTitle, title, { time, hall });
    });

    // B) JSON-LD
    if (byTitle.size === 0) {
      $("script[type='application/ld+json']").each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          const arr = Array.isArray(data) ? data : [data];
          for (const node of arr) collectEventsFromLd(node, dateISO, byTitle);
        } catch {}
      });
    }

    // C) fallback HTML
    if (byTitle.size === 0) {
      $("time").each((_, t) => {
        const dtAttr = $(t).attr("datetime") || "";
        const dateFromTime = dtAttr.slice(0, 10);
        const timeText = dtAttr || $(t).text();
        const time = extractHHMM(timeText);
        if (!time) return;
        if (dateFromTime && dateFromTime !== dateISO) return;

        const box = $(t).closest("article,li,div,section").first();
        const title =
          clean(
            box.find(".title,.film-title,h3,h2,a[href*='film'],a[href*='filmy']").first().text()
          ) ||
          clean(box.text()).split("\n").map(s => s.trim()).find(s => s.length > 3) ||
          "";

        if (!title) return;

        const hall = clean(box.find(".hall,.sál,.sal,.screen,.program-hall").first().text());
        pushShow(byTitle, title, { time: hhmm(time), hall });
      });
    }

    return { items: toItems(byTitle) };
  } catch (e) {
    return { error: "Aero: výjimka", detail: String(e), status: 500 };
  }
}

/* -------------------- Pomocné věci ------------------- */
function pushShow(map, title, show) {
  if (!title || !show || !show.time) return;
  if (!map.has(title)) map.set(title, []);
  map.get(title).push(show);
}

function toItems(byTitle) {
  return [...byTitle.entries()]
    .map(([title, shows]) => ({
      title,
      shows: (shows || [])
        .filter(s => s.time)
        .sort((a, b) => a.time.localeCompare(b.time))
    }))
    .filter(x => x.shows.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function fetchFirstHtml(urls) {
  let lastStatus = 0;
  let lastText = "";
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Referer": url
        }
      });
      lastStatus = r.status;
      lastText = await r.text();
      if (r.ok && lastText && lastText.includes("<html")) {
        return { ok: true, status: r.status, text: lastText };
      }
    } catch (e) {
      lastText = String(e);
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus, snippet: (lastText || "").slice(0, 200) };
}

function collectEventsFromLd(node, dateISO, byTitle) {
  if (!node || typeof node !== "object") return;

  const types = new Set([node["@type"]].flat().filter(Boolean));
  const isEvent = types.has("Event") || types.has("ScreeningEvent") || types.has("Movie");

  if (isEvent && (node.startDate || node.startTime)) {
    const start = node.startDate || node.startTime || "";
    const d = String(start).slice(0, 10);
    if (d === dateISO) {
      const time = extractHHMM(start);
      const title =
        clean(node.name) ||
        clean(node.workPresented && node.workPresented.name) ||
        "";
      const hall =
        clean(node.location && (node.location.name || node.location.address)) ||
        clean(node.superEvent && node.superEvent.location && node.superEvent.location.name) ||
        "";
      pushShow(byTitle, title, { time: hhmm(time), hall });
    }
  }

  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => collectEventsFromLd(x, dateISO, byTitle));
    else if (v && typeof v === "object") collectEventsFromLd(v, dateISO, byTitle);
  }
}

function extractHHMM(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1].padStart(2, "0");
  return `${h}:${m[2]}`;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const hhmm = (s) => extractHHMM(s);
