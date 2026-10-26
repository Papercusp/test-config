---
rel_path: "git-sync/content-errors/fdb11c1fe40dfe7bc55f0db3e441bc9efff1a01384468438afcbdeaf0bdc3d5f.json"
updated_at: 1793046770197
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/shared-pg-lease.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 67 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/shared-pg-lease.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/shared-pg-lease.test.ts:67 [secret-assignment] repo…el (28 chars)","fixerRole":"content-fixer","contentHash":"72a3178c841717ad7c81091777ad477e4ca6aac45a1816a9c30b5cd39f91e1b0","detectorResultHash":"a50f5486be5a0a619bbe1547f83f0c92afe23887e7f12b4889d84acb40085df0"}]}
