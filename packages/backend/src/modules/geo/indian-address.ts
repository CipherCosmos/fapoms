/**
 * FAPOMS — reading an Indian postal address well enough to ask a geocoder about it.
 *
 * ## Why this exists
 *
 * Nominatim's structured search takes a `street`, a `city`, a `state` and a `postalcode`, and it
 * **ANDs** them: every component supplied has to match, or the whole query returns nothing. That
 * makes the `street` parameter unforgiving — and the roster's `address` column is not a street
 * line. It is the entire postal address in one string:
 *
 *     S/O Rajkumar Verma, Ward No-23, Babhuta Sidh Colony, Hanumangadh Town, Hanumangarh, Rajasthan-335513
 *
 * Passing that whole blob as `street` guarantees zero results. Measured against the live server on
 * a record whose address was perfectly good: the blob returned 0 hits, and the identical query
 * with the street simply dropped returned 1. Every row was paying for a query that could not
 * succeed, and then falling back to the pincode centroid — which is why the roster sat at a
 * uniform 3 km accuracy however good the address was.
 *
 * ## What it does, and what it deliberately does not
 *
 * This splits the address into segments, throws away the parts that are never a place, and ranks
 * what is left by how likely it is to be a name a map knows. It does not try to *understand* the
 * address — no attempt to identify which segment is the district or the taluk. It produces
 * ordered candidates for a cascade to try, and the geocoder's own verification decides whether an
 * answer is believable.
 *
 * The vocabulary is Indian on purpose (`nagar`, `colony`, `mohalla`, `bass`, `pet`, `vilai`), and
 * every rule below was written against real rows from the live roster, quoted in the spec.
 */

/**
 * "Son of", "care of", and their variants, with the name that follows.
 *
 * These open a large share of real rows and are pure noise to a geocoder — a person's name is not
 * a place (the same confusion that pinned 52 appraisers onto namesake businesses). The name runs
 * to the next comma, except that `S/O M.R. Jayaprakash # 155/A` has no comma before the house
 * number, so a `#` or a digit-run also ends it.
 */
