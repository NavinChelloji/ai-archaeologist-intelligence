import { z } from "zod";
import { backendBaseEnvShape, loadEnv, portSchema, urlSchema } from "@aca/config";

const AiEnvSchema = z.object({
  ...backendBaseEnvShape,
  PORT: portSchema.default(3200),
  AI_DATABASE_URL: urlSchema,
});

export type AiEnv = z.infer<typeof AiEnvSchema>;

export function loadAiEnv(): AiEnv {
  return loadEnv(AiEnvSchema);
}
