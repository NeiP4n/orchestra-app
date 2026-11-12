# Dev checks

Measured recent job runtimes, excluding runner queue: full typecheck239s, CodeQL SAST461s, Effect lint45s, Klinch focused Linux48s and Windows217s. A3s quality aggregator only starts after its dependencies. Full typecheck, CodeQL and OS-focused suites cannot honestly be called a60-second dev gate.

Ordinary dev PR/push gates now use dev quick checks (whitespace, conflict markers, removed-credential fingerprints and a blocking Gitleaks scan of added diff lines; no package dependency installation) with a one-minute execution timeout. The other quality/security jobs also move off ordinary dev runs; only this clearly named quick job stays. This is not TypeScript checking and is not presented as a test pass. Runner queue, checkout and network delays cannot be guaranteed under60s.

Full typecheck, CodeQL, existing area regression suites, broad unit and app E2E remain on non-dev branches/main PRs, nightly01:23UTC and workflow_dispatch. No assertion is deleted or skipped inside a suite. Main test logic and protection settings remain unchanged. Nightly only activates after the workflow is present on default branch main; until then dispatch can run the dev workflow.

Protection reads returned404, so existing required names could not be verified. If configured as required on dev, the owner must remove or replace typecheck, CodeQL, CodeQL SAST, unit (linux), unit (windows), e2e (linux), e2e (windows), and focused suite names such as Klinch catalog discovery (windows-latest). No protection setting was edited.

The dev quick job scans added lines only and fails on a secret finding. Full-history scanning remains a clearly labeled advisory on broad runs; old leak baseline never makes a new diff green.