const RELATION_PREFIX = /^\s*(?:s\s*\/\s*o|c\s*\/\s*o|d\s*\/\s*o|w\s*\/\s*o|h\s*\/\s*o)\s*:?\s*[^,#]*/i;

/**
 * A landmark is how a person finds a house, and it is not where the house is.
 *
 * "Near Bus Stand", "Opp Nageshwar Temple", "Ajima bakery near" — searching a map for these lands
 * on the landmark, which can be a kilometre away and belongs to somebody else. Both word orders
 * appear in the data ("Near X" and "X near"), so both are matched.
 */
const LANDMARK = /(?:^|\s)(?:near\s*by|near|opp\.?|opposite|behind|beside|back\s+side\s+of)(?:\s|$)|(?:\s)(?:near|opp\.?)\s*$/i;

/**
 * Numbers that identify a dwelling rather than a place.
 *
 * OSM does not hold Indian house numbers, so `4-69/47/B/20` can only ever fail to match and, being
 * ANDed, take an otherwise good query down with it. Covers the labelled forms (`House No-3984`,
 * `Plot No-12`, `Door no -3-3-11/A`, `Ward No-23`, `Flat No 2`), the `#` form (`# 155/A`), and a
 * bare segment that is nothing but digits and separators (`81`, `7/55`, `35-1-3/1`, `10-A`).
 */
const LABELLED_NUMBER = /\b(?:h\.?\s*no|house\s*no|door\s*no|d\.?\s*no|plot\s*no|flat\s*no|ward\s*no|room\s*no|shop\s*no|survey\s*no|khasra\s*no|no)\b\.?\s*[-:.]?\s*[\w/\-]*/gi;
const BARE_NUMBER_SEGMENT = /^[#\s]*\d[\d\s/\-.,]*[a-z]?$/i;

/** `Village- Raghunathpur`, `PO-Siddhipur`, `Vill-1 No Sahapara` — a label, then the actual name. */
const PLACE_LABEL = /^\s*(?:village|vill|po|p\.o|post|at|dist|district|taluk|taluka|tehsil|mandal|via)\b\.?\s*[-:]?\s*/i;

/**
 * The trailing `State-Pincode`, in every form the roster writes it.
 *
 * `Rajasthan-342802`, `A.P-533101`, `West Bengal - 743248`, and the dangling `Hydrabad-` where the
 * pincode was dropped. The pincode is passed to Nominatim as its own parameter, so leaving it
 * inside the street text only makes the street fail to match.
 */
const TRAILING_PINCODE = /[-,\s]+\d{6}\s*$/;
const ANY_PINCODE = /\b\d{6}\b/g;

/** Words that mark a segment as a way — the strongest thing to hand a map. */
const ROAD_WORDS = /\b(?:road|rd|marg|street|st|lane|ln|cross|main|highway|byp?ass|path|galli|gali|bylane)\b/i;

/**
 * Words that mark a named settlement or neighbourhood. Weaker than a road but far better than a
 * bare token, and in this roster they are frequently the only thing OSM actually holds.
 */
const PLACE_WORDS = /\b(?:nagar|colony|society|layout|puram|pura|pally|palli|halli|wadi|vadi|bagh|garden|gardens|enclave|vihar|apartments?|towns?hip|mohalla|pet|peta|pettai|bass|basti|vilai|kunj|niwas|villa|sadan|chowk|bazaar|bazar|mandi|market|circle|phase|sector|block|ward)\b/i;

/**
 * State names and the abbreviations the roster writes them as.
 *
 * A state is already passed to Nominatim as its own parameter, so a segment that is only a state
 * adds nothing; and left on the tail of a real name ("Ramapuram A.P") it stops that name matching
 * and defeats de-duplication, so the same place gets asked about twice under two spellings.
 */
const STATE_TAIL = /[\s,]+(?:a\.?\s?p|m\.?\s?p|u\.?\s?p|t\.?\s?n|w\.?\s?b|h\.?\s?p|j\.?\s?k|a\.?\s?n)\.?\s*$/i;
const STATE_NAMES = new Set([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
  'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
  'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'tamilnadu', 'telangana', 'tripura', 'uttar pradesh',
  'uttarakhand', 'west bengal', 'delhi', 'new delhi', 'jammu and kashmir', 'ladakh', 'puducherry',
  'chandigarh', 'andaman and nicobar islands', 'dadra and nagar haveli', 'daman and diu', 'lakshadweep',
]);

/** A door number that opens a segment: `1-78 Ramapuram`, `10-A Amikunj`, `4 Shree Krishna Niwas`. */
const LEADING_NUMBER = /^[\d][\d\s/\-.]*(?=[a-z])/i;

/**
 * A landmark marker used as a splitter rather than a verdict.
 *
 * Plenty of rows are written with no commas at all — "D-403 Rajhansh Residency Near Shubhash
 * Garden Doctor's Park Road Jahangirpura surat-395009" is one line from the live roster. Treating
 * the word "Near" as a reason to discard the segment threw that entire address away, road and
 * locality included, and then reported the person as having no usable address. Splitting on the
 * marker keeps both halves and only costs the landmark its own sub-segment.
 */
const LANDMARK_SPLIT = /\s+(?:near\s*by|near|opp\.?|opposite|behind|beside|landmark)\s*[-:]?\s+/i;

/**
 * The road phrase inside a longer run of words.
 *
 * "Shubhash Garden Doctor's Park Road Jahangirpura" holds a landmark, a real road and a locality
 * with nothing separating them. Handing the whole run to Nominatim as a street matches nothing;
 * "Doctor's Park Road" matches.
 *
 * The name is taken by walking backwards from the road word and stopping at the first word that
 * names something else — `Garden`, `Nagar`, `Colony`. That boundary is what a fixed window cannot
 * do: three words back from "Road" swallows "Garden" here, and two words back swallows "Nagar" in
 * "Revansiddheshwar Nagar Hotgi Road", where the road is only "Hotgi Road".
 */
function roadPhrase(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean);
  const road = words.findIndex((w) => ROAD_WORDS.test(w));
  if (road <= 0) return null;

  let start = road;
  while (
    start > 0
    && road - start < MAX_ROAD_NAME_WORDS
    && !PLACE_WORDS.test(words[start - 1])
    && !ROAD_WORDS.test(words[start - 1])
    && /[a-z]{2}/i.test(words[start - 1])
  ) start -= 1;

  // A road word with no name in front of it names nothing — the same rule as `cleanSegment`.
  if (start === road) return null;
  return words.slice(start, road + 1).join(' ');
}

/** Longest road name the roster writes: "Vidyaranyapuri Road", "Amrik Singh Road". */
const MAX_ROAD_NAME_WORDS = 3;

/**
 * Split on commas and semicolons, then on landmark markers, remembering which parts touched one.
 *
 * Both word orders occur — "Near Bus Stand" and "Ajima bakery near Tindivanam" — so which side of
 * the marker is the landmark cannot be decided from position. What can be decided is that a part
 * touching a marker and naming no road and no settlement type is the landmark itself: a shop, a
 * temple, a school. That is the rule `cleanSegment` applies, and it keeps "Shubhash Garden
 * Doctor's Park Road Jahangirpura" — which touches a marker and holds a real road — while
 * dropping "GEB Sub Station" and "Ajima bakery".
 */
interface Segment { text: string; touchesLandmark: boolean; }

const splitSegments = (address: string): Segment[] =>
  address.split(/[,;]+/).flatMap((chunk) => {
    const parts = chunk.split(LANDMARK_SPLIT);
    const touched = parts.length > 1 || /\s(?:near|opp\.?)\s*$/i.test(chunk);
    return parts
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ text, touchesLandmark: touched }));
  });

