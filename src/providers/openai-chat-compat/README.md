Owner: `index.ts` (`ProviderModule`), `native.ts` (`ChatCompatProvider`), `config.ts` (`protocolConfig`), `../transport/tool-schema.ts` (`prefixTupleItems`).

# OpenAI Chat Completions Compatible

This module translates Cortico's request and response Items to Chat Completions. The shared
transport owns streaming, cancellation, retries, native function calls and usage accounting.
Adjacent assistant reasoning, text and function calls share one Chat message; tool results keep
their call IDs across subsequent requests.

Connections use the provider library's existing endpoint, secret and model fields. Set `kind`
to `openai-chat-compat`; `baseUrl` is the API prefix and `options.endpointPath` defaults to
`/chat/completions`. Model discovery uses the same prefix's `/models`; a model can also be entered
manually. Secrets are resolved through the provider host and never belong in request-body options.

`ModelSpec.thinking` controls the default `reasoning_effort` mapping: off sends `none`, while on
sends the configured effort or leaves the endpoint's default in effect. `options.reasoningMode`
may be `extra_body` when the endpoint uses another thinking field; the operator supplies that
field in `options.extraBody`. In this mode changing the model's thinking switch does not rewrite
the supplied body, so the connection's body and model settings must agree.

`options.replayReasoning` defaults to false. Enable it only for endpoints accepting assistant
`reasoning_content`. The host's `keepThinking` choice still determines whether past reasoning is
retained. Returned reasoning remains part of Cortico's response Items in either replay mode.

Returned function-call `extra_content` is preserved as opaque per-Item context metadata, outside
the standard response Items and usage logs. It survives session persistence, retained handoff
records and background tool rounds. Replay requires the same provider instance, module, model
and compatibility domain; dropping past reasoning does not discard continuation metadata.
`options.legacyFunctionCallExtraContent` is an optional object for an endpoint's documented
migration of synthetic or foreign-provider function calls. It defaults to absent and never
replaces continuation data from the current provider, including unsigned parallel calls.

`options.tupleSchemaStyle` defaults to `items`, preserving the tools' tuple notation. Select
`prefixItems` for endpoints requiring newer JSON Schema tuple syntax. Conversion walks schema
positions only, retains positional constraints and maps `additionalItems` to the trailing
`items` schema; examples and defaults are unchanged. Stored tool definitions and validation
of the returned arguments retain their original contracts.

`options.extraHeaders` adds request headers; the configured bearer secret owns Authorization.
`options.extraBody` overrides generated body fields. The caller's streaming choice remains
authoritative and every stream sets `stream_options.include_usage=true` after the merge.
Nonstream requests omit `stream_options`. `options.maxContextImages` limits the newest unique saved image handles; unset replays
all saved images and zero leaves attachment text only. Saved images require `multimodal: true`.
Inline image content parts and function results use the shared Chat history renderer.

Requests carry the full selected history. Tool names are sorted and JSON object keys serialize
canonically; message order and schema arrays are retained. The transport serializes once before
retrying. An explicit request reasoning level and output limit take precedence over native model
defaults. `inference_stats` is read alongside final usage without an SDK projection; mismatched
session or request statistics are rejected. Stored usage contains allowlisted counters only.

The module declares its protocol settings as a ConfigGroup and uses the standard connection
editor. Provider discovery reads its `index.ts`; no console client registration is required.
