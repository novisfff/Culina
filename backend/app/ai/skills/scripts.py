from __future__ import annotations

import ast
import json
import subprocess
import sys
import time
import typing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.ai.skills.base import SkillContext
from app.ai.tools.base import ToolContext, ToolDefinition, ToolResult
from app.ai.tools.validation import validate_json_value


_ALLOWED_IMPORT_ROOTS = {
    "__future__",
    "collections",
    "datetime",
    "decimal",
    "functools",
    "itertools",
    "math",
    "re",
    "statistics",
}
_FORBIDDEN_CALLS = {"__import__", "compile", "eval", "exec", "input", "open"}
_DEFAULT_TIMEOUT_SECONDS = 2.0
_MAX_INPUT_BYTES = 256 * 1024
_MAX_OUTPUT_BYTES = 1024 * 1024


@dataclass(frozen=True)
class SkillScriptFunction:
    tool_name: str
    function_name: str
    script_path: Path
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]


class SkillScriptCatalog:
    def __init__(self, skill_dir: Path, script_files: list[str]) -> None:
        self.skill_dir = skill_dir.resolve()
        self._functions: dict[str, SkillScriptFunction] = {}
        for script_file in script_files:
            self._load_script(script_file)

    def functions(self) -> list[SkillScriptFunction]:
        return list(self._functions.values())

    def has(self, tool_name: str) -> bool:
        return tool_name in self._functions

    def get(self, tool_name: str) -> SkillScriptFunction:
        try:
            return self._functions[tool_name]
        except KeyError as exc:
            raise ValueError(f"unknown skill script: {tool_name}") from exc

    def _load_script(self, script_file: str) -> None:
        script_path = (self.skill_dir / script_file).resolve()
        scripts_dir = (self.skill_dir / "scripts").resolve()
        if script_path.suffix != ".py":
            raise ValueError(f"skill script must be a Python file: {script_file}")
        if scripts_dir not in script_path.parents:
            raise ValueError(f"skill script must be inside scripts/: {script_file}")
        if not script_path.is_file():
            raise ValueError(f"skill script does not exist: {script_file}")

        source = script_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(script_path))
        _validate_script_ast(tree, script_file)

        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
                continue
            function_name = node.name
            tool_name = f"script.{function_name}"
            if tool_name in self._functions:
                raise ValueError(f"duplicate skill script function: {tool_name}")
            input_schema, output_schema = _schemas_for_function_node(node)
            self._functions[tool_name] = SkillScriptFunction(
                tool_name=tool_name,
                function_name=function_name,
                script_path=script_path,
                description=ast.get_docstring(node)
                or f"Run the deterministic skill helper {function_name}.",
                input_schema=input_schema,
                output_schema={
                    "type": "object",
                    "properties": {"result": output_schema},
                    "required": ["result"],
                    "additionalProperties": False,
                },
            )


class SkillScriptExecutor:
    def __init__(
        self,
        catalog: SkillScriptCatalog,
        context: SkillContext,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.catalog = catalog
        self.context = context
        self.timeout_seconds = timeout_seconds
        self._results: list[ToolResult] = []

    def tool_definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name=function.tool_name,
                display_name=f"脚本 {function.function_name}",
                description=function.description,
                input_schema=function.input_schema,
                output_schema=function.output_schema,
                permission="skill:script",
                side_effect="read",
                requires_confirmation=False,
                handler=self._handler_for(function.tool_name),
            )
            for function in self.catalog.functions()
        ]

    def has(self, tool_name: str) -> bool:
        return self.catalog.has(tool_name)

    def call(self, tool_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        function = self.catalog.get(tool_name)
        validate_json_value(payload, function.input_schema, location=f"{tool_name} input")
        self._emit_progress(tool_name, "running")
        started_at = time.perf_counter()
        try:
            output = self._run_subprocess(function, payload)
            wrapped_output = {"result": output}
            validate_json_value(
                wrapped_output,
                function.output_schema,
                location=f"{tool_name} output",
            )
            result = ToolResult(
                name=tool_name,
                permission="skill:script",
                side_effect="read",
                status="completed",
                duration_ms=int((time.perf_counter() - started_at) * 1000),
                input=payload,
                output=wrapped_output,
            )
            self._record_result(result)
            self._emit_progress(tool_name, "completed")
            return wrapped_output
        except Exception as exc:
            self._record_result(
                ToolResult(
                    name=tool_name,
                    permission="skill:script",
                    side_effect="read",
                    status="failed",
                    duration_ms=int((time.perf_counter() - started_at) * 1000),
                    input=payload,
                    error=str(exc),
                )
            )
            self._emit_progress(tool_name, "failed")
            raise

    def records(self) -> list[dict[str, Any]]:
        return [result.to_record() for result in self._results]

    def _record_result(self, result: ToolResult) -> None:
        self._results.append(result)
        shared_results = getattr(self.context.tool_executor, "results", None)
        if isinstance(shared_results, list):
            shared_results.append(result)

    def _handler_for(
        self,
        tool_name: str,
    ) -> typing.Callable[[ToolContext, dict[str, Any]], dict[str, Any]]:
        def handler(
            _tool_context: ToolContext,
            payload: dict[str, Any],
        ) -> dict[str, Any]:
            return self.call(tool_name, payload)

        return handler

    def _run_subprocess(
        self,
        function: SkillScriptFunction,
        payload: dict[str, Any],
    ) -> Any:
        worker_path = Path(__file__).with_name("script_worker.py")
        serialized_payload = json.dumps(payload, ensure_ascii=False)
        if len(serialized_payload.encode("utf-8")) > _MAX_INPUT_BYTES:
            raise ValueError(
                f"skill script input exceeds {_MAX_INPUT_BYTES} bytes: "
                f"{function.tool_name}"
            )
        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(worker_path),
                    str(function.script_path),
                    function.function_name,
                ],
                input=serialized_payload,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
                env={"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"skill script timed out after {self.timeout_seconds:g}s: "
                f"{function.tool_name}"
            ) from exc

        if len(completed.stdout.encode("utf-8")) > _MAX_OUTPUT_BYTES:
            raise RuntimeError(
                f"skill script output exceeds {_MAX_OUTPUT_BYTES} bytes: "
                f"{function.tool_name}"
            )
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            detail = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(
                f"skill script returned invalid output: {function.tool_name}"
                + (f" ({detail})" if detail else "")
            ) from exc

        if completed.returncode != 0 or response.get("ok") is not True:
            error = response.get("error") or completed.stderr.strip() or "unknown error"
            raise RuntimeError(f"skill script failed: {function.tool_name}: {error}")
        return response.get("result")

    def _emit_progress(self, tool_name: str, status: str) -> None:
        function_name = tool_name.removeprefix("script.")
        if status == "failed":
            user_message = f"脚本「{function_name}」执行失败"
        elif status == "completed":
            user_message = f"脚本「{function_name}」执行完成"
        else:
            user_message = f"调用脚本「{function_name}」"
        self.context.emit_progress(
            "script",
            tool_name,
            user_message,
            status,
        )


