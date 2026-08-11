from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate

FIXTURE_DIR = Path(__file__).parent / "fixtures"


@dataclass(frozen=True)
class RankingQualityMetrics:
    case_count: int
    direct_hit_top1: float
    mrr_at_10: float
    ndcg_at_10: float
    l4_top5_violations: int
    recall_at_20: float
    deterministic_rate: float

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


def load_quality_cases() -> list[dict[str, object]]:
    return json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))


def load_baseline() -> dict[str, object]:
    return json.loads((FIXTURE_DIR / "local_ranking_baseline.json").read_text(encoding="utf-8"))


def candidate_from_payload(payload: dict[str, object]) -> SearchRankingCandidate:
    return SearchRankingCandidate(
        entity_type=str(payload["entity_type"]),
        entity_id=str(payload["entity_id"]),
        keyword_score=float(payload["keyword_score"]),
        semantic_score=float(payload["semantic_score"]),
        keyword_rank=int(payload["keyword_rank"]) if payload["keyword_rank"] is not None else None,
        semantic_rank=int(payload["semantic_rank"]) if payload["semantic_rank"] is not None else None,
        literal_match=LiteralMatchKind(str(payload["literal_match"])),
        literal_confidence=float(payload["literal_confidence"]),
        trusted_keyword_match=bool(payload["trusted_keyword_match"]),
        detail_only_match=bool(payload["detail_only_match"]),
        dual_source_match=bool(payload["dual_source_match"]),
        signed_business_score=float(payload["signed_business_score"]),
        positive_reasons=tuple(str(reason) for reason in payload["positive_reasons"]),
    )


def _dcg(grades: list[int]) -> float:
    return sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))


def evaluate_quality_cases(cases: list[dict[str, object]]) -> RankingQualityMetrics:
    direct_total = 0
    direct_top1 = 0
    reciprocal_ranks: list[float] = []
    ndcgs: list[float] = []
    l4_top5_violations = 0
    relevant_total = 0
    relevant_recovered = 0
    deterministic = 0
    for case in cases:
        raw_candidates = list(case["candidates"])
        relevance_by_id = {str(item["entity_id"]): int(item["relevance"]) for item in raw_candidates}
        candidates = [candidate_from_payload(item) for item in raw_candidates]
        profile = analyze_search_query(str(case["query"]))
        ranked = rank_local_candidates(profile, candidates)
        ranked_ids = [candidate.entity_id for candidate, _score in ranked]
        repeated_ids = [
            candidate.entity_id
            for candidate, _score in rank_local_candidates(profile, candidates)
        ]
        deterministic += int(ranked_ids == repeated_ids)
        if case["category"] == "literal":
            direct_total += 1
            direct_top1 += int(bool(ranked_ids) and relevance_by_id[ranked_ids[0]] == 3)
        first_best = next(
            (index for index, entity_id in enumerate(ranked_ids[:10], start=1) if relevance_by_id[entity_id] == 3),
            None,
        )
        reciprocal_ranks.append(0.0 if first_best is None else 1.0 / first_best)
        actual_grades = [relevance_by_id[entity_id] for entity_id in ranked_ids[:10]]
        ideal_grades = sorted(relevance_by_id.values(), reverse=True)[:10]
        ideal_dcg = _dcg(ideal_grades)
        ndcgs.append(_dcg(actual_grades) / ideal_dcg if ideal_dcg else 1.0)
        has_high_confidence = any(
            score.confidence_level <= SearchConfidenceLevel.STRONG for _candidate, score in ranked
        )
        if has_high_confidence and len(ranked) >= 5:
            l4_top5_violations += sum(
                score.confidence_level is SearchConfidenceLevel.WEAK for _candidate, score in ranked[:5]
            )
        relevant_ids = {entity_id for entity_id, grade in relevance_by_id.items() if grade > 0}
        relevant_total += len(relevant_ids)
        relevant_recovered += len(relevant_ids & set(ranked_ids[:20]))
    return RankingQualityMetrics(
        case_count=len(cases),
        direct_hit_top1=direct_top1 / direct_total,
        mrr_at_10=sum(reciprocal_ranks) / len(reciprocal_ranks),
        ndcg_at_10=sum(ndcgs) / len(ndcgs),
        l4_top5_violations=l4_top5_violations,
        recall_at_20=relevant_recovered / relevant_total,
        deterministic_rate=deterministic / len(cases),
    )
