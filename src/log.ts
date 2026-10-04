/**
 * The only logging facility in src/. ESLint forbids `console` elsewhere.
 *
 * The field type is restricted to numbers and booleans on purpose: a log line
 * can say "upstream returned 429 on attempt 2" but can never carry a response
 * body, an error message, a URL, or an API key.
 */
export type LogEvent =
  | 'smoobu.request'
  | 'smoobu.retry'
  | 'smoobu.failed'
  | 'smoobu.shape_error'
  | 'ratelimit.denied'
  | 'cache.hit'
  | 'cache.miss'
  | 'http.error'
  | 'server.started';

export type LogFields = Readonly<Record<string, number | boolean>>;

export interface Logger {
  (event: LogEvent, fields?: LogFields): void;
}

export const consoleLogger: Logger = (event, fields = {}) => {
  console.error(JSON.stringify({ t: Date.now(), event, ...fields }));
};

export const silentLogger: Logger = () => undefined;
