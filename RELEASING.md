# Releasing Bek

Bek ships as container images for the `api`, `web`, `worker`, and `migrate`
targets (one multi-stage [`Dockerfile`](./Dockerfile)), published to GitHub
Container Registry (GHCR) by the [`Release` workflow](./.github/workflows/release.yml).

## Versioning

Bek uses semantic versioning once public releases begin. Tags are `vMAJOR.MINOR.PATCH`
(for example `v0.1.0`). Pre-1.0, minor versions may include breaking changes.

## Pre-release checklist

Run from a clean checkout of the commit you intend to tag:

- [ ] Working tree is clean (`git status` shows nothing to commit).
- [ ] `pnpm install --frozen-lockfile` succeeds (lockfile is up to date).
- [ ] `pnpm check` is green (format, lint, typecheck, test, build, e2e, smoke).
- [ ] `pnpm preflight --mode self_hosted` reports no failures for the target config.
- [ ] `CHANGELOG.md` has an entry for the new version (move items out of
      `Unreleased`).
- [ ] Version bumped where applicable and the `docs/` claims still match reality
      (cross-check `docs/commercial/do-not-claim.md`).
- [ ] Docker images build locally for every target (optional but recommended):
      `for t in api web worker migrate; do docker build --target $t -t bek-$t:rc .; done`
- [ ] `docker compose config -q` validates and `docker compose up` brings the
      stack healthy (see [Docker Compose self-hosting](./docs/self-host/docker-compose.md)).

## Cutting the release

1. Tag the commit and push the tag:
   ```bash
   git tag -a v0.1.0 -m "Bek v0.1.0"
   git push origin v0.1.0
   ```
2. The `Release` workflow runs automatically on the `v*.*.*` tag (or via
   `workflow_dispatch` with an existing tag). It:
   - **validates** the tag (`pnpm check` equivalents), then
   - **builds and pushes** the `api`, `web`, `worker`, and `migrate` images to
     `ghcr.io/<owner>/bek-<target>` with BuildKit-generated SBOMs, max-mode
     provenance, and build-provenance attestations.
3. Confirm the images appear under the repository's GHCR packages and that the
   attestations are attached.

## Post-release

- [ ] Smoke the published images with the Compose stack pointed at the tagged
      tags rather than a local build.
- [ ] Announce per the `docs/commercial/` guidance, honoring the
      [do-not-claim list](./docs/commercial/do-not-claim.md).
- [ ] Open the next `Unreleased` section in `CHANGELOG.md`.

## Rollback

Images are immutable per tag. To roll back, redeploy the previous tag's images;
to revert code, cut a new patch release from the prior good commit. Database
migrations are forward-only — review `packages/db/drizzle` before releasing a
migration and have a restore plan for the Postgres volume.
