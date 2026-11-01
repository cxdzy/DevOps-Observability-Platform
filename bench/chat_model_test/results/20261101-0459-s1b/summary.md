# Chat model test, stage 1: 20261101-0459-s1b

Timing: medians and p95 over the repetitions of the chat questions, warm-up excluded, failed calls counted as 180 s. Quality from repetition 1, hand scored blind (0 to 2). Each chat call starts with a unique request line before the FACTS block, so only the system prompt can be reused from the Ollama prompt cache. Explanations run once per incident. prompt_tokens and prompt_tok_s per call are in raw.jsonl.

## Results

| Model | Params | Quant | File size | Peak RAM | Cold load (s) | TTFT warm, median (s) | Reply time median / p95 (s) | Tokens/s median | Grounding mean (0 to 2) | Q11, Q12 | Action claims | Explainer validator pass (of 5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:1.5b | 1.5B | Q4_K_M | 986 MB | 1564 MiB | 4.06 | 5.87 | 6.98 / 7.20 | 20.7 | 0.40 | 0, - | 0 | n/a |
| llama3.2:3b | 3.2B | Q4_K_M | 2.0 GB | 2904 MiB | 10.11 | 10.29 | 13.36 / 17.71 | 9.9 | 1.20 | 2, - | 0 | n/a |
| qwen2.5:3b | 3.1B | Q4_K_M | 1.9 GB | 2245 MiB | 7.67 | 12.21 | 16.12 / 16.79 | 10.8 | 1.40 | 2, - | 0 | n/a |
| phi4-mini | 3.8B | Q4_K_M | 2.5 GB | 3296 MiB | 12.20 | 12.95 | 15.17 / 15.90 | 8.6 | 1.20 | 2, - | 0 | n/a |
| ministral-3:3b | 3.8B | Q4_K_M | 3.0 GB | 3670 MiB | 12.28 | 13.18 | 17.52 / 20.89 | 8.5 | 0.80 | 2, - | 0 | n/a |
| qwen3.5:2b | 1.9B | Q8_0 | 2.7 GB | 3222 MiB | 10.97 | 12.53 | 16.05 / 16.99 | 12.1 | 1.20 | 2, - | 0 | n/a |
| granite4:micro | 3.4B | Q4_K_M | 2.1 GB | 2651 MiB | 8.68 | 11.85 | 14.08 / 15.12 | 9.7 | 1.60 | 2, - | 0 | n/a |
| hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M | 3.35B | Q4_K_M | 2.1 GB | 3030 MiB | 10.41 | 13.12 | 15.25 / 16.07 | 10.7 | 1.40 | 2, - | 0 | n/a |
| hf.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF:Q4_K_M | 3.08B | Q4_K_M | 1.9 GB | 2488 MiB | 8.68 | 10.44 | 12.55 / 13.50 | 11.3 | 1.40 | 2, - | 0 | n/a |
| gemma3:4b | 3.9B | Q4_K_M | 3.4 GB | 4011 MiB | 15.44 | 18.49 | 32.77 / 180.00 | 8.5 | 0.80 | 2, - | 0 | n/a |
| gemma3n:e2b | n/a | n/a | n/a | n/a | n/a | n/a | n/a / n/a | n/a | n/a | -, - | 0 | n/a |

## Stage 1 screening

| Model | Params | Reply median (s) | Q11 | Q15 | Action claims | Mean score (5 questions) | Result |
|---|---|---|---|---|---|---|---|
| qwen2.5:1.5b | 1.5B | 6.98 | 0 | 0 | 0 | 0.40 | kept: baseline, always in stage 2; would have been dropped: Q11 scored 0 (below 2); Q15 scored 0 (below 2) |
| llama3.2:3b | 3.2B | 13.36 | 2 | 0 | 0 | 1.20 | dropped: Q15 scored 0 (below 2) |
| qwen2.5:3b | 3.1B | 16.12 | 2 | 2 | 0 | 1.40 | kept: rank 1 by mean score 1.40 |
| phi4-mini | 3.8B | 15.17 | 2 | 1 | 0 | 1.20 | dropped: Q15 scored 1 (below 2) |
| ministral-3:3b | 3.8B | 17.52 | 2 | 0 | 0 | 0.80 | dropped: Q15 scored 0 (below 2) |
| qwen3.5:2b | 1.9B | 16.05 | 2 | 0 | 0 | 1.20 | dropped: Q15 scored 0 (below 2) |
| granite4:micro | 3.4B | 14.08 | 2 | 1 | 0 | 1.60 | dropped: Q15 scored 1 (below 2) |
| hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M | 3.35B | 15.25 | 2 | 2 | 0 | 1.40 | kept: rank 2 by mean score 1.40 |
| hf.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF:Q4_K_M | 3.08B | 12.55 | 2 | 0 | 0 | 1.40 | dropped: Q15 scored 0 (below 2) |
| gemma3:4b | 3.9B | 32.77 | 2 | 0 | 0 | 0.80 | dropped: median reply time 32.77 s is above 25.0 s; Q15 scored 0 (below 2) |
| gemma3n:e2b | n/a | n/a | - | - | 0 | n/a | dropped: failed to pull or load |

## Decision

**Stage 1 screening rule (plan section 4)**

- qwen2.5:1.5b: kept: baseline, always in stage 2; would have been dropped: Q11 scored 0 (below 2); Q15 scored 0 (below 2)
- llama3.2:3b: dropped: Q15 scored 0 (below 2)
- qwen2.5:3b: kept: rank 1 by mean score 1.40
- phi4-mini: dropped: Q15 scored 1 (below 2)
- ministral-3:3b: dropped: Q15 scored 0 (below 2)
- qwen3.5:2b: dropped: Q15 scored 0 (below 2)
- granite4:micro: dropped: Q15 scored 1 (below 2)
- hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M: kept: rank 2 by mean score 1.40
- hf.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF:Q4_K_M: dropped: Q15 scored 0 (below 2)
- gemma3:4b: dropped: median reply time 32.77 s is above 25.0 s; Q15 scored 0 (below 2)
- gemma3n:e2b: dropped: failed to pull or load

Stage 2 models: qwen2.5:1.5b,qwen2.5:3b,hf.co/CohereLabs/tiny-aya-global-GGUF:Q4_K_M
