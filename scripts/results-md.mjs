// Turns a Vitest JSON report into a short Markdown summary: every test, pass or
// fail, with the reason for each failure. Usage: node scripts/results-md.mjs in.json out.md "Title"
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [input, output, title = "Test results"] = process.argv.slice(2);
const report = JSON.parse(readFileSync(input, "utf8"));
const lines = [
  `# ${title}`,
  "",
  `${report.numPassedTests} of ${report.numTotalTests} passed, ${report.numFailedTests} failed. Run ${new Date(report.startTime).toISOString()}.`,
  "",
];
for (const file of report.testResults) {
  lines.push(`## ${path.relative(process.cwd(), file.name)}`, "", "| Group | Test | Result | Why it failed |", "|---|---|---|---|");
  for (const test of file.assertionResults) {
    const why = (test.failureMessages[0] ?? "").split("\n")[0].replace(/\|/g, "\\|").slice(0, 200);
    lines.push(`| ${test.ancestorTitles.join(" > ")} | ${test.title.replace(/\|/g, "\\|")} | ${test.status === "passed" ? "pass" : "FAIL"} | ${why} |`);
  }
  lines.push("");
}
writeFileSync(output, lines.join("\n"));
console.log(`wrote ${output}`);
