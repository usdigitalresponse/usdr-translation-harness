#!/usr/bin/env python3
"""Build USDR's translation skills for installing.

    python skills/build.py                 # build, then install into this repo's .claude/skills/ (for testing here)
    python skills/build.py --user          # also install into ~/.claude/skills/ (every project; replaces any copy there)
    python skills/build.py --no-project    # build only (skills/dist/ and the zips)
    python skills/build.py --release usdr-plain-language-review [more...]
        # build the named skills with placeholder links into skills/release/
        # (committed; never contains real links)

Dev loop: edit a skill under skills/, run this, start a new Claude Code session
in this repo. For claude.ai, upload the .skill files from skills/dist/.

For each usdr-* skill folder: copies it to skills/dist/<skill>/, writes its
references/materials.md listing only the materials named in the skill's
skill-build.json (from _shared/materials.json), adds the shared groups it uses
(_shared/glossary/ when it uses the glossary, plus any listed under "shared"),
fills in the links from skills/materials.local.json (gitignored; see
materials.example.json), and packages it as skills/dist/<skill>.skill (a zip,
the format claude.ai's skill upload uses; a .zip copy is made too).

Without materials.local.json the {{...}} placeholders stay, and the skills
tell the user their materials aren't configured.
"""

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHARED = HERE / "_shared"
MATERIALS_CATALOG = SHARED / "materials.json"
MATERIALS_TEMPLATE = SHARED / "materials-template.md"
GLOSSARY = "glossary"            # material key, and the shared group added with it
BUILD_CONFIG = "skill-build.json"   # per-skill build settings; not shipped
GLOSSARY_OPEN_NOTE = (" The glossary is a Sheet, and the connector reads only a sheet's first tab,"
                      " which may not be the glossary tab: follow `glossary-access.md` for it.")
DIST = HERE / "dist"
RELEASE = HERE / "release"
# A release must not contain anything that looks like a real Drive link or file ID
LEAK = re.compile(r"(?:docs|drive)\.google\.com/|/d/[\w-]{25,}")
LOCAL_MATERIALS = HERE / "materials.local.json"
SKILL_PREFIX = "usdr-"
TEXT_SUFFIXES = {".md", ".txt", ".py", ".json"}
JUNK = ("__pycache__", ".DS_Store")
PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")
ENCODING = "utf-8"
# Fixed timestamp inside packages, so an unchanged skill builds to identical bytes
ZIP_DATE = (2026, 1, 1, 0, 0, 0)
USER_SKILLS = Path.home() / ".claude" / "skills"
# This repo's project skills folder. .gitignore ignores everything in it except
# the repo's own named skills, so built copies (with real links) stay out of git.
PROJECT_SKILLS = HERE.parent / ".claude" / "skills"


def read(path):
    return Path(path).read_text(encoding=ENCODING)


def write(path, text):
    Path(path).write_text(text, encoding=ENCODING)


def load_materials():
    if not LOCAL_MATERIALS.exists():
        print(f"Note: {LOCAL_MATERIALS.name} not found; material links stay as placeholders.")
        return {}
    return json.loads(read(LOCAL_MATERIALS))


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
    catalog = json.loads(read(MATERIALS_CATALOG))
    unknown = [k for k in keys if k not in catalog]
    if unknown:
        sys.exit(f"Unknown materials in {BUILD_CONFIG}: {', '.join(unknown)}")
    rows = ["| Material | What it is | Link | Local copy name |", "|---|---|---|---|"]
    rows += [f"| {catalog[k]['name']} | {catalog[k]['what']} | {catalog[k]['link']} | "
             f"`{catalog[k]['local_file']}` |" for k in keys]
    text = read(MATERIALS_TEMPLATE).replace("{{MATERIALS_TABLE}}", "\n".join(rows))
    return text.replace("{{GLOSSARY_OPEN_NOTE}}", GLOSSARY_OPEN_NOTE if GLOSSARY in keys else "")


def copy_missing(src_dir, out):
    """Copy a shared group's files into the skill, without overwriting its own."""
    if not src_dir.is_dir():
        sys.exit(f"No shared group folder {src_dir}")
    for f in src_dir.rglob("*"):
        if f.is_file() and not any(j in f.parts for j in JUNK):
            dest = out / f.relative_to(src_dir)
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f, dest)


def package(out, dist, name):
    """Zip the built folder as <name>.skill (folder entries included, like the
    .skill files claude.ai produces) plus a .zip copy."""
    skill_path = dist / f"{name}.skill"
    with zipfile.ZipFile(skill_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted([out, *out.rglob("*")]):
            arcname = f.relative_to(dist).as_posix() + ("/" if f.is_dir() else "")
            info = zipfile.ZipInfo(arcname, date_time=ZIP_DATE)
            info.external_attr = (0o40755 << 16) if f.is_dir() else (0o644 << 16)
            z.writestr(info, b"" if f.is_dir() else f.read_bytes(), zipfile.ZIP_DEFLATED)
    shutil.copyfile(skill_path, dist / f"{name}.zip")
    return skill_path


def build_skill(src, materials, dist=DIST):
    config = json.loads(read(src / BUILD_CONFIG))
    keys = config.get("materials", [])
    groups = ([GLOSSARY] if GLOSSARY in keys else []) + config.get("shared", [])
    out = dist / src.name
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns(*JUNK, BUILD_CONFIG))
    (out / "references").mkdir(exist_ok=True)
    write(out / "references" / "materials.md", materials_doc(keys))
    for group in groups:
        copy_missing(SHARED / group, out)
    missing = set()
    for f in out.rglob("*"):
        if f.is_file() and f.suffix in TEXT_SUFFIXES:
            write(f, fill(read(f), materials, missing))
    return out, package(out, dist, src.name), missing


def release(names, skills):
    """Build named skills with placeholders (no local links) into skills/release/.

    Builds in a temporary folder and copies the package into release/ only
    after the leak check passes, so a failed check leaves release/ untouched.
    """
    by_name = {p.name: p for p in skills}
    unknown = [n for n in names if n not in by_name]
    if unknown:
        sys.exit(f"Unknown skill(s): {', '.join(unknown)}")
    RELEASE.mkdir(exist_ok=True)
    for name in names:
        with tempfile.TemporaryDirectory() as tmp:
            out, skill_path, _ = build_skill(by_name[name], {}, dist=Path(tmp))
            leaked = [str(f.relative_to(out)) for f in out.rglob("*")
                      if f.is_file() and LEAK.search(f.read_text(encoding=ENCODING, errors="ignore"))]
            if leaked:
                sys.exit(f"Refusing to release {name}: Drive links or IDs found in {', '.join(leaked)}. "
                         f"skills/release/ was not changed.")
            shutil.copyfile(skill_path, RELEASE / skill_path.name)
        print(f"Released {(RELEASE / skill_path.name).relative_to(HERE.parent)} (placeholder links)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", action="store_true",
                        help=f"also install into {USER_SKILLS} (replaces any copy there, including hand-edited links)")
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
        out, skill_path, missing = build_skill(src, materials)
        note = f"  (placeholders left: {', '.join(sorted(missing))})" if missing else ""
        print(f"Built {out.relative_to(HERE.parent)} and {skill_path.name} (+ .zip){note}")
        for target in targets:
            dest = target / src.name
            if target == USER_SKILLS and dest.exists():
                print(f"  replacing {dest} (any links edited by hand there are overwritten)")
            shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(out, dest)
            print(f"  installed to {dest}")
    if targets:
        print("Start a new Claude Code session to pick up changes.")


if __name__ == "__main__":
    main()
