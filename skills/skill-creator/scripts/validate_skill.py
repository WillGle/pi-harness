#!/usr/bin/env python3
"""
Validate a skill for correctness and best practices.

Usage:
    python validate_skill.py <path/to/skill>

Example:
    python validate_skill.py ./my-skill
"""

import argparse
import os
import re
import sys
from pathlib import Path


class ValidationResult:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def add_error(self, msg: str):
        self.errors.append(f"❌ ERROR: {msg}")

    def add_warning(self, msg: str):
        self.warnings.append(f"⚠️  WARNING: {msg}")

    def is_valid(self) -> bool:
        return len(self.errors) == 0

    def print_report(self):
        if self.errors:
            print("\n=== ERRORS ===")
            for e in self.errors:
                print(e)

        if self.warnings:
            print("\n=== WARNINGS ===")
            for w in self.warnings:
                print(w)

        print("\n=== RESULT ===")
        if self.is_valid():
            if self.warnings:
                print(f"✅ PASSED with {len(self.warnings)} warning(s)")
            else:
                print("✅ PASSED")
        else:
            print(f"❌ FAILED with {len(self.errors)} error(s)")


def extract_body_without_code_blocks(content: str) -> str:
    """Remove code blocks from content for validation."""
    # Remove fenced code blocks
    result = re.sub(r'```[\s\S]*?```', '', content)
    # Remove inline code
    result = re.sub(r'`[^`]+`', '', result)
    return result


def validate_name(name: str, result: ValidationResult):
    """Validate skill name."""
    if not name:
        result.add_error("name is empty")
        return

    if len(name) > 64:
        result.add_error(f"name too long ({len(name)} chars, max 64)")

    if not re.match(r'^[a-z0-9-]+$', name):
        result.add_error("name must contain only lowercase letters, numbers, hyphens")

    if name.startswith('-') or name.endswith('-'):
        result.add_error("name cannot start or end with hyphen")

    reserved = ['anthropic', 'claude']
    for word in reserved:
        if word in name.lower():
            result.add_error(f"name cannot contain reserved word: {word}")

    # Check naming style (warning only)
    if not re.search(r'ing(-|$)', name):
        result.add_warning(f"Consider gerund form for name (e.g., 'processing-pdfs' instead of '{name}')")


def validate_description(desc: str, result: ValidationResult):
    """Validate skill description."""
    if not desc:
        result.add_error("description is empty")
        return

    if len(desc) > 1024:
        result.add_error(f"description too long ({len(desc)} chars, max 1024)")

    # Check for third person
    first_person = ['I can', 'I will', 'I help', "I'm", 'I am']
    second_person = ['You can', 'You should', 'You will', "You'll"]

    for phrase in first_person:
        if phrase.lower() in desc.lower():
            result.add_error(f"description uses first person ('{phrase}'). Use third person.")

    for phrase in second_person:
        if phrase.lower() in desc.lower():
            result.add_error(f"description uses second person ('{phrase}'). Use third person.")

    # Check for "when to use"
    trigger_phrases = ['use when', 'when user', 'when working', 'when the user', 'trigger']
    has_when = any(phrase in desc.lower() for phrase in trigger_phrases)

    if not has_when:
        result.add_warning("description should include 'when to use' information")


def validate_frontmatter(content: str, result: ValidationResult) -> dict:
    """Validate and extract frontmatter."""
    frontmatter = {}

    if not content.startswith('---'):
        result.add_error("SKILL.md must start with frontmatter (---)")
        return frontmatter

    parts = content.split('---', 2)
    if len(parts) < 3:
        result.add_error("Invalid frontmatter format (missing closing ---)")
        return frontmatter

    fm_content = parts[1].strip()

    for line in fm_content.split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            frontmatter[key.strip()] = value.strip()

    # Validate required fields
    if 'name' not in frontmatter:
        result.add_error("frontmatter missing required field: name")
    else:
        validate_name(frontmatter['name'], result)

    if 'description' not in frontmatter:
        result.add_error("frontmatter missing required field: description")
    else:
        validate_description(frontmatter['description'], result)

    return frontmatter


