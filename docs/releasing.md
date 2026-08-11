# Releasing Juror

## Prerequisites

Releases publish from `.github/workflows/release.yml`, never from a maintainer laptop. Configure
`juror-ai` on npm with a GitHub Actions trusted publisher for repository `Juror-AI/juror` and
workflow `release.yml`. Trusted publishing exchanges GitHub's short-lived OIDC identity and does
not require a long-lived `NPM_TOKEN` repository secret.

The workflow has no arbitrary version input. It starts only for a published GitHub release and
fails unless all of these identities match:

- the release tag is exactly `v` plus the version in `package.json`;
- the tag resolves to the checked-out commit; and
- the checked-out commit equals the release event commit.

## Procedure

1. Update `package.json` and `package-lock.json` to the release version in a reviewed pull
   request.
2. Merge with CI green.
3. Create a GitHub release whose tag is `v<package version>` and targets the intended `main`
   commit.
4. Publish the release. The release workflow validates, tests, builds, packs, attests, uploads,
   and publishes the exact tarball.
5. Confirm the npm package shows provenance and the GitHub release contains the npm tarball,
   Action source archive, CycloneDX SBOM, and `SHA256SUMS`.

Do not reuse a failed release tag for different source. Fix the cause, increment the package
version, and create a new tag and release.

## Generated evidence

- npm provenance and publish attestations link the package to its GitHub workflow and commit.
- GitHub build provenance covers the npm tarball and Action source archive.
- A GitHub SBOM attestation binds the CycloneDX document to the npm tarball.
- `SHA256SUMS` lets users compare downloaded release assets byte for byte.

The source archive is created with `git archive` from the verified release tag. The npm tarball
is created once from that same checkout and the exact file is passed to `npm publish`; it is not
rebuilt between attestation and publication.

## Consumer verification

Download and verify one release:

```bash
gh release download v1.3.3 --repo Juror-AI/juror --dir juror-release
cd juror-release
sha256sum --check SHA256SUMS
gh attestation verify juror-ai-1.3.3.tgz --repo Juror-AI/juror
npm audit signatures
```

`npm audit signatures` verifies registry signatures and provenance for installed dependencies;
run it from a project that installs the released `juror-ai` version. Provenance proves where an
artifact came from, not that it is vulnerability-free.

## Dependency pin maintenance

Dependabot checks npm packages and GitHub Actions weekly. Action references remain full commit
SHAs, while same-line release comments make updates reviewable. CI rejects any external Action
or README installation example that drifts back to a branch or tag reference.

Review dependency updates like code: inspect upstream release notes, confirm the commit belongs
to the documented release, and require CI before merge.
