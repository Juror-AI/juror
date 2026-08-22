import { defineConfig } from 'astro/config';

const site = (process.env.SITE_ORIGIN || 'https://juror.example').replace(/\/$/, '');

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  publicDir: './public',
  build: {
    format: 'directory',
  },
});
