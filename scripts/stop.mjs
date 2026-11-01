#!/usr/bin/env node
import { execSync } from "node:child_process";

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function killPort(port) {
  const out = sh(`lsof -ti tcp:${port}`);
  if (!out) return;
  for (const pid of out.split("\n")) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`stopped pid ${pid} on :${port}`);
    } catch {
      // already gone
    }
  }
}

killPort(8787);
killPort(5173);

const model = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
try {
  execSync(`ollama stop ${model}`, { stdio: "ignore" });
  console.log(`unloaded ollama model ${model}`);
} catch {
  console.log(`ollama model ${model} not loaded (ok)`);
}

console.log("Latch stopped.");
