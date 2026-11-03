// src/index.ts
import { mkdir as mkdir2, readFile as readFile5 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join5, resolve as resolve3 } from "node:path";

// src/builtin.ts
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/builtin.generated.ts
var BUILTIN_DIGEST = "16d65186235fc06f";
var BUILTIN_SKILLS = {
  "skill-creator": {
    "agents/analyzer.md": {
      "text": `# Post-hoc Analyzer Agent

Analyze blind comparison results to understand WHY the winner won and generate improvement suggestions.

## Role

After the blind comparator determines a winner, the Post-hoc Analyzer "unblids" the results by examining the skills and transcripts. The goal is to extract actionable insights: what made the winner better, and how can the loser be improved?

## Inputs

You receive these parameters in your prompt:

- **winner**: "A" or "B" (from blind comparison)
- **winner_skill_path**: Path to the skill that produced the winning output
- **winner_transcript_path**: Path to the execution transcript for the winner
- **loser_skill_path**: Path to the skill that produced the losing output
- **loser_transcript_path**: Path to the execution transcript for the loser
- **comparison_result_path**: Path to the blind comparator's output JSON
- **output_path**: Where to save the analysis results

## Process

### Step 1: Read Comparison Result

1. Read the blind comparator's output at comparison_result_path
2. Note the winning side (A or B), the reasoning, and any scores
3. Understand what the comparator valued in the winning output

### Step 2: Read Both Skills

1. Read the winner skill's SKILL.md and key referenced files
2. Read the loser skill's SKILL.md and key referenced files
3. Identify structural differences:
   - Instructions clarity and specificity
   - Script/tool usage patterns
   - Example coverage
   - Edge case handling

### Step 3: Read Both Transcripts

1. Read the winner's transcript
2. Read the loser's transcript
3. Compare execution patterns:
   - How closely did each follow their skill's instructions?
   - What tools were used differently?
   - Where did the loser diverge from optimal behavior?
   - Did either encounter errors or make recovery attempts?

### Step 4: Analyze Instruction Following

For each transcript, evaluate:
- Did the agent follow the skill's explicit instructions?
- Did the agent use the skill's provided tools/scripts?
- Were there missed opportunities to leverage skill content?
- Did the agent add unnecessary steps not in the skill?

Score instruction following 1-10 and note specific issues.

### Step 5: Identify Winner Strengths

Determine what made the winner better:
- Clearer instructions that led to better behavior?
- Better scripts/tools that produced better output?
- More comprehensive examples that guided edge cases?
- Better error handling guidance?

Be specific. Quote from skills/transcripts where relevant.

### Step 6: Identify Loser Weaknesses

Determine what held the loser back:
- Ambiguous instructions that led to suboptimal choices?
- Missing tools/scripts that forced workarounds?
- Gaps in edge case coverage?
- Poor error handling that caused failures?

### Step 7: Generate Improvement Suggestions

Based on the analysis, produce actionable suggestions for improving the loser skill:
- Specific instruction changes to make
- Tools/scripts to add or modify
- Examples to include
- Edge cases to address

Prioritize by impact. Focus on changes that would have changed the outcome.

### Step 8: Write Analysis Results

Save structured analysis to \`{output_path}\`.

## Output Format

Write a JSON file with this structure:

\`\`\`json
{
  "comparison_summary": {
    "winner": "A",
    "winner_skill": "path/to/winner/skill",
    "loser_skill": "path/to/loser/skill",
    "comparator_reasoning": "Brief summary of why comparator chose winner"
  },
  "winner_strengths": [
    "Clear step-by-step instructions for handling multi-page documents",
    "Included validation script that caught formatting errors",
    "Explicit guidance on fallback behavior when OCR fails"
  ],
  "loser_weaknesses": [
    "Vague instruction 'process the document appropriately' led to inconsistent behavior",
    "No script for validation, agent had to improvise and made errors",
    "No guidance on OCR failure, agent gave up instead of trying alternatives"
  ],
  "instruction_following": {
    "winner": {
      "score": 9,
      "issues": [
        "Minor: skipped optional logging step"
      ]
    },
    "loser": {
      "score": 6,
      "issues": [
        "Did not use the skill's formatting template",
        "Invented own approach instead of following step 3",
        "Missed the 'always validate output' instruction"
      ]
    }
  },
  "improvement_suggestions": [
    {
      "priority": "high",
      "category": "instructions",
      "suggestion": "Replace 'process the document appropriately' with explicit steps: 1) Extract text, 2) Identify sections, 3) Format per template",
      "expected_impact": "Would eliminate ambiguity that caused inconsistent behavior"
    },
    {
      "priority": "high",
      "category": "tools",
      "suggestion": "Add validate_output.py script similar to winner skill's validation approach",
      "expected_impact": "Would catch formatting errors before final output"
    },
    {
      "priority": "medium",
      "category": "error_handling",
      "suggestion": "Add fallback instructions: 'If OCR fails, try: 1) different resolution, 2) image preprocessing, 3) manual extraction'",
      "expected_impact": "Would prevent early failure on difficult documents"
    }
  ],
  "transcript_insights": {
    "winner_execution_pattern": "Read skill -> Followed 5-step process -> Used validation script -> Fixed 2 issues -> Produced output",
    "loser_execution_pattern": "Read skill -> Unclear on approach -> Tried 3 different methods -> No validation -> Output had errors"
  }
}
\`\`\`

## Guidelines

- **Be specific**: Quote from skills and transcripts, don't just say "instructions were unclear"
- **Be actionable**: Suggestions should be concrete changes, not vague advice
- **Focus on skill improvements**: The goal is to improve the losing skill, not critique the agent
- **Prioritize by impact**: Which changes would most likely have changed the outcome?
- **Consider causation**: Did the skill weakness actually cause the worse output, or is it incidental?
- **Stay objective**: Analyze what happened, don't editorialize
- **Think about generalization**: Would this improvement help on other evals too?

## Categories for Suggestions

Use these categories to organize improvement suggestions:

| Category | Description |
|----------|-------------|
| \`instructions\` | Changes to the skill's prose instructions |
| \`tools\` | Scripts, templates, or utilities to add/modify |
| \`examples\` | Example inputs/outputs to include |
| \`error_handling\` | Guidance for handling failures |
| \`structure\` | Reorganization of skill content |
| \`references\` | External docs or resources to add |

## Priority Levels

- **high**: Would likely change the outcome of this comparison
- **medium**: Would improve quality but may not change win/loss
- **low**: Nice to have, marginal improvement

---

# Analyzing Benchmark Results

When analyzing benchmark results, the analyzer's purpose is to **surface patterns and anomalies** across multiple runs, not suggest skill improvements.

## Role

Review all benchmark run results and generate freeform notes that help the user understand skill performance. Focus on patterns that wouldn't be visible from aggregate metrics alone.

## Inputs

You receive these parameters in your prompt:

- **benchmark_data_path**: Path to the in-progress benchmark.json with all run results
- **skill_path**: Path to the skill being benchmarked
- **output_path**: Where to save the notes (as JSON array of strings)

## Process

### Step 1: Read Benchmark Data

1. Read the benchmark.json containing all run results
2. Note the configurations tested (with_skill, without_skill)
3. Understand the run_summary aggregates already calculated

### Step 2: Analyze Per-Assertion Patterns

For each expectation across all runs:
- Does it **always pass** in both configurations? (may not differentiate skill value)
- Does it **always fail** in both configurations? (may be broken or beyond capability)
- Does it **always pass with skill but fail without**? (skill clearly adds value here)
- Does it **always fail with skill but pass without**? (skill may be hurting)
- Is it **highly variable**? (flaky expectation or non-deterministic behavior)

### Step 3: Analyze Cross-Eval Patterns

Look for patterns across evals:
- Are certain eval types consistently harder/easier?
- Do some evals show high variance while others are stable?
- Are there surprising results that contradict expectations?

### Step 4: Analyze Metrics Patterns

Look at time_seconds, tokens, tool_calls:
- Does the skill significantly increase execution time?
- Is there high variance in resource usage?
- Are there outlier runs that skew the aggregates?

### Step 5: Generate Notes

Write freeform observations as a list of strings. Each note should:
- State a specific observation
- Be grounded in the data (not speculation)
- Help the user understand something the aggregate metrics don't show

Examples:
- "Assertion 'Output is a PDF file' passes 100% in both configurations - may not differentiate skill value"
- "Eval 3 shows high variance (50% \xB1 40%) - run 2 had an unusual failure that may be flaky"
- "Without-skill runs consistently fail on table extraction expectations (0% pass rate)"
- "Skill adds 13s average execution time but improves pass rate by 50%"
- "Token usage is 80% higher with skill, primarily due to script output parsing"
- "All 3 without-skill runs for eval 1 produced empty output"

### Step 6: Write Notes

Save notes to \`{output_path}\` as a JSON array of strings:

\`\`\`json
[
  "Assertion 'Output is a PDF file' passes 100% in both configurations - may not differentiate skill value",
  "Eval 3 shows high variance (50% \xB1 40%) - run 2 had an unusual failure",
  "Without-skill runs consistently fail on table extraction expectations",
  "Skill adds 13s average execution time but improves pass rate by 50%"
]
\`\`\`

## Guidelines

**DO:**
- Report what you observe in the data
- Be specific about which evals, expectations, or runs you're referring to
- Note patterns that aggregate metrics would hide
- Provide context that helps interpret the numbers

**DO NOT:**
- Suggest improvements to the skill (that's for the improvement step, not benchmarking)
- Make subjective quality judgments ("the output was good/bad")
- Speculate about causes without evidence
- Repeat information already in the run_summary aggregates
`,
      "mode": 420
    },
    "agents/comparator.md": {
      "text": '# Blind Comparator Agent\n\nCompare two outputs WITHOUT knowing which skill produced them.\n\n## Role\n\nThe Blind Comparator judges which output better accomplishes the eval task. You receive two outputs labeled A and B, but you do NOT know which skill produced which. This prevents bias toward a particular skill or approach.\n\nYour judgment is based purely on output quality and task completion.\n\n## Inputs\n\nYou receive these parameters in your prompt:\n\n- **output_a_path**: Path to the first output file or directory\n- **output_b_path**: Path to the second output file or directory\n- **eval_prompt**: The original task/prompt that was executed\n- **expectations**: List of expectations to check (optional - may be empty)\n\n## Process\n\n### Step 1: Read Both Outputs\n\n1. Examine output A (file or directory)\n2. Examine output B (file or directory)\n3. Note the type, structure, and content of each\n4. If outputs are directories, examine all relevant files inside\n\n### Step 2: Understand the Task\n\n1. Read the eval_prompt carefully\n2. Identify what the task requires:\n   - What should be produced?\n   - What qualities matter (accuracy, completeness, format)?\n   - What would distinguish a good output from a poor one?\n\n### Step 3: Generate Evaluation Rubric\n\nBased on the task, generate a rubric with two dimensions:\n\n**Content Rubric** (what the output contains):\n| Criterion | 1 (Poor) | 3 (Acceptable) | 5 (Excellent) |\n|-----------|----------|----------------|---------------|\n| Correctness | Major errors | Minor errors | Fully correct |\n| Completeness | Missing key elements | Mostly complete | All elements present |\n| Accuracy | Significant inaccuracies | Minor inaccuracies | Accurate throughout |\n\n**Structure Rubric** (how the output is organized):\n| Criterion | 1 (Poor) | 3 (Acceptable) | 5 (Excellent) |\n|-----------|----------|----------------|---------------|\n| Organization | Disorganized | Reasonably organized | Clear, logical structure |\n| Formatting | Inconsistent/broken | Mostly consistent | Professional, polished |\n| Usability | Difficult to use | Usable with effort | Easy to use |\n\nAdapt criteria to the specific task. For example:\n- PDF form \u2192 "Field alignment", "Text readability", "Data placement"\n- Document \u2192 "Section structure", "Heading hierarchy", "Paragraph flow"\n- Data output \u2192 "Schema correctness", "Data types", "Completeness"\n\n### Step 4: Evaluate Each Output Against the Rubric\n\nFor each output (A and B):\n\n1. **Score each criterion** on the rubric (1-5 scale)\n2. **Calculate dimension totals**: Content score, Structure score\n3. **Calculate overall score**: Average of dimension scores, scaled to 1-10\n\n### Step 5: Check Assertions (if provided)\n\nIf expectations are provided:\n\n1. Check each expectation against output A\n2. Check each expectation against output B\n3. Count pass rates for each output\n4. Use expectation scores as secondary evidence (not the primary decision factor)\n\n### Step 6: Determine the Winner\n\nCompare A and B based on (in priority order):\n\n1. **Primary**: Overall rubric score (content + structure)\n2. **Secondary**: Assertion pass rates (if applicable)\n3. **Tiebreaker**: If truly equal, declare a TIE\n\nBe decisive - ties should be rare. One output is usually better, even if marginally.\n\n### Step 7: Write Comparison Results\n\nSave results to a JSON file at the path specified (or `comparison.json` if not specified).\n\n## Output Format\n\nWrite a JSON file with this structure:\n\n```json\n{\n  "winner": "A",\n  "reasoning": "Output A provides a complete solution with proper formatting and all required fields. Output B is missing the date field and has formatting inconsistencies.",\n  "rubric": {\n    "A": {\n      "content": {\n        "correctness": 5,\n        "completeness": 5,\n        "accuracy": 4\n      },\n      "structure": {\n        "organization": 4,\n        "formatting": 5,\n        "usability": 4\n      },\n      "content_score": 4.7,\n      "structure_score": 4.3,\n      "overall_score": 9.0\n    },\n    "B": {\n      "content": {\n        "correctness": 3,\n        "completeness": 2,\n        "accuracy": 3\n      },\n      "structure": {\n        "organization": 3,\n        "formatting": 2,\n        "usability": 3\n      },\n      "content_score": 2.7,\n      "structure_score": 2.7,\n      "overall_score": 5.4\n    }\n  },\n  "output_quality": {\n    "A": {\n      "score": 9,\n      "strengths": ["Complete solution", "Well-formatted", "All fields present"],\n      "weaknesses": ["Minor style inconsistency in header"]\n    },\n    "B": {\n      "score": 5,\n      "strengths": ["Readable output", "Correct basic structure"],\n      "weaknesses": ["Missing date field", "Formatting inconsistencies", "Partial data extraction"]\n    }\n  },\n  "expectation_results": {\n    "A": {\n      "passed": 4,\n      "total": 5,\n      "pass_rate": 0.80,\n      "details": [\n        {"text": "Output includes name", "passed": true},\n        {"text": "Output includes date", "passed": true},\n        {"text": "Format is PDF", "passed": true},\n        {"text": "Contains signature", "passed": false},\n        {"text": "Readable text", "passed": true}\n      ]\n    },\n    "B": {\n      "passed": 3,\n      "total": 5,\n      "pass_rate": 0.60,\n      "details": [\n        {"text": "Output includes name", "passed": true},\n        {"text": "Output includes date", "passed": false},\n        {"text": "Format is PDF", "passed": true},\n        {"text": "Contains signature", "passed": false},\n        {"text": "Readable text", "passed": true}\n      ]\n    }\n  }\n}\n```\n\nIf no expectations were provided, omit the `expectation_results` field entirely.\n\n## Field Descriptions\n\n- **winner**: "A", "B", or "TIE"\n- **reasoning**: Clear explanation of why the winner was chosen (or why it\'s a tie)\n- **rubric**: Structured rubric evaluation for each output\n  - **content**: Scores for content criteria (correctness, completeness, accuracy)\n  - **structure**: Scores for structure criteria (organization, formatting, usability)\n  - **content_score**: Average of content criteria (1-5)\n  - **structure_score**: Average of structure criteria (1-5)\n  - **overall_score**: Combined score scaled to 1-10\n- **output_quality**: Summary quality assessment\n  - **score**: 1-10 rating (should match rubric overall_score)\n  - **strengths**: List of positive aspects\n  - **weaknesses**: List of issues or shortcomings\n- **expectation_results**: (Only if expectations provided)\n  - **passed**: Number of expectations that passed\n  - **total**: Total number of expectations\n  - **pass_rate**: Fraction passed (0.0 to 1.0)\n  - **details**: Individual expectation results\n\n## Guidelines\n\n- **Stay blind**: DO NOT try to infer which skill produced which output. Judge purely on output quality.\n- **Be specific**: Cite specific examples when explaining strengths and weaknesses.\n- **Be decisive**: Choose a winner unless outputs are genuinely equivalent.\n- **Output quality first**: Assertion scores are secondary to overall task completion.\n- **Be objective**: Don\'t favor outputs based on style preferences; focus on correctness and completeness.\n- **Explain your reasoning**: The reasoning field should make it clear why you chose the winner.\n- **Handle edge cases**: If both outputs fail, pick the one that fails less badly. If both are excellent, pick the one that\'s marginally better.\n',
      "mode": 420
    },
    "agents/grader.md": {
      "text": '# Grader Agent\n\nEvaluate expectations against an execution transcript and outputs.\n\n## Role\n\nThe Grader reviews a transcript and output files, then determines whether each expectation passes or fails. Provide clear evidence for each judgment.\n\nYou have two jobs: grade the outputs, and critique the evals themselves. A passing grade on a weak assertion is worse than useless \u2014 it creates false confidence. When you notice an assertion that\'s trivially satisfied, or an important outcome that no assertion checks, say so.\n\n## Inputs\n\nYou receive these parameters in your prompt:\n\n- **expectations**: List of expectations to evaluate (strings)\n- **transcript_path**: Path to the execution transcript (markdown file)\n- **outputs_dir**: Directory containing output files from execution\n\n## Process\n\n### Step 1: Read the Transcript\n\n1. Read the transcript file completely\n2. Note the eval prompt, execution steps, and final result\n3. Identify any issues or errors documented\n\n### Step 2: Examine Output Files\n\n1. List files in outputs_dir\n2. Read/examine each file relevant to the expectations. If outputs aren\'t plain text, use the inspection tools provided in your prompt \u2014 don\'t rely solely on what the transcript says the executor produced.\n3. Note contents, structure, and quality\n\n### Step 3: Evaluate Each Assertion\n\nFor each expectation:\n\n1. **Search for evidence** in the transcript and outputs\n2. **Determine verdict**:\n   - **PASS**: Clear evidence the expectation is true AND the evidence reflects genuine task completion, not just surface-level compliance\n   - **FAIL**: No evidence, or evidence contradicts the expectation, or the evidence is superficial (e.g., correct filename but empty/wrong content)\n3. **Cite the evidence**: Quote the specific text or describe what you found\n\n### Step 4: Extract and Verify Claims\n\nBeyond the predefined expectations, extract implicit claims from the outputs and verify them:\n\n1. **Extract claims** from the transcript and outputs:\n   - Factual statements ("The form has 12 fields")\n   - Process claims ("Used pypdf to fill the form")\n   - Quality claims ("All fields were filled correctly")\n\n2. **Verify each claim**:\n   - **Factual claims**: Can be checked against the outputs or external sources\n   - **Process claims**: Can be verified from the transcript\n   - **Quality claims**: Evaluate whether the claim is justified\n\n3. **Flag unverifiable claims**: Note claims that cannot be verified with available information\n\nThis catches issues that predefined expectations might miss.\n\n### Step 5: Read User Notes\n\nIf `{outputs_dir}/user_notes.md` exists:\n1. Read it and note any uncertainties or issues flagged by the executor\n2. Include relevant concerns in the grading output\n3. These may reveal problems even when expectations pass\n\n### Step 6: Critique the Evals\n\nAfter grading, consider whether the evals themselves could be improved. Only surface suggestions when there\'s a clear gap.\n\nGood suggestions test meaningful outcomes \u2014 assertions that are hard to satisfy without actually doing the work correctly. Think about what makes an assertion *discriminating*: it passes when the skill genuinely succeeds and fails when it doesn\'t.\n\nSuggestions worth raising:\n- An assertion that passed but would also pass for a clearly wrong output (e.g., checking filename existence but not file content)\n- An important outcome you observed \u2014 good or bad \u2014 that no assertion covers at all\n- An assertion that can\'t actually be verified from the available outputs\n\nKeep the bar high. The goal is to flag things the eval author would say "good catch" about, not to nitpick every assertion.\n\n### Step 7: Write Grading Results\n\nSave results to `{outputs_dir}/../grading.json` (sibling to outputs_dir).\n\n## Grading Criteria\n\n**PASS when**:\n- The transcript or outputs clearly demonstrate the expectation is true\n- Specific evidence can be cited\n- The evidence reflects genuine substance, not just surface compliance (e.g., a file exists AND contains correct content, not just the right filename)\n\n**FAIL when**:\n- No evidence found for the expectation\n- Evidence contradicts the expectation\n- The expectation cannot be verified from available information\n- The evidence is superficial \u2014 the assertion is technically satisfied but the underlying task outcome is wrong or incomplete\n- The output appears to meet the assertion by coincidence rather than by actually doing the work\n\n**When uncertain**: The burden of proof to pass is on the expectation.\n\n### Step 8: Read Executor Metrics and Timing\n\n1. If `{outputs_dir}/metrics.json` exists, read it and include in grading output\n2. If `{outputs_dir}/../timing.json` exists, read it and include timing data\n\n## Output Format\n\nWrite a JSON file with this structure:\n\n```json\n{\n  "expectations": [\n    {\n      "text": "The output includes the name \'John Smith\'",\n      "passed": true,\n      "evidence": "Found in transcript Step 3: \'Extracted names: John Smith, Sarah Johnson\'"\n    },\n    {\n      "text": "The spreadsheet has a SUM formula in cell B10",\n      "passed": false,\n      "evidence": "No spreadsheet was created. The output was a text file."\n    },\n    {\n      "text": "The assistant used the skill\'s OCR script",\n      "passed": true,\n      "evidence": "Transcript Step 2 shows: \'Tool: Bash - python ocr_script.py image.png\'"\n    }\n  ],\n  "summary": {\n    "passed": 2,\n    "failed": 1,\n    "total": 3,\n    "pass_rate": 0.67\n  },\n  "execution_metrics": {\n    "tool_calls": {\n      "Read": 5,\n      "Write": 2,\n      "Bash": 8\n    },\n    "total_tool_calls": 15,\n    "total_steps": 6,\n    "errors_encountered": 0,\n    "output_chars": 12450,\n    "transcript_chars": 3200\n  },\n  "timing": {\n    "executor_duration_seconds": 165.0,\n    "grader_duration_seconds": 26.0,\n    "total_duration_seconds": 191.0\n  },\n  "claims": [\n    {\n      "claim": "The form has 12 fillable fields",\n      "type": "factual",\n      "verified": true,\n      "evidence": "Counted 12 fields in field_info.json"\n    },\n    {\n      "claim": "All required fields were populated",\n      "type": "quality",\n      "verified": false,\n      "evidence": "Reference section was left blank despite data being available"\n    }\n  ],\n  "user_notes_summary": {\n    "uncertainties": ["Used 2023 data, may be stale"],\n    "needs_review": [],\n    "workarounds": ["Fell back to text overlay for non-fillable fields"]\n  },\n  "eval_feedback": {\n    "suggestions": [\n      {\n        "assertion": "The output includes the name \'John Smith\'",\n        "reason": "A hallucinated document that mentions the name would also pass \u2014 consider checking it appears as the primary contact with matching phone and email from the input"\n      },\n      {\n        "reason": "No assertion checks whether the extracted phone numbers match the input \u2014 I observed incorrect numbers in the output that went uncaught"\n      }\n    ],\n    "overall": "Assertions check presence but not correctness. Consider adding content verification."\n  }\n}\n```\n\n## Field Descriptions\n\n- **expectations**: Array of graded expectations\n  - **text**: The original expectation text\n  - **passed**: Boolean - true if expectation passes\n  - **evidence**: Specific quote or description supporting the verdict\n- **summary**: Aggregate statistics\n  - **passed**: Count of passed expectations\n  - **failed**: Count of failed expectations\n  - **total**: Total expectations evaluated\n  - **pass_rate**: Fraction passed (0.0 to 1.0)\n- **execution_metrics**: Copied from executor\'s metrics.json (if available)\n  - **output_chars**: Total character count of output files (proxy for tokens)\n  - **transcript_chars**: Character count of transcript\n- **timing**: Wall clock timing from timing.json (if available)\n  - **executor_duration_seconds**: Time spent in executor subagent\n  - **total_duration_seconds**: Total elapsed time for the run\n- **claims**: Extracted and verified claims from the output\n  - **claim**: The statement being verified\n  - **type**: "factual", "process", or "quality"\n  - **verified**: Boolean - whether the claim holds\n  - **evidence**: Supporting or contradicting evidence\n- **user_notes_summary**: Issues flagged by the executor\n  - **uncertainties**: Things the executor wasn\'t sure about\n  - **needs_review**: Items requiring human attention\n  - **workarounds**: Places where the skill didn\'t work as expected\n- **eval_feedback**: Improvement suggestions for the evals (only when warranted)\n  - **suggestions**: List of concrete suggestions, each with a `reason` and optionally an `assertion` it relates to\n  - **overall**: Brief assessment \u2014 can be "No suggestions, evals look solid" if nothing to flag\n\n## Guidelines\n\n- **Be objective**: Base verdicts on evidence, not assumptions\n- **Be specific**: Quote the exact text that supports your verdict\n- **Be thorough**: Check both transcript and output files\n- **Be consistent**: Apply the same standard to each expectation\n- **Explain failures**: Make it clear why evidence was insufficient\n- **No partial credit**: Each expectation is pass or fail, not partial\n',
      "mode": 420
    },
    "assets/eval_review.html": {
      "text": `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eval Set Review - __SKILL_NAME_PLACEHOLDER__</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Lora', Georgia, serif; background: #faf9f5; padding: 2rem; color: #141413; }
    h1 { font-family: 'Poppins', sans-serif; margin-bottom: 0.5rem; font-size: 1.5rem; }
    .description { color: #b0aea5; margin-bottom: 1.5rem; font-style: italic; max-width: 900px; }
    .controls { margin-bottom: 1rem; display: flex; gap: 0.5rem; }
    .btn { font-family: 'Poppins', sans-serif; padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.875rem; font-weight: 500; }
    .btn-add { background: #6a9bcc; color: white; }
    .btn-add:hover { background: #5889b8; }
    .btn-export { background: #d97757; color: white; }
    .btn-export:hover { background: #c4613f; }
    table { width: 100%; max-width: 1100px; border-collapse: collapse; background: white; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th { font-family: 'Poppins', sans-serif; background: #141413; color: #faf9f5; padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #e8e6dc; vertical-align: top; }
    tr:nth-child(even) td { background: #faf9f5; }
    tr:hover td { background: #f3f1ea; }
    .section-header td { background: #e8e6dc; font-family: 'Poppins', sans-serif; font-weight: 500; font-size: 0.8rem; color: #141413; text-transform: uppercase; letter-spacing: 0.05em; }
    .query-input { width: 100%; padding: 0.4rem; border: 1px solid #e8e6dc; border-radius: 4px; font-size: 0.875rem; font-family: 'Lora', Georgia, serif; resize: vertical; min-height: 60px; }
    .query-input:focus { outline: none; border-color: #d97757; box-shadow: 0 0 0 2px rgba(217,119,87,0.15); }
    .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider { position: absolute; inset: 0; background: #b0aea5; border-radius: 24px; cursor: pointer; transition: 0.2s; }
    .toggle .slider::before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
    .toggle input:checked + .slider { background: #d97757; }
    .toggle input:checked + .slider::before { transform: translateX(20px); }
    .btn-delete { background: #c44; color: white; padding: 0.3rem 0.6rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-family: 'Poppins', sans-serif; }
    .btn-delete:hover { background: #a33; }
    .summary { margin-top: 1rem; color: #b0aea5; font-size: 0.875rem; }
  </style>
</head>
<body>
  <h1>Eval Set Review: <span id="skill-name">__SKILL_NAME_PLACEHOLDER__</span></h1>
  <p class="description">Current description: <span id="skill-desc">__SKILL_DESCRIPTION_PLACEHOLDER__</span></p>

  <div class="controls">
    <button class="btn btn-add" onclick="addRow()">+ Add Query</button>
    <button class="btn btn-export" onclick="exportEvalSet()">Export Eval Set</button>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:65%">Query</th>
        <th style="width:18%">Should Trigger</th>
        <th style="width:10%">Actions</th>
      </tr>
    </thead>
    <tbody id="eval-body"></tbody>
  </table>

  <p class="summary" id="summary"></p>

  <script>
    const EVAL_DATA = __EVAL_DATA_PLACEHOLDER__;

    let evalItems = [...EVAL_DATA];

    function render() {
      const tbody = document.getElementById('eval-body');
      tbody.innerHTML = '';

      // Sort: should-trigger first, then should-not-trigger
      const sorted = evalItems
        .map((item, origIdx) => ({ ...item, origIdx }))
        .sort((a, b) => (b.should_trigger ? 1 : 0) - (a.should_trigger ? 1 : 0));

      let lastGroup = null;
      sorted.forEach(item => {
        const group = item.should_trigger ? 'trigger' : 'no-trigger';
        if (group !== lastGroup) {
          const headerRow = document.createElement('tr');
          headerRow.className = 'section-header';
          headerRow.innerHTML = \`<td colspan="3">\${item.should_trigger ? 'Should Trigger' : 'Should NOT Trigger'}</td>\`;
          tbody.appendChild(headerRow);
          lastGroup = group;
        }

        const idx = item.origIdx;
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><textarea class="query-input" onchange="updateQuery(\${idx}, this.value)">\${escapeHtml(item.query)}</textarea></td>
          <td>
            <label class="toggle">
              <input type="checkbox" \${item.should_trigger ? 'checked' : ''} onchange="updateTrigger(\${idx}, this.checked)">
              <span class="slider"></span>
            </label>
            <span style="margin-left:8px;font-size:0.8rem;color:#b0aea5">\${item.should_trigger ? 'Yes' : 'No'}</span>
          </td>
          <td><button class="btn-delete" onclick="deleteRow(\${idx})">Delete</button></td>
        \`;
        tbody.appendChild(tr);
      });
      updateSummary();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function updateQuery(idx, value) { evalItems[idx].query = value; updateSummary(); }
    function updateTrigger(idx, value) { evalItems[idx].should_trigger = value; render(); }
    function deleteRow(idx) { evalItems.splice(idx, 1); render(); }

    function addRow() {
      evalItems.push({ query: '', should_trigger: true });
      render();
      const inputs = document.querySelectorAll('.query-input');
      inputs[inputs.length - 1].focus();
    }

    function updateSummary() {
      const trigger = evalItems.filter(i => i.should_trigger).length;
      const noTrigger = evalItems.filter(i => !i.should_trigger).length;
      document.getElementById('summary').textContent =
        \`\${evalItems.length} queries total: \${trigger} should trigger, \${noTrigger} should not trigger\`;
    }

    function exportEvalSet() {
      const valid = evalItems.filter(i => i.query.trim() !== '');
      const data = valid.map(i => ({ query: i.query.trim(), should_trigger: i.should_trigger }));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'eval_set.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    render();
  </script>
</body>
</html>
`,
      "mode": 420
    },
    "eval-viewer/generate_review.py": {
      "text": `#!/usr/bin/env python3
"""Generate and serve a review page for eval results.

Reads the workspace directory, discovers runs (directories with outputs/),
embeds all output data into a self-contained HTML page, and serves it via
a tiny HTTP server. Feedback auto-saves to feedback.json in the workspace.

Usage:
    python generate_review.py <workspace-path> [--port PORT] [--skill-name NAME]
    python generate_review.py <workspace-path> --previous-feedback /path/to/old/feedback.json

No dependencies beyond the Python stdlib are required.
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import signal
import subprocess
import sys
import time
import webbrowser
from functools import partial
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Files to exclude from output listings
METADATA_FILES = {"transcript.md", "user_notes.md", "metrics.json"}

# Extensions we render as inline text
TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".csv", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".yaml", ".yml", ".xml", ".html", ".css", ".sh", ".rb", ".go", ".rs",
    ".java", ".c", ".cpp", ".h", ".hpp", ".sql", ".r", ".toml",
}

# Extensions we render as inline images
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}

# MIME type overrides for common types
MIME_OVERRIDES = {
    ".svg": "image/svg+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def get_mime_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in MIME_OVERRIDES:
        return MIME_OVERRIDES[ext]
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def find_runs(workspace: Path) -> list[dict]:
    """Recursively find directories that contain an outputs/ subdirectory."""
    runs: list[dict] = []
    _find_runs_recursive(workspace, workspace, runs)
    runs.sort(key=lambda r: (r.get("eval_id", float("inf")), r["id"]))
    return runs


def _find_runs_recursive(root: Path, current: Path, runs: list[dict]) -> None:
    if not current.is_dir():
        return

    outputs_dir = current / "outputs"
    if outputs_dir.is_dir():
        run = build_run(root, current)
        if run:
            runs.append(run)
        return

    skip = {"node_modules", ".git", "__pycache__", "skill", "inputs"}
    for child in sorted(current.iterdir()):
        if child.is_dir() and child.name not in skip:
            _find_runs_recursive(root, child, runs)


def build_run(root: Path, run_dir: Path) -> dict | None:
    """Build a run dict with prompt, outputs, and grading data."""
    prompt = ""
    eval_id = None

    # Try eval_metadata.json
    for candidate in [run_dir / "eval_metadata.json", run_dir.parent / "eval_metadata.json"]:
        if candidate.exists():
            try:
                metadata = json.loads(candidate.read_text())
                prompt = metadata.get("prompt", "")
                eval_id = metadata.get("eval_id")
            except (json.JSONDecodeError, OSError):
                pass
            if prompt:
                break

    # Fall back to transcript.md
    if not prompt:
        for candidate in [run_dir / "transcript.md", run_dir / "outputs" / "transcript.md"]:
            if candidate.exists():
                try:
                    text = candidate.read_text()
                    match = re.search(r"## Eval Prompt\\n\\n([\\s\\S]*?)(?=\\n##|$)", text)
                    if match:
                        prompt = match.group(1).strip()
                except OSError:
                    pass
                if prompt:
                    break

    if not prompt:
        prompt = "(No prompt found)"

    run_id = str(run_dir.relative_to(root)).replace("/", "-").replace("\\\\", "-")

    # Collect output files
    outputs_dir = run_dir / "outputs"
    output_files: list[dict] = []
    if outputs_dir.is_dir():
        for f in sorted(outputs_dir.iterdir()):
            if f.is_file() and f.name not in METADATA_FILES:
                output_files.append(embed_file(f))

    # Load grading if present
    grading = None
    for candidate in [run_dir / "grading.json", run_dir.parent / "grading.json"]:
        if candidate.exists():
            try:
                grading = json.loads(candidate.read_text())
            except (json.JSONDecodeError, OSError):
                pass
            if grading:
                break

    return {
        "id": run_id,
        "prompt": prompt,
        "eval_id": eval_id,
        "outputs": output_files,
        "grading": grading,
    }


def embed_file(path: Path) -> dict:
    """Read a file and return an embedded representation."""
    ext = path.suffix.lower()
    mime = get_mime_type(path)

    if ext in TEXT_EXTENSIONS:
        try:
            content = path.read_text(errors="replace")
        except OSError:
            content = "(Error reading file)"
        return {
            "name": path.name,
            "type": "text",
            "content": content,
        }
    elif ext in IMAGE_EXTENSIONS:
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "image",
            "mime": mime,
            "data_uri": f"data:{mime};base64,{b64}",
        }
    elif ext == ".pdf":
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "pdf",
            "data_uri": f"data:{mime};base64,{b64}",
        }
    elif ext == ".xlsx":
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "xlsx",
            "data_b64": b64,
        }
    else:
        # Binary / unknown \u2014 base64 download link
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {
            "name": path.name,
            "type": "binary",
            "mime": mime,
            "data_uri": f"data:{mime};base64,{b64}",
        }


def load_previous_iteration(workspace: Path) -> dict[str, dict]:
    """Load previous iteration's feedback and outputs.

    Returns a map of run_id -> {"feedback": str, "outputs": list[dict]}.
    """
    result: dict[str, dict] = {}

    # Load feedback
    feedback_map: dict[str, str] = {}
    feedback_path = workspace / "feedback.json"
    if feedback_path.exists():
        try:
            data = json.loads(feedback_path.read_text())
            feedback_map = {
                r["run_id"]: r["feedback"]
                for r in data.get("reviews", [])
                if r.get("feedback", "").strip()
            }
        except (json.JSONDecodeError, OSError, KeyError):
            pass

    # Load runs (to get outputs)
    prev_runs = find_runs(workspace)
    for run in prev_runs:
        result[run["id"]] = {
            "feedback": feedback_map.get(run["id"], ""),
            "outputs": run.get("outputs", []),
        }

    # Also add feedback for run_ids that had feedback but no matching run
    for run_id, fb in feedback_map.items():
        if run_id not in result:
            result[run_id] = {"feedback": fb, "outputs": []}

    return result


def generate_html(
    runs: list[dict],
    skill_name: str,
    previous: dict[str, dict] | None = None,
    benchmark: dict | None = None,
) -> str:
    """Generate the complete standalone HTML page with embedded data."""
    template_path = Path(__file__).parent / "viewer.html"
    template = template_path.read_text()

    # Build previous_feedback and previous_outputs maps for the template
    previous_feedback: dict[str, str] = {}
    previous_outputs: dict[str, list[dict]] = {}
    if previous:
        for run_id, data in previous.items():
            if data.get("feedback"):
                previous_feedback[run_id] = data["feedback"]
            if data.get("outputs"):
                previous_outputs[run_id] = data["outputs"]

    embedded = {
        "skill_name": skill_name,
        "runs": runs,
        "previous_feedback": previous_feedback,
        "previous_outputs": previous_outputs,
    }
    if benchmark:
        embedded["benchmark"] = benchmark

    data_json = json.dumps(embedded)

    return template.replace("/*__EMBEDDED_DATA__*/", f"const EMBEDDED_DATA = {data_json};")


# ---------------------------------------------------------------------------
# HTTP server (stdlib only, zero dependencies)
# ---------------------------------------------------------------------------

def _kill_port(port: int) -> None:
    """Kill any process listening on the given port."""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=5,
        )
        for pid_str in result.stdout.strip().split("\\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        if result.stdout.strip():
            time.sleep(0.5)
    except subprocess.TimeoutExpired:
        pass
    except FileNotFoundError:
        print("Note: lsof not found, cannot check if port is in use", file=sys.stderr)

class ReviewHandler(BaseHTTPRequestHandler):
    """Serves the review HTML and handles feedback saves.

    Regenerates the HTML on each page load so that refreshing the browser
    picks up new eval outputs without restarting the server.
    """

    def __init__(
        self,
        workspace: Path,
        skill_name: str,
        feedback_path: Path,
        previous: dict[str, dict],
        benchmark_path: Path | None,
        *args,
        **kwargs,
    ):
        self.workspace = workspace
        self.skill_name = skill_name
        self.feedback_path = feedback_path
        self.previous = previous
        self.benchmark_path = benchmark_path
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        if self.path == "/" or self.path == "/index.html":
            # Regenerate HTML on each request (re-scans workspace for new outputs)
            runs = find_runs(self.workspace)
            benchmark = None
            if self.benchmark_path and self.benchmark_path.exists():
                try:
                    benchmark = json.loads(self.benchmark_path.read_text())
                except (json.JSONDecodeError, OSError):
                    pass
            html = generate_html(runs, self.skill_name, self.previous, benchmark)
            content = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/api/feedback":
            data = b"{}"
            if self.feedback_path.exists():
                data = self.feedback_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.path == "/api/feedback":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                if not isinstance(data, dict) or "reviews" not in data:
                    raise ValueError("Expected JSON object with 'reviews' key")
                self.feedback_path.write_text(json.dumps(data, indent=2) + "\\n")
                resp = b'{"ok":true}'
                self.send_response(200)
            except (json.JSONDecodeError, OSError, ValueError) as e:
                resp = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        # Suppress request logging to keep terminal clean
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate and serve eval review")
    parser.add_argument("workspace", type=Path, help="Path to workspace directory")
    parser.add_argument("--port", "-p", type=int, default=3117, help="Server port (default: 3117)")
    parser.add_argument("--skill-name", "-n", type=str, default=None, help="Skill name for header")
    parser.add_argument(
        "--previous-workspace", type=Path, default=None,
        help="Path to previous iteration's workspace (shows old outputs and feedback as context)",
    )
    parser.add_argument(
        "--benchmark", type=Path, default=None,
        help="Path to benchmark.json to show in the Benchmark tab",
    )
    parser.add_argument(
        "--static", "-s", type=Path, default=None,
        help="Write standalone HTML to this path instead of starting a server",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.is_dir():
        print(f"Error: {workspace} is not a directory", file=sys.stderr)
        sys.exit(1)

    runs = find_runs(workspace)
    if not runs:
        print(f"No runs found in {workspace}", file=sys.stderr)
        sys.exit(1)

    skill_name = args.skill_name or workspace.name.replace("-workspace", "")
    feedback_path = workspace / "feedback.json"

    previous: dict[str, dict] = {}
    if args.previous_workspace:
        previous = load_previous_iteration(args.previous_workspace.resolve())

    benchmark_path = args.benchmark.resolve() if args.benchmark else None
    benchmark = None
    if benchmark_path and benchmark_path.exists():
        try:
            benchmark = json.loads(benchmark_path.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    if args.static:
        html = generate_html(runs, skill_name, previous, benchmark)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html)
        print(f"\\n  Static viewer written to: {args.static}\\n")
        sys.exit(0)

    # Kill any existing process on the target port
    port = args.port
    _kill_port(port)
    handler = partial(ReviewHandler, workspace, skill_name, feedback_path, previous, benchmark_path)
    try:
        server = HTTPServer(("127.0.0.1", port), handler)
    except OSError:
        # Port still in use after kill attempt \u2014 find a free one
        server = HTTPServer(("127.0.0.1", 0), handler)
        port = server.server_address[1]

    url = f"http://localhost:{port}"
    print(f"\\n  Eval Viewer")
    print(f"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")
    print(f"  URL:       {url}")
    print(f"  Workspace: {workspace}")
    print(f"  Feedback:  {feedback_path}")
    if previous:
        print(f"  Previous:  {args.previous_workspace} ({len(previous)} runs)")
    if benchmark_path:
        print(f"  Benchmark: {benchmark_path}")
    print(f"\\n  Press Ctrl+C to stop.\\n")

    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "eval-viewer/viewer.html": {
      "text": `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eval Review</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js" integrity="sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT" crossorigin="anonymous"></script>
  <style>
    :root {
      --bg: #faf9f5;
      --surface: #ffffff;
      --border: #e8e6dc;
      --text: #141413;
      --text-muted: #b0aea5;
      --accent: #d97757;
      --accent-hover: #c4613f;
      --green: #788c5d;
      --green-bg: #eef2e8;
      --red: #c44;
      --red-bg: #fceaea;
      --header-bg: #141413;
      --header-text: #faf9f5;
      --radius: 6px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Lora', Georgia, serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ---- Header ---- */
    .header {
      background: var(--header-bg);
      color: var(--header-text);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    .header h1 {
      font-family: 'Poppins', sans-serif;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .header .instructions {
      font-size: 0.8rem;
      opacity: 0.7;
      margin-top: 0.25rem;
    }
    .header .progress {
      font-size: 0.875rem;
      opacity: 0.8;
      text-align: right;
    }

    /* ---- Main content ---- */
    .main {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    /* ---- Sections ---- */
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      flex-shrink: 0;
    }
    .section-header {
      font-family: 'Poppins', sans-serif;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }
    .section-body {
      padding: 1rem;
    }

    /* ---- Config badge ---- */
    .config-badge {
      display: inline-block;
      padding: 0.2rem 0.625rem;
      border-radius: 9999px;
      font-family: 'Poppins', sans-serif;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-left: 0.75rem;
      vertical-align: middle;
    }
    .config-badge.config-primary {
      background: rgba(33, 150, 243, 0.12);
      color: #1976d2;
    }
    .config-badge.config-baseline {
      background: rgba(255, 193, 7, 0.15);
      color: #f57f17;
    }

    /* ---- Prompt ---- */
    .prompt-text {
      white-space: pre-wrap;
      font-size: 0.9375rem;
      line-height: 1.6;
    }

    /* ---- Outputs ---- */
    .output-file {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .output-file + .output-file {
      margin-top: 1rem;
    }
    .output-file-header {
      padding: 0.5rem 0.75rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .output-file-header .dl-btn {
      font-size: 0.7rem;
      color: var(--accent);
      text-decoration: none;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-weight: 500;
      opacity: 0.8;
    }
    .output-file-header .dl-btn:hover {
      opacity: 1;
      text-decoration: underline;
    }
    .output-file-content {
      padding: 0.75rem;
      overflow-x: auto;
    }
    .output-file-content pre {
      font-size: 0.8125rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    }
    .output-file-content img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .output-file-content iframe {
      width: 100%;
      height: 600px;
      border: none;
    }
    .output-file-content table {
      border-collapse: collapse;
      font-size: 0.8125rem;
      width: 100%;
    }
    .output-file-content table td,
    .output-file-content table th {
      border: 1px solid var(--border);
      padding: 0.375rem 0.5rem;
      text-align: left;
    }
    .output-file-content table th {
      background: var(--bg);
      font-weight: 600;
    }
    .output-file-content .download-link {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--accent);
      text-decoration: none;
      font-size: 0.875rem;
      cursor: pointer;
    }
    .output-file-content .download-link:hover {
      background: var(--border);
    }
    .empty-state {
      color: var(--text-muted);
      font-style: italic;
      padding: 2rem;
      text-align: center;
    }

    /* ---- Feedback ---- */
    .prev-feedback {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.625rem 0.75rem;
      margin-top: 0.75rem;
      font-size: 0.8125rem;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .prev-feedback-label {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.25rem;
      color: var(--text-muted);
    }
    .feedback-textarea {
      width: 100%;
      min-height: 100px;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.9375rem;
      line-height: 1.5;
      resize: vertical;
      color: var(--text);
    }
    .feedback-textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    .feedback-status {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
      min-height: 1.1em;
    }

    /* ---- Grades (collapsible) ---- */
    .grades-toggle {
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }
    .grades-toggle:hover {
      color: var(--accent);
    }
    .grades-toggle .arrow {
      margin-right: 0.5rem;
      transition: transform 0.15s;
      font-size: 0.75rem;
    }
    .grades-toggle .arrow.open {
      transform: rotate(90deg);
    }
    .grades-content {
      display: none;
      margin-top: 0.75rem;
    }
    .grades-content.open {
      display: block;
    }
    .grades-summary {
      font-size: 0.875rem;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .grade-badge {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .grade-pass { background: var(--green-bg); color: var(--green); }
    .grade-fail { background: var(--red-bg); color: var(--red); }
    .assertion-list {
      list-style: none;
    }
    .assertion-item {
      padding: 0.625rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.8125rem;
    }
    .assertion-item:last-child { border-bottom: none; }
    .assertion-status {
      font-weight: 600;
      margin-right: 0.5rem;
    }
    .assertion-status.pass { color: var(--green); }
    .assertion-status.fail { color: var(--red); }
    .assertion-evidence {
      color: var(--text-muted);
      font-size: 0.75rem;
      margin-top: 0.25rem;
      padding-left: 1.5rem;
    }

    /* ---- View tabs ---- */
    .view-tabs {
      display: flex;
      gap: 0;
      padding: 0 2rem;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .view-tab {
      font-family: 'Poppins', sans-serif;
      padding: 0.625rem 1.25rem;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      background: none;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .view-tab:hover { color: var(--text); }
    .view-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .view-panel { display: none; }
    .view-panel.active { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

    /* ---- Benchmark view ---- */
    .benchmark-view {
      padding: 1.5rem 2rem;
      overflow-y: auto;
      flex: 1;
    }
    .benchmark-table {
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-size: 0.8125rem;
      width: 100%;
      margin-bottom: 1.5rem;
    }
    .benchmark-table th, .benchmark-table td {
      padding: 0.625rem 0.75rem;
      text-align: left;
      border: 1px solid var(--border);
    }
    .benchmark-table th {
      font-family: 'Poppins', sans-serif;
      background: var(--header-bg);
      color: var(--header-text);
      font-weight: 500;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .benchmark-table tr:hover { background: var(--bg); }
    .benchmark-table tr.benchmark-row-with { background: rgba(33, 150, 243, 0.06); }
    .benchmark-table tr.benchmark-row-without { background: rgba(255, 193, 7, 0.06); }
    .benchmark-table tr.benchmark-row-with:hover { background: rgba(33, 150, 243, 0.12); }
    .benchmark-table tr.benchmark-row-without:hover { background: rgba(255, 193, 7, 0.12); }
    .benchmark-table tr.benchmark-row-avg { font-weight: 600; border-top: 2px solid var(--border); }
    .benchmark-table tr.benchmark-row-avg.benchmark-row-with { background: rgba(33, 150, 243, 0.12); }
    .benchmark-table tr.benchmark-row-avg.benchmark-row-without { background: rgba(255, 193, 7, 0.12); }
    .benchmark-delta-positive { color: var(--green); font-weight: 600; }
    .benchmark-delta-negative { color: var(--red); font-weight: 600; }
    .benchmark-notes {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
    }
    .benchmark-notes h3 {
      font-family: 'Poppins', sans-serif;
      font-size: 0.875rem;
      margin-bottom: 0.75rem;
    }
    .benchmark-notes ul {
      list-style: disc;
      padding-left: 1.25rem;
    }
    .benchmark-notes li {
      font-size: 0.8125rem;
      line-height: 1.6;
      margin-bottom: 0.375rem;
    }
    .benchmark-empty {
      color: var(--text-muted);
      font-style: italic;
      text-align: center;
      padding: 3rem;
    }

    /* ---- Navigation ---- */
    .nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 2rem;
      border-top: 1px solid var(--border);
      background: var(--surface);
      flex-shrink: 0;
    }
    .nav-btn {
      font-family: 'Poppins', sans-serif;
      padding: 0.5rem 1.25rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text);
      transition: all 0.15s;
    }
    .nav-btn:hover:not(:disabled) {
      background: var(--bg);
      border-color: var(--text-muted);
    }
    .nav-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .done-btn {
      font-family: 'Poppins', sans-serif;
      padding: 0.5rem 1.5rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.15s;
    }
    .done-btn:hover {
      background: var(--bg);
      border-color: var(--text-muted);
    }
    .done-btn.ready {
      border: none;
      background: var(--accent);
      color: white;
      font-weight: 600;
    }
    .done-btn.ready:hover {
      background: var(--accent-hover);
    }
    /* ---- Done overlay ---- */
    .done-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 100;
      justify-content: center;
      align-items: center;
    }
    .done-overlay.visible {
      display: flex;
    }
    .done-card {
      background: var(--surface);
      border-radius: 12px;
      padding: 2rem 3rem;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
    }
    .done-card h2 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    .done-card p {
      color: var(--text-muted);
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    .done-card .btn-row {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
    }
    .done-card button {
      padding: 0.5rem 1.25rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      cursor: pointer;
      font-size: 0.875rem;
    }
    .done-card button:hover {
      background: var(--bg);
    }
    /* ---- Toast ---- */
    .toast {
      position: fixed;
      bottom: 5rem;
      left: 50%;
      transform: translateX(-50%);
      background: var(--header-bg);
      color: var(--header-text);
      padding: 0.625rem 1.25rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      z-index: 200;
    }
    .toast.visible {
      opacity: 1;
    }
  </style>
</head>
<body>
  <div id="app" style="height:100vh; display:flex; flex-direction:column;">
    <div class="header">
      <div>
        <h1>Eval Review: <span id="skill-name"></span></h1>
        <div class="instructions">Review each output and leave feedback below. Navigate with arrow keys or buttons. When done, copy feedback and paste into Claude Code.</div>
      </div>
      <div class="progress" id="progress"></div>
    </div>

    <!-- View tabs (only shown when benchmark data exists) -->
    <div class="view-tabs" id="view-tabs" style="display:none;">
      <button class="view-tab active" onclick="switchView('outputs')">Outputs</button>
      <button class="view-tab" onclick="switchView('benchmark')">Benchmark</button>
    </div>

    <!-- Outputs panel (qualitative review) -->
    <div class="view-panel active" id="panel-outputs">
    <div class="main">
      <!-- Prompt -->
      <div class="section">
        <div class="section-header">Prompt <span class="config-badge" id="config-badge" style="display:none;"></span></div>
        <div class="section-body">
          <div class="prompt-text" id="prompt-text"></div>
        </div>
      </div>

      <!-- Outputs -->
      <div class="section">
        <div class="section-header">Output</div>
        <div class="section-body" id="outputs-body">
          <div class="empty-state">No output files found</div>
        </div>
      </div>

      <!-- Previous Output (collapsible) -->
      <div class="section" id="prev-outputs-section" style="display:none;">
        <div class="section-header">
          <div class="grades-toggle" onclick="togglePrevOutputs()">
            <span class="arrow" id="prev-outputs-arrow">&#9654;</span>
            Previous Output
          </div>
        </div>
        <div class="grades-content" id="prev-outputs-content"></div>
      </div>

      <!-- Grades (collapsible) -->
      <div class="section" id="grades-section" style="display:none;">
        <div class="section-header">
          <div class="grades-toggle" onclick="toggleGrades()">
            <span class="arrow" id="grades-arrow">&#9654;</span>
            Formal Grades
          </div>
        </div>
        <div class="grades-content" id="grades-content"></div>
      </div>

      <!-- Feedback -->
      <div class="section">
        <div class="section-header">Your Feedback</div>
        <div class="section-body">
          <textarea
            class="feedback-textarea"
            id="feedback"
            placeholder="What do you think of this output? Any issues, suggestions, or things that look great?"
          ></textarea>
          <div class="feedback-status" id="feedback-status"></div>
          <div class="prev-feedback" id="prev-feedback" style="display:none;">
            <div class="prev-feedback-label">Previous feedback</div>
            <div id="prev-feedback-text"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="nav" id="outputs-nav">
      <button class="nav-btn" id="prev-btn" onclick="navigate(-1)">&#8592; Previous</button>
      <button class="done-btn" id="done-btn" onclick="showDoneDialog()">Submit All Reviews</button>
      <button class="nav-btn" id="next-btn" onclick="navigate(1)">Next &#8594;</button>
    </div>
    </div><!-- end panel-outputs -->

    <!-- Benchmark panel (quantitative stats) -->
    <div class="view-panel" id="panel-benchmark">
      <div class="benchmark-view" id="benchmark-content">
        <div class="benchmark-empty">No benchmark data available. Run a benchmark to see quantitative results here.</div>
      </div>
    </div>
  </div>

  <!-- Done overlay -->
  <div class="done-overlay" id="done-overlay">
    <div class="done-card">
      <h2>Review Complete</h2>
      <p>Your feedback has been saved. Go back to your Claude Code session and tell Claude you're done reviewing.</p>
      <div class="btn-row">
        <button onclick="closeDoneDialog()">OK</button>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    // ---- Embedded data (injected by generate_review.py) ----
    /*__EMBEDDED_DATA__*/

    // ---- State ----
    let feedbackMap = {};  // run_id -> feedback text
    let currentIndex = 0;
    let visitedRuns = new Set();

    // ---- Init ----
    async function init() {
      // Load saved feedback from server \u2014 but only if this isn't a fresh
      // iteration (indicated by previous_feedback being present). When
      // previous feedback exists, the feedback.json on disk is stale from
      // the prior iteration and should not pre-fill the textareas.
      const hasPrevious = Object.keys(EMBEDDED_DATA.previous_feedback || {}).length > 0
        || Object.keys(EMBEDDED_DATA.previous_outputs || {}).length > 0;
      if (!hasPrevious) {
        try {
          const resp = await fetch("/api/feedback");
          const data = await resp.json();
          if (data.reviews) {
            for (const r of data.reviews) feedbackMap[r.run_id] = r.feedback;
          }
        } catch { /* first run, no feedback yet */ }
      }

      document.getElementById("skill-name").textContent = EMBEDDED_DATA.skill_name;
      showRun(0);

      // Wire up feedback auto-save
      const textarea = document.getElementById("feedback");
      let saveTimeout = null;
      textarea.addEventListener("input", () => {
        clearTimeout(saveTimeout);
        document.getElementById("feedback-status").textContent = "";
        saveTimeout = setTimeout(() => saveCurrentFeedback(), 800);
      });
    }

    // ---- Navigation ----
    function navigate(delta) {
      const newIndex = currentIndex + delta;
      if (newIndex >= 0 && newIndex < EMBEDDED_DATA.runs.length) {
        saveCurrentFeedback();
        showRun(newIndex);
      }
    }

    function updateNavButtons() {
      document.getElementById("prev-btn").disabled = currentIndex === 0;
      document.getElementById("next-btn").disabled =
        currentIndex === EMBEDDED_DATA.runs.length - 1;
    }

    // ---- Show a run ----
    function showRun(index) {
      currentIndex = index;
      const run = EMBEDDED_DATA.runs[index];

      // Progress
      document.getElementById("progress").textContent =
        \`\${index + 1} of \${EMBEDDED_DATA.runs.length}\`;

      // Prompt
      document.getElementById("prompt-text").textContent = run.prompt;

      // Config badge
      const badge = document.getElementById("config-badge");
      const configMatch = run.id.match(/(with_skill|without_skill|new_skill|old_skill)/);
      if (configMatch) {
        const config = configMatch[1];
        const isBaseline = config === "without_skill" || config === "old_skill";
        badge.textContent = config.replace(/_/g, " ");
        badge.className = "config-badge " + (isBaseline ? "config-baseline" : "config-primary");
        badge.style.display = "inline-block";
      } else {
        badge.style.display = "none";
      }

      // Outputs
      renderOutputs(run);

      // Previous outputs
      renderPrevOutputs(run);

      // Grades
      renderGrades(run);

      // Previous feedback
      const prevFb = (EMBEDDED_DATA.previous_feedback || {})[run.id];
      const prevEl = document.getElementById("prev-feedback");
      if (prevFb) {
        document.getElementById("prev-feedback-text").textContent = prevFb;
        prevEl.style.display = "block";
      } else {
        prevEl.style.display = "none";
      }

      // Feedback
      document.getElementById("feedback").value = feedbackMap[run.id] || "";
      document.getElementById("feedback-status").textContent = "";

      updateNavButtons();

      // Track visited runs and promote done button when all visited
      visitedRuns.add(index);
      const doneBtn = document.getElementById("done-btn");
      if (visitedRuns.size >= EMBEDDED_DATA.runs.length) {
        doneBtn.classList.add("ready");
      }

      // Scroll main content to top
      document.querySelector(".main").scrollTop = 0;
    }

    // ---- Render outputs ----
    function renderOutputs(run) {
      const container = document.getElementById("outputs-body");
      container.innerHTML = "";

      const outputs = run.outputs || [];
      if (outputs.length === 0) {
        container.innerHTML = '<div class="empty-state">No output files</div>';
        return;
      }

      for (const file of outputs) {
        const fileDiv = document.createElement("div");
        fileDiv.className = "output-file";

        // Always show file header with download link
        const header = document.createElement("div");
        header.className = "output-file-header";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = file.name;
        header.appendChild(nameSpan);
        const dlBtn = document.createElement("a");
        dlBtn.className = "dl-btn";
        dlBtn.textContent = "Download";
        dlBtn.download = file.name;
        dlBtn.href = getDownloadUri(file);
        header.appendChild(dlBtn);
        fileDiv.appendChild(header);

        const content = document.createElement("div");
        content.className = "output-file-content";

        if (file.type === "text") {
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          content.appendChild(pre);
        } else if (file.type === "image") {
          const img = document.createElement("img");
          img.src = file.data_uri;
          img.alt = file.name;
          content.appendChild(img);
        } else if (file.type === "pdf") {
          const iframe = document.createElement("iframe");
          iframe.src = file.data_uri;
          content.appendChild(iframe);
        } else if (file.type === "xlsx") {
          renderXlsx(content, file.data_b64);
        } else if (file.type === "binary") {
          const a = document.createElement("a");
          a.className = "download-link";
          a.href = file.data_uri;
          a.download = file.name;
          a.textContent = "Download " + file.name;
          content.appendChild(a);
        } else if (file.type === "error") {
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          pre.style.color = "var(--red)";
          content.appendChild(pre);
        }

        fileDiv.appendChild(content);
        container.appendChild(fileDiv);
      }
    }

    // ---- XLSX rendering via SheetJS ----
    function renderXlsx(container, b64Data) {
      try {
        const raw = Uint8Array.from(atob(b64Data), c => c.charCodeAt(0));
        const wb = XLSX.read(raw, { type: "array" });

        for (let i = 0; i < wb.SheetNames.length; i++) {
          const sheetName = wb.SheetNames[i];
          const ws = wb.Sheets[sheetName];

          if (wb.SheetNames.length > 1) {
            const sheetLabel = document.createElement("div");
            sheetLabel.style.cssText =
              "font-weight:600; font-size:0.8rem; color:#b0aea5; margin-top:0.5rem; margin-bottom:0.25rem;";
            sheetLabel.textContent = "Sheet: " + sheetName;
            container.appendChild(sheetLabel);
          }

          const htmlStr = XLSX.utils.sheet_to_html(ws, { editable: false });
          const wrapper = document.createElement("div");
          wrapper.innerHTML = htmlStr;
          container.appendChild(wrapper);
        }
      } catch (err) {
        container.textContent = "Error rendering spreadsheet: " + err.message;
      }
    }

    // ---- Grades ----
    function renderGrades(run) {
      const section = document.getElementById("grades-section");
      const content = document.getElementById("grades-content");

      if (!run.grading) {
        section.style.display = "none";
        return;
      }

      const grading = run.grading;
      section.style.display = "block";
      // Reset to collapsed
      content.classList.remove("open");
      document.getElementById("grades-arrow").classList.remove("open");

      const summary = grading.summary || {};
      const expectations = grading.expectations || [];

      let html = '<div style="padding: 1rem;">';

      // Summary line
      const passRate = summary.pass_rate != null
        ? Math.round(summary.pass_rate * 100) + "%"
        : "?";
      const badgeClass = summary.pass_rate >= 0.8 ? "grade-pass" : summary.pass_rate >= 0.5 ? "" : "grade-fail";
      html += '<div class="grades-summary">';
      html += '<span class="grade-badge ' + badgeClass + '">' + passRate + '</span>';
      html += '<span>' + (summary.passed || 0) + ' passed, ' + (summary.failed || 0) + ' failed of ' + (summary.total || 0) + '</span>';
      html += '</div>';

      // Assertions list
      html += '<ul class="assertion-list">';
      for (const exp of expectations) {
        const statusClass = exp.passed ? "pass" : "fail";
        const statusIcon = exp.passed ? "\\u2713" : "\\u2717";
        html += '<li class="assertion-item">';
        html += '<span class="assertion-status ' + statusClass + '">' + statusIcon + '</span>';
        html += '<span>' + escapeHtml(exp.text) + '</span>';
        if (exp.evidence) {
          html += '<div class="assertion-evidence">' + escapeHtml(exp.evidence) + '</div>';
        }
        html += '</li>';
      }
      html += '</ul>';

      html += '</div>';
      content.innerHTML = html;
    }

    function toggleGrades() {
      const content = document.getElementById("grades-content");
      const arrow = document.getElementById("grades-arrow");
      content.classList.toggle("open");
      arrow.classList.toggle("open");
    }

    // ---- Previous outputs (collapsible) ----
    function renderPrevOutputs(run) {
      const section = document.getElementById("prev-outputs-section");
      const content = document.getElementById("prev-outputs-content");
      const prevOutputs = (EMBEDDED_DATA.previous_outputs || {})[run.id];

      if (!prevOutputs || prevOutputs.length === 0) {
        section.style.display = "none";
        return;
      }

      section.style.display = "block";
      // Reset to collapsed
      content.classList.remove("open");
      document.getElementById("prev-outputs-arrow").classList.remove("open");

      // Render the files into the content area
      content.innerHTML = "";
      const wrapper = document.createElement("div");
      wrapper.style.padding = "1rem";

      for (const file of prevOutputs) {
        const fileDiv = document.createElement("div");
        fileDiv.className = "output-file";

        const header = document.createElement("div");
        header.className = "output-file-header";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = file.name;
        header.appendChild(nameSpan);
        const dlBtn = document.createElement("a");
        dlBtn.className = "dl-btn";
        dlBtn.textContent = "Download";
        dlBtn.download = file.name;
        dlBtn.href = getDownloadUri(file);
        header.appendChild(dlBtn);
        fileDiv.appendChild(header);

        const fc = document.createElement("div");
        fc.className = "output-file-content";

        if (file.type === "text") {
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          fc.appendChild(pre);
        } else if (file.type === "image") {
          const img = document.createElement("img");
          img.src = file.data_uri;
          img.alt = file.name;
          fc.appendChild(img);
        } else if (file.type === "pdf") {
          const iframe = document.createElement("iframe");
          iframe.src = file.data_uri;
          fc.appendChild(iframe);
        } else if (file.type === "xlsx") {
          renderXlsx(fc, file.data_b64);
        } else if (file.type === "binary") {
          const a = document.createElement("a");
          a.className = "download-link";
          a.href = file.data_uri;
          a.download = file.name;
          a.textContent = "Download " + file.name;
          fc.appendChild(a);
        }

        fileDiv.appendChild(fc);
        wrapper.appendChild(fileDiv);
      }

      content.appendChild(wrapper);
    }

    function togglePrevOutputs() {
      const content = document.getElementById("prev-outputs-content");
      const arrow = document.getElementById("prev-outputs-arrow");
      content.classList.toggle("open");
      arrow.classList.toggle("open");
    }

    // ---- Feedback (saved to server -> feedback.json) ----
    function saveCurrentFeedback() {
      const run = EMBEDDED_DATA.runs[currentIndex];
      const text = document.getElementById("feedback").value;

      if (text.trim() === "") {
        delete feedbackMap[run.id];
      } else {
        feedbackMap[run.id] = text;
      }

      // Build reviews array from map
      const reviews = [];
      for (const [run_id, feedback] of Object.entries(feedbackMap)) {
        if (feedback.trim()) {
          reviews.push({ run_id, feedback, timestamp: new Date().toISOString() });
        }
      }

      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviews, status: "in_progress" }),
      }).then(() => {
        document.getElementById("feedback-status").textContent = "Saved";
      }).catch(() => {
        // Static mode or server unavailable \u2014 no-op on auto-save,
        // feedback will be downloaded on final submit
        document.getElementById("feedback-status").textContent = "Will download on submit";
      });
    }

    // ---- Done ----
    function showDoneDialog() {
      // Save current textarea to feedbackMap (but don't POST yet)
      const run = EMBEDDED_DATA.runs[currentIndex];
      const text = document.getElementById("feedback").value;
      if (text.trim() === "") {
        delete feedbackMap[run.id];
      } else {
        feedbackMap[run.id] = text;
      }

      // POST once with status: complete \u2014 include ALL runs so the model
      // can distinguish "no feedback" (looks good) from "not reviewed"
      const reviews = [];
      const ts = new Date().toISOString();
      for (const r of EMBEDDED_DATA.runs) {
        reviews.push({ run_id: r.id, feedback: feedbackMap[r.id] || "", timestamp: ts });
      }
      const payload = JSON.stringify({ reviews, status: "complete" }, null, 2);
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).then(() => {
        document.getElementById("done-overlay").classList.add("visible");
      }).catch(() => {
        // Server not available (static mode) \u2014 download as file
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "feedback.json";
        a.click();
        URL.revokeObjectURL(url);
        document.getElementById("done-overlay").classList.add("visible");
      });
    }

    function closeDoneDialog() {
      // Reset status back to in_progress
      saveCurrentFeedback();
      document.getElementById("done-overlay").classList.remove("visible");
    }

    // ---- Toast ----
    function showToast(message) {
      const toast = document.getElementById("toast");
      toast.textContent = message;
      toast.classList.add("visible");
      setTimeout(() => toast.classList.remove("visible"), 2000);
    }

    // ---- Keyboard nav ----
    document.addEventListener("keydown", (e) => {
      // Don't capture when typing in textarea
      if (e.target.tagName === "TEXTAREA") return;

      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        navigate(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        navigate(1);
      }
    });

    // ---- Util ----
    function getDownloadUri(file) {
      if (file.data_uri) return file.data_uri;
      if (file.data_b64) return "data:application/octet-stream;base64," + file.data_b64;
      if (file.type === "text") return "data:text/plain;charset=utf-8," + encodeURIComponent(file.content);
      return "#";
    }

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    // ---- View switching ----
    function switchView(view) {
      document.querySelectorAll(".view-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".view-panel").forEach(p => p.classList.remove("active"));
      document.querySelector(\`[onclick="switchView('\${view}')"]\`).classList.add("active");
      document.getElementById("panel-" + view).classList.add("active");
    }

    // ---- Benchmark rendering ----
    function renderBenchmark() {
      const data = EMBEDDED_DATA.benchmark;
      if (!data) return;

      // Show the tabs
      document.getElementById("view-tabs").style.display = "flex";

      const container = document.getElementById("benchmark-content");
      const summary = data.run_summary || {};
      const metadata = data.metadata || {};
      const notes = data.notes || [];

      let html = "";

      // Header
      html += "<h2 style='font-family: Poppins, sans-serif; margin-bottom: 0.5rem;'>Benchmark Results</h2>";
      html += "<p style='color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1.25rem;'>";
      if (metadata.skill_name) html += "<strong>" + escapeHtml(metadata.skill_name) + "</strong> &mdash; ";
      if (metadata.timestamp) html += metadata.timestamp + " &mdash; ";
      if (metadata.evals_run) html += "Evals: " + metadata.evals_run.join(", ") + " &mdash; ";
      html += (metadata.runs_per_configuration || "?") + " runs per configuration";
      html += "</p>";

      // Summary table
      html += '<table class="benchmark-table">';

      function fmtStat(stat, pct) {
        if (!stat) return "\u2014";
        const suffix = pct ? "%" : "";
        const m = pct ? (stat.mean * 100).toFixed(0) : stat.mean.toFixed(1);
        const s = pct ? (stat.stddev * 100).toFixed(0) : stat.stddev.toFixed(1);
        return m + suffix + " \xB1 " + s + suffix;
      }

      function deltaClass(val) {
        if (!val) return "";
        const n = parseFloat(val);
        if (n > 0) return "benchmark-delta-positive";
        if (n < 0) return "benchmark-delta-negative";
        return "";
      }

      // Discover config names dynamically (everything except "delta")
      const configs = Object.keys(summary).filter(k => k !== "delta");
      const configA = configs[0] || "config_a";
      const configB = configs[1] || "config_b";
      const labelA = configA.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
      const labelB = configB.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
      const a = summary[configA] || {};
      const b = summary[configB] || {};
      const delta = summary.delta || {};

      html += "<thead><tr><th>Metric</th><th>" + escapeHtml(labelA) + "</th><th>" + escapeHtml(labelB) + "</th><th>Delta</th></tr></thead>";
      html += "<tbody>";

      html += "<tr><td><strong>Pass Rate</strong></td>";
      html += "<td>" + fmtStat(a.pass_rate, true) + "</td>";
      html += "<td>" + fmtStat(b.pass_rate, true) + "</td>";
      html += '<td class="' + deltaClass(delta.pass_rate) + '">' + (delta.pass_rate || "\u2014") + "</td></tr>";

      // Time (only show row if data exists)
      if (a.time_seconds || b.time_seconds) {
        html += "<tr><td><strong>Time (s)</strong></td>";
        html += "<td>" + fmtStat(a.time_seconds, false) + "</td>";
        html += "<td>" + fmtStat(b.time_seconds, false) + "</td>";
        html += '<td class="' + deltaClass(delta.time_seconds) + '">' + (delta.time_seconds ? delta.time_seconds + "s" : "\u2014") + "</td></tr>";
      }

      // Tokens (only show row if data exists)
      if (a.tokens || b.tokens) {
        html += "<tr><td><strong>Tokens</strong></td>";
        html += "<td>" + fmtStat(a.tokens, false) + "</td>";
        html += "<td>" + fmtStat(b.tokens, false) + "</td>";
        html += '<td class="' + deltaClass(delta.tokens) + '">' + (delta.tokens || "\u2014") + "</td></tr>";
      }

      html += "</tbody></table>";

      // Per-eval breakdown (if runs data available)
      const runs = data.runs || [];
      if (runs.length > 0) {
        const evalIds = [...new Set(runs.map(r => r.eval_id))].sort((a, b) => a - b);

        html += "<h3 style='font-family: Poppins, sans-serif; margin-bottom: 0.75rem;'>Per-Eval Breakdown</h3>";

        const hasTime = runs.some(r => r.result && r.result.time_seconds != null);
        const hasErrors = runs.some(r => r.result && r.result.errors > 0);

        for (const evalId of evalIds) {
          const evalRuns = runs.filter(r => r.eval_id === evalId);
          const evalName = evalRuns[0] && evalRuns[0].eval_name ? evalRuns[0].eval_name : "Eval " + evalId;

          html += "<h4 style='font-family: Poppins, sans-serif; margin: 1rem 0 0.5rem; color: var(--text);'>" + escapeHtml(evalName) + "</h4>";
          html += '<table class="benchmark-table">';
          html += "<thead><tr><th>Config</th><th>Run</th><th>Pass Rate</th>";
          if (hasTime) html += "<th>Time (s)</th>";
          if (hasErrors) html += "<th>Crashes During Execution</th>";
          html += "</tr></thead>";
          html += "<tbody>";

          // Group by config and render with average rows
          const configGroups = [...new Set(evalRuns.map(r => r.configuration))];
          for (let ci = 0; ci < configGroups.length; ci++) {
            const config = configGroups[ci];
            const configRuns = evalRuns.filter(r => r.configuration === config);
            if (configRuns.length === 0) continue;

            const rowClass = ci === 0 ? "benchmark-row-with" : "benchmark-row-without";
            const configLabel = config.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());

            for (const run of configRuns) {
              const r = run.result || {};
              const prClass = r.pass_rate >= 0.8 ? "benchmark-delta-positive" : r.pass_rate < 0.5 ? "benchmark-delta-negative" : "";
              html += '<tr class="' + rowClass + '">';
              html += "<td>" + configLabel + "</td>";
              html += "<td>" + run.run_number + "</td>";
              html += '<td class="' + prClass + '">' + ((r.pass_rate || 0) * 100).toFixed(0) + "% (" + (r.passed || 0) + "/" + (r.total || 0) + ")</td>";
              if (hasTime) html += "<td>" + (r.time_seconds != null ? r.time_seconds.toFixed(1) : "\u2014") + "</td>";
              if (hasErrors) html += "<td>" + (r.errors || 0) + "</td>";
              html += "</tr>";
            }

            // Average row
            const rates = configRuns.map(r => (r.result || {}).pass_rate || 0);
            const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
            const avgPrClass = avgRate >= 0.8 ? "benchmark-delta-positive" : avgRate < 0.5 ? "benchmark-delta-negative" : "";
            html += '<tr class="benchmark-row-avg ' + rowClass + '">';
            html += "<td>" + configLabel + "</td>";
            html += "<td>Avg</td>";
            html += '<td class="' + avgPrClass + '">' + (avgRate * 100).toFixed(0) + "%</td>";
            if (hasTime) {
              const times = configRuns.map(r => (r.result || {}).time_seconds).filter(t => t != null);
              html += "<td>" + (times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : "\u2014") + "</td>";
            }
            if (hasErrors) html += "<td></td>";
            html += "</tr>";
          }
          html += "</tbody></table>";

          // Per-assertion detail for this eval
          const runsWithExpectations = {};
          for (const config of configGroups) {
            runsWithExpectations[config] = evalRuns.filter(r => r.configuration === config && r.expectations && r.expectations.length > 0);
          }
          const hasAnyExpectations = Object.values(runsWithExpectations).some(runs => runs.length > 0);
          if (hasAnyExpectations) {
            // Collect all unique assertion texts across all configs
            const allAssertions = [];
            const seen = new Set();
            for (const config of configGroups) {
              for (const run of runsWithExpectations[config]) {
                for (const exp of (run.expectations || [])) {
                  if (!seen.has(exp.text)) {
                    seen.add(exp.text);
                    allAssertions.push(exp.text);
                  }
                }
              }
            }

            html += '<table class="benchmark-table" style="margin-top: 0.5rem;">';
            html += "<thead><tr><th>Assertion</th>";
            for (const config of configGroups) {
              const label = config.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
              html += "<th>" + escapeHtml(label) + "</th>";
            }
            html += "</tr></thead><tbody>";

            for (const assertionText of allAssertions) {
              html += "<tr><td>" + escapeHtml(assertionText) + "</td>";

              for (const config of configGroups) {
                html += "<td>";
                for (const run of runsWithExpectations[config]) {
                  const exp = (run.expectations || []).find(e => e.text === assertionText);
                  if (exp) {
                    const cls = exp.passed ? "benchmark-delta-positive" : "benchmark-delta-negative";
                    const icon = exp.passed ? "\\u2713" : "\\u2717";
                    html += '<span class="' + cls + '" title="Run ' + run.run_number + ': ' + escapeHtml(exp.evidence || "") + '">' + icon + "</span> ";
                  } else {
                    html += "\u2014 ";
                  }
                }
                html += "</td>";
              }
              html += "</tr>";
            }
            html += "</tbody></table>";
          }
        }
      }

      // Notes
      if (notes.length > 0) {
        html += '<div class="benchmark-notes">';
        html += "<h3>Analysis Notes</h3>";
        html += "<ul>";
        for (const note of notes) {
          html += "<li>" + escapeHtml(note) + "</li>";
        }
        html += "</ul></div>";
      }

      container.innerHTML = html;
    }

    // ---- Start ----
    init();
    renderBenchmark();
  </script>
</body>
</html>
`,
      "mode": 420
    },
    "LICENSE.txt": {
      "text": `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 Anthropic, PBC.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`,
      "mode": 420
    },
    "references/schemas.md": {
      "text": '# JSON Schemas\n\nThis document defines the JSON schemas used by skill-creator.\n\n---\n\n## evals.json\n\nDefines the evals for a skill. Located at `evals/evals.json` within the skill directory.\n\n```json\n{\n  "skill_name": "example-skill",\n  "evals": [\n    {\n      "id": 1,\n      "prompt": "User\'s example prompt",\n      "expected_output": "Description of expected result",\n      "files": ["evals/files/sample1.pdf"],\n      "expectations": [\n        "The output includes X",\n        "The skill used script Y"\n      ]\n    }\n  ]\n}\n```\n\n**Fields:**\n- `skill_name`: Name matching the skill\'s frontmatter\n- `evals[].id`: Unique integer identifier\n- `evals[].prompt`: The task to execute\n- `evals[].expected_output`: Human-readable description of success\n- `evals[].files`: Optional list of input file paths (relative to skill root)\n- `evals[].expectations`: List of verifiable statements\n\n---\n\n## history.json\n\nTracks version progression in Improve mode. Located at workspace root.\n\n```json\n{\n  "started_at": "2026-01-15T10:30:00Z",\n  "skill_name": "pdf",\n  "current_best": "v2",\n  "iterations": [\n    {\n      "version": "v0",\n      "parent": null,\n      "expectation_pass_rate": 0.65,\n      "grading_result": "baseline",\n      "is_current_best": false\n    },\n    {\n      "version": "v1",\n      "parent": "v0",\n      "expectation_pass_rate": 0.75,\n      "grading_result": "won",\n      "is_current_best": false\n    },\n    {\n      "version": "v2",\n      "parent": "v1",\n      "expectation_pass_rate": 0.85,\n      "grading_result": "won",\n      "is_current_best": true\n    }\n  ]\n}\n```\n\n**Fields:**\n- `started_at`: ISO timestamp of when improvement started\n- `skill_name`: Name of the skill being improved\n- `current_best`: Version identifier of the best performer\n- `iterations[].version`: Version identifier (v0, v1, ...)\n- `iterations[].parent`: Parent version this was derived from\n- `iterations[].expectation_pass_rate`: Pass rate from grading\n- `iterations[].grading_result`: "baseline", "won", "lost", or "tie"\n- `iterations[].is_current_best`: Whether this is the current best version\n\n---\n\n## grading.json\n\nOutput from the grader agent. Located at `<run-dir>/grading.json`.\n\n```json\n{\n  "expectations": [\n    {\n      "text": "The output includes the name \'John Smith\'",\n      "passed": true,\n      "evidence": "Found in transcript Step 3: \'Extracted names: John Smith, Sarah Johnson\'"\n    },\n    {\n      "text": "The spreadsheet has a SUM formula in cell B10",\n      "passed": false,\n      "evidence": "No spreadsheet was created. The output was a text file."\n    }\n  ],\n  "summary": {\n    "passed": 2,\n    "failed": 1,\n    "total": 3,\n    "pass_rate": 0.67\n  },\n  "execution_metrics": {\n    "tool_calls": {\n      "Read": 5,\n      "Write": 2,\n      "Bash": 8\n    },\n    "total_tool_calls": 15,\n    "total_steps": 6,\n    "errors_encountered": 0,\n    "output_chars": 12450,\n    "transcript_chars": 3200\n  },\n  "timing": {\n    "executor_duration_seconds": 165.0,\n    "grader_duration_seconds": 26.0,\n    "total_duration_seconds": 191.0\n  },\n  "claims": [\n    {\n      "claim": "The form has 12 fillable fields",\n      "type": "factual",\n      "verified": true,\n      "evidence": "Counted 12 fields in field_info.json"\n    }\n  ],\n  "user_notes_summary": {\n    "uncertainties": ["Used 2023 data, may be stale"],\n    "needs_review": [],\n    "workarounds": ["Fell back to text overlay for non-fillable fields"]\n  },\n  "eval_feedback": {\n    "suggestions": [\n      {\n        "assertion": "The output includes the name \'John Smith\'",\n        "reason": "A hallucinated document that mentions the name would also pass"\n      }\n    ],\n    "overall": "Assertions check presence but not correctness."\n  }\n}\n```\n\n**Fields:**\n- `expectations[]`: Graded expectations with evidence\n- `summary`: Aggregate pass/fail counts\n- `execution_metrics`: Tool usage and output size (from executor\'s metrics.json)\n- `timing`: Wall clock timing (from timing.json)\n- `claims`: Extracted and verified claims from the output\n- `user_notes_summary`: Issues flagged by the executor\n- `eval_feedback`: (optional) Improvement suggestions for the evals, only present when the grader identifies issues worth raising\n\n---\n\n## metrics.json\n\nOutput from the executor agent. Located at `<run-dir>/outputs/metrics.json`.\n\n```json\n{\n  "tool_calls": {\n    "Read": 5,\n    "Write": 2,\n    "Bash": 8,\n    "Edit": 1,\n    "Glob": 2,\n    "Grep": 0\n  },\n  "total_tool_calls": 18,\n  "total_steps": 6,\n  "files_created": ["filled_form.pdf", "field_values.json"],\n  "errors_encountered": 0,\n  "output_chars": 12450,\n  "transcript_chars": 3200\n}\n```\n\n**Fields:**\n- `tool_calls`: Count per tool type\n- `total_tool_calls`: Sum of all tool calls\n- `total_steps`: Number of major execution steps\n- `files_created`: List of output files created\n- `errors_encountered`: Number of errors during execution\n- `output_chars`: Total character count of output files\n- `transcript_chars`: Character count of transcript\n\n---\n\n## timing.json\n\nWall clock timing for a run. Located at `<run-dir>/timing.json`.\n\n**How to capture:** When a subagent task completes, the task notification includes `total_tokens` and `duration_ms`. Save these immediately \u2014 they are not persisted anywhere else and cannot be recovered after the fact.\n\n```json\n{\n  "total_tokens": 84852,\n  "duration_ms": 23332,\n  "total_duration_seconds": 23.3,\n  "executor_start": "2026-01-15T10:30:00Z",\n  "executor_end": "2026-01-15T10:32:45Z",\n  "executor_duration_seconds": 165.0,\n  "grader_start": "2026-01-15T10:32:46Z",\n  "grader_end": "2026-01-15T10:33:12Z",\n  "grader_duration_seconds": 26.0\n}\n```\n\n---\n\n## benchmark.json\n\nOutput from Benchmark mode. Located at `benchmarks/<timestamp>/benchmark.json`.\n\n```json\n{\n  "metadata": {\n    "skill_name": "pdf",\n    "skill_path": "/path/to/pdf",\n    "executor_model": "claude-sonnet-4-20250514",\n    "analyzer_model": "most-capable-model",\n    "timestamp": "2026-01-15T10:30:00Z",\n    "evals_run": [1, 2, 3],\n    "runs_per_configuration": 3\n  },\n\n  "runs": [\n    {\n      "eval_id": 1,\n      "eval_name": "Ocean",\n      "configuration": "with_skill",\n      "run_number": 1,\n      "result": {\n        "pass_rate": 0.85,\n        "passed": 6,\n        "failed": 1,\n        "total": 7,\n        "time_seconds": 42.5,\n        "tokens": 3800,\n        "tool_calls": 18,\n        "errors": 0\n      },\n      "expectations": [\n        {"text": "...", "passed": true, "evidence": "..."}\n      ],\n      "notes": [\n        "Used 2023 data, may be stale",\n        "Fell back to text overlay for non-fillable fields"\n      ]\n    }\n  ],\n\n  "run_summary": {\n    "with_skill": {\n      "pass_rate": {"mean": 0.85, "stddev": 0.05, "min": 0.80, "max": 0.90},\n      "time_seconds": {"mean": 45.0, "stddev": 12.0, "min": 32.0, "max": 58.0},\n      "tokens": {"mean": 3800, "stddev": 400, "min": 3200, "max": 4100}\n    },\n    "without_skill": {\n      "pass_rate": {"mean": 0.35, "stddev": 0.08, "min": 0.28, "max": 0.45},\n      "time_seconds": {"mean": 32.0, "stddev": 8.0, "min": 24.0, "max": 42.0},\n      "tokens": {"mean": 2100, "stddev": 300, "min": 1800, "max": 2500}\n    },\n    "delta": {\n      "pass_rate": "+0.50",\n      "time_seconds": "+13.0",\n      "tokens": "+1700"\n    }\n  },\n\n  "notes": [\n    "Assertion \'Output is a PDF file\' passes 100% in both configurations - may not differentiate skill value",\n    "Eval 3 shows high variance (50% \xB1 40%) - may be flaky or model-dependent",\n    "Without-skill runs consistently fail on table extraction expectations",\n    "Skill adds 13s average execution time but improves pass rate by 50%"\n  ]\n}\n```\n\n**Fields:**\n- `metadata`: Information about the benchmark run\n  - `skill_name`: Name of the skill\n  - `timestamp`: When the benchmark was run\n  - `evals_run`: List of eval names or IDs\n  - `runs_per_configuration`: Number of runs per config (e.g. 3)\n- `runs[]`: Individual run results\n  - `eval_id`: Numeric eval identifier\n  - `eval_name`: Human-readable eval name (used as section header in the viewer)\n  - `configuration`: Must be `"with_skill"` or `"without_skill"` (the viewer uses this exact string for grouping and color coding)\n  - `run_number`: Integer run number (1, 2, 3...)\n  - `result`: Nested object with `pass_rate`, `passed`, `total`, `time_seconds`, `tokens`, `errors`\n- `run_summary`: Statistical aggregates per configuration\n  - `with_skill` / `without_skill`: Each contains `pass_rate`, `time_seconds`, `tokens` objects with `mean` and `stddev` fields\n  - `delta`: Difference strings like `"+0.50"`, `"+13.0"`, `"+1700"`\n- `notes`: Freeform observations from the analyzer\n\n**Important:** The viewer reads these field names exactly. Using `config` instead of `configuration`, or putting `pass_rate` at the top level of a run instead of nested under `result`, will cause the viewer to show empty/zero values. Always reference this schema when generating benchmark.json manually.\n\n---\n\n## comparison.json\n\nOutput from blind comparator. Located at `<grading-dir>/comparison-N.json`.\n\n```json\n{\n  "winner": "A",\n  "reasoning": "Output A provides a complete solution with proper formatting and all required fields. Output B is missing the date field and has formatting inconsistencies.",\n  "rubric": {\n    "A": {\n      "content": {\n        "correctness": 5,\n        "completeness": 5,\n        "accuracy": 4\n      },\n      "structure": {\n        "organization": 4,\n        "formatting": 5,\n        "usability": 4\n      },\n      "content_score": 4.7,\n      "structure_score": 4.3,\n      "overall_score": 9.0\n    },\n    "B": {\n      "content": {\n        "correctness": 3,\n        "completeness": 2,\n        "accuracy": 3\n      },\n      "structure": {\n        "organization": 3,\n        "formatting": 2,\n        "usability": 3\n      },\n      "content_score": 2.7,\n      "structure_score": 2.7,\n      "overall_score": 5.4\n    }\n  },\n  "output_quality": {\n    "A": {\n      "score": 9,\n      "strengths": ["Complete solution", "Well-formatted", "All fields present"],\n      "weaknesses": ["Minor style inconsistency in header"]\n    },\n    "B": {\n      "score": 5,\n      "strengths": ["Readable output", "Correct basic structure"],\n      "weaknesses": ["Missing date field", "Formatting inconsistencies", "Partial data extraction"]\n    }\n  },\n  "expectation_results": {\n    "A": {\n      "passed": 4,\n      "total": 5,\n      "pass_rate": 0.80,\n      "details": [\n        {"text": "Output includes name", "passed": true}\n      ]\n    },\n    "B": {\n      "passed": 3,\n      "total": 5,\n      "pass_rate": 0.60,\n      "details": [\n        {"text": "Output includes name", "passed": true}\n      ]\n    }\n  }\n}\n```\n\n---\n\n## analysis.json\n\nOutput from post-hoc analyzer. Located at `<grading-dir>/analysis.json`.\n\n```json\n{\n  "comparison_summary": {\n    "winner": "A",\n    "winner_skill": "path/to/winner/skill",\n    "loser_skill": "path/to/loser/skill",\n    "comparator_reasoning": "Brief summary of why comparator chose winner"\n  },\n  "winner_strengths": [\n    "Clear step-by-step instructions for handling multi-page documents",\n    "Included validation script that caught formatting errors"\n  ],\n  "loser_weaknesses": [\n    "Vague instruction \'process the document appropriately\' led to inconsistent behavior",\n    "No script for validation, agent had to improvise"\n  ],\n  "instruction_following": {\n    "winner": {\n      "score": 9,\n      "issues": ["Minor: skipped optional logging step"]\n    },\n    "loser": {\n      "score": 6,\n      "issues": [\n        "Did not use the skill\'s formatting template",\n        "Invented own approach instead of following step 3"\n      ]\n    }\n  },\n  "improvement_suggestions": [\n    {\n      "priority": "high",\n      "category": "instructions",\n      "suggestion": "Replace \'process the document appropriately\' with explicit steps",\n      "expected_impact": "Would eliminate ambiguity that caused inconsistent behavior"\n    }\n  ],\n  "transcript_insights": {\n    "winner_execution_pattern": "Read skill -> Followed 5-step process -> Used validation script",\n    "loser_execution_pattern": "Read skill -> Unclear on approach -> Tried 3 different methods"\n  }\n}\n```\n',
      "mode": 420
    },
    "scripts/__init__.py": {
      "text": "",
      "mode": 493
    },
    "scripts/aggregate_benchmark.py": {
      "text": `#!/usr/bin/env python3
"""
Aggregate individual run results into benchmark summary statistics.

Reads grading.json files from run directories and produces:
- run_summary with mean, stddev, min, max for each metric
- delta between with_skill and without_skill configurations

Usage:
    python aggregate_benchmark.py <benchmark_dir>

Example:
    python aggregate_benchmark.py benchmarks/2026-01-15T10-30-00/

The script supports two directory layouts:

    Workspace layout (from skill-creator iterations):
    <benchmark_dir>/
    \u2514\u2500\u2500 eval-N/
        \u251C\u2500\u2500 with_skill/
        \u2502   \u251C\u2500\u2500 run-1/grading.json
        \u2502   \u2514\u2500\u2500 run-2/grading.json
        \u2514\u2500\u2500 without_skill/
            \u251C\u2500\u2500 run-1/grading.json
            \u2514\u2500\u2500 run-2/grading.json

    Legacy layout (with runs/ subdirectory):
    <benchmark_dir>/
    \u2514\u2500\u2500 runs/
        \u2514\u2500\u2500 eval-N/
            \u251C\u2500\u2500 with_skill/
            \u2502   \u2514\u2500\u2500 run-1/grading.json
            \u2514\u2500\u2500 without_skill/
                \u2514\u2500\u2500 run-1/grading.json
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path


def calculate_stats(values: list[float]) -> dict:
    """Calculate mean, stddev, min, max for a list of values."""
    if not values:
        return {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0}

    n = len(values)
    mean = sum(values) / n

    if n > 1:
        variance = sum((x - mean) ** 2 for x in values) / (n - 1)
        stddev = math.sqrt(variance)
    else:
        stddev = 0.0

    return {
        "mean": round(mean, 4),
        "stddev": round(stddev, 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4)
    }


def load_run_results(benchmark_dir: Path) -> dict:
    """
    Load all run results from a benchmark directory.

    Returns dict keyed by config name (e.g. "with_skill"/"without_skill",
    or "new_skill"/"old_skill"), each containing a list of run results.
    """
    # Support both layouts: eval dirs directly under benchmark_dir, or under runs/
    runs_dir = benchmark_dir / "runs"
    if runs_dir.exists():
        search_dir = runs_dir
    elif list(benchmark_dir.glob("eval-*")):
        search_dir = benchmark_dir
    else:
        print(f"No eval directories found in {benchmark_dir} or {benchmark_dir / 'runs'}")
        return {}

    results: dict[str, list] = {}

    for eval_idx, eval_dir in enumerate(sorted(search_dir.glob("eval-*"))):
        metadata_path = eval_dir / "eval_metadata.json"
        if metadata_path.exists():
            try:
                with open(metadata_path) as mf:
                    eval_id = json.load(mf).get("eval_id", eval_idx)
            except (json.JSONDecodeError, OSError):
                eval_id = eval_idx
        else:
            try:
                eval_id = int(eval_dir.name.split("-")[1])
            except ValueError:
                eval_id = eval_idx

        # Discover config directories dynamically rather than hardcoding names
        for config_dir in sorted(eval_dir.iterdir()):
            if not config_dir.is_dir():
                continue
            # Skip non-config directories (inputs, outputs, etc.)
            if not list(config_dir.glob("run-*")):
                continue
            config = config_dir.name
            if config not in results:
                results[config] = []

            for run_dir in sorted(config_dir.glob("run-*")):
                run_number = int(run_dir.name.split("-")[1])
                grading_file = run_dir / "grading.json"

                if not grading_file.exists():
                    print(f"Warning: grading.json not found in {run_dir}")
                    continue

                try:
                    with open(grading_file) as f:
                        grading = json.load(f)
                except json.JSONDecodeError as e:
                    print(f"Warning: Invalid JSON in {grading_file}: {e}")
                    continue

                # Extract metrics
                result = {
                    "eval_id": eval_id,
                    "run_number": run_number,
                    "pass_rate": grading.get("summary", {}).get("pass_rate", 0.0),
                    "passed": grading.get("summary", {}).get("passed", 0),
                    "failed": grading.get("summary", {}).get("failed", 0),
                    "total": grading.get("summary", {}).get("total", 0),
                }

                # Extract timing \u2014 check grading.json first, then sibling timing.json
                timing = grading.get("timing", {})
                result["time_seconds"] = timing.get("total_duration_seconds", 0.0)
                timing_file = run_dir / "timing.json"
                if result["time_seconds"] == 0.0 and timing_file.exists():
                    try:
                        with open(timing_file) as tf:
                            timing_data = json.load(tf)
                        result["time_seconds"] = timing_data.get("total_duration_seconds", 0.0)
                        result["tokens"] = timing_data.get("total_tokens", 0)
                    except json.JSONDecodeError:
                        pass

                # Extract metrics if available
                metrics = grading.get("execution_metrics", {})
                result["tool_calls"] = metrics.get("total_tool_calls", 0)
                if not result.get("tokens"):
                    result["tokens"] = metrics.get("output_chars", 0)
                result["errors"] = metrics.get("errors_encountered", 0)

                # Extract expectations \u2014 viewer requires fields: text, passed, evidence
                raw_expectations = grading.get("expectations", [])
                for exp in raw_expectations:
                    if "text" not in exp or "passed" not in exp:
                        print(f"Warning: expectation in {grading_file} missing required fields (text, passed, evidence): {exp}")
                result["expectations"] = raw_expectations

                # Extract notes from user_notes_summary
                notes_summary = grading.get("user_notes_summary", {})
                notes = []
                notes.extend(notes_summary.get("uncertainties", []))
                notes.extend(notes_summary.get("needs_review", []))
                notes.extend(notes_summary.get("workarounds", []))
                result["notes"] = notes

                results[config].append(result)

    return results


def aggregate_results(results: dict) -> dict:
    """
    Aggregate run results into summary statistics.

    Returns run_summary with stats for each configuration and delta.
    """
    run_summary = {}
    configs = list(results.keys())

    for config in configs:
        runs = results.get(config, [])

        if not runs:
            run_summary[config] = {
                "pass_rate": {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0},
                "time_seconds": {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0},
                "tokens": {"mean": 0, "stddev": 0, "min": 0, "max": 0}
            }
            continue

        pass_rates = [r["pass_rate"] for r in runs]
        times = [r["time_seconds"] for r in runs]
        tokens = [r.get("tokens", 0) for r in runs]

        run_summary[config] = {
            "pass_rate": calculate_stats(pass_rates),
            "time_seconds": calculate_stats(times),
            "tokens": calculate_stats(tokens)
        }

    # Calculate delta between the first two configs (if two exist)
    if len(configs) >= 2:
        primary = run_summary.get(configs[0], {})
        baseline = run_summary.get(configs[1], {})
    else:
        primary = run_summary.get(configs[0], {}) if configs else {}
        baseline = {}

    delta_pass_rate = primary.get("pass_rate", {}).get("mean", 0) - baseline.get("pass_rate", {}).get("mean", 0)
    delta_time = primary.get("time_seconds", {}).get("mean", 0) - baseline.get("time_seconds", {}).get("mean", 0)
    delta_tokens = primary.get("tokens", {}).get("mean", 0) - baseline.get("tokens", {}).get("mean", 0)

    run_summary["delta"] = {
        "pass_rate": f"{delta_pass_rate:+.2f}",
        "time_seconds": f"{delta_time:+.1f}",
        "tokens": f"{delta_tokens:+.0f}"
    }

    return run_summary


def generate_benchmark(benchmark_dir: Path, skill_name: str = "", skill_path: str = "") -> dict:
    """
    Generate complete benchmark.json from run results.
    """
    results = load_run_results(benchmark_dir)
    run_summary = aggregate_results(results)

    # Build runs array for benchmark.json
    runs = []
    for config in results:
        for result in results[config]:
            runs.append({
                "eval_id": result["eval_id"],
                "configuration": config,
                "run_number": result["run_number"],
                "result": {
                    "pass_rate": result["pass_rate"],
                    "passed": result["passed"],
                    "failed": result["failed"],
                    "total": result["total"],
                    "time_seconds": result["time_seconds"],
                    "tokens": result.get("tokens", 0),
                    "tool_calls": result.get("tool_calls", 0),
                    "errors": result.get("errors", 0)
                },
                "expectations": result["expectations"],
                "notes": result["notes"]
            })

    # Determine eval IDs from results
    eval_ids = sorted(set(
        r["eval_id"]
        for config in results.values()
        for r in config
    ))

    benchmark = {
        "metadata": {
            "skill_name": skill_name or "<skill-name>",
            "skill_path": skill_path or "<path/to/skill>",
            "executor_model": "<model-name>",
            "analyzer_model": "<model-name>",
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "evals_run": eval_ids,
            "runs_per_configuration": 3
        },
        "runs": runs,
        "run_summary": run_summary,
        "notes": []  # To be filled by analyzer
    }

    return benchmark


def generate_markdown(benchmark: dict) -> str:
    """Generate human-readable benchmark.md from benchmark data."""
    metadata = benchmark["metadata"]
    run_summary = benchmark["run_summary"]

    # Determine config names (excluding "delta")
    configs = [k for k in run_summary if k != "delta"]
    config_a = configs[0] if len(configs) >= 1 else "config_a"
    config_b = configs[1] if len(configs) >= 2 else "config_b"
    label_a = config_a.replace("_", " ").title()
    label_b = config_b.replace("_", " ").title()

    lines = [
        f"# Skill Benchmark: {metadata['skill_name']}",
        "",
        f"**Model**: {metadata['executor_model']}",
        f"**Date**: {metadata['timestamp']}",
        f"**Evals**: {', '.join(map(str, metadata['evals_run']))} ({metadata['runs_per_configuration']} runs each per configuration)",
        "",
        "## Summary",
        "",
        f"| Metric | {label_a} | {label_b} | Delta |",
        "|--------|------------|---------------|-------|",
    ]

    a_summary = run_summary.get(config_a, {})
    b_summary = run_summary.get(config_b, {})
    delta = run_summary.get("delta", {})

    # Format pass rate
    a_pr = a_summary.get("pass_rate", {})
    b_pr = b_summary.get("pass_rate", {})
    lines.append(f"| Pass Rate | {a_pr.get('mean', 0)*100:.0f}% \xB1 {a_pr.get('stddev', 0)*100:.0f}% | {b_pr.get('mean', 0)*100:.0f}% \xB1 {b_pr.get('stddev', 0)*100:.0f}% | {delta.get('pass_rate', '\u2014')} |")

    # Format time
    a_time = a_summary.get("time_seconds", {})
    b_time = b_summary.get("time_seconds", {})
    lines.append(f"| Time | {a_time.get('mean', 0):.1f}s \xB1 {a_time.get('stddev', 0):.1f}s | {b_time.get('mean', 0):.1f}s \xB1 {b_time.get('stddev', 0):.1f}s | {delta.get('time_seconds', '\u2014')}s |")

    # Format tokens
    a_tokens = a_summary.get("tokens", {})
    b_tokens = b_summary.get("tokens", {})
    lines.append(f"| Tokens | {a_tokens.get('mean', 0):.0f} \xB1 {a_tokens.get('stddev', 0):.0f} | {b_tokens.get('mean', 0):.0f} \xB1 {b_tokens.get('stddev', 0):.0f} | {delta.get('tokens', '\u2014')} |")

    # Notes section
    if benchmark.get("notes"):
        lines.extend([
            "",
            "## Notes",
            ""
        ])
        for note in benchmark["notes"]:
            lines.append(f"- {note}")

    return "\\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Aggregate benchmark run results into summary statistics"
    )
    parser.add_argument(
        "benchmark_dir",
        type=Path,
        help="Path to the benchmark directory"
    )
    parser.add_argument(
        "--skill-name",
        default="",
        help="Name of the skill being benchmarked"
    )
    parser.add_argument(
        "--skill-path",
        default="",
        help="Path to the skill being benchmarked"
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        help="Output path for benchmark.json (default: <benchmark_dir>/benchmark.json)"
    )

    args = parser.parse_args()

    if not args.benchmark_dir.exists():
        print(f"Directory not found: {args.benchmark_dir}")
        sys.exit(1)

    # Generate benchmark
    benchmark = generate_benchmark(args.benchmark_dir, args.skill_name, args.skill_path)

    # Determine output paths
    output_json = args.output or (args.benchmark_dir / "benchmark.json")
    output_md = output_json.with_suffix(".md")

    # Write benchmark.json
    with open(output_json, "w") as f:
        json.dump(benchmark, f, indent=2)
    print(f"Generated: {output_json}")

    # Write benchmark.md
    markdown = generate_markdown(benchmark)
    with open(output_md, "w") as f:
        f.write(markdown)
    print(f"Generated: {output_md}")

    # Print summary
    run_summary = benchmark["run_summary"]
    configs = [k for k in run_summary if k != "delta"]
    delta = run_summary.get("delta", {})

    print(f"\\nSummary:")
    for config in configs:
        pr = run_summary[config]["pass_rate"]["mean"]
        label = config.replace("_", " ").title()
        print(f"  {label}: {pr*100:.1f}% pass rate")
    print(f"  Delta:         {delta.get('pass_rate', '\u2014')}")


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/generate_report.py": {
      "text": `#!/usr/bin/env python3
"""Generate an HTML report from run_loop.py output.

Takes the JSON output from run_loop.py and generates a visual HTML report
showing each description attempt with check/x for each test case.
Distinguishes between train and test queries.
"""

import argparse
import html
import json
import sys
from pathlib import Path


def generate_html(data: dict, auto_refresh: bool = False, skill_name: str = "") -> str:
    """Generate HTML report from loop output data. If auto_refresh is True, adds a meta refresh tag."""
    history = data.get("history", [])
    holdout = data.get("holdout", 0)
    title_prefix = html.escape(skill_name + " \\u2014 ") if skill_name else ""

    # Get all unique queries from train and test sets, with should_trigger info
    train_queries: list[dict] = []
    test_queries: list[dict] = []
    if history:
        for r in history[0].get("train_results", history[0].get("results", [])):
            train_queries.append({"query": r["query"], "should_trigger": r.get("should_trigger", True)})
        if history[0].get("test_results"):
            for r in history[0].get("test_results", []):
                test_queries.append({"query": r["query"], "should_trigger": r.get("should_trigger", True)})

    refresh_tag = '    <meta http-equiv="refresh" content="5">\\n' if auto_refresh else ""

    html_parts = ["""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
""" + refresh_tag + """    <title>""" + title_prefix + """Skill Description Optimization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Lora', Georgia, serif;
            max-width: 100%;
            margin: 0 auto;
            padding: 20px;
            background: #faf9f5;
            color: #141413;
        }
        h1 { font-family: 'Poppins', sans-serif; color: #141413; }
        .explainer {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
            color: #b0aea5;
            font-size: 0.875rem;
            line-height: 1.6;
        }
        .summary {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
        }
        .summary p { margin: 5px 0; }
        .best { color: #788c5d; font-weight: bold; }
        .table-container {
            overflow-x: auto;
            width: 100%;
        }
        table {
            border-collapse: collapse;
            background: white;
            border: 1px solid #e8e6dc;
            border-radius: 6px;
            font-size: 12px;
            min-width: 100%;
        }
        th, td {
            padding: 8px;
            text-align: left;
            border: 1px solid #e8e6dc;
            white-space: normal;
            word-wrap: break-word;
        }
        th {
            font-family: 'Poppins', sans-serif;
            background: #141413;
            color: #faf9f5;
            font-weight: 500;
        }
        th.test-col {
            background: #6a9bcc;
        }
        th.query-col { min-width: 200px; }
        td.description {
            font-family: monospace;
            font-size: 11px;
            word-wrap: break-word;
            max-width: 400px;
        }
        td.result {
            text-align: center;
            font-size: 16px;
            min-width: 40px;
        }
        td.test-result {
            background: #f0f6fc;
        }
        .pass { color: #788c5d; }
        .fail { color: #c44; }
        .rate {
            font-size: 9px;
            color: #b0aea5;
            display: block;
        }
        tr:hover { background: #faf9f5; }
        .score {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 11px;
        }
        .score-good { background: #eef2e8; color: #788c5d; }
        .score-ok { background: #fef3c7; color: #d97706; }
        .score-bad { background: #fceaea; color: #c44; }
        .train-label { color: #b0aea5; font-size: 10px; }
        .test-label { color: #6a9bcc; font-size: 10px; font-weight: bold; }
        .best-row { background: #f5f8f2; }
        th.positive-col { border-bottom: 3px solid #788c5d; }
        th.negative-col { border-bottom: 3px solid #c44; }
        th.test-col.positive-col { border-bottom: 3px solid #788c5d; }
        th.test-col.negative-col { border-bottom: 3px solid #c44; }
        .legend { font-family: 'Poppins', sans-serif; display: flex; gap: 20px; margin-bottom: 10px; font-size: 13px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-swatch { width: 16px; height: 16px; border-radius: 3px; display: inline-block; }
        .swatch-positive { background: #141413; border-bottom: 3px solid #788c5d; }
        .swatch-negative { background: #141413; border-bottom: 3px solid #c44; }
        .swatch-test { background: #6a9bcc; }
        .swatch-train { background: #141413; }
    </style>
</head>
<body>
    <h1>""" + title_prefix + """Skill Description Optimization</h1>
    <div class="explainer">
        <strong>Optimizing your skill's description.</strong> This page updates automatically as Claude tests different versions of your skill's description. Each row is an iteration \u2014 a new description attempt. The columns show test queries: green checkmarks mean the skill triggered correctly (or correctly didn't trigger), red crosses mean it got it wrong. The "Train" score shows performance on queries used to improve the description; the "Test" score shows performance on held-out queries the optimizer hasn't seen. When it's done, Claude will apply the best-performing description to your skill.
    </div>
"""]

    # Summary section
    best_test_score = data.get('best_test_score')
    best_train_score = data.get('best_train_score')
    html_parts.append(f"""
    <div class="summary">
        <p><strong>Original:</strong> {html.escape(data.get('original_description', 'N/A'))}</p>
        <p class="best"><strong>Best:</strong> {html.escape(data.get('best_description', 'N/A'))}</p>
        <p><strong>Best Score:</strong> {data.get('best_score', 'N/A')} {'(test)' if best_test_score else '(train)'}</p>
        <p><strong>Iterations:</strong> {data.get('iterations_run', 0)} | <strong>Train:</strong> {data.get('train_size', '?')} | <strong>Test:</strong> {data.get('test_size', '?')}</p>
    </div>
""")

    # Legend
    html_parts.append("""
    <div class="legend">
        <span style="font-weight:600">Query columns:</span>
        <span class="legend-item"><span class="legend-swatch swatch-positive"></span> Should trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-negative"></span> Should NOT trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-train"></span> Train</span>
        <span class="legend-item"><span class="legend-swatch swatch-test"></span> Test</span>
    </div>
""")

    # Table header
    html_parts.append("""
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Iter</th>
                <th>Train</th>
                <th>Test</th>
                <th class="query-col">Description</th>
""")

    # Add column headers for train queries
    for qinfo in train_queries:
        polarity = "positive-col" if qinfo["should_trigger"] else "negative-col"
        html_parts.append(f'                <th class="{polarity}">{html.escape(qinfo["query"])}</th>\\n')

    # Add column headers for test queries (different color)
    for qinfo in test_queries:
        polarity = "positive-col" if qinfo["should_trigger"] else "negative-col"
        html_parts.append(f'                <th class="test-col {polarity}">{html.escape(qinfo["query"])}</th>\\n')

    html_parts.append("""            </tr>
        </thead>
        <tbody>
""")

    # Find best iteration for highlighting
    if test_queries:
        best_iter = max(history, key=lambda h: h.get("test_passed") or 0).get("iteration")
    else:
        best_iter = max(history, key=lambda h: h.get("train_passed", h.get("passed", 0))).get("iteration")

    # Add rows for each iteration
    for h in history:
        iteration = h.get("iteration", "?")
        train_passed = h.get("train_passed", h.get("passed", 0))
        train_total = h.get("train_total", h.get("total", 0))
        test_passed = h.get("test_passed")
        test_total = h.get("test_total")
        description = h.get("description", "")
        train_results = h.get("train_results", h.get("results", []))
        test_results = h.get("test_results", [])

        # Create lookups for results by query
        train_by_query = {r["query"]: r for r in train_results}
        test_by_query = {r["query"]: r for r in test_results} if test_results else {}

        # Compute aggregate correct/total runs across all retries
        def aggregate_runs(results: list[dict]) -> tuple[int, int]:
            correct = 0
            total = 0
            for r in results:
                runs = r.get("runs", 0)
                triggers = r.get("triggers", 0)
                total += runs
                if r.get("should_trigger", True):
                    correct += triggers
                else:
                    correct += runs - triggers
            return correct, total

        train_correct, train_runs = aggregate_runs(train_results)
        test_correct, test_runs = aggregate_runs(test_results)

        # Determine score classes
        def score_class(correct: int, total: int) -> str:
            if total > 0:
                ratio = correct / total
                if ratio >= 0.8:
                    return "score-good"
                elif ratio >= 0.5:
                    return "score-ok"
            return "score-bad"

        train_class = score_class(train_correct, train_runs)
        test_class = score_class(test_correct, test_runs)

        row_class = "best-row" if iteration == best_iter else ""

        html_parts.append(f"""            <tr class="{row_class}">
                <td>{iteration}</td>
                <td><span class="score {train_class}">{train_correct}/{train_runs}</span></td>
                <td><span class="score {test_class}">{test_correct}/{test_runs}</span></td>
                <td class="description">{html.escape(description)}</td>
""")

        # Add result for each train query
        for qinfo in train_queries:
            r = train_by_query.get(qinfo["query"], {})
            did_pass = r.get("pass", False)
            triggers = r.get("triggers", 0)
            runs = r.get("runs", 0)

            icon = "\u2713" if did_pass else "\u2717"
            css_class = "pass" if did_pass else "fail"

            html_parts.append(f'                <td class="result {css_class}">{icon}<span class="rate">{triggers}/{runs}</span></td>\\n')

        # Add result for each test query (with different background)
        for qinfo in test_queries:
            r = test_by_query.get(qinfo["query"], {})
            did_pass = r.get("pass", False)
            triggers = r.get("triggers", 0)
            runs = r.get("runs", 0)

            icon = "\u2713" if did_pass else "\u2717"
            css_class = "pass" if did_pass else "fail"

            html_parts.append(f'                <td class="result test-result {css_class}">{icon}<span class="rate">{triggers}/{runs}</span></td>\\n')

        html_parts.append("            </tr>\\n")

    html_parts.append("""        </tbody>
    </table>
    </div>
""")

    html_parts.append("""
</body>
</html>
""")

    return "".join(html_parts)


def main():
    parser = argparse.ArgumentParser(description="Generate HTML report from run_loop output")
    parser.add_argument("input", help="Path to JSON output from run_loop.py (or - for stdin)")
    parser.add_argument("-o", "--output", default=None, help="Output HTML file (default: stdout)")
    parser.add_argument("--skill-name", default="", help="Skill name to include in the report title")
    args = parser.parse_args()

    if args.input == "-":
        data = json.load(sys.stdin)
    else:
        data = json.loads(Path(args.input).read_text())

    html_output = generate_html(data, skill_name=args.skill_name)

    if args.output:
        Path(args.output).write_text(html_output)
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(html_output)


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/improve_description.py": {
      "text": `#!/usr/bin/env python3
"""Improve a skill description based on eval results.

Takes eval results (from run_eval.py) and generates an improved description
by calling \`claude -p\` as a subprocess (same auth pattern as run_eval.py \u2014
uses the session's Claude Code auth, no separate ANTHROPIC_API_KEY needed).
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from scripts.utils import parse_skill_md


def _call_claude(prompt: str, model: str | None, timeout: int = 300) -> str:
    """Run \`claude -p\` with the prompt on stdin and return the text response.

    Prompt goes over stdin (not argv) because it embeds the full SKILL.md
    body and can easily exceed comfortable argv length.
    """
    cmd = ["claude", "-p", "--output-format", "text"]
    if model:
        cmd.extend(["--model", model])

    # Remove CLAUDECODE env var to allow nesting claude -p inside a
    # Claude Code session. The guard is for interactive terminal conflicts;
    # programmatic subprocess usage is safe. Same pattern as run_eval.py.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    result = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude -p exited {result.returncode}\\nstderr: {result.stderr}"
        )
    return result.stdout


def improve_description(
    skill_name: str,
    skill_content: str,
    current_description: str,
    eval_results: dict,
    history: list[dict],
    model: str,
    test_results: dict | None = None,
    log_dir: Path | None = None,
    iteration: int | None = None,
) -> str:
    """Call Claude to improve the description based on eval results."""
    failed_triggers = [
        r for r in eval_results["results"]
        if r["should_trigger"] and not r["pass"]
    ]
    false_triggers = [
        r for r in eval_results["results"]
        if not r["should_trigger"] and not r["pass"]
    ]

    # Build scores summary
    train_score = f"{eval_results['summary']['passed']}/{eval_results['summary']['total']}"
    if test_results:
        test_score = f"{test_results['summary']['passed']}/{test_results['summary']['total']}"
        scores_summary = f"Train: {train_score}, Test: {test_score}"
    else:
        scores_summary = f"Train: {train_score}"

    prompt = f"""You are optimizing a skill description for a Claude Code skill called "{skill_name}". A "skill" is sort of like a prompt, but with progressive disclosure -- there's a title and description that Claude sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder like helper files and scripts and additional documentation or examples.

The description appears in Claude's "available_skills" list. When a user sends a query, Claude decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.

Here's the current description:
<current_description>
"{current_description}"
</current_description>

Current scores ({scores_summary}):
<scores_summary>
"""
    if failed_triggers:
        prompt += "FAILED TO TRIGGER (should have triggered but didn't):\\n"
        for r in failed_triggers:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times)\\n'
        prompt += "\\n"

    if false_triggers:
        prompt += "FALSE TRIGGERS (triggered but shouldn't have):\\n"
        for r in false_triggers:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times)\\n'
        prompt += "\\n"

    if history:
        prompt += "PREVIOUS ATTEMPTS (do NOT repeat these \u2014 try something structurally different):\\n\\n"
        for h in history:
            train_s = f"{h.get('train_passed', h.get('passed', 0))}/{h.get('train_total', h.get('total', 0))}"
            test_s = f"{h.get('test_passed', '?')}/{h.get('test_total', '?')}" if h.get('test_passed') is not None else None
            score_str = f"train={train_s}" + (f", test={test_s}" if test_s else "")
            prompt += f'<attempt {score_str}>\\n'
            prompt += f'Description: "{h["description"]}"\\n'
            if "results" in h:
                prompt += "Train results:\\n"
                for r in h["results"]:
                    status = "PASS" if r["pass"] else "FAIL"
                    prompt += f'  [{status}] "{r["query"][:80]}" (triggered {r["triggers"]}/{r["runs"]})\\n'
            if h.get("note"):
                prompt += f'Note: {h["note"]}\\n'
            prompt += "</attempt>\\n\\n"

    prompt += f"""</scores_summary>

Skill content (for context on what the skill does):
<skill_content>
{skill_content}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. When I say "based on the failures", it's a bit of a tricky line to walk because we don't want to overfit to the specific cases you're seeing. So what I DON'T want you to do is produce an ever-expanding list of specific queries that this skill should or shouldn't trigger for. Instead, try to generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful. The reason for this is twofold:

1. Avoid overfitting
2. The list might get loooong and it's injected into ALL queries and there might be a lot of skills, so we don't want to blow too much space on any given description.

Concretely, your description should not be more than about 100-200 words, even if that comes at the cost of accuracy. There is a hard limit of 1024 characters \u2014 descriptions over that will be truncated, so stay comfortably under it.

Here are some tips that we've found to work well in writing these descriptions:
- The skill should be phrased in the imperative -- "Use this skill for" rather than "this skill does"
- The skill description should focus on the user's intent, what they are trying to achieve, vs. the implementation details of how the skill works.
- The description competes with other skills for Claude's attention \u2014 make it distinctive and immediately recognizable.
- If you're getting lots of failures after repeated attempts, change things up. Try different sentence structures or wordings.

I'd encourage you to be creative and mix up the style in different iterations since you'll have multiple opportunities to try different approaches and we'll just grab the highest-scoring one at the end. 

Please respond with only the new description text in <new_description> tags, nothing else."""

    text = _call_claude(prompt, model)

    match = re.search(r"<new_description>(.*?)</new_description>", text, re.DOTALL)
    description = match.group(1).strip().strip('"') if match else text.strip().strip('"')

    transcript: dict = {
        "iteration": iteration,
        "prompt": prompt,
        "response": text,
        "parsed_description": description,
        "char_count": len(description),
        "over_limit": len(description) > 1024,
    }

    # Safety net: the prompt already states the 1024-char hard limit, but if
    # the model blew past it anyway, make one fresh single-turn call that
    # quotes the too-long version and asks for a shorter rewrite. (The old
    # SDK path did this as a true multi-turn; \`claude -p\` is one-shot, so we
    # inline the prior output into the new prompt instead.)
    if len(description) > 1024:
        shorten_prompt = (
            f"{prompt}\\n\\n"
            f"---\\n\\n"
            f"A previous attempt produced this description, which at "
            f"{len(description)} characters is over the 1024-character hard limit:\\n\\n"
            f'"{description}"\\n\\n'
            f"Rewrite it to be under 1024 characters while keeping the most "
            f"important trigger words and intent coverage. Respond with only "
            f"the new description in <new_description> tags."
        )
        shorten_text = _call_claude(shorten_prompt, model)
        match = re.search(r"<new_description>(.*?)</new_description>", shorten_text, re.DOTALL)
        shortened = match.group(1).strip().strip('"') if match else shorten_text.strip().strip('"')

        transcript["rewrite_prompt"] = shorten_prompt
        transcript["rewrite_response"] = shorten_text
        transcript["rewrite_description"] = shortened
        transcript["rewrite_char_count"] = len(shortened)
        description = shortened

    transcript["final_description"] = description

    if log_dir:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"improve_iter_{iteration or 'unknown'}.json"
        log_file.write_text(json.dumps(transcript, indent=2))

    return description


def main():
    parser = argparse.ArgumentParser(description="Improve a skill description based on eval results")
    parser.add_argument("--eval-results", required=True, help="Path to eval results JSON (from run_eval.py)")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--history", default=None, help="Path to history JSON (previous attempts)")
    parser.add_argument("--model", required=True, help="Model for improvement")
    parser.add_argument("--verbose", action="store_true", help="Print thinking to stderr")
    args = parser.parse_args()

    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    eval_results = json.loads(Path(args.eval_results).read_text())
    history = []
    if args.history:
        history = json.loads(Path(args.history).read_text())

    name, _, content = parse_skill_md(skill_path)
    current_description = eval_results["description"]

    if args.verbose:
        print(f"Current: {current_description}", file=sys.stderr)
        print(f"Score: {eval_results['summary']['passed']}/{eval_results['summary']['total']}", file=sys.stderr)

    new_description = improve_description(
        skill_name=name,
        skill_content=content,
        current_description=current_description,
        eval_results=eval_results,
        history=history,
        model=args.model,
    )

    if args.verbose:
        print(f"Improved: {new_description}", file=sys.stderr)

    # Output as JSON with both the new description and updated history
    output = {
        "description": new_description,
        "history": history + [{
            "description": current_description,
            "passed": eval_results["summary"]["passed"],
            "failed": eval_results["summary"]["failed"],
            "total": eval_results["summary"]["total"],
            "results": eval_results["results"],
        }],
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/package_skill.py": {
      "text": `#!/usr/bin/env python3
"""
Skill Packager - Creates a distributable .skill file of a skill folder

Usage:
    python utils/package_skill.py <path/to/skill-folder> [output-directory]

Example:
    python utils/package_skill.py skills/public/my-skill
    python utils/package_skill.py skills/public/my-skill ./dist
"""

import fnmatch
import sys
import zipfile
from pathlib import Path
from scripts.quick_validate import validate_skill

# Patterns to exclude when packaging skills.
EXCLUDE_DIRS = {"__pycache__", "node_modules"}
EXCLUDE_GLOBS = {"*.pyc"}
EXCLUDE_FILES = {".DS_Store"}
# Directories excluded only at the skill root (not when nested deeper).
ROOT_EXCLUDE_DIRS = {"evals"}


def should_exclude(rel_path: Path) -> bool:
    """Check if a path should be excluded from packaging."""
    parts = rel_path.parts
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    # rel_path is relative to skill_path.parent, so parts[0] is the skill
    # folder name and parts[1] (if present) is the first subdir.
    if len(parts) > 1 and parts[1] in ROOT_EXCLUDE_DIRS:
        return True
    name = rel_path.name
    if name in EXCLUDE_FILES:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_GLOBS)


def package_skill(skill_path, output_dir=None):
    """
    Package a skill folder into a .skill file.

    Args:
        skill_path: Path to the skill folder
        output_dir: Optional output directory for the .skill file (defaults to current directory)

    Returns:
        Path to the created .skill file, or None if error
    """
    skill_path = Path(skill_path).resolve()

    # Validate skill folder exists
    if not skill_path.exists():
        print(f"\u274C Error: Skill folder not found: {skill_path}")
        return None

    if not skill_path.is_dir():
        print(f"\u274C Error: Path is not a directory: {skill_path}")
        return None

    # Validate SKILL.md exists
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        print(f"\u274C Error: SKILL.md not found in {skill_path}")
        return None

    # Run validation before packaging
    print("\u{1F50D} Validating skill...")
    valid, message = validate_skill(skill_path)
    if not valid:
        print(f"\u274C Validation failed: {message}")
        print("   Please fix the validation errors before packaging.")
        return None
    print(f"\u2705 {message}\\n")

    # Determine output location
    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"

    # Create the .skill file (zip format)
    try:
        with zipfile.ZipFile(skill_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Walk through the skill directory, excluding build artifacts
            for file_path in skill_path.rglob('*'):
                if not file_path.is_file():
                    continue
                arcname = file_path.relative_to(skill_path.parent)
                if should_exclude(arcname):
                    print(f"  Skipped: {arcname}")
                    continue
                zipf.write(file_path, arcname)
                print(f"  Added: {arcname}")

        print(f"\\n\u2705 Successfully packaged skill to: {skill_filename}")
        return skill_filename

    except Exception as e:
        print(f"\u274C Error creating .skill file: {e}")
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python utils/package_skill.py <path/to/skill-folder> [output-directory]")
        print("\\nExample:")
        print("  python utils/package_skill.py skills/public/my-skill")
        print("  python utils/package_skill.py skills/public/my-skill ./dist")
        sys.exit(1)

    skill_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"\u{1F4E6} Packaging skill: {skill_path}")
    if output_dir:
        print(f"   Output directory: {output_dir}")
    print()

    result = package_skill(skill_path, output_dir)

    if result:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/quick_validate.py": {
      "text": `#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import sys
import os
import re
import yaml
from pathlib import Path

def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    # Check SKILL.md exists
    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        return False, "SKILL.md not found"

    # Read and validate frontmatter
    content = skill_md.read_text()
    if not content.startswith('---'):
        return False, "No YAML frontmatter found"

    # Extract frontmatter
    match = re.match(r'^---\\n(.*?)\\n---', content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    # Parse YAML frontmatter
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return False, "Frontmatter must be a YAML dictionary"
    except yaml.YAMLError as e:
        return False, f"Invalid YAML in frontmatter: {e}"

    # Define allowed properties
    ALLOWED_PROPERTIES = {'name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'}

    # Check for unexpected properties (excluding nested keys under metadata)
    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    # Check required fields
    if 'name' not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if 'description' not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    # Extract name for validation
    name = frontmatter.get('name', '')
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        # Check naming convention (kebab-case: lowercase with hyphens)
        if not re.match(r'^[a-z0-9-]+$', name):
            return False, f"Name '{name}' should be kebab-case (lowercase letters, digits, and hyphens only)"
        if name.startswith('-') or name.endswith('-') or '--' in name:
            return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        # Check name length (max 64 characters per spec)
        if len(name) > 64:
            return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."

    # Extract and validate description
    description = frontmatter.get('description', '')
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        # Check for angle brackets
        if '<' in description or '>' in description:
            return False, "Description cannot contain angle brackets (< or >)"
        # Check description length (max 1024 characters per spec)
        if len(description) > 1024:
            return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    # Validate compatibility field if present (optional)
    compatibility = frontmatter.get('compatibility', '')
    if compatibility:
        if not isinstance(compatibility, str):
            return False, f"Compatibility must be a string, got {type(compatibility).__name__}"
        if len(compatibility) > 500:
            return False, f"Compatibility is too long ({len(compatibility)} characters). Maximum is 500 characters."

    return True, "Skill is valid!"

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)`,
      "mode": 493
    },
    "scripts/run_eval.py": {
      "text": `#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Claude to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so the command file
    we create ends up where claude -p will look for it.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Creates a command file in .claude/commands/ so it appears in Claude's
    available_skills list, then runs \`claude -p\` with the raw query.
    Uses --include-partial-messages to detect triggering early from
    stream events (content_block_start) rather than waiting for the
    full assistant message, which only arrives after tool execution.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"

    try:
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        # Use YAML block scalar to avoid breaking on quotes in description
        indented_desc = "\\n  ".join(skill_description.split("\\n"))
        command_content = (
            f"---\\n"
            f"description: |\\n"
            f"  {indented_desc}\\n"
            f"---\\n\\n"
            f"# {skill_name}\\n\\n"
            f"This skill handles: {skill_description}\\n"
        )
        command_file.write_text(command_content)

        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
        if model:
            cmd.extend(["--model", model])

        # Remove CLAUDECODE env var to allow nesting claude -p inside a
        # Claude Code session. The guard is for interactive terminal conflicts;
        # programmatic subprocess usage is safe.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=env,
        )

        triggered = False
        start_time = time.time()
        buffer = ""
        # Track state for stream event detection
        pending_tool_name = None
        accumulated_json = ""

        try:
            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    remaining = process.stdout.read()
                    if remaining:
                        buffer += remaining.decode("utf-8", errors="replace")
                    break

                ready, _, _ = select.select([process.stdout], [], [], 1.0)
                if not ready:
                    continue

                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                while "\\n" in buffer:
                    line, buffer = buffer.split("\\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Early detection via stream events
                    if event.get("type") == "stream_event":
                        se = event.get("event", {})
                        se_type = se.get("type", "")

                        if se_type == "content_block_start":
                            cb = se.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                tool_name = cb.get("name", "")
                                if tool_name in ("Skill", "Read"):
                                    pending_tool_name = tool_name
                                    accumulated_json = ""
                                else:
                                    return False

                        elif se_type == "content_block_delta" and pending_tool_name:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                if clean_name in accumulated_json:
                                    return True

                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                return clean_name in accumulated_json
                            if se_type == "message_stop":
                                return False

                    # Fallback: full assistant message
                    elif event.get("type") == "assistant":
                        message = event.get("message", {})
                        for content_item in message.get("content", []):
                            if content_item.get("type") != "tool_use":
                                continue
                            tool_name = content_item.get("name", "")
                            tool_input = content_item.get("input", {})
                            if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered

                    elif event.get("type") == "result":
                        return triggered
        finally:
            # Clean up process on any exit path (return, exception, timeout)
            if process.poll() is None:
                process.kill()
                process.wait()

        return triggered
    finally:
        if command_file.exists():
            command_file.unlink()


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for claude -p (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/run_loop.py": {
      "text": `#!/usr/bin/env python3
"""Run the eval + improve loop until all pass or max iterations reached.

Combines run_eval.py and improve_description.py in a loop, tracking history
and returning the best description found. Supports train/test split to prevent
overfitting.
"""

import argparse
import json
import random
import sys
import tempfile
import time
import webbrowser
from pathlib import Path

from scripts.generate_report import generate_html
from scripts.improve_description import improve_description
from scripts.run_eval import find_project_root, run_eval
from scripts.utils import parse_skill_md


def split_eval_set(eval_set: list[dict], holdout: float, seed: int = 42) -> tuple[list[dict], list[dict]]:
    """Split eval set into train and test sets, stratified by should_trigger."""
    random.seed(seed)

    # Separate by should_trigger
    trigger = [e for e in eval_set if e["should_trigger"]]
    no_trigger = [e for e in eval_set if not e["should_trigger"]]

    # Shuffle each group
    random.shuffle(trigger)
    random.shuffle(no_trigger)

    # Calculate split points
    n_trigger_test = max(1, int(len(trigger) * holdout))
    n_no_trigger_test = max(1, int(len(no_trigger) * holdout))

    # Split
    test_set = trigger[:n_trigger_test] + no_trigger[:n_no_trigger_test]
    train_set = trigger[n_trigger_test:] + no_trigger[n_no_trigger_test:]

    return train_set, test_set


def run_loop(
    eval_set: list[dict],
    skill_path: Path,
    description_override: str | None,
    num_workers: int,
    timeout: int,
    max_iterations: int,
    runs_per_query: int,
    trigger_threshold: float,
    holdout: float,
    model: str,
    verbose: bool,
    live_report_path: Path | None = None,
    log_dir: Path | None = None,
) -> dict:
    """Run the eval + improvement loop."""
    project_root = find_project_root()
    name, original_description, content = parse_skill_md(skill_path)
    current_description = description_override or original_description

    # Split into train/test if holdout > 0
    if holdout > 0:
        train_set, test_set = split_eval_set(eval_set, holdout)
        if verbose:
            print(f"Split: {len(train_set)} train, {len(test_set)} test (holdout={holdout})", file=sys.stderr)
    else:
        train_set = eval_set
        test_set = []

    history = []
    exit_reason = "unknown"

    for iteration in range(1, max_iterations + 1):
        if verbose:
            print(f"\\n{'='*60}", file=sys.stderr)
            print(f"Iteration {iteration}/{max_iterations}", file=sys.stderr)
            print(f"Description: {current_description}", file=sys.stderr)
            print(f"{'='*60}", file=sys.stderr)

        # Evaluate train + test together in one batch for parallelism
        all_queries = train_set + test_set
        t0 = time.time()
        all_results = run_eval(
            eval_set=all_queries,
            skill_name=name,
            description=current_description,
            num_workers=num_workers,
            timeout=timeout,
            project_root=project_root,
            runs_per_query=runs_per_query,
            trigger_threshold=trigger_threshold,
            model=model,
        )
        eval_elapsed = time.time() - t0

        # Split results back into train/test by matching queries
        train_queries_set = {q["query"] for q in train_set}
        train_result_list = [r for r in all_results["results"] if r["query"] in train_queries_set]
        test_result_list = [r for r in all_results["results"] if r["query"] not in train_queries_set]

        train_passed = sum(1 for r in train_result_list if r["pass"])
        train_total = len(train_result_list)
        train_summary = {"passed": train_passed, "failed": train_total - train_passed, "total": train_total}
        train_results = {"results": train_result_list, "summary": train_summary}

        if test_set:
            test_passed = sum(1 for r in test_result_list if r["pass"])
            test_total = len(test_result_list)
            test_summary = {"passed": test_passed, "failed": test_total - test_passed, "total": test_total}
            test_results = {"results": test_result_list, "summary": test_summary}
        else:
            test_results = None
            test_summary = None

        history.append({
            "iteration": iteration,
            "description": current_description,
            "train_passed": train_summary["passed"],
            "train_failed": train_summary["failed"],
            "train_total": train_summary["total"],
            "train_results": train_results["results"],
            "test_passed": test_summary["passed"] if test_summary else None,
            "test_failed": test_summary["failed"] if test_summary else None,
            "test_total": test_summary["total"] if test_summary else None,
            "test_results": test_results["results"] if test_results else None,
            # For backward compat with report generator
            "passed": train_summary["passed"],
            "failed": train_summary["failed"],
            "total": train_summary["total"],
            "results": train_results["results"],
        })

        # Write live report if path provided
        if live_report_path:
            partial_output = {
                "original_description": original_description,
                "best_description": current_description,
                "best_score": "in progress",
                "iterations_run": len(history),
                "holdout": holdout,
                "train_size": len(train_set),
                "test_size": len(test_set),
                "history": history,
            }
            live_report_path.write_text(generate_html(partial_output, auto_refresh=True, skill_name=name))

        if verbose:
            def print_eval_stats(label, results, elapsed):
                pos = [r for r in results if r["should_trigger"]]
                neg = [r for r in results if not r["should_trigger"]]
                tp = sum(r["triggers"] for r in pos)
                pos_runs = sum(r["runs"] for r in pos)
                fn = pos_runs - tp
                fp = sum(r["triggers"] for r in neg)
                neg_runs = sum(r["runs"] for r in neg)
                tn = neg_runs - fp
                total = tp + tn + fp + fn
                precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
                recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
                accuracy = (tp + tn) / total if total > 0 else 0.0
                print(f"{label}: {tp+tn}/{total} correct, precision={precision:.0%} recall={recall:.0%} accuracy={accuracy:.0%} ({elapsed:.1f}s)", file=sys.stderr)
                for r in results:
                    status = "PASS" if r["pass"] else "FAIL"
                    rate_str = f"{r['triggers']}/{r['runs']}"
                    print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:60]}", file=sys.stderr)

            print_eval_stats("Train", train_results["results"], eval_elapsed)
            if test_summary:
                print_eval_stats("Test ", test_results["results"], 0)

        if train_summary["failed"] == 0:
            exit_reason = f"all_passed (iteration {iteration})"
            if verbose:
                print(f"\\nAll train queries passed on iteration {iteration}!", file=sys.stderr)
            break

        if iteration == max_iterations:
            exit_reason = f"max_iterations ({max_iterations})"
            if verbose:
                print(f"\\nMax iterations reached ({max_iterations}).", file=sys.stderr)
            break

        # Improve the description based on train results
        if verbose:
            print(f"\\nImproving description...", file=sys.stderr)

        t0 = time.time()
        # Strip test scores from history so improvement model can't see them
        blinded_history = [
            {k: v for k, v in h.items() if not k.startswith("test_")}
            for h in history
        ]
        new_description = improve_description(
            skill_name=name,
            skill_content=content,
            current_description=current_description,
            eval_results=train_results,
            history=blinded_history,
            model=model,
            log_dir=log_dir,
            iteration=iteration,
        )
        improve_elapsed = time.time() - t0

        if verbose:
            print(f"Proposed ({improve_elapsed:.1f}s): {new_description}", file=sys.stderr)

        current_description = new_description

    # Find the best iteration by TEST score (or train if no test set)
    if test_set:
        best = max(history, key=lambda h: h["test_passed"] or 0)
        best_score = f"{best['test_passed']}/{best['test_total']}"
    else:
        best = max(history, key=lambda h: h["train_passed"])
        best_score = f"{best['train_passed']}/{best['train_total']}"

    if verbose:
        print(f"\\nExit reason: {exit_reason}", file=sys.stderr)
        print(f"Best score: {best_score} (iteration {best['iteration']})", file=sys.stderr)

    return {
        "exit_reason": exit_reason,
        "original_description": original_description,
        "best_description": best["description"],
        "best_score": best_score,
        "best_train_score": f"{best['train_passed']}/{best['train_total']}",
        "best_test_score": f"{best['test_passed']}/{best['test_total']}" if test_set else None,
        "final_description": current_description,
        "iterations_run": len(history),
        "holdout": holdout,
        "train_size": len(train_set),
        "test_size": len(test_set),
        "history": history,
    }


def main():
    parser = argparse.ArgumentParser(description="Run eval + improve loop")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override starting description")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--max-iterations", type=int, default=5, help="Max improvement iterations")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--holdout", type=float, default=0.4, help="Fraction of eval set to hold out for testing (0 to disable)")
    parser.add_argument("--model", required=True, help="Model for improvement")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    parser.add_argument("--report", default="auto", help="Generate HTML report at this path (default: 'auto' for temp file, 'none' to disable)")
    parser.add_argument("--results-dir", default=None, help="Save all outputs (results.json, report.html, log.txt) to a timestamped subdirectory here")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, _, _ = parse_skill_md(skill_path)

    # Set up live report path
    if args.report != "none":
        if args.report == "auto":
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            live_report_path = Path(tempfile.gettempdir()) / f"skill_description_report_{skill_path.name}_{timestamp}.html"
        else:
            live_report_path = Path(args.report)
        # Open the report immediately so the user can watch
        live_report_path.write_text("<html><body><h1>Starting optimization loop...</h1><meta http-equiv='refresh' content='5'></body></html>")
        webbrowser.open(str(live_report_path))
    else:
        live_report_path = None

    # Determine output directory (create before run_loop so logs can be written)
    if args.results_dir:
        timestamp = time.strftime("%Y-%m-%d_%H%M%S")
        results_dir = Path(args.results_dir) / timestamp
        results_dir.mkdir(parents=True, exist_ok=True)
    else:
        results_dir = None

    log_dir = results_dir / "logs" if results_dir else None

    output = run_loop(
        eval_set=eval_set,
        skill_path=skill_path,
        description_override=args.description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        max_iterations=args.max_iterations,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        holdout=args.holdout,
        model=args.model,
        verbose=args.verbose,
        live_report_path=live_report_path,
        log_dir=log_dir,
    )

    # Save JSON output
    json_output = json.dumps(output, indent=2)
    print(json_output)
    if results_dir:
        (results_dir / "results.json").write_text(json_output)

    # Write final HTML report (without auto-refresh)
    if live_report_path:
        live_report_path.write_text(generate_html(output, auto_refresh=False, skill_name=name))
        print(f"\\nReport: {live_report_path}", file=sys.stderr)

    if results_dir and live_report_path:
        (results_dir / "report.html").write_text(generate_html(output, auto_refresh=False, skill_name=name))

    if results_dir:
        print(f"Results saved to: {results_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
`,
      "mode": 493
    },
    "scripts/utils.py": {
      "text": `"""Shared utilities for skill-creator scripts."""

from pathlib import Path



def parse_skill_md(skill_path: Path) -> tuple[str, str, str]:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    content = (skill_path / "SKILL.md").read_text()
    lines = content.split("\\n")

    if lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    name = ""
    description = ""
    frontmatter_lines = lines[1:end_idx]
    i = 0
    while i < len(frontmatter_lines):
        line = frontmatter_lines[i]
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip('"').strip("'")
        elif line.startswith("description:"):
            value = line[len("description:"):].strip()
            # Handle YAML multiline indicators (>, |, >-, |-)
            if value in (">", "|", ">-", "|-"):
                continuation_lines: list[str] = []
                i += 1
                while i < len(frontmatter_lines) and (frontmatter_lines[i].startswith("  ") or frontmatter_lines[i].startswith("\\t")):
                    continuation_lines.append(frontmatter_lines[i].strip())
                    i += 1
                description = " ".join(continuation_lines)
                continue
            else:
                description = value.strip('"').strip("'")
        i += 1

    return name, description, content
`,
      "mode": 493
    },
    "SKILL.md": {
      "text": '---\nname: skill-creator\ndescription: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill\'s description for better triggering accuracy.\n---\n\n# Skill Creator\n\nA skill for creating new skills and iteratively improving them.\n\nAt a high level, the process of creating a skill goes like this:\n\n- Decide what you want the skill to do and roughly how it should do it\n- Write a draft of the skill\n- Create a few test prompts and run claude-with-access-to-the-skill on them\n- Help the user evaluate the results both qualitatively and quantitatively\n  - While the runs happen in the background, draft some quantitative evals if there aren\'t any (if there are some, you can either use as is or modify if you feel something needs to change about them). Then explain them to the user (or if they already existed, explain the ones that already exist)\n  - Use the `eval-viewer/generate_review.py` script to show the user the results for them to look at, and also let them look at the quantitative metrics\n- Rewrite the skill based on feedback from the user\'s evaluation of the results (and also if there are any glaring flaws that become apparent from the quantitative benchmarks)\n- Repeat until you\'re satisfied\n- Expand the test set and try again at larger scale\n\nYour job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they\'re like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.\n\nOn the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.\n\nOf course, you should always be flexible and if the user is like "I don\'t need to run a bunch of evaluations, just vibe with me", you can do that instead.\n\nThen after the skill is done (but again, the order is flexible), you can also run the skill description improver, which we have a whole separate script for, to optimize the triggering of the skill.\n\nCool? Cool.\n\n## Communicating with the user\n\nThe skill creator is liable to be used by people across a wide range of familiarity with coding jargon. If you haven\'t heard (and how could you, it\'s only very recently that it started), there\'s a trend now where the power of Claude is inspiring plumbers to open up their terminals, parents and grandparents to google "how to install npm". On the other hand, the bulk of users are probably fairly computer-literate.\n\nSo please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:\n\n- "evaluation" and "benchmark" are borderline, but OK\n- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them\n\nIt\'s OK to briefly explain terms if you\'re in doubt, and feel free to clarify terms with a short definition if you\'re unsure if the user will get it.\n\n---\n\n## Creating a skill\n\n### Capture Intent\n\nStart by understanding the user\'s intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first \u2014 the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.\n\n1. What should this skill enable Claude to do?\n2. When should this skill trigger? (what user phrases/contexts)\n3. What\'s the expected output format?\n4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don\'t need them. Suggest the appropriate default based on the skill type, but let the user decide.\n\n### Interview and Research\n\nProactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you\'ve got this part ironed out.\n\nCheck available MCPs - if useful for research (searching docs, finding similar skills, looking up best practices), research in parallel via subagents if available, otherwise inline. Come prepared with context to reduce burden on the user.\n\n### Write the SKILL.md\n\nBased on the user interview, fill in these components:\n\n- **name**: Skill identifier\n- **description**: When to trigger, what it does. This is the primary triggering mechanism - include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Note: currently Claude has a tendency to "undertrigger" skills -- to not use them when they\'d be useful. To combat this, please make the skill descriptions a little bit "pushy". So for instance, instead of "How to build a simple fast dashboard to display internal Anthropic data.", you might write "How to build a simple fast dashboard to display internal Anthropic data. Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don\'t explicitly ask for a \'dashboard.\'"\n- **compatibility**: Required tools, dependencies (optional, rarely needed)\n- **the rest of the skill :)**\n\n### Skill Writing Guide\n\n#### Anatomy of a Skill\n\n```\nskill-name/\n\u251C\u2500\u2500 SKILL.md (required)\n\u2502   \u251C\u2500\u2500 YAML frontmatter (name, description required)\n\u2502   \u2514\u2500\u2500 Markdown instructions\n\u2514\u2500\u2500 Bundled Resources (optional)\n    \u251C\u2500\u2500 scripts/    - Executable code for deterministic/repetitive tasks\n    \u251C\u2500\u2500 references/ - Docs loaded into context as needed\n    \u2514\u2500\u2500 assets/     - Files used in output (templates, icons, fonts)\n```\n\n#### Progressive Disclosure\n\nSkills use a three-level loading system:\n1. **Metadata** (name + description) - Always in context (~100 words)\n2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)\n3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)\n\nThese word counts are approximate and you can feel free to go longer if needed.\n\n**Key patterns:**\n- Keep SKILL.md under 500 lines; if you\'re approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next to follow up.\n- Reference files clearly from SKILL.md with guidance on when to read them\n- For large reference files (>300 lines), include a table of contents\n\n**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:\n```\ncloud-deploy/\n\u251C\u2500\u2500 SKILL.md (workflow + selection)\n\u2514\u2500\u2500 references/\n    \u251C\u2500\u2500 aws.md\n    \u251C\u2500\u2500 gcp.md\n    \u2514\u2500\u2500 azure.md\n```\nClaude reads only the relevant reference file.\n\n#### Principle of Lack of Surprise\n\nThis goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill\'s contents should not surprise the user in their intent if described. Don\'t go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.\n\n#### Writing Patterns\n\nPrefer using the imperative form in instructions.\n\n**Defining output formats** - You can do it like this:\n```markdown\n## Report structure\nALWAYS use this exact template:\n# [Title]\n## Executive summary\n## Key findings\n## Recommendations\n```\n\n**Examples pattern** - It\'s useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):\n```markdown\n## Commit message format\n**Example 1:**\nInput: Added user authentication with JWT tokens\nOutput: feat(auth): implement JWT-based authentication\n```\n\n### Writing Style\n\nTry to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.\n\n### Test Cases\n\nAfter writing the skill draft, come up with 2-3 realistic test prompts \u2014 the kind of thing a real user would actually say. Share them with the user: [you don\'t have to use this exact language] "Here are a few test cases I\'d like to try. Do these look right, or do you want to add more?" Then run them.\n\nSave test cases to `evals/evals.json`. Don\'t write assertions yet \u2014 just the prompts. You\'ll draft assertions in the next step while the runs are in progress.\n\n```json\n{\n  "skill_name": "example-skill",\n  "evals": [\n    {\n      "id": 1,\n      "prompt": "User\'s task prompt",\n      "expected_output": "Description of expected result",\n      "files": []\n    }\n  ]\n}\n```\n\nSee `references/schemas.md` for the full schema (including the `assertions` field, which you\'ll add later).\n\n## Running and evaluating test cases\n\nThis section is one continuous sequence \u2014 don\'t stop partway through. Do NOT use `/skill-test` or any other testing skill.\n\nPut results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.) and within that, each test case gets a directory (`eval-0/`, `eval-1/`, etc.). Don\'t create all of this upfront \u2014 just create directories as you go.\n\n### Step 1: Spawn all runs (with-skill AND baseline) in the same turn\n\nFor each test case, spawn two subagents in the same turn \u2014 one with the skill, one without. This is important: don\'t spawn the with-skill runs first and then come back for baselines later. Launch everything at once so it all finishes around the same time.\n\n**With-skill run:**\n\n```\nExecute this task:\n- Skill path: <path-to-skill>\n- Task: <eval prompt>\n- Input files: <eval files if any, or "none">\n- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/\n- Outputs to save: <what the user cares about \u2014 e.g., "the .docx file", "the final CSV">\n```\n\n**Baseline run** (same prompt, but the baseline depends on context):\n- **Creating a new skill**: no skill at all. Same prompt, no skill path, save to `without_skill/outputs/`.\n- **Improving an existing skill**: the old version. Before editing, snapshot the skill (`cp -r <skill-path> <workspace>/skill-snapshot/`), then point the baseline subagent at the snapshot. Save to `old_skill/outputs/`.\n\nWrite an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it\'s testing \u2014 not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory \u2014 don\'t assume they carry over from previous iterations.\n\n```json\n{\n  "eval_id": 0,\n  "eval_name": "descriptive-name-here",\n  "prompt": "The user\'s task prompt",\n  "assertions": []\n}\n```\n\n### Step 2: While runs are in progress, draft assertions\n\nDon\'t just wait for the runs to finish \u2014 you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.\n\nGood assertions are objectively verifiable and have descriptive names \u2014 they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively \u2014 don\'t force assertions onto things that need human judgment.\n\nUpdate the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they\'ll see in the viewer \u2014 both the qualitative outputs and the quantitative benchmark.\n\n### Step 3: As runs complete, capture timing data\n\nWhen each subagent task completes, you receive a notification containing `total_tokens` and `duration_ms`. Save this data immediately to `timing.json` in the run directory:\n\n```json\n{\n  "total_tokens": 84852,\n  "duration_ms": 23332,\n  "total_duration_seconds": 23.3\n}\n```\n\nThis is the only opportunity to capture this data \u2014 it comes through the task notification and isn\'t persisted elsewhere. Process each notification as it arrives rather than trying to batch them.\n\n### Step 4: Grade, aggregate, and launch the viewer\n\nOnce all runs are done:\n\n1. **Grade each run** \u2014 spawn a grader subagent (or grade inline) that reads `agents/grader.md` and evaluates each assertion against the outputs. Save results to `grading.json` in each run directory. The grading.json expectations array must use the fields `text`, `passed`, and `evidence` (not `name`/`met`/`details` or other variants) \u2014 the viewer depends on these exact field names. For assertions that can be checked programmatically, write and run a script rather than eyeballing it \u2014 scripts are faster, more reliable, and can be reused across iterations.\n\n2. **Aggregate into benchmark** \u2014 run the aggregation script from the skill-creator directory:\n   ```bash\n   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>\n   ```\n   This produces `benchmark.json` and `benchmark.md` with pass_rate, time, and tokens for each configuration, with mean \xB1 stddev and the delta. If generating benchmark.json manually, see `references/schemas.md` for the exact schema the viewer expects.\nPut each with_skill version before its baseline counterpart.\n\n3. **Do an analyst pass** \u2014 read the benchmark data and surface patterns the aggregate stats might hide. See `agents/analyzer.md` (the "Analyzing Benchmark Results" section) for what to look for \u2014 things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.\n\n4. **Launch the viewer** with both qualitative outputs and quantitative data:\n   ```bash\n   nohup python <skill-creator-path>/eval-viewer/generate_review.py \\\n     <workspace>/iteration-N \\\n     --skill-name "my-skill" \\\n     --benchmark <workspace>/iteration-N/benchmark.json \\\n     > /dev/null 2>&1 &\n   VIEWER_PID=$!\n   ```\n   For iteration 2+, also pass `--previous-workspace <workspace>/iteration-<N-1>`.\n\n   **Cowork / headless environments:** If `webbrowser.open()` is not available or the environment has no display, use `--static <output_path>` to write a standalone HTML file instead of starting a server. Feedback will be downloaded as a `feedback.json` file when the user clicks "Submit All Reviews". After download, copy `feedback.json` into the workspace directory for the next iteration to pick up.\n\nNote: please use generate_review.py to create the viewer; there\'s no need to write custom HTML.\n\n5. **Tell the user** something like: "I\'ve opened the results in your browser. There are two tabs \u2014 \'Outputs\' lets you click through each test case and leave feedback, \'Benchmark\' shows the quantitative comparison. When you\'re done, come back here and let me know."\n\n### What the user sees in the viewer\n\nThe "Outputs" tab shows one test case at a time:\n- **Prompt**: the task that was given\n- **Output**: the files the skill produced, rendered inline where possible\n- **Previous Output** (iteration 2+): collapsed section showing last iteration\'s output\n- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail\n- **Feedback**: a textbox that auto-saves as they type\n- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox\n\nThe "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.\n\nNavigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json`.\n\n### Step 5: Read the feedback\n\nWhen the user tells you they\'re done, read `feedback.json`:\n\n```json\n{\n  "reviews": [\n    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},\n    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},\n    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}\n  ],\n  "status": "complete"\n}\n```\n\nEmpty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.\n\nKill the viewer server when you\'re done with it:\n\n```bash\nkill $VIEWER_PID 2>/dev/null\n```\n\n---\n\n## Improving the skill\n\nThis is the heart of the loop. You\'ve run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.\n\n### How to think about improvements\n\n1. **Generalize from the feedback.** The big picture thing that\'s happening here is that we\'re trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it\'s quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it\'s useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there\'s some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It\'s relatively cheap to try and maybe you\'ll land on something great.\n\n2. **Keep the prompt lean.** Remove things that aren\'t pulling their weight. Make sure to read the transcripts, not just the final outputs \u2014 if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.\n\n3. **Explain the why.** Try hard to explain the **why** behind everything you\'re asking the model to do. Today\'s LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that\'s a yellow flag \u2014 if possible, reframe and explain the reasoning so that the model understands why the thing you\'re asking for is important. That\'s a more humane, powerful, and effective approach.\n\n4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the subagents all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the subagent writing a `create_docx.py` or a `build_chart.py`, that\'s a strong signal the skill should bundle that script. Write it once, put it in `scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.\n\nThis task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I\'d suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.\n\n### The iteration loop\n\nAfter improving the skill:\n\n1. Apply your improvements to the skill\n2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs. If you\'re creating a new skill, the baseline is always `without_skill` (no skill) \u2014 that stays the same across iterations. If you\'re improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.\n3. Launch the reviewer with `--previous-workspace` pointing at the previous iteration\n4. Wait for the user to review and tell you they\'re done\n5. Read the new feedback, improve again, repeat\n\nKeep going until:\n- The user says they\'re happy\n- The feedback is all empty (everything looks good)\n- You\'re not making meaningful progress\n\n---\n\n## Advanced: Blind comparison\n\nFor situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there\'s a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.\n\nThis is optional, requires subagents, and most users won\'t need it. The human review loop is usually sufficient.\n\n---\n\n## Description Optimization\n\nThe description field in SKILL.md frontmatter is the primary mechanism that determines whether Claude invokes a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy.\n\n### Step 1: Generate trigger eval queries\n\nCreate 20 eval queries \u2014 a mix of should-trigger and should-not-trigger. Save as JSON:\n\n```json\n[\n  {"query": "the user prompt", "should_trigger": true},\n  {"query": "another prompt", "should_trigger": false}\n]\n```\n\nThe queries must be realistic and something a Claude Code or Claude.ai user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail. For instance, file paths, personal context about the user\'s job or situation, column names and values, company names, URLs. A little bit of backstory. Some might be in lowercase or contain abbreviations or typos or casual speech. Use a mix of different lengths, and focus on edge cases rather than making them clear-cut (the user will get a chance to sign off on them).\n\nBad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`\n\nGood: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like \'Q4 sales final FINAL v2.xlsx\') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`\n\nFor the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent \u2014 some formal, some casual. Include cases where the user doesn\'t explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.\n\nFor the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses \u2014 queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn\'t, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.\n\nThe key thing to avoid: don\'t make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy \u2014 it doesn\'t test anything. The negative cases should be genuinely tricky.\n\n### Step 2: Review with user\n\nPresent the eval set to the user for review using the HTML template:\n\n1. Read the template from `assets/eval_review.html`\n2. Replace the placeholders:\n   - `__EVAL_DATA_PLACEHOLDER__` \u2192 the JSON array of eval items (no quotes around it \u2014 it\'s a JS variable assignment)\n   - `__SKILL_NAME_PLACEHOLDER__` \u2192 the skill\'s name\n   - `__SKILL_DESCRIPTION_PLACEHOLDER__` \u2192 the skill\'s current description\n3. Write to a temp file (e.g., `/tmp/eval_review_<skill-name>.html`) and open it: `open /tmp/eval_review_<skill-name>.html`\n4. The user can edit queries, toggle should-trigger, add/remove entries, then click "Export Eval Set"\n5. The file downloads to `~/Downloads/eval_set.json` \u2014 check the Downloads folder for the most recent version in case there are multiple (e.g., `eval_set (1).json`)\n\nThis step matters \u2014 bad eval queries lead to bad descriptions.\n\n### Step 3: Run the optimization loop\n\nTell the user: "This will take some time \u2014 I\'ll run the optimization loop in the background and check on it periodically."\n\nSave the eval set to the workspace, then run in the background:\n\n```bash\npython -m scripts.run_loop \\\n  --eval-set <path-to-trigger-eval.json> \\\n  --skill-path <path-to-skill> \\\n  --model <model-id-powering-this-session> \\\n  --max-iterations 5 \\\n  --verbose\n```\n\nUse the model ID from your system prompt (the one powering the current session) so the triggering test matches what the user actually experiences.\n\nWhile it runs, periodically tail the output to give the user updates on which iteration it\'s on and what the scores look like.\n\nThis handles the full optimization loop automatically. It splits the eval set into 60% train and 40% held-out test, evaluates the current description (running each query 3 times to get a reliable trigger rate), then calls Claude to propose improvements based on what failed. It re-evaluates each new description on both train and test, iterating up to 5 times. When it\'s done, it opens an HTML report in the browser showing the results per iteration and returns JSON with `best_description` \u2014 selected by test score rather than train score to avoid overfitting.\n\n### How skill triggering works\n\nUnderstanding the triggering mechanism helps design better eval queries. Skills appear in Claude\'s `available_skills` list with their name + description, and Claude decides whether to consult a skill based on that description. The important thing to know is that Claude only consults skills for tasks it can\'t easily handle on its own \u2014 simple, one-step queries like "read this PDF" may not trigger a skill even if the description matches perfectly, because Claude can handle them directly with basic tools. Complex, multi-step, or specialized queries reliably trigger skills when the description matches.\n\nThis means your eval queries should be substantive enough that Claude would actually benefit from consulting a skill. Simple queries like "read file X" are poor test cases \u2014 they won\'t trigger skills regardless of description quality.\n\n### Step 4: Apply the result\n\nTake `best_description` from the JSON output and update the skill\'s SKILL.md frontmatter. Show the user before/after and report the scores.\n\n---\n\n### Package and Present (only if `present_files` tool is available)\n\nCheck whether you have access to the `present_files` tool. If you don\'t, skip this step. If you do, package the skill and present the .skill file to the user:\n\n```bash\npython -m scripts.package_skill <path/to/skill-folder>\n```\n\nAfter packaging, direct the user to the resulting `.skill` file path so they can install it.\n\n---\n\n## Claude.ai-specific instructions\n\nIn Claude.ai, the core workflow is the same (draft \u2192 test \u2192 review \u2192 improve \u2192 repeat), but because Claude.ai doesn\'t have subagents, some mechanics change. Here\'s what to adapt:\n\n**Running test cases**: No subagents means no parallel execution. For each test case, read the skill\'s SKILL.md, then follow its instructions to accomplish the test prompt yourself. Do them one at a time. This is less rigorous than independent subagents (you wrote the skill and you\'re also running it, so you have full context), but it\'s a useful sanity check \u2014 and the human review step compensates. Skip the baseline runs \u2014 just use the skill to complete the task as requested.\n\n**Reviewing results**: If you can\'t open a browser (e.g., Claude.ai\'s VM has no display, or you\'re on a remote server), skip the browser reviewer entirely. Instead, present results directly in the conversation. For each test case, show the prompt and the output. If the output is a file the user needs to see (like a .docx or .xlsx), save it to the filesystem and tell them where it is so they can download and inspect it. Ask for feedback inline: "How does this look? Anything you\'d change?"\n\n**Benchmarking**: Skip the quantitative benchmarking \u2014 it relies on baseline comparisons which aren\'t meaningful without subagents. Focus on qualitative feedback from the user.\n\n**The iteration loop**: Same as before \u2014 improve the skill, rerun the test cases, ask for feedback \u2014 just without the browser reviewer in the middle. You can still organize results into iteration directories on the filesystem if you have one.\n\n**Description optimization**: This section requires the `claude` CLI tool (specifically `claude -p`) which is only available in Claude Code. Skip it if you\'re on Claude.ai.\n\n**Blind comparison**: Requires subagents. Skip it.\n\n**Packaging**: The `package_skill.py` script works anywhere with Python and a filesystem. On Claude.ai, you can run it and the user can download the resulting `.skill` file.\n\n**Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. In this case:\n- **Preserve the original name.** Note the skill\'s directory name and `name` frontmatter field -- use them unchanged. E.g., if the installed skill is `research-helper`, output `research-helper.skill` (not `research-helper-v2`).\n- **Copy to a writeable location before editing.** The installed skill path may be read-only. Copy to `/tmp/skill-name/`, edit there, and package from the copy.\n- **If packaging manually, stage in `/tmp/` first**, then copy to the output directory -- direct writes may fail due to permissions.\n\n---\n\n## Cowork-Specific Instructions\n\nIf you\'re in Cowork, the main things to know are:\n\n- You have subagents, so the main workflow (spawn test cases in parallel, run baselines, grade, etc.) all works. (However, if you run into severe problems with timeouts, it\'s OK to run the test prompts in series rather than parallel.)\n- You don\'t have a browser or display, so when generating the eval viewer, use `--static <output_path>` to write a standalone HTML file instead of starting a server. Then proffer a link that the user can click to open the HTML in their browser.\n- For whatever reason, the Cowork setup seems to disincline Claude from generating the eval viewer after running the tests, so just to reiterate: whether you\'re in Cowork or in Claude Code, after running tests, you should always generate the eval viewer for the human to look at examples before revising the skill yourself and trying to make corrections, using `generate_review.py` (not writing your own boutique html code). Sorry in advance but I\'m gonna go all caps here: GENERATE THE EVAL VIEWER *BEFORE* evaluating inputs yourself. You want to get them in front of the human ASAP!\n- Feedback works differently: since there\'s no running server, the viewer\'s "Submit All Reviews" button will download `feedback.json` as a file. You can then read it from there (you may have to request access first).\n- Packaging works \u2014 `package_skill.py` just needs Python and a filesystem.\n- Description optimization (`run_loop.py` / `run_eval.py`) should work in Cowork just fine since it uses `claude -p` via subprocess, not a browser, but please save it until you\'ve fully finished making the skill and the user agrees it\'s in good shape.\n- **Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. Follow the update guidance in the claude.ai section above.\n\n---\n\n## Reference files\n\nThe agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.\n\n- `agents/grader.md` \u2014 How to evaluate assertions against outputs\n- `agents/comparator.md` \u2014 How to do blind A/B comparison between two outputs\n- `agents/analyzer.md` \u2014 How to analyze why one version beat another\n\nThe references/ directory has additional documentation:\n- `references/schemas.md` \u2014 JSON structures for evals.json, grading.json, etc.\n\n---\n\nRepeating one more time the core loop here for emphasis:\n\n- Figure out what the skill is about\n- Draft or edit the skill\n- Run claude-with-access-to-the-skill on test prompts\n- With the user, evaluate the outputs:\n  - Create benchmark.json and run `eval-viewer/generate_review.py` to help the user review them\n  - Run quantitative evals\n- Repeat until you and the user are satisfied\n- Package the final skill and return it to the user.\n\nPlease add steps to your TodoList, if you have such a thing, to make sure you don\'t forget. If you\'re in Cowork, please specifically put "Create evals JSON and run `eval-viewer/generate_review.py` so human can review test cases" in your TodoList to make sure it happens.\n\nGood luck!\n',
      "mode": 420
    }
  }
};

// src/builtin.ts
var BUILTIN_DIR_NAME = ".builtin";
var STAMP = ".digest";
var README = `# \u5185\u7F6E\u6280\u80FD

\u8FD9\u4E2A\u76EE\u5F55\u7531 leo-plugin-skills \u7BA1\u7406\uFF1A\u63D2\u4EF6\u5347\u7EA7\u65F6\u4F1A\u6574\u4E2A\u91CD\u5199\uFF0C\u5728\u8FD9\u91CC\u7684\u6539\u52A8\u4F1A\u4E22\u5931\u3002

\u60F3\u6539\u67D0\u4E2A\u5185\u7F6E\u6280\u80FD\uFF1A\u628A\u5B83\u590D\u5236\u5230\u4E0A\u4E00\u7EA7\u76EE\u5F55\uFF08~/.leo/skills/<\u540C\u540D>/\uFF09\u518D\u6539\uFF0C\u540C\u540D\u7684\u7528\u6237\u6280\u80FD\u4F18\u5148\u4E8E\u5185\u7F6E\u6280\u80FD\u3002
\u4E0D\u60F3\u7528\u67D0\u4E2A\u5185\u7F6E\u6280\u80FD\uFF1A/skills disable <\u540D\u5B57>\uFF0C\u6216\u5728 skills.json \u7684 "disabled" \u91CC\u5199\u4E0A\u5B83\u3002
`;
async function materializeBuiltin(dir, skills = BUILTIN_SKILLS, digest = BUILTIN_DIGEST) {
  const names = Object.keys(skills);
  const current = await readFile(join(dir, STAMP), "utf8").catch(() => "");
  const present = new Set(await readdir(dir).catch(() => []));
  if (current.trim() === digest && names.every((n) => present.has(n))) return { written: false, names };
  await mkdir(dir, { recursive: true });
  for (const name of present) {
    if (name.startsWith(".") || name === "README.md" || name in skills) continue;
    await rm(join(dir, name), { recursive: true, force: true });
  }
  for (const [name, files] of Object.entries(skills)) {
    const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    for (const [rel, f] of Object.entries(files)) {
      const target = join(tmp, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.text);
      await chmod(target, f.mode).catch(() => {
      });
    }
    const dest = join(dir, name);
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  }
  await writeFile(join(dir, "README.md"), README);
  await writeFile(join(dir, STAMP), `${digest}
`);
  return { written: true, names };
}

// src/catalog.ts
import { readdir as readdir2, readFile as readFile2, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join as join2, relative, resolve, sep } from "node:path";

// src/frontmatter.ts
function splitFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return { body: src };
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      return { yaml: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { body: src };
}
function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function stripComment(v) {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const i = v.search(/\s#/);
  return i >= 0 ? v.slice(0, i) : v;
}
function scalar(raw) {
  const v = stripComment(raw).trim();
  if (v === "") return "";
  if (v === "true" || v === "True" || v === "TRUE") return true;
  if (v === "false" || v === "False" || v === "FALSE") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") || v.startsWith("{")) return void 0;
  return unquote(v);
}
function parseYamlSubset(yaml) {
  const out = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    const cont = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) cont.push(lines[j++]);
    while (cont.length && cont.at(-1).trim() === "") cont.pop();
    i = j - 1;
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest);
    if (block) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const body = cont.map((l) => l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : "");
      let text;
      if (block[1] === "|") text = body.join("\n");
      else {
        text = "";
        for (const l of body) {
          if (!l) text += "\n";
          else text += text && !text.endsWith("\n") ? ` ${l}` : l;
        }
      }
      out[key] = block[2] === "+" ? `${text}
` : block[2] === "-" ? text.replace(/\n+$/, "") : text.replace(/\n*$/, "\n").replace(/^\n$/, "");
      continue;
    }
    if (rest === "") {
      out[key] = cont.some((l) => l.trim()) ? void 0 : "";
      continue;
    }
    if (cont.some((l) => l.trim()) && !rest.startsWith('"') && !rest.startsWith("'")) {
      out[key] = scalar([rest, ...cont.map((l) => l.trim()).filter(Boolean)].join(" "));
      continue;
    }
    if ((rest.startsWith('"') || rest.startsWith("'")) && cont.length) {
      out[key] = unquote([rest, ...cont.map((l) => l.trim())].join(" "));
      continue;
    }
    out[key] = scalar(rest);
  }
  return out;
}
function parseSkillFile(text) {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === void 0) return { data: {}, body, hasFrontmatter: false };
  return { data: parseYamlSubset(yaml), body, hasFrontmatter: true };
}

// src/catalog.ts
var SOURCE_LABEL = { project: "\u9879\u76EE", custom: "\u81EA\u5B9A\u4E49\u76EE\u5F55", user: "\u7528\u6237", builtin: "\u5185\u7F6E" };
var SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var isSkillName = (s) => s.length <= 64 && SKILL_NAME_RE.test(s);
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join2(homedir(), p.slice(2));
  return p;
}
var SkillCatalog = class {
  constructor(roots) {
    this.roots = roots;
  }
  roots;
  cache = /* @__PURE__ */ new Map();
  /** 读一个 SKILL.md 的元数据；改动时间与大小没变就用缓存 */
  async readMeta(dirName, file) {
    let st;
    try {
      st = await stat(file);
    } catch {
      return void 0;
    }
    if (!st.isFile()) return void 0;
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
    let parsed;
    try {
      const { data, hasFrontmatter } = parseSkillFile(await readFile2(file, "utf8"));
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : dirName;
      const description = typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "";
      if (!hasFrontmatter) parsed = { error: "\u7F3A\u5C11 frontmatter\uFF08--- name / description ---\uFF09" };
      else if (!isSkillName(name)) parsed = { error: `\u6280\u80FD\u540D "${name}" \u4E0D\u5408\u6CD5\uFF1A\u53EA\u80FD\u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26\uFF0C\u6700\u957F 64 \u4E2A\u5B57\u7B26` };
      else if (!description) parsed = { error: "\u7F3A\u5C11 description" };
      else
        parsed = {
          name,
          description,
          modelInvocable: data["disable-model-invocation"] !== true,
          userInvocable: data["user-invocable"] !== false,
          ...typeof data.license === "string" && data.license ? { license: data.license } : {}
        };
    } catch (err) {
      parsed = { error: err.message };
    }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
    return parsed;
  }
  async scanRoot(root, diagnostics) {
    let entries;
    try {
      entries = await readdir2(root.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const dir = join2(root.dir, e.name);
      if (!e.isDirectory()) {
        if (!e.isSymbolicLink()) continue;
        const st = await stat(dir).catch(() => void 0);
        if (!st?.isDirectory()) continue;
      }
      const file = join2(dir, "SKILL.md");
      const meta = await this.readMeta(e.name, file);
      if (!meta) continue;
      if ("error" in meta) {
        diagnostics.push({ file, message: meta.error });
        continue;
      }
      out.push({ ...meta, source: root.source, dir, file, disabled: false });
    }
    return out;
  }
  async snapshot(disabled = []) {
    const diagnostics = [];
    const winners = /* @__PURE__ */ new Map();
    const shadowed = [];
    const seen = /* @__PURE__ */ new Set();
    const off = new Set(disabled);
    for (const root of this.roots()) {
      const key = resolve(root.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const s of await this.scanRoot(root, diagnostics)) {
        s.disabled = off.has(s.name);
        const win = winners.get(s.name);
        if (win) shadowed.push({ ...s, shadowedBy: win.source });
        else winners.set(s.name, s);
      }
    }
    return { skills: [...winners.values()].sort((a, b) => a.name.localeCompare(b.name)), shadowed, diagnostics };
  }
};
async function listResources(dir, limit = 80, depth = 3) {
  const files = [];
  let more = false;
  async function walk(d, level) {
    let entries;
    try {
      entries = await readdir2(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "__pycache__" || e.name === "node_modules") continue;
      const p = join2(d, e.name);
      if (e.isDirectory()) {
        if (level < depth) await walk(p, level + 1);
        else if (files.length < limit) files.push(`${relative(dir, p).split(sep).join("/")}/`);
        continue;
      }
      const rel = relative(dir, p).split(sep).join("/");
      if (rel === "SKILL.md") continue;
      if (files.length >= limit) {
        more = true;
        return;
      }
      files.push(rel);
    }
  }
  await walk(dir, 1);
  return { files, more };
}
var MAX_RESOURCE_BYTES = 256 * 1024;
async function readResource(skillDir, file) {
  if (!file.trim()) throw new Error("file \u4E0D\u80FD\u4E3A\u7A7A");
  if (isAbsolute(file)) throw new Error("file \u8981\u5199\u76F8\u5BF9\u6280\u80FD\u76EE\u5F55\u7684\u8DEF\u5F84\uFF0C\u4F8B\u5982 references/schemas.md");
  const base = await realpath(skillDir);
  let target;
  try {
    target = await realpath(resolve(base, file));
  } catch {
    throw new Error(`\u6280\u80FD\u76EE\u5F55\u91CC\u6CA1\u6709 ${file}`);
  }
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`${file} \u4E0D\u5728\u6280\u80FD\u76EE\u5F55\u91CC`);
  const st = await stat(target);
  if (st.isDirectory()) {
    const { files, more } = await listResources(target, 200, 1);
    return `${file} \u662F\u76EE\u5F55\uFF0C\u91CC\u9762\u6709\uFF1A
${files.join("\n")}${more ? "\n\u2026" : ""}`;
  }
  const buf = await readFile2(target);
  if (buf.subarray(0, 8e3).includes(0)) throw new Error(`${file} \u662F\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u4E0D\u80FD\u76F4\u63A5\u8BFB\uFF1B\u9700\u8981\u7684\u8BDD\u7528 bash \u6309\u7EDD\u5BF9\u8DEF\u5F84\u5904\u7406\uFF1A${target}`);
  const text = buf.subarray(0, MAX_RESOURCE_BYTES).toString("utf8");
  return buf.length > MAX_RESOURCE_BYTES ? `${text}

[\u6587\u4EF6\u8FC7\u957F\uFF0C\u53EA\u663E\u793A\u524D ${MAX_RESOURCE_BYTES} \u5B57\u8282\uFF1B\u5B8C\u6574\u5185\u5BB9\uFF1A${target}]` : text;
}

// src/config.ts
import { readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import { join as join3 } from "node:path";

// src/jsonc.ts
function stripJsonc(text) {
  let src = "";
  for (let i = 0, inStr = false; i < text.length; ) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      src += ch;
      if (ch === "\\") {
        src += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
    } else if (ch === '"') {
      inStr = true;
      src += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      src += ch;
      i++;
    }
  }
  let out = "";
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? "";
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}
function parseJsoncTree(text) {
  let i = 0;
  const skip = () => {
    for (; ; ) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text[i] === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? text.length : e + 2;
      } else return;
    }
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    skip();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const members = [];
      for (; ; ) {
        skip();
        if (text[i] === "}") {
          i++;
          return { type: "object", start, end: i, members };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') throw new Error(`skills.json: unexpected "${text[i] ?? "EOF"}" at ${i}`);
        const key = str();
        skip();
        if (text[i] !== ":") throw new Error(`skills.json: expected ":" at ${i}`);
        i++;
        members.push({ key, value: value() });
      }
    }
    if (ch === "[") {
      i++;
      for (; ; ) {
        skip();
        if (text[i] === "]") {
          i++;
          return { type: "value", start, end: i };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (i >= text.length) throw new Error("skills.json: unterminated array");
        value();
      }
    }
    if (ch === '"') {
      str();
      return { type: "value", start, end: i };
    }
    while (i < text.length && /[^\s,\]}/]/.test(text[i])) i++;
    if (i === start) throw new Error(`skills.json: unexpected "${ch ?? "EOF"}" at ${i}`);
    return { type: "value", start, end: i };
  };
  const root = value();
  if (root.type !== "object") throw new Error("provider.json must contain a JSON object");
  return root;
}
var lineIndent = (text, pos) => {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
};
var childIndent = (text, obj) => obj.members.length ? lineIndent(text, obj.members[0].value.start) : `${lineIndent(text, obj.start)}  `;
var format = (v, indent) => JSON.stringify(v, null, 2).replace(/\n/g, `
${indent}`);
var splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);
var findObject = (root, path) => {
  let cur = root;
  for (const k of path) {
    if (cur?.type !== "object") return void 0;
    cur = cur.members.find((m) => m.key === k)?.value;
  }
  return cur?.type === "object" ? cur : void 0;
};
function setJsonc(text, path, value) {
  const root = parseJsoncTree(text);
  const parent = findObject(root, path.slice(0, -1));
  if (!parent) throw new Error(`skills.json: "${path.slice(0, -1).join(".")}" is not an object`);
  const key = path.at(-1);
  const indent = childIndent(text, parent);
  const existing = parent.members.find((m) => m.key === key);
  if (existing) return splice(text, existing.value.start, existing.value.end, format(value, lineIndent(text, existing.value.start)));
  const member = `${JSON.stringify(key)}: ${format(value, indent)}`;
  if (!parent.members.length) {
    const inner = text.slice(parent.start + 1, parent.end - 1);
    if (!inner.includes("\n")) return splice(text, parent.start, parent.end, `{
${indent}${member}
${lineIndent(text, parent.start)}}`);
    return splice(text, parent.start + 1, parent.start + 1, `
${indent}${member}`);
  }
  const last = parent.members.at(-1);
  const after = last.value.end;
  let j = after;
  while (j < parent.end && /\s/.test(text[j])) j++;
  if (text[j] === ",") return splice(text, j + 1, j + 1, `
${indent}${member}`);
  return splice(text, after, after, `,
${indent}${member}`);
}

