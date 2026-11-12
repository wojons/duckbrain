import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

// PyYAML is also used by the release workflow's YAML validation command.
const parseWorkflow = `import json, sys, yaml
with open(sys.argv[1], encoding="utf-8") as source:
    workflow = yaml.safe_load(source)
# PyYAML's YAML 1.1 loader interprets GitHub's unquoted ` + "`on`" + ` as True.
workflow["on"] = workflow.pop(True, workflow.get("on"))
print(json.dumps(workflow))`;

describe("release workflow", () => {
  it("parses and wires npm publication to version tag pushes", () => {
    const workflow = JSON.parse(execFileSync("python3", ["-c", parseWorkflow, ".github/workflows/release.yml"], { encoding: "utf8" }));
    expect(workflow.on.push.tags).toContain("v*");
    const steps = workflow.jobs.release.steps;
    const build = steps.findIndex((step: { name?: string }) => step.name === "Build CLI for npm package");
    const publish = steps.findIndex((step: { name?: string }) => step.name === "Publish package to npm");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(build);
    expect(steps[build].run).toContain("pnpm run build:cli");
    expect(steps[publish].env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(steps[publish].run).toContain("npm publish --access public");
    expect(steps[publish].run).toContain('"v$version"');
  });
});
