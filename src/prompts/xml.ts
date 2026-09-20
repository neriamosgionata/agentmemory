const VALID_TAG = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// #1271: take the LAST match, not the first. A chatty response can carry
// tag-shaped prose in its preamble ("the <title> field should..."), and the
// old first-match regex stored that preamble as the payload. Models emit
// their final answer last, so the last complete tag pair is the payload.
export function getXmlTag(xml: string, tag: string): string {
  if (!VALID_TAG.test(tag)) return "";
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let last = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    last = match[1].trim();
  }
  return last;
}

export function getXmlChildren(
  xml: string,
  parentTag: string,
  childTag: string,
): string[] {
  if (!VALID_TAG.test(parentTag) || !VALID_TAG.test(childTag)) return [];
  const parentRe = new RegExp(
    `<${parentTag}>([\\s\\S]*?)</${parentTag}>`,
    "g",
  );
  let parentBody = "";
  let parentMatch: RegExpExecArray | null;
  while ((parentMatch = parentRe.exec(xml)) !== null) {
    parentBody = parentMatch[1];
  }
  if (!parentBody) return [];
  const items: string[] = [];
  const re = new RegExp(`<${childTag}>([\\s\\S]*?)</${childTag}>`, "g");
  let m;
  while ((m = re.exec(parentBody)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}
