import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReadOnlyCommand } from "../pi-extension/subagents/tools/read-only-bash.ts";

function allowed(command: string): void {
  assert.equal(checkReadOnlyCommand(command), null, `expected allowed: ${command}`);
}

function blocked(command: string, hint?: RegExp): void {
  const reason = checkReadOnlyCommand(command);
  assert.ok(reason, `expected blocked: ${command}`);
  if (hint) assert.match(reason, hint);
}

test("allows inspection commands", () => {
  allowed("ls -la");
  allowed("git status --short");
  allowed("git log --oneline -20");
  allowed("git diff HEAD~1 -- src/auth.ts");
  allowed("git diff -U5 HEAD");
  allowed("git log -n20 --oneline");
  allowed("git branch --list main");
  allowed("git branch -a");
  allowed("wc -l src/auth.ts");
  allowed("find src -name '*.ts'");
  allowed("find . -type f -name '*.ts'");
  allowed("sort src/words.txt | uniq -c");
  allowed("grep -o 'foo' src/auth.ts");
  allowed("grep -rn 'verifyToken' src");
  allowed("cat src/auth.ts");
  allowed("head -n 20 src/auth.ts");
  allowed("tail -n 20 src/auth.ts");
  allowed("cut -d: -f1 /etc/passwd");
  allowed("tr -d 'x'");
  allowed("nl -ba src/auth.ts");
  allowed("stat -c %s src/auth.ts");
  allowed("du -s -h src");
  allowed("diff -u a.ts b.ts");
  allowed("echo hello");
  allowed("pwd -P");
  allowed("realpath src/auth.ts");
  allowed("basename src/auth.ts");
  allowed("dirname src/auth.ts");
  allowed("which node");
  allowed("md5sum src/auth.ts");
  allowed("sha256sum src/auth.ts");
  allowed("comm -12 a.txt b.txt");
});

test("blocks every way to write through the shell", () => {
  blocked("echo hi > src/auth.ts", /redirection/);
  blocked("cat a >> b", /redirection/);
  blocked("find . -name '*.ts' -delete", /-exec\/-delete/);
  blocked("find . -exec rm {} \\;");
  blocked("rm src/auth.ts", /not an allowed inspection command/);
  blocked("touch new.ts", /not an allowed inspection command/);
  blocked("tee out.txt", /not an allowed inspection command/);
  blocked("npm install", /not an allowed inspection command/);
  blocked("node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'", /not an allowed inspection command/);
  blocked("awk '{print \"x\"}' file", /not an allowed inspection command/);
  blocked("ls; rm -rf src", /chaining/);
  blocked("ls && rm src", /chaining/);
  blocked("cat $(echo /etc/passwd)", /command substitution/);
  blocked("cat `whoami`", /command substitution/);
  blocked("sort -o sorted.txt src/words.txt", /writes a file/);
  blocked("uniq src/a.txt src/b.txt", /output file/);
});

test("removed commands are blocked entirely", () => {
  blocked("rg 'TODO' src", /not an allowed inspection command/);
  blocked("rg -n 'x' src", /not an allowed inspection command/);
  blocked("rg --pre sh foo .", /not an allowed inspection command/);
  blocked("sed -n '1,80p' src/auth.ts", /not an allowed inspection command/);
  blocked("sed -n '/function/p' src/auth.ts", /not an allowed inspection command/);
  blocked("sed -i 's/a/b/' src/auth.ts", /not an allowed inspection command/);
  blocked("sed --in-place 's/a/b/' src/auth.ts", /not an allowed inspection command/);
  blocked("sed -n '1,5w out.txt' src/auth.ts", /not an allowed inspection command/);
  blocked("jq -n env", /not an allowed inspection command/);
  blocked("tree -ofoo", /not an allowed inspection command/);
  blocked("file src/auth.ts", /not an allowed inspection command/);
});

test("blocks attached and abbreviated write forms", () => {
  blocked("sed -i.bak s/a/b/ f", /not an allowed inspection command/);
  blocked("sed -Ei 's/a/b/' f", /not an allowed inspection command/);
  blocked("sed -n \"s/a/b/gw out\" f", /not an allowed inspection command/);
  blocked("sed -n p -e \"w out\" f", /not an allowed inspection command/);
  blocked("sort -ofoo in", /writes a file/);
  blocked("sort --out=foo in", /writes a file/);
  blocked("sort --compress-program sh in", /external program/);
  blocked("find . -fls out", /would modify files/);
  blocked("find . -fprint out", /would modify files/);
  blocked("find . -fprint0 out", /would modify files/);
  blocked("find . -fprintf out '%p'", /would modify files/);
  blocked("find . -execdir cat {} +", /modify files/);
});

test("blocks git commands that write or run programs", () => {
  blocked("git checkout main", /not a read-only git subcommand/);
  blocked("git commit -m x", /not a read-only git subcommand/);
  blocked("git reset --hard", /not a read-only git subcommand/);
  blocked("git push", /not a read-only git subcommand/);
  blocked("git branch feature-x", /not a listing/);
  blocked("git branch -v add", /not a listing/);
  blocked("git branch -D main", /can modify refs/);
  blocked("git tag v1.0.0", /not a listing/);
  blocked("git diff --output=patch.diff", /writes a file/);
  blocked("git diff --out=foo", /writes a file/);
  blocked("git log --out=foo", /writes a file/);
  blocked("git diff --ext-diff", /external program/);
  blocked("git show --textconv HEAD", /external program/);
  blocked("git diff -O/tmp/x HEAD", /external program/);
  blocked("git -c core.pager=sh status", /external program/);
  blocked("git --config-env=diff.external=FOO diff", /external program/);
  blocked("git diff --config=core.pager=sh HEAD", /not an allowed inspection command|external program/);
  blocked("git grep -O\"touch /tmp/x\" foo", /not a read-only git subcommand/);
  blocked("git remote -v add x URL", /not a read-only git subcommand/);
  blocked("git status --unknown-flag", /unknown flag/);
});

test("blocks executable paths, unlisted flags, and environment dumps", () => {
  blocked("./cat x", /executable paths are not allowed/);
  blocked("/tmp/git status", /executable paths are not allowed/);
  blocked("../bin/ls -la", /executable paths are not allowed/);
  blocked("cat /proc/self/environ", /environment secrets/);
  blocked("cat proc/self/environ", /environment secrets/);
  blocked("cat /proc/1234/environ", /environment secrets/);
  blocked("grep X /proc/thread-self/environ", /environment secrets/);
  blocked("ls --definitely-not-a-flag", /unknown flag/);
  blocked("find . -fls out", /would modify files/);
});
