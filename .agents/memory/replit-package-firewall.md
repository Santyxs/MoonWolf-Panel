---
name: Replit package firewall lockfiles
description: Environment-specific behavior when npm updates dependencies in this workspace.
---

When npm updates dependencies in this workspace, `package-lock.json` may record resolved tarball URLs from Replit's internal package firewall rather than the public npm registry.

**Why:** This occurred during a normal `npm audit fix` and is expected package-manager output in this environment, not a source-code change or a reason to hand-edit the lockfile.

**How to apply:** Preserve the generated lockfile URLs unless the package installation itself fails or the project explicitly requires a different registry.