#!/usr/bin/env python3
"""
Project Scouter Utility.

Iterates through a workspace directory to perform a fast, zero-token cost
structural analysis. Identifies key configuration files, project stacks,
documentation outline, and file hierarchy, generating a concise Markdown
report (.scout_report.md) for incoming agents.

Usage:
    python3 scout.py <workspace-directory> [--output <output-file>]
"""

import argparse
import sys
from pathlib import Path

# Common directories to completely ignore
IGNORED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "bower_components",
    "venv", ".venv", "env", ".env", "__pycache__", ".pytest_cache",
    ".mypy_cache", "dist", "build", "target", "out", ".claude",
    ".gemini", ".gcloud", ".github", ".idea", ".vscode", "dist-newstyle"
}

# Agent-specific instruction files — highest priority for incoming agents
AGENT_INSTRUCTION_FILES = {
    # Claude / Anthropic
    "CLAUDE.md", "claude.md", ".claude.md",
    # OpenAI Codex
    "codex.md", "CODEX.md",
    # Generic multi-agent
    "AGENTS.md", "agents.md",
    # Cursor
    ".cursorrules",
    # Gemini / Antigravity
    "GEMINI.md", "gemini.md",
    # Generic start-here conventions
    "START-HERE.md", "start-here.md", "ONBOARDING.md",
}

# Common files that indicate project type
CONFIG_FILE_STACKS = {
    "package.json": "Node.js/JavaScript Project",
    "Cargo.toml": "Rust Project",
    "go.mod": "Go Project",
    "pyproject.toml": "Python Project",
    "setup.py": "Python Project (Legacy)",
    "requirements.txt": "Python Project dependencies",
    "default.nix": "Nix Environment / Package",
    "flake.nix": "Nix Flake Environment",
    "Makefile": "Makefile C/C++ or general build tool",
    "CMakeLists.txt": "CMake C/C++ Project",
    "pom.xml": "Java Maven Project",
    "build.gradle": "Java/Kotlin Gradle Project",
    "mix.exs": "Elixir Project",
    "Gemfile": "Ruby Project",
}


def parse_doc_headers(filepath: Path) -> list[str]:
    """Extract headers (# or ##) from markdown files to create an outline."""
    headers = []
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith("#"):
                    headers.append(stripped)
                if len(headers) >= 15:  # Cap to prevent too much context
                    headers.append("... (additional headers truncated)")
                    break
    except Exception as e:
        headers.append(f"Error reading file headers: {e}")
    return headers


def scan_directory(root_path: Path, max_depth: int = 3) -> tuple[list[str], int]:
    """Generate a compact tree layout of the directory up to a certain depth."""
    tree_lines = []
    total_files = 0

    def _recurse(path: Path, current_depth: int, prefix: str):
        nonlocal total_files
        if current_depth > max_depth:
            return

        try:
            items = sorted(list(path.iterdir()), key=lambda x: (not x.is_dir(), x.name.lower()))
        except PermissionError:
            tree_lines.append(f"{prefix}└── [Permission Denied]")
            return
        except Exception as e:
            tree_lines.append(f"{prefix}└── [Error listing directory: {e}]")
            return

        # Filter items
        filtered_items = []
        for item in items:
            if item.is_dir() and item.name in IGNORED_DIRS:
                continue
            if item.name.startswith(".") and item.is_file():
                # Ignore hidden files in the tree representation to keep it clean
                continue
            filtered_items.append(item)

        count = len(filtered_items)
        for i, item in enumerate(filtered_items):
            is_last = (i == count - 1)
            connector = "└── " if is_last else "├── "
            
            if item.is_dir():
                tree_lines.append(f"{prefix}{connector}{item.name}/")
                new_prefix = prefix + ("    " if is_last else "│   ")
                _recurse(item, current_depth + 1, new_prefix)
            else:
                total_files += 1
                tree_lines.append(f"{prefix}{connector}{item.name}")

    tree_lines.append(f"{root_path.name}/")
    _recurse(root_path, 1, "")
    return tree_lines, total_files


