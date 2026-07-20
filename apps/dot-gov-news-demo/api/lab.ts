import { createVercelDemoHandler } from "./_lab.js";

export default { fetch: createVercelDemoHandler(process.env) };
