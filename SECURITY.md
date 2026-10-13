# Security policy

## Reporting a vulnerability

Please **do not describe a vulnerability in a public issue**.

Report it privately through the project's GitHub repository, using **Security → Report a vulnerability** (GitHub private security advisories). If private reporting is not enabled there, open an issue that says only that you have a security report and how you can be contacted, without technical details, and the maintainer will arrange a private channel.

> **Status:** Voltloom's own GitHub repository has not been created yet, so there is no public reporting channel today. This section will be updated with the repository link when it is published. Nothing in this project contacts or reports to any remote.

When you report, please include: the affected version or commit, what you did, what you expected, what happened, and (if you can) a minimal reproduction. You can expect an acknowledgement; this is a one-person portfolio project, so there is no guaranteed response time.

## What is in scope

- The browser app (`index.html`, `src/`), including project loading, share links (`?p=`), the Content-Security-Policy and handling of untrusted project data.
- The local compile service (`compiler/`) and its source checks.
- The build and test configuration, if it exposes files that should not be served.

## Important properties and limits (please read before reporting)

- **The compile service is not a sandbox.** It compiles C source with Emscripten on the machine that runs it. It binds to `127.0.0.1`, accepts requests only from an allow-list of browser origins, limits source size and concurrency, and refuses a list of dangerous preprocessor and include constructs, but a determined local user could still abuse it. Run it only on a machine you control, never expose it to a network, and never run it as a privileged user. See `docs/deployment.md`.
- User programs (Python and C) run inside Web Workers in the visitor's browser; Stop terminates the worker. They have no access to the host beyond what the browser allows.
- Projects and share links are treated as untrusted input: they are validated before use and never executed as markup.
- The page loads the Monaco editor and fonts from third-party CDNs (listed in `THIRD_PARTY_NOTICES.md`); a compromise of those providers is outside this project's control.

## Supported versions

Only the latest commit of the main branch is maintained.
