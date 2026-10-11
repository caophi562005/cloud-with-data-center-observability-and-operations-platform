export interface TagDraft { key: string; value: string; editingKey?: string; tagId?: string; pending: boolean; error?: string }
export const EMPTY_TAG_DRAFT: TagDraft = { key: "", value: "", pending: false };
export type TagDraftAction = { type: "key" | "value"; value: string } | { type: "edit"; key: string; value: string; tagId: string } | { type: "pending" | "reset" | "saved" } | { type: "failed"; error: string };
export function tagDraftReducer(state: TagDraft, action: TagDraftAction): TagDraft {
  switch (action.type) {
    case "key": return { ...state, key: action.value, error: undefined };
    case "value": return { ...state, value: action.value, error: undefined };
    case "edit": return { key: action.key, value: action.value, editingKey: action.key, tagId: action.tagId, pending: false };
    case "pending": return { ...state, pending: true, error: undefined };
    case "failed": return { ...state, pending: false, error: action.error };
    case "reset":
    case "saved": return EMPTY_TAG_DRAFT;
  }
}
