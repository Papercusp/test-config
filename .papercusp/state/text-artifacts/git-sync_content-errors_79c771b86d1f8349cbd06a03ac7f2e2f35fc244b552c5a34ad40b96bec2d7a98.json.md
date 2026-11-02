---
rel_path: "git-sync/content-errors/79c771b86d1f8349cbd06a03ac7f2e2f35fc244b552c5a34ad40b96bec2d7a98.json"
updated_at: 1793600895643
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/executed-inputs-capture.test.ts","detectorKey":"quarantined-importer","error":"imports './executed-inputs-capture' → 'src/executed-inputs-capture.ts', which is EXCLUDED from this commit (held by su-0dcd3a3c-a45f-482b-a8cd-e957407353f9 for WI-6554700010022070 — PreToolUse:apply_patch). Committing this file alone could leave HEAD without the dependency changes its import needs — holding it back until 'src/executed-inputs-capture.ts' is resolved.","fixerRole":"content-fixer","excludedRoot":"src/executed-inputs-capture.ts","excludedRootReason":"held by su-0dcd3a3c-a45f-482b-a8cd-e957407353f9 for WI-6554700010022070 — PreToolUse:apply_patch"}]}
