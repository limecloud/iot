"""从正式物模型生成当前 MCU 布尔/整数绑定；拒绝未实现的模型类型。"""
from pathlib import Path
import argparse
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[2]
SAFE = 2**53 - 1


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise ValueError("invalid binding identifier")
    return value


def no_floats(value):
    if isinstance(value, float):
        raise ValueError("MCU 0.1 binding generator requires integer JSON numbers")
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > SAFE:
        raise ValueError("unsafe JSON integer")
    if isinstance(value, dict):
        for key, item in value.items():
            if not key.isascii():
                raise ValueError("MCU 0.1 model keys must be ASCII")
            no_floats(item)
    elif isinstance(value, list):
        for item in value:
            no_floats(item)


def bounds(schema):
    low, high = schema.get("minimum", -SAFE), schema.get("maximum", SAFE)
    if type(low) is not int or type(high) is not int or not -SAFE <= low <= high <= SAFE:
        raise ValueError("invalid integer bounds")
    return low, high


def generate(name):
    model = json.loads((ROOT / "contracts/models" / f"{name}.json").read_text())
    no_floats(model)
    if model["schema_version"] != 1:
        raise ValueError("unsupported model version")
    # 此受限模型只含安全整数；不把 Python JSON 编码器宣称为通用 RFC8785 实现。
    canonical = json.dumps(model, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    revision = "sha256:" + hashlib.sha256(canonical).hexdigest()
    properties, events, paths = [], [], set()
    quote = lambda value: json.dumps(value, ensure_ascii=True)
    for service in model["services"]:
        service_id = identifier(service["id"])
        if service["actions"]:
            raise ValueError("MCU action bindings are not implemented")
        for item in service["properties"]:
            path = service_id + "." + identifier(item["id"])
            if path in paths or len(path) >= 97:
                raise ValueError("duplicate or overlong binding path")
            paths.add(path)
            kind = item["schema"]["type"]
            if kind not in ("boolean", "integer"):
                raise ValueError("unsupported MCU property type")
            low, high = bounds(item["schema"]) if kind == "integer" else (0, 0)
            properties.append("    {" + f'{quote(path)}, LI_{kind.upper()}, {str("write" in item["access"]).lower()}, INT64_C({low}), INT64_C({high})' + "},")
        for item in service["events"]:
            path = service_id + "." + identifier(item["id"])
            schema = item["schema"]
            if schema["type"] != "object" or len(schema.get("properties", {})) != 1 or schema.get("additionalProperties") is not False:
                raise ValueError("MCU 0.1 supports single integer field events")
            field, value = next(iter(schema["properties"].items()))
            if schema["required"] != [field] or value["type"] != "integer":
                raise ValueError("unsupported MCU event shape")
            low, high = bounds(value)
            if path in paths or len(path) >= 97:
                raise ValueError("duplicate or overlong event path")
            paths.add(path)
            events.append("    {" + f"{quote(path)}, {quote(identifier(field))}, INT64_C({low}), INT64_C({high})" + "},")
    if len(properties) > 16 or len(events) > 16:
        raise ValueError("MCU binding capacity exceeded")
    prefix = "LI_" + name.upper()
    lines = ["/* 由 firmware/tools/generate-bindings.py 生成，请修改 contracts/models 中的事实源。 */", f"#ifndef {prefix}_BINDINGS_H", f"#define {prefix}_BINDINGS_H", '#include "limeiot.h"', f'#define {prefix}_REVISION "{revision}"']
    if properties:
        lines += [f"static const li_property_t {prefix}_PROPERTIES[] = {{", *properties, "};"]
    if events:
        lines += [f"static const li_event_t {prefix}_EVENTS[] = {{", *events, "};"]
    lines += [f"#define {prefix}_PROPERTY_COUNT {len(properties)}", f"#define {prefix}_EVENT_COUNT {len(events)}", "#endif", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for name in ("lamp", "button"):
        target = ROOT / "firmware/generated" / f"{name}.h"
        content = generate(name)
        if args.check:
            if not target.exists() or target.read_text() != content:
                raise SystemExit(f"stale binding: {target.relative_to(ROOT)}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
    print("firmware model bindings: checked" if args.check else "firmware model bindings: generated")
