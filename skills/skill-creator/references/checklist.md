# Skill Quality Checklist

Complete checklist to verify skill before shipping.

## Core Quality

### Frontmatter

```
[ ] name follows conventions (lowercase, hyphens, max 64 chars)
[ ] description non-empty (max 1024 chars)
[ ] description includes WHAT the skill does
[ ] description includes WHEN to use it
[ ] description written in third person
[ ] description includes relevant keywords
[ ] No XML tags in name or description
[ ] No reserved words (anthropic, claude)
```

### SKILL.md Body

```
[ ] Total lines < 500
[ ] Starts with clear purpose statement
[ ] Uses imperative language (not "you should")
[ ] Includes Quick Start section
[ ] Workflows have clear steps
[ ] Examples are concrete, not abstract
[ ] No time-sensitive information
[ ] Consistent terminology throughout
```

### Structure

```
[ ] References are 1 level deep from SKILL.md
[ ] Large reference files (>100 lines) have table of contents
[ ] All referenced files exist
[ ] No unnecessary files (README, CHANGELOG, etc.)
[ ] Directory structure follows convention:
    skill-name/
    ├── SKILL.md
    ├── scripts/
    ├── references/
    └── assets/
```

## Scripts Quality

### Code Quality

```
[ ] All scripts tested and working
[ ] Error handling is explicit and helpful
[ ] No "magic numbers" - all values justified
[ ] No hardcoded paths (use arguments or {baseDir})
[ ] Forward slashes in all paths
[ ] Scripts solve problems, not punt to Claude
```

### Documentation

```
[ ] Each script has clear purpose documented
[ ] Input/output clearly specified
[ ] Usage examples provided
[ ] Required dependencies listed
```

### Testing

```
[ ] Scripts tested with valid inputs
[ ] Scripts tested with invalid inputs
[ ] Error messages are helpful
[ ] Edge cases handled
```

## References Quality

```
[ ] Each reference file serves clear purpose
[ ] No duplicate information with SKILL.md
[ ] Files are well-organized with headers
[ ] Links from SKILL.md are correct
[ ] Content is concise and focused
```

## Assets Quality

```
[ ] Templates are complete and functional
[ ] Placeholders clearly marked
[ ] No hardcoded paths in templates
[ ] Assets referenced correctly in SKILL.md
```

## Paths & Dependencies

```
[ ] All paths use {baseDir} prefix
[ ] All paths use forward slashes
[ ] Required packages clearly listed
[ ] Package installation instructions included
[ ] No assumptions about pre-installed tools
```

## Workflows

```
[ ] Complex tasks have checklists
[ ] Validation steps after critical operations
[ ] Feedback loops where appropriate
[ ] Clear decision points in conditional workflows
[ ] Error recovery instructions included
```

## Testing & Validation

### Automated

```
[ ] validate_skill.py passes without errors
[ ] validate_skill.py passes without warnings
```

### Manual Testing

```
[ ] Tested with at least 3 different use cases
[ ] Tested skill discovery (does it trigger correctly?)
[ ] Tested with fresh Claude instance (Claude B)
[ ] Tested edge cases and error scenarios
```

### Model Compatibility

```
[ ] Tested with Claude Haiku (enough guidance?)
[ ] Tested with Claude Sonnet (clear and efficient?)
[ ] Tested with Claude Opus (not over-explaining?)
```

## Final Checks

```
[ ] Re-read SKILL.md as if seeing it for first time
[ ] Check for typos and grammar
[ ] Verify all links work
[ ] Run package_skill.py successfully
[ ] .skill file opens and contains correct files
```

## Quick Pass Checklist

Abbreviated version for quick review:

```
[ ] Description: WHAT + WHEN + third person
[ ] SKILL.md < 500 lines
[ ] References 1 level deep
[ ] Scripts tested and working
[ ] Paths use {baseDir}
[ ] validate_skill.py passes
[ ] Tested with real use cases
```

## Red Flags - Stop and Fix

If any of the following are present, MUST fix before shipping:

```
🚨 SKILL.md > 500 lines
🚨 Nested references (A → B → C)
🚨 Hardcoded paths (/home/user/...)
🚨 Scripts without error handling
🚨 Description vague or missing "when to use"
🚨 validate_skill.py fails
🚨 Not tested with real use cases
```

## Post-Ship Checklist

After deployment:

```
[ ] Monitor how Claude uses the skill
[ ] Note any discovery issues (skill not triggering)
[ ] Note any execution issues (wrong behavior)
[ ] Collect user feedback
[ ] Plan iteration based on observations
```