/**
 * Strip a segment down to the part that names a place, or to nothing.
 *
 * Returns `null` when what is left could not be a place name — which is the point: a segment that
 * reduces to nothing must be dropped, not passed on as an empty string that would match anything.
 */
function cleanSegment(segment: Segment): string | null {
  let s = segment.text.replace(RELATION_PREFIX, '');
  s = s.replace(ANY_PINCODE, ' ');
  s = s.replace(LABELLED_NUMBER, ' ');
  s = s.replace(PLACE_LABEL, '');
  s = s.replace(/[#]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(LEADING_NUMBER, '');
  s = s.replace(STATE_TAIL, '');
  s = s.replace(/^[-:.\s]+|[-:.,\s]+$/g, '').trim();

  if (!s) return null;
  // A state is already its own Nominatim parameter; as a street it can only fail to match.
  if (STATE_NAMES.has(s.toLowerCase())) return null;
  if (BARE_NUMBER_SEGMENT.test(s)) return null;
  // The landmark itself: it touches a marker and names neither a road nor a settlement, so it is
  // a shop or a temple, and searching for it lands on somebody else's building. See splitSegments.
  const namesAWay = ROAD_WORDS.test(s) || PLACE_WORDS.test(s);
  if ((segment.touchesLandmark || LANDMARK.test(s)) && !namesAWay) return null;
  // Two characters cannot identify a place, and single letters are block labels ("B", "A").
  if (s.length < 3) return null;
  // Nothing but punctuation and digits left over.
  if (!/[a-z]{3}/i.test(s)) return null;
  /**
   * A keyword with no name in front of it names nothing.
   *
   * `Street No-5` loses its number to LABELLED_NUMBER and would otherwise survive as the word
   * "Street" — which then sorts ABOVE the real road in the same address, because it matches
   * ROAD_WORDS. Searching a map for "Street" is worse than not searching.
   */
  const named = s.split(/\s+/).filter((w) => !ROAD_WORDS.test(w) && !PLACE_WORDS.test(w) && /[a-z]{3}/i.test(w));
  if (named.length === 0) return null;
  return s;
}

/**
 * Every part of the address that could name a place, best first.
 *
 * Ranked rather than filtered, because the cascade tries them in turn and stops at the first that
 * a map recognises: a road name beats a colony name beats a bare village name, and trying them in
 * that order is what makes the first hit also the most precise one.
 *
 * Order within a tier follows the address itself, which in Indian postal convention runs from the
 * most specific to the least — so the earliest road is the one nearest the house.
 */
export function placeCandidates(address: string | null | undefined): string[] {
  if (!address) return [];
  const cleaned = splitSegments(String(address).replace(TRAILING_PINCODE, ''))
    .map(cleanSegment)
    .filter((s): s is string => s !== null);

  /**
   * A road buried in a longer run is pulled out and asked about on its own, first.
   *
   * The run it came from is kept behind it rather than replaced: where the address IS just a road
   * name the two are the same string and de-duplication drops one, and where the run holds
   * something else useful it is still available further down the ladder.
   */
  const extracted = cleaned
    .map(roadPhrase)
    .filter((s): s is string => s !== null && s.length >= 4);

  const roads = [...extracted, ...cleaned.filter((s) => ROAD_WORDS.test(s))];
  const places = cleaned.filter((s) => !ROAD_WORDS.test(s) && PLACE_WORDS.test(s));
  const rest = cleaned.filter((s) => !ROAD_WORDS.test(s) && !PLACE_WORDS.test(s));

  // De-duplicated, because "Ramapuram" appears twice in some rows and asking twice costs a lookup
  // and returns the same answer.
  const seen = new Set<string>();
  return [...roads, ...places, ...rest].filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Is this address specific enough that failing to place it is worth telling somebody about?
 *
 * An address that yields no candidate at all — blank, or nothing but a name and a house number —
 * can never be geocoded, however good the geocoder is. That is a record to fix rather than a
 * lookup to retry, and it is the distinction the workforce flag is built on.
 */
export function isAddressUsable(address: string | null | undefined): boolean {
  return placeCandidates(address).length > 0;
}
