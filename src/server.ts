import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCheckAvailability } from './tools/checkAvailability.js';
import { registerGetBookingLink } from './tools/getBookingLink.js';
import { registerGetCalendar } from './tools/getCalendar.js';
import { registerListProperties } from './tools/listProperties.js';
import type { ToolDeps } from './tools/shared.js';

export const SERVER_NAME = 'smoobu-availability-mcp';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = `Public, read-only availability and pricing for vacation rentals in Puerto Viejo de Talamanca, Costa Rica.
Workflow: list_properties -> check_availability (dates, guests) -> get_booking_link. Use get_calendar to browse nightly prices and open dates.
All dates are YYYY-MM-DD in Costa Rica time. Prices exclude taxes. Nothing here creates, changes or cancels a booking.`;

export const TOOL_NAMES = ['list_properties', 'check_availability', 'get_calendar', 'get_booking_link'] as const;

/** Builds a fresh McpServer with the four public tools registered. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerListProperties(server, deps);
  registerCheckAvailability(server, deps);
  registerGetCalendar(server, deps);
  registerGetBookingLink(server, deps);
  return server;
}
