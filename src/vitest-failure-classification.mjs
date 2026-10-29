/**
 * Vitest's JSON reporter stores error.stack || error.message in failureMessages,
 * not the Error object or a separate class field. Vitest replaces the stack of
 * promise settlement AssertionErrors with a captured plain Error stack, so that
 * one shape additionally needs the exact message and immediate matcher origin.
 */
export function isVitestAssertionFailure(failureMessages) {
  if (!Array.isArray(failureMessages)) return false;
  const messages = failureMessages.filter((message) => typeof message === 'string' && message.trim() !== '');
  return messages.length > 0 && messages.every((message) => {
    const [header = '', origin = ''] = message.trimStart().split(/\r?\n/, 2);
    return header === 'AssertionError'
      || header.startsWith('AssertionError:')
      || header.startsWith('AssertionError [')
      || isPromiseSettlementAssertion(header, origin);
  });
}

function isPromiseSettlementAssertion(header, origin) {
  const matcher = /^Error: promise rejected ".*" instead of resolving$/.test(header)
    ? 'RESOLVES'
    : /^Error: promise resolved ".*" instead of rejecting$/.test(header)
      ? 'REJECTS'
      : null;
  if (!matcher) return false;
  // A domain/hook error mentioning promises or a later expect frame is not
  // evidence. Only Vitest's own first stack frame can identify this rewrite.
  const frame = /^\s*at _?Assertion\.__VITEST_(RESOLVES|REJECTS)__ \((?:file:\/\/)?[^\r\n]*[/\\]node_modules[/\\]@vitest[/\\]expect[/\\]dist[/\\]index\.js:\d+:\d+\)$/.exec(origin);
  return frame?.[1] === matcher;
}
