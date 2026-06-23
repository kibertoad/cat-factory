-- Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom
-- OpenAI-compatible runners). A runner lives on the user's own machine, so endpoints are
-- scoped to the user and resolved by the run initiator at execution time. The optional
-- bearer key is stored system-key-encrypted (`api_key_cipher`); `models` is a JSON array
-- of the model ids the user enabled from that runner.
CREATE TABLE local_model_endpoints (
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,        -- runner type: ollama | lmstudio | llamacpp | vllm | custom
  label          TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_cipher TEXT,                 -- system-key ciphertext of an optional bearer key (NULL = keyless)
  models         TEXT NOT NULL,        -- JSON array of enabled model ids
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
