// Client mirror of the server's inbox records (server/inbox.ts).

export interface InboxItem {
  id: string;
  botId: string;
  text: string;
  ts: number;
  status: "open" | "replied";
  reply?: string;
  repliedAt?: number;
}

export interface InboxQuestion {
  id: string;
  botId: string;
  prompt: string;
  /** Empty array = free-text question. */
  options: string[];
  ts: number;
  status: "pending" | "answered";
  answer?: string;
  answeredAt?: number;
  threadId?: string;
  requestId?: string;
}
