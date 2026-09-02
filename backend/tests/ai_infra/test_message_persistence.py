from app.ai.workflows.runner_support.message_persistence import merge_message_part_timelines


def test_streamed_parts_before_result_anchor_follow_persisted_prefix() -> None:
    persisted_parts = [
        {"id": "text-before", "type": "text", "text": "前置说明"},
        {"id": "approval", "type": "approval_request", "approval": {"id": "approval-1"}},
        {"id": "result", "type": "result_card", "card": {"type": "operation_result"}},
        {"id": "text-after", "type": "text", "text": "结果后的补充"},
    ]
    streamed_parts = [
        {"id": "activity-before", "type": "run_activity", "activity": {"id": "event-1"}},
        {"id": "streamed-text", "type": "text", "text": "本轮继续说明"},
        {"id": "result", "type": "result_card", "card": {"type": "operation_result"}},
        {"id": "activity-after", "type": "run_activity", "activity": {"id": "event-2"}},
    ]

    merged = merge_message_part_timelines(persisted_parts, streamed_parts)

    assert [part["id"] for part in merged] == [
        "text-before",
        "approval",
        "activity-before",
        "streamed-text",
        "result",
        "text-after",
        "activity-after",
    ]
