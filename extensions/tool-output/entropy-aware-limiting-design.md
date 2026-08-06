# Entropy-Aware Tool Output Limiting Design

## Background

The current `tool-output-limiter` extension protects the model context from very long tool results by saving the full result to a temporary file and returning a shortened preview. It already separates preview policy by result type:

- non-error output keeps more head than tail;
- error output keeps more tail than head because failure details often appear near the end.

That structure should remain. The desired improvement is narrower: before applying the existing truncation path, allow long outputs that look like useful readable text, such as documentation or source files intentionally requested by the agent.

The problem is not length alone. Long logs, build listings, package lists, binary-like output, compressed/base64 payloads, and repeated machine output can waste context even when they are technically text. Conversely, long documents and source files may be exactly the information the agent asked for and should not be truncated merely because they exceed a fixed character threshold.

## Goal

Add a content-based allow gate for long outputs:

1. Keep short output behavior unchanged.
2. Keep existing truncation and preview behavior for outputs classified as noise.
3. Allow long readable, useful text when there is no strong evidence that the output is binary, encoded, extreme low-entropy, or repetitive machine output.
4. Preserve full-output saving for all truncated outputs.
5. Make the classification testable against representative samples.

## Non-Goals

- Do not replace the existing `isError` preview split.
- Do not summarize output with an LLM.
- Do not decide from tool name alone.
- Do not permanently discard original output when truncating.
- Do not attempt semantic understanding of every document type.

## Sample Strategy

Two sample layers exist because committed tests must stay small and fast, while threshold calibration benefits from larger real-world data.

### Committed Behavior Samples

Default tests use compact generated strings inside `tests/tool-output-limiter.test.ts`. They cover the stable behavior classes without committing large logs or binary payloads:

- readable long documentation should be allowed;
- repeated machine logs should be truncated;
- high-entropy encoded text should be truncated;
- lossy/binary-like text should be truncated;
- existing short-output and `isError` preview behavior should remain unchanged.

These tests should execute in well under a second on a normal local run. Do not add large fixture files to default tests.

### Local Calibration Samples

Large, realistic calibration samples are generated locally and intentionally ignored by git:

```text
tests/generated/tool-output-limiter-samples/
```

Generate and inspect them with:

```bash
bun tests/scripts/tool-output-limiter-calibration.ts
```

The script creates representative docs, source snippets, logs, listings, base64 payloads, and binary samples from the current environment when available, then prints a metric table. Use it when tuning thresholds, investigating a misclassification, or adding support for a new output class. The generated files are disposable and must not be committed.

### Calibration Acquisition Method

Calibration samples should come from the current environment when practical so they reflect realistic agent output rather than only synthetic strings.

Useful long text samples:

- local skill documents;
- pi documentation excerpts;
- real TypeScript source files.

Repetitive machine-output samples:

- `/var/log/pacman.log`;
- readable Samba logs under `/var/log/samba/`;
- generated `find` listings over installed package trees;
- `pacman -Q` package lists.

High-entropy or binary-like samples:

- random bytes;
- random bytes base64-encoded;
- gzip-compressed local docs base64-encoded;
- random bytes decoded as UTF-8 with replacement characters;
- real binary system logs such as `/var/log/wtmp` when available.

Synthetic samples are acceptable when they represent a known class that is hard to obtain safely or deterministically, such as extreme repeated characters or random binary payloads. Prefer environment-derived real samples for logs, lists, docs, and source code.

## Metrics

Classification should compute metrics only after the output exceeds `MAX_OUTPUT_CHARS`. Short output remains unchanged.

Recommended metrics:

| Metric | Purpose |
|---|---|
| `byteEntropy` | Detect extreme low entropy and high-entropy encoded/binary-like payloads. |
| `gzipRatio` | Detect compressibility. Useful only with other structure metrics. |
| `printableRatio` | Detect binary/control-character-heavy output. |
| `replacementRatio` | Detect binary data decoded as text through Unicode replacement characters. |
| `lineTemplateDupScore` | Detect repeated normalized log/message templates. |
| `shapeDupScore` | Detect repeated list/table/build-output shapes even when paths, hashes, and numbers differ. |
| `naturalTextScore` | Protect readable documentation/source-like content from being classified only by compression or repetition. |
| `rollingEntropy` | Optional guard against local anomalies and uniformly encoded data. |

### Important Metric Lessons

Do not use a single entropy threshold. Real logs and real source code can have similar byte entropy.

Do not use `gzipRatio` alone. Documentation and source code can be compressible while still being useful.

Do not use line duplication alone. Source code and generated structured files may contain repeated forms.

Do not treat printable text as safe. Base64 and compressed payloads are printable but usually poor context.

Do not rely on high entropy to detect all binary-like output. Random bytes decoded with replacement characters may show moderate byte entropy but high `replacementRatio`.

## Decision Tree

The classifier should run only for long outputs:

```text
if original.length <= MAX_OUTPUT_CHARS:
  allow
else:
  classify content
```

For long output, use this order:

