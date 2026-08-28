import type { AppMutationRegistry } from '../useAppMutations';
export function useRecipeMutationActions(m: AppMutationRegistry) { return { createRecipeMutation: m.createRecipeMutation, updateRecipeMutation: m.updateRecipeMutation, deleteRecipeMutation: m.deleteRecipeMutation, cookRecipeMutation: m.cookRecipeMutation, previewCookRecipeMutation: m.previewCookRecipeMutation }; }
