// Independent Node service-start seam; no HTTP/page/API request drives recovery.
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { registerNodeInstrumentation } = await jiti.import("../instrumentation-node.ts");
const { waitForTaskReportExecutor, startTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
registerNodeInstrumentation();
startTaskReportExecutor();
await waitForTaskReportExecutor();
process.exit(0);
