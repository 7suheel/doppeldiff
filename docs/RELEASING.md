# Releasing

Releases are published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a
version tag is created (pushing it, or publishing a GitHub release that creates it). It can also be run by hand:
**Actions** → **Release** → **Run workflow** → **Use workflow from** → **Tags** → the version tag. It refuses to run on
a branch, refuses a tag that does not match `package.json`, and refuses a version already on npm.

Authentication: the `NPM_TOKEN` secret if it exists, otherwise npm **trusted publishing** (OIDC). Both publish with
a provenance statement that links the package to the commit and workflow run that built it. The goal is trusted
publishing only: set it up below, then delete the secret.

## One-time setup: npm trusted publishing

The package must exist on npm first (v0.1.0 is published with a temporary `NPM_TOKEN`).

1. Sign in at [npmjs.com](https://www.npmjs.com) and open
   [npmjs.com/package/doppeldiff](https://www.npmjs.com/package/doppeldiff).
2. Click the **Settings** tab (you are asked for your second factor).
3. In the **Trusted Publisher** section, under **Select your publisher**, click **GitHub Actions**.
4. Fill in the form exactly (fields are case-sensitive, and npm does not check them when you save):
   - **Organization or user**: `7suheel`
   - **Repository**: `doppeldiff`
   - **Workflow filename**: `release.yml` (only the file name, not `.github/workflows/release.yml`)
   - **Environment name**: `npm` (the job runs in this GitHub environment)
   - **Allowed actions**: tick **`npm publish`**. Trusted publishers created after September 3, 2026 only allow
     `npm stage publish` by default, and the workflow runs `npm publish`.
5. Click the button that saves the trusted publisher.
6. Still in **Settings**, under **Publishing access**, select **Require two-factor authentication and disallow
   tokens**, then click **Update Package Settings**. This does not affect trusted publishing.
7. Remove the token:
   - GitHub: repository **Settings** → **Secrets and variables** → **Actions** → `NPM_TOKEN` → delete (trash icon)
     → **Yes, remove this secret**. If you created it under **Environments** → `npm` instead, delete it there.
   - npm: avatar menu → **Access Tokens** → find the granular token → **Delete** (or open it and click **Delete
     token**).

The next tag then publishes without any token. If it fails with `ENEEDAUTH` / "Unable to authenticate", one of the
fields in step 4 does not match exactly.

Optional hardening: on GitHub, **Settings** → **Environments** → **npm** → **Required reviewers** (a pushed tag then
waits for approval before publishing), and a tag ruleset for `v*` (**Settings** → **Rules** → **Rulesets** →
**New tag ruleset**) so only you can create release tags.

## Each release

1. Update `CHANGELOG.md` and the version (`npm version 0.2.0 --no-git-tag-version`).
2. Update the tag in `examples/workflows/*.yml`.
3. `npm run check && npm run build && npm run build:action`, commit, push, wait for CI.
4. Tag the commit CI checked and push the tag:
   ```bash
   git tag -a v0.2.0 -m "doppeldiff 0.2.0" && git push origin v0.2.0
   ```
   The workflow checks that the tag matches `package.json`, runs the full check, verifies `action/dist` and
   publishes.
5. Move the major tag for Action users: `git tag -f v0 v0.2.0 && git push -f origin v0`.
6. Create the GitHub release (and the Marketplace listing), below.

## GitHub release and Marketplace listing

The repository meets GitHub's Marketplace requirements: it is public, it has exactly one action metadata file at
the root (`action.yml`), the action's `name` (`doppeldiff behavioral diff`) is distinctive, and `branding` uses an
allowed icon (`git-pull-request`) and color (`purple`). Other files, including `.github/workflows/` and
`examples/workflows/`, are allowed.

Publishing to the Marketplace is done in the web UI when creating a release (a release created with the CLI or
API is not listed). Your account needs two-factor authentication.

1. Open the repository on GitHub and click `action.yml` in the file list. A banner offers to publish the action
   to the GitHub Marketplace; click **Draft a release**. (Or: **Releases** → **Draft a new release**.)
2. Under **Release Action**, tick **Publish this Action to the GitHub Marketplace**. The first time, the box is
   disabled until you click **accept the GitHub Marketplace Developer Agreement** and accept it.
3. Wait for the metadata check to show **Everything looks good!** If it reports that the name is taken, change
   `name:` in `action.yml`, commit, and release a new tag (the name is read from the tagged commit).
4. **Primary Category**: **Code quality**. **Another Category** (optional): **Testing**.
5. **Choose a tag**: select the existing tag (for example `v0.1.0`). Do not type a new one: a new tag would point
   at the current `main`, not at the commit npm published.
6. **Release title**: `v0.1.0`. In the description, click **Generate release notes** or paste the CHANGELOG entry.
7. Leave **Set as a pre-release** unticked and **Set as the latest release** ticked. Click **Publish release** and
   confirm with your second factor.
8. The listing appears at `https://github.com/marketplace/actions/doppeldiff-behavioral-diff`.