def find_key_files(root_path: Path) -> dict[str, list[Path]]:
    """Scan root directories for project configuration, entry points, and docs."""
    results = {
        "agent_instructions": [],
        "configs": [],
        "docs": [],
        "entries": [],
    }

    try:
        for item in root_path.iterdir():
            if item.name in IGNORED_DIRS:
                continue

            # Check for agent-specific instruction files first (highest priority)
            if item.is_file() and item.name in AGENT_INSTRUCTION_FILES:
                results["agent_instructions"].append(item)
                continue  # Don't double-count as generic doc

            # Check for config files
            if item.name in CONFIG_FILE_STACKS:
                results["configs"].append(item)

            # Check for doc files (generic .md, readme, license)
            if item.is_file() and (
                item.suffix.lower() == ".md"
                or item.name.lower() in {"readme", "license"}
            ):
                results["docs"].append(item)

            # Check for common entry points at root
            if item.is_file() and item.name.lower() in {
                "main.py", "app.py", "index.js", "server.js",
                "index.html", "main.go", "lib.rs", "main.rs"
            }:
                results["entries"].append(item)
    except Exception as e:
        print(f"Error scanning root for key files: {e}", file=sys.stderr)

    return results


def main():
    # Force UTF-8 encoding on standard output and error streams
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    parser = argparse.ArgumentParser(description="Generate a project scout report.")
    parser.add_argument("workspace", help="Root directory of the workspace to scan")
    parser.add_argument("--output", "-o", help="Output file path", default=".scout_report.md")

    args = parser.parse_args()
    workspace_dir = Path(args.workspace).resolve()

    if not workspace_dir.exists():
        print(f"Error: Directory not found: {workspace_dir}", file=sys.stderr)
        sys.exit(1)

    if not workspace_dir.is_dir():
        print(f"Error: Not a directory: {workspace_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Scouting workspace: {workspace_dir}")

    try:
        # 1. Identify Key Files
        key_files = find_key_files(workspace_dir)

        # 2. Build Directory Tree
        tree_lines, total_files = scan_directory(workspace_dir, max_depth=3)

        # 3. Compile report
        report = []
        report.append(f"# Workspace Scout Report: `{workspace_dir.name}`")
        report.append("")
        report.append("Generated automatically by the `project-scouting` utility.")
        report.append("")
        
        # Agent instruction files — most important for incoming agents
        report.append("## Agent Instruction Files")
        if key_files["agent_instructions"]:
            for ai_file in sorted(key_files["agent_instructions"], key=lambda p: p.name):
                report.append(f"### File: `{ai_file.name}`")
                headers = parse_doc_headers(ai_file)
                if headers:
                    for h in headers:
                        report.append(f"  {h}")
                else:
                    report.append("  *(No headers — read full file for agent rules)*")
                report.append("")
        else:
            report.append("No agent instruction files found (AGENTS.md, CLAUDE.md, codex.md, etc.). Check subdirectories if present.")
        report.append("")

        # Tech stack section
        report.append("## Identified Tech Stack & Configuration")
        if key_files["configs"]:
            for config in key_files["configs"]:
                desc = CONFIG_FILE_STACKS.get(config.name, "Custom Config File")
                report.append(f"- `{config.name}`: {desc}")
        else:
            report.append("No common project configuration files identified in the workspace root.")
        report.append("")

        # Key entry points
        report.append("## Entry Points")
        if key_files["entries"]:
            for entry in key_files["entries"]:
                report.append(f"- `{entry.name}` (Root Entry File)")
        else:
            report.append("No obvious entry files found in workspace root. Check structure below.")
        report.append("")

        # Onboarding Docs outline
        report.append("## Documentation & Onboarding Guides")
        if key_files["docs"]:
            for doc in key_files["docs"]:
                report.append(f"### File: `{doc.name}`")
                headers = parse_doc_headers(doc)
                if headers:
                    for h in headers:
                        report.append(f"  {h}")
                else:
                    report.append("  *(No headers found in file)*")
                report.append("")
        else:
            report.append("No documentation markdown files found in workspace root.")
            report.append("")

        # Directory tree representation
        report.append("## Directory Tree (Max Depth 3)")
        report.append("```text")
        report.extend(tree_lines)
        report.append("```")
        report.append(f"\n*(Total files encountered in scanned directory tree: {total_files})*")
        report.append("")

        # Write output file
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = workspace_dir / output_path

        output_path.write_text("\n".join(report), encoding="utf-8")
        print(f"Scout report written to: {output_path}")
        sys.exit(0)

    except Exception as e:
        print(f"Error compiling scout report: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
