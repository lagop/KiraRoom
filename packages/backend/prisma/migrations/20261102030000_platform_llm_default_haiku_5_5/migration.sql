-- The column default for a new platform LLM config row: Claude Haiku 5.5,
-- which production already runs. Existing rows keep the model they have.
ALTER TABLE "PlatformLlmConfig" ALTER COLUMN "defaultModel" SET DEFAULT 'claude-haiku-5-5';
