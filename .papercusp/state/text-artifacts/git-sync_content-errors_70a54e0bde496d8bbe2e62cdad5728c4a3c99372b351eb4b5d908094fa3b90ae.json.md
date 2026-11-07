---
rel_path: "git-sync/content-errors/70a54e0bde496d8bbe2e62cdad5728c4a3c99372b351eb4b5d908094fa3b90ae.json"
updated_at: 1794040489141
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/test-case-records.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 311 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/test-case-records.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/test-case-records.test.ts:311 [secret-assignment] synt…ue (22 chars)","fixerRole":"content-fixer","contentHash":"d8fde311a4e915cac0fc2e4ca8813f5c99cbdcfa53e7fcfaf80ecdd1612e9b16","detectorResultHash":"9894fe785bc3fc3afecc50f48f6c769c1ee1943ee16e14a6629eb19e0a70af38"}]}
