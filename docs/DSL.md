# Obsidian+ Tag Triggers DSL

**Turn your notes into interactive, programmable workflows.**

The Tag Triggers DSL (Domain-Specific Language) lets you automate what happens when you interact with tagged content in your notes. No coding required—just bullet points that describe what you want.

---

## Quick Start

Add a `## Tag Triggers` section to your tags config file:

```markdown
## Tag Triggers

- #podcast
  - onEnter:
    - read: `#podcast {{url}}`
    - fetch: `https://noembed.com/embed?url={{url}}` as: `meta`
    - transform:
      - #podcast {{meta.title}}
        - url: {{meta.url}}
        - channel: [{{meta.author_name}}]({{meta.author_url}})
        - {{cursor}}
```

Now type `- #podcast https://youtube.com/watch?v=xyz` and press **Enter**. The DSL fetches video metadata and transforms your line into a rich, structured note with title, URL, and channel info.

---

## How It Works

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
│  You type   │───▶│   Trigger    │───▶│   Actions   │───▶│  Transform   │
│  + Enter    │    │   fires      │    │   execute   │    │  your note   │
└─────────────┘    └──────────────┘    └─────────────┘    └──────────────┘
```

1. **Triggers** detect when something happens (Enter pressed, task checked, etc.)
2. **Actions** run in sequence—read content, fetch data, transform output
3. **Variables** extracted with `{{name}}` flow through the chain
4. **Errors** appear as `* Error: ...` bullets so you know what went wrong

---

## Triggers

Triggers are entry points—they fire when specific events occur.

| Trigger | When It Fires |
|---------|--------------|
| `onEnter` | User presses Enter at end of a tagged line |
| `onTrigger` | Task enters “in progress” phase for a connector-driven transaction |
| `onDone` | Task enters done `[x]` (fires even if `onTrigger` is not defined) |
| `onError` | Task marked with error `[!]` |
| `onInProgress` | Task marked in-progress `[/]` |
| `onCancelled` | Task marked cancelled `[-]` |
| `onReset` | Task checkbox cleared `[ ]` |

### Example: Webhook on Task Completion

```markdown
- #deploy
  - onDone:
    - build: `payload`
      - task: `{{task.text}}`
      - file: `{{file.path}}`
      - timestamp: `{{task.completed}}`
    - fetch: `https://api.example.com/deploy`
      - method: POST
      - body: `{{payload}}`
```

Check off a `#deploy` task → sends a webhook to your deployment API.

---

## Actions Reference

### `read` — Extract Data from Text

Reads the current line (or file/selection) and extracts variables using patterns.

