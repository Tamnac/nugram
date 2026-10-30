# Sidebar toggle accessibility investigation

Investigation dates: September 13–14, 2026. Session ID: `1263bd55-a01d-4028-9623-af23d2a61e47`.

## Summary

In a chat with approximately 5,268 message bubbles, toggling the sidebar could freeze the renderer for several seconds. Chrome tracing and Windows sampled CPU stacks identify **Blink accessibility updates and serialization as the dominant cost**, rather than application JavaScript or compositor work. A trace labeled the interval as a long `Commit`, but most of that interval was `LocalFrameView::RunAccessibilitySteps`.

There are two distinguishable problems:

- Sidebar structural or visibility changes can trigger expensive serialization involving existing chat accessibility objects, even without replacing their IDs. A persistent named sidebar landmark substantially reduced this cost in a controlled, fixed-chat-geometry experiment.
- Chat resizing, and separately matching the collapsed grid-column rule, can replace approximately 140,000 inline accessibility text boxes. Actual resizing remained expensive with grid, flex, and explicit width/margin layouts.

Neither a landmark alone nor replacing grid was a validated fix for normal sidebar toggling. Reducing the mounted message/text population through windowed rendering is the strongest practical direction supported by these results, but was not implemented or benchmarked here.

An earlier approximately 35 ms `ChatGroup` mount cost is a separate, smaller optimization opportunity. Stable sidebar width is also separate follow-up work; the user plans to handle it in another session.

No application changes from the experiments were retained.

## Environment and method

- Windows Tauri development app at `http://localhost:3000/`, inspected through CDP port 9222.
- WebView2 152.0.4191.66, underlying Chromium 152.0.7977.83.
- Large chat: approximately 5,268 message bubbles and 56,000 layout objects.
- Original trace: approximately 3.18 seconds in `Commit`, including approximately 3.08 seconds of active renderer CPU.
- A nine-message chat took roughly 10 ms in the initial comparison.
- “Skip offscreen” / `content-visibility` was already disabled in the initial slow case. Removing bubble `contain: content` did not solve it.

Measurements combined Chrome lifecycle traces, accessibility snapshots and ID comparisons, runtime DOM/CSS experiments, and a Windows Performance Recorder CPU capture inspected in WPA. Detailed accessibility tracing adds overhead, but lighter traces without that category still reproduced multi-second stalls.

Timings below are observations, not a controlled statistical benchmark. Machine speed varied substantially, including after laptop sleep. Do not add timings from separate captures or nested native stack branches.

## Relevant application code

