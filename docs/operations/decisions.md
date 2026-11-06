# Bounded decisions

Authorized agents call `t3_decide` with an explicit `engine` (`jev` or `luna`), a versioned rule, shared JSON/text evidence, and named questions. Internal workflows use `DecisionService.decide` with the same contract. The models are fixed server-side to `jev-1.14.0` and `gpt-6-luna`; credentials and endpoint/model overrides are never tool arguments.

```json
{
  "engine": "jev",
  "rule": { "id": "synthetic-export-smoke", "version": "1" },
  "evidence": "Export fails in Safari. The same export succeeds in Firefox.",
  "questions": [
    { "id": "workaround", "type": "predicate", "instructions": "Does a workaround exist?" },
    {
      "id": "area",
      "type": "choice",
      "instructions": "Which area is affected?",
      "choices": [
        { "label": "export", "description": "Exporting data" },
        { "label": "billing", "description": "Payments and subscriptions" }
      ]
    },
    {
      "id": "severity",
      "type": "score",
      "instructions": "How severe is the failure?",
      "levels": [
        { "label": "cosmetic", "description": "Appearance only" },
        { "label": "workaround", "description": "Task fails but another way works" },
        { "label": "blocked", "description": "Task fails with no workaround" }
      ]
    }
  ]
}
```

For a small mixed smoke check, invoke this once with each engine. Retain only engine, requested/resolved model, adapter/rule version, digest, latency, usage/cost and synthetic answers. Keep live evidence separate from offline tests. Successful schema checks establish interoperability, not accuracy or comparative speed.

Predicate `probability` estimates truth and is never a Boolean. Choice `selectedChoiceProbability` is distinct from optional provider `confidence`. Scores retain the provider's continuous number on `0 … levels.length − 1`, with the supplied anchors; they are never rounded to a level. Probability distributions are preserved, accepting documented two-decimal rounding drift. OpenAI per-question refusals remain `refusal`; TypeSafe documents no refusal or unknown wire variant. Callers can reserve an offered choice for uncertainty. Never treat a missing answer, failed batch, refusal or low confidence as a positive decision. Results grant no authority to execute actions or skip checks.

Configure standard server environment variables `TYPESAFE_API_KEY` and `OPENAI_API_KEY`, or provision the existing secure server store entries `decision-api-key-jev` and `decision-api-key-luna` (store entries take precedence). With neither, an installed server reads the Jev key as `TYPESAFE_API_KEY` from Bitwarden Secrets through the host's `bws` wrapper (Luna has no such fallback); evaluation harnesses use the environment only. Supply app-owned keys through the deployment's secret injection; never put them in tool arguments or source files. Reads are lazy, and absent keys do not block startup. Identity comes from the authenticated T3 session, including scheduled runs. Implementation/browser profiles can use decisions; source readers, advisors, reviewers and researchers cannot. External clients need trusted project context in addition to authentication; linked read-only credentials are denied.

Limits are 128 KiB total input, 32 questions, 2–64 choices per question, 2–10 rubric levels, 1 MiB provider response, a 20-second whole-operation deadline, four active calls and 60 admissions per minute per server environment. Excess work is rejected with no queue. Each admitted batch makes at most one provider call, with no retry, alternate provider, application cache, file/URL reads or action execution. Luna requests disable implicit prompt caching. Existing provider cache counters, when present, are still reported honestly.

`DecisionError.code` distinguishes invalid input, unavailable credentials/provider, invalid provider response, transport failure, cancellation, timeout, busy and rate limit. MCP protocol cancellation and Effect fiber interruption abort the HTTP transport. Internal callers may also pass `{ signal }` to receive a `cancelled` error. A local abort never establishes that provider billing stopped; failure/cancellation usage and cost are unknown unless separately observed.

The digest uses versioned canonical JSON of the complete input, engine/model, adapter version and options; it identifies requests, not deterministic output. This feature adds no evidence/digest/secret logs or persistence. Existing caller transcripts and provider retention still apply. Unknown usage is `null`, never zero. Prices are endpoint-specific input estimates: [Jev](https://docs.typesafe.ai/models) $0.042/M and [Luna Decisions](https://developers.openai.com/api/docs/guides/decisions) $0.10/M uncached; output is free. Unknown cache-write pricing yields unknown cost; cache-read estimates use the uncached rate as an upper bound. These estimates do not include account-specific or regional premiums.
