/**
 * Phrases that give away German prose in a text that is supposed to be English.
 *
 * Not a language detector — a short list of high-confidence markers that leak through a
 * hand-maintained changelog: articles and verb forms English does not have as standalone
 * words, plus the compound nouns typical for adapter release notes.
 */
export const GERMAN_PHRASES: readonly string[] = [
  // Determiners and short function words English does not carry as standalone words
  "in der",
  "mit der",
  "auf der",
  "auf dem",
  "in den",
  "von der",
  "über die",
  "und ist",
  "und sind",
  "und wird",
  "und werden",
  "ist jetzt",
  "wird jetzt",
  "werden jetzt",
  // Compound nouns and verbs typical for adapter release notes
  "Mehrsprachig",
  "Datenpunkt",
  "Datenpunkte",
  "Datenpunkt-Namen",
  "Beschreibungen",
  "Sprachen)",
  "ioBroker-Systemsprache",
  "Systemsprache",
  "lokalisiert",
  "vereinheitlicht",
  "vorhanden",
  "gemerget",
  "ausnahme",
  "behoben",
  "verworfen",
  "vereinfacht",
  "abgewiesen",
  "Implementierungs-Trivia",
  "umgeschrieben",
  "umgestellt",
  "stoppt",
  "läuft",
  "Strip-Länge",
  "Stack-Traces",
  "Versionen",
  "Verbindung",
  "Geräte",
  "übersetzt",
];

/** An umlaut in an English text is a give-away on its own. */
const UMLAUT_RE = /[äöüßÄÖÜ]/;

/**
 * Find German markers in a text.
 *
 * Matches whole words: the boundary is spelled out as "not a letter" including umlauts,
 * because the shorthand word boundary is ASCII-only in JavaScript and would fire inside
 * German words. Keeps e.g. "parsed" from matching "parsen".
 *
 * @param text the text to inspect
 * @param minHits how many markers must be present before the text counts as German
 * @returns the markers found, empty when the text reads as English
 */
export function germanPhrasesIn(text: string, minHits = 1): string[] {
  const hits: string[] = [];
  if (UMLAUT_RE.test(text)) {
    hits.push("(umlaut)");
  }
  const lower = text.toLowerCase();
  for (const phrase of GERMAN_PHRASES) {
    const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-zäöüß])${escaped}(?:$|[^a-zäöüß])`);
    if (pattern.test(lower)) {
      hits.push(phrase);
    }
  }
  return hits.length >= minHits ? hits : [];
}
