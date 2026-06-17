from __future__ import annotations

import importlib.util
import json
import resource
import sys
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path
from typing import Any


class _DiscardOutput:
    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        return None


_SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "next": next,
    "range": range,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"script result is not JSON serializable: {type(value).__name__}")


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "invalid worker arguments"}))
        return 2

    script_path = Path(sys.argv[1])
    function_name = sys.argv[2]
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise TypeError("script input must be a JSON object")

        spec = importlib.util.spec_from_file_location("_culina_skill_worker", script_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load script: {script_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.__dict__["__builtins__"] = _SAFE_BUILTINS
        function = getattr(module, function_name)
        discarded_output = _DiscardOutput()
        with redirect_stdout(discarded_output), redirect_stderr(discarded_output):
            result = _json_value(function(**payload))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
