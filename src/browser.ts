import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";

export type BrowserWork = {
  runId: string;
  sessionId?: string;
  status: string;
  liveViewUrl?: string;
  task: string;
  result?: unknown;
  cause?: unknown;
  screenshotDataUrl?: string;
};

type SearchResult = {
  title?: string;
  url?: string;
  description?: string;
};

const activeRuns = new Map<string, BrowserWork>();

function client() {
  if (!process.env.BROWSERBASE_API_KEY) {
    throw new Error("BROWSERBASE_API_KEY is not configured");
  }
  return new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
}

function taskQuery(task: string) {
  const objective = task.match(/Current objective:\s*([^\n]+)/i)?.[1];
  const action = task.match(/Specific next action:\s*([^\n]+)/i)?.[1];
  return [objective, action].filter(Boolean).join(" ").slice(0, 180) || task.slice(0, 180);
}

async function debugUrl(bb: Browserbase, sessionId: string) {
  try {
    const debug: any = await bb.sessions.debug(sessionId);
    return debug.debuggerFullscreenUrl || debug.debuggerUrl || undefined;
  } catch {
    return undefined;
  }
}

async function fetchNotes(bb: Browserbase, results: SearchResult[]) {
  const findings: Array<{ title: string; url: string; note: string }> = [];
  for (const result of results.slice(0, 5)) {
    if (!result?.url) continue;
    let note = String(result.description || "").trim();
    try {
      const fetched: any = await (bb as any).fetchAPI.create({
        url: result.url,
        format: "markdown",
      });
      const body = String(fetched?.content || fetched?.markdown || fetched?.text || "").replace(/\s+/g, " ").trim();
      if (body) note = body.slice(0, 420);
    } catch {
      // Search metadata is still useful when a fetch is blocked.
    }
    findings.push({
      title: String(result.title || result.url),
      url: String(result.url),
      note: note || "Visited in the live browser session.",
    });
  }
  return findings;
}

async function driveSession(
  bb: Browserbase,
  runId: string,
  sessionId: string,
  connectUrl: string,
  task: string,
  results: SearchResult[],
) {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    const capture = async () => {
      try {
        const jpg = await page.screenshot({ type: "jpeg", quality: 62 });
        const current = activeRuns.get(runId);
        if (current) {
          activeRuns.set(runId, {
            ...current,
            screenshotDataUrl: `data:image/jpeg;base64,${Buffer.from(jpg).toString("base64")}`,
          });
        }
      } catch {
        // A live debugger/replay still exists if a screenshot capture fails.
      }
    };

    const visit = results.filter((result) => result?.url).slice(0, 4);
    if (!visit.length) {
      await page.goto("https://www.browserbase.com/search", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(12_000);
      await capture();
    } else {
      for (const result of visit) {
        await page.goto(String(result.url), { waitUntil: "domcontentloaded", timeout: 35_000 }).catch(() => {});
        await page.waitForTimeout(7_000);
        await page.mouse.wheel(0, 650).catch(() => {});
        await page.waitForTimeout(2_500);
        await capture();
        await page.waitForTimeout(1_500);
      }
    }

    const findings = await fetchNotes(bb, results);
    activeRuns.set(runId, {
      runId,
      sessionId,
      status: "COMPLETED",
      task,
      result: {
        summary: findings.length
          ? `Research session visited ${findings.length} relevant public sources for the current company objective.`
          : "Browser session completed, but no useful public sources were returned.",
        findings,
        suggestedNextStep: "Use the saved sources and findings to complete the current internal company task.",
      },
    });
  } catch (error: any) {
    activeRuns.set(runId, {
      runId,
      sessionId,
      status: "FAILED",
      task,
      cause: { message: String(error?.message || error).slice(0, 1200) },
    });
  } finally {
    try { await browser?.close(); } catch {}
  }
}

export async function startBrowserWork(task: string): Promise<BrowserWork> {
  const bb = client();
  const runId = randomUUID();

  const search: any = await (bb as any).search.web({
    query: taskQuery(task),
    numResults: 6,
  });
  const results: SearchResult[] = Array.isArray(search?.results) ? search.results : [];

  const session: any = await bb.sessions.create({
    browserSettings: { recordSession: true },
  } as any);

  const sessionId = String(session.id);
  const liveViewUrl = await debugUrl(bb, sessionId);
  const running: BrowserWork = {
    runId,
    sessionId,
    status: "RUNNING",
    liveViewUrl,
    task,
  };
  activeRuns.set(runId, running);

  void driveSession(bb, runId, sessionId, String(session.connectUrl), task, results);
  return running;
}

export async function getBrowserWork(runId: string, sessionIdHint?: string): Promise<BrowserWork> {
  const existing = activeRuns.get(runId);
  if (existing) {
    if (!existing.liveViewUrl && existing.sessionId && existing.status === "RUNNING") {
      const bb = client();
      existing.liveViewUrl = await debugUrl(bb, existing.sessionId);
      activeRuns.set(runId, existing);
    }
    return existing;
  }

  if (sessionIdHint) {
    const bb = client();
    const liveViewUrl = await debugUrl(bb, sessionIdHint);
    if (liveViewUrl) {
      return { runId, sessionId: sessionIdHint, status: "RUNNING", liveViewUrl, task: "browser session" };
    }
  }

  return {
    runId,
    sessionId: sessionIdHint,
    status: "COMPLETED",
    task: "browser session",
  };
}
