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
   thing things stuff lot lots bit little big small new old current previous
   http https www ftp url uri href see note also thus hence eg ie etc based given`
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

/**
 * Strip high-noise, low-concept spans (URLs, emails, ARNs, bare host names)
 * before term extraction. These otherwise shatter into meaningless fragments
 * like "amazonaws com", "https awscom saml", "arn aws" or "jane.doe".
 */
function preClean(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(/\barn:[a-z0-9-]*:[^\s"'`]+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|gov|edu|co|amazonaws|cloud)\b/gi, ' ');
}

/** Extract candidate multi-word / technical terms from a block of text. */
function candidateTerms(raw: string): Map<string, number> {
  const text = preClean(raw);
  const counts = new Map<string, number>();
  const bump = (raw: string, by = 1) => {
    const term = raw.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (term.length < 3 || term.length > 60) return;
    if (/\d{5,}/.test(term)) return; // ids, dates, hashes (e.g. d-9767b75967, image 20250128)
    if (!term.includes(' ') && /^[\p{L}\p{N}+/=_-]{20,}$/u.test(term)) return; // random long ids/tokens
    const key = term.toLowerCase();
    const words = key.split(/\s+/);
    if (words.length > 4) return; // real concepts are short; longer = sentence fragment
    if (words.every((w) => STOPWORDS.has(w) || NOISE.has(w))) return;
    if (words.length === 1 && (STOPWORDS.has(key) || NOISE.has(key))) return;
    // Reject mostly-filler phrases (e.g. "both of them", "one of the").
    if (words.length >= 3) {
      const meaningful = words.filter((w) => !STOPWORDS.has(w) && !NOISE.has(w)).length;
      if (meaningful < Math.ceil(words.length / 2)) return;
    }
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

  // 4. RECURRING lowercase bigrams (real domain phrases, not incidental
  //    adjacency). We only keep a bigram if both words are substantial and the
  //    pair recurs in this block — this kills junk like "signs via" / "via maps".
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const bigramFreq = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (a.length < 4 || b.length < 4 || NOISE.has(a) || NOISE.has(b)) continue;
    const bg = `${a} ${b}`;
    bigramFreq.set(bg, (bigramFreq.get(bg) ?? 0) + 1);
  }
  for (const [bg, c] of bigramFreq) {
    if (c >= 2) bump(bg, 0.6 * Math.min(c, 3));
  }

  return counts;
}

/**
 * Drop candidate phrases that are just a sub-span of a longer, equally-or-more
 * prominent phrase (e.g. "aws iam" / "iam identity" inside "aws iam identity
 * center"). This removes redundant, fragmented connections.
 */
function dropSubphrases(entries: [string, number][]): [string, number][] {
  const meta = entries.map(([label, weight]) => ({
    label,
    weight,
    padded: ` ${label.toLowerCase()} `,
    n: label.split(/\s+/).length,
  }));
  return entries.filter(([label, weight], i) => {
    const e = meta[i];
    if (e.n === 1) return true;
    const sub = ` ${label.toLowerCase()} `;
    return !meta.some((o) => o !== e && o.n > e.n && o.padded.includes(sub) && o.weight >= weight * 0.8);
  });
}

/**
 * Turn a message (or turn) into concepts + co-occurrence relations.
 * Deterministic, local, no model required — this is the baseline capture that
 * runs for every ingested message. Assistants can also supply explicit
 * concepts/relations via the MCP `remember` tool for higher-quality capture.
 */
export function extract(text: string, maxConcepts = 12): ExtractionResult {
  const counts = candidateTerms(text);
  const filtered = [...counts.entries()].filter(([, c]) => c >= 0.6);
  const ranked = dropSubphrases(filtered)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxConcepts);

  const concepts: Concept[] = ranked.map(([label, weight]) => ({
    label,
    kind: /^[A-Z]/.test(label) && !label.includes(' ') ? 'entity' : 'concept',
    weight: Math.min(3, 1 + weight / 4),
  }));

  const relations: { a: string; b: string; kind: string }[] = [];
  const localSpans = preClean(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((span) => span.trim())
    .filter(Boolean);
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i].label.toLowerCase();
      const b = concepts[j].label.toLowerCase();
      const local = localSpans.some((span) => {
        const lower = span.toLowerCase();
        const ai = lower.indexOf(a);
        const bi = lower.indexOf(b);
        return ai >= 0 && bi >= 0 && Math.abs(ai - bi) <= 180;
      });
      if (local) relations.push({ a: concepts[i].label, b: concepts[j].label, kind: 'related' });
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
