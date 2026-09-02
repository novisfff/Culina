from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.ai_revert.types import AIRevertResponse


ERRORS: dict[str, tuple[int, bool]] = {
    "operation_not_revertible": (409, False),
    "revert_expired": (409, False),
    "revert_forbidden": (403, False),
    "revert_target_changed": (409, True),
    "revert_dependency_exists": (409, True),
    "revert_adapter_version_unsupported": (409, True),
    "revert_request_id_reused": (409, False),
}

ERROR_MESSAGES = {
    "operation_not_revertible": "该操作当前不可撤销",
    "revert_expired": "该操作的撤销期限已过",
    "revert_forbidden": "只有原执行人或当前家庭管理员可以撤销",
    "revert_target_changed": "目标状态已变化，不能撤销",
    "revert_dependency_exists": "目标已有后续依赖，不能撤销",
    "revert_adapter_version_unsupported": "该操作的撤销版本不受支持",
    "revert_request_id_reused": "请求 ID 已用于其他操作",
}


class AIRevertError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 409,
        permanent_block: bool = False,
        response: AIRevertResponse | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status_code = status_code
        self.permanent_block = permanent_block
        self.response = response


class AIRevertTargetChanged(AIRevertError):
    def __init__(self, message: str | None = None, *, response: AIRevertResponse | None = None) -> None:
        status_code, permanent = ERRORS["revert_target_changed"]
        super().__init__(
            "revert_target_changed",
            message or ERROR_MESSAGES["revert_target_changed"],
            status_code=status_code,
            permanent_block=permanent,
            response=response,
        )


class AIRevertDependencyExists(AIRevertError):
    def __init__(self, message: str | None = None, *, response: AIRevertResponse | None = None) -> None:
        status_code, permanent = ERRORS["revert_dependency_exists"]
        super().__init__(
            "revert_dependency_exists",
            message or ERROR_MESSAGES["revert_dependency_exists"],
            status_code=status_code,
            permanent_block=permanent,
            response=response,
        )


class AIRevertAdapterVersionUnsupported(AIRevertError):
    def __init__(self, message: str | None = None, *, response: AIRevertResponse | None = None) -> None:
        status_code, permanent = ERRORS["revert_adapter_version_unsupported"]
        super().__init__(
            "revert_adapter_version_unsupported",
            message or ERROR_MESSAGES["revert_adapter_version_unsupported"],
            status_code=status_code,
            permanent_block=permanent,
            response=response,
        )


PERMANENT_ERROR_TYPES = {
    "revert_target_changed": AIRevertTargetChanged,
    "revert_dependency_exists": AIRevertDependencyExists,
    "revert_adapter_version_unsupported": AIRevertAdapterVersionUnsupported,
}


def ai_revert_error(
    code: str,
    *,
    message: str | None = None,
    status_code: int | None = None,
    response: AIRevertResponse | None = None,
) -> AIRevertError:
    configured_status, permanent = ERRORS[code]
    error_type = PERMANENT_ERROR_TYPES.get(code)
    if error_type is not None and status_code is None:
        return error_type(message, response=response)
    return AIRevertError(
        code,
        message or ERROR_MESSAGES[code],
        status_code=status_code or configured_status,
        permanent_block=permanent,
        response=response,
    )