```text
1. Binary / lossy text / high-entropy encoded payload
   -> truncate

2. Extreme low entropy
   -> truncate

3. Repetitive machine output
   -> truncate

4. Long readable useful text, non-error only
   -> allow

5. Fallback
   -> truncate using the existing isError preview policy
```

Ordering matters. Strong noise evidence must override the readable-text allow path.

## Classification Rules v0

These thresholds are starting points derived from calibration samples and compact behavior tests. Adjust them with evidence from both layers.

### Binary or Encoded High-Entropy Output

Truncate when any strong binary/encoded signal appears:

```text
printableRatio < 0.92
replacementRatio > 0.02
byteEntropy > 7.2
byteEntropy > 5.85 && gzipRatio > 0.55 && lineTemplateDupScore < 0.20
base64ishRatio > 0.95 && gzipRatio > 0.50
```

Rationale:

- random bytes have very high entropy and poor printability;
- lossy-decoded binary has high replacement-character ratio;
- base64/compressed data is printable but high entropy and poorly compressible.

### Extreme Low-Entropy Output

Truncate when output is almost entirely repeated or degenerate:

```text
byteEntropy < 2.0
gzipRatio < 0.01
```

Rationale: repeated characters or highly degenerate output provide little context value at large sizes.

### Repetitive Machine Output

Truncate when output is compressible, structurally repetitive, and not natural text:

```text
gzipRatio < 0.25
(lineTemplateDupScore > 0.80 || shapeDupScore > 0.80)
naturalTextScore < 0.55
```

Optional stabilizer:

```text
rollingEntropyMax - rollingEntropyMin < 1.2
```

Rationale: logs, package lists, file listings, build tables, and repeated warnings often vary by timestamp, path, hash, or number while preserving the same shape. They should be detected by normalized templates and shape duplication, not just exact duplicate lines.

### Long Readable Text Allow Gate

Allow long non-error output when it looks like readable documentation or source and no forced-truncate rule matched:

```text
!isError
printableRatio >= 0.98
replacementRatio <= 0.001
byteEntropy >= 3.2
byteEntropy <= 5.7
gzipRatio >= 0.20
naturalTextScore >= 0.55
shapeDupScore < 0.80
```

Rationale: this protects long useful documents and source files without weakening truncation of error logs or machine output.

## Error Output Policy

Keep the current error/non-error preview split. In v0, error output should not use the long-readable allow gate.

Reason: most long error output is logs, traces, build noise, or repeated diagnostics. The existing error preview already prioritizes the tail where final failure details usually appear. This conservative choice can be revisited after collecting real examples where long error output is a useful readable document.

## Fallback Policy

If a long output does not confidently match an allow case, truncate it using the existing preview mechanism.

This is intentionally conservative. The extension already saves the full original output to a file, so truncation is reversible. Incorrectly allowing noisy output is more costly to the active model context than incorrectly truncating a borderline sample whose full text remains available.

## Implementation Shape

Keep the existing extension flow:

```ts
const original = textFromContent(event.content);
if (original.length <= MAX_OUTPUT_CHARS) return;

const decision = classifyLongOutput(original, { isError: Boolean(event.isError) });
if (decision.kind === "allow") return;

const { previewText, previewPolicy } = makePreview(original, Boolean(event.isError));
return limitedMessage;
```

Recommended internal structure:

```ts
type LongOutputDecision =
  | { kind: "allow"; reason: "long_readable_text" }
  | { kind: "truncate"; reason: "binary_or_encoded" | "low_entropy" | "repetitive_machine" | "fallback" };
```

Keep metric functions small and deterministic. Avoid async work, model calls, or external commands inside `tool_result` handling.

## Testing Strategy

Default tests must stay compact, deterministic, and fast. They should not depend on large checked-in fixtures, current system logs, `node_modules` traversal, or binary dumps.

Default tests should preserve existing behavior:

- short output remains unchanged;
- truncated output is saved to the temp file;
- non-error preview keeps head-prioritized policy;
- error preview keeps tail-prioritized policy;
- default preset still loads the extension.

Default tests should also cover stable classifier classes with small generated strings:

- readable long text -> allow;
- repeated machine output -> truncate;
- high-entropy encoded output -> truncate;
- binary/lossy text -> truncate.

Large real-world samples belong in ignored local calibration output under `tests/generated/`, produced by `tests/scripts/tool-output-limiter-calibration.ts`. Use those samples to inspect metrics and tune thresholds manually, then encode only the stable distilled behavior as small default tests.

When thresholds change, update this document only if the rationale or decision tree changes. Pure numeric calibration can live in tests and constants.

## Maintenance Notes

Prefer adding or updating a compact behavior case before changing a threshold. When the issue depends on large real-world material, reproduce it first with ignored calibration samples, then distill the stable behavior into a small generated test case.

When adding calibration samples, avoid secrets and private user data. Sanitize or generate equivalents if needed.

Keep classifier defaults conservative:

```text
short output -> allow
long output with strong useful-text evidence -> allow
other long output -> truncate but save full original
```

This preserves context safety while allowing deliberate long reads to remain useful.
