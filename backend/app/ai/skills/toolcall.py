from __future__ import annotations

from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.scripts import SkillScriptCatalog


VISIBLE_TEXT_OPEN = "<visible_text>"
VISIBLE_TEXT_CLOSE = "</visible_text>"
STRUCTURED_RESULT_OPEN = "<structured_result>"
STRUCTURED_RESULT_CLOSE = "</structured_result>"


class VisibleTextStream:
    def __init__(self, emit) -> None:
        self.emit = emit
        self.buffer = ""
        self.in_visible = False
        self.chunks: list[str] = []

    @property
    def text(self) -> str:
        return "".join(self.chunks)

    def feed(self, chunk: str) -> None:
        if not chunk:
            return
        self.buffer += chunk
        self._drain()

    def flush(self) -> None:
        if self.in_visible and self.buffer:
            self._emit(self.buffer)
        self.buffer = ""

    def _drain(self) -> None:
        while self.buffer:
            if self.in_visible:
                close_index = self.buffer.find(VISIBLE_TEXT_CLOSE)
                if close_index >= 0:
                    segment = self.buffer[:close_index]
                    if segment and not segment.endswith("\n"):
                        segment = f"{segment}\n"
                    self._emit(segment)
                    self.buffer = self.buffer[close_index + len(VISIBLE_TEXT_CLOSE) :]
                    self.in_visible = False
                    continue
                safe_length = max(0, len(self.buffer) - len(VISIBLE_TEXT_CLOSE) + 1)
                if safe_length <= 0:
                    return
                self._emit(self.buffer[:safe_length])
                self.buffer = self.buffer[safe_length:]
                return

            open_index = self.buffer.find(VISIBLE_TEXT_OPEN)
            if open_index >= 0:
                self.buffer = self.buffer[open_index + len(VISIBLE_TEXT_OPEN) :]
                self.in_visible = True
                continue
            keep_length = len(VISIBLE_TEXT_OPEN) - 1
            if len(self.buffer) <= keep_length:
                return
            self.buffer = self.buffer[-keep_length:]
            return

    def _emit(self, text: str) -> None:
        if not text:
            return
        self.chunks.append(text)
        self.emit(text)


class ToolCallingSkill(BaseSkill):
    """Skill catalog package used by the workspace orchestrator."""

    def __init__(self, manifest: SkillManifest, skill_dir: Path, *, instructions: str | None = None) -> None:
        super().__init__(manifest, skill_dir)
        self.instructions = instructions or ""
        self.script_catalog = SkillScriptCatalog(skill_dir, manifest.script_files)
