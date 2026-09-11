import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_DATA, FIXTURE_PATTERN_IDS } from "../lib/pdf-fixture-data.ts";
import { generateShippingDocumentsPdf } from "../lib/pdf-generator.ts";
import { prepareOrderForPdf } from "../lib/pdf-order-assessment.ts";

const outputDir = process.argv[2];
if (!outputDir || !path.isAbsolute(outputDir)) {
  throw new Error("absolute output directory is required");
}
await mkdir(outputDir, { recursive: true });

for (const fixtureId of FIXTURE_PATTERN_IDS) {
  const entry = structuredClone(FIXTURE_DATA[fixtureId]);
  const prepared = prepareOrderForPdf(entry.order);
  if (prepared.assessment.generationOutcome !== "eligible") {
    throw new Error(`${fixtureId} is not eligible`);
  }
  const bytes = await generateShippingDocumentsPdf([
    { order: prepared.order, orderState: entry.orderState },
  ]);
  await writeFile(path.join(outputDir, `${fixtureId}.pdf`), bytes);
}

console.log(`rendered_fixture_count=${FIXTURE_PATTERN_IDS.length}`);
