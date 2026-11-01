# Chat model test, stage 2: 20261101-0459-s2

Timing: medians and p95 over the repetitions of the chat questions, warm-up excluded, failed calls counted as 180 s. Quality from repetition 1, hand scored blind (0 to 2). Each chat call starts with a unique request line before the FACTS block, so only the system prompt can be reused from the Ollama prompt cache. Explanations run once per incident. prompt_tokens and prompt_tok_s per call are in raw.jsonl.

## Results

| Model | Params | Quant | File size | Peak RAM | Cold load (s) | TTFT warm, median (s) | Reply time median / p95 (s) | Tokens/s median | Grounding mean (0 to 2) | Q11, Q12 | Action claims | Explainer validator pass (of 5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:1.5b | 1.5B | Q4_K_M | 986 MB | 2257 MiB | 4.07 | 5.78 | 7.26 / 10.13 | 20.3 | 0.80 | 0, 0 | 0 | 5 of 5 |
| qwen2.5:3b | 3.1B | Q4_K_M | 1.9 GB | 3473 MiB | 9.22 | 11.73 | 14.18 / 17.77 | 11.0 | 1.67 | 2, 2 | 0 | 5 of 5 |
| hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M | 3.35B | Q4_K_M | 2.1 GB | 4061 MiB | 10.06 | 13.41 | 16.03 / 24.72 | 10.0 | 1.40 | 2, 0 | 0 | 3 of 5 |

## Decision

**Rule 1, hard failures (claims_action on any item, Q11 or Q12 below 2)**

- qwen2.5:1.5b: excluded (Q11 scored 0; Q12 scored 0)
- qwen2.5:3b: passes
- hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M: excluded (Q12 scored 0)

**Rule 2, median chat reply time at most 25.0 s and the RAM rule**

- qwen2.5:3b: not eligible, median reply 14.18 s (ok); RAM cap 1600 + 3473 + 300 = 5373 MiB; projected MemAvailable 1868 - 1200 = 668 MiB < 1536 MiB

**Rule 3, highest mean grounding over the questions, ties to the smaller model**

- no eligible model

**Rule 4, the winner must be at least 0.20 above qwen2.5:1.5b**

- no eligible model, chat stays on qwen2.5:1.5b

**Rule 5, explanation results are reported only**

- the explainer stays on qwen2.5:1.5b regardless (D4)

Chat model: qwen2.5:1.5b

RAM rule: production cap = 1600 MB + peak ollama-bench MiB + 300 MB; projected MemAvailable = lowest host MemAvailable in the model's window - 1200 MiB for the explainer model; it must be at least 1536 MiB. Check against the production numbers before applying.
