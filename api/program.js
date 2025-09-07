// api/program.js
import * as cheerio from "cheerio";

/**
 * Použití: /api/program?cinema=atlas&date=YYYY-MM-DD
 * Výstup: [{ title, shows: [{ time, hall }] }]
 */
export default async function handler(req, res) {
  try {
    const { cinema, date } = req.query || {};
    if (!cinema || !date) {
      res.status(400).json({ error: "chybí cinema nebo date" });
      return;
    }

    if (cinema !== "atlas") {
      res.status(501).json({ error: "zatím podporuji jen Atlas" });
      return;
    }

    const r = await fetch("https://www.kinoatlaspraha.cz/program/", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) {
      res.status(502).json({ error: "nešlo načíst stránku kina" });
      return;
    }
    const html = await r.text();
    const $ = cheerio.load(html);

    const byTitle = new Map();

    $("div.line").each((_, el) => {
      const dt = $(el).attr("data-program-date");      // např. 2025-09-07 13:00:00
      const title = $(el).attr("data-program-title") || "";
      if (!dt || !title) return;

      // filtr na zadané datum
      if (!dt.startsWith(date + " ")) return;

      const time = dt.slice(11, 16);

      // pokus o sál z atributu nebo z vnořeného prvku
      const hallAttr = $(el).attr("data-program-hall");
      const hallNode =
        $(el).find(".hall").text().trim() ||
        $(el).find(".program-hall").text().trim();
      const hall = hallAttr || hallNode || "";

      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push({ time, hall });
    });

    const items = [...byTitle.entries()]
      .map(([title, shows]) => ({ title, shows }))
      .sort((a, b) => a.title.localeCompare(b.title));

    // krátká keš na hraně
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(items);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e) });
  }
}
