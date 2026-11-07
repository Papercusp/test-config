---
rel_path: "git-sync/content-errors/cc6ae527e6e793b3087363a678322812e2b9ab6cc3d8c6fe293666b7f43dc47a.json"
updated_at: 1794041814018
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp/libs/test-config","files":[{"scope":"superproject","file":"src/test-case-records.test.ts","detectorKey":"secrets","error":"credential-shaped content would enter git history (1 finding(s) at line 368 [secret-assignment]). This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant (the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: pot_git:secrets_exemptions { action:'add', path:'src/test-case-records.test.ts', reason:'<why this is a false positive>' }. Detail: refusing to publish — 1 secret(s): src/test-case-records.test.ts:368 [secret-assignment] synt…ue (22 chars)","fixerRole":"content-fixer","contentHash":"62cc2dbf2476e927e73a67258b14c6a5cedd471129c9052f1e226bc8190c113d","detectorResultHash":"72f3a0f4d3ffc4c7f3be7a9502a48bc3a632ee390672340db7df43c667bf691f"}]}
