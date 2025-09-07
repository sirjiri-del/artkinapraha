// api/program.js
import * as cheerio from "cheerio";

/**
 * GET /api/program?cinema=<atlas|svetozor|lucerna|aero|edison>&date=YYYY-MM-DD
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
    else if (cinema === "edison") out = await safeScrapeEdison(date);
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

/* ---------------------- Edison ---------------------- */
async function safeScrapeEdison(dateISO) {
  try {
    const urls = [
      "https://www.edisonfilmhub.cz/cz/program/",
      "https://www.edisonfilmhub.cz/program/",
      `https://www.edisonfilmhub.cz/cz/program/?date=${dateISO}`,
      `https://www.edisonfilmhub.cz/program/?date=${dateISO}`
    ];
    const html = await fetchFirstHtml(urls);
    if (!html.ok) return { error: "Edison: načtení selhalo", status: html.status, snippet: html.snippet };

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
            box.find(".title,.film-title,h3,h2,a[href*='film']").first().text()
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
    return { error: "Edison: výjimka", detail: String(e), status: 500 };
  }
}

/* -------------------- Ostatní funkce ----------------- */
// (Atlas, Svetozor, Lucerna, Aero – beze změny jako máš už teď)
// + pomocné pushShow, toItems, fetchFirstHtml, collectEventsFromLd, extractHHMM, clean, hhmm
// … všechny nech tak, jak máš z poslední verze (jen přidej nový blok safeScrapeEdison)