- [Sidebar](../src/sidebar.tsx#L163): outer `<Show when={props.sidebarOpen}>` mounts/unmounts the sidebar contents; `ChatGroup` begins around line 1181.
- [App](../src/App.tsx): sidebar state, `.top.sidebar-collapsed`, and the sibling chat container.
- [TopBar](../src/TopBar.tsx): sidebar toggle button and title.
- [Main layout CSS](../src/css/index.css#L527): `.top` uses `grid-template-columns: auto 1fr`; the collapsed rule changes this to `0 1fr`.
- [Sidebar CSS](../src/css/sidebar.css#L521): `width: min-content`, `min-width: 350px`, and narrow-screen overlay behavior.
- [MessagePlaceholder](../src/Message.tsx#L1072): returns full message text, including potentially very long text nodes.
- [Message CSS](../src/css/messages.css): containment, offscreen rendering, and placeholder styles.

## Chrome trace findings

Detailed captures placed essentially the whole long Commit in accessibility lifecycle work. Representative stage durations were:

| Stage | Observed duration |
| --- | ---: |
| Processing deferred accessibility work | 293–382 ms |
| Accessibility serialization | 2.2–3.5 s |
| Sending accessibility events, nested within serialization | 460–864 ms |

The stall persisted after laptop sleep, with open operations around 3.6–4.2 seconds in some captures and higher later. Adding `role="main"` to the chat container did not help.

Fixing chat position and dimensions reduced layout from roughly 130–235 ms to 3–7 ms, but accessibility still took seconds. This separated layout work from the remaining accessibility cost.

### Structural changes and a persistent sidebar landmark

Early fixed-position diagnostic button experiments found a large difference by insertion location:

| Mutation | Accessibility duration |
| --- | ---: |
| Add under `.top` | 2.59–3.45 s |
| Add inside `.sidebar` | 0.4–0.5 ms |
| Remove either diagnostic button | Under approximately 0.4 ms |

Later ID checks of these insertions retained the existing inline-text-box IDs. Expensive serialization therefore does not require wholesale inline-object recreation. Switching Current Chat/Chats tabs was around 5–46 ms. Changing the toggle button title was about 0.2–0.3 ms; inserting a button inside the top bar was about 0.6 ms.

Hiding the sidebar without unmounting it was still expensive: visibility-only changes took roughly 2.9–3.7 seconds, and display-only changes 3.3–4.0 seconds. Mounting was not the only trigger.

A persistent named `<aside aria-label="Sidebar">` gave the following results:

- With normal chat resizing, a source-level wrapper alone still took 3–4 seconds. It was reverted.
- In a runtime visibility-only test, the ungrouped sidebar took 2.6–3.7 seconds; the grouped case took 2.6–11.4 ms; restoring the ungrouped case restored seconds-long work.
- With actual sidebar mount/unmount, fixed chat geometry, and the collapsed grid rule removed, the unwrapped case took 4,036 / 4,231 ms and the wrapped case 60.1 / 71.9 ms.

These results support a persistent included accessibility ancestor as a way to limit the scope of structural updates. They do not establish that a landmark fixes resizing, nor identify exactly which nodes were serialized. Runtime DOM experiments also have the contamination caveat described below.

### Accessibility tree size and diagnostic hiding

A normal accessibility snapshot contained:

| Category | Approximate count |
| --- | ---: |
| Total AX nodes | 183,170 |
| Nonignored nodes | 169,912 |
| InlineTextBox | 140,235 |
| Ignored nodes | 13,258 |
| StaticText | 9,646 |
| Buttons | 6,262 |
| Images | 6,080 |

Later snapshots had approximately 140,139 inline text boxes; live state was not identical throughout the session.

With focus on BODY, setting `aria-hidden="true"` on the message list reduced the snapshot to 25,634 total nodes and 261 exposed nodes, with approximately 25,229 ignored for `ariaHiddenSubtree`. Toggling still took approximately 4.6 seconds.

Setting `inert` reduced the snapshot to 7,094 total nodes and 261 exposed nodes, including approximately 6,689 ignored for `inertElement`. Toggle accessibility durations fell to 580.5 / 236.0 ms; restoring normal state restored seconds-long work.

These were diagnostic probes, not proposed fixes. Both remove chat content from assistive technology, and `inert` also disables interaction. Snapshot counts are not counts of nodes serialized during a toggle.

### Inline accessibility object recreation

Snapshot comparisons used accessibility IDs and `backendDOMNodeId` for DOM-backed objects:

- Normal sidebar resizing preserved 42,419 shared DOM-backed AX objects with no changed AX IDs, while none of the inline-text-box IDs survived between before/closed/reopened snapshots.
- Fixing chat position, width, height, scroll position, and scroll height still produced complete inline ID replacement, with stable DOM-backed IDs.
- Three idle snapshots four seconds apart retained all inline IDs. Snapshotting alone did not explain the replacements.
- With fixed geometry, changing only `.sidebar-collapsed` replaced all inline IDs. Changing an unrelated class retained them.
- Visibility-only sidebar hiding retained chat IDs.
- Computed-style comparisons of `.top`, `.chatContainer`, `.messageList`, `.messagePlaceholder`, and `.top::before` found no differences under the fixed-geometry override.
- Removing the collapsed CSS rule made the class-only toggle retain IDs.
- Isolating `grid-template-columns: 0px 1fr`, even overridden by important fixed sizing, reproduced replacement. Isolating the nested `justify-self: center` declaration did not.

The exact Blink invalidation path from the overridden grid declaration was not established. Identical measured geometry and sampled computed styles do not prove that internal layout state was unchanged.

Conversely, actual mount/unmount with the grid rule removed still took about four seconds while retaining inline IDs. This is important evidence that broad serialization and inline-object recreation are distinct costs.

## Native sampled CPU findings

WPR used the built-in CPU profile, requiring elevation:

```sh
wpr -start CPU -filemode
wpr -stop D:/js/openrouter/sidebar-cpu.etl
```

The recording began before the reproduction. Four sidebar toggles occurred approximately 2026-09-14 10:00:30–10:01:02 UTC. WPA resolved renderer PID 21936, thread 9956, to native `msedge.dll` symbols. The older PID 13924 seen in earlier Chrome traces was not assumed to be the same process.

In one selected interval, sampled CPU weights were:

| Native branch | Weight |
| --- | ---: |
| `RunAccessibilitySteps` | 3,440.2 ms |
| ↳ `GetUpdatesAndEventsForSerialization` | 2,308.2 ms |
| ↳ ↳ `SerializeChanges` | 2,294.2 ms |
| ↳ `SendAccessibilitySerialization` | 642.0 ms |
| ↳ `CommitAXUpdates` | 490.1 ms |

These are nested sampled CPU weights, not independent wall-clock phases.

Within recursive serialization, one `AXObject::Serialize` branch accounted for 1,134.7 ms, including 1,026.3 ms in `SerializeInlineTextBox`:

| Inline text serialization operation | Weight |
| --- | ---: |
| `GetWordBoundaries` | 330.6 ms |
| `TextCharacterOffsets` | 290.5 ms |
| `AddIntListAttributeFromOffsetVector` | 128.7 ms |
| Bounding boxes | 61.9 ms |
| `GetName` | 61.9 ms |
| String attributes | 52.4 ms |
| Line attributes | 36.4 ms |

`GetWordBoundariesForText` accounted for 201.9 ms beneath word-boundary work, including ICU iteration.

Another serialization branch accounted for 655.9 ms, including this nested chain:

```text
SerializeOtherScreenReaderAttributes  550.3 ms
  SerializeLineAttributes             534.7 ms
    ComputeNodesOnLine                529.7 ms
      MoveToNextInlineLeafOnLine      523.9 ms
        MoveToLastForSameLayoutObject 519.9 ms (518.9 ms self)
```

Within `CommitAXUpdates`, `ProcessCleanLayoutCallbacks` accounted for 466.0 ms and `FireTreeUpdatedEventForAXID` for 359.3 ms, with recursive child updates and creation around 350 ms.

This establishes significant text serialization, line-navigation, sending, and object-update work. It does not prove an infinite recursion, a whole-tree reset, or quadratic complexity. The highlighted inline, line-navigation, sending, and update branches do not account for every sample; roughly 750 ms remains elsewhere in the selected accessibility interval.

### Separate mouse-release layout cost

A separate 401.7 ms sampled CPU branch ran through:

```text
MainThreadEventQueue … HandleMouseReleaseEvent
  UpdateLifecyclePhases
    UpdateStyleAndLayout
      Grid intrinsic track sizing
        Descendant block/text layout
```

This was synchronous Blink lifecycle work during mouse release, not 402 ms of application `mouseup` JavaScript. It is a separate layout cost, not the explanation for the larger accessibility serialization interval. Later flex experiments also had expensive layout.

## Grid versus flex versus explicit sizing

A final comparison kept the same persistent sidebar landmark, changed sidebar display without remounting it, and matched the visible chat geometry between layout variants:

- Viewport: 1026 × 916.
- Open: chat x=363, width=663.
- Closed: chat x=5, width=1021.
- Phase separation used two `requestAnimationFrame` callbacks followed by a delay, after an earlier run allowed work to cross phase markers.

| Layout method | Close AX | Open AX | Close layout | Open layout |
| --- | ---: | ---: | ---: | ---: |
| Grid | 8,366.7 ms | 9,665.5 ms | 324.5 ms | 478.1 ms |
| Flex, sidebar `flex-basis` | 6,107.9 ms | 7,775.4 ms | 873.3 ms | 787.1 ms |
| Explicit width and margin | 6,364.8 ms | 8,111.2 ms | 585.3 ms | 643.1 ms |

This was one sequential close/open pair per variant, on a machine running substantially slower than earlier. It does not justify reliable percentage improvements or ranking the methods. All variants remained multi-second: replacing grid alone did not solve actual chat-resize costs.

An initial comparison was aborted after discovering a duplicate live sidebar. A normal close removed one instance; the remaining orphan was removed and reopening produced one sidebar before the final comparison. The likely cause was runtime DOM movement combined with Solid hot reload, but its exact origin was not established. Earlier runtime mutation findings should therefore be treated as supporting evidence with imperfect isolation, not uniformly pristine measurements.

## Long text nodes and an unsuccessful experiment

The longest text nodes were full-message placeholders, including approximately 181,024, 158,024, and 153,676 characters. Some StaticText AX objects had 4,000–5,000 child text boxes.

A runtime experiment split long placeholder text nodes into approximately 1,000-character inline spans. It substantially changed layout and timed out, so it provides no valid performance conclusion. All 58 original text nodes and the original scroll height were restored; no persisted messages changed.

Native stacks make long text and fragment navigation relevant investigation targets, but no text-splitting optimization was validated.

## Chromium source cross-check

Source matching Chromium 152.0.7977.83 supports the observed native stacks:

- [`inline_cursor.cc`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.83/third_party/blink/renderer/core/layout/inline/inline_cursor.cc): `MoveToLastForSameLayoutObject` repeatedly calls `MoveToNextForSameLayoutObject` before restoring the last position. `MoveToNextInlineLeafOnLine` calls it.
- [`ax_object_cache_impl.cc`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.83/third_party/blink/renderer/modules/accessibility/ax_object_cache_impl.cc): `ComputeNodesOnLine` caches per-block results and navigates inline leaves; `ClearBlockFlowCachedData` removes inline AX children; `InlineTextBoxesUpdated` participates in clearing/rebuilding them.
- [`layout_text.cc`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.83/third_party/blink/renderer/core/layout/layout_text.cc): text layout/cache invalidation is relevant to inline accessibility updates.
- [`ax_tree_serializer.h`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.83/ui/accessibility/ax_tree_serializer.h): serializer client-tree and common-ancestor handling supports investigating persistent included ancestors as update boundaries.

These explain plausible mechanisms, not a fully proven call chain for the overridden grid rule. No exact matching known Chromium issue was identified. General background: [Chromium accessibility performance](https://developer.chrome.com/blog/chromium-accessibility-performance) and [LayoutNG](https://developer.chrome.com/docs/chromium/layoutng).

The investigation did not establish which accessibility client enabled this work. DevTools stayed open at the user's request; there was no robust DevTools-closed, clean-profile isolation. An adjacent [UIA activation issue](https://issuetracker.google.com/issues/369865053) is not evidence of the cause in this session.

## Follow-up work

### Stable sidebar width — separate session

The desktop layout combines an `auto` grid track with sidebar `width: min-content` and `min-width: 350px`. Expanding sections can change intrinsic width and therefore resize the chat.

A stable explicit width, optionally user-resizable and persisted, would prevent section contents from deciding chat width. Descendants need appropriate `min-width: 0`, fitting form controls, wrapping labels/paths, and selective local overflow. Preserve narrow-screen overlay behavior. This reduces avoidable resizing; it does not by itself eliminate resizing when the sidebar opens or closes.

The user will handle this separately. No width implementation is included here.

### Approximately 35 ms `ChatGroup` remount cost

An earlier profile attributed approximately 35 ms to `ChatGroup` work when reopening the sidebar. The outer `<Show>` in [sidebar.tsx](../src/sidebar.tsx#L163) destroys its contents on close and recreates them on open, so chat-list/group construction is paid again when that content is displayed.

This is a distinct application rendering cost, not the seconds-long native accessibility work. The 35 ms figure was not reverified in the later native captures and should not be added to their timings.

Keeping selected sidebar content mounted could avoid repeated creation, but needs its own benchmark and a deliberate retained-DOM/reactivity tradeoff. The display/visibility experiments show that keeping DOM mounted alone is not a validated accessibility-stall fix. A persistent semantic wrapper and retaining the full sidebar contents are different changes and should be tested separately.

### Reduce mounted message text

Prioritize a windowed message-rendering design that removes distant message text from the live DOM, rather than only simplifying message markup or skipping paint. Full-text placeholders still produce substantial layout and AX populations.

A design must preserve scrolling/anchor stability, variable message heights, selection and copying behavior, keyboard navigation, search navigation, and usable assistive-technology access to older messages. Database windowed loading already has an entry point in `loadChatMessagesWindowed` in [db.ts](../src/helpers/db.ts); that is not itself a completed rendering solution.

A persistent named sidebar boundary remains worth testing independently with fixed geometry. It is not a replacement for addressing resize-driven text work.

## Artifacts and limitations

Artifacts are local diagnostic files, not required repository assets. AX snapshots and native captures may contain private chat content or process data; do not publish them without review. The native ETL is approximately 944 MB and has a companion `sidebar-cpu.etl.NGENPDB/` directory.

Key captures in the repository root:

| Artifact | Purpose |
| --- | --- |
| `Trace-20260913T113637.json.gz`, `Trace-20260913T114136.json.gz` | Initial traces |
| `Trace-commit-detailed.json.gz`, `Trace-commit-chatlist-detailed.json.gz` | Accessibility lifecycle detail |
| `Trace-commit-geometry.json.gz`, `Trace-commit-geometry-light.json.gz` | Fixed geometry and lighter tracing |
| `Trace-commit-mutations.json.gz`, `Trace-commit-mutations-repeat.json.gz` | Insertion/removal probes |
| `Trace-commit-sidebar-aside.json.gz` | Wrapper with normal resizing |
| `Trace-commit-css-only.json.gz`, `Trace-visibility-grouped.json.gz` | Hiding versus grouped hiding |
| `Trace-fixed-no-rule.json.gz`, `Trace-fixed-no-rule-aside.json.gz` | Fixed geometry, removed grid rule, mount/unmount |
| `Trace-commit-chat-hidden-verified.json.gz`, `Trace-commit-chat-inert.json.gz` | Diagnostic AX exclusion |
| `Trace-layout-methods-barrier.json.gz` | Final layout-method comparison |
| `sidebar-cpu.etl` | Native sampled CPU recording |

Snapshot families include `AX-tree-*`, `AX-toggle-*`, `AX-fixed-toggle-*`, `AX-probe-*`, `AX-fixed-no-rule-*`, and `AX-fixed-no-rule-aside-*`, all compressed JSON. Earlier layout-method runs and the timed-out placeholder-chunk experiment are not valid final comparisons.

At experiment cleanup, there was one sidebar, no experimental wrapper/style, and no retained application source diff. Unrelated user files were left untouched. Documentation is the only intended persistent result of this session.