// src/config.ts
var CONFIG_FILE_NAME = "skills.json";
var DEFAULT_CONFIG = {
  enabled: true,
  builtin: true,
  disabled: [],
  paths: [],
  maxDescriptionChars: 500,
  remoteManage: false
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function normalizeConfig(raw) {
  const bad = (key, want) => new Error(`skills: ${key} \u5E94\u4E3A ${want}`);
  const d = DEFAULT_CONFIG;
  const bool = (key) => {
    const v = raw[key];
    if (v === void 0) return d[key];
    if (typeof v !== "boolean") throw bad(key, "true / false");
    return v;
  };
  const list = (key) => {
    let v = raw[key];
    if (v === void 0) return [...d[key]];
    if (typeof v === "string") v = v.trim() ? [v] : [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(key, "\u5B57\u7B26\u4E32\u6570\u7EC4");
    return [...new Set(v.map((x) => x.trim()).filter(Boolean))];
  };
  const max = raw.maxDescriptionChars ?? d.maxDescriptionChars;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 20) throw bad("maxDescriptionChars", "20 \u4EE5\u4E0A\u7684\u6574\u6570");
  return { enabled: bool("enabled"), builtin: bool("builtin"), disabled: list("disabled"), paths: list("paths"), maxDescriptionChars: max, remoteManage: bool("remoteManage") };
}
async function readConfigFile(dir) {
  let text;
  try {
    text = await readFile3(join3(dir, CONFIG_FILE_NAME), "utf8");
  } catch {
    return void 0;
  }
  const data = JSON.parse(stripJsonc(text));
  if (!isObj(data)) throw new Error(`skills: ${join3(dir, CONFIG_FILE_NAME)} \u5E94\u4E3A JSON \u5BF9\u8C61`);
  return data;
}
async function loadConfig(paths, options) {
  const merged = {};
  const append = (data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === "$schema" || v === void 0) continue;
      if ((k === "disabled" || k === "paths") && Array.isArray(merged[k]) && Array.isArray(v)) merged[k] = [...merged[k], ...v];
      else merged[k] = v;
    }
  };
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue;
      const data = await readConfigFile(dir);
      if (data) append(data);
    }
  }
  const { loadConfigFiles: _, ...rest } = options;
  append(rest);
  return normalizeConfig(merged);
}
async function writeDisabled(dir, disabled) {
  const file = join3(dir, CONFIG_FILE_NAME);
  let text;
  try {
    text = await readFile3(file, "utf8");
  } catch {
    text = "{\n}\n";
  }
  await writeFile2(file, setJsonc(text, ["disabled"], disabled));
  return file;
}
async function readDisabled(dir) {
  const data = await readConfigFile(dir).catch(() => void 0);
  const v = data?.disabled;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : [];
}

