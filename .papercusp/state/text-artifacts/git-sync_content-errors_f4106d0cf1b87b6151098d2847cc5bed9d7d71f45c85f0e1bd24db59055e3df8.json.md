---
rel_path: "git-sync/content-errors/f4106d0cf1b87b6151098d2847cc5bed9d7d71f45c85f0e1bd24db59055e3df8.json"
updated_at: 1793942563936
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/node-test-ledger.test.ts","detectorKey":"quarantined-importer","error":"imports './node-test-ledger.ts' → 'src/node-test-ledger.ts', which is EXCLUDED from this commit (held by su-60a9de95-dd40-4807-8e4b-107dcd49c416 for EI-28013689712855473 — PreToolUse:apply_patch). Committing this file alone could leave HEAD without the dependency changes its import needs — holding it back until 'src/node-test-ledger.ts' is resolved.","fixerRole":"content-fixer","excludedRoot":"src/node-test-ledger.ts","excludedRootReason":"held by su-60a9de95-dd40-4807-8e4b-107dcd49c416 for EI-28013689712855473 — PreToolUse:apply_patch"}]}
