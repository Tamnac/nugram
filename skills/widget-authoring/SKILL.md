---
name: widget-authoring
description: Writing nugram widgets (small HTML apps shown inline in chat) and verifying them in a headless browser with the bundled preview script. Use when asked to create or change a widget.
---

# Writing widgets

A widget is a small HTML app that nugram (desktop build) shows inline in chat. The model shows one by calling the `show_widget` tool or by writing a `<widget name="..." />` tag in a message. Widgets cannot read or write anything in nugram; the model only chooses which widget to show and what args to pass.

Example: [examples/recipe/widget.html](examples/recipe/widget.html). Copy the `recipe` folder into a widget root to use it.

## Layout

A widget is a folder containing one file, `widget.html`:

```
<root>/<name>/widget.html
```

Roots, in priority order (the first one wins when two widgets share a name):

1. `widgets/` in the chat folder
2. `.widgets/` in the chat folder
3. `~/.widgets` (home directory; on an SSH chat, the remote home)

- The folder name is the widget name. Lookups ignore case.
- Only one level is scanned: `<root>/<group>/<name>/widget.html` is not found. Folders starting with `.` are skipped.
- Other files in the folder are ignored, and `widget.html` cannot load them (see Assets).
- Start `widget.html` with `<!DOCTYPE html>`. Without it the page is rendered in quirks mode.
- A new widget is found the first time it's shown, and the file is read every time a widget is shown, so edits appear the next time you show it. Widgets already in the chat keep the version they loaded.

## The description

The model learns about widgets from the `@@widgets` macro, which must be in the system prompt or a message for the model to see the list. Each entry is the widget name plus the `content` of this tag:

```html
<meta name="description" content="Month calendar. Args: date (YYYY-MM-DD, default today), highlight (comma-separated dates).">
```

It's the only documentation the model gets, so list every arg with its type, format and default. Keep it to one or two sentences.

Write it as one quoted attribute, and watch the characters:

- Use `&quot;` for a double quote inside a double-quoted value, or use single quotes inside the text. `<` and `>` can be written as is.
- `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and numeric references (`&#39;`, `&#x2192;`) are decoded; other entities are left as typed.
- Newlines are collapsed to single spaces when the description is shown to the model.
- A widget without a description is still listed, with no documentation, and a warning is logged.

## Args

Args are available as `window.widgetArgs`, defined by a script inserted before your own code.

| Shown via | Example | Arg values |
|---|---|---|
| `show_widget` tool | `{ "name": "calendar", "args": { "date": "2026-06-10", "highlight": ["2026-06-12"] }, "height": 300 }` | Any JSON |
| Inline tag | `<widget name="calendar" date="2026-06-10" highlight="2026-06-12" height="300" />` | Strings only |

In the tag, every attribute except `name` and `height` becomes an arg:

- Values can use double or single quotes.
- Entities are decoded as in the description, so `&#10;` puts a newline in a value.
- `height` is a whole number of pixels: `height="300"` or `height="300px"`. Anything else falls back to 400 with a warning; the tool rejects it with an error.

The user can turn tools off, so widgets should work from the tag as well as the tool:

- Coerce types: `Number(args.servings)`, and accept a list either as an array or as a delimited string.
- Treat every arg as optional, and use defaults or demo content when one is missing or malformed. The model will sometimes get args wrong.
- Use `window.widgetArgs ?? {}`, so opening the file directly in a browser also works.
- Insert arg values with `textContent`, not `innerHTML`.

## Sandbox

The widget runs in an `<iframe sandbox="allow-scripts" srcdoc="...">`. Scripts run, and the iframe has an opaque (`null`) origin. As a result:

