# Juror MCP directory submissions

Canonical production endpoint: `https://app.juror.dev/mcp`

OAuth protected-resource metadata: `https://app.juror.dev/.well-known/oauth-protected-resource`
Metadata version: `1.0.0` (`registry/server.json`)

This record is deliberately factual. A directory entry is not marked published until the release owner has submitted it from the verified publisher account and tested the live canonical endpoint.

| Directory | Submission URL | Release owner | Status | Renewal / update requirement | Rejection reason |
| --- | --- | --- | --- | --- | --- |
| OpenAI Plugin directory | `https://platform.openai.com/` | Assign before submission | Prepared — external submission required | Re-submit listing changes; retain verified publisher identity | — |
| Official MCP Registry | `https://registry.modelcontextprotocol.io/` | Assign before submission | Prepared — publish `registry/server.json` as `dev.juror/juror` after DNS namespace verification | Publish a new semantic version for metadata or endpoint changes | — |
| Smithery | `https://smithery.ai/` | Assign before submission | Prepared — add the external Streamable HTTP server; no proxy | Keep endpoint, OAuth, and public docs current | — |
| Glama | `https://glama.ai/` | Assign before submission | Prepared — set `GLAMA_MAINTAINER_EMAIL` to the publisher email and verify `/.well-known/glama.json` | Re-verify after publisher-email or domain changes | — |
| MCP.so | `https://github.com/chatmcp/mcpso/issues/new` | Assign before submission | Prepared — submit factual remote connection details | Update the issue/listing when endpoint or metadata changes | — |

## Submission packet

- Publisher: Juror (verified organization required for OpenAI public publication).
- Listing promise: “Inspect multi-model PR findings and safely run or rerun Juror Cloud reviews.”
- Category: Developer Tools.
- Support and product page: `https://juror.dev/en/integrations/chatgpt`.
- Privacy and terms: `https://app.juror.dev/privacy` and `https://app.juror.dev/terms`.
- Authentication: OAuth 2.1 authorization code flow for public DCR clients with PKCE S256; resource-bound five-minute JWT access tokens.
- Scopes: `juror.read` and `juror.reviews.write`.
- Connection: direct Streamable HTTP only; no proxy, SSE, duplicate listing, or paid ranking.
- Attach staging-verified screenshots of the passive review card, OAuth linking, and a redacted prepare → confirm → start flow before submitting.

## Release validation

1. Verify DNS ownership for the `dev.juror` registry namespace and the Juror publisher identity in OpenAI.
2. Run MCP Inspector and ChatGPT/Codex developer-mode tests against staging.
3. Confirm the production `/mcp`, OAuth discovery, protected-resource metadata, and Glama file resolve from the public internet.
4. After each directory is accepted, record its public URL, reviewer decision, and any renewal date in this table.
