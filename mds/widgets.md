# Widgets

Status: researched + probed, not implemented. Temporary origin probe in `src-tauri/src/lib.rs` (marked for deletion).

## Vision

Today the model can emit inline HTML/CSS, but no JS, and the output is ephemeral and token-expensive.

A widget is a small webapp stored as files on disk and rendered inline in chat via a tag:

```
<Calendar date="today" />
```

The app mounts the widget as a sandboxed iframe. The widget is interactive, persists its own state, and can reach real services (calendar, files, network). Examples: Google Calendar client, p5.js sketches, shopping list, ebook viewer.

Three provenance tiers:

1. **Store widgets** — vetted, signed, e.g. an official Google Calendar client.
2. **Community widgets** — shared, unvetted.
3. **Local widgets** — written from scratch by the model, or cloned from a store widget and modified ("add X to my calendar widget"). Tier 3 is the differentiator.

## Prior art

OpenAI Apps SDK and the MCP Apps spec use the same base design: widget in an iframe, JSON-RPC over postMessage (`ui/*` bridge: `tools/call`, `ui/message`, `ui/update-model-context`). Notable:

- `window.openai.callTool` from a widget does NOT round-trip through the model. The MCP-UI LLM-as-go-between pattern is an MCP-UI choice, not a constraint.
- `_meta` on tool results is widget-only, never shown to the model.
- `setWidgetState` persists state per (message_id, widgetId) AND sends it to the model every turn (<4k tokens guidance).
- Per-widget CSP (`_meta.ui.csp`: connectDomains / resourceDomains / frameDomains) and a dedicated origin per app (`_meta.ui.domain`).

Their widgets are server-hosted build artifacts requiring an MCP server; ChatGPT-only. Ours would be local files the model can read and rewrite. Using the MCP Apps `ui/*` wire protocol as our bridge format would let existing MCP Apps widgets run here.

## Probe results (Windows/WebView2, measured)

Probe: `register_uri_scheme_protocol("widget", ...)` serving a diagnostic page; iframes mounted from the app; results via postMessage.

| Question | Result |
|---|---|
| Storage inside widget | Works. `localStorage` write + read OK. Origin is real, not opaque: `http://widget.localhost` |
| Isolation from host app | Confirmed. `frames[0].document` from the app throws SecurityError |
| Subdomains (`alpha.widget.localhost`) | Do NOT route. "refused to connect" |
| URI seen by Rust handler | Rewritten: page origin is `http://widget.localhost`, handler receives `widget://localhost/...`. Host is always `localhost`, so widget id must go in the URL path |
| Direct fetch to third-party APIs | Works: api.github.com and www.googleapis.com both succeeded (they allow any Origin) |

Spec-level facts relevant to the design (not measured here):

- `sandbox="allow-scripts"` without `allow-same-origin` gives an opaque origin: no localStorage/IndexedDB/same-origin fetch. That configuration forces everything through postMessage.
- `allow-same-origin` + `allow-scripts` is dangerous ONLY when the framed page is same-origin with the parent (it can then strip its own sandbox attribute). When the widget is on a different origin than the app, the combination is safe and is what makes widgets self-sufficient webapps. This is why OpenAI gives each app a dedicated origin.

## Decided architecture

**Files.** `widgets/<id>/` containing `WIDGET.md` (frontmatter: name, description, props schema, declared permissions) + `index.html` and assets. Discovery mirrors `helpers/skills.ts`: project-scoped and home-scoped roots.

**Serving.** Custom protocol, id in path: `http://widget.localhost/<id>/index.html`. On macOS/Linux origins are `<scheme>://localhost`; design must not depend on the exact origin string.

**Mounting.** Message render path in `Message.tsx`: extract widget tags before Remarkable parses, replace with placeholder divs carrying an instance id, mount iframes via a `createEffect` (same hook that runs `postProcessContent`). Props encoded as query string: `.../index.html?date=today`. Partial tags during streaming must not mount — only complete self-closing tags on settled content.

**Sandbox attribute.** `allow-scripts allow-same-origin` (widget is cross-origin to the app, so this is safe; see probe facts). Never `allow-top-navigation`, no popups.

**Bridge.** postMessage API, deliberately small. Only for things the iframe cannot do itself:

