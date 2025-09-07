// api/program.js
import * as cheerio from "cheerio";

/**
 * /api/program?cinema=<atlas|svetozor>&date=YYYY-MM-DD
 * Výstup: [{ title, shows: [{ time, hall }] }]
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
  // Zkoušíme více adres i případný parametr dne (pokud by existoval)
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

  // 1) Preferuj data v atributech (pokud existují)
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

  // 2) Fallback – najdi elementy s <time> a k nim blízký název
  if (byTitle.size === 0) {
    $("time").each((_, t) => {
      const dtAttr = $(t).attr("datetime") || "";
      const dateFromTime = dtAttr.slice(0, 10);
      const timeText = dtAttr || $(t).text();
      const time = extractHHMM(timeText);
      if (!time) return;

      // filtr na den – pokud není datum v datetime, bereme vše a zkusíme ho dohledat z kontextu
      if (
