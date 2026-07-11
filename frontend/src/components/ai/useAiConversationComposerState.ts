import { useCallback, useEffect, useRef, useState } from 'react';

export const NEW_AI_CONVERSATION_SCOPE = 'new-ai-conversation';

export function useAiConversationComposerState(initialScope: string) {
  const [scope, setScope] = useState(initialScope);
  const scopeRef = useRef(scope);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[scope] ?? '';

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const selectScope = useCallback((nextScope: string | ((current: string) => string)) => {
    setScope((current) => {
      const resolved = typeof nextScope === 'function' ? nextScope(current) : nextScope;
      scopeRef.current = resolved;
      return resolved;
    });
  }, []);

  const setDraft = useCallback((value: string) => {
    const targetScope = scopeRef.current;
    setDrafts((current) => ({ ...current, [targetScope]: value }));
  }, []);

  const moveScope = useCallback((from: string, to: string) => {
    setDrafts((current) => {
      if (!(from in current) || from === to) return current;
      const next = { ...current, [to]: current[from] };
      delete next[from];
      return next;
    });
    setScope((current) => {
      if (current !== from) return current;
      scopeRef.current = to;
      return to;
    });
    if (scopeRef.current === from) {
      scopeRef.current = to;
    }
  }, []);

  const clearScope = useCallback((key: string) => {
    setDrafts((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  return { scope, draft, setDraft, selectScope, moveScope, clearScope };
}
