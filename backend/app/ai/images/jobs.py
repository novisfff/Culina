from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from threading import Lock
from typing import Literal

from app.core.utils import create_id, utcnow
from app.ai.images.generation import ImageGenerationClient, ImageGenerationRequest, ImageGenerationResult

ImageJobStatus = Literal["queued", "running", "succeeded", "failed"]


@dataclass(slots=True)
class ImageGenerationJob:
    id: str
    family_id: str
    user_id: str
    request: ImageGenerationRequest
    reference_media_id: str | None = None
    status: ImageJobStatus = "queued"
    error: str | None = None
    result: ImageGenerationResult | None = None
    created_at: datetime | None = None
    completed_at: datetime | None = None
    finalized_asset_id: str | None = None
    finalizing: bool = False


_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="culina-image")
_jobs: dict[str, ImageGenerationJob] = {}
_jobs_lock = Lock()


def _run_job(job_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.status = "running"

    try:
        client = ImageGenerationClient()
        result = (
            client.generate_from_reference(job.request)
            if job.request.mode.value == "reference"
            else client.generate_from_text(job.request)
        )
    except Exception as exc:  # pragma: no cover - provider failures depend on network/config
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job.status = "failed"
                job.error = str(exc) or "AI 主图生成失败"
                job.completed_at = utcnow()
        return

    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.status = "succeeded"
            job.result = result
            job.completed_at = utcnow()


def enqueue_image_generation(
    *,
    family_id: str,
    user_id: str,
    request: ImageGenerationRequest,
    reference_media_id: str | None = None,
) -> ImageGenerationJob:
    job = ImageGenerationJob(
        id=create_id("image-job"),
        family_id=family_id,
        user_id=user_id,
        request=request,
        reference_media_id=reference_media_id,
        created_at=utcnow(),
    )
    with _jobs_lock:
        _jobs[job.id] = job
    _executor.submit(_run_job, job.id)
    return job


def get_image_generation_job(job_id: str) -> ImageGenerationJob | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def mark_image_generation_job_finalized(job_id: str, asset_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.finalized_asset_id = asset_id
            job.finalizing = False


def claim_image_generation_job_result(job_id: str) -> ImageGenerationResult | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job.status != "succeeded" or job.result is None:
            return None
        if job.finalized_asset_id or job.finalizing:
            return None
        job.finalizing = True
        return job.result


def release_image_generation_job_result(job_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None and job.finalized_asset_id is None:
            job.finalizing = False
