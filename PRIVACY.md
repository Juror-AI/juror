# Juror Cloud Privacy Notice

Effective: August 21, 2026

Juror Cloud processes account identity, GitHub App installation metadata, selected repository metadata, pull-request run summaries, findings, billing records, and configured QA evidence to provide the hosted service. D1 contains only the queryable finding index; detailed explanations, claims, expected/actual text, attempts, and review/comment bodies live in private object storage. OAuth and provider credentials are kept in Cloudflare secrets; reusable credentials are not committed to this open-source repository.

Repository checkouts exist only inside a per-run isolated Sandbox and are destroyed after the run. Source checkouts, full patches, raw model scratch text, and chain-of-thought are not retained. Sanitized run reports are retained for up to one year and QA evidence for up to 90 days unless deletion occurs sooner.

Training-purpose PR review and comment collection is disabled by default. If a workspace admin opts in, selected review bodies and comments are redacted, pseudonymized, compressed, encrypted with a per-workspace key, and stored in a private object-storage bucket rather than the application database. PR descriptions and raw file paths require additional opt-ins. The retained corpus can be exported or permanently deleted in Settings; deleting it also destroys its workspace encryption key.

Cloudflare provides compute, database, queue, Sandbox, and object-storage infrastructure. GitHub provides repository identity and events. Configured AI providers process the minimum run material needed for review or QA. Stripe processes billing after a trial. These providers receive data only for their service function and under their own applicable terms.

We use account and operational data to provide, secure, meter, troubleshoot, and improve Juror Cloud. We do not sell personal information. Shared-model improvement uses private repository data only after an administrator explicitly selects that scope.

Workspace administrators control membership, repository access, retention choices, training consent, export, and deletion. Privacy requests can be sent privately through the repository's security contact process described in [SECURITY.md](SECURITY.md). We may retain minimal non-content records when required for billing, security, fraud prevention, or legal compliance.
