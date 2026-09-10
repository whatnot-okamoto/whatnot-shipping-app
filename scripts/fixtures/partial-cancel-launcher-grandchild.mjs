import { writeFileSync } from "node:fs";

const markerFile = process.argv[2];
setTimeout(() => writeFileSync(markerFile, "grandchild-survived", "utf8"), 3_500);
setInterval(() => {}, 1_000);
