# Quickstart for SillyTavern users

Nugram is a chat client built around control over exactly what the model sees. For roleplay and storywriting it covers the main features of SillyTavern (presets, swipes, editing anything, macros, lore), but it has limited character cards, no group chats or extensions.

## Getting started

1. **Get the app.** Install the desktop app, or try the web version (see [Getting it](#getting-it)).
2. **Add a provider.** Sidebar → **Providers**: enter an API key or the URL of an OpenAI-compatible server such as openrouter. Pick the model in the top bar.
3. **Bring in a character.** Nugram has no character cards, so a character becomes a set of prompts. To use your name in the greeting, first set a `char` macro in sidebar → **Macros**. Then use the upload button in the top bar and pick a SillyTavern card (`.png` or `.json`). That creates a config for the character, opens a chat with its greeting (alternate greetings become versions), sets the `char` and `user` macros, and adds the card's lorebook entries, if it has any. Details under [Bringing your things over](#bringing-your-things-over). Alternatively just write it out in your first message.
4. **Add a minimal roleplay prompt.** The character prompts only describe the character; the model also needs rules for how to roleplay. [Evening-Truth's prompts](https://rentry.org/Evening-Truth-Roleplay-Prompts) are a good small starting point. Open the page for your model, then in the config's Prompts section:
   - Press **Add**, name it "Main prompt", role **System**, position **0**, and paste the *Pre-History / Main Prompt* text.
   - Press **Add** again, name it "Post-history", role **System**, position between **-1** and **-5**, and paste the *Post History* text. A negative position counts from the end of the chat: `-1` is after the last message, `-3` (recommended) is before the last two.
   - These prompts are written for SillyTavern, so in what you paste, replace `{{user}}` with `@@user` and `{{char}}` with `@@char`. Pasted text is not converted.
   - Prompts with the same position are sent in list order, and new prompts are added at the end of the list.
5. **Chat.** Send a message. Use the arrows on a message to switch between versions, the refresh button to regenerate, and the pencil to edit anything. The [concept map](#concept-map) covers the rest.

Optionally set Temperature and the other samplers under Samplers in the sidebar. Evening-Truth's pages list recommended values per model.

## Getting it

- **Desktop** (Windows is the tested platform): installers are on the [releases page](https://github.com/Tamnac/nugram/releases). The desktop app has the chat list with folders and full-text search, SQLite storage with automatic backups, and the shell/file tools.
- **Web**: [tamnac.github.io/nugram](https://tamnac.github.io/nugram/) is for trying it out. Chats are kept in the browser, and several features are desktop-only, so it is not the full experience.

The app provides no inference. Open the sidebar → **Providers** and add an API key, or a URL for any OpenAI-compatible server (a local llama.cpp, KoboldCpp or Ollama endpoint works as a custom provider). Then pick the model in the top bar.

## Concept map

| SillyTavern | Nugram |
|---|---|
| Chat completion preset | **Config** (sidebar → Prompts). A list of prompts with a role, an enabled toggle and a position |
| Prompt Manager order / injection depth | A prompt's **position**: `0` is the start of the chat, `-1` is after the last message, `-2` before the last, and so on. Author's Note style injections are a prompt at `-2` or similar |
| `{{char}}`, `{{user}}`, `{{time}}` | `@@char`, `@@user`, `@@time`. Define your own in sidebar → **Macros**. `@@char` and `@@user` are ordinary macros you set, not special names |
| Character card | No equivalent. A character is one or more prompts in a config, plus macros. Use the card converter below |
| Swipes | **Versions** of a message. Use the arrows on the message, the refresh button to regenerate, or *Add Version* in the message's ⌄ menu to write one yourself |
| Editing a message | Pencil button. Works on any message, including the AI's reasoning and tool results |
| Writing as the AI | The **User / Assistant** toggle beside the input: with Assistant selected, sending adds your text as an AI message without making a request. There is no model-written "impersonate" button |
| Hide messages / context size | **Cut Here** in a message's ⌄ menu: earlier messages are not sent. `/compact` summarizes and moves the cut for you |
| Branches | **Fork Here** in the ⌄ menu: a new independent chat up to that message |
| World Info | **Lore** (sidebar → Lore). See the note below, it is not keyword-triggered |
| Samplers per API | Sidebar → **Samplers**: overrides matched by model name pattern, saved with the config. **Extra body args** adds raw JSON to requests |
| Reasoning / prefill | Sidebar → **Reasoning**: effort, whether past reasoning is re-sent, and a reasoning prefill |

Other things:

- **Continuing a reply**: end the chat on a partial AI message and send, and the model continues it. Many providers (Anthropic/claude) reject a conversation that ends on an assistant message, so this depends on the provider and model.
- **Reasoning prefill** (sidebar → Reasoning) is added to each request as a final assistant message, regardless of the User / Assistant toggle. It is not stored in the chat, and is skipped when the chat already ends on an assistant message.
- Macros are filled in when a message is sent, so a stored message contains the real text.
- `@Entry`, `@[Entry with spaces]` in your message pulls that lore entry into the request. `@ref 12` quotes message 12.
- **Once / Loop** beside the input: *Once* sends a single request, *Loop* keeps going while the model makes tool calls. Not super relevant unless you're using tools.
- Alt+Enter adds your message to the chat without sending it. While a reply is streaming, sending queues your next message.
- Ctrl+Shift+F searches the open chat (Ctrl+F also works but it misses messages that are not yet loaded for long chats). In the desktop chat list, Ctrl+O focuses the search.
- Models can use HTML in replies, so stylized output and small widgets work inline.

## Bringing your things over

**Presets.** Sidebar → Prompts → the config's ⋮ menu → **Import**. SillyTavern chat completion preset JSON is recognized: prompt order, enabled state, roles and injection depth are converted, and `{{macro}}` becomes `@@macro`. Define the macros the preset uses (`char`, `user`, ...) in sidebar → Macros.

**Preset support is limited.** Simple presets (a list of prompts) convert well. Presets built on variables, such as Freaky Frankenstein, will not work: only plain `{{name}}` macros are converted, so tags like `{{setvar::...}}` and `{{getvar::...}}` stay in the prompts as literal text, and look strange to you and to the model. The same goes for other SillyTavern macros Nugram has no equivalent for (`{{random::...}}`, `{{roll}}`, comments, ...). The placeholder entries for character card, world info and chat history are dropped. If an imported preset looks messy, a minimal prompt like the one in the steps above is usually the better start.

**Chats.** The top bar's upload button takes a SillyTavern `.jsonl` directly. Swipes become versions, and per-swipe reasoning, model and timing are kept. The chat's character and user names become the `char` and `user` macros. A warning is shown because this import is not fully tested yet; check the result. The standalone `scripts/convert_chat.js` (plain node, no dependencies) converts one file or a whole folder to the app's JSON format, but does not set the macros.

**Characters.** The top bar's upload button takes character cards (PNG with embedded data, or JSON; V1, V2 and V3). Importing one:

1. Adds a config named after the character, with the description, personality, scenario, system prompt and post-history instructions as prompts. Example messages become real user and assistant prompts (one per turn), wrapped in `[Example chat]` and `[Start a new chat]` markers. Existing configs are not touched.
2. Opens the greeting as an assistant message, with the alternate greetings as versions. A non-empty chat is left alone and a new chat is made (desktop). `{{char}}` and `{{user}}` in the greeting are filled in, and the `char` and `user` macros are set.
3. Adds the card's embedded lorebook entries to your lore, skipping names that already exist.

The config only holds the character. If you already have a roleplay config you like, copy the character's prompts into it instead of using the new one.

To convert cards outside the app, `bun scripts/convert_card.ts card.png out --user "Your name"` writes the same result as three files: `<name>.config.json` (sidebar → Prompts → the config's ⋮ menu → **Import**), `<name>.chat.json` (the top bar upload button, after the config) and `<name>.lore.json` (sidebar → Lore → Import, which **replaces** all current entries).

**Lorebooks.** There is no World Info import. A lore file is a JSON array of `{ "name", "description", "content" }`, so a lorebook can be converted with a few lines of script.

## Lore works differently

World Info inserts entries when keywords appear. Nugram's lore is a small wiki the model reads on demand: with the lore tools enabled (`grep_lore`, `read_lore_entries`, `edit_lore_entry`) it searches entries by name and description, reads the ones it needs, and can write new ones. Put keywords in an entry's description so searches find it, or mention the entry yourself with `@Entry`. Nothing is inserted automatically.

For larger worlds, the desktop app can run the same way against a folder of notes, for example an Obsidian vault. Set the chat's folder to the vault (sidebar → Workspace), enable the file tools, and describe the vault's layout in an `agents.md` in that folder, which is injected with the `@@agents` macro. This takes some setup that is not covered here.

## What is missing

- Character cards, avatars and a character library
- Group chats
- Keyword-triggered lore, and ST World Info files
- Extensions: TTS, image generation, expressions, vector storage
- Text completion (non-chat) APIs. Everything goes through chat completion or Responses style APIs
