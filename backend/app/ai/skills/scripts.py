from __future__ import annotations

import importlib.util
import json
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import Any


class SkillScriptRuntime:
    def __init__(self, skill_dir: Path | None, script_files: list[str]) -> None:
        self.skill_dir = skill_dir
        self.script_files = list(script_files)
        self._modules: list[ModuleType] | None = None
        self._functions: dict[str, Any] | None = None

    def describe(self) -> list[dict[str, Any]]:
        return [
            {"file": relative_path, "functions": functions}
            for relative_path, functions in self._function_names_by_file().items()
        ]

    def has_function(self, name: str) -> bool:
        return name in self._load_functions()

    def call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        functions = self._load_functions()
        try:
            function = functions[name]
        except KeyError as exc:
            available = ", ".join(sorted(functions))
            raise KeyError(f"Skill script function {name!r} is not available; available functions: {available}") from exc
        result = function(*args, **kwargs)
        normalized = self._normalize_json_value(result)
        json.dumps(normalized, ensure_ascii=False)
        return normalized

    def call_optional(self, name: str, *args: Any, **kwargs: Any) -> Any | None:
        if not self.has_function(name):
            return None
        return self.call(name, *args, **kwargs)

    def _function_names_by_file(self) -> dict[str, list[str]]:
        modules = self._load_modules()
        by_file: dict[str, list[str]] = {}
        for module, relative_path in zip(modules, self.script_files, strict=False):
            names = [
                name
                for name, value in vars(module).items()
                if callable(value) and not name.startswith("_") and getattr(value, "__module__", None) == module.__name__
            ]
            by_file[relative_path] = sorted(names)
        return by_file

    def _load_functions(self) -> dict[str, Any]:
        if self._functions is not None:
            return self._functions
        functions: dict[str, Any] = {}
        for module, relative_path in zip(self._load_modules(), self.script_files, strict=False):
            for name, value in vars(module).items():
                if not callable(value) or name.startswith("_") or getattr(value, "__module__", None) != module.__name__:
                    continue
                functions.setdefault(name, value)
                functions[f"{Path(relative_path).stem}.{name}"] = value
        self._functions = functions
        return functions

    def _load_modules(self) -> list[ModuleType]:
        if self._modules is not None:
            return self._modules
        modules: list[ModuleType] = []
        if self.skill_dir is None:
            self._modules = modules
            return modules
        for index, relative_path in enumerate(self.script_files):
            path = self.skill_dir / relative_path
            module_name = f"_culina_skill_script_{self.skill_dir.name}_{index}_{path.stem}".replace("-", "_")
            spec = importlib.util.spec_from_file_location(module_name, path)
            if spec is None or spec.loader is None:
                raise ValueError(f"Cannot load skill script: {relative_path}")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            modules.append(module)
        self._modules = modules
        return modules

    def _normalize_json_value(self, value: Any) -> Any:
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, dict):
            return {str(key): self._normalize_json_value(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._normalize_json_value(item) for item in value]
        if isinstance(value, tuple):
            return [self._normalize_json_value(item) for item in value]
        return value
