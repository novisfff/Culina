"""Provider-facing adapters for the model-usage ledger.

Adapters deliberately own the small, strict boundary between an external
provider call and the durable usage lifecycle: reserve, dispatch, then settle
or mark the attempt uncertain.  Provider implementations should never send a
remote request without a dispatch permit.
"""

from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.embedding import EmbeddingUsageAdapter
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.adapters.rerank import RerankUsageAdapter

__all__ = ("AudioUsageAdapter", "EmbeddingUsageAdapter", "LLMUsageAdapter", "RerankUsageAdapter")
