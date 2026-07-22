import { createServerActionErrorResponse } from "../src/index.js";

createServerActionErrorResponse({ message: "Legacy public error." });
createServerActionErrorResponse({
  code: "POST_CONFLICT",
  message: "Could not save post.",
});
