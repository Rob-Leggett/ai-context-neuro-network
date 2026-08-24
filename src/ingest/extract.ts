const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves just like get got make made want need really thing things use used using also going want know think well okay yes yeah`
    .split(/\s+/)
    .filter(Boolean),
);

// Conversational / status / generic-verb words that are not meaningful concepts
// even when capitalized (e.g. "Done", "Fixed", "Thanks"). Rejected as standalone terms.
const NOISE = new Set(
  `done fixed yes no okay ok sure great thanks thank hi hello hey please sorry maybe perhaps
   update updated create created add added remove removed change changed fix fixing run running
   check checking test testing build building start started stop stopped set setting done next
   step steps here there this that now then today yesterday tomorrow let lets sure right left
   good bad nice cool awesome perfect done working works worked file files folder folders code
   line lines error errors issue issues problem problems way ways time times day days part parts
   thing things stuff lot lots bit little big small new old current previous`
    .split(/\s+/)
    .filter(Boolean),
);

export interface Concept {
  label: string;
  kind: 'concept' | 'entity' | 'decision';
  weight: number;
}

export interface ExtractionResult {
  concepts: Concept[];
  /** co-occurrence pairs (by label) discovered in the same message */
  relations: { a: string; b: string; kind: string }[];
  decisions: string[];
}

const DECISION_CUES = [
  /\b(?:we|i|let'?s|team)\s+(?:decided|chose|agreed|will use|are using|are going with|settled on|picked)\b[^.!?\n]*/gi,
  /\b(?:decision|conclusion|going with|chosen approach)\s*[:\-][^.!?\n]*/gi,
];

/** Extract candidate multi-word / technical terms from a block of text. */
function candidateTerms(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (raw: string, by = 1) => {
    const term = raw.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (term.length < 3 || term.length > 60) return;
    const key = term.toLowerCase();
    const words = key.split(/\s+/);
    if (words.every((w) => STOPWORDS.has(w) || NOISE.has(w))) return;
    if (words.length === 1 && (STOPWORDS.has(key) || NOISE.has(key))) return;
    counts.set(term, (counts.get(term) ?? 0) + by);
  };

  // 1. `code identifiers` and quoted terms — high signal.
  for (const m of text.matchAll(/`([^`]{2,60})`/g)) bump(m[1], 2);
  for (const m of text.matchAll(/"([^"]{3,60})"/g)) bump(m[1], 2);

  // 2. Capitalized proper-noun phrases (Title Case runs).
  for (const m of text.matchAll(/\b([A-Z][\p{L}\p{N}]+(?:\s+[A-Z][\p{L}\p{N}]+){0,3})\b/gu)) {
    bump(m[1], 1.5);
  }

  // 3. Technical tokens: dotted/camelCase/snake_case identifiers.
  for (const m of text.matchAll(/\b([a-z][\w]*(?:[._-][\w]+)+|[a-z]+[A-Z]\w+)\b/g)) bump(m[1], 1.2);

  // 4. Frequent lowercase bigrams (domain phrases).
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  for (let i = 0; i < words.length - 1; i++) {
    bump(`${words[i]} ${words[i + 1]}`, 0.6);
  }

  return counts;
}

/**
 * Turn a message (or turn) into concepts + co-occurrence relations.
 * Deterministic, local, no model required — this is the baseline capture that
 * runs for every ingested message. Assistants can also supply explicit
 * concepts/relations via the MCP `remember` tool for higher-quality capture.
 */
export function extract(text: string, maxConcepts = 12): ExtractionResult {
  const counts = candidateTerms(text);
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= 0.6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxConcepts);

  const concepts: Concept[] = ranked.map(([label, weight]) => ({
    label,
    kind: /^[A-Z]/.test(label) && !label.includes(' ') ? 'entity' : 'concept',
    weight: Math.min(3, 1 + weight / 4),
  }));

  const relations: { a: string; b: string; kind: string }[] = [];
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      relations.push({ a: concepts[i].label, b: concepts[j].label, kind: 'related' });
    }
  }

  const decisions: string[] = [];
  for (const re of DECISION_CUES) {
    for (const m of text.matchAll(re)) {
      const d = m[0].trim().replace(/\s+/g, ' ').slice(0, 140);
      if (d.length > 8) decisions.push(d);
    }
  }

  return { concepts, relations, decisions };
}
