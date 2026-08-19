/**
 * Counted nouns, written the way a person writes them.
 *
 * Screens across the app were reading "3 required field(s) missing", "8 assayer(s) moved",
 * "1 row(s) could not be imported". The "(s)" is a programmer's shorthand for "I did not want to
 * decide", and it leaks the fact that a machine assembled the sentence — which is exactly the
 * register this application is trying to get out of. It is also actively wrong at a count of one:
 * "1 row(s)" tells a clerk chasing a single failed import that the system is unsure how many
 * there were.
 *
 * English plurals here are the regular kind (fields, rows, certificates, assayers), so the rule
 * is simple; `plural` takes an explicit plural form for the cases that are not.
 */
export function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

/**
 * The same thing with the number in front, which is how these almost always appear:
 * `counted(3, 'required field')` → `3 required fields`, `counted(1, 'required field')` →
 * `1 required field`.
 */
export function counted(count: number, one: string, many?: string): string {
  return `${count} ${plural(count, one, many)}`;
}
