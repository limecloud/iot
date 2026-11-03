# Gootuan light-and-touch example

[简体中文](README.zh-CN.md) | [Integration guide](../../integrations/gootuan/README.md)

This example consumes the current formal contracts; it does not define a new contract or a complete robot model. The model exposes two ordinary light properties and one bounded synthetic touch event. The rule turns on two virtual lights after a touch. Both endpoints deliberately reuse the existing harness IDs `device-button` and `device-lamp` while binding this same model.

| File | Role |
| --- | --- |
| [model.json](model.json) | Schema 1 candidate, no actions, motors, camera or voice |
| [rule.json](rule.json) | Current event/set rule, two independently accepted steps |
| [event.json](event.json) | Rules simulation event; the integration harness supplies live event ID/time |
| [verify.mjs](verify.mjs) | Formal-schema/shared-Rust validation, optional isolated real software journey |

```sh
npm ci
cargo build --locked -p limeiot-model-validator -p limeiot-gateway -p limeiot-simulator
node "docs/examples/gootuan/verify.mjs"
```

For HTTP/MQTT/SQLite execution, provide the local Broker as described in [local development](../../../deploy/dev/README.md):

```sh
python3 "tools/bootstrap-broker.py"
node "docs/examples/gootuan/verify.mjs" --integration
```

The default check has no network effects. `--integration` intentionally deploys and executes the rule only in its new isolated local test stack, verifies zero effects during preview and both virtual results after deployment, checks duplicate/historical events do not trigger another run, then stops the rule. The example uses zero cooldown so a cooldown cannot mask unintended replay. Artifacts stay under ignored `.dev/gootuan-example-*`; credentials are not in the result record.

Do not submit these fictitious IDs to a production space or treat the model as a signed release. The rule is not a workflow waiting for physical completion or a synchronization clock. It does not implement a toy's motion, safety stop, image understanding, voice, dance or chorus. Stopping future rule triggers does not cancel accepted commands. See the [case verification](../../integrations/gootuan/verification.json) for actual execution scope.
