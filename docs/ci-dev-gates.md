# Dev checks

Pull requests and pushes to dev keep typecheck (including changed-file lint), quality/security, CodeQL and the existing path-scoped regression workflows. The broad unit and app E2E jobs in test.yml do not run for ordinary dev pull requests or pushes.

Broad coverage stays on main pull requests and pushes with its existing policies, on other previously supported non-dev branches, nightly at 01:23 UTC, and through workflow_dispatch. Nightly and on-demand runs use full unit coverage and enable app E2E. No test, assertion, branch protection, security gate or main merge requirement is removed.

A skipped job is not evidence that tests passed. Known-red full unit results remain visible on broad runs. Focused tests for the changed area still need to pass on dev.
