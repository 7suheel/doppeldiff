# Releasing

[`release.yml`](../.github/workflows/release.yml) publishes to npm when a version tag is created: by pushing it, or
by publishing a GitHub release that creates it. It can also be run by hand on an existing tag: **Actions** →
**Release** → **Run workflow** → **Use workflow from** → **Tags** → the tag.

It authenticates with npm **trusted publishing** (OIDC) only: no npm token exists, and the package's publishing
access is set to "Require two-factor authentication and disallow tokens". npm attaches a provenance statement that
links each version to the commit and workflow run that built it.

Before publishing, the workflow refuses to run on a branch, refuses a tag that does not match `package.json` or a
version already on npm, runs the full check, verifies `action/dist`, and fails if npm would rewrite `package.json`
on publish.

## npm trusted publisher (configured)

On [npmjs.com/package/doppeldiff](https://www.npmjs.com/package/doppeldiff) → **Settings** → **Trusted Publisher**:
GitHub Actions, organization or user `7suheel`, repository `doppeldiff`, workflow filename `release.yml`, environment
`npm`, allowed action `npm publish`. If you rename the workflow file or the environment, update this entry, or the
publish fails with `ENEEDAUTH` / "Unable to authenticate".

## Each release

1. On `main`: update `CHANGELOG.md`, the version in `package.json` and `package-lock.json`
   (`npm version 0.2.0 --no-git-tag-version`) and the tag in `examples/workflows/*.yml`; run
   `npm run check && npm run build && npm run build:action`; commit and push; wait until CI is green.
2. Create the release and its tag from the website (no terminal needed):
   1. **Releases** → **Draft a new release** (or click `action.yml` → **Draft a release**).
   2. **Choose a tag** → type `v0.2.0` → **Create new tag: v0.2.0 on publish**. **Target**: `main`. Check that
      `main`'s latest commit is the one CI checked.
   3. Tick **Publish this Action to the GitHub Marketplace** (categories: **Code quality**, optionally **Testing**)
      and wait for **Everything looks good!**
   4. **Release title** `v0.2.0` → **Generate release notes** (or paste the CHANGELOG entry) → **Publish release**,
      and confirm with your second factor.
3. Publishing the release creates the tag, which starts **Actions** → **Release**. When it is green, the version is
   on npm. If it fails for a transient reason, open the run and click **Re-run all jobs** (same tag, same commit).

With a terminal, step 2 can instead be `git tag -a v0.2.0 -m "doppeldiff 0.2.0" && git push origin v0.2.0`,
followed by creating the release for the existing tag.

Optional: move a major tag for Action users (`git tag -f v0 v0.2.0 && git push -f origin v0`, terminal only).

## Marketplace requirements

The repository meets GitHub's Marketplace requirements: it is public, it has exactly one action metadata file at
the root (`action.yml`), the action's `name` (`doppeldiff behavioral diff`) is distinctive, and `branding` uses an
allowed icon (`git-pull-request`) and color (`purple`). Other files, including `.github/workflows/` and
`examples/workflows/`, are allowed. Listing happens only through the web UI when publishing a release (a release
created with the CLI or API is not listed), and needs two-factor authentication and the accepted Marketplace
Developer Agreement. The listing is at `https://github.com/marketplace/actions/doppeldiff-behavioral-diff`.

## History

v0.1.0 was the first publish. npm only accepts a trusted publisher for a package that already exists, so 0.1.0 was
staged with a temporary granular token (`npm stage publish`) and approved on npmjs.com with 2FA. That staging
created the `0.0.0-stage` placeholder version. The token and the staging workflow have since been removed.
