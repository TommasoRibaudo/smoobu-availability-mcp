/** An error whose message is safe to show to an anonymous caller. */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Smoobu returned a non-success status or could not be reached.
 * The message intentionally carries only the status code, never the body.
 */
export class SmoobuUpstreamError extends Error {
  override readonly name = 'SmoobuUpstreamError';
  constructor(
    readonly status: number | undefined,
    readonly attempts: number,
  ) {
    super(status === undefined ? `Smoobu unreachable after ${attempts} attempt(s)` : `Smoobu responded ${status} after ${attempts} attempt(s)`);
  }
}

/** Smoobu answered 2xx but the JSON did not have the shape we rely on. */
export class SmoobuShapeError extends Error {
  override readonly name = 'SmoobuShapeError';
  constructor(endpoint: string) {
    super(`Unexpected response shape from ${endpoint}`);
  }
}
