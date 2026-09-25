# Workflow Patterns

Patterns for complex workflows in Skills.

## Sequential Workflow

For tasks that must be executed in order.

```markdown
## PDF Form Filling Workflow

Copy checklist and track progress:

```
Progress:
- [ ] Step 1: Analyze form
- [ ] Step 2: Create mapping
- [ ] Step 3: Validate
- [ ] Step 4: Fill form
- [ ] Step 5: Verify output
```

### Step 1: Analyze form
Run: `python scripts/analyze_form.py input.pdf`
Output: `fields.json` with form fields

### Step 2: Create mapping
Edit `fields.json` to add values for each field.

### Step 3: Validate
Run: `python scripts/validate.py fields.json`
Fix errors before continuing.

### Step 4: Fill form
Run: `python scripts/fill_form.py input.pdf fields.json output.pdf`

### Step 5: Verify
Run: `python scripts/verify.py output.pdf`
If fail → return to Step 2.
```

## Conditional Workflow

For tasks with branching logic.

```markdown
## Document Modification

### Determine approach

**Creating new document?**
→ Follow "Creation Workflow" below

**Editing existing document?**
→ Follow "Edit Workflow" below

---

### Creation Workflow
1. Use docx-js library
2. Build document from scratch
3. Export to .docx

### Edit Workflow
1. Unpack existing document
2. Modify XML directly
3. Validate after each change
4. Repack when complete
```

## Feedback Loop Pattern

Validate → Fix → Repeat

```markdown
## Content Review Process

1. Draft content following [STYLE_GUIDE.md](references/style-guide.md)

2. **Review checklist:**
   - [ ] Terminology consistent
   - [ ] Examples follow standard format
   - [ ] All required sections present

3. **If issues found:**
   - Note each issue with specific reference
   - Revise content
   - Review checklist again

4. **Only proceed when all checks pass**

5. Finalize document
```

## Wizard-Style Multi-Step

For complex processes requiring user input.

```markdown
## Project Setup Wizard

### Step 1: Initial Setup

1. Ask user for project type
2. Validate prerequisites
3. Create base configuration

**Wait for user confirmation before proceeding.**

### Step 2: Configuration

1. Present configuration options
2. User chooses settings
3. Generate config file

**Wait for user confirmation before proceeding.**

### Step 3: Initialization

1. Run initialization scripts
2. Verify setup successful
3. Report results
```

## Iterative Refinement

Multiple passes with increasing depth.

```markdown
## Code Analysis

### Pass 1: Broad Scan
1. Search entire codebase for patterns
2. Identify high-level issues
3. Categorize findings

### Pass 2: Deep Analysis
For each high-level issue:
1. Read full file context
2. Analyze root cause
3. Determine severity

### Pass 3: Recommendations
For each finding:
1. Research best practices
2. Generate specific fix
3. Estimate effort

### Final Report
Present all findings with recommendations.
```

## Context Aggregation

Combine information from multiple sources.

```markdown
## Project Summary

### Gather Context

1. **Read overview**: `README.md`
2. **Analyze dependencies**: `package.json`
3. **Search patterns**: `grep -r "TODO" src/`
4. **Check history**: `git log --oneline -20`

### Synthesize

Combine findings into coherent summary:
- Project purpose and architecture
- Key dependencies and versions
- Outstanding issues
- Recent changes
```

## Script Automation Pattern

Offload computation to scripts.

```markdown
## Data Analysis

### Run analyzer

```bash
python scripts/analyzer.py --path "$TARGET_DIR" --output report.json
```

### Process results

1. Read `report.json`
2. Parse findings
3. Present summary to user

### Scripts available

| Script | Purpose |
|--------|---------|
| analyzer.py | Analyze directory structure |
| summarizer.py | Generate summary |
| visualizer.py | Create charts |
```

## Template-Based Generation

Generate from templates in assets/.

```markdown
## Report Generation

### Process

1. Read template: `{baseDir}/assets/report-template.html`

2. Parse user requirements

3. Fill placeholders:
   - `{{TITLE}}` → user-provided title
   - `{{SUMMARY}}` → generated summary
   - `{{DATE}}` → current date
   - `{{CONTENT}}` → generated content

4. Write to output file

5. Report completion
```

## Error Handling Pattern

Graceful error handling in workflows.

```markdown
## Data Processing

### Main workflow

1. **Validate input**
   ```bash
   python scripts/validate_input.py data.csv
   ```
   If fails → Report error and stop

2. **Process data**
   ```bash
   python scripts/process.py data.csv --output result.json
   ```
   If fails → Check error log, attempt recovery

3. **Generate output**
   ```bash
   python scripts/generate.py result.json
   ```
   If fails → Fallback to basic output

### Error recovery

| Error Type | Recovery Action |
|------------|-----------------|
| Invalid input | Request corrected input |
| Processing error | Retry with defaults |
| Output error | Generate basic output |
```

## Parallel Tasks Pattern

For tasks that can run independently.

```markdown
## Multi-Service Deployment

### Independent tasks (can run in parallel)

**Task A: Build frontend**
```bash
cd frontend && npm run build
```

**Task B: Build backend**
```bash
cd backend && npm run build
```

**Task C: Run tests**
```bash
npm test
```

### Sequential tasks (after parallel complete)

1. Verify all builds successful
2. Deploy to staging
3. Run integration tests
4. Deploy to production
```

## Best Practices

### DO:
- Include progress checklists for long workflows
- Add validation steps after each critical operation
- Provide clear decision points in conditional workflows
- Include error recovery instructions

### DON'T:
- Create workflows too long (>10 steps) without breaking down
- Skip validation steps
- Assume success without verification
- Mix multiple workflows in one section
