import type { AiChatAttachment, AiChatResponse, AiHumanInputRequest, AiMessage } from '../../api/types';
import type { AiApprovalDecisionSubmit } from './AiConversationThread';
import { useAiHumanInputStream } from './useAiHumanInputStream';
import { useAiApprovalStream } from './useAiApprovalStream';
import type { StreamMutationContext } from './aiStreamSupport';
import { useAiChatStream } from './useAiChatStream';

export type ChatStreamPayload = {
  message: string;
  conversationKey: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
  attachments?: AiChatAttachment[];
};

export type ApprovalStreamPayload = {
  approval: Parameters<AiApprovalDecisionSubmit>[0];
  decision: 'approved' | 'rejected';
  values: Record<string, unknown>;
  comment?: string;
};

export type HumanInputStreamPayload = {
  message: AiMessage;
  request: AiHumanInputRequest;
  response: { selected_option_ids?: string[]; text?: string };
};

export type AiConversationStreams = {
  startChat: (payload: ChatStreamPayload) => Promise<AiChatResponse>;
  startApproval: (payload: ApprovalStreamPayload) => Promise<void>;
  startHumanInput: (payload: HumanInputStreamPayload) => Promise<AiChatResponse>;
  submittingApprovalIds: Set<string>;
  submittingHumanInputRequestIds: Set<string>;
  submittingHumanInputByRequestId: Record<string, { messageId: string; conversationId: string; runId: string | null }>;
};

export function useAiConversationStreams(context: StreamMutationContext): AiConversationStreams {
  const approval = useAiApprovalStream(context);
  const humanInput = useAiHumanInputStream(context);
  const startChat = useAiChatStream(context);

  return {
    startChat,
    startApproval: approval.startApproval,
    startHumanInput: humanInput.startHumanInput,
    submittingApprovalIds: approval.submittingApprovalIds,
    submittingHumanInputRequestIds: humanInput.submittingRequestIds,
    submittingHumanInputByRequestId: humanInput.submittingByRequestId,
  };
}
