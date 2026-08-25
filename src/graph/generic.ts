/**
 * Ultra-generic tokens that co-occur with almost everything (language keywords,
 * JSON/IAM policy words, filler). As graph hubs they blur community boundaries,
 * and they make useless cluster names / analysis results — so both the graph
 * view and the analyzer skip them when labelling and ranking structure.
 */
export const GENERIC = new Set(
  `string number boolean object array list item value key id name names type types option options
   date time none null undefined nan json xml yaml html css sql const let var function func method
   methods class classes classname return async await true false void enum interface public private
   protected static import export default effect action allow deny resource principal statement e.g
   i.e etc todo fixme note code codes file files folder promise label labels data map set get put
   post ensure ensures can should must will may also using used use uses new add added update updated
   remove response request result results status count index example examples version step steps
   description descriptions latest notes total note write writes click clicks select selects replace
   replaces content contents level levels search custom summary overview details conclusion decision`
    .split(/\s+/)
    .filter(Boolean),
);

/** True for tokens too generic to be a meaningful concept / cluster name. */
export function isGeneric(label: string): boolean {
  const k = label.trim().toLowerCase();
  return k.length < 3 || GENERIC.has(k);
}

/**
 * A captured "decision" is only meaningful if it carries content beyond the cue
 * word. Rejects bare cues like "Conclusion:", "decision:", "Conclusion:**".
 */
export function isMeaningfulDecision(label: string): boolean {
  const stripped = label
    .trim()
    .replace(/[*:>#\-\s]+/g, ' ')
    .replace(/\b(conclusion|decision|decisions|summary|note)\b/gi, '')
    .trim();
  return stripped.replace(/[^\p{L}\p{N}]/gu, '').length >= 6;
}