def validate_body(content: str, skill_path: Path, result: ValidationResult):
    """Validate SKILL.md body content."""
    # Get body (after frontmatter)
    parts = content.split('---', 2)
    if len(parts) < 3:
        return

    body = parts[2]
    lines = body.strip().split('\n')

    # Check length
    if len(lines) > 800:
        result.add_error(f"SKILL.md body too long ({len(lines)} lines, max 800)")
    elif len(lines) > 500:
        result.add_warning(f"SKILL.md body is {len(lines)} lines (recommended < 500)")

    # Get body without code blocks for text validation
    body_text = extract_body_without_code_blocks(body)

    # Check for TODOs
    todo_count = body.lower().count('todo')
    if todo_count > 0:
        result.add_warning(f"Found {todo_count} TODO(s) in body")

    # Check for second person (only in non-code text)
    second_person = ['you should', 'you can', 'you need', 'you must', "you'll", 'you will']
    for phrase in second_person:
        if phrase in body_text.lower():
            result.add_warning(f"Body uses second person ('{phrase}'). Consider imperative form.")
            break

    # Check file references exist
    ref_pattern = r'\[([^\]]+)\]\(([^)]+)\)'
    for match in re.finditer(ref_pattern, body):
        link_text, link_path = match.groups()

        # Skip external URLs
        if link_path.startswith('http'):
            continue

        # Skip anchors
        if link_path.startswith('#'):
            continue

        # Check if file exists
        full_path = skill_path / link_path
        if not full_path.exists():
            result.add_error(f"Referenced file not found: {link_path}")


def validate_references(skill_path: Path, result: ValidationResult):
    """Validate reference files."""
    refs_dir = skill_path / "references"
    if not refs_dir.exists():
        return

    for ref_file in refs_dir.glob("*.md"):
        content = ref_file.read_text()

        # Check for nested references (warning only)
        ref_pattern = r'\[([^\]]+)\]\(references/[^)]+\)'
        nested_refs = re.findall(ref_pattern, content)

        # Only warn if it's a real nested reference, not an example
        body_without_code = extract_body_without_code_blocks(content)
        if re.search(r'\[([^\]]+)\]\(references/[^)]+\)', body_without_code):
            result.add_warning(f"Nested reference in {ref_file.name} - keep refs 1 level deep")


def validate_scripts(skill_path: Path, result: ValidationResult):
    """Validate script files."""
    scripts_dir = skill_path / "scripts"
    if not scripts_dir.exists():
        return

    for script in scripts_dir.glob("*.py"):
        content = script.read_text()

        # Check for docstring
        if not (content.startswith('"""') or content.startswith("'''")):
            if not content.startswith('#!/'):
                result.add_warning(f"Script {script.name} missing docstring")
            else:
                # Check after shebang
                lines = content.split('\n', 2)
                if len(lines) > 1 and not ('"""' in lines[1] or "'''" in lines[1]):
                    result.add_warning(f"Script {script.name} missing docstring")

        # Check for basic error handling
        if 'def ' in content and 'try:' not in content:
            result.add_warning(f"Script {script.name} may need error handling (no try/except)")


def validate_structure(skill_path: Path, result: ValidationResult):
    """Validate skill directory structure."""
    # Check for SKILL.md
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        result.add_error("SKILL.md not found")
        return None

    # Check for unwanted files
    unwanted = ['README.md', 'CHANGELOG.md', 'LICENSE', 'INSTALLATION.md']
    for filename in unwanted:
        if (skill_path / filename).exists():
            result.add_warning(f"Unnecessary file: {filename} (skills are for AI, not humans)")

    return skill_md.read_text()


def validate_skill(skill_path: str) -> ValidationResult:
    """Main validation function."""
    result = ValidationResult()
    path = Path(skill_path)

    if not path.exists():
        result.add_error(f"Skill path not found: {skill_path}")
        return result

    if not path.is_dir():
        result.add_error(f"Skill path must be a directory: {skill_path}")
        return result

    print(f"Validating skill: {path.name}")
    print("=" * 50)

    # Validate structure
    content = validate_structure(path, result)
    if content is None:
        return result

    # Validate frontmatter
    frontmatter = validate_frontmatter(content, result)

    # Validate body
    validate_body(content, path, result)

    # Validate references
    validate_references(path, result)

    # Validate scripts
    validate_scripts(path, result)

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Validate a skill for correctness and best practices",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python validate_skill.py ./my-skill
    python validate_skill.py /path/to/pdf-processor
        """
    )

    parser.add_argument(
        "skill_path",
        help="Path to skill directory"
    )

    args = parser.parse_args()

    result = validate_skill(args.skill_path)
    result.print_report()

    sys.exit(0 if result.is_valid() else 1)


if __name__ == "__main__":
    main()