def _validate_script_ast(tree: ast.AST, script_file: str) -> None:
    allowed_top_level = (
        ast.Assign,
        ast.AnnAssign,
        ast.Expr,
        ast.FunctionDef,
        ast.Import,
        ast.ImportFrom,
    )
    for node in getattr(tree, "body", []):
        if not isinstance(node, allowed_top_level):
            raise ValueError(
                f"unsupported top-level statement in skill script {script_file}: "
                f"{type(node).__name__}"
            )
        if isinstance(node, ast.FunctionDef) and node.decorator_list:
            raise ValueError(
                f"decorators are not allowed in skill script {script_file}: {node.name}"
            )
        if isinstance(node, ast.Expr) and not (
            isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            raise ValueError(
                f"only module docstrings are allowed at top level in skill script "
                f"{script_file}"
            )

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = {alias.name.split(".", 1)[0] for alias in node.names}
            unsupported = roots - _ALLOWED_IMPORT_ROOTS
            if unsupported:
                raise ValueError(
                    f"unsupported import in skill script {script_file}: "
                    f"{', '.join(sorted(unsupported))}"
                )
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root not in _ALLOWED_IMPORT_ROOTS:
                raise ValueError(
                    f"unsupported import in skill script {script_file}: {root}"
                )
        elif isinstance(node, ast.Call):
            call_name = _call_name(node.func)
            if call_name in _FORBIDDEN_CALLS:
                raise ValueError(
                    f"forbidden call in skill script {script_file}: {call_name}"
                )


def _call_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _schemas_for_function_node(
    function: ast.FunctionDef,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if function.args.posonlyargs or function.args.vararg or function.args.kwarg:
        raise ValueError(
            f"skill script function uses unsupported parameters: {function.name}"
        )

    arguments = [*function.args.args, *function.args.kwonlyargs]
    positional_default_offset = len(function.args.args) - len(function.args.defaults)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for index, argument in enumerate(arguments):
        if argument.annotation is None:
            raise ValueError(
                f"skill script parameter requires a type annotation: "
                f"{function.name}.{argument.arg}"
            )
        properties[argument.arg] = _annotation_schema(argument.annotation)
        if index < len(function.args.args):
            if index < positional_default_offset:
                required.append(argument.arg)
        else:
            keyword_index = index - len(function.args.args)
            if function.args.kw_defaults[keyword_index] is None:
                required.append(argument.arg)

    input_schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        input_schema["required"] = required
    if function.returns is None:
        raise ValueError(
            f"skill script function requires a return annotation: {function.name}"
        )
    return input_schema, _annotation_schema(function.returns)


def _annotation_schema(annotation: Any) -> dict[str, Any]:
    if annotation is None:
        return {}
    if isinstance(annotation, ast.Constant) and annotation.value is None:
        return {"type": "null"}
    if isinstance(annotation, ast.Name):
        return {
            "str": {"type": "string"},
            "bool": {"type": "boolean"},
            "int": {"type": "integer"},
            "float": {"type": "number"},
            "dict": {"type": "object"},
            "list": {"type": "array"},
            "tuple": {"type": "array"},
            "set": {"type": "array"},
            "Any": {},
            "None": {"type": "null"},
        }.get(annotation.id, {})
    if isinstance(annotation, ast.Subscript):
        container = _annotation_name(annotation.value)
        slice_items = (
            list(annotation.slice.elts)
            if isinstance(annotation.slice, ast.Tuple)
            else [annotation.slice]
        )
        if container in {"list", "tuple", "set"}:
            return {
                "type": "array",
                "items": _annotation_schema(slice_items[0]) if slice_items else {},
            }
        if container == "dict":
            value_schema = (
                _annotation_schema(slice_items[1]) if len(slice_items) > 1 else {}
            )
            return {"type": "object", "additionalProperties": value_schema}
        if container == "Optional":
            return {
                "anyOf": [
                    _annotation_schema(slice_items[0]),
                    {"type": "null"},
                ]
            }
        if container == "Union":
            return {"anyOf": [_annotation_schema(item) for item in slice_items]}
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return {
            "anyOf": [
                _annotation_schema(annotation.left),
                _annotation_schema(annotation.right),
            ]
        }
    return {}


def _annotation_name(annotation: ast.expr) -> str:
    if isinstance(annotation, ast.Name):
        return annotation.id
    if isinstance(annotation, ast.Attribute):
        return annotation.attr
    return ""