// src/install.ts
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir as readdir3, readFile as readFile4, rm as rm2, stat as stat2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join as join4, resolve as resolve2 } from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
function parseGitSource(src) {
  const s = src.trim();
  const tree = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?\/?$/.exec(s);
  if (tree) {
    const subdir = tree[4]?.replace(/\/SKILL\.md$/, "");
    return { url: `https://github.com/${tree[1]}/${tree[2]}.git`, ref: tree[3], ...subdir ? { subdir } : {} };
  }
  const gh = /^github:([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#(.+))?$/.exec(s);
  if (gh) return { url: `https://github.com/${gh[1]}/${gh[2]}.git`, ...gh[3] ? { ref: gh[3] } : {} };
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+?\/?$/.test(s)) return { url: `${s.replace(/\/$/, "").replace(/\.git$/, "")}.git` };
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) return { url: s };
  return void 0;
}
async function findSkills(root, depth = 4) {
  const skills = [];
  const errors = [];
  async function visit(dir, level) {
    const file = join4(dir, "SKILL.md");
    const st = await stat2(file).catch(() => void 0);
    if (st?.isFile()) {
      const { data, hasFrontmatter } = parseSkillFile(await readFile4(file, "utf8"));
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : basename(dir);
      const description = typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "";
      if (!hasFrontmatter || !description) errors.push(`${file}\uFF1A\u7F3A\u5C11 frontmatter \u7684 description`);
      else if (!isSkillName(name)) errors.push(`${file}\uFF1A\u6280\u80FD\u540D "${name}" \u4E0D\u5408\u6CD5`);
      else skills.push({ name, description, dir });
      return;
    }
    if (level >= depth) return;
    let entries;
    try {
      entries = await readdir3(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      await visit(join4(dir, e.name), level + 1);
    }
  }
  await visit(root, 0);
  return { skills, errors };
}
async function gitClone(src, dest) {
  const args = ["clone", "--depth", "1", ...src.ref ? ["--branch", src.ref] : [], src.url, dest];
  try {
    await run("git", args, { timeout: 12e4, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch (err) {
    const e = err;
    if (e.code === "ENOENT") throw new Error("\u6CA1\u6709\u627E\u5230 git \u547D\u4EE4\uFF1A\u8BF7\u5148\u5B89\u88C5 git\uFF0C\u6216\u8005\u4E0B\u8F7D\u540E\u7528\u672C\u5730\u8DEF\u5F84\u5B89\u88C5");
    throw new Error(`git clone \u5931\u8D25\uFF1A${(e.stderr || e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
}
async function installSkills(o) {
  const git = parseGitSource(o.source);
  let tmp;
  try {
    let root;
    if (git) {
      tmp = await mkdtemp(join4(tmpdir(), "leo-skill-"));
      await (o.clone ?? gitClone)(git, join4(tmp, "repo"));
      root = git.subdir ? join4(tmp, "repo", git.subdir) : join4(tmp, "repo");
      if (!(await stat2(root).catch(() => void 0))?.isDirectory()) throw new Error(`\u4ED3\u5E93\u91CC\u6CA1\u6709\u76EE\u5F55 ${git.subdir}`);
    } else {
      root = resolve2(o.cwd ?? process.cwd(), expandHome(o.source));
      const st = await stat2(root).catch(() => void 0);
      if (!st) throw new Error(`\u627E\u4E0D\u5230 ${o.source}`);
      if (st.isFile() && basename(root) === "SKILL.md") root = resolve2(root, "..");
      else if (!st.isDirectory()) throw new Error(`${o.source} \u4E0D\u662F\u76EE\u5F55`);
    }
    const { skills: found, errors } = await findSkills(root);
    if (!found.length) throw new Error(`${o.source} \u91CC\u6CA1\u6709\u627E\u5230\u6280\u80FD\uFF08\u9700\u8981\u5E26 frontmatter \u7684 SKILL.md\uFF09${errors.length ? `\uFF1A${errors.join("\uFF1B")}` : ""}`);
    let picked = found;
    if (o.names?.length) {
      picked = found.filter((s) => o.names.includes(s.name) || o.names.includes(basename(s.dir)));
      const missing = o.names.filter((n) => !picked.some((s) => s.name === n || basename(s.dir) === n));
      if (missing.length) throw new Error(`${o.source} \u91CC\u6CA1\u6709\u6280\u80FD ${missing.join(", ")}\uFF1B\u6709\uFF1A${found.map((s) => s.name).join(", ")}`);
    } else if (found.length > 1 && !o.all) {
      return { installed: [], choices: found, skipped: [] };
    }
    const installed = [];
    const skipped = [];
    for (const s of picked) {
      const dest = join4(o.targetDir, s.name);
      if (await stat2(dest).catch(() => void 0)) {
        if (!o.force) {
          skipped.push(s.name);
          continue;
        }
        await rm2(dest, { recursive: true, force: true });
      }
      await cp(s.dir, dest, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules|__pycache__)$/.test(p) });
      installed.push({ ...s, dir: dest });
    }
    return { installed, skipped };
  } finally {
    if (tmp) await rm2(tmp, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function removeSkillDir(dir) {
  await rm2(dir, { recursive: true, force: true });
}

// src/index.ts
var PLUGIN_NAME = "leo-plugin-skills";
var SKILLS_DIR_NAME = "skills";
var escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var clip = (s, max) => s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
function catalogSection(skills, maxDescriptionChars = 500) {
  const visible = skills.filter((s) => s.modelInvocable && !s.disabled);
  if (!visible.length) return void 0;
  return [
    "## Skills",
    "Skills are task-specific instruction packages. When the user's task matches a skill's description below, call the `skill` tool with its name to load the full instructions BEFORE starting the task, then follow them. Do not load skills that are not relevant.",
    "A loaded skill may reference bundled files (references, scripts, assets). Read them only when needed with `skill` (name + file, path relative to the skill directory); run its scripts with bash using the absolute skill directory the tool returns.",
    "",
    "<available_skills>",
    ...visible.map((s) => `<skill><name>${s.name}</name><description>${escapeXml(clip(s.description, maxDescriptionChars))}</description></skill>`),
    "</available_skills>"
  ].join("\n");
}
async function renderSkill(s) {
  const { body } = parseSkillFile(await readFile5(s.file, "utf8"));
  const { files, more } = await listResources(s.dir);
  return [
    `<skill_content name="${s.name}" source="${s.source}">`,
    `Skill directory: ${s.dir}`,
    "Relative paths in the instructions are relative to this directory.",
    ...files.length ? ["<skill_resources>", ...files, ...more ? ["\u2026"] : [], "</skill_resources>"] : [],
    "<skill_instructions>",
    body.trim(),
    "</skill_instructions>",
    "</skill_content>"
  ].join("\n");
}
function listText(snap, svc) {
  const lines = [];
  if (!snap.skills.length) lines.push("\u8FD8\u6CA1\u6709\u6280\u80FD\u3002");
  for (const s of snap.skills) {
    const flags = [SOURCE_LABEL[s.source], s.disabled ? "\u5DF2\u7981\u7528" : "", !s.modelInvocable ? "\u4EC5\u624B\u52A8" : "", !s.userInvocable ? "\u4EC5\u6A21\u578B" : ""].filter(Boolean).join(" \xB7 ");
    lines.push(`  ${s.name}\uFF08${flags}\uFF09\u2014 ${clip(s.description, 80)}`);
  }
  for (const s of snap.shadowed) lines.push(`  ${s.name}\uFF08${SOURCE_LABEL[s.source]}\uFF09\u88AB${SOURCE_LABEL[s.shadowedBy]}\u7684\u540C\u540D\u6280\u80FD\u8986\u76D6`);
  for (const d of snap.diagnostics) lines.push(`  \u26A0 ${d.file}\uFF1A${d.message}`);
  lines.push(`\u5916\u90E8\u6280\u80FD\u76EE\u5F55\uFF1A${svc.dirs.user}${svc.dirs.project ? `\u3001${svc.dirs.project}` : ""}`);
  lines.push("\u5B89\u88C5\uFF1A/skills add <git \u5730\u5740|\u672C\u5730\u8DEF\u5F84> [\u6280\u80FD\u540D\u2026] [--project] [--all]\uFF1B\u624B\u52A8\u89E6\u53D1\uFF1A/skill <\u540D\u5B57> [\u4EFB\u52A1]");
  return lines.join("\n");
}
var MANAGE = /* @__PURE__ */ new Set(["add", "install", "remove", "rm", "uninstall", "enable", "disable"]);
function createSkillsPlugin(opts = {}) {
  return {
    name: PLUGIN_NAME,
    inject: ["tools", "context"],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx, raw = {}) {
      const leoPaths = ctx.maybe("leoPaths");
      const paths = leoPaths ?? { cwd: process.cwd(), userDir: join5(homedir2(), ".leo") };
      const config = await loadConfig(leoPaths, raw ?? {});
      const userDir = join5(paths.userDir, SKILLS_DIR_NAME);
      const projectDir = paths.projectDir ? join5(paths.projectDir, SKILLS_DIR_NAME) : void 0;
      const builtinDir = join5(userDir, BUILTIN_DIR_NAME);
      const log = { warn: (m) => ctx.logger?.warn?.(m) };
      await mkdir2(userDir, { recursive: true }).catch((e) => log.warn(`skills: \u521B\u5EFA ${userDir} \u5931\u8D25\uFF1A${e.message}`));
      if (projectDir) await mkdir2(projectDir, { recursive: true }).catch((e) => log.warn(`skills: \u521B\u5EFA ${projectDir} \u5931\u8D25\uFF1A${e.message}`));
      if (config.builtin) {
        const job = opts.builtin ? materializeBuiltin(builtinDir, opts.builtin, `test-${Object.keys(opts.builtin).join(",")}`) : materializeBuiltin(builtinDir);
        await job.catch(
          (e) => log.warn(`skills: \u91CA\u653E\u5185\u7F6E\u6280\u80FD\u5931\u8D25\uFF1A${e.message}`)
        );
      }
      const base = paths.projectRoot ?? paths.cwd ?? process.cwd();
      const roots = () => [
        ...projectDir ? [{ source: "project", dir: projectDir }] : [],
        ...config.paths.map((p) => ({ source: "custom", dir: resolve3(base, expandHome(p)) })),
        { source: "user", dir: userDir },
        ...config.builtin ? [{ source: "builtin", dir: builtinDir }] : []
      ];
      const catalog = new SkillCatalog(roots);
      const svc = {
        config,
        paths,
        dirs: { user: userDir, ...projectDir ? { project: projectDir } : {}, builtin: builtinDir },
        snapshot: () => catalog.snapshot(config.disabled),
        find: async (name) => (await catalog.snapshot(config.disabled)).skills.find((s) => s.name === name)
      };
      ctx.provide("skills", svc);
      if (!config.enabled) return;
      const context = ctx.get("context");
      await ctx.effect(
        () => context.registerSection({
          id: "skills.catalog",
          layer: "agent",
          priority: 60,
          render: async () => catalogSection((await svc.snapshot()).skills, config.maxDescriptionChars)
        })
      );
      const tools = ctx.get("tools");
      await ctx.effect(() => tools.register(skillTool(svc)));
      const commands = ctx.maybe("commands");
      if (!commands) return;
      await ctx.effect(
        () => commands.register({
          name: "skill",
          usage: "<\u540D\u5B57> [\u4EFB\u52A1]",
          description: "\u624B\u52A8\u89E6\u53D1\u4E00\u4E2A\u6280\u80FD\uFF1A\u628A\u5B83\u7684\u5B8C\u6574\u8BF4\u660E\u4EA4\u7ED9 Agent\uFF0C\u518D\u63A5\u7740\u505A\u4F60\u5199\u7684\u4EFB\u52A1",
          plugin: "skills",
          run: async ({ argv, args }) => {
            const name = argv[0];
            if (!name) return { text: listText(await svc.snapshot(), svc) };
            const s = await svc.find(name);
            if (!s) return { text: `\u6CA1\u6709\u6280\u80FD ${name}\u3002\u7528 /skills \u770B\u770B\u6709\u54EA\u4E9B`, isError: true };
            if (s.disabled) return { text: `\u6280\u80FD ${name} \u5DF2\u7981\u7528\uFF1A/skills enable ${name}`, isError: true };
            if (!s.userInvocable) return { text: `\u6280\u80FD ${name} \u53EA\u5141\u8BB8\u6A21\u578B\u81EA\u5DF1\u52A0\u8F7D\uFF08user-invocable: false\uFF09`, isError: true };
            const task = args.slice(name.length).trim();
            const block = await renderSkill(s);
            return {
              text: `\u5DF2\u52A0\u8F7D\u6280\u80FD ${name}`,
              prompt: `${block}

${task ? `The user explicitly invoked the skill "${name}". Follow it for this task:
${task}` : `The user explicitly invoked the skill "${name}". Follow it; ask the user what they want to do with it if the task is unclear.`}`
            };
          }
        })
      );
      await ctx.effect(
        () => commands.register({
          name: "skills",
          usage: "[add <\u6765\u6E90> [\u6280\u80FD\u540D\u2026] [--project] [--all] [--force] | remove <\u540D\u5B57> [--project] | enable|disable <\u540D\u5B57> [--project] | info <\u540D\u5B57>]",
          description: "\u6280\u80FD\uFF1A\u5217\u8868\u3001\u5B89\u88C5\u3001\u5220\u9664\u3001\u542F\u7528 / \u7981\u7528",
          plugin: "skills",
          run: async (c) => {
            try {
              return await manage(c);
            } catch (err) {
              return { text: err.message, isError: true };
            }
          }
        })
      );
      async function manage({ argv, surface }) {
        const flags = new Set(argv.filter((a) => a.startsWith("--")));
        const [sub, ...rest] = argv.filter((a) => !a.startsWith("--"));
        if (!sub || sub === "list" || sub === "ls") return { text: listText(await svc.snapshot(), svc) };
        if (MANAGE.has(sub) && surface && surface !== "cli" && !config.remoteManage) {
          return { text: '\u4E3A\u4E86\u5B89\u5168\uFF0C\u804A\u5929\u6E20\u9053\u91CC\u4E0D\u80FD\u5B89\u88C5\u3001\u5220\u9664\u6216\u542F\u505C\u6280\u80FD\u3002\u8BF7\u5728\u7EC8\u7AEF\u91CC\u64CD\u4F5C\uFF0C\u6216\u5728 skills.json \u91CC\u8BBE "remoteManage": true', isError: true };
        }
        const useProject = flags.has("--project");
        if (useProject && !projectDir) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u5728\u9879\u76EE\u91CC\uFF08\u6CA1\u6709 .leo \u76EE\u5F55\uFF09\uFF1A\u5148 leo init\uFF0C\u6216\u53BB\u6389 --project");
        const target = useProject ? projectDir : userDir;
        const scopeDir = useProject ? paths.projectDir : paths.userDir;
        if (sub === "info") {
          const name2 = rest[0];
          if (!name2) throw new Error("\u7528\u6CD5\uFF1A/skills info <\u540D\u5B57>");
          const s = await svc.find(name2);
          if (!s) throw new Error(`\u6CA1\u6709\u6280\u80FD ${name2}`);
          const { files } = await listResources(s.dir, 30);
          return {
            text: [`${s.name}\uFF08${SOURCE_LABEL[s.source]}${s.disabled ? " \xB7 \u5DF2\u7981\u7528" : ""}\uFF09`, s.description, `\u76EE\u5F55\uFF1A${s.dir}`, ...s.license ? [`\u8BB8\u53EF\uFF1A${s.license}`] : [], ...files.length ? [`\u6587\u4EF6\uFF1A${files.join("\u3001")}`] : []].join("\n")
          };
        }
        if (sub === "add" || sub === "install") {
          const source = rest[0];
          if (!source) throw new Error("\u7528\u6CD5\uFF1A/skills add <git \u5730\u5740|\u672C\u5730\u8DEF\u5F84> [\u6280\u80FD\u540D\u2026] [--project] [--all] [--force]");
          const r = await installSkills({
            source,
            targetDir: target,
            names: rest.slice(1),
            all: flags.has("--all"),
            force: flags.has("--force"),
            cwd: paths.cwd ?? process.cwd(),
            ...opts.clone ? { clone: opts.clone } : {}
          });
          if (r.choices) {
            return { text: [`${source} \u91CC\u6709 ${r.choices.length} \u4E2A\u6280\u80FD\uFF0C\u6307\u5B9A\u8981\u88C5\u54EA\u4E2A\uFF08\u6216\u52A0 --all\uFF09\uFF1A`, ...r.choices.map((s) => `  ${s.name} \u2014 ${clip(s.description, 80)}`)].join("\n") };
          }
          const lines = r.installed.map((s) => `\u5DF2\u5B89\u88C5 ${s.name} \u2192 ${s.dir}`);
          if (r.skipped.length) lines.push(`\u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7\uFF1A${r.skipped.join(", ")}\uFF08--force \u8986\u76D6\uFF09`);
          return { text: lines.join("\n") || "\u6CA1\u6709\u5B89\u88C5\u4EFB\u4F55\u6280\u80FD", isError: !r.installed.length };
        }
        const name = rest[0];
        if (!name) throw new Error(`\u7528\u6CD5\uFF1A/skills ${sub} <\u540D\u5B57>${sub === "remove" || sub === "rm" ? " [--project]" : ""}`);
        if (sub === "remove" || sub === "rm" || sub === "uninstall") {
          const snap = await svc.snapshot();
          const all = [...snap.skills, ...snap.shadowed].filter((s) => s.name === name);
          const want = useProject ? "project" : flags.has("--user") ? "user" : void 0;
          const removable = all.filter((s) => want ? s.source === want : s.source === "project" || s.source === "user");
          const hit = removable[0];
          if (!hit) {
            if (all.some((s) => s.source === "builtin")) throw new Error(`${name} \u662F\u5185\u7F6E\u6280\u80FD\uFF0C\u4E0D\u80FD\u5220\u9664\uFF1B\u4E0D\u60F3\u7528\u53EF\u4EE5 /skills disable ${name}`);
            if (all.some((s) => s.source === "custom")) throw new Error(`${name} \u5728 skills.json \u7684 paths \u76EE\u5F55\u91CC\uFF0C\u8BF7\u5230\u90A3\u4E2A\u76EE\u5F55\u624B\u52A8\u5220\u9664`);
            throw new Error(`\u6CA1\u6709\u53EF\u5220\u9664\u7684\u6280\u80FD ${name}`);
          }
          await removeSkillDir(hit.dir);
          const left = (await svc.find(name))?.source;
          return { text: `\u5DF2\u5220\u9664 ${name}\uFF08${SOURCE_LABEL[hit.source]}\uFF09\uFF1A${hit.dir}${left ? `\uFF1B\u73B0\u5728\u751F\u6548\u7684\u662F${SOURCE_LABEL[left]}\u7684\u540C\u540D\u6280\u80FD` : ""}` };
        }
        if (sub === "enable" || sub === "disable") {
          const own = await readDisabled(scopeDir);
          const next = sub === "disable" ? [.../* @__PURE__ */ new Set([...own, name])] : own.filter((n) => n !== name);
          const file = await writeDisabled(scopeDir, next);
          if (sub === "disable") {
            if (!config.disabled.includes(name)) config.disabled.push(name);
          } else {
            config.disabled.splice(0, config.disabled.length, ...config.disabled.filter((n) => n !== name));
          }
          const still = sub === "enable" && config.disabled.includes(name);
          const exists = await svc.find(name);
          return {
            text: `${sub === "disable" ? "\u5DF2\u7981\u7528" : "\u5DF2\u542F\u7528"} ${name}\uFF08\u5199\u5165 ${file}\uFF09${exists ? "" : "\uFF1B\u6CE8\u610F\uFF1A\u73B0\u5728\u8FD8\u6CA1\u6709\u8FD9\u4E2A\u6280\u80FD"}${still ? "\uFF1B\u53E6\u4E00\u7EA7 skills.json \u91CC\u8FD8\u7981\u7528\u7740\u5B83" : ""}`
          };
        }
        throw new Error(`\u4E0D\u8BA4\u8BC6\u7684\u5B50\u547D\u4EE4 ${sub}\u3002\u7528\u6CD5\uFF1A/skills [add|remove|enable|disable|info]`);
      }
    }
  };
}
function skillTool(svc) {
  return {
    name: "skill",
    title: "\u52A0\u8F7D\u6280\u80FD",
    description: "Load a skill from <available_skills>: returns its full instructions and the absolute skill directory. Call it as soon as the task matches a skill description, before doing the task. Pass `file` to read one bundled file the skill mentions (path relative to the skill directory).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name, exactly as listed in <available_skills>" },
        file: { type: "string", description: "Optional: a file inside the skill directory to read, e.g. references/schemas.md" }
      },
      required: ["name"],
      additionalProperties: false
    },
    execute: async (args) => {
      const name = String(args.name ?? "").trim();
      const s = await svc.find(name);
      if (!s || s.disabled) {
        const names = (await svc.snapshot()).skills.filter((x) => x.modelInvocable && !x.disabled).map((x) => x.name);
        throw new Error(`\u6CA1\u6709\u53EF\u7528\u7684\u6280\u80FD "${name}"${names.length ? `\uFF1B\u53EF\u7528\u7684\u6709\uFF1A${names.join(", ")}` : ""}`);
      }
      if (!s.modelInvocable) throw new Error(`\u6280\u80FD ${name} \u53EA\u80FD\u7531\u7528\u6237\u7528 /skill \u624B\u52A8\u89E6\u53D1`);
      if (typeof args.file === "string" && args.file.trim()) {
        const text = await readResource(s.dir, args.file.trim());
        return `<skill_file skill="${s.name}" path="${args.file.trim()}">
${text}
</skill_file>`;
      }
      return renderSkill(s);
    }
  };
}
var plugin = createSkillsPlugin();
var index_default = plugin;
export {
  BUILTIN_DIGEST,
  BUILTIN_SKILLS,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  SKILLS_DIR_NAME,
  SKILL_NAME_RE,
  SOURCE_LABEL,
  SkillCatalog,
  catalogSection,
  createSkillsPlugin,
  index_default as default,
  expandHome,
  findSkills,
  installSkills,
  isSkillName,
  listResources,
  listText,
  loadConfig,
  materializeBuiltin,
  normalizeConfig,
  parseGitSource,
  parseSkillFile,
  parseYamlSubset,
  readResource,
  renderSkill,
  splitFrontmatter
};
