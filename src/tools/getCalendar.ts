import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PRICE_NOTE, getCalendarOutput } from '../schemas.js';
import type { CalendarDay, GetCalendarOutput } from '../schemas.js';
import { MAX_CALENDAR_DAYS, MAX_MONTHS_AHEAD, eachDay, validateCalendarRange } from '../validation.js';
import type { ToolDeps } from './shared.js';
import { READ_ONLY_ANNOTATIONS, guarded, ok, requireProperty, roundMoney, today } from './shared.js';

export const GET_CALENDAR_DESCRIPTION = `Get the day-by-day calendar of one property: for every date in the range, whether the night is available, the nightly price and the minimum stay that applies when arriving that day.

Use this to find open windows or to compare nightly prices. Confirm an actual stay with check_availability, which applies minimum-stay and check-in rules and returns the total for the dates.

Arguments:
- property: slug from list_properties (required).
- from: first date, YYYY-MM-DD, today (Costa Rica time) or later.
- to: last date, YYYY-MM-DD, inclusive. At most ${MAX_CALENDAR_DAYS} days after \`from\` and at most ${MAX_MONTHS_AHEAD} months ahead. Split longer periods into several calls.

A day is reported only as available true/false; no further detail is given for unavailable days. Nightly prices exclude taxes and fees and may be null when no rate is published.

Example: get_calendar({ "property": "casa-caribe", "from": "2027-03-01", "to": "2027-03-31" })`;

export const getCalendarInput = {
  property: z.string().max(80).describe('Property slug from list_properties'),
  from: z.string().describe('First date of the range, YYYY-MM-DD'),
  to: z.string().describe(`Last date of the range (inclusive), YYYY-MM-DD; at most ${MAX_CALENDAR_DAYS} days after from`),
};

export interface GetCalendarArgs {
  readonly property: string;
  readonly from: string;
  readonly to: string;
}

export async function runGetCalendar(deps: ToolDeps, args: GetCalendarArgs): Promise<GetCalendarOutput> {
  const property = requireProperty(deps, args.property);
  const range = validateCalendarRange({ from: args.from, to: args.to, today: today(deps) });
  const id = property.smoobuApartmentId;

  const { value: rates } = await deps.loader.load(`rates:${id}:${range.from}:${range.to}`, deps.cacheTtlRatesMs, () =>
    deps.smoobu.getRates([id], range.from, range.to),
  );
  const byDate = rates.get(id);

  const days: CalendarDay[] = [];
  for (const date of eachDay(range.from, range.to)) {
    const day = byDate?.get(date);
    days.push({
      date,
      available: day?.available ?? false,
      price: day?.price === null || day?.price === undefined ? null : roundMoney(day.price),
      minStay: day?.minLengthOfStay !== null && day?.minLengthOfStay !== undefined && day.minLengthOfStay > 0 ? Math.round(day.minLengthOfStay) : null,
    });
  }

  return {
    slug: property.slug,
    name: property.name,
    from: range.from,
    to: range.to,
    currency: property.currency,
    days,
    note: `${PRICE_NOTE} Nightly prices; minStay is the minimum number of nights when arriving on that date.`,
  };
}

export function registerGetCalendar(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_calendar',
    {
      title: 'Get availability calendar',
      description: GET_CALENDAR_DESCRIPTION,
      inputSchema: getCalendarInput,
      outputSchema: getCalendarOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args): Promise<CallToolResult> => guarded(deps, async () => ok(getCalendarOutput, await runGetCalendar(deps, args))),
  );
}
