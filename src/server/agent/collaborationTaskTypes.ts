/** Workflow records are explicit reports and decisions, never inferred Agent activity. */
export interface TaskMember { serviceId: string; sessionId: string }
/** Authenticated integration identity is separate from a terminal member. */
export interface TaskOrigin {
  integrationId: string; source: string; externalActor?: Record<string, unknown>;
  externalMessageId?: string; metadata?: Record<string, unknown>;
}
export type TaskReportStatus = 'ack' | 'working' | 'blocked' | 'complete' | 'failed';
export interface CollaborationTaskEvent {
  id: string; sequence: number; kind: string; actor: TaskMember | null;
  content: string; createdAt: number; attemptId: string | null;
  reportStatus?: TaskReportStatus; evidence?: unknown; artifactId?: string; target?: TaskMember;
  source?: 'system' | 'user' | 'integration';
  origin?: TaskOrigin;
  replyToEventId?: string;
  deliveryId?: string;
}
export interface CollaborationTaskDecision {
  id: string; attemptId: string; question: string; options: string[];
  status: 'pending' | 'answered' | 'superseded'; createdAt: number;
  answer?: string; answeredAt?: number;
}
export interface CollaborationTaskArtifact {
  id: string; attemptId: string; kind: 'plan' | 'result' | 'review';
  content: string; evidence?: unknown; createdAt: number; actor: TaskMember;
  reviewsArtifactId?: string;
  verdict?: 'pass' | 'changes' | 'blocked';
  summary?: string;
}
export interface TaskWorkflow {
  kind: 'goal' | 'step'; rootTaskId?: string; reviewers: TaskMember[];
  isolated: boolean; paused: boolean; maxRevisions: number;
  integration?: boolean;
  maxParallel?: number;
  workType?: 'auto' | 'code' | 'read-only';
}
export interface TaskWorkspace { cwd: string; repository: string; branch: string; base: string }
export interface CollaborationTaskAttempt {
  id: string; assignee: TaskMember; createdAt: number;
  threadId: string; messageId?: string; deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'expired';
  deliveredAt?: number | null; deliveryError?: string | null;
  report?: { status: TaskReportStatus; content: string; evidence?: unknown; createdAt: number; summary?: string };
}
export interface CollaborationTask {
  origin?: TaskOrigin;
  id: string; ownerServiceId: string; groupId: string; title: string; spec: string;
  constraints: string; acceptance: string; createdAt: number; updatedAt: number; revision: number;
  coordinator: TaskMember | null; parentTaskId: string | null; dependsOn: string[];
  status: 'open' | 'accepted' | 'closed'; activeAttemptId: string | null;
  acceptedArtifactId?: string; approvedPlanArtifactId?: string; attempts: CollaborationTaskAttempt[];
  events: CollaborationTaskEvent[]; decisions: CollaborationTaskDecision[]; artifacts: CollaborationTaskArtifact[];
  deliveries: Array<{ id: string; attemptId: string | null; kind: string; messageId: string; status: string; deliveredAt: number | null; error: string | null }>;
  workflow?: TaskWorkflow; scheduledAssignee?: TaskMember; workspace?: TaskWorkspace;
  automationIssue?: string; completionMode?: 'reviewed';
  coordination?: { notifiedSequence: number; acknowledgedSequence: number; notifiedAt: number };
}
export interface TaskOutbox {
  replyToEventId?: string;
  id: string; taskId: string; attemptId: string | null; target: TaskMember;
  content: string; kind: 'task' | 'message' | 'handoff'; threadId: string;
  messageId?: string; lastError?: string; nextRetryAt?: number;
}
export type TaskOperationKind = 'assign' | 'report' | 'ask' | 'answer' | 'submit-plan' | 'review' | 'request-review' | 'approve-plan' | 'accept' | 'revise' | 'close' | 'reopen' | 'comment' | 'respond' | 'coordinator' | 'coordinate' | 'pause' | 'resume' | 'retry';
export interface TaskOperation {
  replyToEventId?: string;
  kind: TaskOperationKind; expectedRevision?: number; idempotencyKey: string;
  content?: string; assignee?: TaskMember; coordinator?: TaskMember | null;
  attemptId?: string; status?: TaskReportStatus; evidence?: unknown;
  decisionId?: string; artifactId?: string; options?: string[];
  verdict?: 'pass' | 'changes' | 'blocked';
  summary?: string;
}
export interface TaskCreateInput {
  idempotencyKey: string; groupId: string; title: string; spec: string;
  constraints?: string; acceptance?: string; assignee?: TaskMember;
  coordinator?: TaskMember | null; parentTaskId?: string | null; dependsOn?: string[];
  managed?: boolean; reviewers?: TaskMember[]; isolated?: boolean;
  integration?: boolean;
  workType?: 'code' | 'read-only';
}
export interface CollaborationTaskView extends CollaborationTask {
  /** Response metadata computed before a summary omits the report body; never persisted. */
  automationIssueSource?: 'member-report' | 'system';
  summaryOnly?: boolean; replica?: boolean;
  memberSessions: Record<string, string>;
  outbox: Array<{ id: string; attemptId: string | null; messageId?: string; lastError?: string }>;
  children?: Array<{ id: string; title: string; status: CollaborationTask['status']; revision: number; completionMode?: 'reviewed'; workspace?: TaskWorkspace }>;
  roster?: Array<{ member: TaskMember; sessionId: string; role: string }>;
}
export function taskMemberKey(member: TaskMember): string { return `${member.serviceId}:${member.sessionId}`; }
