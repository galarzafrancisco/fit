# Design guidelines

Fit has no web UI yet; its "interface" is what MCP tools and REST return to an
AI client and, through it, to a person. These rules keep that output
consistent now and define the design system for a future UI.

## Output design (MCP and REST)

- **One vocabulary.** Use the names in `@fit/activity-model` (`sport`,
  `sportGroup`, `provider`, `startTime`, `distanceMeters`, …) everywhere: tool
  arguments, results, REST, docs. Do not introduce synonyms (`type`, `kind`,
  `source`) for the same thing.
- **Units in names.** Every quantity's unit is in its field name
  (`distanceMeters`, `movingTimeSeconds`, `averageSpeedKmh`). Stored values are
  SI; convenience fields (`distanceKm`, `movingTimeHours`,
  `averagePaceSecondsPerKm`) are rounded and derived, never stored.
- **Time.** Instants are ISO 8601 UTC (`startTime`); wall-clock local time is
  separate (`startTimeLocal`) with `timezone`/`utcOffsetSeconds` when known.
- **Unknown is null.** A metric the provider did not report is `null`, never 0.
- **Compact lists, rich detail.** List items carry what a person scans for;
  detail adds everything else. Large payloads (`raw`, `history`) are opt-in.
- **Pagination.** Opaque `cursor`/`nextCursor`; never offsets that drift when
  new activities arrive.
- **Errors explain the next step** ("connect again with connect_provider"),
  never internals or tokens.
- **Tool descriptions are short**, say what the tool returns, and mention the
  follow-up tool when there is one.
- **No health claims.** Report numbers; do not diagnose, prescribe or judge
  ("you are overtraining").

## Future UI design system

When a web app is added it follows money's UI architecture (`docs/ui/` in
money): React + Vite, a BFF sign-in with HttpOnly cookies, a generated API
client, and a small token-based component library. Fit-specific rules:

- **Tokens first.** Colors, spacing, radii and type scale are CSS custom
  properties in one `tokens.css`; components never hard-code values.
- **Sport colors** come from one mapping keyed by `SportGroup` (8 groups), with
  accessible contrast in light and dark themes and a non-color cue (icon or
  label) wherever color carries meaning.
- **Units are shown with the value** (`10.2 km`, `5:12 /km`, `1 h 04 min`),
  formatted by one shared formatter that respects the user's locale.
- **Provenance is visible.** Every activity shows its provider and links to it
  (`providerUrl`); imported data is read-only in the UI.
- **Connection states** (`not_connected`, `active`, `needs_reauth`, `revoked`,
  `disconnected`) each have one defined label, color and call to action.
- **Charts** use the same sport colors, label axes with units, and start bar
  axes at zero.
