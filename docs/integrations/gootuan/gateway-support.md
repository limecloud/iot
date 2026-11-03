# Gootuan gateway support review and software verification

[简体中文](gateway-support.zh-CN.md)

2026-11-03. Scope: local gateway software and its consumers. Gootuan still requires independent firmware, hardware and physical acceptance. These results do not declare a finished retail toy. [Machine evidence and source digests](gateway-verification.json).

## Implemented generic capabilities

| Capability | Current behavior | Reference |
| --- | --- | --- |
| Live business events | After complete ingest validation, project device/model/session, original event and body digest; notify only after commit; duplicates and history produce no new business projection | [Event contract](../../../contracts/device-events.en.md) |
| Staged multi-device plans | Creation issues zero commands; explicit start admits a whole stage atomically, then waits for its results before admitting the next | [Plan contract](../../../contracts/execution-plans.en.md) |
| Long-task completion | Submitted only proves input submission; plans additionally verify task, generation, step, session and original event digest | Formal plan contract |
| Recovery and reservations | Lost responses only query the original key; running plans recover as unknown without replay; started plans reserve devices until explicit release | Original command ledger and plan records |
| Persistence | First plan commit adopts snapshot v12; unused v10/v11 databases do not implicitly upgrade; corruption and late SQL failure never publish partial changes | Five Store test groups |
| Console action consumers | Both active remote workspaces support Schema 2 parameters, availability, model digests, risk confirmation, complete receipts and original-key recovery | [Website maintenance verification](https://github.com/limecloud/iotweb/blob/main/docs/06-咕团生态案例与接入.md) |

Plans are local-owner HTTP/CLI operations, limited to eight devices, sixteen steps and fifteen minutes; child commands retain their thirty-second maximum. Management expires_at follows the contract's canonical UTC spelling; device events retain original RFC3339 text and its digest. The cloud relay allowlist remains unchanged.

## Executed verification

| Check | Result | Scope |
| --- | --- | --- |
| Core events and plans | 19 passed, 0 failed | Deduplication, lexical times, barriers, task events, cancellation, capacity, reservations, tampering and restart |
| Gateway runtime | 55 passed, 0 failed | Includes five plan-store groups and existing runtime regression |
| HTTP/MQTT/SQLite | 3 passed, 0 failed | SSE/polling, commit failure, two-device barriers, long tasks, cancellation and gateway recovery |
| CLI failure recovery | 1 passed, 0 failed | Lost response, 404 and bad digest never add a POST; changed input under the original key is rejected locally |
| Build and Clippy | Passed | gateway/simulator/model-validator build; targeted core-plan and gateway Clippy |
| Frontend checks | 13 passed | Shared forms, receipts and original TUI boundaries; one synthetic-HTTP browser journey per built workspace passed |
| Website | Build passed; 30 passed, 12 environment skips | Four public pages at 390px/1440px, same-site downloads and provenance hashes; not deployed |

The CLI fixture initially encountered a temporary-directory alias and insufficient total timeout. Canonical fixture paths and explicit socket cleanup resolved these failures without changing private-directory protection or business assertions. The future-version fixture moved from 12 to 13 and still checks rejection without rewriting. Machine evidence records commands, initial failures and final source digests.

## Remaining product engineering

1. **Safe device motion:** atomic device generation fences, rejection of old commands/timelines, driver shutdown on lease expiry, watchdogs, obstacle sensing and physical stops. Prioritizing stop in a queue cannot prevent late older commands from restarting motion. Plan cancellation blocks future stages; it does not prove physical stopping.
2. **Synchronized performance:** current ready/online flags do not establish show readiness or clock quality. Measure clock offset, uncertainty, drift, preloading and output latency on multiple real units. Stage barriers do not synchronize beats.
3. **Product firmware:** the C SDK currently implements limited properties and single-integer events. S3 generic actions, structured events, motor/audio/camera drivers and concurrent operation remain work.
4. **Consumer onboarding:** bound-device CSR issuance does not implement physical-button challenges, ownership claiming/transfer or product provisioning.
5. **Product application and AI:** teams, sessions, roles, scoring, age policies, parent authorization, budgets and media policies belong to the product layer. Complete ASR/TTS, conversation and vision are not delivered.
6. **Long-term capacity:** 128 plans, 1024 management decisions, 4096 commands, 4096 deduplication identities and bounded event retention are not unlimited history. Archiving, retirement and reclamation require separate contracts; do not persist one command per control frame or beat.

No production IoT service, existing gateway database, Git commit/push or deployment was used. Software simulation retains `hardware=false`, `motion=false` and `beat_synchronization=false`.
