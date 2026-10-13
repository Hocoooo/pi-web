// Independent Node service-start seam; no HTTP/page/API request drives recovery.
import { getGlobalDispatcher } from "undici";
import { createTaskTestJiti } from "./__fixtures__/task-jiti.mjs";
const jiti = createTaskTestJiti(import.meta.url);
const { registerNodeInstrumentation } = await jiti.import("../instrumentation-node.ts");
const { waitForTaskReportExecutor, startTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
registerNodeInstrumentation();
startTaskReportExecutor();
await waitForTaskReportExecutor();
// Drain HTTP handles before natural exit; forced exit races libuv on Windows.
await getGlobalDispatcher().close();
