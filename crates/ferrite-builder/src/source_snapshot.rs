use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProjectSourceSnapshot {
    entries: Vec<ProjectSourceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ProjectSourceEntry {
    path: String,
    value: String,
}

impl ProjectSourceSnapshot {
    pub(crate) fn capture(project: &Path, excluded_paths: &[PathBuf]) -> io::Result<Self> {
        let requested_project = if project.is_absolute() {
            project.to_path_buf()
        } else {
            std::env::current_dir()?.join(project)
        };
        let project = fs::canonicalize(&requested_project)?;
        let excluded_paths = excluded_paths
            .iter()
            .map(|path| normalized_excluded_path(&requested_project, &project, path))
            .collect::<Vec<_>>();
        let mut entries = Vec::new();
        visit_project(&project, &project, &excluded_paths, &mut entries)?;
        entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
        Ok(Self { entries })
    }
}

fn visit_project(
    project: &Path,
    current: &Path,
    excluded_paths: &[PathBuf],
    entries: &mut Vec<ProjectSourceEntry>,
) -> io::Result<()> {
    let mut children = fs::read_dir(current)?.collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let path = entry.path();
        if is_excluded(&path, excluded_paths) || is_generated_directory(&entry.file_name()) {
            continue;
        }

        let metadata = fs::symlink_metadata(&path)?;
        let relative = portable_relative(project, &path)?;
        if metadata.file_type().is_symlink() {
            entries.push(ProjectSourceEntry {
                path: relative,
                value: symlink_value(&path)?,
            });
        } else if metadata.is_dir() {
            visit_project(project, &path, excluded_paths, entries)?;
        } else if metadata.is_file() {
            entries.push(ProjectSourceEntry {
                path: relative,
                value: format!("sha256:{}", sha256_hex(&fs::read(&path)?)),
            });
        } else {
            entries.push(ProjectSourceEntry {
                path: relative,
                value: "special".to_owned(),
            });
        }
    }
    Ok(())
}

fn normalized_excluded_path(
    requested_project: &Path,
    canonical_project: &Path,
    path: &Path,
) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        requested_project.join(path)
    };

    if let Ok(relative) = path.strip_prefix(requested_project) {
        canonical_project.join(relative)
    } else {
        path
    }
}

fn is_excluded(path: &Path, excluded_paths: &[PathBuf]) -> bool {
    excluded_paths
        .iter()
        .any(|excluded| path == excluded || path.starts_with(excluded))
}

fn is_generated_directory(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    matches!(
        name.as_ref(),
        ".git" | ".ferrite" | "node_modules" | "target"
    ) || name.starts_with(".ferrite-build-")
        || name.starts_with(".ferrite-verified-build-")
        || name.starts_with(".ferrite-verified-types-")
        || name.starts_with(".ferrite-previous-")
}

fn portable_relative(project: &Path, path: &Path) -> io::Result<String> {
    path.strip_prefix(project)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| {
            io::Error::other(format!(
                "project source `{}` is outside project root `{}`",
                path.display(),
                project.display()
            ))
        })
}

fn symlink_value(path: &Path) -> io::Result<String> {
    let target = fs::read_link(path)?;
    let target_text = target.to_string_lossy().replace('\\', "/");
    match fs::canonicalize(path) {
        Ok(canonical) if canonical.is_file() => Ok(format!(
            "symlink:{target_text}:sha256:{}",
            sha256_hex(&fs::read(canonical)?)
        )),
        Ok(canonical) => Ok(format!(
            "symlink:{target_text}:target:{}",
            canonical.to_string_lossy().replace('\\', "/")
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(format!("symlink:{target_text}:missing"))
        }
        Err(_) => Ok(format!("symlink:{target_text}:error")),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_source_additions_changes_and_deletions() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("app")).unwrap();
        let page = project.path().join("app/page.tsx");
        fs::write(&page, "export default function Page() {}\n").unwrap();
        let initial = ProjectSourceSnapshot::capture(project.path(), &[]).unwrap();

        let data = project.path().join("app/data.json");
        fs::write(&data, "{\"version\":1}\n").unwrap();
        let added = ProjectSourceSnapshot::capture(project.path(), &[]).unwrap();
        assert_ne!(initial, added);

        fs::write(&data, "{\"version\":2}\n").unwrap();
        let changed = ProjectSourceSnapshot::capture(project.path(), &[]).unwrap();
        assert_ne!(added, changed);

        fs::remove_file(&data).unwrap();
        let removed = ProjectSourceSnapshot::capture(project.path(), &[]).unwrap();
        assert_eq!(initial, removed);
    }

    #[test]
    fn ignores_generated_build_and_type_outputs() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("app")).unwrap();
        fs::write(
            project.path().join("app/page.tsx"),
            "export default function Page() {}\n",
        )
        .unwrap();
        let types_out = project.path().join("generated/routes.d.ts");
        let out_dir = project.path().join("custom-build");
        let initial =
            ProjectSourceSnapshot::capture(project.path(), &[out_dir.clone(), types_out.clone()])
                .unwrap();

        fs::create_dir_all(out_dir).unwrap();
        fs::write(project.path().join("custom-build/index.html"), "built").unwrap();
        fs::create_dir_all(types_out.parent().unwrap()).unwrap();
        fs::write(types_out, "generated").unwrap();
        fs::create_dir_all(project.path().join(".ferrite/tmp")).unwrap();
        fs::write(project.path().join(".ferrite/tmp/state"), "state").unwrap();
        fs::create_dir_all(
            project
                .path()
                .join("generated/.ferrite-verified-types-residue"),
        )
        .unwrap();
        fs::write(
            project
                .path()
                .join("generated/.ferrite-verified-types-residue/routes.d.ts"),
            "staged",
        )
        .unwrap();

        let current = ProjectSourceSnapshot::capture(
            project.path(),
            &[
                project.path().join("custom-build"),
                project.path().join("generated/routes.d.ts"),
            ],
        )
        .unwrap();
        assert_eq!(initial, current);
    }
}
