# Publishing

`@pulgueta/wompi-convex` is released from the monorepo by the changesets
GitHub Action, never by hand.

1. Add a changeset with your change: `pnpm changeset` (from the repo root).
2. Merge to `main`. The Action opens (or updates) the "chore(release):
   version packages" pull request.
3. Merge that pull request. The Action runs `pnpm release`
   (`turbo build && changeset publish`) and publishes to npm.

## Do not `npm publish` / `npm pack`

This package depends on `@pulgueta/wompi` with the `workspace:^` protocol.
Only pnpm rewrites that specifier to a real version range when it packs the
tarball. A tarball produced with `npm publish` or `npm pack` still contains
`workspace:^`, and every `npm install` of that version fails with
`EUNSUPPORTEDPROTOCOL` — this happened with `0.2.0`.

CI packs both publishable packages with `pnpm pack` and fails when a manifest
still contains `workspace:`. To sanity-check a build locally:

```sh
pnpm --filter ./packages/convex-component pack --pack-destination /tmp/packs
tar -xOf /tmp/packs/pulgueta-wompi-convex-*.tgz package/package.json | grep -n '"@pulgueta/wompi"'
```

The line must show a version range (for example `"^3.3.0"`), not `workspace:^`.

`build` always removes `dist` and the incremental `tsbuildinfo` first, so a
stale local build can never leak missing declaration files into a release.
