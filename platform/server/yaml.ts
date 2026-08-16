// W6-E: everything-as-YAML export. A deliberately tiny emitter — strings,
// numbers, booleans, arrays, plain objects — enough for agents, routines and
// templates. Import stays JSON (POST bodies); YAML is the human/repo format.
import type { Projections } from "./store.ts";

function yamlScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return /^[A-Za-z0-9 _.@/-]*$/.test(s) && s.trim() === s && s !== "" ? s : JSON.stringify(s);
}

function yamlNode(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return " []\n";
    let out = "\n";
    for (const item of v) {
      if (item !== null && typeof item === "object") {
        const entries = Object.entries(item as Record<string, unknown>);
        out += `${pad}-`;
        let first = true;
        for (const [k, val] of entries) {
          const prefix = first ? " " : `${pad}  `;
          out += `${prefix}${k}:${yamlEntry(val, indent + 2)}`;
          first = false;
        }
      } else {
        out += `${pad}- ${yamlScalar(item)}\n`;
      }
    }
    return out;
  }
  if (v !== null && typeof v === "object") {
    let out = "\n";
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out += `${pad}${k}:${yamlEntry(val, indent + 1)}`;
    }
    return out;
  }
  return ` ${yamlScalar(v)}\n`;
}

function yamlEntry(v: unknown, indent: number): string {
  return yamlNode(v, indent);
}

export function toYaml(doc: Record<string, unknown>): string {
  let out = "";
  for (const [k, v] of Object.entries(doc)) {
    out += `${k}:${yamlNode(v, 1)}`;
  }
  return out;
}

/** The org's portable operating config: agents, routines, templates. */
export function exportYaml(projections: Projections): string {
  return toYaml({
    version: 1,
    agents: [...projections.agents.values()].map((a) => ({
      name: a.name,
      persona: a.persona,
      driver: a.driver,
      model: a.modelPolicy.model,
      effort: a.modelPolicy.effort,
      allowTools: a.allowTools,
      ...(a.environment ? { networkAllowlist: a.environment.networkAllowlist } : {}),
    })),
    routines: [...projections.routines.values()].map((r) => ({
      name: r.name,
      prompt: r.prompt,
      schedule: r.schedule.kind === "interval" ? `every ${r.schedule.minutes}m` : "manual",
    })),
    templates: [...projections.templates.values()].map((t) => ({
      name: t.name,
      steps: t.steps.map((s) => ({
        title: s.title,
        prompt: s.prompt,
        requiresApproval: s.requiresApproval,
      })),
    })),
  });
}
