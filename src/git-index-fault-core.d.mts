export function errorText(error: unknown): string;
export function indexFaultDiagnostic(error: unknown): string;
export function sleepSync(ms: number): void;
export function isRepositoryIndexFault(error: unknown): boolean;
export class RepositoryIndexFaultError extends Error {
  constructor(message: string, options?: { attempts?: number; cause?: unknown });
  isRepositoryIndexFault: boolean;
  attempts: number | undefined;
  cause: unknown;
}
export function withGitIndexFaultRetry<T>(run: () => T, options?: {
  attempts?: number; delayMs?: number;
  onRetry?: (info: { attempt: number; of: number; delayMs: number; error: unknown }) => void;
}): T;