1. Height reporting — a document cannot resize its own iframe.
2. Model-visible context — see below.
3. Native access — fs roots, shell (local tier only); routes through existing `helpers/backend/`.
4. Secrets/proxied auth — tokens never live in widget-readable code.
5. Runtime host state — theme changes, fullscreen requests.

Everything else (DOM, canvas, fetch to allowlisted domains, IndexedDB, workers) is plain web.

**Model context.** Live, not event-log. At `buildRequestMessages` time, each mounted widget contributes a current-state block (e.g. "Calendar (msg 12): viewing March, 3 selected"), recomputed per request. Injected near the tail, not at the widget's message position, so interactions 40 messages up don't invalidate the Anthropic cache prefix.

**Permissions.** Declarative, granted at install time, browser-extension style: `net: [calendar.google.com]`, `fs: [~/Documents/books]`, `storage`, `clipboard`. Details:

- Network: enforced by CSP `connect-src` on the widget document (response headers from the protocol handler). No host proxy needed for allowlisted domains.
- Filesystem: virtual roots. Widget requests `fs.read('books/x.epub')`, host resolves under the granted root, rejects `..`. Widget never sees real paths.
- Dangerous ops: widget-initiated `host.confirm(...)` rendered in trusted chrome outside the iframe. No per-call approval prompts otherwise.
- `shell` is not a store/community capability. Only the local tier can receive it, and only explicitly.

**Storage split** (different lifetimes, don't conflate):

1. **App data** (shopping list contents, ebook library). Default: widget's own IndexedDB — validated, zero cost. Optional host-backed file DB (SQLite at `widget-data/<id>/data.db`, via `host.db.query`) for data the model should be able to inspect when debugging. Uninstall = delete directory.
2. **View state** (which month, current page). Per instance, keyed `(messageId, instanceIdx)`, stored in `story.db` so forking and backups carry it.
3. **Secrets.** Host-held only. Host attaches auth to requests to declared domains; widget never sees tokens.


## Open problems

- **All widgets share one origin** (`http://widget.localhost`) on Windows. Widget A can read widget B's localStorage/IndexedDB. A widget registering a service worker at `/` intercepts all widget traffic. Mitigations for v1: namespace storage by widget id; keep secrets host-side so there's little worth stealing. If a real store ships: register one scheme per widget (`widget-calendar:`, distinct hosts, scanned at startup, install requires restart) or run a 127.0.0.1 server with a port per widget.
- **CORS for non-permissive APIs.** GitHub/googleapis allow any Origin; APIs that don't will fail from `http://widget.localhost`. For those, requests route through the host, which also solves secret injection. Needs a per-domain list: direct vs proxied.
- **Discovery cost.** Injecting every widget's props schema into the system prompt defeats the token savings. Progressive disclosure like skills: one-line catalog, model reads `WIDGET.md` via `read_file` when needed.
- **Authoring loop.** For the model to write/debug widgets, iframe console errors and exceptions must feed back into chat as tool-result-shaped output. Undefined mechanism.
- **Widget lifetime/scope.** Unresolved: do ad-hoc model-written widgets start chat-scoped and get promoted to global? Can widgets be pinned outside a message (persistent sidebar)? Pinned widgets have no `messageId`, breaking the view-state key scheme.
- **Backups.** `helpers/backup.ts` snapshots `story.db` only. `widget-data/` must be enumerated in.
- **Production recheck.** Probes ran in dev (app origin `http://localhost:3000`). In production the app is `http://tauri.localhost`; iframe loading and isolation need one confirmation pass there.
- **CSP delivery.** `app.security.csp` is `null` in tauri.conf.json; the app shell is unaffected, but per-widget CSP via protocol response headers is untested.
- **Uninstall.** Delete dir, revoke grants, drop instance state, unregister any service worker for the shared origin.

## Adjacent bug found (independent of widgets)

`standardTags` in `Message.tsx` (~line 37) includes `iframe`, and `helpers/sanitize.ts` strips only `on*` attributes and `javascript:` URLs. The model can currently emit `<iframe src="https://anything">` and it renders unsandboxed inside the privileged webview. Should be fixed regardless of whether widgets ship.
