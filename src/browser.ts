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
  const beforeSessions: any[] = await bb.sessions.list().catch(() => []);
  const beforeIds = new Set(beforeSessions.map((session: any) => String(session.id)));

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

  let sessionId: string | undefined =
    run.sessionId || run.session?.id || run.browserSessionId || run.browser_session_id;

  if (!sessionId) {
    for (let attempt = 0; attempt < 8 && !sessionId; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const sessions: any[] = await bb.sessions.list();
        const fresh = sessions
          .filter((session: any) => !beforeIds.has(String(session.id)))
          .sort((a: any, b: any) => new Date(b.startedAt || b.createdAt || 0).getTime() - new Date(a.startedAt || a.createdAt || 0).getTime());
        if (fresh[0]?.id) sessionId = String(fresh[0].id);
      } catch {
        // The managed run still works even if session discovery is delayed.
      }
    }
  }

  let liveViewUrl: string | undefined;
  if (sessionId) {
    try {
      const debug: any = await bb.sessions.debug(sessionId);
      liveViewUrl = debug.debuggerFullscreenUrl || debug.debuggerUrl;
    } catch {
      // The run can still proceed if the live debugger URL is not ready yet.
    }
  }

  return {
    runId: run.runId || run.id,
    sessionId,
    status: run.status,
    liveViewUrl,
    task: run.task
  };
}

export async function getBrowserWork(runId: string, sessionIdHint?: string): Promise<BrowserWork> {
  const bb = client();
  const run: any = await bb.agents.runs.retrieve(runId);
  const sessionId: string | undefined =
    run.sessionId || run.session?.id || run.browserSessionId || run.browser_session_id || sessionIdHint;

  let liveViewUrl: string | undefined;
  if (sessionId && ["PENDING", "RUNNING", "PAUSED"].includes(run.status)) {
    try {
      const debug: any = await bb.sessions.debug(sessionId);
      liveViewUrl = debug.debuggerFullscreenUrl || debug.debuggerUrl;
    } catch {
      // ignore transient debugger errors
    }
  }

  return {
    runId: run.runId || run.id,
    sessionId,
    status: run.status,
    liveViewUrl,
    task: run.task,
    result: run.result,
    cause: run.cause
  };
}
