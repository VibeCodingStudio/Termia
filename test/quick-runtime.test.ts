import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseQuickAskArguments } from "../extensions/termia/quick-ask.ts";
import {
  excludeTermiaExtension,
  quickBashEnabled,
  quickRuntimeOptions,
} from "../extensions/termia/quick-runtime.ts";
import { fileWorkspace, sshWorkspace } from "../extensions/termia/workspace.ts";

test("builds a cwd-bound in-memory Pi runtime from delegated arguments", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-quick-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);

  const invocation = parseQuickAskArguments([
    "--thinking",
    "high",
    "--tools",
    "read,termia_history",
    "--extension",
    "./extra.ts",
    "question",
  ]);
  const options = quickRuntimeOptions(
    { shellId: "local", cwd, argv: [] },
    invocation,
    {
      agentDir,
      projectTrusted: true,
      termiaExtensionPath: join(root, "termia.ts"),
      binding: fileWorkspace(cwd),
    },
  );

  assert.equal(options.cwd, cwd);
  assert.equal(options.sessionManager.getSessionFile(), undefined);
  assert.equal(options.settingsManager.isProjectTrusted(), true);
  assert.equal(options.thinkingLevel, "high");
  assert.deepEqual(options.tools, ["read", "termia_history"]);
  assert.equal(options.resourceLoaderOptions.noContextFiles, true);
  assert.deepEqual(options.resourceLoaderOptions.additionalExtensionPaths, ["./extra.ts"]);
});

test("maps Pi tool suppression without inventing a second tool policy", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-quick-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "cwd"));
  mkdirSync(join(root, "agent"));

  const all = quickRuntimeOptions(
    { shellId: "local", cwd: join(root, "cwd"), argv: [] },
    parseQuickAskArguments(["--no-tools", "question"]),
    {
      agentDir: join(root, "agent"),
      projectTrusted: false,
      termiaExtensionPath: "/termia.ts",
      binding: fileWorkspace(join(root, "cwd")),
    },
  );
  assert.equal(all.noTools, "all");

  const builtin = quickRuntimeOptions(
    { shellId: "local", cwd: join(root, "cwd"), argv: [] },
    parseQuickAskArguments(["--no-builtin-tools", "question"]),
    {
      agentDir: join(root, "agent"),
      projectTrusted: false,
      termiaExtensionPath: "/termia.ts",
      binding: fileWorkspace(join(root, "cwd")),
    },
  );
  assert.equal(builtin.noTools, "builtin");
});

test("enables the PTY bash replacement only when delegated Pi policy enables bash", () => {
  const base = {
    tools: undefined,
    excludeTools: undefined,
    noTools: undefined,
  };
  assert.equal(quickBashEnabled(base), true);
  assert.equal(quickBashEnabled({ ...base, tools: ["read", "bash"] }), true);
  assert.equal(quickBashEnabled({ ...base, tools: ["read"] }), false);
  assert.equal(quickBashEnabled({ ...base, excludeTools: ["bash"] }), false);
  assert.equal(quickBashEnabled({ ...base, noTools: "all" }), false);
  assert.equal(quickBashEnabled({ ...base, noTools: "builtin" }), false);
});

test("removes only the Termia extension from a nested Pi runtime", () => {
  const extensions = [
    { resolvedPath: "/extensions/termia.ts", name: "termia" },
    { resolvedPath: "/extensions/other.ts", name: "other" },
  ];
  assert.deepEqual(excludeTermiaExtension(extensions, "/extensions/termia.ts"), [extensions[1]]);
});

test("appends fixed Termia behavior without embedding SSH workspace identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-quick-ssh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const cwd = join(mountRoot, "srv/app");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir);
  const binding = sshWorkspace([{
    shellId: "host-a-shell",
    parentShellId: "local",
    destination: "host-a",
    user: "alice",
    host: "host-a",
    port: 22,
    controlPath: "/tmp/a/control",
  }], "/srv/app", mountRoot);
  const options = quickRuntimeOptions(
    { shellId: "host-a-shell", cwd, argv: [] },
    parseQuickAskArguments(["--append-system-prompt", "user addition", "question"]),
    { agentDir, projectTrusted: true, termiaExtensionPath: "/termia.ts", binding },
  );

  const additions = options.resourceLoaderOptions.appendSystemPrompt?.join("\n") ?? "";
  assert.match(additions, /user addition/);
  assert.match(additions, /Termia Operational Behavior/);
  assert.match(additions, /local Termia workspace/i);
  assert.match(additions, /SSH Termia workspace/i);
  assert.match(additions, /high-risk/i);
  assert.doesNotMatch(additions, /ssh:\/\/alice@host-a\/srv\/app/);
  assert.doesNotMatch(additions, new RegExp(mountRoot));
});