| Doesn't work | Do instead |
|---|---|
| `localStorage`, `sessionStorage`, cookies (they throw) | Keep state in variables. |
| `alert`, `confirm`, `prompt` (stubbed: they log a warning and return `undefined`, `false`, `null`) | Show messages in the page. |
| Form submission (`<form>` submit events don't fire) | Handle button clicks and input events. |
| `window.open`, `target="_blank"`, navigating the top window | Nothing. Links can't leave the iframe. |
| Access to the parent page, nugram or files | Nothing. The host sends the theme (see Theme) and nothing else, and the widget can't send anything back. |
| `fetch` to APIs without CORS headers | Only `Access-Control-Allow-Origin: *` endpoints work. |

Widgets keep no state. A widget reloads from scratch whenever its message re-renders: when the message is edited, a version is switched, or the message scrolls back into view.

## Assets

The HTML is loaded through `srcdoc`, so relative URLs (`./app.js`, `style.css`, `img.png`) don't resolve. Either:

- inline CSS, JS and small images (`data:` URLs, inline `<svg>`), or
- load from absolute URLs, e.g. `<script src="https://cdn.jsdelivr.net/npm/..."></script>`. This requires network access.

Prefer inlining, so the widget works offline and loads fast.

## Theme

The frame gets the nugrams theme CSS custom vars. A `:root` rule injected before your own CSS, the same values as the `window.widgetTheme` object, and a re-send when the user switches theme, so the widget follows without reloading. A switch also fires `widgettheme` on `window`, with the new vars as `event.detail`, so drawing code (canvas, SVG) can redraw from `window.widgetTheme`.

Using these is optional. It makes sense for lighter or "native" feelings UIs that you want to look almost part of nugram or at least less disruptive. Widgets going for a more custom appearance can ignore these.

Four more important ones:

| Var | |
|---|---|
| `--back` | chat background, also used by assistant (your messages) |
| `--back-light` | lighter surface. Used by user messages |
| `--text` | foreground: text, icons etc. |
| `--accent1` | the one accent |

The rest is there for widgets that show chat-like content or want the app's shape and type in detail:

| Var | |
|---|---|
| `--quote`, `--italic`, `--link`, `--link-hover` | inline text colours |
| `--border-subtle`, `--shadow` | borders and shadows |
| `--rad-sm`, `--rad`, `--rad-lg` | corner radii |
| `--font-ui`, `--font-message`, `--font-monospace` | font stacks |
| `--line-height-normal`, `--letter-spacing` | text spacing |

- The injected rule also sets `color-scheme: light dark`, and most colours are `light-dark(...)` pairs, so they follow the OS light/dark setting like the rest of the app. Widgets with a dark UI of their own can hardcode their colours and leave `color-scheme` alone: setting it to a value the host isn't using (`dark` while the OS is light) makes the browser paint an opaque backdrop behind the frame, which hides rounded corners and any transparent areas. Override it only if you need dark native scrollbars or form controls, and give the page a solid background then.
- Give every one a fallback: `var(--back, #fffaf3)`. The file should still look right opened directly in a browser, and a var can be missing (a theme that doesn't set it, a future version).
- Derive the muted tones from the four rather than reaching for more vars: `color-mix(in srgb, var(--text) 58%, transparent)` for secondary text, borders and dividers.
- Deriving your own names from the theme is the shortest way to fit in; name them something else (`--card`, `--line`) so it stays clear which are yours. [examples/recipe/widget.html](examples/recipe/widget.html) does this.

## Size and look

- The frame is 400px tall by default, and the user can resize it vertically. Pass `height` (tool arg or tag attribute, in pixels) to change the starting height. The host can't size the frame to fit the content, so make the content scroll (`html, body { height: 100% }` with `overflow: auto`) or fit in a known height.
- Width is the message width, so design for roughly 320–900px.
- Take colours, radii and fonts from the theme (see above) with fallbacks, rather than hardcoding a palette.

## Verifying

You can't see the chat, so check the widget with [preview.mjs](preview.mjs) from this skill's folder before showing it. It needs Node, Bun or Deno, and a Chromium-based browser (Edge, Chrome, Chromium or Brave; Edge comes with Windows).

```sh
node <skill folder>/preview.mjs <widget folder> --run \
  --args '{"title": "Tea", "servings": 2}' \
  --tag '<widget name="recipe" title="Tea" steps="Boil; Steep" />'
```

It mounts the widget the way nugram does, one frame per `--args` (tool form) or `--tag` (inline form), plus a frame with no args when you give neither, and prints:

- the line the model sees in `@@widgets`, so you can read the description as the model will
- static checks: missing description or doctype, relative URLs, storage, dialogs, forms, popups, bad tag names or heights
- per frame: problems at runtime (uncaught errors, unhandled rejections, failed loads, `console.warn`/`error`), content size against the frame, and the visible text

What to cover:

- one frame with no args, one with tool-style JSON args and one with a tag, since tag args are always strings
- `--screenshot shot.png`, then view the PNG (e.g. with `read_file`) to check the layout; repeat with `--dark`
- the frames carry nugram's default (modern) theme, so they look like the chat; `--theme '<json>'` overrides individual vars, e.g. `--theme '{"--rad": "0px", "--font-ui": "monospace"}'` to see it with square corners and a mono font
- fix what's reported until the exit code is 0 (1 = problems found, 2 = usage or browser error)

Other options: `--height`, `--width` (default 720), `--out`, `--browser <path>` (or `CHROME_PATH`), `--no-report` to mount without the reporting script. See `--help`.

The report and screenshot show the state after loading. To test clicks and typing, use the chrome-devtools CLI (`npm i -g chrome-devtools-mcp`) on the preview page the script printed:

```sh
chrome-devtools new_page "file:///.../widget-preview-recipe.html"
chrome-devtools take_snapshot          # accessibility tree, including inside the widget frames, with uids
chrome-devtools click <uid>
chrome-devtools take_snapshot          # check the state changed; the report at the bottom of the page updates too
chrome-devtools emulate --colorScheme dark
chrome-devtools take_screenshot --filePath shot.png
chrome-devtools list_console_messages
```

If it can't find Chrome, start it with another browser first: `chrome-devtools start --executablePath <path to msedge/chromium>`. `evaluate_script` can't reach into the widget frames because they're sandboxed; use snapshots and clicks.

Limits:

- On Windows, nugram renders with WebView2, the same engine as Edge, so the preview is close. On macOS and Linux nugram uses WebKit, so small differences are possible.
- Only the user can judge how it looks and feels. After it passes, show it with `show_widget` and ask the user to try it.

In nugram itself, problems are logged with `console.warn` in the devtools console: a missing description, an unreadable `widget.html`, an unknown widget name, a bad `height`, and calls to `alert`/`confirm`/`prompt`. To show the tag syntax in a message without mounting a widget, put it in a fenced code block. Widgets don't render while a message is streaming.

## Template

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="description" content="What it shows. Args: foo (number, default 1), bar (text).">
<style>
	:root {
		color-scheme: light dark;
		--bg: var(--back, light-dark(#fff, #1e1e1e));
		--fg: var(--text, light-dark(#222, #ddd));
		--line: var(--border-subtle, light-dark(#ddd, #333));
		--radius: var(--rad, 8px);
	}
	html, body { height: 100%; margin: 0; }
	body {
		background: var(--bg); color: var(--fg); overflow: auto;
		font: 14px/var(--line-height-normal, 1.4) var(--font-ui, system-ui, sans-serif);
	}
</style>
</head>
<body>
<div id="app"></div>
<script>
	const args = window.widgetArgs ?? {};
	const foo = Number(args.foo) || 1;
	const bar = typeof args.bar === 'string' ? args.bar : '';
	document.getElementById('app').textContent = `${bar} × ${foo}`;
</script>
</body>
</html>
```

## Checklist

- [ ] `<root>/<name>/widget.html`, one file, no relative URLs
- [ ] `<meta name="description">` names every arg, with type, format and default
- [ ] Works with no args, string args (tag) and JSON args (tool)
- [ ] Doesn't use storage, alerts, form submission or popups
- [ ] `preview.mjs --run` exits 0; screenshots look right in light and dark
- [ ] Scrolls or fits within the frame height
