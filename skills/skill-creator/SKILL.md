---
name: skill-creator
description: Creates and updates Agent Skills for any AI coordinator with proper structure and best practices. Use when user wants to create new skill, update existing skill, learn SKILL.md authoring, validate a skill, or package skills for distribution. Includes automation scripts and authoring guidelines.
---

# Skill Creator

Create high-quality Agent Skills following Anthropic best practices.

## Understanding Skills

**Skills = Prompt Template + Context Injection + Execution Context Modification**

Skills are not executable code. They are instruction templates injected into conversation context to guide the agent through specialized tasks.

### Progressive Disclosure (Core Principle)

```
Level 1: Metadata (~100 tokens)     → Always loaded at startup
Level 2: SKILL.md body (<5k tokens) → Loaded when skill triggers
Level 3: Resources (unlimited)      → Loaded as needed
```

Context window is a shared resource. Skills must be concise to avoid consuming context needed for conversation and other skills.

## Skill Structure

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description)
│   └── Markdown body (instructions)
├── scripts/        → Executable code (Python/Bash)
├── references/     → Documentation loaded into context
└── assets/         → Files used in output (templates, images)
```

### Frontmatter (Required)

```yaml
---
name: skill-name          # lowercase, numbers, hyphens only (max 64 chars)
description: Skill desc   # What it does + When to use (max 1024 chars)
---
```

**Description rules:**
- Write in third person ("Processes files..." not "You can use this to...")
- Include both WHAT and WHEN
- Use specific keywords for the agent to match intent

See details: [references/frontmatter-guide.md](references/frontmatter-guide.md)

### Body Guidelines

- Keep under 500 lines
- Use imperative language ("Analyze code..." not "You should analyze...")
- Reference external files instead of embedding everything
- Keep references 1 level deep from SKILL.md

## Skill Creation Process (6 Steps)

### Step 1: Gather Use Cases

Ask user to understand how the skill will be used:

- "What tasks will this skill support?"
- "Give specific examples of how you want to use this skill?"
- "What would a user say to trigger this skill?"

**Complete this step when:** Clear list of use cases and trigger phrases exists.

### Step 2: Analyze & Plan

For each use case, identify:

1. **Scripts needed** - What code requires deterministic reliability?
2. **References needed** - What documentation does the agent need to read?
3. **Assets needed** - What templates, images are used in output?

**Analysis example:**

| Use Case | Scripts | References | Assets |
|----------|---------|------------|--------|
| "Rotate PDF" | rotate_pdf.py | - | - |
| "Build todo app" | - | react-patterns.md | hello-world/ template |
| "Query sales data" | - | schema.md | - |

### Step 3: Initialize Skill

Run the initialization script:

```bash
python {baseDir}/scripts/init_skill.py <skill-name> --path <output-directory>
```

The script creates:
- Skill directory with standard structure
- SKILL.md template with TODO placeholders
- scripts/, references/, assets/ directories with example files

### Step 4: Implement Resources

**Priority order:**

1. **Scripts first** - Write and test required scripts
2. **References second** - Create documentation files
3. **Assets last** - Copy templates, images

**Test scripts:** Run them to verify output matches expectations.

**Delete example files:** After implementation, remove unneeded example files.

### Step 5: Write SKILL.md

#### 5.1 Frontmatter

```yaml
---
name: your-skill-name
description: [What it does]. Use when [specific triggers/contexts].
---
```

#### 5.2 Body Structure

```markdown
# Skill Name

[1-2 sentence purpose statement]

## Quick Start
[Simplest example]

## Workflows
[Steps to accomplish main tasks]

## Resources
[Links to scripts/, references/, assets/]
```

See detailed patterns: [references/content-patterns.md](references/content-patterns.md)

### Step 6: Validate & Package

**Validate:**

```bash
python {baseDir}/scripts/validate_skill.py <path/to/skill>
```

Checks:
- Frontmatter format and required fields
- SKILL.md length (< 500 lines recommended)
- File references exist
- Naming conventions

**Package:**

```bash
python {baseDir}/scripts/package_skill.py <path/to/skill> [output-dir]
```

Creates `.skill` file (zip format) for distribution.

## Degrees of Freedom

Choose specificity level appropriate for the task:

| Level | When to use | Example |
|-------|-------------|---------|
| **High** (text instructions) | Multiple approaches valid, context decides | Code review, analysis |
| **Medium** (pseudocode/params) | Preferred pattern exists, some variation OK | Report generation |
| **Low** (specific scripts) | Operations fragile, consistency critical | Database migrations |

## Workflow Patterns

### Sequential Workflow

```markdown
## Process

1. Analyze input (run analyze.py)
2. Validate results (run validate.py)
3. Generate output (run generate.py)
```

### Conditional Workflow

```markdown
## Determine approach

**Creating new?** → Follow "Creation workflow"
**Editing existing?** → Follow "Edit workflow"
```

### Feedback Loop

```markdown
## Validation cycle

1. Make changes
2. Run validator: `python validate.py`
3. If errors: fix and repeat step 2
4. If pass: proceed to next step
```

See more: [references/workflow-patterns.md](references/workflow-patterns.md)

## Anti-patterns to Avoid

- ❌ SKILL.md > 500 lines
- ❌ Nested references (file A → file B → file C)
- ❌ Hardcoded paths (`/home/user/...` instead of `{baseDir}/...`)
- ❌ Windows-style paths (`scripts\helper.py`)
- ❌ Time-sensitive information
- ❌ Inconsistent terminology
- ❌ Vague descriptions ("Helps with documents")
- ❌ Unnecessary files (README.md, CHANGELOG.md)

See details: [references/anti-patterns.md](references/anti-patterns.md)

## Pre-ship Checklist

```
Core Quality:
[ ] Description is clear (what + when)
[ ] SKILL.md < 500 lines
[ ] References 1 level deep
[ ] No time-sensitive info
[ ] Consistent terminology

Scripts & Resources:
[ ] Scripts tested and working
[ ] Error handling is clear
[ ] Paths use {baseDir}

Validation:
[ ] validate_skill.py passes
[ ] Tested with real use cases
```

See full checklist: [references/checklist.md](references/checklist.md)

## Quality grading (S→F)

To grade a skill (or the whole repo) against published standards — Anthropic
skill-authoring best practices, OpenAI tool-design guidance, ISO/IEC 25010 —
use the S→F rubric: six dimensions × 0–3 points, tier gates, and the grading
procedure. See [references/quality-rubric.md](references/quality-rubric.md).

## Iteration

After deployment:

1. **Observe** - How does the agent use the skill?
2. **Identify gaps** - Where does the agent struggle?
3. **Refine** - Update SKILL.md or resources
4. **Test again** - Verify improvements

Best skills are refined through real usage, not assumptions.
