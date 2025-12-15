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
| `onTrigger` | User toggles any task checkbox |
| `onDone` | Task marked complete `[x]` |
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
| `{{var}}` | Capture required value | `{{url}}` → must exist |
| `{{var?}}` | Capture optional value | `{{subtitle?}}` → can be empty |
| `{{var*}}` | Greedy (rest of line) | `{{description*}}` |
| `{{items+}}` | Space-separated list | `apple banana` → `["apple", "banana"]` |
| `{{items+:, }}` | Custom delimiter list | `a, b, c` → `["a", "b", "c"]` |

**Options:**
- `source: file` — read entire file instead of current line
- `source: selection` — read selected text
- `source: children` — read child bullets

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

Sets a variable to a value (string or parsed JSON).

```yaml
- set: `myVar` value: `Hello {{name}}`
```

Use for intermediate calculations or preparing data.

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
    - set: `completed` value: `{{tasks.filter(t => t.completed).length}}`
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
| `{{task.text}}` | Task text (if in task context) |
| `{{task.completed}}` | Whether task is completed |
| `{{task.status}}` | Task status character |
| `{{cursor}}` | Special: marks cursor position in transforms |

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
- `build` creates an object with multiple properties:
  ```yaml
  - build: person
    - name: John
    - age: 30
  ```
- Both try to parse JSON, so `set: data value: [1,2,3]` creates an array

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

