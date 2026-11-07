/**
 * Vitest's JSON reporter stores error.stack || error.message in failureMessages,
 * not the Error object or a separate class field. Vitest replaces the stack of
 * promise AssertionErrors with a captured plain Error stack, so those shapes
 * additionally need an assertion message and the immediate matcher origin.
 */
export function isVitestAssertionFailure(failureMessages) {
  if (!Array.isArray(failureMessages)) return false;
  const messages = failureMessages.filter((message) => typeof message === 'string' && message.trim() !== '');
  return messages.length > 0 && messages.every((message) => {
    const [header = ''] = message.trimStart().split(/\r?\n/, 1);
    return header === 'AssertionError'
      || header.startsWith('AssertionError:')
      || header.startsWith('AssertionError [')
      || isPromiseAssertion(header, message)
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

function isPromiseAssertion(header, message) {
  const matcher = /^Error: promise rejected ".*" instead of resolving$/.test(header)
    ? 'RESOLVES'
    : /^Error: promise resolved ".*" instead of rejecting$/.test(header)
      ? 'REJECTS'
      : null;
  // A settled promise can fail its value matcher as well as its settlement
  // matcher. Vitest retains the captured Error stack for both; object diffs
  // may insert explanatory lines before the first stack frame.
  if (!matcher && !/^Error: expected /.test(header)) return false;
  // A domain/hook error mentioning promises or a later expect frame is not
  // evidence. Only Vitest's own first stack frame can identify this rewrite.
  const origin = message.split(/\r?\n/).find((line) => /^\s*at /.test(line));
  const frame = /^\s*at _?Assertion\.__VITEST_(RESOLVES|REJECTS)__ \((?:file:\/\/)?[^\r\n]*[/\\]node_modules[/\\]@vitest[/\\]expect[/\\]dist[/\\]index\.js:\d+:\d+\)$/.exec(origin ?? '');
  return frame !== null && (matcher === null || frame[1] === matcher);
}
