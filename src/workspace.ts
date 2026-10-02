export type WorkspaceFile = {
  path: string;
  mimeType: string;
  content?: string;
  storageUrl?: string;
  createdBy: string;
};

export type ExternalAction = {
  type: "email" | "publish" | "form" | "calendar" | "drive" | "purchase";
  title: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  payload: Record<string, unknown>;
};

export const DESKS = {
  research: ["browser", "notes", "search"],
  writing: ["documents", "files"],
  numbers: ["spreadsheets", "analysis"],
  build: ["code", "preview", "deploy"],
  operations: ["email", "calendar", "forms", "drive"],
  founder: ["memory", "tasks", "decisions"]
} as const;
