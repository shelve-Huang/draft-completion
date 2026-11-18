# Draft completion

A composer control that turns a rough draft into a complete prompt, with one-click revert.

## What it does

A **Complete** button sits immediately left of the model selector in the message composer. It sends the text currently in the composer to the model selected in that selector, rewrites it into a more complete and explicit request, and writes the result back into the composer. Nothing is submitted: the rewritten text stays an editable draft.

After a successful rewrite the control becomes **Revert** — the two are never on screen together — and clicking it restores the exact draft from before the rewrite. That revert lives only as long as the draft still holds the rewritten text: the first edit drops it, the control returns to **Complete**, and the completion can no longer be undone. A stale rewrite therefore never reverts over newer text, and one completion is revertable at a time.

The control disables itself while the draft is empty, while the composer is sending a message, and while a rewrite is already running. If the draft is edited while a rewrite is in flight, the result is discarded instead of overwriting the newer edit.

## Model traffic

Each click makes exactly one extra model request to the provider of the model currently selected in the composer, billed to that provider account. The request carries the draft text only: no conversation history, no workspace files, and no attachments. The rewritten prompt is returned over a local, authenticated route and never leaves the machine except on that provider request.

## Configuration

The patch row accepts optional overrides; unset fields keep the defaults.

| Key | Default | Meaning |
|---|---|---|
| `maxInputChars` | `8000` | Longest draft accepted; a longer draft is refused with `draft-too-long` |
| `maxOutputTokens` | `1200` | Output-token cap for one rewrite |
| `temperature` | `0.3` | Sampling temperature; lower keeps the rewrite closer to the draft |
| `systemPrompt` | built-in | Replaces the rewrite instructions wholesale |

```yaml
- id: draft-completion
  name: '@local/draft-completion'
  config:
    maxOutputTokens: 2000
    temperature: 0.2
```

## Limitations

- The rewrite uses the model the composer's selector currently shows. Switching providers mid-session is reflected immediately; a stale default-model record is not consulted.
- Draft attachments and inline reference chips are not part of the prompt; the completion sees the draft's plain text, and applying a result replaces the draft body, so reference chips in the draft are dropped by the rewrite.
- The route is bound to `plugin/draft-completion/complete` and is not relocatable through configuration, because the Client half addresses it by that path.
- Reasoning output is discarded; only the visible text block becomes the rewritten draft.
- Turning the plugin off — in **Plugins** or through `plugin_manager` — removes the button, the locale dictionaries, and the route together.
