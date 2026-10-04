import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toPublicProperty } from '../catalog.js';
import { listPropertiesOutput } from '../schemas.js';
import type { ListPropertiesOutput } from '../schemas.js';
import type { ToolDeps } from './shared.js';
import { READ_ONLY_ANNOTATIONS, guarded, ok } from './shared.js';

export const LIST_PROPERTIES_DESCRIPTION = `List the vacation rental properties in Puerto Viejo de Talamanca, Costa Rica that can be checked and booked through this server.

Returns, for each property: its \`slug\` (use this as the \`property\` argument in the other tools), public name, number of bedrooms and the maximum number of guests.

No input is required. Call this first when you do not know a property's slug.

Example: list_properties() -> { "count": 2, "properties": [{ "slug": "casa-caribe", "name": "...", "bedrooms": 3, "maxGuests": 6 }, ...] }`;

export function runListProperties(deps: ToolDeps): ListPropertiesOutput {
  const properties = deps.catalog.map(toPublicProperty);
  return {
    count: properties.length,
    properties,
    note: 'Use the slug as the `property` argument of check_availability, get_calendar and get_booking_link.',
  };
}

export function registerListProperties(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_properties',
    {
      title: 'List properties',
      description: LIST_PROPERTIES_DESCRIPTION,
      inputSchema: {},
      outputSchema: listPropertiesOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (): Promise<CallToolResult> => guarded(deps, () => Promise.resolve(ok(listPropertiesOutput, runListProperties(deps)))),
  );
}
