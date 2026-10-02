import Browserbase from "@browserbasehq/sdk";

export type BrowserWork = {
  runId: string;
  sessionId?: string;
  status: string;
  liveViewUrl?: string;
  task: string;
  result?: unknown;
  cause?: unknown;
};

function client() {
  if (!process.env.BROWSERBASE_API_KEY) {
    throw new Error("BROWSERBASE_API_KEY is not configured");
  }
  return new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
}

export async function startBrowserWork(task: string): Promise<BrowserWork> {
  const bb = client();

  const run: any = await bb.agents.runs.create({
    task,
    resultSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              note: { type: "string" }
            },
            required: ["title", "url", "note"]
          }
        },
        suggestedNextStep: { type: "string" }
      },
      required: ["summary", "findings", "suggestedNextStep"]
    }
  });

  let liveViewUrl: string | undefined;
  if (run.sessionId) {
    try {
      const debug: any = await bb.sessions.debug(run.sessionId);
      liveViewUrl = debug.debuggerFullscreenUrl || debug.debuggerUrl;
    } catch {
      // The run can still proceed if the live debugger URL is not ready yet.
    }
  }

  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    liveViewUrl,
    task: run.task
  };
}

export async function getBrowserWork(runId: string): Promise<BrowserWork> {
  const bb = client();
  const run: any = await bb.agents.runs.retrieve(runId);

  let liveViewUrl: string | undefined;
  if (run.sessionId && ["PENDING", "RUNNING", "PAUSED"].includes(run.status)) {
    try {
      const debug: any = await bb.sessions.debug(run.sessionId);
      liveViewUrl = debug.debuggerFullscreenUrl || debug.debuggerUrl;
    } catch {
      // ignore transient debugger errors
    }
  }

  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    liveViewUrl,
    task: run.task,
    result: run.result,
    cause: run.cause
  };
}
