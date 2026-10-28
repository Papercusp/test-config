/**
 * Vitest's JSON reporter stores error.stack || error.message in failureMessages,
 * not the Error object or a separate class field. AssertionError in the first
 * line is the only failure shape this adapter may emit as mutation evidence.
 */
export function isVitestAssertionFailure(failureMessages) {
  if (!Array.isArray(failureMessages)) return false;
  const messages = failureMessages.filter((message) => typeof message === 'string' && message.trim() !== '');
  return messages.length > 0 && messages.every((message) => {
    const header = message.trimStart().split('\n', 1)[0]?.trimStart() ?? '';
    return header === 'AssertionError'
      || header.startsWith('AssertionError:')
      || header.startsWith('AssertionError [');
  });
}
