/**
 * Pure, dependency-free redaction for diagnostic text that can cross a UI,
 * log, or persistence boundary.
 *
 * This is intentionally shared. Session-part ingest already needed both
 * self-identifying token shapes and key-directed values; the task manager now
 * applies the same rules before exposing `/proc` cmdlines and upstream errors.
 */

const SELF_IDENTIFYING_SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

const KEY_DIRECTED_SECRET_RE = new RegExp(
  [
    // Search for the credential suffix itself. Arbitrary prefixes (AWS_, etc.)
    // stay untouched outside the match; greedily consuming them retries the
    // entire suffix at every character of a non-secret identifier, quadratically.
    String.raw`((?:(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential)s?|(?:access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|database[_-]?url))["'\s]*[:=]\s*["']?)([^\s"',;&)}\]]{8,})`,
    String.raw`((?:authorization|proxy-authorization)["'\s]*[:=]\s*["']?(?:bearer|basic|token)\s+)([^\s"',;&)}\]]{8,})`,
    String.raw`(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(?=-----END)`,
  ].join('|'),
  'gi',
);

const SENSITIVE_VALUE_KEY_RE =
  /(?:authorization|cookie|password|passphrase|secret|token|private.?key|access.?key|api.?key|client.?secret)/i;
const SAFE_REFERENCE_KEY_RE = /(?:credential|secret|token|key)ref$/i;

/**
 * True when an object KEY names a credential-bearing value (token, secret,
 * password, API key, ...). Opaque storage references (`credentialRef`,
 * `tokenRef`) are not sensitive. The one key-directed test shared by every
 * structured redactor, so consumers never fork the pattern.
 */
export function isSensitiveValueKey(key: string): boolean {
  return SENSITIVE_VALUE_KEY_RE.test(key) && !SAFE_REFERENCE_KEY_RE.test(key);
}

function sensitiveEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => isSensitiveValueKey(key) && typeof value === 'string' && value.length >= 16)
    .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
}

/**
 * The self-identifying set as plain data, for a redactor that must rebuild it
 * elsewhere — capability:bash streams it chunk-safely and ships it to its
 * durable systemd runner, which cannot import TypeScript (WI-10003538). This
 * stays the ONE definition; consumers must not fork the regex.
 */
export const SELF_IDENTIFYING_SECRET_PATTERN: Readonly<{ source: string; flags: string; replacement: string }> =
  Object.freeze({
    source: SELF_IDENTIFYING_SECRET_RE.source,
    flags: SELF_IDENTIFYING_SECRET_RE.flags,
    replacement: '[redacted]',
  });

/** Scrub token shapes that identify themselves without any surrounding key. */
export function redactSelfIdentifyingSecrets(text: string): string {
  return text.replace(SELF_IDENTIFYING_SECRET_RE, SELF_IDENTIFYING_SECRET_PATTERN.replacement);
}

/**
 * Scrub exact secret values whose format is deliberately opaque.
 *
 * Papercusp's local superuser bearer is random base64url-like text with no
 * self-identifying prefix. Treating every same-length alphanumeric string as a
 * secret would erase hashes and ids from diagnostics, so callers that know an
 * opaque value pass it explicitly. Ignore short values to avoid turning a bad
 * fixture or empty configuration into a broad text replacement.
 */
export function redactKnownSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let output = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 16) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

/** Scrub opaque values identified by a credential key/header next to them. */
export function redactKeyDirectedSecrets(text: string): string {
  return text.replace(KEY_DIRECTED_SECRET_RE, (match, ...groups: unknown[]) => {
    // Groups are [key1, value1, key2, value2, key3, value3, offset, input].
    for (let i = 0; i < 6; i += 2) {
      if (typeof groups[i] !== 'string') continue;
      // The value regex intentionally stops before `]`; preserve an existing
      // marker rather than turning a second scrub into `[redacted]]`.
      if (groups[i + 1] === '[redacted' || groups[i + 1] === '[redacted]') return match;
      return `${groups[i]}[redacted]`;
    }
    return '[redacted]';
  });
}

const POSTGRES_URL_USERINFO_RE = /\b(postgres(?:ql)?:\/\/)[^\s/@]+@/gi;

/** Scrub credentials embedded in PostgreSQL URLs even when no key labels the URL. */
function redactPostgresUrlUserInfo(text: string): string {
  return text.replace(POSTGRES_URL_USERINFO_RE, (_match, scheme: string) => `${scheme}[redacted]@`);
}

/** Defense-in-depth composition for arbitrary diagnostic text. */
export function redactSensitiveText(
  text: string,
  knownSecrets: readonly (string | null | undefined)[] = [],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return redactKnownSecrets(
    redactPostgresUrlUserInfo(redactKeyDirectedSecrets(redactSelfIdentifyingSecrets(text))),
    [...knownSecrets, ...sensitiveEnvironmentValues(environment)],
  );
}

/**
 * Defense-in-depth redaction for JSON-shaped values crossing a UI boundary.
 *
 * Key-directed secrets are removed before recursively scrubbing self-identifying
 * tokens from ordinary strings. Opaque references such as `credentialRef` are
 * intentionally preserved: they identify server-side storage without carrying
 * the credential itself. The input is never mutated.
 */
export function redactSensitiveValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  return redactSensitiveValueWith(value, redactSensitiveText, seen);
}

const STRUCTURED_STRING_SECRET_SIGNAL_RE = new RegExp(
  [
    String.raw`\b(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key(?:[_-]?id)?|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential|database[_-]?url)\s*=`,
    String.raw`\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  ].join('|'),
  'i',
);

function redactStructuredString(text: string): string {
  const selfIdentifyingRedacted = redactPostgresUrlUserInfo(redactSelfIdentifyingSecrets(text));
  const structuredRedacted = STRUCTURED_STRING_SECRET_SIGNAL_RE.test(selfIdentifyingRedacted)
    ? redactKeyDirectedSecrets(selfIdentifyingRedacted)
    : selfIdentifyingRedacted;
  return redactKnownSecrets(structuredRedacted, sensitiveEnvironmentValues());
}

/**
 * Redact parsed JSON-shaped data without treating ordinary prose inside a
 * string value (for example, "Design token: brand-accent") as a secret key.
 * Actual sensitive object keys, provider-shaped tokens, assignments, auth
 * headers, and private-key blocks remain protected.
 */
export function redactStructuredSensitiveValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  return redactSensitiveValueWith(value, redactStructuredString, seen);
}

function redactSensitiveValueWith(
  value: unknown,
  redactString: (text: string) => string,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValueWith(entry, redactString, seen));
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      isSensitiveValueKey(key)
        ? '[redacted]'
        : redactSensitiveValueWith(entry, redactString, seen);
  }
  seen.delete(value);
  return result;
}
