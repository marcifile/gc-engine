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
  const raw = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(raw) as FounderDecision;
}
