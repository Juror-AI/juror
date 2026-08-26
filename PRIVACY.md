# Juror Cloud Privacy Notice

Effective: August 26, 2026

Juror Cloud processes account identity, GitHub App installation metadata, selected repository metadata, pull-request run summaries, findings, billing records, and configured QA evidence to provide the hosted service. D1 contains only the queryable finding index; detailed explanations, claims, expected/actual text, attempts, and review/comment bodies live in private object storage. OAuth and provider credentials are kept in Cloudflare secrets; reusable credentials are not committed to this open-source repository.

Repository checkouts exist only inside a per-run isolated Sandbox and are destroyed after the run. Source checkouts, full patches, raw model scratch text, and chain-of-thought are not retained. Sanitized run reports are retained for up to one year and QA evidence for up to 90 days unless deletion occurs sooner.

Training-purpose PR review and comment collection is disabled by default. If a workspace admin opts in, selected review bodies and comments are redacted, pseudonymized, compressed, encrypted with a per-workspace key, and stored in a private object-storage bucket rather than the application database. PR descriptions and raw file paths require additional opt-ins. The retained corpus can be exported or permanently deleted in Settings; deleting it also destroys its workspace encryption key.

Cloudflare provides compute, database, queue, Sandbox, and object-storage infrastructure. GitHub provides repository identity and events. Configured AI providers process the minimum run material needed for review or QA. Stripe processes billing after a trial. These providers receive data only for their service function and under their own applicable terms.

We use account and operational data to provide, secure, meter, troubleshoot, and improve Juror Cloud. We do not sell personal information. Shared-model improvement uses private repository data only after an administrator explicitly selects that scope.

## ChatGPT, Codex, and MCP access

The Juror Plugin and remote MCP endpoint use OAuth 2.1 through the same Juror Cloud account identity and workspace memberships. A connected client receives a short-lived, resource-bound access token and only the scopes it has been granted. We retain OAuth client, consent, token-revocation, and minimal confirmation records needed to secure the connection and prevent replay; review confirmation records expire after five minutes.

MCP responses contain only the minimum workspace-scoped review metadata needed for the requested tool. A retained finding body or claim is returned only when a caller explicitly requests one named finding. The endpoint does not return raw diffs, repository checkouts, full reports, screenshots, artifacts, provider credentials, or model prompt text. You can revoke a connected client from your Juror Cloud account/session controls; token expiry and revocation then prevent further access.

Directory-native aggregate analytics and redacted operational counters may measure connection health. We do not log chat prompts, MCP tool arguments, finding text, repository names, or secrets for analytics.

Workspace administrators control membership, repository access, retention choices, training consent, export, and deletion. Privacy requests can be sent privately through the repository's security contact process described in [SECURITY.md](SECURITY.md). We may retain minimal non-content records when required for billing, security, fraud prevention, or legal compliance.
