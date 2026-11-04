#!/usr/bin/env python3
"""Build USDR's translation skills for installing.

    python skills/build.py                 # build, then install into this repo's .claude/skills/ (for testing here)
    python skills/build.py --user          # also install into ~/.claude/skills/ (every project)
    python skills/build.py --no-project    # build only (skills/dist/ and the zips)
    python skills/build.py --release usdr-plain-language-review [more...]
        # build the named skills with placeholder links into skills/release/
        # (committed; never contains real links)

Dev loop: edit a skill under skills/, run this, start a new Claude Code session
in this repo. For claude.ai, upload the zips from skills/dist/.

For each usdr-* skill folder: copies it to skills/dist/<skill>/, writes its
references/materials.md listing only the materials named in the skill's
skill-build.json (from _shared/materials.json), adds the glossary
instructions and scripts if it uses the glossary, fills in the links from
skills/materials.local.json (gitignored; see materials.example.json), and
packages it as skills/dist/<skill>.skill (a zip, the format claude.ai's skill
upload uses; a .zip copy is made too) for Settings > Capabilities > Skills.

Without materials.local.json the {{...}} placeholders stay, and the skills
tell the user their materials aren't configured.
"""

import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHARED = HERE / "_shared"
MATERIALS_CATALOG = SHARED / "materials.json"
MATERIALS_TEMPLATE = SHARED / "materials-template.md"
GLOSSARY_FILES = SHARED / "glossary"
GLOSSARY = "glossary"
BUILD_CONFIG = "skill-build.json"   # per-skill build settings; not shipped
GLOSSARY_OPEN_NOTE = (" The glossary is a Sheet, and the connector reads only a sheet's first tab,"
                      " which may not be the glossary tab: follow `glossary-access.md` for it.")
DIST = HERE / "dist"
RELEASE = HERE / "release"
URL_IN_TEXT = re.compile(r"https://docs\.google\.com/")
LOCAL_MATERIALS = HERE / "materials.local.json"
SKILL_PREFIX = "usdr-"
TEXT_SUFFIXES = {".md", ".txt", ".py", ".json"}
PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")
USER_SKILLS = Path.home() / ".claude" / "skills"
# This repo's project skills folder. .gitignore ignores everything in it except
# the repo's own named skills, so built copies (with real links) stay out of git.
PROJECT_SKILLS = HERE.parent / ".claude" / "skills"


def load_materials():
    if not LOCAL_MATERIALS.exists():
        print(f"Note: {LOCAL_MATERIALS.name} not found; material links stay as placeholders.")
        return {}
    return json.loads(LOCAL_MATERIALS.read_text())


def fill(text, materials, missing):
    def sub(m):
        key = m.group(1)
        if key in materials:
            return materials[key]
        missing.add(key)
        return m.group(0)
    return PLACEHOLDER.sub(sub, text)


def materials_doc(keys):
    """This skill's materials.md: the shared template with only its materials."""
    catalog = json.loads(MATERIALS_CATALOG.read_text())
    unknown = [k for k in keys if k not in catalog]
    if unknown:
        sys.exit(f"Unknown materials in {BUILD_CONFIG}: {', '.join(unknown)}")
    rows = ["| Material | What it is | Link | Local copy name |", "|---|---|---|---|"]
    rows += [f"| {catalog[k]['name']} | {catalog[k]['what']} | {catalog[k]['link']} | "
             f"`{catalog[k]['local_file']}` |" for k in keys]
    text = MATERIALS_TEMPLATE.read_text()
    text = text.replace("{{MATERIALS_TABLE}}", "\n".join(rows))
    return text.replace("{{GLOSSARY_OPEN_NOTE}}", GLOSSARY_OPEN_NOTE if GLOSSARY in keys else "")


def copy_missing(src_dir, out):
    """Copy files from a shared folder into the skill, without overwriting its own."""
    for f in src_dir.rglob("*"):
        if f.is_file():
            dest = out / f.relative_to(src_dir)
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dest)


def build_skill(src, materials, dist=DIST):
    config = json.loads((src / BUILD_CONFIG).read_text())
    keys = config.get("materials", [])
    out = dist / src.name
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store", BUILD_CONFIG))
    (out / "references").mkdir(exist_ok=True)
    (out / "references" / "materials.md").write_text(materials_doc(keys))
    if GLOSSARY in keys:
        copy_missing(GLOSSARY_FILES, out)
    missing = set()
    for f in out.rglob("*"):
        if f.is_file() and f.suffix in TEXT_SUFFIXES:
            f.write_text(fill(f.read_text(), materials, missing))
    # Folder entries included, like the .skill files claude.ai produces
    skill_path = dist / f"{src.name}.skill"
    with zipfile.ZipFile(skill_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted([out, *out.rglob("*")]):
            z.write(f, f.relative_to(dist))
    shutil.copy2(skill_path, dist / f"{src.name}.zip")
    return out, skill_path, missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", action="store_true",
                        help=f"also install into {USER_SKILLS} (available in every project)")
    parser.add_argument("--no-project", action="store_true",
                        help=f"don't install into {PROJECT_SKILLS}")
    parser.add_argument("--release", nargs="+", metavar="SKILL",
                        help="build these skills with placeholder links into skills/release/ (for committing)")
    args = parser.parse_args()

    skills = sorted(p for p in HERE.iterdir() if p.is_dir() and p.name.startswith(SKILL_PREFIX))
    if not skills:
        sys.exit("No usdr-* skill folders found.")

    if args.release:
        release(args.release, skills)
        return

    targets = ([] if args.no_project else [PROJECT_SKILLS]) + ([USER_SKILLS] if args.user else [])
    materials = load_materials()
    DIST.mkdir(exist_ok=True)

    for src in skills:
        out, zip_path, missing = build_skill(src, materials)
        note = f"  (placeholders left: {', '.join(sorted(missing))})" if missing else ""
        print(f"Built {out.relative_to(HERE.parent)} and {zip_path.name} (+ .zip){note}")
        for target in targets:
            dest = target / src.name
            shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(out, dest)
            print(f"  installed to {dest}")
    if targets:
        print("Start a new Claude Code session to pick up changes.")


def release(names, skills):
    """Build named skills with placeholders (no local links) into skills/release/."""
    by_name = {p.name: p for p in skills}
    unknown = [n for n in names if n not in by_name]
    if unknown:
        sys.exit(f"Unknown skill(s): {', '.join(unknown)}")
    RELEASE.mkdir(exist_ok=True)
    for name in names:
        out, skill_path, _ = build_skill(by_name[name], {}, dist=RELEASE)
        # Safety net: a release must never carry a real Drive link
        leaked = [f for f in out.rglob("*") if f.is_file() and URL_IN_TEXT.search(f.read_text(errors="ignore"))]
        if leaked:
            sys.exit(f"Refusing to release {name}: Drive links found in {', '.join(map(str, leaked))}")
        shutil.rmtree(out)                     # keep just the packages in release/
        (RELEASE / f"{name}.zip").unlink()
        print(f"Released {skill_path.relative_to(HERE.parent)} (placeholder links)")


if __name__ == "__main__":
    main()
