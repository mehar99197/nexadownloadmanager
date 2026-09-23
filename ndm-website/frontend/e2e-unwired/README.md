# Unwired specs

Recovered from the server (commit 5e8d3ce) together with the features they
test — `CookieConsent.jsx` / `ConsentContext.jsx` and the download-integrity
check — none of which is wired into the site yet. They import
`e2e/support/stub.js`, which was never recovered, so inside `e2e/` they stop
Playwright from running any spec at all.

Kept here, outside `testDir`, so whoever wires the features up starts from
them: write the stub helper, move the spec back into `e2e/`, make it pass.
