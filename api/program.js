// api/program.js
import * as cheerio from "cheerio";

/**
 * /api/program?cinema=atlas&date=YYYY-MM-DD
 * Vrací: [{ title, shows: [{ time, hall }] }]
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

    // primární a záložní URL pro případ změny domény
    const urls = [
      "https://www.kinoatlaspraha.cz/program/",
      "https://www.kinoatlas.cz/program/"
    ];

    // zkus načíst stránku s hlavičkami co vypadají jako běžný prohlížeč
    let html = null;
    let lastStatus = 0;
    let lastText = "";

    for (const url of urls) {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
        html = lastText;
        break;
      }
    }

    if (!html) {
      res
        .status(502)
        .json({
          error: "nešlo načíst stránku kina",
          status: lastStatus,
          snippet: (lastText || "").slice(0, 200)
        });
      return;
    }

    const $ = cheerio.load(html);
    const byTitle = new Map();

    $("div.line").each((_, el) => {
      const dt = $(el).attr("data-program-date");      // 2025-09-07 13:00:00
      const title = $(el).attr("data-program-title") || "";
      if (!dt || !title) return;

      if (!dt.startsWith(date + " ")) return;

      const time = dt.slice(11, 16);

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

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(items);
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e) });
  }
}
