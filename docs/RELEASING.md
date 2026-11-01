# Releasing

Releases are published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a
version tag is pushed. The package gets an npm **provenance** statement (it links the published tarball to the
commit and workflow run that built it).

## One-time setup

1. **First publish.** npm can only attach a trusted publisher to a package that exists. For the very first
   version, either publish manually from a clean checkout of the tag (`npm ci && npm run build && npm publish
--access public`, with 2FA), or add a short-lived granular `NPM_TOKEN` secret to the `npm` environment of this
   repository and push the tag.
2. **Trusted publishing.** On npmjs.com, package settings → _Trusted publishing_ → GitHub Actions:
   organization/user `7suheel`, repository `doppeldiff`, workflow `release.yml`, environment `npm`.
3. Delete the `NPM_TOKEN` secret (if you created one), and in the package settings require 2FA and disallow
   tokens for publishing. From then on, only this workflow can publish.
4. Optional: in the repository settings, protect the `npm` environment (required reviewers), so a pushed tag
   waits for approval before publishing.

## Each release

1. Update `CHANGELOG.md` and the version in `package.json` (`npm version 0.2.0 --no-git-tag-version`).
2. Update the tag in `examples/workflows/*.yml` and the README.
3. `npm run check && npm run build && npm run build:action`, commit, push, wait for CI.
4. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. The workflow checks that the tag matches
   `package.json`, runs the full check, verifies `action/dist`, and publishes.
5. Move the major tag for Action users: `git tag -f v0 v0.2.0 && git push -f origin v0`.
6. Create a GitHub release from the tag with the changelog entry.

The GitHub Action does not need npm: workflows reference the tag (`7suheel/doppeldiff@v0.1.0`) and the action runs
its committed `action/dist` bundle.
