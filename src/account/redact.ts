const GRANT_SHAPE = /cfa(?:_|%5f)live(?:_|%5f)[\w.~%+=-]*/gi;

export const REDACTED = "[redacted app grant]";

export function redactGrant(value: string): string {
  return value.replace(GRANT_SHAPE, REDACTED);
}

function scrub(error: Error, seen: WeakSet<Error>): void {
  if (seen.has(error)) return;
  seen.add(error);
  error.message = redactGrant(error.message);
  if (typeof error.stack === "string") error.stack = redactGrant(error.stack);
  if (error.cause instanceof Error) scrub(error.cause, seen);
}

export function redactError(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  scrub(error, new WeakSet());
  return error;
}

export function redactedMessage(err: unknown): string {
  return redactError(err).message;
}
