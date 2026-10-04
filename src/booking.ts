export const BOOKING_PLACEHOLDERS = ['{property}', '{arrival}', '{departure}', '{guests}'] as const;

export interface BookingLinkInput {
  readonly property: string;
  readonly arrival: string;
  readonly departure: string;
  readonly guests: number;
}

/** Throws a plain Error (operator configuration problem, surfaced at startup). */
export function validateBookingUrlTemplate(template: string): void {
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    throw new Error('BOOKING_URL_TEMPLATE must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('BOOKING_URL_TEMPLATE must use http or https');
  }
  if (!template.includes('{arrival}') || !template.includes('{departure}')) {
    throw new Error('BOOKING_URL_TEMPLATE must contain the {arrival} and {departure} placeholders');
  }
}

export function buildBookingUrl(template: string, input: BookingLinkInput): string {
  return template
    .replaceAll('{property}', encodeURIComponent(input.property))
    .replaceAll('{arrival}', encodeURIComponent(input.arrival))
    .replaceAll('{departure}', encodeURIComponent(input.departure))
    .replaceAll('{guests}', encodeURIComponent(String(input.guests)));
}
