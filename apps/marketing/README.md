# Juror marketing site

This is the isolated static Astro application for Juror's public marketing and documentation
surface. It reads the committed route manifest in `../../docs/seo-route-manifest.csv` and
generates every declared locale route at build time.

## Local work

```bash
npm install
npm run dev
npm test
```

The default `SITE_ORIGIN` is the reserved `https://juror.example`, which intentionally keeps
local and preview builds out of search. The production launch records are marked
`approved_launch`; an indexable build still requires the final custom-domain origin and
`CONTENT_RELEASE=approved`. This keeps non-production deployments from competing with the
public site in search.

Use the production command for the indexable `juror.dev` release:

```bash
SITE_ORIGIN=https://juror.dev CONTENT_RELEASE=approved npm run deploy
```

`npm run deploy` blocks on the release gate, static-route checks, and then invokes Workers Static
Assets deployment. `npm run deploy:dry-run` only validates the Wrangler deployment configuration;
it never marks content indexable. Do not deploy to Pages as a second public origin.
