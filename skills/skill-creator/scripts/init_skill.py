#!/usr/bin/env python3
"""
Initialize a new skill with proper structure and templates.

Usage:
    python init_skill.py <skill-name> --path <output-directory>
    python init_skill.py my-skill --path ./skills

Example:
    python init_skill.py pdf-processor --path /home/user/skills
"""

import argparse
import os
import sys
import re
from pathlib import Path
from datetime import datetime


def validate_skill_name(name: str) -> tuple[bool, str]:
    """Validate skill name follows conventions."""
    if not name:
        return False, "Skill name cannot be empty"

    if len(name) > 64:
        return False, f"Skill name too long ({len(name)} chars, max 64)"

    if not re.match(r'^[a-z0-9-]+$', name):
        return False, "Skill name must contain only lowercase letters, numbers, and hyphens"

    if name.startswith('-') or name.endswith('-'):
        return False, "Skill name cannot start or end with hyphen"

    reserved = ['anthropic', 'claude']
    for word in reserved:
        if word in name.lower():
            return False, f"Skill name cannot contain reserved word: {word}"

    return True, "Valid"


def create_skill_md(skill_name: str) -> str:
    """Generate SKILL.md template content."""
    display_name = ' '.join(word.capitalize() for word in skill_name.split('-'))

    return f'''---
name: {skill_name}
description: TODO: Describe what this skill does AND when to use it. Example: "Process PDF files for text extraction, form filling, and merging. Use when working with PDF files or document processing tasks."
---

# {display_name}

TODO: Brief 1-2 sentence description of skill purpose.

## Quick Start

TODO: Add the simplest example to get started.

```python
# Example code here
```

## Workflows

TODO: Document main workflows.

### Workflow 1: [Name]

1. Step 1
2. Step 2
3. Step 3

## Resources

### Scripts

- `scripts/example.py` - TODO: Description

### References

- [references/guide.md](references/guide.md) - TODO: Description

### Assets

- `assets/template.txt` - TODO: Description
'''


def create_example_script() -> str:
    """Generate example script content."""
    return '''#!/usr/bin/env python3
"""
Example utility script.

TODO: Replace with actual script for your skill.

Usage:
    python example.py <input> [--output <output>]
"""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description="Example script")
    parser.add_argument("input", help="Input file path")
    parser.add_argument("--output", "-o", help="Output file path", default="output.txt")

    args = parser.parse_args()

    try:
        # TODO: Implement actual logic
        print(f"Processing: {args.input}")
        print(f"Output: {args.output}")
        print("Done!")

    except FileNotFoundError:
        print(f"Error: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
'''


def create_example_reference() -> str:
    """Generate example reference content."""
    return '''# Guide

TODO: Add detailed documentation here.

## Contents

- [Section 1](#section-1)
- [Section 2](#section-2)
- [Section 3](#section-3)

## Section 1

TODO: Content for section 1.

## Section 2

TODO: Content for section 2.

## Section 3

TODO: Content for section 3.
'''


def create_example_asset() -> str:
    """Generate example asset content."""
    return '''# {{TITLE}}

Generated: {{DATE}}

## Summary

{{SUMMARY}}

## Content

{{CONTENT}}
'''


def init_skill(skill_name: str, output_path: str) -> bool:
    """Initialize a new skill with proper structure."""

    valid, message = validate_skill_name(skill_name)
    if not valid:
        print(f"Error: Invalid skill name: {message}", file=sys.stderr)
        return False

    skill_dir = Path(output_path) / skill_name

    if skill_dir.exists():
        print(f"Error: Directory already exists: {skill_dir}", file=sys.stderr)
        return False

    try:
        skill_dir.mkdir(parents=True)
        (skill_dir / "scripts").mkdir()
        (skill_dir / "references").mkdir()
        (skill_dir / "assets").mkdir()

        skill_md_path = skill_dir / "SKILL.md"
        skill_md_path.write_text(create_skill_md(skill_name))
        print(f"Created: {skill_md_path}")

        script_path = skill_dir / "scripts" / "example.py"
        script_path.write_text(create_example_script())
        script_path.chmod(0o755)
        print(f"Created: {script_path}")

        ref_path = skill_dir / "references" / "guide.md"
        ref_path.write_text(create_example_reference())
        print(f"Created: {ref_path}")

        asset_path = skill_dir / "assets" / "template.txt"
        asset_path.write_text(create_example_asset())
        print(f"Created: {asset_path}")

        print(f"\nSkill initialized successfully: {skill_dir}")
        print(f"\nNext steps:")
        print(f"  1. Edit SKILL.md - fill in TODO sections")
        print(f"  2. Add/modify scripts in scripts/")
        print(f"  3. Add references in references/")
        print(f"  4. Add assets in assets/")
        print(f"  5. Delete example files you don't need")
        print(f"  6. Run validate_skill.py to check")

        return True

    except Exception as e:
        print(f"Error creating skill: {e}", file=sys.stderr)
        if skill_dir.exists():
            import shutil
            shutil.rmtree(skill_dir)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Initialize a new skill with proper structure",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python init_skill.py pdf-processor --path ./skills
    python init_skill.py data-analyzer --path /home/user/my-skills
        """
    )

    parser.add_argument(
        "skill_name",
        help="Name of the skill (lowercase, hyphens, max 64 chars)"
    )

    parser.add_argument(
        "--path", "-p",
        required=True,
        help="Output directory where skill folder will be created"
    )

    args = parser.parse_args()

    success = init_skill(args.skill_name, args.path)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
