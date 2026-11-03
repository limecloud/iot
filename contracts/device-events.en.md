# Accepted live device event projection

[简体中文](device-events.md) | [Projection schema](device-event.schema.json)

Local HTTP polling and SSE share the existing durable channel: `GET /api/v1/spaces/{space}/events?after={cursor}` and `GET /api/v1/spaces/{space}/events/stream`. SSE resumes with `Last-Event-ID`, using existing local authorization and session revocation. This adds neither control-plane forwarding nor permission to subscribe directly to device MQTT.

## Implemented payload

The channel envelope is `{event_id,type,space_id,payload}`. Its outer `event_id` is a gateway database cursor, distinct from the device's business event ID. A new live `device.event` has `payload={occurred_at,data}`: the outer timestamp comes from the existing Store, and `payload.data` is the strict [DeviceEvent](../gateway/crates/core/src/device_events.rs) projection:

| Field | Meaning |
| --- | --- |
| device_id, model_revision | Source checked against current authority and the exact bound model |
| boot_id, session_id, message_id, seq | Accepted boot/session/message/sequence context; these are not control credentials |
| event_id, path | Device business event ID and model event path |
| occurred_at, received_at | Original observation timestamp text, preserving its offset and fraction, and gateway receive time used by core validation |
| body_digest | RFC 8785 JCS SHA-256 of the original event body, matching the durable `device:event_id` deduplication digest; extra original fields are not included as readable content |
| data | Business data validated against that exact model's event schema |

A projection requires successful full ingestion, a new business event, `historical=false`, and the existing live window: no more than five seconds old or two seconds ahead at receipt. The durable key remains device plus `event_id`; a new envelope, reconnect or gateway restart cannot project the same business event again. A reused key with different content remains rejected.

Failed model, session, sequence, topic, schema or time checks produce no business projection. Valid historical, stale or duplicate messages may still produce an existing-channel notification with `payload.data=null`; consumers must ignore it as a new business event. Extra original body fields, raw envelopes and transport credentials are not persisted as event projections. Product data policies still apply to business `data`; model authors must not define credentials as business data.

## Commit, recovery and limits

Original deduplication/rule effects and the projection are committed in the same existing Store transaction before publishing memory changes or notifying SSE. Failed commits expose no readable projection. Committed records remain readable by cursor after restart. Existing pages of 100, bounded retention of approximately 5,000 records, `event_gap` / SSE `gap` and session expiry semantics remain unchanged. After a gap, refresh the current state of the relevant object; this bounded channel is neither a complete history nor a high-frequency telemetry store.

The projection proves acceptance of the source and schema-conforming data. It does not independently prove a physical effect, data truth or long-task completion. A product must still bind its original task, generation, action and required observations. A friendly event path cannot establish a stop or completed performance. Non-event message output retains its existing shape.

## Verification

```sh
cargo test --locked -p limeiot-core --test device_events
cargo build --locked -p limeiot-gateway -p limeiot-simulator
node --test "tests/device-events.test.mjs"
```

Core cases cover duplicates, recovery, historical/stale inputs, wrong models/sessions/sequences, invalid schemas, future time and conflicting business IDs. The isolated integration covers real HTTP/MQTT/SQLite, SSE/poll consistency, failed commits, strict fields, restart reads and no replay. Software simulation does not establish physical toy or sensor acceptance.
