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
      || isPromiseSettlementAssertion(header, origin)
      || isTestingLibraryQueryAssertion(header, message);
  });
}

function isTestingLibraryQueryAssertion(header, message) {
  if (!/^TestingLibraryElementError: (Unable to find |Found multiple elements)/.test(header)) return false;
  // DOM query errors include a pretty-printed document before the stack.
  // Require the first stack frame to identify the library's query assertion,
  // rather than accepting arbitrary runtime errors with a matching message.
  const origin = message.split(/\r?\n/).find((line) => /^\s*at /.test(line));
  return /^\s*at (?:Object\.)?getElementError \((?:file:\/\/)?[^\r\n]*[/\\]node_modules[/\\]@testing-library[/\\]dom[/\\]dist[/\\]config\.js:\d+:\d+\)$/.test(origin ?? '');
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
