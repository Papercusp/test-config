---
rel_path: "git-sync/content-errors/f7ddb495b2c0263cb29c4ae25e7e2cf8c62f84c8be55f6139662aa631e42538f.json"
updated_at: 1794029524531
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/test-case-records.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 255 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/test-case-records.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/test-case-records.test.ts:255 [secret-assignment] synt…ue (22 chars)","fixerRole":"content-fixer","contentHash":"e462bf95d408d431bd965ce372fcb453ed5643c5da322df03d2a5ea9583468d6","detectorResultHash":"79a14959f13bb4b6350dad8e51aaa2452a93d3cf47e57c22a72310f3928482dd"}]}
