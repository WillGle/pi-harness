# Content Patterns

Effective patterns for SKILL.md body content.

## Basic Structure

```markdown
---
# Frontmatter
---

# [Skill Name]

[1-2 sentence purpose statement]

## Quick Start
[Simplest example - users can start immediately]

## Core Workflows
[Main workflows of the skill]

## Advanced Features
[Links to reference files for complex features]

## Resources
[List of available scripts, references, assets]
```

## Pattern 1: High-level Guide with References

Keep SKILL.md lean, link to detailed content.

```markdown
# PDF Processing

## Quick start

Extract text with pdfplumber:

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

## Advanced features

- **Form filling**: See [references/forms.md](references/forms.md)
- **Table extraction**: See [references/tables.md](references/tables.md)
- **Merging documents**: See [references/merge.md](references/merge.md)
```

Claude only loads forms.md, tables.md, or merge.md when needed.

## Pattern 2: Domain-specific Organization

Organize by domain to avoid loading irrelevant context.

```
bigquery-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md (revenue, billing)
    ├── sales.md (pipeline, opportunities)
    ├── product.md (usage, features)
    └── marketing.md (campaigns)
```

SKILL.md:

```markdown
# BigQuery Analysis

## Available datasets

- **Finance**: Revenue, ARR, billing → [references/finance.md](references/finance.md)
- **Sales**: Pipeline, accounts → [references/sales.md](references/sales.md)
- **Product**: API usage, features → [references/product.md](references/product.md)
- **Marketing**: Campaigns → [references/marketing.md](references/marketing.md)

## Quick search

```bash
grep -i "revenue" references/finance.md
grep -i "pipeline" references/sales.md
```
```

When user asks about sales, Claude only reads sales.md.

## Pattern 3: Conditional Details

Show basic content, link to advanced.

```markdown
# DOCX Processing

## Creating documents

Use docx-js for new documents. Basic example:

```python
from docx import Document
doc = Document()
doc.add_heading('Title', 0)
doc.save('output.docx')
```

## Editing documents

For simple edits, modify content directly.

**For tracked changes**: See [references/redlining.md](references/redlining.md)
**For OOXML details**: See [references/ooxml.md](references/ooxml.md)
```

## Pattern 4: Script-based Workflow

When skill relies heavily on scripts.

```markdown
# Form Processor

## Workflow

1. **Analyze form**: `python scripts/analyze_form.py input.pdf`
   - Output: `fields.json` with form fields list

2. **Create mapping**: Edit `fields.json` to add values

3. **Validate**: `python scripts/validate.py fields.json`
   - Fix errors if any

4. **Fill form**: `python scripts/fill_form.py input.pdf fields.json output.pdf`

## Scripts reference

| Script | Purpose | Input | Output |
|--------|---------|-------|--------|
| analyze_form.py | Extract fields | PDF | fields.json |
| validate.py | Validate mapping | fields.json | Pass/errors |
| fill_form.py | Fill form | PDF + JSON | PDF |
| verify.py | Verify output | PDF | Pass/errors |
```

## Template Pattern

Provide templates for output format.

### Strict Template (for API responses, data formats)

```markdown
## Report Structure

ALWAYS use this exact template:

```markdown
# [Title]

## Executive Summary
[One paragraph overview]

## Key Findings
- Finding 1 with data
- Finding 2 with data
- Finding 3 with data

## Recommendations
1. Actionable recommendation
2. Actionable recommendation
```
```

### Flexible Template (when adaptation is useful)

```markdown
## Report Structure

Sensible default format, adjust as needed:

```markdown
# [Title]

## Summary
[Overview - adapt length to content]

## Findings
[Organize based on what you discover]

## Next Steps
[Tailor to context]
```
```

## Examples Pattern

Input/output pairs for output quality.

```markdown
## Commit Message Format

**Example 1:**
Input: Added user authentication with JWT
Output:
```
feat(auth): implement JWT authentication

Add login endpoint and token validation
```

**Example 2:**
Input: Fixed date display bug in reports
Output:
```
fix(reports): correct date formatting

Use UTC timestamps consistently
```

Style: type(scope): brief description, then details.
```

## Writing Guidelines

### DO:
- Use imperative language: "Analyze code...", "Run script..."
- Provide concrete examples
- Keep sections focused
- Use tables for structured data
- Link to detailed content

### DON'T:
- Use second person: "You should...", "You can..."
- Explain things Claude already knows
- Embed large code blocks (put in references)
- Create deeply nested references
- Include time-sensitive information

### Concise vs Verbose

**❌ Verbose (150 tokens):**
```markdown
PDF (Portable Document Format) files are a common file format
that contains text, images, and other content. To extract text
from a PDF, you'll need to use a library. There are many libraries
available for PDF processing, but we recommend pdfplumber because
it's easy to use...
```

**✅ Concise (50 tokens):**
```markdown
## Extract PDF text

Use pdfplumber:

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
```

Claude already knows what PDFs are and how libraries work.
