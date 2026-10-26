---
rel_path: "git-sync/content-errors/d44651f9f2d1bacc2ce55393b0816bc9f95a44f6900d2f968a98ce6f993ece7b.json"
updated_at: 1793046769089
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/shared-pg-lease.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 66 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/shared-pg-lease.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/shared-pg-lease.test.ts:66 [secret-assignment] repo…el (28 chars)","fixerRole":"content-fixer","contentHash":"f3e677f2e60607496b68946d101ef4ff096dcfadca4e6726d47dfac8400d9a2b","detectorResultHash":"bb62da6463d13222837fef0654a7775b4403a8c6f4cf632c06b826f54861ff1d"}]}
