# Obsidian Plus MCP Server

## Portal Pattern (Default Behavior)

When `tagPortalsOnly` is enabled (default: true), writes to Obsidian must target tagged bullets:

1. **Use `query_tag` first** to find an existing tagged bullet
2. **Use `append_to_note` with `parentLine`** pointing to the tag's line number
3. **Only use `createTaggedRoot=true`** when user explicitly asks to create a new entry

## Daily Notes Section Rules

- **Notes & Tasks** = default section (work done today, task results, enrichments)
- **Reflection & Plan** = ONLY for introspection, reviewing the day, planning tomorrow

## Example Workflow

```
# User: "enrich the #process item about just commands"

1. query_tag("#process", query="just commands") → finds line 52
2. append_to_note(date="today", parentLine=52, content="Here's the summary...")
```

## Error Recovery

If you get a "Tag portal required" error:
- Use `query_tag` to find a tagged bullet first
- Provide the line number as `parentLine`
- Or ask the user to create a tagged bullet as an entry point
