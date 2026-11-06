/** What a saved login's value is replaced with wherever the server returns or records text. */
export const REDACTED_LOGIN = "[saved login]";

const htmlEscaped = (value: string, apostrophe: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", apostrophe);

/**
 * Every form a value commonly takes once a page or the server re-encodes it: literal,
 * JSON-escaped, URL-encoded (`%20` and `+`), HTML entities and whitespace-normalised.
 */
export const secretForms = (values: Iterable<string>): ReadonlyArray<string> => {
  const forms = new Set<string>();
  for (const value of values) {
    const encoded = encodeURIComponent(value);
    for (const form of [
      value,
      JSON.stringify(value).slice(1, -1),
      encoded,
      encoded.replaceAll("%20", "+"),
      htmlEscaped(value, "&#39;"),
      htmlEscaped(value, "&#x27;"),
      value.replace(/\s+/g, " ").trim(),
    ])
      if (form.length > 0) forms.add(form);
  }
  // Longest first, so a form inside another never leaves the rest showing.
  return [...forms].toSorted((a, b) => b.length - a.length);
};

export const redactText = (text: string, forms: ReadonlyArray<string>) => {
  let redacted = text;
  for (const form of forms) redacted = redacted.replaceAll(form, REDACTED_LOGIN);
  return redacted;
};

/** Replaces the forms in every string of a JSON-like value; an image's base64 stays intact. */
export const redactDeep = <A>(value: A, forms: ReadonlyArray<string>): A => {
  if (forms.length === 0) return value;
  const visit = (node: unknown, key: string | undefined): unknown => {
    if (typeof node === "string") return redactText(node, forms);
    if (Array.isArray(node)) return node.map((entry) => visit(entry, undefined));
    if (node === null || typeof node !== "object" || ArrayBuffer.isView(node)) return node;
    if (key === "screenshot") return node;
    return Object.fromEntries(
      Object.entries(node).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]),
    );
  };
  return visit(value, undefined) as A;
};
