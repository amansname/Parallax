# Deployment integrity

Parallax previews, verifies, and deploys one immutable site artifact built from
an exact Git commit. Source files in a mutable worktree are never the served or
deployed product.

## Candidate artifact

`npm run site:build` refuses a dirty worktree, reads the committed deployable
files through Git, and writes `.parallax-artifact/`. Its manifest records the
source commit, source tree, artifact ID, byte length, and SHA-256 hash of every
served file. `npm run site:verify` rejects a missing, extra, or changed byte.

All application modules, styles, and local assets are bound to the same artifact
ID. The stable root page fetches cache-busted deployment metadata before opening
that artifact. An already-open older application checks the same metadata and
returns to the stable root when a newer artifact is active.

## Preview and required checks

`npm run preview` serves only the verified committed artifact at
`http://127.0.0.1:8825/`. It refuses a dirty candidate and never selects another
port. The CI artifact job builds and uploads the exact pull-request head. Full
browser verification downloads that same artifact and fails if the browser
requests an application byte without the artifact ID or receipt headers.

## GitHub Pages

`.github/workflows/pages.yml` is the only authorized deployment path. It runs
only after `Parallax quality` succeeds for a push to `main`, refuses to deploy a
commit that is no longer the tip of `main`, rebuilds the exact successful commit,
and verifies the complete artifact before deployment. After deployment,
`npm run site:verify-live` waits for that artifact ID and compares every live
file byte-for-byte with its manifest.

GitHub Pages must be configured with **Build and deployment: GitHub Actions**.
The former branch/root Pages build must be disabled; otherwise it remains a
second ungoverned deployment director.

## Browser state boundary

Browser storage is not part of the site artifact and differs by origin. Shipped
Demo/default household records are rebuilt from current code on every boot. A
missing or empty store seeds those defaults. An unreadable, corrupt, or unsafe
saved store is preserved byte-for-byte while the current defaults remain
selectable in read-only recovery mode; browser state cannot disable the planner
or replace code-owned defaults.