```yaml
- read: `#tag {{variable}}`
```

**Pattern Syntax:**

| Pattern | Meaning | Example |
|---------|---------|---------|
| `{{var}}` | Capture required value (first word) | `{{url}}` → must exist |
| `{{var?}}` | Capture optional value | `{{subtitle?}}` → can be empty |
| `{{var*}}` | Greedy (rest of line) | `{{description*}}` |
| `{{items+}}` | Space-separated list | `apple banana` → `["apple", "banana"]` |
| `{{items+:, }}` | Custom delimiter list | `a, b, c` → `["a", "b", "c"]` |

> **Tip:** Placeholders must be closed. An unbalanced token such as `{{name` will throw an error during execution instead of running with the literal text.

**Options:**
- `source: file` — read entire file instead of current line
- `source: selection` — read selected text
- `source: children` — read child bullets
- `source: wikilink` — read the contents of another note by wikilink
- `source: image` — read image file (wikilink or URL) and convert to base64
- `asFile: fromFile` — when reading another file/image, also expose its metadata (path, name, basename, extension, resourcePath, frontmatter on Markdown)
- `includeFrontmatter: true` — when reading another Markdown note by wikilink, also expose its YAML frontmatter
- `frontmatterAs: meta` — rename the frontmatter variable (defaults to `frontmatter`)

#### Reading another note by wikilink

```yaml
- read: ``
  - source: wikilink
  - from: `[[My Blog Post]]`
  - as: `post_md`
  - stripFrontmatter: true
```

After this, `{{post_md}}` contains the linked note's markdown body, and `{{text}}` is also set to the same content.
`{{fromFile}}` holds the linked note's metadata (path/name/basename/extension/resourcePath/frontmatter) unless you set `asFile` to a different variable name.

**Reading a specific section:**

You can read just a section of a note by including a heading anchor in the wikilink:

```yaml
- read: ``
  - source: wikilink
  - from: `[[My Blog Post#Introduction]]`
  - as: `intro_section`
```

This will:
- Find the heading that matches "Introduction" (case-insensitive, supports slug matching)
- Extract all content from that heading until the next heading of the same or higher level
- Store only that section's content in `{{intro_section}}`

**Section matching:**
- Matches by heading text (case-insensitive) or slug
- Supports all heading levels (`#`, `##`, `###`, etc.)
- Extracts content until the next heading of equal or higher level
- If the section isn't found, throws an error with a clear message

**Example:**
```markdown
# My Blog Post

Some intro text.

## Introduction

This is the introduction section.
It has multiple paragraphs.

## Next Section

This won't be included.
```

Using `[[My Blog Post#Introduction]]` will extract:
```markdown
## Introduction

This is the introduction section.
It has multiple paragraphs.
```

#### Reading images (wikilinks or URLs)

Read image files and convert them to base64 for sending to APIs:

```yaml
- read: ``
  - source: image
  - from: `{{meta.media}}`
  - as: `media_base64`
  - format: base64   # or 'dataUri' (default), 'url'
```

**Behavior:**
- If `from` is an external URL (`http://...` or `https://...`), it's passed through as-is (when `format: url`)
- If `from` is a wikilink (`![[image.png]]` or `[[image.png]]`):
  - Resolves to the image file in your vault
  - Reads the binary data
  - Converts to base64 string or data URI
  - Supported formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`
  - Also exposes file metadata at `{{fromFile}}` (or your custom `asFile` variable)

**Format options:**
- `format: base64` — returns just the base64 string (e.g., `iVBORw0KGgo...`)
- `format: dataUri` — returns data URI (e.g., `data:image/png;base64,iVBORw0KGgo...`) (default)
- `format: url` — for external URLs, passes through; for local files, returns resource path

**Example:**
```yaml
- read: ``
  - source: children
  - childrenAs: `meta`
- read: ``
  - source: image
  - from: `{{meta.media}}`
  - as: `media`
  - format: base64
- build: `payload`
  - title: `{{file.basename}}`
  - media: `{{media}}`
```

#### Reading children as an object

When you `read` from `children`, the DSL also builds an object view:

- Lines that look like `key: value` become properties (e.g. `{{children.title}}`).
- Lines that do **not** match `key: value` are ignored for the object (but still exist in `{{childrenLines}}` / `{{text}}`).

```yaml
- read: ``
  - source: children
  - childrenAs: `meta`
  - childrenLinesAs: `meta_lines`
```

Now you can reference:
- `{{meta.post}}` (from a `post: [[...]]` child)
- `{{meta.title}}`
- `{{meta.tags}}` (string unless you parse it)
- raw: `{{meta_lines}}`

---

### `file` — Resolve Wikilinks to File Metadata

Resolve a wikilink or path to the underlying vault file without reading its contents. The resolved metadata is safe to hand to `shell` or other actions that need on-disk paths.

```yaml
- file: `[[My Note]]` as: `noteFile`
- shell: `cat "{{noteFile.path}}"`
```

**Metadata fields:**
- `path`, `name`, `basename`, `extension`
- `resourcePath` (Obsidian resource URL for embeds)
- `frontmatter` (Markdown files only; `null` for non-Markdown)

If you already `read` a wikilink or image, `{{fromFile}}` (or your `asFile:` override) contains the same metadata without needing a separate `file` action.

---

### `validate` — Fail Fast (with a Useful Error)

`validate` is your guardrail: it turns “mystery automations” into reliable workflows.

```yaml
- validate: `{{config.BLOG_API_TOKEN}}` message: `Missing BLOG_API_TOKEN (set it via config:)`
```

- If the condition is falsy (or a required variable is missing), execution stops and a `* Error (validate): ...` bullet is appended in the note.
- Use `{{var?}}` when you explicitly want optional data.

---

### `delay` — Wait Before the Next Step

```yaml
- delay: `500ms`
- delay: `2s`
- delay: `1m`
```

Useful for rate limits, backoff, or letting external systems catch up.

---

### `filter` — Keep Only What You Want (Lists)

`filter` takes an array and keeps only items matching a simple condition.

```yaml
- filter: `items` as: `nonEmpty` where: `{{item}} != ""`
```

You can control the per-item variable name:

```yaml
- filter: `tasks` as: `done` 
  - itemAs: `t`
  - where: `{{t.completed}} == true`
```

---

### `map` — Convert Lists Into Other Lists

`map` transforms an array into a new array using a template.

```yaml
- map: `tasks` as: `titles` template: `{{item.text}}`
```

If your template renders JSON, `map` will parse it into objects automatically.

---

### `date` — Time Without Writing Code

Set a variable to “now”, or parse an existing date string.

```yaml
- date: `now` as: `created` 
  - format: epoch   # epoch|unix|iso|date
```

```yaml
- date: `parse` as: `created`
  - from: `{{meta.date}}`
  - format: unix
```

---

### `fetch` — Make HTTP Requests

Fetches data from APIs and stores the response.

```yaml
- fetch: `https://api.example.com/data` as: `response`
```

**Full Syntax:**

```yaml
- fetch: `https://api.example.com/endpoint`
  - method: POST
  - body: `{{payload}}`
  - headers:
    - Content-Type: application/json
    - X-Custom-Header: {{value}}
  - auth:
    - type: bearer
    - token: `{{secrets.API_TOKEN}}`
  - as: result
```

**Authentication Types:**

| Type | Fields |
|------|--------|
| `basic` | `username`, `password` |
| `bearer` | `token` |
| `apiKey` | `apiKey`, `headerName` (default: `X-API-Key`) |

**Response Handling:**
- JSON responses are automatically parsed
- Access nested fields: `{{response.data.items}}`
- Array access: `{{response.items.0}}` or `{{response.items[0]}}`

---

### `shell` — Run Local Commands (Vault-Scoped)

Executes a shell command from the vault root so relative paths stay inside your vault.

```yaml
- shell: `ls templates`
  - as: `listing`
```

**Behavior & safety:**
- Commands are run with the vault root as the working directory.
- Absolute paths (`/`, `~`, drive letters) and parent segments (`..`) are rejected to keep execution inside the vault. Symlink external folders into the vault if needed.
- Combined stdout/stderr is stored in `as:` (if provided) and echoed as a `+` child bullet.
- Non-zero exit codes produce a `* Error (shell): ...` bullet with the failure details.

Use this for lightweight local automations that should only touch files inside the vault.

---

### `transform` — Reshape Your Content

Replaces the current line and adds child bullets.

```yaml
- transform:
  - New line content {{with.variables}}
    - child bullet {{more.data}}
    - another child
    - {{cursor}}
```

**Key Features:**
- First child becomes the replacement line
- Nested children preserve hierarchy  
- `{{cursor}}` marks where your cursor lands after transform
- Indentation in config = indentation in output

---

### `set` — Create or Update Variables

Sets a variable to a value (string or parsed JSON). Can also extract values using pattern syntax (like `read`).

**Simple assignment:**
```yaml
- set: `myVar` value: `Hello {{name}}`
```

**JavaScript expressions inside `{{ ... }}`:**
- When a placeholder continues past the variable name (e.g., `{{note.path.toLowerCase()}}`), the full expression is executed with all current variables in scope.
- The expression result is stringified (objects become JSON) and spliced into the template; `null`/`undefined` become empty strings.

Example — slugify a wikilinked file path:
```yaml
- set: `slug`
  value: `{{noteFile.path.toLowerCase().replace(/[^a-z0-9]+/g, '-')}}`
```

**Extract using pattern (e.g., parse comma-separated list into array):**
```yaml
- set: `tags` value: `{{meta.tags}}` pattern: `{{tags+:, }}`
```

**Pattern examples:**
- `pattern: {{tags+:, }}` — comma-space-separated list → array
- `pattern: {{items+}}` — space-separated list → array  
- `pattern: {{items+;}}` — semicolon-separated list → array

When a pattern is provided, `set` uses the same extraction logic as `read`, allowing you to parse strings into structured data (arrays, objects, etc.). This differentiates `set` from `build` (which constructs objects from child bullets).

Use for intermediate calculations, preparing data, or parsing structured strings.

---

### `foreach` — Loop Over Arrays

Iterates over an array variable, running child actions for each item.

```yaml
- foreach: `items` as: `item`
  - append: `[ ] {{item}}`
```

**Available Loop Variables:**
- `{{item}}` — current item (or custom name via `as:`)
- `{{item_index}}` — zero-based index

---

### `append` — Add Child Bullets

Appends a new child bullet under the current line.

```yaml
- append: `New child content`
  - indent: 2   # optional: indent level (default: 1)
```

**Bullet safety:**
- In **task-trigger contexts** (`onTrigger`/`onDone`/etc), `append` writes children using **`+` bullets** by default (automation output).
- In **editor contexts** (`onEnter`), `append` writes `-` children (useful for “create tasks” workflows like `#shopping`).

If you’re writing “automation output” under a task, prefer the `task` action below for explicit control.

---

### `task` — Safe Task Manipulation (status, clear errors/responses)

`task` is a set of primitives for interacting with the current task **without touching user-authored `-` bullets**.

#### Clear children by bullet

- Errors in Obsidian+ / DSL use `*`
- Connector responses / outputs use `+`

```yaml
- task: clear bullets: `*`   # clear errors
- task: clear bullets: `+`   # clear responses
- task: clear bullets: `*+`  # clear both
```

#### Set task status

```yaml
- task: status to: `x`
- task: status to: `!`
- task: status to: `/`
```

#### Append a generated child line (defaults to `+`)

```yaml
- task: append `Posted id={{res.id}}`
- task: append `API response stored` indent: 2
```

Safety rules:
- `task` refuses to clear or write `-` bullets (those are considered user-owned)
- Use `*` for errors, `+` for generated output

---

### `if` — Conditional Logic

Executes actions conditionally.

```yaml
- if: `{{status}} == done`
  - notify: `Task completed!`
  - else:
    - log: `Task not done yet`
```

**Supported Operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`

---

### `notify` — Show User Notification

Displays an Obsidian notice popup.

```yaml
- notify: `Operation completed!`
  - duration: 5000   # milliseconds
```

---

### `log` — Debug Logging

Logs to the developer console (Ctrl+Shift+I).

```yaml
- log: `Current value: {{myVar}}`
```

---

### `extract` — Regex Extraction

Extracts matches using regular expressions.

```yaml
- extract: `/(\d{4})-(\d{2})-(\d{2})/` from: `{{text}}` as: `dates`
```

---

### `match` — Pattern Matching

Like `read`, but matches against a variable instead of the line.

```yaml
- match: `{{pattern}}` in: `{{text}}`
```

---

### `query` — Search Your Vault

Queries tasks using the tag system.

```yaml
- query: `#project` as: `tasks`
  - onlyCompleted: true
```

---

### `return` — Early Exit

Stops execution and optionally returns a value.

```yaml
- return: `{{result}}`
```

---

## Complete Examples

### 📻 Podcast Metadata Fetcher

Type a YouTube/podcast URL, press Enter, get rich metadata:

```markdown
- #podcast
  - onEnter:
    - read: `#podcast {{url}}`
    - fetch: `https://noembed.com/embed?url={{url}}` as: `meta`
    - transform:
      - #podcast {{meta.title}}
        - url: {{meta.url}}
        - channel: [{{meta.author_name}}]({{meta.author_url}})
        - {{cursor}}
```

**Before:** `- #podcast https://youtube.com/watch?v=dQw4w9WgXcQ`

**After:**
```markdown
- #podcast Never Gonna Give You Up
  - url: https://youtube.com/watch?v=dQw4w9WgXcQ
  - channel: [Rick Astley](https://youtube.com/channel/UC...)
  - 
```

---

### 🛒 Shopping List Expander

Turn inline items into a checkbox list:

```markdown
- #shopping
  - onEnter:
    - read: `#shopping {{items+:, }}`
    - transform:
      - #shopping
    - foreach: `items` as: `item`
      - append: `[ ] {{item}}`
```

**Before:** `- #shopping skim milk, eggs, bread, swiss cheese`

**After:**
```markdown
- #shopping
  - [ ] skim milk
  - [ ] eggs
  - [ ] bread
  - [ ] swiss cheese
```

---

### ✍️ Publish a Blog Post (linked note + metadata)

This shows how to publish a post file referenced from a task. The task holds a wikilink to the post, plus any extra metadata you want.

**Tag Triggers config:**

```markdown
- #publish-blog
  - config: `config/blog-secrets.json`
  - onTrigger:
    - validate: `{{config.BLOG_API_TOKEN}}` message: `Missing BLOG_API_TOKEN`

    # Grab metadata from children as an object (only `key: value` lines become properties)
    - read: ``
      - source: children
      - childrenAs: `meta`
      - childrenLinesAs: `meta_lines`
    - validate: `{{meta.post}}` message: `Missing post: [[...]] child bullet`

    # Read linked post content
    - read: ``
      - source: wikilink
      - from: `{{meta.post}}`
      - as: `post_md`
      - stripFrontmatter: true

    # Parse tags from comma-separated string into array
    - set: `tags` value: `{{meta.tags}}` pattern: `{{tags+:, }}`
    
    # Convert image to base64 if provided
    - if: `{{meta.media}}`
      - read: ``
        - source: image
        - from: `{{meta.media}}`
        - as: `media_base64`
        - format: base64
    
    # Build payload + publish
    - date: `now` as: `created` 
      - format: epoch
    - build: `payload`
      - title: `{{file.basename}}`
      - created: `{{created}}`
      - content: `{{post_md}}`
      - tags: `{{tags}}`
      - media: `{{media_base64?}}`
    - fetch: `https://staging.host.horse/api/blog` as: `res`
      - method: POST
      - headers:
        - Authorization: `Bearer {{config.BLOG_API_TOKEN}}`
      - body: `{{payload}}`

    - transform:
      - #publish-blog ✅ Posted id={{res.id}}
        - {{cursor}}
```

**In your note:**

```markdown
- [ ] #publish-blog
  - post: [[Blog/My First Post]]
  - tags: tech, obsidian, automation
  - media: ![[Blog/header-image.png]]
```

- The `tags: tech, obsidian, automation` child gets parsed into an array via `set` with pattern `{{tags+:, }}`
- The `media: ![[Blog/header-image.png]]` child gets converted to base64 via `read source: image`
- Both are included in the payload sent to your blog API

### 🔔 Slack Notification on Task Complete

```markdown
- #notify-slack
  - onDone:
    - build: `payload`
      - text: `Task completed: {{task.text}}`
      - channel: `#general`
    - fetch: `https://hooks.slack.com/services/xxx/yyy/zzz`
      - method: POST
      - body: `{{payload}}`
    - notify: `Slack notified!`
```

---

### 📊 Project Summary Generator

```markdown
- #project-summary
  - onTrigger:
    - query: `#{{task.text}}` as: `tasks`
    - filter: `tasks` as: `done` 
      - itemAs: `t`
      - where: `{{t.completed}} == true`
    - map: `done` as: `doneTitles` template: `{{item.text}}`
    - set: `completed` value: `{{done.length}}`
    - transform:
      - {{task.text}} Summary
        - Total: {{tasks.length}} tasks
        - Completed: {{completed}}
```

---

## Error Handling

Every action can have an `onError` block:

```yaml
- fetch: `https://api.example.com/data` as: `result`
  - onError:
    - notify: `API failed: {{error.message}}`
    - set: `result` value: `{}`
```

**Default Behavior:**
- Errors appear as `* Error (action): message` child bullets
- Execution stops at the first error (unless handled)
- The cursor moves to the error line for easy fixing

---

## Variables Reference

### Built-in Variables

| Variable | Description |
|----------|-------------|
| `{{line}}` | Current line text |
| `{{file.path}}` | File path |
| `{{file.name}}` | File name with extension |
| `{{file.basename}}` | File name without extension |
| `{{file.frontmatter}}` | YAML frontmatter object for the current Markdown file (or `null` if absent) |
| `{{task.text}}` | Task text (if in task context) |
| `{{task.completed}}` | Whether task is completed |
| `{{task.status}}` | Task status character |
| `{{cursor}}` | Special: marks cursor position in transforms |

#### File metadata variables

- Current note: `{{file.path}}`, `{{file.name}}`, `{{file.basename}}`, `{{file.extension}}`, `{{file.frontmatter}}`
- Resolved wikilinks/images: `{{fromFile.*}}` (or your custom `asFile:` variable on `read`), including `frontmatter` for Markdown notes
- Standalone resolution: `file: [[Note]] as: linkFile` exposes `{{linkFile.path}}`, `{{linkFile.resourcePath}}`, `{{linkFile.frontmatter}}`, etc.

### Trigger Event Variables (Status Transitions)

For task-trigger flows, the DSL also receives an `event` object:

- `{{event.fromStatus}}` — status before the change (e.g. `" "`, `"/"`)
- `{{event.toStatus}}` — status after the change (e.g. `"x"`, `"!"`)

This is especially useful in `onTrigger` if you want to gate execution:

```yaml
- onTrigger:
  - if: `{{event.toStatus}} != x`
    - return: ``
  - log: `Running only for completion`
```

### Variable Strictness

- `{{var}}` — **Required.** Error if missing.
- `{{var?}}` — **Optional.** Empty string if missing.

This prevents silent failures—you'll know immediately if data didn't load.

---

## Tips & Best Practices

### 1. Start Simple
Begin with `read` + `transform`. Add `fetch` when you need external data.

### 2. Use Logging for Debugging
```yaml
- log: `URL is: {{url}}`
- log: `Response: {{response}}`
```
Check the developer console (Ctrl+Shift+I) to see values.

### 3. Handle Errors Gracefully
Add `onError` blocks for network requests:
```yaml
- fetch: `...`
  - onError:
    - notify: `Request failed`
```

### 4. Test Patterns Incrementally
If `read` fails, the pattern doesn't match. Check:
- Spelling of the tag
- Spaces in the pattern vs. your actual line
- Required vs. optional variables (`{{x}}` vs `{{x?}}`)

### 5. Chain Actions Logically
```
read → (extract variables) → fetch → (get data) → transform → (update note)
```

### 6. Read Specific Sections from Long Notes
If you only need part of a note, use section anchors:
```yaml
- read: ``
  - source: wikilink
  - from: `[[Long Note#Summary Section]]`
```
This extracts just that section instead of the entire file—useful for large notes or when you only need specific content.

---

## FAQ

**Q: Why isn't my trigger firing?**
- Check that your tag is defined in `## Tag Triggers` section
- For `onEnter`, cursor must be at end of line when you press Enter
- Tags with `onEnter` only are NOT promoted to task tags

**Q: Why do I see `{{variable}}` in my output instead of the value?**
- The variable is missing or misspelled
- The fetch failed (check for `* Error` bullets)
- Use `{{variable?}}` if it's optional

**Q: Can I call other plugins/connectors?**
- Currently DSL has built-in fetch for HTTP calls
- AI and specialized integrations use their own connectors
- Future: `invoke` command to call connectors from DSL

**Q: What's the difference between `set` and `build`?**
- `set` creates a single variable: `set: name value: John`
- `set` with `pattern` extracts structured data from strings: `set: tags value: {{meta.tags}} pattern: {{tags+:, }}`
- `build` creates an object with multiple properties from child bullets:
  ```yaml
  - build: person
    - name: John
    - age: 30
  ```
- Both try to parse JSON, so `set: data value: [1,2,3]` creates an array
- Use `set` with `pattern` when you need to parse a string (like comma-separated lists) into arrays/objects

---

## What's Next?

The DSL is actively evolving. Planned features:

- **`invoke`** — Call other connectors (AI, HTTP) from DSL
- **`prompt`** — Request user input mid-execution
- **`delay`** — Wait before next action
- **`validate`** — Assert conditions with custom error messages
- **`navigate`** — Open files/headings programmatically

Have ideas? The DSL is designed to be extensible—new actions are straightforward to add.

---

*Tag Triggers DSL — Write triggers, not code.*

