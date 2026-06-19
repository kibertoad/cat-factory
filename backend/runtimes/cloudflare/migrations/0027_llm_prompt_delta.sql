-- Delta prompt storage for the LLM observability sink. A container agent re-sends its
-- whole growing conversation on every model call, so storing each call's full prompt
-- was hugely redundant (~21× the bytes of storing the conversation once). `prompt_text`
-- now holds only the messages a call APPENDED beyond `prompt_prefix_count`; `prompt_hash`
-- is the hash of the call's full messages array, so the next call can verify it genuinely
-- extends this one before its prefix is elided. The full prompt is rebuilt on export.

ALTER TABLE llm_call_metrics ADD COLUMN prompt_prefix_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_call_metrics ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT '';
