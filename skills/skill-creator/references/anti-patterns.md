# Anti-patterns to Avoid

Patterns that reduce skill quality and effectiveness.

## Structure Anti-patterns

### ❌ SKILL.md Too Long

**Problem:** SKILL.md > 500 lines consumes too much context.

```markdown
# Bad: 1500+ lines in SKILL.md
[All documentation crammed into one file]
```

**Solution:** Split content into reference files.

```markdown
# Good: ~300 lines in SKILL.md
## Quick Start
[Essential info]

## Advanced
See [references/advanced.md](references/advanced.md)
```

### ❌ Deeply Nested References

**Problem:** File A → File B → File C. Claude may not read everything.

```markdown
# SKILL.md
See [advanced.md](advanced.md)...

# advanced.md
See [details.md](details.md)...

# details.md
Here's the actual information...
```

**Solution:** Keep references 1 level deep.

```markdown
# SKILL.md
- **Advanced**: [references/advanced.md](references/advanced.md)
- **Details**: [references/details.md](references/details.md)
- **Examples**: [references/examples.md](references/examples.md)
```

### ❌ Unnecessary Files

**Problem:** README.md, CHANGELOG.md, INSTALLATION.md in skill.

Skills are for AI agents, not humans. These files only create clutter.

**Solution:** Only include files Claude actually needs:
- SKILL.md (required)
- scripts/ (executable code)
- references/ (documentation for Claude)
- assets/ (templates, images for output)

## Frontmatter Anti-patterns

### ❌ Vague Description

**Problem:**

```yaml
description: Helps with documents
```

Claude doesn't know when to trigger this skill.

**Solution:**

```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files, forms, or document extraction.
```

### ❌ Wrong Person

**Problem:**

```yaml
description: I can help you process Excel files
description: You can use this to analyze data
```

**Solution:** Third person.

```yaml
description: Processes Excel files and generates analysis reports
```

### ❌ Missing "When to Use"

**Problem:**

```yaml
description: Comprehensive PDF manipulation toolkit
```

**Solution:** Include triggers.

```yaml
description: Comprehensive PDF manipulation toolkit for extracting text, filling forms, and merging documents. Use when working with PDF files or .pdf extensions.
```

## Content Anti-patterns

### ❌ Explaining Known Concepts

**Problem:**

```markdown
PDF (Portable Document Format) files are a common file format
that contains text, images, and other content. To extract text
from a PDF, you'll need to use a library...
```

Claude already knows what PDFs are.

**Solution:** Get to the point.

```markdown
Use pdfplumber for text extraction:
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
```

### ❌ Second Person Instructions

**Problem:**

```markdown
You should analyze the code first.
You can use the script to process files.
You need to validate before continuing.
```

**Solution:** Imperative form.

```markdown
Analyze the code first.
Use the script to process files.
Validate before continuing.
```

### ❌ Time-sensitive Information

**Problem:**

```markdown
If you're doing this before August 2025, use the old API.
After August 2025, use the new API.
```

**Solution:** Use "old patterns" section.

```markdown
## Current Method
Use the v2 API endpoint: `api.example.com/v2/`

## Legacy Patterns
<details>
<summary>v1 API (deprecated)</summary>
The v1 API used: `api.example.com/v1/`
</details>
```

### ❌ Inconsistent Terminology

**Problem:**

```markdown
Use the API endpoint to fetch data.
Call the URL to retrieve information.
Access the route to get records.
```

**Solution:** Pick one term and stick to it.

```markdown
Use the API endpoint to fetch data.
Use the API endpoint to retrieve user information.
Use the API endpoint to get records.
```

### ❌ Too Many Options

**Problem:**

```markdown
You can use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or...
```

**Solution:** Provide default with escape hatch.

```markdown
Use pdfplumber for text extraction.

For scanned PDFs requiring OCR, use pdf2image with pytesseract instead.
```

## Path Anti-patterns

### ❌ Hardcoded Paths

**Problem:**

```markdown
Read /home/user/project/config.json
Run /Users/john/scripts/process.py
```

**Solution:** Use {baseDir}.

```markdown
Read {baseDir}/config.json
Run {baseDir}/scripts/process.py
```

### ❌ Windows-style Paths

**Problem:**

```markdown
scripts\helper.py
reference\guide.md
```

**Solution:** Forward slashes.

```markdown
scripts/helper.py
reference/guide.md
```

## Script Anti-patterns

### ❌ Scripts Without Error Handling

**Problem:**

```python
def process_file(path):
    return open(path).read()  # Fails silently
```

**Solution:** Handle errors explicitly.

```python
def process_file(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"File {path} not found, creating default")
        with open(path, 'w') as f:
            f.write('')
        return ''
```

### ❌ Magic Numbers

**Problem:**

```python
TIMEOUT = 47  # Why 47?
RETRIES = 5   # Why 5?
```

**Solution:** Document rationale.

```python
# HTTP requests typically complete within 30 seconds
# Longer timeout for slow connections
REQUEST_TIMEOUT = 30

# Three retries balances reliability vs speed
MAX_RETRIES = 3
```

### ❌ Assuming Tools Installed

**Problem:**

```markdown
Use the pdf library to process the file.
```

**Solution:** Include installation.

```markdown
Install required package: `pip install pypdf`

Then use:
```python
from pypdf import PdfReader
```
```

## Workflow Anti-patterns

### ❌ No Validation Steps

**Problem:**

```markdown
1. Make changes
2. Deploy
```

**Solution:** Add validation.

```markdown
1. Make changes
2. Run validation: `python validate.py`
3. If errors → fix and repeat step 2
4. Deploy
```

### ❌ No Error Recovery

**Problem:**

```markdown
Run the migration script.
[No guidance if it fails]
```

**Solution:** Include recovery.

```markdown
Run: `python migrate.py`

If fails:
- Check error log: `logs/migration.log`
- Run rollback: `python rollback.py`
- Fix issues
- Retry migration
```

### ❌ Workflows Too Long Without Breaks

**Problem:** 20 steps in one section.

**Solution:** Break into phases.

```markdown
## Phase 1: Preparation
Steps 1-5...

## Phase 2: Execution
Steps 6-10...

## Phase 3: Verification
Steps 11-15...
```

## Testing Anti-patterns

### ❌ No Real-world Testing

**Problem:** Ship skill without testing with actual use cases.

**Solution:** Test with Claude B (fresh instance) on real tasks.

### ❌ Testing Only Happy Path

**Problem:** Only test when everything works perfectly.

**Solution:** Test edge cases, errors, and unexpected inputs.
