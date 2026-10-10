// Fixture for the momo.float.phone sync, Check Phone batch-generation + unread badges.
// generateCheckPhoneAppBatch itself needs a live LLM call, so this drives the two real,
// exported pieces that don't: the per-app output parser (parseCheckPhoneBatchAppOutput,
// exported specifically for this) and the <<<APP:id>>>...<<<END_APP>>> section-boundary
// regex, extracted from source rather than hand-copied.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; results.push({ name, extra }); }
}

const engine = await jiti.import("./lib/checkphone-engine.ts");
const src = fs.readFileSync(path.join(__dirname, "lib/checkphone-engine.ts"), "utf8");

// ── A. parseCheckPhoneBatchAppOutput: real per-app parsers still work through the batch path ──
{
    const notesBlock = "#Notepad1\n[Title]Grocery list\n[Time]2 hours ago\n[Body]Milk, eggs, bread";
    const notesResult = engine.parseCheckPhoneBatchAppOutput("notes", notesBlock, "char1", "Alex");
    check("A1 notes: valid block parses to a real payload", Boolean(notesResult.payload) && !notesResult.error);
    check("A2 notes: summary is derived from the payload", typeof notesResult.summary === "string" && notesResult.summary.length > 0);

    const garbage = "this is not a notepad section at all";
    const failResult = engine.parseCheckPhoneBatchAppOutput("notes", garbage, "char1", "Alex");
    check("A3 notes: unparsable input returns an error, not a crash", failResult.payload === null && typeof failResult.error === "string");
    check("A4 error message names the app in English, not Chinese", /notepad|notes/i.test(failResult.error ?? "") || !/[一-鿿]/.test(failResult.error ?? ""));
}

// ── B. The <<<APP:id>>> section-boundary regex, extracted from source (not hand-copied) ──
{
    const regexMatch = src.match(/const sectionPattern = (\/<<<APP:[^;]+;)/);
    check("B0 section-boundary regex literal found in source", Boolean(regexMatch));
    // eslint-disable-next-line no-eval
    const sectionPattern = eval(regexMatch[1].replace(/;$/, ""));

    const multiAppOutput = [
        "<<<APP:notes>>>",
        "#Notepad1",
        "[Title]Grocery list",
        "[Content]Milk, eggs, bread",
        "<<<END_APP>>>",
        "<<<APP:email>>>",
        "#Inbox1",
        "[Sender]boss@example.com",
        "[Subject]Meeting moved",
        "[Body]Let's push it to 3pm.",
        "<<<END_APP>>>",
    ].join("\n");

    const sections = new Map();
    for (const match of multiAppOutput.matchAll(sectionPattern)) {
        sections.set(match[1].toLowerCase(), match[2].trim());
    }
    check("B1 both app sections extracted", sections.size === 2);
    check("B2 notes section content correctly bounded", sections.get("notes")?.includes("Grocery list") && !sections.get("notes")?.includes("boss@example.com"));
    check("B3 email section content correctly bounded", sections.get("email")?.includes("Meeting moved") && !sections.get("email")?.includes("Grocery list"));

    // Non-vacuity: a boundary typo (missing colon) must NOT match.
    const brokenOutput = "<<<APPnotes>>>\nstuff\n<<<END_APP>>>";
    const brokenSections = new Map();
    for (const match of brokenOutput.matchAll(sectionPattern)) brokenSections.set(match[1].toLowerCase(), match[2].trim());
    check("B4 non-vacuity: a malformed boundary (no colon) extracts nothing", brokenSections.size === 0);
}

// ── C. Teaching text for a multi-app batch request is English, with zero CJK ──
{
    const start = src.indexOf("This round must generate");
    const end = src.indexOf("return messages;", start);
    check("C1 batch teaching block located in source", start > -1 && end > start);
    const teachingBlock = start > -1 && end > start ? src.slice(start, end) : "";
    check("C2 batch teaching text has zero CJK", teachingBlock.length > 0 && !/[一-鿿]/.test(teachingBlock));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
