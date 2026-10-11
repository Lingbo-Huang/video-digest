#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "bridge-config.json"), "utf8"),
  );
  const headers = {
    "Content-Type": "application/json",
    "X-YouTube-Digest-Token": config.token,
  };
  const response = await fetch(`http://${config.host}:${config.port}/v1/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      taskType: "translation",
      messages: [
        {
          role: "system",
          content: "Return a tiny valid JSON object with the requested value.",
        },
        {
          role: "user",
          content: "Use exactly this semantic value: local-bridge-ok",
        },
      ],
      maxTokens: 128,
      responseFormat: { type: "json_object" },
    }),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !body?.job?.id) {
    throw new Error(body?.error || "Unexpected local bridge response");
  }
  let job = body.job;
  const deadline = Date.now() + 185_000;
  while (!new Set(["completed", "failed"]).has(job.status)) {
    if (Date.now() >= deadline) throw new Error("Async local bridge task timed out");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const statusResponse = await fetch(
      `http://${config.host}:${config.port}/v1/jobs/${job.id}`,
      { headers },
    );
    const statusBody = await statusResponse.json();
    if (!statusResponse.ok || statusBody?.ok !== true) {
      throw new Error(statusBody?.error || "Could not read local bridge task");
    }
    job = statusBody.job;
  }
  if (job.status !== "completed" || !/local-bridge-ok/.test(job.text)) {
    throw new Error(job.error || "Unexpected local bridge task response");
  }
  process.stdout.write("Local Codex bridge smoke test passed.\n");
}

main().catch((error) => {
  process.stderr.write(`Local Codex bridge smoke test failed: ${error.message}\n`);
  process.exitCode = 1;
});
