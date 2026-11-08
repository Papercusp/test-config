---
rel_path: "git-sync/content-errors/f79b3df44c0cd41bd59c02539ba58d4f1196aaed4f8ebf91cba021442c7807ae.json"
updated_at: 1794112086959
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/test-case-records.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 429 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/test-case-records.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/test-case-records.test.ts:429 [secret-assignment] synt…ue (22 chars)","fixerRole":"content-fixer","contentHash":"36ad33930216b391f937db7ef5e410708c9c2ce2ef3b25239bf253937320d0bc","detectorResultHash":"db3a686959427dec8d21cbe65a37eb0b92d3ddd578aa1184d854be7bdb99fa97"}]}
