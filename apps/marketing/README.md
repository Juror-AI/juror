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
the generated site out of search. Builds remain non-indexable unless all three production gates
are true: the origin is a final `https` custom domain, `CONTENT_RELEASE=approved`, and every
manifest record is marked `approved_*`. This makes a preview or partially edited route manifest
safe to deploy without competing with production in search.

After native editorial, technical, legal, and evidence reviews are recorded in the manifest,
use the production command:

```bash
SITE_ORIGIN=https://www.example.com CONTENT_RELEASE=approved npm run deploy
```

`npm run deploy` blocks on the release gate, static-route checks, and then invokes Workers Static
Assets deployment. `npm run deploy:dry-run` only validates the Wrangler deployment configuration;
it never marks content indexable. Do not deploy to Pages as a second public origin.
