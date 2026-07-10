import json
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from app.ai.evals.models import SkillEvalCase, SkillEvalObservation

ModelT = TypeVar("ModelT", bound=BaseModel)


def _load_jsonl(path: Path, model_type: type[ModelT], *, id_field: str, label: str) -> list[ModelT]:
    values: list[ModelT] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                raw: Any = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: malformed JSON: {exc.msg}") from exc
            if not isinstance(raw, dict):
                raise ValueError(f"{path}:{line_number}: expected one JSON object")
            try:
                value = model_type.model_validate(raw)
            except ValidationError as exc:
                raise ValueError(f"{path}:{line_number}: validation error: {exc}") from exc
            identifier = str(getattr(value, id_field))
            if identifier in seen:
                raise ValueError(f"{path}:{line_number}: duplicate {label} id: {identifier}")
            seen.add(identifier)
            values.append(value)
    return values


def load_eval_cases(path: Path) -> list[SkillEvalCase]:
    return _load_jsonl(path, SkillEvalCase, id_field="id", label="eval case")


def load_eval_observations(path: Path) -> list[SkillEvalObservation]:
    return _load_jsonl(path, SkillEvalObservation, id_field="caseId", label="eval observation")


def join_cases_and_observations(
    *,
    cases: list[SkillEvalCase],
    observations: list[SkillEvalObservation],
) -> list[tuple[SkillEvalCase, SkillEvalObservation]]:
    case_by_id = {case.id: case for case in cases}
    observation_by_id = {observation.caseId: observation for observation in observations}
    missing = sorted(set(case_by_id) - set(observation_by_id))
    if missing:
        raise ValueError("missing observations: " + ", ".join(missing))
    extra = sorted(set(observation_by_id) - set(case_by_id))
    if extra:
        raise ValueError("extra observations: " + ", ".join(extra))
    return [(case_by_id[case_id], observation_by_id[case_id]) for case_id in sorted(case_by_id)]
