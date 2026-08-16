// T5: AgentDriver seam — mock and anthropic drivers implement this.
import type { AgentRecord } from "../../shared/contracts.ts";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type DriverInput = {
  agent: AgentRecord;
  /** D10 data blocks (memory etc.), already wrapped as non-instruction reference data. */
  contextBlocks: string[];
  transcript: { author: string; text: string }[];
  tools: ToolDef[];
};

export type DriverCallbacks = {
  onDelta: (text: string) => void;
  onToolCall: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

export interface AgentDriver {
  runTurn(input: DriverInput, callbacks: DriverCallbacks): Promise<{ text: string }>;
}
