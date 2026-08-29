from __future__ import annotations

from collections.abc import Callable, Iterator
import logging
from queue import Queue
from time import perf_counter
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner

logger = logging.getLogger(__name__)


def _elapsed_ms(started_at: float) -> int:
    return int((perf_counter() - started_at) * 1000)


def make_stream_worker_runner(
    *,
    db_bind: Any,
    provider_factory: Any,
    runner_factory: Callable[[], "WorkspaceGraphRunner"] | None,
) -> tuple["WorkspaceGraphRunner", Callable[[], None]]:
    if runner_factory is not None:
        return runner_factory(), lambda: None

    from app.ai.workspace_service import AIApplicationService
    from app.ai.workflows.runner import WorkspaceGraphRunner

    worker_db = Session(bind=db_bind, autoflush=False, autocommit=False, future=True)
    service = AIApplicationService(worker_db, provider_factory=provider_factory)
    return WorkspaceGraphRunner(service), worker_db.close


def enqueue_stream_event(
    event_queue: Queue[Any],
    *,
    seen_event_ids: set[str],
    is_disconnected: Callable[[], bool],
    event: str,
    data: dict[str, Any],
) -> None:
    if event == "progress" and isinstance(data.get("id"), str):
        seen_event_ids.add(data["id"])
    if is_disconnected():
        return
    event_queue.put((event, data))


def drain_stream_graph(
    worker_runner: "WorkspaceGraphRunner",
    *,
    graph_stream: Callable[["WorkspaceGraphRunner"], Iterator[Any]],
    handle_update: Callable[["WorkspaceGraphRunner", Any], Iterator[tuple[str, dict[str, Any]]]],
    enqueue: Callable[[str, dict[str, Any]], None],
    before_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None,
    after_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None,
    perf_context: dict[str, Any] | None,
) -> None:
    total_started_at = perf_counter()
    before_graph_ms = 0
    graph_stream_ms = 0
    after_graph_ms = 0
    chunk_count = 0
    custom_event_count = 0
    emitted_event_count = 0
    status = "completed"
    try:
        if before_graph is not None:
            before_started_at = perf_counter()
            for event, data in before_graph(worker_runner):
                enqueue(event, data)
                emitted_event_count += 1
            before_graph_ms = _elapsed_ms(before_started_at)
        graph_started_at = perf_counter()
        for chunk in graph_stream(worker_runner):
            chunk_count += 1
            mode, update = chunk if isinstance(chunk, tuple) else ("updates", chunk)
            if mode == "custom":
                event, data = worker_runner._custom_stream_event(update)
                if event:
                    enqueue(event, data)
                    custom_event_count += 1
                    emitted_event_count += 1
                continue
            if mode != "updates":
                continue
            for event, data in handle_update(worker_runner, update):
                enqueue(event, data)
                emitted_event_count += 1
        graph_stream_ms = _elapsed_ms(graph_started_at)
        worker_runner.db.commit()
        if after_graph is not None:
            after_started_at = perf_counter()
            final_events = list(after_graph(worker_runner))
            worker_runner.db.commit()
            for event, data in final_events:
                enqueue(event, data)
                emitted_event_count += 1
            after_graph_ms = _elapsed_ms(after_started_at)
    except BaseException:
        status = "failed"
        raise
    finally:
        context = perf_context or {}
        logger.info(
            "AI graph stream perf summary flow=%s family_id=%s user_id=%s conversation_id=%s run_id=%s status=%s before_graph_ms=%s graph_stream_ms=%s after_graph_ms=%s total_ms=%s chunk_count=%s custom_event_count=%s emitted_event_count=%s",
            context.get("flow") or "unknown",
            context.get("family_id"),
            context.get("user_id"),
            context.get("conversation_id"),
            context.get("run_id"),
            status,
            before_graph_ms,
            graph_stream_ms,
            after_graph_ms,
            _elapsed_ms(total_started_at),
            chunk_count,
            custom_event_count,
            emitted_event_count,
        )


def handle_stream_worker_exception(
    worker_runner: "WorkspaceGraphRunner",
    exc: BaseException,
    *,
    event_queue: Queue[Any],
    is_disconnected: Callable[[], bool],
    on_worker_exception: Callable[["WorkspaceGraphRunner", BaseException], bool | None] | None,
    perf_context: dict[str, Any] | None = None,
    enqueue: Callable[[str, dict[str, Any]], None] | None = None,
) -> None:
    reported_exc = exc
    handled = False
    try:
        worker_runner.db.rollback()
        if on_worker_exception is not None:
            handled = bool(on_worker_exception(worker_runner, exc))
        if handled:
            context = perf_context or {}
            conversation_id = context.get("conversation_id")
            run_id = context.get("run_id")
            if (
                enqueue is None
                or not isinstance(conversation_id, str)
                or not conversation_id
                or not isinstance(run_id, str)
                or not run_id
            ):
                raise RuntimeError("已吸收的 AI 流错误缺少最终响应上下文")
            # The persister has already committed a durable success.  Return
            # that snapshot through the normal SSE response event so clients
            # do not interpret the swallowed provider error as a failed request.
            enqueue("response", worker_runner._chat_response(conversation_id, run_id))
            return
    except Exception as persistence_exc:
        logger.exception("AI graph background worker failed while recording stream error")
        reported_exc = persistence_exc
    if is_disconnected():
        logger.warning(
            "AI graph background worker failed after subscriber disconnect: %s",
            reported_exc,
            exc_info=True,
        )
    else:
        event_queue.put(reported_exc)


def consume_stream_graph_worker(
    *,
    db_bind: Any,
    provider_factory: Any,
    event_queue: Queue[Any],
    graph_stream: Callable[["WorkspaceGraphRunner"], Iterator[Any]],
    handle_update: Callable[["WorkspaceGraphRunner", Any], Iterator[tuple[str, dict[str, Any]]]],
    enqueue: Callable[[str, dict[str, Any]], None],
    is_disconnected: Callable[[], bool],
    before_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None,
    after_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None,
    on_worker_exception: Callable[["WorkspaceGraphRunner", BaseException], bool | None] | None,
    runner_factory: Callable[[], "WorkspaceGraphRunner"] | None,
    perf_context: dict[str, Any] | None,
    stream_done_marker: object,
) -> None:
    worker_runner, close_worker_runner = make_stream_worker_runner(
        db_bind=db_bind,
        provider_factory=provider_factory,
        runner_factory=runner_factory,
    )
    context = perf_context or {}
    family_id = context.get("family_id")
    run_id = context.get("run_id")
    if isinstance(family_id, str) and family_id and isinstance(run_id, str) and run_id:
        # Never carry a request-thread provider into a worker. The worker has
        # its own Session and reconstructs from the immutable run snapshot.
        worker_runner._bind_provider_for_run(family_id=family_id, run_id=run_id)
    previous_sink = worker_runner._direct_stream_sink
    worker_runner._direct_stream_sink = enqueue
    try:
        drain_stream_graph(
            worker_runner,
            graph_stream=graph_stream,
            handle_update=handle_update,
            enqueue=enqueue,
            before_graph=before_graph,
            after_graph=after_graph,
            perf_context=perf_context,
        )
    except BaseException as exc:
        handle_stream_worker_exception(
            worker_runner,
            exc,
            event_queue=event_queue,
            is_disconnected=is_disconnected,
            on_worker_exception=on_worker_exception,
            perf_context=perf_context,
            enqueue=enqueue,
        )
    finally:
        worker_runner._direct_stream_sink = previous_sink
        close_worker_runner()
        if not is_disconnected():
            event_queue.put(stream_done_marker)
