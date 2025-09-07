// api/program.js
import * as cheerio from "cheerio";

/**
 * /api/program?cinema=<atlas|svetozor>&date=YYYY-MM-DD
 * -> [{ title, shows: [{ time, hall }] }]
 */
export default async function handler(req, res) {
  try {
    const { cinema, date } = req.query || {};
    if (!cinema || !date) {
      res.status(400).json({ error: "chybí cinema nebo date" });
      return;
    }

    let items = [];
    if (cinema === "atlas") {
      items = await scrapeAtlas(date);
    } else if (cinema === "svetozor") {
      items = await scrapeSvetozor(date);
    } else {
      res.status(501).json({ error: "toto kino zatím neumím" });
      return;
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(items);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e) });
  }
}

/* ----------------------- Atlas ----------------------- */
async function scrapeAtlas(dateISO) {
  const urls = [
    "https://www.kinoatlaspraha.cz/program/",
    "https://www.kinoatlas.cz/program/"
  ];
  const html = await fetchFirstHtml(urls);
  if (!html.ok) throw new Error(`Atlas: ${html.status} ${html.snippet}`);

  const $ = cheerio.load(html.text);
  const byTitle = new Map();

  $("div.line").each((_, el) => {
    const dt = $(el).attr("data-program-date"); // 2025-09-07 13:00:00
    const title = $(el).attr("data-program-title") || "";
    if (!dt || !title) return;
    if (!dt.startsWith(dateISO + " ")) return;

    const time = dt.slice(11, 16);
    const hall =
      $(el).attr("data-program-hall") ||
      $(el).find(".hall,.program-hall").first().text().trim() ||
      "";

    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push({ time, hall });
  });

  return toItems(byTitle);
}

/* --------------------- Světozor ---------------------- */
async function scrapeSvetozor(dateISO) {
  // několik možných URL, některé weby dovolují parametr date
  const urls = [
    "https://www.kinosvetozor.cz/cz/program/",
    "https://www.kinosvetozor.cz/program/",
    `https://www.kinosvetozor.cz/cz/program/?date=${dateISO}`,
    `https://www.kinosvetozor.cz/program/?date=${dateISO}`
  ];
  const html = await fetchFirstHtml(urls);
  if (!html.ok) throw new Error(`Světozor: ${html.status} ${html.snippet}`);

  const $ = cheerio.load(html.text);
  const byTitle = new Map();

  /* A) data-program-* (nejčistší varianta) */
  $("[data-program-date][data-program-title]").each((_, el) => {
    const dt = $(el).attr("data-program-date");
    const title = clean($(el).attr("data-program-title"));
    if (!dt || !title) return;
    if (!dt.startsWith(dateISO + " ")) return;

    const time = toHHMM(dt.slice(11, 16));
    const hall =
      clean($(el).attr("data-program-hall")) ||
      clean($(el).find(".hall,.sál,.sal,.program-hall,.screen").first().text());

    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push({ time, hall });
  });

  /* B) JSON-LD s eventy (často spolehlivé) */
  if (byTitle.size === 0) {
    $("script[type='application/ld+json']").each((_, el) => {
      let jsonText = $(el).contents().text();
      if (!jsonText) return;
      try {
        const data = JSON.parse(jsonText);
        const list = Array.isArray(data) ? data : [data];
        for (const node of list) {
          collectEventsFromLd(node, dateISO, byTitle);
        }
      } catch {
        // ignoruj nevalidní JSON-LD
      }
    });
  }

  /* C) Fallback: vizuální HTML – <time> + nejbližší název */
  if (byTitle.size === 0) {
    $("time").each((_, t) => {
      const dtAttr = $(t).attr("datetime") || "";
      const dateFromTime = dtAttr.slice(0, 10);
      const timeText = dtAttr || $(t).text();
      const time = extractHHMM(timeText);
      if (!time) return;

      if (dateFromTime && dateFromTime !== dateISO) return;

      // blízký kontejner s titulkem
      const container = $(t).closest("article,li,div,section").first();

      // několik selektorů pro název
      const title =
        clean(
          container
            .find(".title,.film-title,h3,h2,a[href*='film'],a[href*='filmy']")
            .first()
            .text()
        ) ||
        // poslední záchrana – první delší řetězec v textu kontejneru
        clean(container.text())
          .split("\n")
          .map(s => s.trim())
          .find(s => s.length > 3) ||
        "";

      if (!title) return;

      const hall = clean(
        container.find(".hall,.sál,.sal,.screen,.program-hall").first().text()
      );

      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push({ time: toHHMM(time), hall });
    });
  }

  return toItems(byTitle);
}

/* -------------------- Pomocné věci ------------------- */
function toItems(byTitle) {
  return [...byTitle.entries()]
    .map(([title, shows]) => ({
      title,
      shows: shows
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
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
  }
  return { ok: false, status: lastStatus, snippet: (lastText || "").slice(0, 200) };
}

function collectEventsFromLd(node, dateISO, byTitle) {
  if (!node || typeof node !== "object") return;

  // pokud je to rovnou Event
  if ((node["@type"] === "Event" || node["@type"] === "Movie" || node["@type"] === "ScreeningEvent") && (node.startDate || node.startTime)) {
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
      if (title && time) {
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push({ time: toHHMM(time), hall });
      }
    }
  }

  // projdi vnořená pole a objekty
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => collectEventsFromLd(x, dateISO, byTitle));
    else if (v && typeof v === "object") collectEventsFromLd(v, dateISO, byTitle);
  }
}

function extractHHMM(s) {
  if (!s) return null;
  // ISO 2025-09-07T19:30:00+01:00 nebo jakýkoli text s hh:mm
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1].padStart(2, "0");
  return `${h}:${m[2]}`;
}

const clean
