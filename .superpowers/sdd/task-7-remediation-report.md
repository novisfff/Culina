# Task 7 Review Remediation Report

## Status

Resolved both Task 7 review findings in commit `aa6f4a58` (`fix(search): isolate private recall and preserve local ties`).

## TDD evidence

### RED

Added focused regressions for pre-limit private meal-plan visibility across SQLite LIKE and compact scan paths, no-user mixed-scope recall, the bound MySQL JSON visibility condition, hybrid user-id forwarding, and successful-rerank local-order ties.

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py tests/search/test_hybrid_ranking_features.py -q
```

Result: `5 failed, 10 passed`. Failures were the expected missing `user_id` keyword-store interface, private meal-plan limit starvation, missing MySQL JSON condition, and entity-id rerank tie-break.

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_hybrid_search.py::test_hybrid_search_passes_user_identity_to_keyword_recall -q
```

Result: `1 failed`; the observed keyword recall identity was `None` instead of `user-current`.

### GREEN

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py tests/search/test_hybrid_ranking_features.py tests/search/test_hybrid_search.py::test_hybrid_search_passes_user_identity_to_keyword_recall -q
```

Result: `16 passed in 0.40s`.

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py tests/search/test_hybrid_ranking_features.py tests/search/test_hybrid_search.py -q
```

Result: `45 passed in 1.11s`.

## Source changes

- `search_keyword_documents` now accepts `user_id`; `hybrid_search` passes the current identity.
- SQLite LIKE and compact scan queries apply a shared family-preserving visibility predicate before their limits. Meal-plan documents require matching `metadata_json["user_id"]`; without identity they are excluded while family-visible scopes remain available.
- MySQL FULLTEXT applies the equivalent pre-limit filter using bound `:user_id` parameters and `JSON_UNQUOTE(JSON_EXTRACT(...))`.
- Successful rerank captures the incoming local position and uses it after bucket, provider score, and local score as the final tie-break.

## Final verification

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
```

Result: `169 passed in 3.56s`.

```bash
cd backend && .venv/bin/python -m py_compile app/services/search/hybrid.py app/services/search/keyword_store.py tests/search/test_keyword_store.py tests/search/test_hybrid_ranking_features.py tests/search/test_hybrid_search.py
git diff --check
```

Result: exit code 0 with no output.

No migration, public response schema, plan/spec, frontend, vector-store, or unrelated module changed. MySQL behavior is locked by SQL compilation assertions; no live MySQL instance was used in this remediation.

## Follow-up privacy remediation

### RED

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_hybrid_search.py::test_search_vectors_without_user_excludes_meal_plans_from_mixed_scope_recall tests/search/test_hybrid_search.py::test_search_vectors_without_user_skips_meal_plan_only_recall -q
```

Result: `2 failed in 0.19s`. The mixed-scope request returned the private `meal_plan` hit, and the meal-plan-only request returned a private hit instead of avoiding the vector store.

### GREEN

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_hybrid_search.py::test_search_vectors_without_user_excludes_meal_plans_from_mixed_scope_recall tests/search/test_hybrid_search.py::test_search_vectors_without_user_skips_meal_plan_only_recall -q
```

Result: `2 passed in 0.13s`.

### Final verification

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
```

Result: `171 passed in 3.34s`.

```bash
cd backend && .venv/bin/python -m py_compile app/services/search/hybrid.py tests/search/test_hybrid_search.py && git diff --check
```

Result: exit code 0 with no output.

## Empty keyword identity remediation

### RED

Added a SQLite regression where a newer private `meal_plan` document has
`metadata_json={"user_id": ""}` and a matching family recipe is older. With
`user_id=""` and a mixed-scope `limit=1`, the private document previously
consumed the keyword recall slot; the same call scoped only to `meal_plan`
also exposed it.

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py::test_keyword_search_with_empty_user_excludes_private_plans_before_mixed_scope_limit -q
```

Result: `1 failed in 0.25s`. The mixed-scope result was
`('meal_plan', 'empty-user-plan')` instead of the family recipe.

### GREEN

`search_keyword_documents` now normalizes `user_id` once at its public entry
with `user_id or None`, and passes that normalized value to its MySQL
FULLTEXT, SQLite LIKE, and compact helpers. Consequently both the shared
SQLite visibility predicate and MySQL bound `:user_id IS NOT NULL` condition
observe absent identity before their limits or scans.

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py::test_keyword_search_with_empty_user_excludes_private_plans_before_mixed_scope_limit -q
```

Result: `1 passed in 0.21s`.

### Final verification

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py -q
cd backend && .venv/bin/python -m pytest tests/search -q
cd backend && .venv/bin/python -m py_compile app/services/search/keyword_store.py tests/search/test_keyword_store.py
git diff --check
```

Results: `13 passed in 0.36s`; `172 passed in 3.40s`; compilation and
`git diff --check` both exited 0 with no output.

Source/test commit: `6e49e974` (`fix(search): normalize empty keyword identity`).
