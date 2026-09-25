#!/usr/bin/env python3
"""
Package a skill into a .skill file for distribution.

Usage:
    python package_skill.py <path/to/skill> [output-dir]

Example:
    python package_skill.py ./my-skill ./dist
"""

import argparse
import os
import sys
import zipfile
from pathlib import Path


def should_include(path: Path) -> bool:
    """Check if file should be included in package."""
    name = path.name

    # Exclude hidden files
    if name.startswith('.'):
        return False

    # Exclude Python cache
    if '__pycache__' in str(path):
        return False

    # Exclude backup files
    if name.endswith('~') or name.endswith('.bak'):
        return False

    # Exclude compiled Python
    if name.endswith('.pyc'):
        return False

    return True


def package_skill(skill_path: str, output_dir: str = None) -> bool:
    """Package a skill into a .skill file."""
    path = Path(skill_path)

    if not path.exists():
        print(f"Error: Skill path not found: {skill_path}", file=sys.stderr)
        return False

    if not path.is_dir():
        print(f"Error: Skill path must be a directory: {skill_path}", file=sys.stderr)
        return False

    skill_md = path / "SKILL.md"
    if not skill_md.exists():
        print(f"Error: SKILL.md not found in {skill_path}", file=sys.stderr)
        return False

    skill_name = path.name

    # Determine output path
    if output_dir:
        out_path = Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)
    else:
        out_path = path.parent

    output_file = out_path / f"{skill_name}.skill"

    print(f"Packaging skill: {skill_name}")
    print("=" * 50)

    try:
        file_count = 0

        with zipfile.ZipFile(output_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in path.rglob('*'):
                if file_path.is_file() and should_include(file_path):
                    # Store with skill name as root directory
                    arc_name = f"{skill_name}/{file_path.relative_to(path)}"
                    zf.write(file_path, arc_name)
                    print(f"  Added: {file_path.relative_to(path)}")
                    file_count += 1

        size_kb = output_file.stat().st_size / 1024

        print("=" * 50)
        print(f"✅ Package created: {output_file}")
        print(f"   Files: {file_count}")
        print(f"   Size: {size_kb:.1f} KB")

        return True

    except Exception as e:
        print(f"Error packaging skill: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Package a skill into a .skill file for distribution",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python package_skill.py ./my-skill
    python package_skill.py ./my-skill ./dist
        """
    )

    parser.add_argument(
        "skill_path",
        help="Path to skill directory"
    )

    parser.add_argument(
        "output_dir",
        nargs='?',
        default=None,
        help="Output directory (default: same as skill parent)"
    )

    args = parser.parse_args()

    success = package_skill(args.skill_path, args.output_dir)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
