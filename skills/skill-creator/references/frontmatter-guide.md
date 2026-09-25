# Frontmatter Guide

Detailed guide for YAML frontmatter in SKILL.md.

## Required Fields

### name

```yaml
name: your-skill-name
```

**Rules:**
- Maximum 64 characters
- Only lowercase letters, numbers, and hyphens
- No XML tags
- No reserved words: "anthropic", "claude"

**Naming conventions (recommended):**

Use gerund form (verb + -ing):
- ✅ `processing-pdfs`
- ✅ `analyzing-spreadsheets`
- ✅ `managing-databases`

Acceptable alternatives:
- Noun phrases: `pdf-processing`, `spreadsheet-analysis`
- Action-oriented: `process-pdfs`, `analyze-spreadsheets`

**Avoid:**
- ❌ Vague names: `helper`, `utils`, `tools`
- ❌ Overly generic: `documents`, `data`, `files`

### description

```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Rules:**
- Non-empty
- Maximum 1024 characters
- No XML tags

**Structure:** `[What it does]. [When to use it].`

**Write in third person:**
- ✅ "Processes Excel files and generates reports"
- ❌ "I can help you process Excel files"
- ❌ "You can use this to process Excel files"

**Include specific keywords:**

```yaml
# ❌ Too vague
description: Helps with documents

# ✅ Specific with keywords
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files, forms, document extraction, or .pdf files.
```

## Optional Fields

### allowed-tools

Define tools the skill can use without user approval.

```yaml
allowed-tools: "Read,Write,Bash,Glob,Grep,Edit"
```

**Wildcards:**
- `Bash(git:*)` - Only git subcommands
- `Bash(npm:*)` - All npm operations

**Best practice:** Only include tools actually needed.

```yaml
# ✅ Minimal permissions
allowed-tools: "Read,Write"

# ✅ Specific git commands
allowed-tools: "Bash(git status:*),Bash(git diff:*),Read,Grep"

# ❌ Too many permissions
allowed-tools: "Bash,Read,Write,Edit,Glob,Grep,WebSearch,Task,Agent"
```

### model

Override model for the skill.

```yaml
model: "claude-opus-4-20250514"  # Specific model
model: "inherit"                  # Session's current model (default)
```

### version

Metadata for version tracking.

```yaml
version: "1.0.0"
```

### disable-model-invocation

Prevent Claude from automatically invoking the skill.

```yaml
disable-model-invocation: true
```

When `true`: Skill can only be invoked manually by user via `/skill-name`.

Use cases: Dangerous operations, configuration commands, interactive workflows.

### mode

Mark skill as a "mode command".

```yaml
mode: true
```

When `true`: Skill appears in separate "Mode Commands" section.

Use cases: `debug-mode`, `expert-mode`, `review-mode`.

## Complete Examples

### Basic Skill

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---
```

### Advanced Skill

```yaml
---
name: database-migration
description: Safely execute database migrations with validation and rollback support. Use when user needs to migrate database schema, run migration scripts, or rollback changes.
allowed-tools: "Bash(python scripts/*:*),Read,Write"
version: "2.1.0"
---
```

### Mode Skill

```yaml
---
name: debug-mode
description: Enable verbose debugging output and step-by-step execution. Use when user wants detailed debugging or troubleshooting assistance.
mode: true
disable-model-invocation: true
---
```
