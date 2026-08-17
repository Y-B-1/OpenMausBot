// Client mirror of the server's pipeline records (server/pipelines.ts).

export interface TemplateStep {
  id: string;
  title: string;
  prompt: string;
  botId: string;
  gate?: "approval";
}

export interface PipelineTemplate {
  id: string;
  name: string;
  steps: TemplateStep[];
  createdAt: number;
}

export type StepState = "pending" | "running" | "done";

export type PipelineRunStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "rejected"
  | "failed"
  | "cancelled";

export interface PipelineApproval {
  token: string;
  stepIndex: number;
  expiresAt: number;
}

export interface PipelineRun {
  id: string;
  templateId: string;
  name: string;
  input: string;
  steps: TemplateStep[];
  status: PipelineRunStatus;
  haltReason?: string;
  stepIndex: number;
  stepStates: StepState[];
  stepOutputs: Array<string | null>;
  approvedSteps: number[];
  approval?: PipelineApproval;
  threadId?: string;
  startedAt: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateInput {
  name: string;
  steps: Array<{ title: string; prompt: string; botId: string; gate?: "approval" }>;
}
