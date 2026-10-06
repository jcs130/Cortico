Owner: `index.ts` (`ProviderModule`), `native.ts` (`ChatCompatProvider`), `config.ts` (`protocolConfig`).

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

`options.extraHeaders` adds request headers; the configured bearer secret owns Authorization.
`options.extraBody` overrides generated body fields. The caller's streaming choice remains
authoritative. Streaming requests include usage unless an explicit `stream_options` override is
supplied. `options.maxContextImages` limits the newest unique saved image handles; unset replays
all saved images and zero leaves attachment text only. Saved images require `multimodal: true`.
Inline image content parts and function results use the shared Chat history renderer.

The module declares its protocol settings as a ConfigGroup and uses the standard connection
editor. Provider discovery reads its `index.ts`; no console client registration is required.
