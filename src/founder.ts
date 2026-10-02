export type FounderDecision = {
  currentTask: string;
  desk: "research" | "writing" | "numbers" | "build" | "operations" | "founder";
  reasoning: string;
  nextAction: string;
  needsBrowser?: boolean;
  needsFiles?: boolean;
  needsHuman?: boolean;
  externalAction?: {
    type: "email" | "calendar" | "drive";
    title: string;
    payload: Record<string, unknown>;
  };
  costUsd?: number;
};

function companyModel(company: unknown) {
  const value = company && typeof company === "object" ? String((company as any).founderModel || "") : "";
  const allowed = new Set([
    "anthropic/claude-sonnet-5.5",
    "openai/gpt-6.1-sol",
    "google/gemini-3.5-flash"
  ]);
  return allowed.has(value) ? value : (process.env.FOUNDER_MODEL || "anthropic/claude-sonnet-4");
}

export async function decideNextWork(company: unknown): Promise<FounderDecision> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://gc-engine-production.up.railway.app",
      "X-Title": "GC"
    },
    body: JSON.stringify({
      model: companyModel(company),
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: [
            "You are the persistent founder of a small company inside GC.",
            "The company should try to become genuinely useful and eventually earn external revenue.",
            "Choose one concrete next piece of work, not a broad plan.",
            "Use the user's notes as context, not unconditional commands.",
            "Prefer research before building when evidence is weak.",
            "Return strict JSON only with: currentTask, desk, reasoning, nextAction, needsBrowser, needsFiles, needsHuman, and optional externalAction.",
            "desk must be one of research, writing, numbers, build, operations, founder.",
            "externalAction is optional and may be exactly one of: email, calendar, drive.",
            "Only propose an externalAction when the required destination or file is already known from company context.",
            "For email use payload {to, subject, body}. For calendar use {summary, description, start, end} with ISO timestamps. For drive use {fileId}.",
            "Never propose purchases, fund transfers, contracts, account-security changes, mass outreach, or more than one external action in a run.",
            "If the company lacks the needed connected integration, do useful internal work instead."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify(company)
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenRouter failed: ${response.status} ${detail.slice(0, 500)}`);
  }

  const data: any = await response.json();
  const raw = String(data?.choices?.[0]?.message?.content || "{}").trim();
  const cleaned = raw
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "")
    .trim();

  let parsed: FounderDecision;
  try {
    parsed = JSON.parse(cleaned) as FounderDecision;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as FounderDecision;
    } else {
      throw new Error(`Founder returned invalid JSON: ${cleaned.slice(0, 500)}`);
    }
  }

  parsed.costUsd = Number(data?.usage?.cost || 0);
  return parsed;
}


export type WorkArtifact = {
  path: string;
  mimeType: "text/markdown" | "text/csv" | "application/json" | "text/plain";
  content: string;
  summary: string;
  nextStep: string;
  costUsd?: number;
};

export async function produceWorkArtifact(
  company: unknown,
  decision: FounderDecision
): Promise<WorkArtifact> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://gc-engine-production.up.railway.app",
      "X-Title": "GC"
    },
    body: JSON.stringify({
      model: process.env.WORKER_MODEL || companyModel(company),
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content: [
            "You are a specialist worker inside a small company.",
            "Produce one useful concrete artifact for the current task.",
            "Do not invent that external actions happened. Only create the file content.",
            "Choose a short workspace path under research/, product/, sales/, brand/, ops/, or build/.",
            "Return strict JSON only with path, mimeType, content, summary, nextStep.",
            "mimeType must be text/markdown, text/csv, application/json, or text/plain."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({ company, decision })
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenRouter worker failed: ${response.status} ${detail.slice(0, 500)}`);
  }

  const data: any = await response.json();
  const raw = String(data?.choices?.[0]?.message?.content || "{}").trim();
  const cleaned = raw
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);

  const mimeTypes = new Set(["text/markdown", "text/csv", "application/json", "text/plain"]);
  const mimeType = mimeTypes.has(parsed.mimeType) ? parsed.mimeType : "text/markdown";
  const fallbackExt =
    mimeType === "text/csv" ? "csv" :
    mimeType === "application/json" ? "json" :
    mimeType === "text/plain" ? "txt" : "md";
  let path = String(parsed.path || `product/work-${Date.now()}.${fallbackExt}`)
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");

  if (!/^(research|product|sales|brand|ops|build)\//.test(path)) {
    path = `product/${path}`;
  }

  return {
    path: path.slice(0, 500),
    mimeType,
    content: String(parsed.content || "").slice(0, 100000),
    summary: String(parsed.summary || decision.currentTask).slice(0, 4000),
    nextStep: String(parsed.nextStep || decision.nextAction).slice(0, 4000),
    costUsd: Number(data?.usage?.cost || 0)
  };
}
