export type FounderDecision = {
  currentTask: string;
  desk: "research" | "writing" | "numbers" | "build" | "operations" | "founder";
  reasoning: string;
  nextAction: string;
  needsBrowser?: boolean;
  needsFiles?: boolean;
  needsHuman?: boolean;
};

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
      model: process.env.FOUNDER_MODEL || "anthropic/claude-sonnet-4",
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
            "Return strict JSON only with: currentTask, desk, reasoning, nextAction, needsBrowser, needsFiles, needsHuman.",
            "desk must be one of research, writing, numbers, build, operations, founder."
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

  try {
    return JSON.parse(cleaned) as FounderDecision;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as FounderDecision;
    }
    throw new Error(`Founder returned invalid JSON: ${cleaned.slice(0, 500)}`);
  }
}


export type WorkArtifact = {
  path: string;
  mimeType: "text/markdown" | "text/csv" | "application/json" | "text/plain";
  content: string;
  summary: string;
  nextStep: string;
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
      model: process.env.WORKER_MODEL || process.env.FOUNDER_MODEL || "anthropic/claude-sonnet-4",
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
    nextStep: String(parsed.nextStep || decision.nextAction).slice(0, 4000)
  };
}
