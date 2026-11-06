---
rel_path: "git-sync/content-errors/cb026834e0a9ac35e820ab19a0c11481f556b7e9a2fca0a79f8873dd8d165db7.json"
updated_at: 1793962355051
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/admin-test-runs-reporter.test.ts","detectorKey":"quarantined-importer","error":"imports './admin-test-runs-reporter' → 'src/admin-test-runs-reporter.ts', which is EXCLUDED from this commit (held by su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49 for WI-6554700010044325 — PreToolUse:apply_patch). Committing this file alone could leave HEAD without the dependency changes its import needs — holding it back until 'src/admin-test-runs-reporter.ts' is resolved.","fixerRole":"content-fixer","excludedRoot":"src/admin-test-runs-reporter.ts","excludedRootReason":"held by su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49 for WI-6554700010044325 — PreToolUse:apply_patch"}]}
