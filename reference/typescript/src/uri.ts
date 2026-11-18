export type Scheme = "command" | "state";

export type ParseResult =
  | { ok: true; scheme: Scheme; uri: string; segments: string[] }
  | { ok: false; reason: string };

export interface ParseOptions {
  readonly templates?: boolean;
}

const SCHEME_PATTERN = /^(command|state):(.*)$/s;
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
const PARAM_PATTERN = /^:[a-z][a-z0-9-]*$/;
const CANONICAL_PATTERN = /^(command|state):\/(.*)$/;

export function parseRef(
  raw: unknown,
  scheme: Scheme,
  focusPath = "/",
  options: ParseOptions = {}
): ParseResult {
  if (typeof raw !== "string") return fail("URI must be a string");
  const match = SCHEME_PATTERN.exec(raw);
  if (!match) return fail(`Expected "command:" or "state:" scheme: ${raw}`);
  if (match[1] !== scheme) return fail(`Scheme mismatch: expected ${scheme}: in ${raw}`);

  const rest = match[2];
  if (rest.startsWith("//")) return fail(`Authority syntax is forbidden: ${raw}`);

  const absolute = rest.startsWith("/");
  const source = absolute ? rest : `${focusPath.replace(/\/+$/, "")}/${rest}`;
  const stack: string[] = [];

  for (const segment of source.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return fail(`Reference climbs above the root: ${raw}`);
      stack.pop();
      continue;
    }
    const valid =
      SEGMENT_PATTERN.test(segment) || (options.templates === true && PARAM_PATTERN.test(segment));
    if (!valid) return fail(`Invalid segment "${segment}" in ${raw}`);
    stack.push(segment);
  }

  return { ok: true, scheme, uri: `${scheme}:/${stack.join("/")}`, segments: stack };
}

export function matchesGlob(canonicalUri: string, glob: string): boolean {
  const uri = CANONICAL_PATTERN.exec(canonicalUri);
  const pattern = CANONICAL_PATTERN.exec(glob);
  if (!uri || !pattern || uri[1] !== pattern[1]) return false;
  const path = uri[2] ? uri[2].split("/") : [];
  const globSegments = pattern[2] ? pattern[2].split("/") : [];
  return matchSegments(path, globSegments, 0, 0);
}

export function matchTemplate(
  template: readonly string[],
  segments: readonly string[]
): Record<string, string> | undefined {
  if (template.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < template.length; i++) {
    const part = template[i];
    if (part.startsWith(":")) {
      params[part.slice(1)] = segments[i];
    } else if (part !== segments[i]) {
      return undefined;
    }
  }
  return params;
}

function matchSegments(path: readonly string[], glob: readonly string[], p: number, g: number): boolean {
  if (g === glob.length) return p === path.length;
  const pattern = glob[g];
  if (pattern === "**") {
    for (let next = p; next <= path.length; next++) {
      if (matchSegments(path, glob, next, g + 1)) return true;
    }
    return false;
  }
  if (p === path.length) return false;
  if (pattern === "*" || pattern === path[p]) return matchSegments(path, glob, p + 1, g + 1);
  return false;
}

function fail(reason: string): ParseResult {
  return { ok: false, reason };
}
