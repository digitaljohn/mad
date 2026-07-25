# Security

mad ships signed self-updates to third parties, so security reports get
priority over everything else.

## Reporting a vulnerability

Please **do not put details in a public issue.**

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/digitaljohn/mad/security/advisories/new).

If that page is unavailable, open a public issue saying only *"security report,
please open a private channel"* — no specifics — and you'll be invited to a
private advisory. Never the details in the open.

You should hear back within a few days. Fixes ship as a patch release through
the built-in updater, which is the fastest path to every installed copy.

## Scope worth knowing about

- Updates are signed with a minisign key; the public half is baked into the
  app and verified before anything installs. A compromised GitHub release
  alone cannot ship code to users.
- The webview runs with a strict CSP, no remote content, and every filesystem
  command is scoped to folders the user granted through native dialogs.
- Anything that lets a crafted markdown file escape those boundaries —
  script execution, out-of-workspace reads or writes, updater bypass — is
  exactly what this file is for.
